from collections.abc import AsyncIterator
from types import SimpleNamespace

import pytest
from daytona import (
    AsyncDaytona,
    AsyncSandbox,
    DaytonaConfig,
    DaytonaError,
    DaytonaGoneError,
    DaytonaNotFoundError,
    DaytonaSessionEndedError,
    ListSandboxesQuery,
    SandboxState,
)

from tests.integration_tests.conftest import cleanup_sandboxes, listed_sandboxes


@pytest.mark.parametrize(
    "error",
    [DaytonaGoneError("gone"), DaytonaSessionEndedError("ended"), DaytonaError("offline")],
)
async def test_live_verification_propagates_when_deletion_is_inconclusive(
    monkeypatch: pytest.MonkeyPatch, error: DaytonaError
) -> None:
    async def listed(query: ListSandboxesQuery) -> AsyncIterator[SimpleNamespace]:
        yield SimpleNamespace(id="sandbox")

    async def get(sandbox_id: str) -> AsyncSandbox:
        raise error

    async with AsyncDaytona(DaytonaConfig(api_key="test")) as client:
        monkeypatch.setattr(client, "list", listed)
        monkeypatch.setattr(client, "get", get)

        with pytest.raises(type(error)) as caught:
            await listed_sandboxes(client, {"pai-upgrade": "test"})

    assert caught.value is error


async def test_live_verification_omits_when_sandbox_is_not_found(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def listed(query: ListSandboxesQuery) -> AsyncIterator[SimpleNamespace]:
        yield SimpleNamespace(id="sandbox")

    async def get(sandbox_id: str) -> AsyncSandbox:
        raise DaytonaNotFoundError("deleted")

    async with AsyncDaytona(DaytonaConfig(api_key="test")) as client:
        monkeypatch.setattr(client, "list", listed)
        monkeypatch.setattr(client, "get", get)

        remaining = await listed_sandboxes(client, {"pai-upgrade": "test"})

    assert remaining == []


async def test_cleanup_continues_past_a_failing_sandbox_and_reports_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    deleted: list[str] = []

    class FakeSandbox:
        def __init__(self, sandbox_id: str) -> None:
            self.id = sandbox_id
            self.state = SandboxState.STARTED

        async def delete(self, *, wait: bool, timeout: float) -> None:
            deleted.append(self.id)

    async def listed(query: ListSandboxesQuery) -> AsyncIterator[SimpleNamespace]:
        for item in ():
            yield item

    async def get(sandbox_id: str) -> FakeSandbox:
        if sandbox_id == "a-flaky":
            raise DaytonaError("transient")
        if sandbox_id in deleted:
            raise DaytonaNotFoundError("deleted")
        return FakeSandbox(sandbox_id)

    async with AsyncDaytona(DaytonaConfig(api_key="test")) as client:
        monkeypatch.setattr(client, "list", listed)
        monkeypatch.setattr(client, "get", get)

        with pytest.raises(AssertionError, match="a-flaky"):
            await cleanup_sandboxes(client, ["a-flaky", "b-ok"], {"pai-upgrade": "test"})

    assert deleted == ["b-ok"]
