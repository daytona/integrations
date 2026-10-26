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

    Every deletion is attempted even when others fail, and a label sweep that fails partway
    keeps the ids it already collected, so one transient error cannot leak the rest. The
    end state decides the outcome: leftovers and errors that left a sandbox unverified are
    reported together, while an error later superseded by success is dropped.
    """
    tracked = sorted(sandbox_ids)
    errors: dict[str, str] = {}

    async def label_ids(phase: str) -> list[str]:
        ids: list[str] = []
        try:
            async for listed in client.list(ListSandboxesQuery(labels=labels)):
                ids.append(listed.id)
        except DaytonaError as error:
            errors[f"{phase} label sweep"] = repr(error)
        return ids

    async def delete(sandbox_id: str) -> None:
        try:
            sandbox = await client.get(sandbox_id)
            if sandbox.state != SandboxState.DESTROYED:
                await sandbox.delete(wait=True, timeout=60)
        except DaytonaNotFoundError:
            pass
        except DaytonaError as error:
            errors[f"delete {sandbox_id}"] = repr(error)
            return
        errors.pop(f"delete {sandbox_id}", None)

    for sandbox_id in tracked:
        await delete(sandbox_id)
    for sandbox_id in await label_ids("delete"):
        await delete(sandbox_id)

    remaining: list[str] = []
    listed_ids = await label_ids("verify")
    for sandbox_id in dict.fromkeys([*tracked, *listed_ids]):
        try:
            gone = await is_gone(client, sandbox_id)
        except DaytonaError as error:
            errors[f"verify {sandbox_id}"] = repr(error)
            continue
        if gone:
            errors.pop(f"delete {sandbox_id}", None)
        else:
            remaining.append(sandbox_id)
    if "verify label sweep" not in errors:
        errors.pop("delete label sweep", None)
    if remaining or errors:
        raise AssertionError(
            f"Live sandbox cleanup incomplete: remaining={remaining} errors={errors}"
        )
    return len(tracked)


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
