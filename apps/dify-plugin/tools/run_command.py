import uuid
from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from daytona import SessionExecuteRequest

from _client import build_client, get_sandbox


class RunCommandTool(Tool):
    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage]:
        daytona = build_client(self.runtime.credentials)

        sandbox_id = tool_parameters.get("sandbox_id", "")
        ephemeral = not sandbox_id

        if sandbox_id:
            sandbox = get_sandbox(daytona, sandbox_id)
        else:
            sandbox = daytona.create()

        session_id = f"dify-{uuid.uuid4().hex[:12]}"
        session_created = False

        try:
            sandbox.process.create_session(session_id)
            session_created = True

            response = sandbox.process.execute_session_command(
                session_id,
                SessionExecuteRequest(command=tool_parameters["command"]),
            )

            yield self.create_json_message({
                "exit_code": response.exit_code,
                "stdout": response.stdout or "",
                "stderr": response.stderr or "",
                "sandbox_id": sandbox.id,
            })
        finally:
            if session_created and not ephemeral:
                try:
                    sandbox.process.delete_session(session_id)
                except Exception:
                    pass
            if ephemeral:
                try:
                    sandbox.delete()
                except Exception:
                    pass
