from __future__ import annotations

from types import SimpleNamespace
from typing import TYPE_CHECKING, Literal

import pytest
from daytona import (
    DaytonaAuthenticationError,
    DaytonaError,
    DaytonaFileNotFoundError,
    DaytonaForbiddenError,
    DaytonaGoneError,
    DaytonaNotFoundError,
    DaytonaSessionEndedError,
    SandboxState,
)

from pydantic_ai_daytona import (
    DaytonaSandboxAuthError,
    DaytonaSandboxError,
    DaytonaSandboxSession,
    DaytonaSandboxTerminalError,
)
from typing_extensions import assert_never

if TYPE_CHECKING:
    from tests.unit_tests.conftest import FakeDaytona


class FailingFilesystem:
    async def get_file_info(self, path: str) -> SimpleNamespace:
        raise DaytonaError("toolbox unreachable")

    async def download_file(self, path: str) -> bytes:
        raise DaytonaError("toolbox unreachable")

    async def upload_file(self, data: bytes, path: str) -> None:
        raise DaytonaError("toolbox unreachable")

    async def list_files(self, path: str) -> list[SimpleNamespace]:
        raise DaytonaError("toolbox unreachable")


@pytest.mark.parametrize("operation", ["size", "read", "write", "list"])
async def test_filesystem_errors_probe_deleted_sandbox(
    sdk: FakeDaytona,
    monkeypatch: pytest.MonkeyPatch,
    operation: Literal["size", "read", "write", "list"],
) -> None:
    monkeypatch.setattr(sdk.sandbox, "fs", FailingFilesystem(), raising=False)
    async with DaytonaSandboxSession() as session:
        sdk.sandbox.state = SandboxState.DESTROYED
        with pytest.raises(DaytonaSandboxTerminalError):
            match operation:
                case "size":
                    await session.file_size("file")
                case "read":
                    await session.read_bytes("file")
                case "write":
                    await session.write_bytes("file", b"value")
                case "list":
                    await session.list_entries(".")
                case unreachable:
                    assert_never(unreachable)


@pytest.mark.parametrize("state", [SandboxState.DESTROYING, SandboxState.DESTROYED])
async def test_generic_error_probes_deleted_states(sdk: FakeDaytona, state: SandboxState) -> None:
    async with DaytonaSandboxSession() as session:
        sdk.sandbox.state = state
        sdk.sandbox.process.execute_error = DaytonaError("toolbox unreachable")
        with pytest.raises(DaytonaSandboxTerminalError):
            await session.exec("true", timeout=5)
    assert sdk.sandbox.refreshes == 1


@pytest.mark.parametrize(
    "probe_error",
    [
        DaytonaNotFoundError("gone"),
        DaytonaFileNotFoundError("path"),
        DaytonaGoneError("unavailable"),
        DaytonaSessionEndedError("session"),
        DaytonaError("offline"),
        None,
    ],
)
async def test_probe_preserves_inconclusive_errors(
    sdk: FakeDaytona, probe_error: DaytonaError | None
) -> None:
    sdk.sandbox.refresh_error = probe_error
    sdk.sandbox.process.setup_error = DaytonaError("original")
    async with DaytonaSandboxSession() as session:
        with pytest.raises(DaytonaSandboxError, match="original") as caught:
            await session.exec("true", timeout=5)
    assert isinstance(caught.value, DaytonaSandboxTerminalError) is isinstance(
        probe_error, DaytonaNotFoundError
    )


@pytest.mark.parametrize(
    "error,expected",
    [
        (DaytonaFileNotFoundError("path"), DaytonaSandboxError),
        (DaytonaSessionEndedError("session"), DaytonaSandboxError),
        (DaytonaNotFoundError("sandbox"), DaytonaSandboxTerminalError),
        (DaytonaGoneError("sandbox"), DaytonaSandboxTerminalError),
        (DaytonaAuthenticationError("auth"), DaytonaSandboxAuthError),
        (DaytonaForbiddenError("auth"), DaytonaSandboxAuthError),
    ],
)
async def test_known_errors_keep_mapping_without_probe(
    sdk: FakeDaytona, error: DaytonaError, expected: type[DaytonaSandboxError]
) -> None:
    sdk.sandbox.process.setup_error = error
    async with DaytonaSandboxSession() as session:
        with pytest.raises(expected) as caught:
            await session.exec("true", timeout=5)
    assert type(caught.value) is expected
    assert sdk.sandbox.refreshes == 0
