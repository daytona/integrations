"""Unit tests for the sandbox toolset, driven through a fake session."""

from typing import Any, cast

import pytest
from pydantic_ai.exceptions import ModelRetry

from pydantic_ai_daytona._session import (
    DaytonaSandboxError,
    DaytonaSandboxExecResult,
    DaytonaSandboxSession,
    DaytonaSandboxTerminalError,
)
from pydantic_ai_daytona._toolset import DaytonaSandboxToolset


class FakeSession:
    """In-memory stand-in for DaytonaSandboxSession with scriptable failures."""

    def __init__(self) -> None:
        self.files: dict[str, bytes] = {}
        self.dirs: dict[str, list[tuple[str, bool]]] = {}
        self.exec_results: list[DaytonaSandboxExecResult] = []
        self.exec_calls: list[tuple[str, int]] = []
        self.error: DaytonaSandboxError | None = None
        self._sandbox_id: str | None = "sb-fake"

    @property
    def sandbox_id(self) -> str | None:
        return self._sandbox_id

    def _maybe_raise(self) -> None:
        if self.error is not None:
            raise self.error

    async def exec(self, command: str, *, timeout: int) -> DaytonaSandboxExecResult:
        self._maybe_raise()
        self.exec_calls.append((command, timeout))
        return self.exec_results.pop(0)

    async def file_size(self, path: str) -> int:
        self._maybe_raise()
        if path not in self.files:
            raise DaytonaSandboxError(f"no such file: {path}")
        return len(self.files[path])

    async def read_bytes(self, path: str) -> bytes:
        self._maybe_raise()
        return self.files[path]

    async def write_bytes(self, path: str, data: bytes) -> None:
        self._maybe_raise()
        self.files[path] = data

    async def list_entries(self, path: str) -> list[tuple[str, bool]]:
        self._maybe_raise()
        if path not in self.dirs:
            raise DaytonaSandboxError(f"no such directory: {path}")
        return self.dirs[path]


def make_toolset(session: FakeSession, **overrides: Any) -> DaytonaSandboxToolset[None]:
    settings: dict[str, Any] = {
        "snapshot": None,
        "image": None,
        "sandbox_id": None,
        "env": None,
        "workdir": None,
        "labels": None,
        "os_user": None,
        "ephemeral": None,
        "network_block_all": None,
        "network_allow_list": None,
        "domain_allow_list": None,
        "auto_stop_interval": None,
        "auto_delete_interval": None,
        "api_key": None,
        "api_url": None,
        "target": None,
        "default_command_timeout": 60.0,
        "max_command_timeout": 300,
        "max_output_bytes": 50 * 1024,
        "max_output_lines": 2000,
        "max_read_bytes": 5 * 1024 * 1024,
        "session": cast(DaytonaSandboxSession, session),
        "_run_scoped": True,
    }
    settings.update(overrides)
    return DaytonaSandboxToolset[None](**settings)


@pytest.fixture
def session() -> FakeSession:
    return FakeSession()


def ok(stdout: str, exit_code: int = 0, stderr: str = "") -> DaytonaSandboxExecResult:
    return DaytonaSandboxExecResult(
        stdout=stdout, stderr=stderr, exit_code=exit_code, timed_out=False, applied_timeout=60
    )


class TestLifecycle:
    async def test_external_session_is_used_but_not_closed(self, session: FakeSession) -> None:
        toolset = make_toolset(session)
        async with toolset:
            session.exec_results.append(ok("hi"))
            assert await toolset.run_command("echo hi") == "[stdout]\nhi"

    async def test_unopened_external_session_fails_at_run_start(self) -> None:
        closed = FakeSession()
        closed._sandbox_id = None
        toolset = make_toolset(closed)
        with pytest.raises(DaytonaSandboxError, match="not open"):
            await toolset.__aenter__()

    async def test_tool_call_without_entering_fails(self, session: FakeSession) -> None:
        toolset = make_toolset(session)
        with pytest.raises(DaytonaSandboxError, match="not open"):
            await toolset.run_command("echo hi")

    async def test_for_run_returns_run_scoped_copy(self, session: FakeSession) -> None:
        base = make_toolset(session, _run_scoped=False)
        run_toolset = await base.for_run(cast(Any, None))
        assert isinstance(run_toolset, DaytonaSandboxToolset)
        assert run_toolset is not base


