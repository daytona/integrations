import time
from collections.abc import Generator
from typing import Any

from daytona import SessionExecuteRequest

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from _client import build_client, get_sandbox


class StartServiceTool(Tool):
    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage]:
        sandbox_id = tool_parameters.get("sandbox_id")
        if not sandbox_id:
            raise ValueError("sandbox_id is required")

        command = tool_parameters.get("command")
        if not command:
            raise ValueError("command is required")

        daytona = build_client(self.runtime.credentials)
        sandbox = get_sandbox(daytona, sandbox_id)

        session_id = f"svc-{int(time.time())}"
        sandbox.process.create_session(session_id)

        req = SessionExecuteRequest(command=command, run_async=True)
        response = sandbox.process.execute_session_command(session_id, req)

        cmd_id = getattr(response, "cmd_id", None)

        yield self.create_json_message({
            "session_id": session_id,
            "cmd_id": cmd_id,
            "sandbox_id": sandbox_id,
            "command": command,
        })
        yield self.create_text_message(
            f"Service started in session '{session_id}' (cmd_id: {cmd_id}). "
            f"Use get_service_logs with this session_id to retrieve output."
        )
