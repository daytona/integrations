"""Live integration tests against a real Daytona backend (needs DAYTONA_API_KEY)."""

import asyncio
import os
import time
import uuid
from collections.abc import AsyncGenerator

import pytest
import pytest_asyncio

from pydantic_ai_daytona import DaytonaSandboxError, DaytonaSandboxSession
from pydantic_ai_daytona._toolset import DaytonaSandboxToolset

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
async def session() -> AsyncGenerator[DaytonaSandboxSession, None]:
    async with DaytonaSandboxSession(env={"MARKER": "pydantic-ai-daytona"}) as live_session:
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
    result = await session.exec("sleep 30", timeout=1)
    assert result.timed_out
    after = await session.exec("echo recovered", timeout=30)
    assert "recovered" in after.stdout


async def test_concurrent_commands_run_in_parallel(session: DaytonaSandboxSession) -> None:
    started = time.monotonic()
    results = await asyncio.gather(
        session.exec("sleep 2 && echo a", timeout=30),
        session.exec("sleep 2 && echo b", timeout=30),
    )
    elapsed = time.monotonic() - started
    assert [r.exit_code for r in results] == [0, 0]
    # Serialized execution would take >=4s; parallel sessions finish in ~2s.
    assert elapsed < 3.8, f"commands appear serialized ({elapsed:.1f}s)"


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


async def test_attach_starts_a_stopped_sandbox() -> None:
    from daytona import AsyncDaytona

    daytona = AsyncDaytona()
    sandbox = await daytona.create(timeout=120)
    try:
        await sandbox.stop()
        async with DaytonaSandboxSession(sandbox_id=sandbox.id) as attached:
            result = await attached.exec("echo restarted", timeout=30)
            assert "restarted" in result.stdout
    finally:
        await sandbox.delete()
        await daytona.close()


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
