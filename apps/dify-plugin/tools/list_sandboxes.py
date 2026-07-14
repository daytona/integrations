from collections.abc import Generator
from itertools import islice
from typing import Any

from daytona import ListSandboxesQuery

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from _client import build_client, to_int


class ListSandboxesTool(Tool):
    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage]:
        daytona = build_client(self.runtime.credentials)

        limit_raw = tool_parameters.get("limit")
        limit = 50 if limit_raw in (None, "") else to_int(limit_raw, "limit")
        if limit <= 0:
            raise ValueError("limit must be a positive whole number")

        # ListSandboxesQuery.limit is the page size, and iterating the result
        # pages through the whole account — cap what we actually collect.
        query = ListSandboxesQuery(limit=limit)
        sandboxes = list(islice(daytona.list(query), limit))

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
