from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from _client import build_client, get_sandbox


class ManageSandboxTool(Tool):
    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage]:
        sandbox_id = tool_parameters.get("sandbox_id")
        if not sandbox_id:
            raise ValueError("sandbox_id is required")

        action = tool_parameters.get("action")
        if not action:
            raise ValueError("action is required")

        daytona = build_client(self.runtime.credentials)
        sandbox = get_sandbox(daytona, sandbox_id)

        if action == "start":
            sandbox.start()
        elif action == "stop":
            sandbox.stop()
        elif action == "archive":
            # Daytona requires a sandbox to be stopped before it can be archived;
            # an already-archived sandbox is treated as an idempotent no-op.
            # Sandbox.stop() blocks until the sandbox is fully stopped.
            current = getattr(sandbox.state, "value", sandbox.state)
            if current != "archived":
                if current != "stopped":
                    sandbox.stop()
                sandbox.archive()
        else:
            raise ValueError(
                f"Invalid action: '{action}'. Must be one of: start, stop, archive."
            )

        sandbox = get_sandbox(daytona, sandbox_id)
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
