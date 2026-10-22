"""DaytonaSandbox exec, readiness and lifecycle over Daytona sessions."""

from __future__ import annotations

import pytest
from agent_env.providers.sandbox_providers.sandbox import NetworkPolicy
from daytona import DaytonaConflictError, DaytonaConnectionError, DaytonaError, DaytonaNotFoundError

from agentenv_daytona.image import DOCKER_START_SCRIPT
from agentenv_daytona.sandbox import DaytonaSandbox
from tests.unit_tests.fakes import FakeProcess, FakeRaw, Handler, Outcome


def sandbox_with(handler: Handler) -> tuple[DaytonaSandbox, FakeRaw]:
    raw = FakeRaw(process=FakeProcess(handler=handler))

    async def read_raw() -> FakeRaw:
        return raw

    return (
        DaytonaSandbox(
            raw, tunnel_urls={8080: "https://u"}, network_policy=NetworkPolicy(), read_raw=read_raw
        ),
        raw,
    )


def fast(sandbox: DaytonaSandbox) -> DaytonaSandbox:
    # VmSandbox declares whole seconds; a fraction keeps these tests fast.
    setattr(sandbox, "_VM_READY_TIMEOUT", 0.2)
    setattr(sandbox, "_VM_READY_POLL_INTERVAL", 0.01)
    return sandbox


def test_sandbox_presents_as_a_daytona_vm() -> None:
    sandbox, raw = sandbox_with(lambda argv: (0, "", ""))

    assert (sandbox.type, sandbox.mode, sandbox.sandbox_id, sandbox.vnc_url) == (
        "daytona",
        "vm",
        raw.id,
        None,
    )
    assert sandbox.tunnel_urls == {8080: "https://u"}


async def test_exec_runs_the_exact_argv_and_keeps_stdout_and_stderr_apart() -> None:
    sandbox, raw = sandbox_with(lambda argv: (3, "out\n", "err\n"))

    result = await sandbox.exec_with_output("sudo", "bash", "-c", "echo 'a b'; exit 3")

    assert result == (3, "out\n", "err\n")
    assert raw.process.commands == [["sudo", "bash", "-c", "echo 'a b'; exit 3"]]


async def test_every_session_is_deleted_even_when_the_command_raises() -> None:
    sandbox, raw = sandbox_with(lambda argv: DaytonaError("boom"))

    with pytest.raises(DaytonaError):
        await sandbox.exec_with_output("true")

    assert raw.process.open_sessions == set() and len(raw.process.deleted_sessions) == 1


async def test_a_dropped_connection_reads_as_exit_minus_one_which_exec_script_retries() -> None:
    outcomes: list[Outcome] = [DaytonaConnectionError("reset"), (0, "ok\n", "")]
    sandbox, raw = sandbox_with(lambda argv: outcomes.pop(0))

    assert await sandbox.exec_script("echo ok", max_retries=1) == "ok\n"
    assert len(raw.process.commands) == 2


async def test_a_dropped_connection_without_retries_fails_the_script_with_exit_minus_one() -> None:
    sandbox, _ = sandbox_with(lambda argv: DaytonaConnectionError("reset"))

    with pytest.raises(RuntimeError, match=r"exit -1"):
        await sandbox.exec_script("echo ok")


async def test_a_missing_exit_code_reads_as_minus_one() -> None:
    sandbox, _ = sandbox_with(lambda argv: (None, "", ""))

    assert (await sandbox.exec_with_output("true"))[0] == -1


async def test_terminate_of_a_gone_sandbox_is_not_an_error() -> None:
    sandbox, raw = sandbox_with(lambda argv: (0, "", ""))
    raw.delete_error = DaytonaNotFoundError("gone")

    await sandbox.terminate()

    assert raw.deletes == 1


async def test_terminate_of_a_sandbox_daytona_is_already_deleting_is_not_an_error() -> None:
    sandbox, raw = sandbox_with(lambda argv: (0, "", ""))
    raw.delete_error, raw.desired_state = (
        DaytonaConflictError("state change in progress"),
        "destroyed",
    )

    await sandbox.terminate()

    assert raw.deletes == 1


async def test_terminate_retries_a_409_for_another_state_change_in_progress() -> None:
    sandbox, raw = sandbox_with(lambda argv: (0, "", ""))
    raw.delete_failures = [DaytonaConflictError("state change in progress")]
    sandbox._DELETE_RETRY_DELAY = 0

    await sandbox.terminate()

    assert (raw.deletes, raw.state) == (2, "destroyed")


async def test_terminate_gives_up_on_a_409_that_never_clears() -> None:
    sandbox, raw = sandbox_with(lambda argv: (0, "", ""))
    raw.delete_error = DaytonaConflictError("state change in progress")
    sandbox._DELETE_RETRY_DELAY = 0

    with pytest.raises(DaytonaConflictError):
        await sandbox.terminate()

    assert raw.deletes == sandbox._DELETE_ATTEMPTS


async def test_terminate_surfaces_other_failures() -> None:
    sandbox, raw = sandbox_with(lambda argv: (0, "", ""))
    raw.delete_error = DaytonaError("server error")

    with pytest.raises(DaytonaError):
        await sandbox.terminate()


async def test_wait_for_vm_starts_dockerd_then_polls_docker_info_until_it_answers() -> None:
    answers = iter([(1, "", "no socket"), (1, "", "no socket"), (0, "29.9.1\n", "")])

    def handler(argv: list[str]) -> Outcome:
        return next(answers) if argv[:3] == ["sudo", "docker", "info"] else (0, "", "")

    sandbox, raw = sandbox_with(handler)

    await fast(sandbox).wait_for_vm()

    assert raw.process.commands[0] == ["sudo", "bash", "-c", DOCKER_START_SCRIPT]
    assert sum(cmd[:3] == ["sudo", "docker", "info"] for cmd in raw.process.commands) == 3


async def test_wait_for_vm_gives_up_with_the_dockerd_log_tail() -> None:
    def handler(argv: list[str]) -> Outcome:
        if argv[:2] == ["sudo", "tail"]:
            return (0, "level=fatal msg=boom\n", "")
        return (1, "", "no socket") if argv[:3] == ["sudo", "docker", "info"] else (0, "", "")

    sandbox, _ = sandbox_with(handler)

    with pytest.raises(RuntimeError, match="level=fatal msg=boom"):
        await fast(sandbox).wait_for_vm()


async def test_setup_for_gateway_requires_the_compose_v2_plugin() -> None:
    def handler(argv: list[str]) -> Outcome:
        return (
            (1, "", "'compose' is not a docker command")
            if argv[2:4] == ["compose", "version"]
            else (0, "", "")
        )

    sandbox, _ = sandbox_with(handler)

    with pytest.raises(RuntimeError, match="Compose v2"):
        await fast(sandbox).setup_vm_for_gateway([8080])


async def test_setup_for_gateway_opens_no_firewall_ports() -> None:
    sandbox, raw = sandbox_with(lambda argv: (0, "v5\n", ""))

    await fast(sandbox).setup_vm_for_gateway([8080])

    assert not any("iptables" in " ".join(cmd) for cmd in raw.process.commands)
