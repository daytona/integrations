from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from _client import build_client, get_sandbox


class GetServiceLogsTool(Tool):
    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage]:
        sandbox_id = tool_parameters.get("sandbox_id")
        if not sandbox_id:
            raise ValueError("sandbox_id is required")

        session_id = tool_parameters.get("session_id")
        if not session_id:
            raise ValueError("session_id is required")

        cmd_id = tool_parameters.get("cmd_id") or None

        daytona = build_client(self.runtime.credentials)
        sandbox = get_sandbox(daytona, sandbox_id)

        if not cmd_id:
            session = sandbox.process.get_session(session_id)
            commands = getattr(session, "commands", None) or []
            if commands:
                cmd_id = getattr(commands[-1], "id", None)
            if not cmd_id:
                raise ValueError(
                    f"Could not determine cmd_id for session '{session_id}'. "
                    "Provide cmd_id explicitly (from start_service output)."
                )

        logs = sandbox.process.get_session_command_logs(session_id, cmd_id)

        stdout = getattr(logs, "stdout", None) or ""
        stderr = getattr(logs, "stderr", None) or ""
        output = getattr(logs, "output", None) or ""
        if output:
            combined = output
        elif stdout and stderr:
            # Join the two streams with a single newline, without doubling one
            # that stdout already ends with.
            separator = "" if stdout.endswith("\n") else "\n"
            combined = stdout + separator + stderr
        else:
            combined = stdout or stderr

        yield self.create_text_message(combined or "(no output)")
        yield self.create_json_message({
            "session_id": session_id,
            "cmd_id": cmd_id,
            "sandbox_id": sandbox_id,
            "stdout": stdout,
            "stderr": stderr,
        })
