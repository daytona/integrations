"""Daytona tools for ADK agents.

Provides ADK tool implementations for code execution in Daytona sandbox.
"""

import json
import logging
import shlex
import uuid
from functools import partial
from typing import Any, Dict

import anyio
from daytona.v2 import Sandbox
from google.adk.tools import BaseTool, ToolContext
from google.genai import types

logger = logging.getLogger(__name__)


class ExecuteCodeTool(BaseTool):
    """Tool for executing code snippets inside the Daytona sandbox."""

    def __init__(self, sandbox: Sandbox):
        super().__init__(
            name="execute_code_in_daytona",
            description=(
                "Execute Python, JavaScript, or TypeScript code inside the Daytona sandbox. "
                "Provide the code snippet and language. "
                "Supported languages: 'python' (default), 'javascript', 'typescript'."
            ),
        )
        self.sandbox = sandbox

    def _get_declaration(self) -> types.FunctionDeclaration:
        return types.FunctionDeclaration(
            name=self.name,
            description=self.description,
            parameters=types.Schema(
                type=types.Type.OBJECT,
                properties={
                    "code": types.Schema(
                        type=types.Type.STRING,
                        description="The code snippet to execute.",
                    ),
                    "language": types.Schema(
                        type=types.Type.STRING,
                        description=(
                            "Programming language. Optional; defaults to 'python' when omitted. "
                            "MUST be set to 'javascript' or 'typescript' to execute those languages — "
                            "omitting this field will run the code through the Python interpreter."
                        ),
                        enum=["python", "javascript", "typescript"],
                    ),
                    "env": types.Schema(
                        type=types.Type.OBJECT,
                        description="Optional environment variables as key-value pairs.",
                    ),
                    "argv": types.Schema(
                        type=types.Type.ARRAY,
                        items=types.Schema(type=types.Type.STRING),
                        description="Optional command line arguments.",
                    ),
                    "timeout": types.Schema(
                        type=types.Type.INTEGER,
                        description="Optional timeout in seconds.",
                    ),
                },
                required=["code"],
            ),
        )

    async def run_async(
        self,
        *,
        args: Dict[str, Any],
        tool_context: ToolContext,
    ) -> Dict[str, Any]:
        """Execute code inside the Daytona sandbox."""
        code = args.get("code", "")
        language = args.get("language", "python").lower()
        env = args.get("env")
        argv = args.get("argv")
        timeout = args.get("timeout")

        logger.debug(f"Executing {language} code (length: {len(code)} chars)")

        try:
            if language == "python":
                if argv:
                    code = f"import sys; sys.argv = {json.dumps(['-c', *argv])}\n" + code
                response = await anyio.to_thread.run_sync(partial(
                    self.sandbox.run_code, code, language="python", isolated=True, env=env, timeout=timeout
                ))
                output = response.logs.stdout + response.logs.stderr
                if response.error is not None:
                    return {"result": output, "error": "\n".join(response.error.traceback), "exit_code": -1}
                if response.process.reason != "exited":
                    return {"result": output, "error": str(response.process.reason), "exit_code": -1}
                return {"result": output, "exit_code": response.process.exit_code}

            elif language in ("javascript", "typescript"):
                ext = "js" if language == "javascript" else "ts"
                script_path = f"/tmp/script_{uuid.uuid4().hex}.{ext}"
                await anyio.to_thread.run_sync(lambda: self.sandbox.fs.write_bytes(script_path, code.encode("utf-8")))

                try:
                    if language == "javascript":
                        cmd = f"node {script_path}"
                    else:
                        # ts-node: skip type checking, ignore tsconfig, force commonjs
                        cmd = (
                            f"ts-node --transpile-only --skipProject "
                            f"--compilerOptions '{{\"module\":\"commonjs\",\"moduleResolution\":\"node\"}}' "
                            f"{script_path}"
                        )

                    if argv:
                        cmd += " " + " ".join(shlex.quote(str(arg)) for arg in argv)

                    response = await anyio.to_thread.run_sync(partial(self.sandbox.exec, cmd, env=env, execution_timeout=timeout))
                    logger.debug(f"Code execution completed with exit_code: {response.exit_code}")
                    if response.reason != "exited":
                        return {"result": response.output, "error": str(response.reason), "exit_code": -1}
                    return {"result": response.output, "exit_code": response.exit_code}
                finally:
                    try:
                        with anyio.CancelScope(shield=True):
                            await anyio.to_thread.run_sync(lambda: self.sandbox.fs.delete(script_path))
                    except Exception as cleanup_error:
                        logger.warning(
                            f"Failed to delete temp script {script_path}: {cleanup_error}"
                        )

            else:
                logger.warning(f"Unsupported language requested: {language}")
                return {"error": f"Unsupported language: {language}", "exit_code": -1}

        except Exception as e:
            logger.error(f"Code execution failed: {e}")
            return {"error": str(e), "exit_code": -1}


