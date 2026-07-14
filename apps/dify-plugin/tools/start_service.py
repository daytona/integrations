import uuid
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

        # A UUID keeps sessions unique even when several services are started in
        # the same sandbox within the same second (int(time.time()) collided).
        session_id = f"svc-{uuid.uuid4().hex}"
        sandbox.process.create_session(session_id)

        try:
            req = SessionExecuteRequest(command=command, run_async=True)
            response = sandbox.process.execute_session_command(session_id, req)
        except Exception:
            # Keep session creation transactional: drop the empty session if the
            # command failed to launch so failures don't accumulate stale sessions.
            try:
                sandbox.process.delete_session(session_id)
            except Exception:
                pass
            raise

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
