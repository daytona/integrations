import os
import uuid
from collections.abc import AsyncGenerator

import pytest_asyncio
from daytona import AsyncDaytona, AsyncSandbox, DaytonaNotFoundError, ListSandboxesQuery, SandboxState

LABELS = {"pai-upgrade": f"{os.environ.get('PAI_UPGRADE_RUN', 'live')}-{uuid.uuid4().hex}"}


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
    client = AsyncDaytona()
    print(f"\nLive sandbox labels: {LABELS}")
    try:
        yield client
    finally:
        try:
            leftovers = await listed_sandboxes(client, LABELS)
            for sandbox in leftovers:
                try:
                    await sandbox.delete(wait=True, timeout=60)
                except DaytonaNotFoundError:
                    continue
            remaining = [sandbox.id for sandbox in await listed_sandboxes(client, LABELS)]
            assert not remaining, f"Live sandboxes remain: {remaining}"
            print(f"\nLabel-filtered cleanup: {len(remaining)} sandboxes remain")
        finally:
            await client.close()
