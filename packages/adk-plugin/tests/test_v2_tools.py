"""Offline regression coverage of v2 result adaptation."""

from unittest.mock import create_autospec, PropertyMock

import anyio
import pytest
from daytona.v2 import Sandbox
from daytona.v2.types import InterpreterError, InterpreterLogs, InterpreterProcess, InterpreterResult, ProcessResult
from google.adk.tools import ToolContext

from daytona_adk.tools import ExecuteCodeTool, ExecuteCommandTool, ReadFileTool, UploadFileTool, StartLongRunningCommandTool


@pytest.mark.asyncio
async def test_python_returns_logs_when_process_exits():
    # Given: the SDK's real v2 result type, not a v0 ExecuteResponse.
    sandbox = create_autospec(Sandbox, instance=True)
    sandbox.run_code.return_value = InterpreterResult(
        process=InterpreterProcess("p", 0, None, "exited"),
        logs=InterpreterLogs(stdout="2\n", stderr="diagnostic"),
    )
    # When
    result = await ExecuteCodeTool(sandbox).run_async(args={"code": "print(1+1)"}, tool_context=create_autospec(ToolContext))
    # Then
    assert result == {"result": "2\ndiagnostic", "exit_code": 0}


@pytest.mark.asyncio
async def test_python_reports_error_when_interpreter_fails_with_zero_process_exit():
    # Given
    sandbox = create_autospec(Sandbox, instance=True)
    sandbox.run_code.return_value = InterpreterResult(
        process=InterpreterProcess("p", 0, None, "exited"),
        error=InterpreterError("SyntaxError", "invalid syntax", ["SyntaxError: invalid syntax"]),
    )
    # When
    result = await ExecuteCodeTool(sandbox).run_async(args={"code": "("}, tool_context=create_autospec(ToolContext))
    # Then
    assert result["exit_code"] == -1
    assert "SyntaxError" in result["error"]


@pytest.mark.asyncio
@pytest.mark.parametrize("reason", ["timed_out", "signaled", "lost", "failed", "unknown"])
async def test_shell_reports_failure_when_process_did_not_exit(reason):
    # Given
    sandbox = create_autospec(Sandbox, instance=True)
    sandbox.exec.return_value = ProcessResult("p", None, None, reason, output="partial")
    # When
    result = await ExecuteCommandTool(sandbox).run_async(args={"command": "sleep 10", "timeout": 2}, tool_context=create_autospec(ToolContext))
    # Then
    assert result == {"result": "partial", "error": reason, "exit_code": -1}


@pytest.mark.asyncio
async def test_shell_returns_output_when_command_exits_nonzero():
    # Given
    sandbox = create_autospec(Sandbox, instance=True)
    sandbox.exec.return_value = ProcessResult("p", 7, None, "exited", output="failure detail")
    # When
    result = await ExecuteCommandTool(sandbox).run_async(args={"command": "exit 7"}, tool_context=create_autospec(ToolContext))
    # Then
    assert result == {"result": "failure detail", "exit_code": 7}


@pytest.mark.asyncio
async def test_file_roundtrip_when_content_is_unicode():
    # Given: a wire-free bytes store, shared by upload and read.
    files: dict[str, bytes] = {}
    sandbox = create_autospec(Sandbox, instance=True)
    sandbox.fs.write_bytes.side_effect = files.__setitem__
    sandbox.fs.read_bytes.side_effect = files.__getitem__
    fs = sandbox.fs

    def worker_fs():
        with pytest.raises(RuntimeError):
            anyio.get_current_task()
        return fs

    type(sandbox).fs = PropertyMock(side_effect=worker_fs)
    await UploadFileTool(sandbox).run_async(args={"file_path": "/tmp/a", "content": "héllo\n"}, tool_context=create_autospec(ToolContext))
    # When
    result = await ReadFileTool(sandbox).run_async(args={"file_path": "/tmp/a"}, tool_context=create_autospec(ToolContext))
    # Then
    assert result == {"content": "héllo\n", "path": "/tmp/a"}


@pytest.mark.asyncio
async def test_background_returns_actual_ids_when_started():
    # Given
    sandbox = create_autospec(Sandbox, instance=True)
    session = sandbox.process.create_session.return_value
    session.id = "server-session-id"
    # When
    result = await StartLongRunningCommandTool(sandbox).run_async(args={"command": "sleep 10", "timeout": 2}, tool_context=create_autospec(ToolContext))
    # Then
    assert result == {"session_id": "server-session-id", "output": "", "exit_code": None}
    session.start.assert_called_once_with("sleep 10", execution_timeout=2)


@pytest.mark.asyncio
async def test_upload_returns_error_dict_when_sdk_raises_non_daytona_error():
    # Given: the Step A contract catches every exception.
    sandbox = create_autospec(Sandbox, instance=True)
    sandbox.fs.write_bytes.side_effect = RuntimeError("boom")
    # When
    result = await UploadFileTool(sandbox).run_async(args={"file_path": "/tmp/a", "content": "x"}, tool_context=create_autospec(ToolContext))
    # Then
    assert result == {"error": "boom", "success": False}


@pytest.mark.asyncio
async def test_upload_writes_empty_bytes_when_content_is_missing():
    # Given
    sandbox = create_autospec(Sandbox, instance=True)
    # When
    result = await UploadFileTool(sandbox).run_async(args={"file_path": "/tmp/a"}, tool_context=create_autospec(ToolContext))
    # Then
    assert result == {"success": True, "path": "/tmp/a"}
    sandbox.fs.write_bytes.assert_called_once_with("/tmp/a", b"")


@pytest.mark.asyncio
async def test_read_returns_error_dict_when_file_path_is_missing_and_sdk_raises():
    # Given
    sandbox = create_autospec(Sandbox, instance=True)
    sandbox.fs.read_bytes.side_effect = RuntimeError("no path")
    # When
    result = await ReadFileTool(sandbox).run_async(args={}, tool_context=create_autospec(ToolContext))
    # Then
    assert result == {"error": "no path", "content": None}
    sandbox.fs.read_bytes.assert_called_once_with("")
