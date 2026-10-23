from __future__ import annotations

import shlex
from types import SimpleNamespace
from typing import TYPE_CHECKING

import pytest
from daytona import DaytonaConnectionTimeoutError, DaytonaError, SandboxState

from pydantic_ai_daytona import DaytonaSandboxSession

if TYPE_CHECKING:
    from tests.unit_tests.conftest import FakeDaytona


@pytest.mark.parametrize("attached", [False, True])
@pytest.mark.parametrize(
    "probe_case",
    [
        (SimpleNamespace(exit_code=0, result="/bin/bash\n"), "/bin/bash"),
        (SimpleNamespace(exit_code=0, result="/usr/bin/bash\n"), "/usr/bin/bash"),
        (SimpleNamespace(exit_code=1, result=""), "/bin/sh"),
        (SimpleNamespace(exit_code=0, result=""), "/bin/sh"),
    ],
)
async def test_shell_is_detected_once_when_session_opens(
    sdk: FakeDaytona, attached: bool, probe_case: tuple[SimpleNamespace, str]
) -> None:
    # Given a ready owned or attached sandbox with this probe response.
    probe, expected_shell = probe_case
    sdk.sandbox.process.shell_probe = probe
    session = DaytonaSandboxSession(sandbox_id=sdk.sandbox.id if attached else None)
    # When multiple commands run in one opened session.
    async with session:
        assert session._shell == expected_shell
        first = await session.exec("printf first", timeout=5)
        second = await session.exec("printf second", timeout=5)
    # Then detection is cached and both invocations use the selected shell.
    assert (first.stdout, second.stdout) == ("first", "second")
    assert sdk.sandbox.process.shell_probes == 1
    assert len(sdk.sandbox.process.transferred) == 2
    for line in sdk.sandbox.process.commands:
        assert f"{expected_shell} -c" in shlex.split(line)[2]


@pytest.mark.parametrize(
    "command,expected",
    [
        ("exit 7", ("", "", 7)),
        ("cat; printf done", ("done", "", 0)),
        ("printf '%s' \"$SPECIAL\"", ("spaces '\"$HOME\nlast", "", 0)),
        ("printf stdout; printf stderr >&2; exit 23", ("stdout", "stderr", 23)),
    ],
)
async def test_command_semantics_when_only_sh_is_available(
    sdk: FakeDaytona, command: str, expected: tuple[str, str, int]
) -> None:
    # Given a sandbox without bash and a literally quoted environment value.
    sdk.sandbox.process.shell_probe = SimpleNamespace(exit_code=1, result="")
    async with DaytonaSandboxSession(env={"SPECIAL": "spaces '\"$HOME\nlast"}) as session:
        # When the command runs through the detected sh.
        result = await session.exec(command, timeout=1)
    # Then stdin, streams, quoting, and exit status retain their contracts.
    assert (result.stdout, result.stderr, result.exit_code) == expected
    assert not result.timed_out


async def test_bounded_partial_output_when_only_sh_is_available(sdk: FakeDaytona) -> None:
    # Given a sandbox without bash.
    sdk.sandbox.process.shell_probe = SimpleNamespace(exit_code=1, result="")
    async with DaytonaSandboxSession() as session:
        # When a command exceeds its deadline after writing both streams.
        result = await session.exec(
            "printf discarded-stdout; printf discarded-stderr >&2; sleep 30",
            timeout=1,
            max_output_bytes=6,
        )
    # Then the bounded stream tails survive the timeout.
    assert (result.stdout, result.stderr, result.exit_code) == ("stdout", "stderr", -1)
    assert result.stdout_truncated and result.stderr_truncated
    assert result.timed_out


@pytest.mark.parametrize("attached", [False, True])
@pytest.mark.parametrize(
    "error", [DaytonaError("probe failed"), DaytonaConnectionTimeoutError("probe timeout")]
)
async def test_shell_defaults_to_sh_when_probe_fails(
    sdk: FakeDaytona, attached: bool, error: DaytonaError
) -> None:
    # Given an SDK failure during the optional shell probe.
    sdk.sandbox.process.shell_probe_error = error
    # When the session opens and executes a command.
    async with DaytonaSandboxSession(
        sandbox_id=sdk.sandbox.id if attached else None
    ) as session:
        result = await session.exec("exit 7", timeout=5)
    # Then sh still executes with the exact status, without another probe.
    assert session._shell == "/bin/sh"
    assert (result.exit_code, result.timed_out) == (7, False)
    assert sdk.sandbox.process.shell_probes == 1


async def test_shell_is_detected_again_when_session_reopens(sdk: FakeDaytona) -> None:
    # Given an attached session previously opened with bash available.
    session = DaytonaSandboxSession(sandbox_id=sdk.sandbox.id)
    async with session:
        assert session._shell == "/bin/bash"
    sdk.sandbox.process.shell_probe = SimpleNamespace(exit_code=1, result="")
    # When the same session reopens after the image's available shells change.
    async with session:
        result = await session.exec("exit 7", timeout=5)
    # Then the previous cached shell is replaced.
    assert session._shell == "/bin/sh"
    assert result.exit_code == 7
    assert sdk.sandbox.process.shell_probes == 2


async def test_shell_probe_runs_after_attached_sandbox_is_ready(
    sdk: FakeDaytona, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Given a stopped sandbox whose shell is only accessible after startup.
    sdk.sandbox.state = SandboxState.STOPPED
    original_exec = sdk.sandbox.process.exec

    async def exec_when_ready(command: str, *, timeout: int) -> SimpleNamespace:
        assert sdk.sandbox.state == SandboxState.STARTED
        return await original_exec(command, timeout=timeout)

    monkeypatch.setattr(sdk.sandbox.process, "exec", exec_when_ready)
    # When attaching to it.
    async with DaytonaSandboxSession(sandbox_id=sdk.sandbox.id) as session:
        # Then the probe sees the started sandbox.
        assert session._shell == "/bin/bash"
    assert sdk.sandbox.process.shell_probes == 1
