from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

import pytest
from daytona import DaytonaError, SandboxState

from pydantic_ai_daytona import (
    DaytonaSandboxError,
    DaytonaSandboxSession,
    DaytonaSandboxTerminalError,
)

if TYPE_CHECKING:
    from tests.unit_tests.conftest import FakeDaytona


@pytest.mark.parametrize(
    "state", [SandboxState.STOPPED, SandboxState.ARCHIVED, SandboxState.PAUSED]
)
async def test_attach_restarts_restartable_states(sdk: FakeDaytona, state: SandboxState) -> None:
    sdk.sandbox.state = state
    async with DaytonaSandboxSession(sandbox_id=sdk.sandbox.id):
        assert sdk.sandbox.starts == 1
    assert not sdk.sandbox.deleted


@pytest.mark.parametrize(
    "state", [SandboxState.STARTING, SandboxState.RESTORING, SandboxState.RESUMING]
)
async def test_attach_waits_for_transitions(sdk: FakeDaytona, state: SandboxState) -> None:
    sdk.sandbox.state = state
    async with DaytonaSandboxSession(sandbox_id=sdk.sandbox.id):
        assert sdk.sandbox.waits == 1
        assert sdk.sandbox.starts == 0


@pytest.mark.parametrize("state", [SandboxState.DESTROYING, SandboxState.DESTROYED])
async def test_attach_rejects_deleted_states(sdk: FakeDaytona, state: SandboxState) -> None:
    sdk.sandbox.state = state
    with pytest.raises(DaytonaSandboxTerminalError):
        await DaytonaSandboxSession(sandbox_id=sdk.sandbox.id).__aenter__()
    assert sdk.closed
    assert sdk.sandbox.starts == 0


@pytest.mark.parametrize("state", [SandboxState.ERROR, SandboxState.BUILD_FAILED])
async def test_attach_reports_failed_states(sdk: FakeDaytona, state: SandboxState) -> None:
    sdk.sandbox.state = state
    with pytest.raises(DaytonaSandboxError, match="failed to start"):
        await DaytonaSandboxSession(sandbox_id=sdk.sandbox.id).__aenter__()
    assert sdk.closed
    assert sdk.sandbox.starts == 0


async def test_cancellation_waits_for_creation_and_shielded_delete(sdk: FakeDaytona) -> None:
    sdk.create_release.clear()
    sdk.sandbox.delete_release.clear()
    session = DaytonaSandboxSession()
    entering = asyncio.create_task(session.__aenter__())
    await sdk.create_started.wait()
    entering.cancel()
    await asyncio.sleep(0)
    sdk.create_release.set()
    await sdk.sandbox.delete_started.wait()
    entering.cancel()
    await asyncio.sleep(0)
    assert not entering.done()
    sdk.sandbox.delete_release.set()
    with pytest.raises(asyncio.CancelledError):
        await entering
    assert sdk.sandbox.deleted
    assert sdk.closed
    assert session.sandbox_id is None


async def test_cancelled_failed_creation_closes_client(sdk: FakeDaytona) -> None:
    sdk.create_release.clear()
    sdk.create_error = DaytonaError("creation refused")
    entering = asyncio.create_task(DaytonaSandboxSession().__aenter__())
    await sdk.create_started.wait()
    entering.cancel()
    await asyncio.sleep(0)
    sdk.create_release.set()
    with pytest.raises(asyncio.CancelledError):
        await entering
    assert sdk.closed
    assert not sdk.sandbox.deleted


async def test_owned_delete_failure_is_reported_not_raised(
    sdk: FakeDaytona, caplog: pytest.LogCaptureFixture
) -> None:
    sdk.sandbox.delete_error = DaytonaError("destroy failed")
    with caplog.at_level(logging.WARNING, logger="pydantic_ai_daytona._session"):
        async with DaytonaSandboxSession():
            pass
    assert not sdk.sandbox.deleted
    assert sdk.closed
    assert [r.getMessage() for r in caplog.records] == [
        f"Could not delete Daytona sandbox {sdk.sandbox.id}: destroy failed"
    ]


async def test_owned_deletion_completes_when_teardown_is_cancelled(sdk: FakeDaytona) -> None:
    # Given an owned session whose deletion is in flight.
    session = await DaytonaSandboxSession().__aenter__()
    sdk.sandbox.delete_release.clear()
    exiting = asyncio.create_task(session.__aexit__(None, None, None))
    await sdk.sandbox.delete_started.wait()

    # When cancellation arrives before the deletion completes.
    exiting.cancel()
    asyncio.get_running_loop().call_soon(sdk.sandbox.delete_release.set)

    # Then deletion completes before cancellation reaches the caller.
    with pytest.raises(asyncio.CancelledError):
        await exiting
    assert sdk.sandbox.deleted
    assert sdk.closed
