from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from daytona import CreateSandboxFromSnapshotParams

from _client import build_client, get_sandbox


class RunCodeTool(Tool):
    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage]:
        daytona = build_client(self.runtime.credentials)

        sandbox_id = tool_parameters.get("sandbox_id", "")
        ephemeral = not sandbox_id

        if sandbox_id:
            sandbox = get_sandbox(daytona, sandbox_id)
        else:
            language = tool_parameters.get("language", "python")
            if language not in ("python", "typescript", "javascript"):
                raise ValueError(f"Invalid language: {language}. Must be python, typescript, or javascript.")
            sandbox = daytona.create(CreateSandboxFromSnapshotParams(language=language))

        try:
            response = sandbox.process.code_run(tool_parameters["code"])
            yield self.create_json_message({
                "exit_code": response.exit_code,
                "output": response.result,
                "sandbox_id": sandbox.id,
            })
        finally:
            if ephemeral:
                try:
                    sandbox.delete()
                except Exception:
                    pass
