from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from _client import build_client


class ManageSandboxTool(Tool):
    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage]:
        sandbox_id = tool_parameters.get("sandbox_id")
        if not sandbox_id:
            raise ValueError("sandbox_id is required")

        action = tool_parameters.get("action")
        if not action:
            raise ValueError("action is required")

        daytona = build_client(self.runtime.credentials)
        sandbox = daytona.get(sandbox_id)

        if action == "start":
            sandbox.start()
            sandbox.wait_for_sandbox_start()
        elif action == "stop":
            sandbox.stop()
        elif action == "archive":
            sandbox.archive()
        else:
            raise ValueError(
                f"Invalid action: '{action}'. Must be one of: start, stop, archive."
            )

        sandbox = daytona.get(sandbox_id)
        state = getattr(sandbox.state, "value", sandbox.state) if sandbox.state else None

        yield self.create_json_message({
            "success": True,
            "sandbox_id": sandbox_id,
            "action": action,
            "state": state,
        })
        yield self.create_text_message(
            f"Sandbox '{sandbox_id}' {action} completed. Current state: {state}."
        )
