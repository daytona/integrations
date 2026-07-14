from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from _client import build_client, get_sandbox


class ListFilesTool(Tool):
    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage]:
        sandbox_id = tool_parameters.get("sandbox_id")
        if not sandbox_id:
            raise ValueError("sandbox_id is required")

        path = tool_parameters.get("path")
        if not path:
            raise ValueError("path is required")

        daytona = build_client(self.runtime.credentials)
        sandbox = get_sandbox(daytona, sandbox_id)
        files = sandbox.fs.list_files(path)

        entries = []
        text_lines = []

        for f in files:
            entry = {
                "name": f.name,
                "size": f.size,
                "is_dir": f.is_dir,
                "mode": f.mode,
                "owner": f.owner,
            }
            entries.append(entry)
            prefix = "d" if f.is_dir else "-"
            text_lines.append(f"{prefix} {f.size:>10} {f.owner:<10} {f.name}")

        text_output = f"Directory listing for '{path}' in sandbox '{sandbox_id}':\n\n"
        text_output += "\n".join(text_lines)

        yield self.create_text_message(text_output)
        yield self.create_json_message({
            "sandbox_id": sandbox_id,
            "path": path,
            "entries": entries,
            "count": len(entries),
        })
