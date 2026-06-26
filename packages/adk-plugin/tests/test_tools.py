"""Unit tests for Daytona ADK tools."""

from typing import Generator
from unittest.mock import MagicMock

import pytest

from daytona_adk import DaytonaPlugin
from daytona_adk.tools import (
    ExecuteCodeTool,
    ExecuteCommandTool,
    ReadFileTool,
    StartLongRunningCommandTool,
    UploadFileTool,
)


@pytest.fixture(scope="module")
def plugin() -> Generator[DaytonaPlugin, None, None]:
    """Create a DaytonaPlugin instance shared across tests."""
    p = DaytonaPlugin(
        sandbox_name="test-sandbox",
        env_vars={"TEST_ENV": "test_value", "DEBUG": "true"},
        labels={"test": "integration", "project": "daytona-adk"},
        auto_stop_interval=30,
        auto_delete_interval=60,
    )
    yield p
    p.destroy_sandbox()


@pytest.fixture
def mock_tool_context() -> MagicMock:
    """Create a mock ToolContext - our tools don't use it."""
    return MagicMock()


class TestExecuteCodeTool:
    """Tests for ExecuteCodeTool."""

    @pytest.mark.asyncio
    async def test_execute_python_code(
        self, plugin: DaytonaPlugin, mock_tool_context: MagicMock
    ) -> None:
        """Test executing Python code."""
        tool = ExecuteCodeTool(plugin._sandbox)
        result = await tool.run_async(
            args={"code": "print('hello world')"},
            tool_context=mock_tool_context,
        )
        assert result["exit_code"] == 0
        assert "hello world" in result["result"]

    @pytest.mark.asyncio
    async def test_execute_python_with_env(
        self, plugin: DaytonaPlugin, mock_tool_context: MagicMock
    ) -> None:
        """Test executing Python code with environment variables."""
        tool = ExecuteCodeTool(plugin._sandbox)
        result = await tool.run_async(
            args={
                "code": "import os; print(os.environ.get('MY_VAR', 'not found'))",
                "env": {"MY_VAR": "test_value"},
            },
            tool_context=mock_tool_context,
        )
        assert result["exit_code"] == 0
        assert "test_value" in result["result"]

    @pytest.mark.asyncio
    async def test_execute_javascript_code(
        self, plugin: DaytonaPlugin, mock_tool_context: MagicMock
    ) -> None:
        """Test executing JavaScript code."""
        tool = ExecuteCodeTool(plugin._sandbox)
        result = await tool.run_async(
            args={
                "code": "console.log('hello from js')",
                "language": "javascript",
            },
            tool_context=mock_tool_context,
        )
        assert result["exit_code"] == 0
        assert "hello from js" in result["result"]

    @pytest.mark.asyncio
    async def test_execute_typescript_code(
        self, plugin: DaytonaPlugin, mock_tool_context: MagicMock
    ) -> None:
        """Test executing TypeScript code."""
        tool = ExecuteCodeTool(plugin._sandbox)
        result = await tool.run_async(
            args={
                "code": "const msg: string = 'hello from ts'; console.log(msg)",
                "language": "typescript",
            },
            tool_context=mock_tool_context,
        )
        assert result["exit_code"] == 0
        assert "hello from ts" in result["result"]

    @pytest.mark.asyncio
    async def test_execute_python_syntax_error(
        self, plugin: DaytonaPlugin, mock_tool_context: MagicMock
    ) -> None:
        """Test Python code with syntax error."""
        tool = ExecuteCodeTool(plugin._sandbox)
        result = await tool.run_async(
            args={"code": "print('unclosed"},
            tool_context=mock_tool_context,
        )
        assert result["exit_code"] != 0 or "error" in result

    @pytest.mark.asyncio
    async def test_execute_unsupported_language(
        self, plugin: DaytonaPlugin, mock_tool_context: MagicMock
    ) -> None:
        """Test unsupported language returns error."""
        tool = ExecuteCodeTool(plugin._sandbox)
        result = await tool.run_async(
            args={"code": "code", "language": "ruby"},
            tool_context=mock_tool_context,
        )
        assert "error" in result
        assert "Unsupported language" in result["error"]

    @pytest.mark.asyncio
    async def test_execute_python_with_timeout(
        self, plugin: DaytonaPlugin, mock_tool_context: MagicMock
    ) -> None:
        """Test Python code execution with timeout."""
        tool = ExecuteCodeTool(plugin._sandbox)
        result = await tool.run_async(
            args={
                "code": "import time; time.sleep(10)",
                "language": "python",
                "timeout": 2,
            },
            tool_context=mock_tool_context,
        )
        # Should timeout and return error
        assert result["exit_code"] != 0 and "error" in result


