from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from _client import build_client, get_sandbox


class WriteFileTool(Tool):
    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage]:
        sandbox_id = tool_parameters.get("sandbox_id")
        if not sandbox_id:
            raise ValueError("sandbox_id is required")

        remote_path = tool_parameters.get("remote_path")
        if not remote_path:
            raise ValueError("remote_path is required")

        content = tool_parameters.get("content")
        if content is None:
            raise ValueError("content is required")

        daytona = build_client(self.runtime.credentials)
        sandbox = get_sandbox(daytona, sandbox_id)

        encoded = content.encode("utf-8")
        sandbox.fs.upload_file(encoded, remote_path)

        if encoded:
            size_bytes = len(encoded)
        else:
            file_info = sandbox.fs.get_file_info(remote_path)
            size_bytes = file_info.size

        yield self.create_json_message({
            "success": True,
            "sandbox_id": sandbox_id,
            "remote_path": remote_path,
            "size_bytes": size_bytes,
        })
