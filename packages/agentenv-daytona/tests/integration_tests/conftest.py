"""Live-test plumbing: a config file naming the provider, and a sweep of anything the run left.

Every module here skips without ``DAYTONA_API_KEY``. The key is read by agent-env through the
config's ``env:`` reference and never printed. Every sandbox a session creates carries that session's
own attribution label, so the sweep only ever touches this session's sandboxes, never those of a
concurrent run or a teammate sharing the account.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

LIVE = pytest.mark.skipif(
    not os.environ.get("DAYTONA_API_KEY"),
    reason="DAYTONA_API_KEY not set; these tests require a live Daytona backend",
)
SESSION = uuid.uuid4().hex
SESSION_LABEL = "agentenv.attr.agentenv_test_session"


def config_toml(*, daytona_by_default: bool = False, key_env: str = "DAYTONA_API_KEY") -> str:
    """A config with the daytona provider table that labels every sandbox with this session."""
    defaults = 'default = "daytona"\nagent_default = "daytona"\n' if daytona_by_default else ""
    return (
        f'[sandbox]\n{defaults}attribution = {{ agentenv_test_session = "{SESSION}" }}\n\n'
        f'[sandbox.providers.daytona.config]\napi_key = "env:{key_env}"\n'
    )


def _state(value: object) -> str:
    return str(getattr(value, "value", value))


async def _sweep() -> tuple[list[str], list[str]]:
    """Delete this session's sandboxes still running: (ids left running, ids that could not be deleted)."""
    from daytona import AsyncDaytona, DaytonaError, DaytonaNotFoundError, ListSandboxesQuery

    query = ListSandboxesQuery(labels={SESSION_LABEL: SESSION})
    left: list[Any] = []
    async with AsyncDaytona() as client:
        # The list lags a delete by a few seconds, so give in-flight deletes time to show.
        for _ in range(15):
            left = [s async for s in client.list(query) if _state(s.desired_state) != "destroyed"]
            if not left:
                return [], []
            await asyncio.sleep(2)
        failed = []
        for sandbox in left:
            try:
                await sandbox.delete()
            except DaytonaNotFoundError:
                continue
            except DaytonaError as exc:
                failed.append(f"{sandbox.id}: {exc}")
        return [sandbox.id for sandbox in left], failed


@pytest.fixture(scope="session")
def live_config(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Path]:
    """``AGENT_ENV_CONFIG`` pointing at a config with the daytona table, for the whole session; at the
    end, any of this session's sandboxes still running is deleted, and the session fails."""
    from agent_env.config import reset_config

    path = tmp_path_factory.mktemp("agentenv") / "config.toml"
    path.write_text(config_toml())
    previous = os.environ.get("AGENT_ENV_CONFIG")
    os.environ["AGENT_ENV_CONFIG"] = str(path)
    reset_config()
    yield path
    if previous is None:
        os.environ.pop("AGENT_ENV_CONFIG", None)
    else:
        os.environ["AGENT_ENV_CONFIG"] = previous
    reset_config()
    if not os.environ.get("DAYTONA_API_KEY"):
        return
    left, failed = asyncio.run(_sweep())
    if failed:
        pytest.fail(
            f"live tests left Daytona sandboxes running, and these could not be deleted: {failed}"
        )
    if left:
        pytest.fail(f"live tests left Daytona sandboxes running (now deleted): {left}")
