"""Live integration tests against a real Daytona backend (needs DAYTONA_API_KEY)."""

import asyncio
import json
import os
import shlex
import statistics
import time
import uuid
from collections.abc import AsyncGenerator

import pytest
import pytest_asyncio
from daytona import (
    AsyncDaytona,
    AsyncSandbox,
    CreateSandboxFromImageParams,
    CreateSandboxFromSnapshotParams,
)

from pydantic_ai_daytona import (
    DaytonaSandbox,
    DaytonaSandboxError,
    DaytonaSandboxSession,
    DaytonaSandboxTerminalError,
)
from pydantic_ai_daytona._toolset import DaytonaSandboxToolset

from .conftest import LABELS, is_gone, listed_sandboxes

# One sandbox is shared across this module's tests, so every test must run on the
# same (module-scoped) event loop the sandbox's HTTP client was created on.
pytestmark = [
    pytest.mark.skipif(
        not os.environ.get("DAYTONA_API_KEY"),
        reason="DAYTONA_API_KEY not set; these tests require a live Daytona backend",
    ),
    pytest.mark.asyncio(loop_scope="module"),
]


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def session(backend: AsyncDaytona) -> AsyncGenerator[DaytonaSandboxSession, None]:
    async with DaytonaSandboxSession(
        env={"MARKER": "pydantic-ai-daytona"}, labels=LABELS
    ) as live_session:
        yield live_session


async def test_session_exposes_sandbox_id(session: DaytonaSandboxSession) -> None:
    assert session.sandbox_id


async def test_exec_captures_output_and_exit_code(session: DaytonaSandboxSession) -> None:
    result = await session.exec("echo hello && echo world", timeout=30)
    assert result.exit_code == 0
    assert "hello" in result.stdout
    assert "world" in result.stdout

    failing = await session.exec("exit 3", timeout=30)
    assert failing.exit_code == 3


async def test_exec_separates_stdout_and_stderr(session: DaytonaSandboxSession) -> None:
    result = await session.exec("echo to-out && echo to-err >&2", timeout=30)
    assert "to-out" in result.stdout
    assert "to-err" in result.stderr
    assert "to-err" not in result.stdout


async def test_bare_exit_reports_exit_code_instead_of_hanging(
    session: DaytonaSandboxSession,
) -> None:
    result = await session.exec("echo before && exit 7", timeout=30)
    assert result.exit_code == 7
    assert "before" in result.stdout
    assert not result.timed_out


async def test_exec_is_stateless_between_commands(session: DaytonaSandboxSession) -> None:
    await session.exec("cd /tmp && export LEAKED=1", timeout=30)
    result = await session.exec("pwd && printenv LEAKED || true", timeout=30)
    assert "/tmp" not in result.stdout
    assert "1" not in result.stdout.splitlines()


async def test_exec_sees_sandbox_env(session: DaytonaSandboxSession) -> None:
    result = await session.exec("printenv MARKER", timeout=30)
    assert "pydantic-ai-daytona" in result.stdout


async def test_exec_timeout_is_reported_and_next_command_is_not_blocked(
    session: DaytonaSandboxSession,
) -> None:
    result = await session.exec("echo before; echo warning >&2; sleep 30", timeout=1)
    assert result.timed_out
    assert result.stdout == "before\n"
    assert result.stderr == "warning\n"
    after = await session.exec("echo recovered", timeout=30)
    assert "recovered" in after.stdout


async def test_concurrent_commands_run_in_parallel(session: DaytonaSandboxSession) -> None:
    started = time.monotonic()
    results = await asyncio.gather(
        session.exec("sleep 4 && echo a", timeout=30),
        session.exec("sleep 4 && echo b", timeout=30),
    )
    elapsed = time.monotonic() - started
    assert [r.exit_code for r in results] == [0, 0]
    # Serialized execution needs >=8s of sleep alone; parallel sessions need ~4s plus
    # overhead. The 7.5s bound leaves headroom for slow runners on both sides.
    assert elapsed < 7.5, f"commands appear serialized ({elapsed:.1f}s)"


