import os
import uuid
from collections.abc import AsyncGenerator
from typing import Any

import pytest
import pytest_asyncio
from daytona import AsyncDaytona, AsyncSandbox, DaytonaNotFoundError, ListSandboxesQuery, SandboxState

LABELS = {"pai-upgrade": f"{os.environ.get('PAI_UPGRADE_RUN', 'live')}-{uuid.uuid4().hex}"}
# Every sandbox created during the run, verified by id at cleanup: a label-filtered list
# can lag behind a just-created sandbox, so it alone cannot prove that none remain.
CREATED_IDS: set[str] = set()


async def is_gone(client: AsyncDaytona, sandbox_id: str) -> bool:
    try:
        sandbox = await client.get(sandbox_id)
    except DaytonaNotFoundError:
        return True
    return sandbox.state == SandboxState.DESTROYED


async def listed_sandboxes(client: AsyncDaytona, labels: dict[str, str]) -> list[AsyncSandbox]:
    # Label-filtered lists can retain deleted records after delete(wait=True), verified live.
    sandboxes = []
    async for listed in client.list(ListSandboxesQuery(labels=labels)):
        try:
            current = await client.get(listed.id)
        except DaytonaNotFoundError:
            continue
        if current.state != SandboxState.DESTROYED:
            sandboxes.append(current)
    return sandboxes


@pytest_asyncio.fixture(scope="module", loop_scope="module", autouse=True)
async def backend() -> AsyncGenerator[AsyncDaytona, None]:
    original_create = AsyncDaytona.create

    async def recording_create(client: AsyncDaytona, *args: Any, **kwargs: Any) -> AsyncSandbox:
        sandbox = await original_create(client, *args, **kwargs)
        CREATED_IDS.add(sandbox.id)
        return sandbox

    client = AsyncDaytona()
    print(f"\nLive sandbox labels: {LABELS}")
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(AsyncDaytona, "create", recording_create)
        try:
            yield client
        finally:
            try:
                for sandbox_id in sorted(CREATED_IDS):
                    try:
                        sandbox = await client.get(sandbox_id)
                        if sandbox.state != SandboxState.DESTROYED:
                            await sandbox.delete(wait=True, timeout=60)
                    except DaytonaNotFoundError:
                        continue
                for sandbox in await listed_sandboxes(client, LABELS):
                    try:
                        await sandbox.delete(wait=True, timeout=60)
                    except DaytonaNotFoundError:
                        continue
                remaining = [i for i in sorted(CREATED_IDS) if not await is_gone(client, i)]
                remaining += [s.id for s in await listed_sandboxes(client, LABELS)]
                assert not remaining, f"Live sandboxes remain: {sorted(set(remaining))}"
                print(f"\nCleanup verified by id: {len(CREATED_IDS)} created, none remain")
            finally:
                await client.close()
