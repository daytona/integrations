from collections.abc import AsyncIterator, Awaitable, Callable
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


class RecordingSandbox:
    def __init__(self, sandbox_id: str, deleted: list[str]) -> None:
        self.id = sandbox_id
        self.state = SandboxState.STARTED
        self.deleted = deleted

    async def delete(self, *, wait: bool, timeout: float) -> None:
        self.deleted.append(self.id)


def flaky_get(deleted: list[str]) -> Callable[[str], Awaitable[RecordingSandbox]]:
    async def get(sandbox_id: str) -> RecordingSandbox:
        if sandbox_id == "a-flaky":
            raise DaytonaError("transient")
        if sandbox_id in deleted:
            raise DaytonaNotFoundError("deleted")
        return RecordingSandbox(sandbox_id, deleted)

    return get


async def test_cleanup_continues_past_a_failing_sandbox_and_reports_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    deleted: list[str] = []

    async def listed(query: ListSandboxesQuery) -> AsyncIterator[SimpleNamespace]:
        for item in ():
            yield item

    async with AsyncDaytona(DaytonaConfig(api_key="test")) as client:
        monkeypatch.setattr(client, "list", listed)
        monkeypatch.setattr(client, "get", flaky_get(deleted))

        with pytest.raises(AssertionError, match="a-flaky"):
            await cleanup_sandboxes(client, ["a-flaky", "b-ok"], {"pai-upgrade": "test"})

    assert deleted == ["b-ok"]


async def test_label_sweep_keeps_partial_results_past_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    deleted: list[str] = []

    async def listed(query: ListSandboxesQuery) -> AsyncIterator[SimpleNamespace]:
        yield SimpleNamespace(id="a-flaky")
        yield SimpleNamespace(id="b-listed")
        raise DaytonaError("pagination failed")

    async with AsyncDaytona(DaytonaConfig(api_key="test")) as client:
        monkeypatch.setattr(client, "list", listed)
        monkeypatch.setattr(client, "get", flaky_get(deleted))

        with pytest.raises(AssertionError) as caught:
            await cleanup_sandboxes(client, [], {"pai-upgrade": "test"})

    assert deleted == ["b-listed"]
    message = str(caught.value)
    assert "a-flaky" in message
    assert "label sweep" in message


async def test_error_superseded_by_a_later_success_does_not_fail_cleanup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    deleted: list[str] = []
    attempts = {"retried": 0}

    async def listed(query: ListSandboxesQuery) -> AsyncIterator[SimpleNamespace]:
        yield SimpleNamespace(id="retried")

    async def get(sandbox_id: str) -> RecordingSandbox:
        if sandbox_id in deleted:
            raise DaytonaNotFoundError("deleted")
        attempts[sandbox_id] += 1
        if attempts[sandbox_id] == 1:
            raise DaytonaError("transient")
        return RecordingSandbox(sandbox_id, deleted)

    async with AsyncDaytona(DaytonaConfig(api_key="test")) as client:
        monkeypatch.setattr(client, "list", listed)
        monkeypatch.setattr(client, "get", get)

        assert await cleanup_sandboxes(client, ["retried"], {"pai-upgrade": "test"}) == 1

    assert deleted == ["retried"]
