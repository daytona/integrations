import json
from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from _client import build_client, get_sandbox, to_int


class RunCommandTool(Tool):
    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage]:
        daytona = build_client(self.runtime.credentials)

        sandbox_id = tool_parameters.get("sandbox_id", "")
        ephemeral = not sandbox_id

        command = tool_parameters.get("command")
        if not command:
            raise ValueError("command is required")
        cwd = tool_parameters.get("cwd") or None
        env_vars = self._parse_env_vars(tool_parameters.get("env_vars"))

        timeout = tool_parameters.get("timeout")
        timeout = None if timeout in (None, "") else to_int(timeout, "timeout")
        if timeout is not None and timeout < 0:
            raise ValueError("timeout must be greater than or equal to 0 (0 means no timeout)")

        if sandbox_id:
            sandbox = get_sandbox(daytona, sandbox_id)
        else:
            sandbox = daytona.create()

        try:
            response = sandbox.process.exec(command, cwd=cwd, env=env_vars, timeout=timeout)

            yield self.create_text_message(response.result or "(no output)")
            yield self.create_json_message({
                "exit_code": response.exit_code,
                "output": response.result or "",
                "sandbox_id": sandbox.id,
            })
        finally:
            if ephemeral:
                try:
                    sandbox.delete()
                except Exception:
                    pass

    @staticmethod
    def _parse_env_vars(raw: Any) -> dict[str, str] | None:
        if not raw:
            return None
        if isinstance(raw, dict):
            return {str(k): str(v) for k, v in raw.items()}
        try:
            parsed = json.loads(raw)
        except (ValueError, TypeError) as e:
            raise ValueError(f"env_vars must be a JSON object string: {e}")
        if not isinstance(parsed, dict):
            raise ValueError("env_vars must be a JSON object")
        return {str(k): str(v) for k, v in parsed.items()}
