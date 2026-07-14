from collections.abc import Generator
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from _client import build_client, get_sandbox


def _redact_url(url: str) -> str:
    """Strip embedded userinfo (user:token@host) so credentials aren't echoed back."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return url
    if not (parts.username or parts.password):
        return url
    host = parts.hostname or ""
    if parts.port:
        host = f"{host}:{parts.port}"
    return urlunsplit((parts.scheme, host, parts.path, parts.query, parts.fragment))


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

        commit_id = tool_parameters.get("commit_id") or None
        # A commit id produces a detached checkout and overrides branch, so don't send both.
        branch = None if commit_id else (tool_parameters.get("branch") or None)
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

        # Never echo embedded credentials back into tool output.
        safe_url = _redact_url(url)
        yield self.create_json_message({
            "success": True,
            "sandbox_id": sandbox_id,
            "url": safe_url,
            "path": path,
            "branch": branch,
            "commit_id": commit_id,
        })
        yield self.create_text_message(
            f"Repository '{safe_url}' cloned to '{path}' in sandbox '{sandbox_id}'."
        )
