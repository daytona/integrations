from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from _client import build_client, get_sandbox, to_int


class GetPreviewUrlTool(Tool):
    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage]:
        sandbox_id = tool_parameters.get("sandbox_id")
        if not sandbox_id:
            raise ValueError("sandbox_id is required")

        port = tool_parameters.get("port")
        if port is None:
            raise ValueError("port is required")
        port = to_int(port, "port")
        if not (3000 <= port <= 9999):
            raise ValueError(f"Port must be between 3000 and 9999, got {port}")

        daytona = build_client(self.runtime.credentials)
        sandbox = get_sandbox(daytona, sandbox_id)
        preview = sandbox.get_preview_link(port)

        yield self.create_json_message({
            "url": preview.url,
            "token": preview.token,
            "port": port,
            "sandbox_id": sandbox_id,
        })
