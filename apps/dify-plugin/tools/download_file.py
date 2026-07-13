import mimetypes
import os
from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from _client import MAX_FILE_SIZE, build_client, get_sandbox


class DownloadFileTool(Tool):
    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage]:
        sandbox_id = tool_parameters.get("sandbox_id")
        if not sandbox_id:
            raise ValueError("sandbox_id is required")

        remote_path = tool_parameters.get("remote_path")
        if not remote_path:
            raise ValueError("remote_path is required")

        daytona = build_client(self.runtime.credentials)
        sandbox = get_sandbox(daytona, sandbox_id)

        info = sandbox.fs.get_file_info(remote_path)
        if info.size and info.size > MAX_FILE_SIZE:
            raise ValueError(
                f"File size ({info.size} bytes) exceeds maximum allowed size "
                f"({MAX_FILE_SIZE} bytes)."
            )

        content = sandbox.fs.download_file(remote_path)
        if len(content) > MAX_FILE_SIZE:
            raise ValueError(
                f"Downloaded file size ({len(content)} bytes) exceeds maximum allowed size "
                f"({MAX_FILE_SIZE} bytes)."
            )

        filename = os.path.basename(remote_path) or "downloaded_file"
        mime_type, _ = mimetypes.guess_type(filename)
        if not mime_type:
            mime_type = "application/octet-stream"

        yield self.create_blob_message(
            blob=content,
            meta={"mime_type": mime_type, "filename": filename},
        )
        yield self.create_json_message({
            "success": True,
            "sandbox_id": sandbox_id,
            "remote_path": remote_path,
            "size_bytes": len(content),
            "mime_type": mime_type,
            "filename": filename,
        })