class TestExecuteCommandTool:
    """Tests for ExecuteCommandTool."""

    @pytest.mark.asyncio
    async def test_execute_simple_command(
        self, plugin: DaytonaPlugin, mock_tool_context: MagicMock
    ) -> None:
        """Test executing a simple shell command."""
        tool = ExecuteCommandTool(plugin._sandbox)
        result = await tool.run_async(
            args={"command": "echo 'hello shell'"},
            tool_context=mock_tool_context,
        )
        assert result["exit_code"] == 0
        assert "hello shell" in result["result"]

    @pytest.mark.asyncio
    async def test_execute_command_with_cwd(
        self, plugin: DaytonaPlugin, mock_tool_context: MagicMock
    ) -> None:
        """Test executing command with working directory."""
        tool = ExecuteCommandTool(plugin._sandbox)
        result = await tool.run_async(
            args={"command": "pwd", "cwd": "/tmp"},
            tool_context=mock_tool_context,
        )
        assert result["exit_code"] == 0
        assert "/tmp" in result["result"]

    @pytest.mark.asyncio
    async def test_execute_command_with_env(
        self, plugin: DaytonaPlugin, mock_tool_context: MagicMock
    ) -> None:
        """Test executing command with environment variables."""
        tool = ExecuteCommandTool(plugin._sandbox)
        result = await tool.run_async(
            args={
                "command": "echo $TEST_VAR",
                "env": {"TEST_VAR": "env_test"},
            },
            tool_context=mock_tool_context,
        )
        assert result["exit_code"] == 0
        assert "env_test" in result["result"]

    @pytest.mark.asyncio
    async def test_execute_failing_command(
        self, plugin: DaytonaPlugin, mock_tool_context: MagicMock
    ) -> None:
        """Test command that fails."""
        tool = ExecuteCommandTool(plugin._sandbox)
        result = await tool.run_async(
            args={"command": "exit 1"},
            tool_context=mock_tool_context,
        )
        assert result["exit_code"] != 0

    @pytest.mark.asyncio
    async def test_execute_command_with_timeout(
        self, plugin: DaytonaPlugin, mock_tool_context: MagicMock
    ) -> None:
        """Test command execution with timeout."""
        tool = ExecuteCommandTool(plugin._sandbox)
        result = await tool.run_async(
            args={
                "command": "sleep 10",
                "timeout": 2,
            },
            tool_context=mock_tool_context,
        )
        # Should timeout and return error
        assert result["exit_code"] != 0 and "error" in result


class TestUploadFileTool:
    """Tests for UploadFileTool."""

    @pytest.mark.asyncio
    async def test_upload_file(self, plugin: DaytonaPlugin, mock_tool_context: MagicMock) -> None:
        """Test uploading a file."""
        tool = UploadFileTool(plugin._sandbox)
        result = await tool.run_async(
            args={
                "file_path": "/tmp/test_upload.txt",
                "content": "test content here",
            },
            tool_context=mock_tool_context,
        )
        assert result["success"] is True
        assert result["path"] == "/tmp/test_upload.txt"

    @pytest.mark.asyncio
    async def test_upload_file_with_special_chars(
        self, plugin: DaytonaPlugin, mock_tool_context: MagicMock
    ) -> None:
        """Test uploading file with special characters."""
        tool = UploadFileTool(plugin._sandbox)
        content = "line1\nline2\ttabbed\n{'json': 'value'}"
        result = await tool.run_async(
            args={
                "file_path": "/tmp/test_special.txt",
                "content": content,
            },
            tool_context=mock_tool_context,
        )
        assert result["success"] is True


