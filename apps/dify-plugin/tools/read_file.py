from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from _client import build_client, get_sandbox


class ReadFileTool(Tool):
    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage]:
        sandbox_id = tool_parameters.get("sandbox_id")
        if not sandbox_id:
            raise ValueError("sandbox_id is required")

        remote_path = tool_parameters.get("remote_path")
        if not remote_path:
            raise ValueError("remote_path is required")

        daytona = build_client(self.runtime.credentials)
        sandbox = get_sandbox(daytona, sandbox_id)

        file_data = sandbox.fs.download_file(remote_path)
        file_info = sandbox.fs.get_file_info(remote_path)

        content = file_data.decode("utf-8")

        yield self.create_text_message(content)
        yield self.create_json_message({
            "success": True,
            "sandbox_id": sandbox_id,
            "remote_path": remote_path,
            "size_bytes": file_info.size,
        })
