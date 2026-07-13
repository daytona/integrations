from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from _client import build_client, get_sandbox


class SearchFilesTool(Tool):
    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage]:
        sandbox_id = tool_parameters.get("sandbox_id")
        if not sandbox_id:
            raise ValueError("sandbox_id is required")

        path = tool_parameters.get("path")
        if not path:
            raise ValueError("path is required")

        pattern = tool_parameters.get("pattern")
        if not pattern:
            raise ValueError("pattern is required")

        daytona = build_client(self.runtime.credentials)
        sandbox = get_sandbox(daytona, sandbox_id)
        matches = sandbox.fs.search_files(path, pattern)

        yield self.create_json_message({
            "sandbox_id": sandbox_id,
            "path": path,
            "pattern": pattern,
            "matches": matches,
            "count": len(matches),
        })
