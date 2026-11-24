import hashlib
from typing import Any

from daytona import Daytona, DaytonaConfig
from daytona.v0 import DaytonaError, DaytonaNotFoundError, Sandbox

MAX_FILE_SIZE = 100 * 1024 * 1024  # 100 MB
DAYTONA_CLOUD_API_URL = "https://app.daytona.io/api"

# The plugin daemon is long-lived, so cache one Daytona client per unique
# credential set to avoid re-creating an HTTP session on every tool call.
_client_cache: dict[str, Daytona] = {}


def _cache_key(credentials: dict[str, Any]) -> str:
    api_key = str(credentials.get("api_key", ""))
    return hashlib.sha256(api_key.encode()).hexdigest()


def to_int(value: Any, name: str) -> int:
    # Dify sends "number" params as float; silent int() truncation (0.5 -> 0)
    # disables auto-stop and under-provisions resources, so reject fractions.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a whole number, got {value!r}")
    if isinstance(value, float) and not value.is_integer():
        raise ValueError(f"{name} must be a whole number, got {value}")
    return int(value)


def build_client(credentials: dict[str, Any]) -> Daytona:
    # Credentials saved by plugin 0.0.2 or earlier can still carry a custom API URL.
    # SDK 2.x only talks to Daytona Cloud, so refuse them rather than send a
    # self-hosted key there.
    api_url = str(credentials.get("api_url") or "").rstrip("/")
    if api_url not in ("", DAYTONA_CLOUD_API_URL):
        raise ValueError(
            f"Custom API URL {api_url} is no longer supported: this plugin "
            "version only targets Daytona Cloud. Re-authorize it with a Daytona "
            "Cloud API key, or stay on plugin version 0.0.2 for a self-hosted Daytona."
        )
    key = _cache_key(credentials)
    if key not in _client_cache:
        _client_cache[key] = Daytona(DaytonaConfig(api_key=credentials["api_key"]))
    return _client_cache[key]


def get_sandbox(client: Daytona, sandbox_id: str) -> Sandbox:
    if not sandbox_id:
        raise ValueError("sandbox_id is required")
    try:
        sandbox = client.v0.get(sandbox_id)
    except DaytonaNotFoundError as e:
        raise ValueError(f"Sandbox '{sandbox_id}' not found") from e
    except DaytonaError as e:
        raise ValueError(f"Failed to retrieve sandbox '{sandbox_id}': {e}") from e
    if sandbox is None:
        raise ValueError(f"Sandbox '{sandbox_id}' not found")
    return sandbox
