"""Daytona tools for ADK agents.

Provides ADK tool implementations for code execution in Daytona sandbox.
"""

import logging
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

from daytona import CodeRunParams, Sandbox, SessionExecuteRequest  # type: ignore
from google.adk.tools import BaseTool, ToolContext
from google.genai import types


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
                        description="Programming language: 'python' (default), 'javascript', or 'typescript'.",
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
                required=["code", "language"],
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
                params: Optional[CodeRunParams] = None
                if env or argv:
                    params = CodeRunParams(env=env, argv=argv)
                response = self.sandbox.process.code_run(code, params, timeout)
                logger.debug(f"Code execution completed with exit_code: {response.exit_code}")
                return {"result": response.result, "exit_code": response.exit_code}

            elif language in ("javascript", "typescript"):
                ext = "js" if language == "javascript" else "ts"
                script_path = f"/tmp/script_{id(self)}.{ext}"
                self.sandbox.fs.upload_file(code.encode("utf-8"), script_path)

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
                    cmd += " " + " ".join(argv)

                response = self.sandbox.process.exec(cmd, env=env, timeout=timeout)
                self.sandbox.fs.delete_file(script_path)
                logger.debug(f"Code execution completed with exit_code: {response.exit_code}")
                return {"result": response.result, "exit_code": response.exit_code}

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
            response = self.sandbox.process.exec(command, cwd, env, timeout)
            logger.debug(f"Command completed with exit_code: {response.exit_code}")
            return {"result": response.result, "exit_code": response.exit_code}
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
            self.sandbox.fs.upload_file(content_bytes, file_path)
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
            content_bytes = self.sandbox.fs.download_file(file_path)
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
        session_id = f"long-running-{id(self)}"

        logger.debug(f"Starting long-running command: {command[:100]}{'...' if len(command) > 100 else ''}")

        try:
            self.sandbox.process.create_session(session_id)
            request = SessionExecuteRequest(command=command, runAsync=True)
            response = self.sandbox.process.execute_session_command(
                session_id, request, timeout
            )
            logger.debug(f"Long-running command started with session_id: {session_id}")
            return {
                "session_id": session_id,
                "output": response.output if response.output else "",
                "exit_code": response.exit_code,
            }
        except Exception as e:
            logger.error(f"Failed to start long-running command: {e}")
            return {"error": str(e), "exit_code": -1}
