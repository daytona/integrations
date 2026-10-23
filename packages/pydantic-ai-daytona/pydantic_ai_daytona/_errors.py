"""Daytona failure translation and control-plane probing."""

from daytona import (
    AsyncSandbox,
    DaytonaAuthenticationError,
    DaytonaError,
    DaytonaFileNotFoundError,
    DaytonaForbiddenError,
    DaytonaGoneError,
    DaytonaNotFoundError,
    DaytonaSessionEndedError,
    SandboxState,
)


class DaytonaSandboxError(Exception):
    """A sandbox operation failed in a way the model may be able to react to."""


class DaytonaSandboxTerminalError(DaytonaSandboxError):
    """The sandbox is gone or unusable; retrying a tool call cannot fix it."""


class DaytonaSandboxAuthError(DaytonaSandboxTerminalError):
    """Daytona rejected the credentials."""


def map_error(error: DaytonaError, action: str) -> DaytonaSandboxError:
    if isinstance(error, (DaytonaAuthenticationError, DaytonaForbiddenError)):
        return DaytonaSandboxAuthError(f"Daytona rejected the credentials while {action}: {error}")
    # These subclass not-found/gone but do not mean the sandbox itself is gone.
    if isinstance(error, (DaytonaFileNotFoundError, DaytonaSessionEndedError)):
        return DaytonaSandboxError(f"Failed {action}: {error}")
    if isinstance(error, (DaytonaNotFoundError, DaytonaGoneError)):
        return DaytonaSandboxTerminalError(
            f"The sandbox is gone (it may have been deleted) while {action}: {error}"
        )
    return DaytonaSandboxError(f"Failed {action}: {error}")


async def operation_error(
    sandbox: AsyncSandbox, error: DaytonaError, action: str
) -> DaytonaSandboxError:
    """Probe ambiguous SDK failures only; an inconclusive probe preserves the original error."""
    mapped = map_error(error, action)
    if type(mapped) is not DaytonaSandboxError or isinstance(
        error, (DaytonaFileNotFoundError, DaytonaSessionEndedError)
    ):
        return mapped
    try:
        await sandbox.refresh_data(request_timeout=30)
    except (DaytonaNotFoundError, DaytonaGoneError):
        return DaytonaSandboxTerminalError(f"The sandbox is gone while {action}: {error}")
    except (DaytonaAuthenticationError, DaytonaForbiddenError) as probe_error:
        return map_error(probe_error, action)
    except DaytonaError:
        return mapped
    if sandbox.state in (SandboxState.DESTROYING, SandboxState.DESTROYED):
        return DaytonaSandboxTerminalError(f"The sandbox is gone while {action}: {error}")
    if sandbox.state in (SandboxState.STOPPED, SandboxState.ARCHIVED, SandboxState.PAUSED):
        return DaytonaSandboxTerminalError(
            f"The sandbox stopped while {action}; attach again to restart it: {error}"
        )
    return mapped
