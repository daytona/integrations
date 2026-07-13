from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from _client import build_client, get_sandbox


class GitCloneTool(Tool):
    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage]:
        sandbox_id = tool_parameters.get("sandbox_id")
        if not sandbox_id:
            raise ValueError("sandbox_id is required")

        url = tool_parameters.get("url")
        if not url:
            raise ValueError("url is required")

        path = tool_parameters.get("path")
        if not path:
            raise ValueError("path is required")

        branch = tool_parameters.get("branch") or None
        commit_id = tool_parameters.get("commit_id") or None
        username = tool_parameters.get("username") or None
        password = tool_parameters.get("password") or None

        daytona = build_client(self.runtime.credentials)
        sandbox = get_sandbox(daytona, sandbox_id)

        sandbox.git.clone(
            url=url,
            path=path,
            branch=branch,
            commit_id=commit_id,
            username=username,
            password=password,
        )

        yield self.create_json_message({
            "success": True,
            "sandbox_id": sandbox_id,
            "url": url,
            "path": path,
            "branch": branch,
        })
        yield self.create_text_message(
            f"Repository '{url}' cloned to '{path}' in sandbox '{sandbox_id}'."
        )