class TestReadFileTool:
    """Tests for ReadFileTool."""

    @pytest.mark.asyncio
    async def test_read_file(self, plugin: DaytonaPlugin, mock_tool_context: MagicMock) -> None:
        """Test reading a file that was uploaded."""
        # First upload a file
        upload_tool = UploadFileTool(plugin._sandbox)
        await upload_tool.run_async(
            args={
                "file_path": "/tmp/test_read.txt",
                "content": "content to read",
            },
            tool_context=mock_tool_context,
        )

        # Then read it
        read_tool = ReadFileTool(plugin._sandbox)
        result = await read_tool.run_async(
            args={"file_path": "/tmp/test_read.txt"},
            tool_context=mock_tool_context,
        )
        assert result["content"] == "content to read"
        assert result["path"] == "/tmp/test_read.txt"

    @pytest.mark.asyncio
    async def test_read_nonexistent_file(
        self, plugin: DaytonaPlugin, mock_tool_context: MagicMock
    ) -> None:
        """Test reading a file that doesn't exist."""
        tool = ReadFileTool(plugin._sandbox)
        result = await tool.run_async(
            args={"file_path": "/tmp/nonexistent_file_12345.txt"},
            tool_context=mock_tool_context,
        )
        assert "error" in result


class TestStartLongRunningCommandTool:
    """Tests for StartLongRunningCommandTool."""

    @pytest.mark.asyncio
    async def test_start_command(self, plugin: DaytonaPlugin, mock_tool_context: MagicMock) -> None:
        """Test starting a command in a session."""
        tool = StartLongRunningCommandTool(plugin._sandbox)
        result = await tool.run_async(
            args={"command": "echo 'session test'"},
            tool_context=mock_tool_context,
        )
        assert "session_id" in result
        assert result["session_id"].startswith("long-running-")


class TestToolDeclarations:
    """Test that all tools have valid declarations."""

    def test_execute_code_tool_declaration(self, plugin: DaytonaPlugin) -> None:
        """Test ExecuteCodeTool has valid declaration."""
        tool = ExecuteCodeTool(plugin._sandbox)
        decl = tool._get_declaration()
        assert decl.name == "execute_code_in_daytona"
        assert decl.parameters is not None
        assert decl.parameters.properties is not None
        assert "code" in decl.parameters.properties
        assert "language" in decl.parameters.properties
        assert decl.parameters.required is not None
        assert "code" in decl.parameters.required

    def test_execute_command_tool_declaration(self, plugin: DaytonaPlugin) -> None:
        """Test ExecuteCommandTool has valid declaration."""
        tool = ExecuteCommandTool(plugin._sandbox)
        decl = tool._get_declaration()
        assert decl.name == "execute_command_in_daytona"
        assert decl.parameters is not None
        assert decl.parameters.properties is not None
        assert "command" in decl.parameters.properties
        assert "cwd" in decl.parameters.properties
        assert "env" in decl.parameters.properties

    def test_upload_file_tool_declaration(self, plugin: DaytonaPlugin) -> None:
        """Test UploadFileTool has valid declaration."""
        tool = UploadFileTool(plugin._sandbox)
        decl = tool._get_declaration()
        assert decl.name == "upload_file_to_daytona"
        assert decl.parameters is not None
        assert decl.parameters.properties is not None
        assert "file_path" in decl.parameters.properties
        assert "content" in decl.parameters.properties

    def test_read_file_tool_declaration(self, plugin: DaytonaPlugin) -> None:
        """Test ReadFileTool has valid declaration."""
        tool = ReadFileTool(plugin._sandbox)
        decl = tool._get_declaration()
        assert decl.name == "read_file_from_daytona"
        assert decl.parameters is not None
        assert decl.parameters.properties is not None
        assert "file_path" in decl.parameters.properties

    def test_start_long_running_command_tool_declaration(self, plugin: DaytonaPlugin) -> None:
        """Test StartLongRunningCommandTool has valid declaration."""
        tool = StartLongRunningCommandTool(plugin._sandbox)
        decl = tool._get_declaration()
        assert decl.name == "start_long_running_command_daytona"
        assert decl.parameters is not None
        assert decl.parameters.properties is not None
        assert "command" in decl.parameters.properties
        assert "timeout" in decl.parameters.properties
