import hashlib
from typing import Any

from daytona import Daytona, DaytonaConfig, DaytonaError, DaytonaNotFoundError, Sandbox

MAX_FILE_SIZE = 100 * 1024 * 1024  # 100 MB

# The plugin daemon is long-lived, so cache one Daytona client per unique
# credential set to avoid re-creating an HTTP session on every tool call.
_client_cache: dict[str, Daytona] = {}


def _cache_key(credentials: dict[str, Any]) -> str:
    # Length-prefix each field so distinct api_key/api_url pairs can't collide
    # into the same entry (e.g. "a:" + "b" vs "a" + ":b").
    api_key = str(credentials.get("api_key", ""))
    api_url = str(credentials.get("api_url", ""))
    raw = f"{len(api_key)}:{api_key}{len(api_url)}:{api_url}"
    return hashlib.sha256(raw.encode()).hexdigest()


def to_int(value: Any, name: str) -> int:
    # Dify sends "number" params as float; silent int() truncation (0.5 -> 0)
    # disables auto-stop and under-provisions resources, so reject fractions.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a whole number, got {value!r}")
    if isinstance(value, float) and not value.is_integer():
        raise ValueError(f"{name} must be a whole number, got {value}")
    return int(value)


def build_client(credentials: dict[str, Any]) -> Daytona:
    key = _cache_key(credentials)
    if key not in _client_cache:
        config = DaytonaConfig(api_key=credentials["api_key"])
        if api_url := credentials.get("api_url"):
            config.api_url = api_url
        _client_cache[key] = Daytona(config)
    return _client_cache[key]


def get_sandbox(client: Daytona, sandbox_id: str) -> Sandbox:
    if not sandbox_id:
        raise ValueError("sandbox_id is required")
    try:
        sandbox = client.get(sandbox_id)
    except DaytonaNotFoundError as e:
        raise ValueError(f"Sandbox '{sandbox_id}' not found") from e
    except DaytonaError as e:
        raise ValueError(f"Failed to retrieve sandbox '{sandbox_id}': {e}") from e
    if sandbox is None:
        raise ValueError(f"Sandbox '{sandbox_id}' not found")
    return sandbox
