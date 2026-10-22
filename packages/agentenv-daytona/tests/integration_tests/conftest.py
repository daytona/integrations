"""Live-test plumbing: a config file naming the provider, and a sweep of anything the run left.

Every module here skips without ``DAYTONA_API_KEY``. The key is read by agent-env through the
config's ``env:`` reference and never printed.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path

import pytest

LIVE = pytest.mark.skipif(
    not os.environ.get("DAYTONA_API_KEY"),
    reason="DAYTONA_API_KEY not set; these tests require a live Daytona backend",
)
CONFIG = '[sandbox.providers.daytona.config]\napi_key = "env:DAYTONA_API_KEY"\n'


async def managed_since(started: datetime) -> list[str]:
    """Ids of agent-env sandboxes created since ``started`` that still exist."""
    from daytona import AsyncDaytona, ListSandboxesQuery

    query = ListSandboxesQuery(labels={"agentenv.managed": "true"}, created_at_after=started)
    async with AsyncDaytona() as client:
        return [
            sandbox.id
            async for sandbox in client.list(query)
            # A delete returns before the sandbox is gone; one being deleted wants "destroyed".
            if getattr(sandbox.desired_state, "value", sandbox.desired_state) != "destroyed"
        ]


async def _sweep(started: datetime) -> list[str]:
    from daytona import AsyncDaytona, DaytonaError

    # The list lags a delete by a few seconds, so give in-flight deletes time to show.
    left: list[str] = []
    for _ in range(15):
        if not (left := await managed_since(started)):
            return []
        await asyncio.sleep(2)
    async with AsyncDaytona() as client:
        for sandbox_id in left:
            try:
                await (await client.get(sandbox_id)).delete()
            except DaytonaError as exc:  # gone or going meanwhile: reported below either way
                print(f"sweep could not delete {sandbox_id}: {exc}")
    return left


@pytest.fixture(scope="session")
def live_config(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Path]:
    """``AGENT_ENV_CONFIG`` pointing at a config with the daytona table, for the whole session; at the
    end, anything agent-env created during the session and left running is deleted and reported."""
    from agent_env.config import reset_config

    path = tmp_path_factory.mktemp("agentenv") / "config.toml"
    path.write_text(CONFIG)
    previous = os.environ.get("AGENT_ENV_CONFIG")
    os.environ["AGENT_ENV_CONFIG"] = str(path)
    reset_config()
    started = datetime.now(timezone.utc)
    yield path
    if previous is None:
        os.environ.pop("AGENT_ENV_CONFIG", None)
    else:
        os.environ["AGENT_ENV_CONFIG"] = previous
    reset_config()
    if os.environ.get("DAYTONA_API_KEY") and (left := asyncio.run(_sweep(started))):
        pytest.fail(f"live tests left Daytona sandboxes running (now deleted): {left}")
