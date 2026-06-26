from typing import Any

from daytona import Daytona, DaytonaConfig, DaytonaNotFoundError, Sandbox


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
