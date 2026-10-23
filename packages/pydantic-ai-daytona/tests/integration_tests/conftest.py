import os
import uuid
from collections.abc import AsyncGenerator, Iterable
from typing import Any

import pytest
import pytest_asyncio
from daytona import (
    AsyncDaytona,
    AsyncSandbox,
    DaytonaError,
    DaytonaNotFoundError,
    ListSandboxesQuery,
    SandboxState,
)

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


async def cleanup_sandboxes(
    client: AsyncDaytona, sandbox_ids: Iterable[str], labels: dict[str, str]
) -> int:
    """Delete every tracked and label-listed sandbox, then verify none remain.

    Every deletion is attempted even when others fail; all failures and leftovers are
    reported together at the end, so one transient error cannot leak the rest.
    """
    ids = sorted(sandbox_ids)
    failures: list[str] = []

    async def delete(sandbox_id: str, sandbox: AsyncSandbox | None = None) -> None:
        try:
            current = sandbox if sandbox is not None else await client.get(sandbox_id)
            if current.state != SandboxState.DESTROYED:
                await current.delete(wait=True, timeout=60)
        except DaytonaNotFoundError:
            return
        except DaytonaError as error:
            failures.append(f"delete {sandbox_id}: {error!r}")

    async def listed(phase: str) -> list[AsyncSandbox]:
        try:
            return await listed_sandboxes(client, labels)
        except DaytonaError as error:
            failures.append(f"{phase} label sweep: {error!r}")
            return []

    for sandbox_id in ids:
        await delete(sandbox_id)
    for sandbox in await listed("delete"):
        await delete(sandbox.id, sandbox)

    remaining: list[str] = []
    for sandbox_id in ids:
        try:
            if not await is_gone(client, sandbox_id):
                remaining.append(sandbox_id)
        except DaytonaError as error:
            failures.append(f"verify {sandbox_id}: {error!r}")
    remaining += [s.id for s in await listed("verify") if s.id not in remaining]
    if remaining or failures:
        raise AssertionError(
            f"Live sandbox cleanup incomplete: remaining={remaining} failures={failures}"
        )
    return len(ids)


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
                created = await cleanup_sandboxes(client, CREATED_IDS, LABELS)
                print(f"\nCleanup verified by id: {created} created, none remain")
            finally:
                await client.close()