class ExecuteCommandTool(BaseTool):
    """Tool for executing shell commands inside the Daytona sandbox."""

    def __init__(self, sandbox: Sandbox):
        super().__init__(
            name="execute_command_in_daytona",
            description=(
                "Execute a shell command inside the Daytona sandbox. Provide the command to run."
            ),
        )
        self.sandbox = sandbox

    def _get_declaration(self) -> types.FunctionDeclaration:
        return types.FunctionDeclaration(
            name=self.name,
            description=self.description,
            parameters=types.Schema(
                type=types.Type.OBJECT,
                properties={
                    "command": types.Schema(
                        type=types.Type.STRING,
                        description="The shell command to execute.",
                    ),
                    "cwd": types.Schema(
                        type=types.Type.STRING,
                        description="Optional working directory for the command.",
                    ),
                    "env": types.Schema(
                        type=types.Type.OBJECT,
                        description="Optional environment variables as key-value pairs.",
                    ),
                    "timeout": types.Schema(
                        type=types.Type.INTEGER,
                        description="Optional timeout in seconds.",
                    ),
                },
                required=["command"],
            ),
        )

    async def run_async(
        self,
        *,
        args: Dict[str, Any],
        tool_context: ToolContext,
    ) -> Dict[str, Any]:
        """Execute a command inside the Daytona sandbox."""
        command = args.get("command", "")
        cwd = args.get("cwd")
        env = args.get("env")
        timeout = args.get("timeout")

        logger.debug(f"Executing command: {command[:100]}{'...' if len(command) > 100 else ''}")

        try:
            response = await anyio.to_thread.run_sync(partial(self.sandbox.exec, command, cwd=cwd, env=env, execution_timeout=timeout))
            logger.debug(f"Command completed with exit_code: {response.exit_code}")
            if response.reason != "exited":
                return {"result": response.output, "error": str(response.reason), "exit_code": -1}
            return {"result": response.output, "exit_code": response.exit_code}
        except Exception as e:
            logger.error(f"Command execution failed: {e}")
            return {"error": str(e), "exit_code": -1}


class UploadFileTool(BaseTool):
    """Tool for uploading files to the Daytona sandbox."""

    def __init__(self, sandbox: Sandbox):
        super().__init__(
            name="upload_file_to_daytona",
            description=(
                "Upload a file to the Daytona sandbox. Provide the file path and content."
            ),
        )
        self.sandbox = sandbox

    def _get_declaration(self) -> types.FunctionDeclaration:
        return types.FunctionDeclaration(
            name=self.name,
            description=self.description,
            parameters=types.Schema(
                type=types.Type.OBJECT,
                properties={
                    "file_path": types.Schema(
                        type=types.Type.STRING,
                        description="The destination path in the sandbox.",
                    ),
                    "content": types.Schema(
                        type=types.Type.STRING,
                        description="The file content to upload.",
                    ),
                },
                required=["file_path", "content"],
            ),
        )

    async def run_async(
        self,
        *,
        args: Dict[str, Any],
        tool_context: ToolContext,
    ) -> Dict[str, Any]:
        """Upload a file to the Daytona sandbox."""
        file_path = args.get("file_path", "")
        content = args.get("content", "")

        logger.debug(f"Uploading file to: {file_path} (size: {len(content)} bytes)")

        try:
            content_bytes = content.encode("utf-8")
            await anyio.to_thread.run_sync(lambda: self.sandbox.fs.write_bytes(file_path, content_bytes))
            logger.debug(f"File uploaded successfully: {file_path}")
            return {"success": True, "path": file_path}
        except Exception as e:
            logger.error(f"File upload failed for {file_path}: {e}")
            return {"error": str(e), "success": False}