async def test_attach_by_sandbox_id_reuses_sandbox_and_leaves_it_running(
    session: DaytonaSandboxSession,
) -> None:
    assert session.sandbox_id is not None
    async with DaytonaSandboxSession(sandbox_id=session.sandbox_id) as attached:
        assert attached.sandbox_id == session.sandbox_id
        result = await attached.exec("echo attached", timeout=30)
        assert "attached" in result.stdout
    # Exiting an attached session must not delete the sandbox it does not own.
    still_alive = await session.exec("echo alive", timeout=30)
    assert "alive" in still_alive.stdout


async def test_attach_starts_a_stopped_sandbox(backend: AsyncDaytona) -> None:
    sandbox = await backend.create(CreateSandboxFromSnapshotParams(labels=LABELS), timeout=120)
    try:
        await sandbox.stop()
        async with DaytonaSandboxSession(sandbox_id=sandbox.id) as attached:
            result = await attached.exec("echo restarted", timeout=30)
            assert "restarted" in result.stdout
    finally:
        await sandbox.delete(wait=True)


async def test_file_roundtrip(session: DaytonaSandboxSession) -> None:
    path = f"pai-test-{uuid.uuid4().hex}/notes.txt"
    await session.write_bytes(path, b"line 1\nline 2\n")
    assert await session.file_size(path) == 14
    assert await session.read_bytes(path) == b"line 1\nline 2\n"
    entries = await session.list_entries(path.rsplit("/", 1)[0])
    assert ("notes.txt", False) in entries


async def test_file_size_rejects_directories(session: DaytonaSandboxSession) -> None:
    directory = f"pai-test-dir-{uuid.uuid4().hex}"
    await session.exec(f"mkdir -p {directory}", timeout=30)
    with pytest.raises(DaytonaSandboxError, match="is a directory"):
        await session.file_size(directory)


async def test_toolset_end_to_end_with_injected_session(session: DaytonaSandboxSession) -> None:
    toolset: DaytonaSandboxToolset[None] = DaytonaSandboxToolset(
        snapshot=None,
        image=None,
        sandbox_id=None,
        env=None,
        workdir=None,
        labels=None,
        os_user=None,
        ephemeral=None,
        network_block_all=None,
        network_allow_list=None,
        domain_allow_list=None,
        auto_stop_interval=None,
        auto_delete_interval=None,
        api_key=None,
        api_url=None,
        target=None,
        default_command_timeout=60.0,
        max_command_timeout=300,
        max_output_bytes=50 * 1024,
        max_output_lines=2000,
        max_read_bytes=5 * 1024 * 1024,
        session=session,
        _run_scoped=True,
    )
    async with toolset:
        marker = uuid.uuid4().hex
        await toolset.write_file(f"{marker}.txt", "from the toolset\n")
        assert "from the toolset" in await toolset.read_file(f"{marker}.txt")
        assert f"{marker}.txt" in await toolset.list_directory(".")
        out = await toolset.run_command(f"cat {marker}.txt")
        assert "from the toolset" in out


async def test_stdin_is_closed(session: DaytonaSandboxSession) -> None:
    started = time.monotonic()
    result = await session.exec("cat", timeout=5)
    assert result.exit_code == 0
    assert not result.timed_out
    assert result.stdout == ""
    assert time.monotonic() - started < 5


async def test_attached_env_preserves_tricky_values(session: DaytonaSandboxSession) -> None:
    env = {"SPECIAL": "spaces 'single' \"double\" $HOME\nsecond line", "-dashed-name": "-literal"}
    assert session.sandbox_id is not None
    capability: DaytonaSandbox[None] = DaytonaSandbox(sandbox_id=session.sandbox_id, env=env)
    toolset = capability.get_toolset()
    assert isinstance(toolset, DaytonaSandboxToolset)
    toolset._run_scoped = True
    code = (
        "import os,json; print(json.dumps({k:os.environ[k] for k in ['SPECIAL','-dashed-name']}))"
    )
    async with toolset:
        output = await toolset.run_command(f"python3 -c {shlex.quote(code)}")
    assert json.loads(output.removeprefix("[stdout]\n")) == env


