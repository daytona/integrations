from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage
from dify_plugin.file.file import File

from _client import MAX_FILE_SIZE, build_client, get_sandbox


class UploadFileTool(Tool):
    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage]:
        sandbox_id = tool_parameters.get("sandbox_id")
        if not sandbox_id:
            raise ValueError("sandbox_id is required")

        remote_path = tool_parameters.get("remote_path")
        if not remote_path:
            raise ValueError("remote_path is required")

        file = tool_parameters.get("file")
        if not file:
            raise ValueError("file is required")
        if not isinstance(file, File):
            raise ValueError(f"Expected file parameter to be a File, got {type(file).__name__}")

        # Reject oversized files using metadata before materializing the blob in memory.
        size_hint = getattr(file, "size", None)
        if size_hint and size_hint > MAX_FILE_SIZE:
            raise ValueError(
                f"File size ({size_hint} bytes) exceeds maximum allowed size "
                f"({MAX_FILE_SIZE} bytes)."
            )

        blob = file.blob
        if len(blob) > MAX_FILE_SIZE:
            raise ValueError(
                f"File size ({len(blob)} bytes) exceeds maximum allowed size "
                f"({MAX_FILE_SIZE} bytes)."
            )

        daytona = build_client(self.runtime.credentials)
        sandbox = get_sandbox(daytona, sandbox_id)
        sandbox.fs.upload_file(blob, remote_path)

        yield self.create_json_message({
            "success": True,
            "sandbox_id": sandbox_id,
            "remote_path": remote_path,
            "size_bytes": len(blob),
        })