class ReadFileTool(BaseTool):
    """Tool for reading files from the Daytona sandbox."""

    def __init__(self, sandbox: Sandbox):
        super().__init__(
            name="read_file_from_daytona",
            description="Read a file from the Daytona sandbox. Provide the file path.",
        )
        self.sandbox = sandbox

    def _get_declaration(self) -> types.FunctionDeclaration:
        return types.FunctionDeclaration(
            name=self.name,
            description=self.description,
            parameters=types.Schema(
                type=types.Type.OBJECT,
                properties={
                    "file_path": types.Schema(
                        type=types.Type.STRING,
                        description="The path of the file to read.",
                    ),
                },
                required=["file_path"],
            ),
        )

    async def run_async(
        self,
        *,
        args: Dict[str, Any],
        tool_context: ToolContext,
    ) -> Dict[str, Any]:
        """Read a file from the Daytona sandbox."""
        file_path = args.get("file_path", "")

        logger.debug(f"Reading file: {file_path}")

        try:
            content_bytes = await anyio.to_thread.run_sync(lambda: self.sandbox.fs.read_bytes(file_path))
            content = content_bytes.decode("utf-8")
            logger.debug(f"File read successfully: {file_path} (size: {len(content)} bytes)")
            return {"content": content, "path": file_path}
        except Exception as e:
            logger.error(f"File read failed for {file_path}: {e}")
            return {"error": str(e), "content": None}


class StartLongRunningCommandTool(BaseTool):
    """Tool for starting long-running commands (e.g., dev servers)."""

    def __init__(self, sandbox: Sandbox):
        super().__init__(
            name="start_long_running_command_daytona",
            description=(
                "Start a long-running command in the Daytona sandbox "
                "(e.g., npm run dev, python server.py). "
                "Returns a session ID that can be used to check status or stop the process."
            ),
            is_long_running=True,
        )
        self.sandbox = sandbox

    def _get_declaration(self) -> types.FunctionDeclaration:
        return types.FunctionDeclaration(
            name=self.name,
            description=self.description,
            parameters=types.Schema(
                type=types.Type.OBJECT,
                properties={
                    "command": types.Schema(
                        type=types.Type.STRING,
                        description="The long-running command to start.",
                    ),
                    "timeout": types.Schema(
                        type=types.Type.INTEGER,
                        description="Optional timeout in seconds for the command.",
                    ),
                },
                required=["command"],
            ),
        )

    async def run_async(
        self,
        *,
        args: Dict[str, Any],
        tool_context: ToolContext,
    ) -> Dict[str, Any]:
        """Start a long-running command."""
        command = args.get("command", "")
        timeout = args.get("timeout")
        session_id = f"long-running-{uuid.uuid4().hex}"

        logger.debug(f"Starting long-running command: {command[:100]}{'...' if len(command) > 100 else ''}")

        try:
            session = await anyio.to_thread.run_sync(lambda: self.sandbox.process.create_session(name=session_id))
            await anyio.to_thread.run_sync(partial(session.start, command, execution_timeout=timeout))
            logger.debug(f"Long-running command started with session_id: {session_id}")
            return {
                "session_id": session.id,
                "output": "",
                "exit_code": None,
            }
        except Exception as e:
            logger.error(f"Failed to start long-running command: {e}")
            return {"error": str(e), "exit_code": -1}
