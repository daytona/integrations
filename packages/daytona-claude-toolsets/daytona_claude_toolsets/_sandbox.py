"""The sandbox a driver works in: one it was handed (borrowed) or one it created (owned)."""

from __future__ import annotations

import logging
from typing import Literal, Optional, Union

from daytona import CreateSandboxFromImageParams, CreateSandboxFromSnapshotParams, Daytona, Sandbox

log = logging.getLogger("daytona_claude_toolsets")

CreateParams = Union[CreateSandboxFromSnapshotParams, CreateSandboxFromImageParams]
OnClose = Literal["delete", "stop"]

LABELS = {"created-by": "daytona-claude-toolsets"}
"""Labels put on every sandbox this package creates, so a leftover one can be found and removed.

Reserved: a caller's `create_params.labels` cannot change them. Taking a sandbox off this list
would hide it from the cleanup the README documents, which is the one thing the label is for."""


class SandboxLease:
    """Holds the driver's sandbox. A borrowed sandbox is never stopped or deleted; an owned one is
    deleted (or stopped) by `release`, once."""

    def __init__(self, sandbox: Sandbox, *, owned: bool, on_close: OnClose) -> None:
        self.sandbox = sandbox
        self.owned = owned
        self.on_close = on_close
        self._released = False

    @classmethod
    def acquire(
        cls,
        sandbox: Optional[Sandbox],
        *,
        daytona: Optional[Daytona],
        create_params: Optional[CreateParams],
        default_env: dict[str, str],
        on_close: OnClose,
        create_timeout: float,
    ) -> SandboxLease:
        if on_close not in ("delete", "stop"):
            raise ValueError("on_close must be 'delete' or 'stop'")
        if sandbox is not None:
            if create_params is not None:
                raise ValueError("pass either sandbox or create_params, not both")
            return cls(sandbox, owned=False, on_close=on_close)

        params = with_defaults(create_params, default_env)
        client = daytona if daytona is not None else Daytona()
        return cls(client.create(params, timeout=create_timeout), owned=True, on_close=on_close)

    def release(self) -> None:
        """Delete or stop an owned sandbox. Safe to call more than once; a failure is logged, not
        raised, so it cannot mask the error that led to the close."""
        if self._released:
            return
        self._released = True
        if not self.owned:
            return
        try:
            if self.on_close == "delete":
                self.sandbox.delete()
            else:
                self.sandbox.stop()
        except Exception as exc:
            log.warning(
                "could not %s sandbox %s (%s); remove it by its label "
                "created-by=daytona-claude-toolsets",
                self.on_close,
                self.sandbox.id,
                type(exc).__name__,
            )


def with_defaults(params: Optional[CreateParams], default_env: dict[str, str]) -> CreateParams:
    """The caller's create params (or the default snapshot's) with this package's label and the
    driver's default environment added. The caller's object is not modified.

    The environment the driver sets is a default: the caller's value for the same name wins.
    `LABELS` is not — it is applied last, so a sandbox this package created always answers to
    the label the README says to clean up by. Every other label the caller sets is kept.
    """
    base: CreateParams = params if params is not None else CreateSandboxFromSnapshotParams()
    env = {**default_env, **(base.env_vars or {})}
    labels = {**(base.labels or {}), **LABELS}
    return base.model_copy(update={"env_vars": env, "labels": labels})
