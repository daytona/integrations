from typing import Any

from daytona import Daytona, DaytonaConfig, DaytonaNotFoundError, Sandbox

MAX_FILE_SIZE = 100 * 1024 * 1024  # 100 MB


def to_int(value: Any, name: str) -> int:
    # Dify sends "number" params as float; silent int() truncation (0.5 -> 0)
    # disables auto-stop and under-provisions resources, so reject fractions.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a whole number, got {value!r}")
    if isinstance(value, float) and not value.is_integer():
        raise ValueError(f"{name} must be a whole number, got {value}")
    return int(value)


def build_client(credentials: dict[str, Any]) -> Daytona:
    config = DaytonaConfig(api_key=credentials["api_key"])
    if api_url := credentials.get("api_url"):
        config.api_url = api_url
    return Daytona(config)


def get_sandbox(client: Daytona, sandbox_id: str) -> Sandbox:
    if not sandbox_id:
        raise ValueError("sandbox_id is required")
    try:
        sandbox = client.get(sandbox_id)
    except DaytonaNotFoundError as e:
        raise ValueError(f"Sandbox '{sandbox_id}' not found") from e
    if sandbox is None:
        raise ValueError(f"Sandbox '{sandbox_id}' not found")
    return sandbox