class TestRunCommand:
    async def test_zero_exit_returns_labelled_stdout(self, session: FakeSession) -> None:
        toolset = make_toolset(session)
        async with toolset:
            session.exec_results.append(ok("hello\n"))
            assert await toolset.run_command("echo hello") == "[stdout]\nhello"

    async def test_streams_are_labelled_separately(self, session: FakeSession) -> None:
        toolset = make_toolset(session)
        async with toolset:
            session.exec_results.append(ok("out", stderr="err"))
            assert await toolset.run_command("cmd") == "[stdout]\nout\n[stderr]\nerr"

    async def test_stderr_only(self, session: FakeSession) -> None:
        toolset = make_toolset(session)
        async with toolset:
            session.exec_results.append(ok("", stderr="warning"))
            assert await toolset.run_command("cmd") == "[stderr]\nwarning"

    async def test_nonzero_exit_appends_exit_code(self, session: FakeSession) -> None:
        toolset = make_toolset(session)
        async with toolset:
            session.exec_results.append(ok("boom", exit_code=2))
            assert await toolset.run_command("false") == "[stdout]\nboom\n[exit code: 2]"

    async def test_empty_output_is_marked(self, session: FakeSession) -> None:
        toolset = make_toolset(session)
        async with toolset:
            session.exec_results.append(ok(""))
            assert await toolset.run_command("true") == "(no output)"

    async def test_timeout_is_reported(self, session: FakeSession) -> None:
        toolset = make_toolset(session)
        async with toolset:
            session.exec_results.append(
                DaytonaSandboxExecResult(
                    stdout="", stderr="", exit_code=-1, timed_out=True, applied_timeout=5
                )
            )
            out = await toolset.run_command("sleep 100", timeout_seconds=5)
            assert out == "[timed out after 5s; output was not captured]"

    async def test_each_stream_is_tail_truncated_separately(self, session: FakeSession) -> None:
        toolset = make_toolset(session, max_output_lines=2)
        async with toolset:
            session.exec_results.append(ok("a\nb\nc\n", stderr="x\ny\nz\n"))
            out = await toolset.run_command("seq 3")
            assert out == (
                "[stdout]\n[... output truncated to the last 2 lines ...]\nb\nc\n"
                "[stderr]\n[... output truncated to the last 2 lines ...]\ny\nz"
            )

    async def test_default_timeout_applied(self, session: FakeSession) -> None:
        toolset = make_toolset(session, default_command_timeout=42.4)
        async with toolset:
            session.exec_results.append(ok(""))
            await toolset.run_command("true")
            assert session.exec_calls == [("true", 43)]

    async def test_requested_timeout_clamped_to_ceiling(self, session: FakeSession) -> None:
        toolset = make_toolset(session, max_command_timeout=100)
        async with toolset:
            session.exec_results.append(ok(""))
            await toolset.run_command("true", timeout_seconds=500)
            assert session.exec_calls == [("true", 100)]

    async def test_non_positive_timeout_is_model_retry(self, session: FakeSession) -> None:
        toolset = make_toolset(session)
        async with toolset:
            with pytest.raises(ModelRetry, match="timeout_seconds must be greater than 0"):
                await toolset.run_command("true", timeout_seconds=0)

    async def test_sandbox_error_becomes_model_retry(self, session: FakeSession) -> None:
        toolset = make_toolset(session)
        async with toolset:
            session.error = DaytonaSandboxError("transient failure")
            with pytest.raises(ModelRetry, match="transient failure"):
                await toolset.run_command("true")

    async def test_terminal_error_propagates(self, session: FakeSession) -> None:
        toolset = make_toolset(session)
        async with toolset:
            session.error = DaytonaSandboxTerminalError("sandbox is gone")
            with pytest.raises(DaytonaSandboxTerminalError, match="sandbox is gone"):
                await toolset.run_command("true")


class TestReadFile:
    async def test_reads_whole_file(self, session: FakeSession) -> None:
        toolset = make_toolset(session)
        async with toolset:
            session.files["notes.txt"] = b"line 1\nline 2\n"
            assert await toolset.read_file("notes.txt") == "line 1\nline 2"

    async def test_missing_file_is_model_retry(self, session: FakeSession) -> None:
        toolset = make_toolset(session)
        async with toolset:
            with pytest.raises(ModelRetry, match="Could not read"):
                await toolset.read_file("missing.txt")

    async def test_oversized_file_is_refused(self, session: FakeSession) -> None:
        toolset = make_toolset(session, max_read_bytes=4)
        async with toolset:
            session.files["big.bin"] = b"12345"
            with pytest.raises(ModelRetry, match="read limit"):
                await toolset.read_file("big.bin")

    async def test_pages_with_offset_and_limit(self, session: FakeSession) -> None:
        toolset = make_toolset(session)
        async with toolset:
            session.files["f.txt"] = b"1\n2\n3\n4\n"
            out = await toolset.read_file("f.txt", offset=2, limit=2)
            assert out.startswith("2\n3")
            assert "offset=4" in out


class TestWriteFile:
    async def test_writes_and_reports_bytes(self, session: FakeSession) -> None:
        toolset = make_toolset(session)
        async with toolset:
            assert await toolset.write_file("out.txt", "hé") == "Wrote 3 bytes to 'out.txt'."
            assert session.files["out.txt"] == "hé".encode()

    async def test_unencodable_content_is_model_retry(self, session: FakeSession) -> None:
        toolset = make_toolset(session)
        async with toolset:
            with pytest.raises(ModelRetry, match="UTF-8"):
                await toolset.write_file("out.txt", "\ud800")

    async def test_write_error_is_model_retry(self, session: FakeSession) -> None:
        toolset = make_toolset(session)
        async with toolset:
            session.error = DaytonaSandboxError("disk full")
            with pytest.raises(ModelRetry, match="Could not write"):
                await toolset.write_file("out.txt", "data")


class TestListDirectory:
    async def test_marks_directories_with_slash(self, session: FakeSession) -> None:
        toolset = make_toolset(session)
        async with toolset:
            session.dirs["."] = [("app.py", False), ("src", True)]
            assert await toolset.list_directory() == "app.py\nsrc/"

    async def test_empty_directory(self, session: FakeSession) -> None:
        toolset = make_toolset(session)
        async with toolset:
            session.dirs["empty"] = []
            assert await toolset.list_directory("empty") == "(empty directory)"

    async def test_missing_directory_is_model_retry(self, session: FakeSession) -> None:
        toolset = make_toolset(session)
        async with toolset:
            with pytest.raises(ModelRetry, match="Could not list"):
                await toolset.list_directory("nope")
