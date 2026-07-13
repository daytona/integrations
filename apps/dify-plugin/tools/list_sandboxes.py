from collections.abc import Generator
from typing import Any

from daytona import ListSandboxesQuery, SandboxState

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from _client import build_client


class ListSandboxesTool(Tool):
    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage]:
        daytona = build_client(self.runtime.credentials)

        limit = tool_parameters.get("limit")
        if limit in (None, ""):
            limit = 50
        else:
            limit = int(limit)

        query = ListSandboxesQuery(limit=limit)
        sandboxes = list(daytona.list(query=query))

        result = []
        for sb in sandboxes:
            state = getattr(sb.state, "value", sb.state) if sb.state else None
            result.append({
                "id": sb.id,
                "name": getattr(sb, "name", None),
                "state": state,
            })

        yield self.create_json_message({
            "sandboxes": result,
            "count": len(result),
        })
        if result:
            lines = [f"- {sb['id']} ({sb['state']})" for sb in result]
            yield self.create_text_message(
                f"Found {len(result)} sandbox(es):\n" + "\n".join(lines)
            )
        else:
            yield self.create_text_message("No sandboxes found.")
