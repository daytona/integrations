import json
from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from daytona import (
    CreateSandboxFromImageParams,
    CreateSandboxFromSnapshotParams,
    Resources,
)

from _client import build_client


class CreateSandboxTool(Tool):
    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage]:
        daytona = build_client(self.runtime.credentials)

        name = tool_parameters.get("name") or None
        snapshot = tool_parameters.get("snapshot") or None
        image = tool_parameters.get("image") or None

        language = tool_parameters.get("language", "python")
        if language not in ("python", "typescript", "javascript"):
            raise ValueError(f"Invalid language: {language}. Must be python, typescript, or javascript.")

        env_vars = self._parse_env_vars(tool_parameters.get("env_vars"))

        auto_stop = tool_parameters.get("auto_stop_interval", 15)
        if isinstance(auto_stop, float):
            auto_stop = int(auto_stop)

        common_kwargs: dict[str, Any] = {
            "language": language,
            "auto_stop_interval": auto_stop,
        }
        if name:
            common_kwargs["name"] = name
        if env_vars:
            common_kwargs["env_vars"] = env_vars

        if snapshot:
            params = CreateSandboxFromSnapshotParams(snapshot=snapshot, **common_kwargs)
        elif image:
            resources = self._build_resources(tool_parameters)
            image_kwargs = dict(common_kwargs)
            image_kwargs["image"] = image
            if resources:
                image_kwargs["resources"] = resources
            params = CreateSandboxFromImageParams(**image_kwargs)
        else:
            params = CreateSandboxFromSnapshotParams(**common_kwargs)

        sandbox = daytona.create(params, timeout=180)

        yield self.create_json_message({
            "sandbox_id": sandbox.id,
        })

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

    @staticmethod
    def _build_resources(tool_parameters: dict[str, Any]) -> Resources | None:
        cpu = tool_parameters.get("cpu")
        memory = tool_parameters.get("memory")
        disk = tool_parameters.get("disk")
        if cpu is None and memory is None and disk is None:
            return None
        kwargs: dict[str, int] = {}
        if cpu is not None:
            kwargs["cpu"] = int(cpu)
        if memory is not None:
            kwargs["memory"] = int(memory)
        if disk is not None:
            kwargs["disk"] = int(disk)
        return Resources(**kwargs)
