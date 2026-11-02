"""ADK text-file tools backed by the v2 bytes API."""

import logging
from typing import TypedDict

import anyio
from daytona.v2 import DaytonaError, Sandbox
from daytona.v2.types import JsonValue
from google.adk.tools import BaseTool, ToolContext
from google.genai import types
from pydantic import BaseModel, ConfigDict

logger = logging.getLogger(__name__)


class FileResult(TypedDict, total=False):
    success: bool
    path: str
    content: str | None
    error: str


class UploadArgs(BaseModel):
    """Parse file-tool arguments at the ADK boundary."""

    model_config = ConfigDict(frozen=True, strict=True)
    file_path: str
    content: str


class ReadArgs(BaseModel):
    """Parse read-tool arguments at the ADK boundary."""

    model_config = ConfigDict(frozen=True, strict=True)
    file_path: str


class UploadFileTool(BaseTool):
    """Tool for uploading UTF-8 text to the sandbox."""

    def __init__(self, sandbox: Sandbox):
        super().__init__(
            name="upload_file_to_daytona",
            description="Upload a file to the Daytona sandbox. Provide the file path and content.",
        )
        self.sandbox = sandbox

    def _get_declaration(self) -> types.FunctionDeclaration:
        return types.FunctionDeclaration(
            name=self.name, description=self.description,
            parameters=types.Schema(
                type=types.Type.OBJECT,
                properties={
                    "file_path": types.Schema(type=types.Type.STRING, description="The destination path in the sandbox."),
                    "content": types.Schema(type=types.Type.STRING, description="The file content to upload."),
                },
                required=["file_path", "content"],
            ),
        )

    async def run_async(self, *, args: dict[str, JsonValue], tool_context: ToolContext) -> FileResult:
        """Write the parsed content as UTF-8 bytes."""
        parsed = UploadArgs.model_validate(args)
        try:
            await anyio.to_thread.run_sync(lambda: self.sandbox.fs.write_bytes(parsed.file_path, parsed.content.encode("utf-8")))
            return {"success": True, "path": parsed.file_path}
        except DaytonaError as error:
            logger.error("File upload failed", extra={"path": parsed.file_path, "error": str(error)})
            return {"error": str(error), "success": False}


class ReadFileTool(BaseTool):
    """Tool for reading UTF-8 text from the sandbox."""

    def __init__(self, sandbox: Sandbox):
        super().__init__(
            name="read_file_from_daytona",
            description="Read a file from the Daytona sandbox. Provide the file path.",
        )
        self.sandbox = sandbox

    def _get_declaration(self) -> types.FunctionDeclaration:
        return types.FunctionDeclaration(
            name=self.name, description=self.description,
            parameters=types.Schema(
                type=types.Type.OBJECT,
                properties={"file_path": types.Schema(type=types.Type.STRING, description="The path of the file to read.")},
                required=["file_path"],
            ),
        )

    async def run_async(self, *, args: dict[str, JsonValue], tool_context: ToolContext) -> FileResult:
        """Read bytes and decode UTF-8 without a local temporary file."""
        parsed = ReadArgs.model_validate(args)
        try:
            content = (await anyio.to_thread.run_sync(lambda: self.sandbox.fs.read_bytes(parsed.file_path))).decode("utf-8")
            return {"content": content, "path": parsed.file_path}
        except (DaytonaError, UnicodeDecodeError) as error:
            logger.error("File read failed", extra={"path": parsed.file_path, "error": str(error)})
            return {"error": str(error), "content": None}