async def test_large_output_is_bounded_before_transfer(session: DaytonaSandboxSession) -> None:
    cap = 64 * 1024
    result = await session.exec(
        "head -c 10485760 /dev/zero | tr '\\0' x; printf 'stdout-tail'; "
        "head -c 10485760 /dev/zero | tr '\\0' y >&2; printf 'stderr-tail' >&2",
        timeout=30,
        max_output_bytes=cap,
    )
    assert len(result.stdout.encode()) == cap
    assert len(result.stderr.encode()) == cap
    assert result.stdout.endswith("stdout-tail")
    assert result.stderr.endswith("stderr-tail")
    assert result.stdout_truncated and result.stderr_truncated


async def test_cancelled_creation_leaves_no_orphan(
    backend: AsyncDaytona, monkeypatch: pytest.MonkeyPatch
) -> None:
    labels = {**LABELS, "case": f"cancel-{uuid.uuid4().hex}"}
    create_started = asyncio.Event()
    created: list[str] = []
    original_create = AsyncDaytona.create

    async def create(
        client: AsyncDaytona,
        params: CreateSandboxFromSnapshotParams | CreateSandboxFromImageParams,
        *,
        timeout: float,
    ) -> AsyncSandbox:
        create_started.set()
        sandbox = await original_create(client, params, timeout=timeout)
        created.append(sandbox.id)
        return sandbox

    monkeypatch.setattr(AsyncDaytona, "create", create)
    entering = asyncio.create_task(DaytonaSandboxSession(labels=labels).__aenter__())
    await asyncio.wait_for(create_started.wait(), timeout=30)
    assert not entering.done(), "Creation finished before cancellation could exercise it"
    entering.cancel()
    with pytest.raises(asyncio.CancelledError):
        await entering
    # Creation must run to completion despite the cancellation, so its id is always known.
    assert created, "create never returned, so the created sandbox cannot be verified"
    remaining = [sandbox_id for sandbox_id in created if not await is_gone(backend, sandbox_id)]
    assert not remaining, f"Orphaned sandboxes: {remaining}"
    assert not await listed_sandboxes(backend, labels)


async def test_out_of_band_deletion_is_terminal(backend: AsyncDaytona) -> None:
    async with DaytonaSandboxSession(labels=LABELS) as session:
        assert session.sandbox_id is not None
        sandbox = await backend.get(session.sandbox_id)
        await sandbox.delete(wait=True)
        with pytest.raises(DaytonaSandboxTerminalError):
            await session.exec("echo cannot-run", timeout=5)


async def test_workdir_anchors_commands_and_files(session: DaytonaSandboxSession) -> None:
    directory = f"/tmp/pai-workdir-{uuid.uuid4().hex}"
    await session.exec(f"mkdir -p {directory}", timeout=30)
    async with DaytonaSandboxSession(sandbox_id=session.sandbox_id, workdir=directory) as attached:
        await attached.write_bytes("anchored.txt", b"anchored\n")
        result = await attached.exec("pwd; cat anchored.txt", timeout=30)
        assert result.stdout == f"{directory}\nanchored\n"
        assert await attached.read_bytes("anchored.txt") == b"anchored\n"


async def test_command_latency(session: DaytonaSandboxSession) -> None:
    times = []
    for _ in range(5):
        started = time.perf_counter()
        result = await session.exec("echo hi", timeout=30)
        times.append(time.perf_counter() - started)
        assert result.stdout == "hi\n"
    print(f"\nAfter echo hi seconds: {times}; median={statistics.median(times):.6f}")
