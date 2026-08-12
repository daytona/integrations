"""Daytona sandbox session: lifecycle, command execution, and file access.

`DaytonaSandboxSession` wraps the Daytona SDK behind the small surface the toolset
needs. It owns error translation: SDK failures become `DaytonaSandboxError` (retryable
by the model) or `DaytonaSandboxTerminalError` (the sandbox or credentials are gone;
retrying a tool call cannot help).

Commands run through Daytona process sessions (rather than one-shot `process.exec`)
because only session commands report stdout and stderr as separate streams. A session
runs its commands sequentially, so each command gets its own short-lived session --
that is what lets parallel tool calls actually run in parallel. Each command is also
wrapped in `cd <base> && (...)`: the `cd` keeps `run_command` and the file tools
agreeing on what `.` means, and the subshell keeps shell-terminating commands (like
a bare `exit`) from hanging the session until timeout.
"""

from __future__ import annotations

import posixpath
import shlex
from collections.abc import Mapping
from dataclasses import dataclass
from types import TracebackType
from uuid import uuid4

from daytona import (
    AsyncDaytona,
    AsyncSandbox,
    CreateSandboxFromImageParams,
    CreateSandboxFromSnapshotParams,
    DaytonaAuthenticationError,
    DaytonaConfig,
    DaytonaConnectionTimeoutError,
    DaytonaError,
    DaytonaFileNotFoundError,
    DaytonaForbiddenError,
    DaytonaGoneError,
    DaytonaNotFoundError,
    DaytonaProcessExecutionTimeoutError,
    DaytonaSessionEndedError,
    SandboxState,
    SessionExecuteRequest,
)
from typing_extensions import Self

DEFAULT_SANDBOX_CREATE_TIMEOUT = 120.0


class DaytonaSandboxError(Exception):
    """A sandbox operation failed in a way the model may be able to react to."""


class DaytonaSandboxTerminalError(DaytonaSandboxError):
    """The sandbox is gone or unusable; retrying a tool call cannot fix it."""


class DaytonaSandboxAuthError(DaytonaSandboxTerminalError):
    """Daytona rejected the credentials."""


@dataclass(kw_only=True, frozen=True)
class DaytonaSandboxExecResult:
    """Outcome of one command: separate output streams, exit code, and timeout status.

    A timed-out command's output is not captured (`stdout` and `stderr` are empty and
    `timed_out` is True).
    """

    stdout: str
    stderr: str
    exit_code: int
    timed_out: bool
    applied_timeout: int


class DaytonaSandboxSession:
    """Lifecycle, command, and file access for one Daytona sandbox.

    Use as an async context manager. With `sandbox_id` the session attaches to an
    existing sandbox (starting it if stopped) and leaves it running on exit; otherwise
    it creates a sandbox on enter (from `snapshot`, `image`, or the Daytona default
    snapshot) and deletes it on exit.

    Pass an entered session to `DaytonaSandbox(session=...)` to reuse one sandbox
    across agent runs while controlling its lifetime yourself.
    """

    def __init__(
        self,
        *,
        snapshot: str | None = None,
        image: str | None = None,
        sandbox_id: str | None = None,
        env: Mapping[str, str] | None = None,
        workdir: str | None = None,
        labels: Mapping[str, str] | None = None,
        os_user: str | None = None,
        ephemeral: bool | None = None,
        network_block_all: bool | None = None,
        network_allow_list: str | None = None,
        domain_allow_list: str | None = None,
        auto_stop_interval: int | None = None,
        auto_delete_interval: int | None = None,
        api_key: str | None = None,
        api_url: str | None = None,
        target: str | None = None,
        create_timeout: float = DEFAULT_SANDBOX_CREATE_TIMEOUT,
    ) -> None:
        if snapshot is not None and image is not None:
            raise ValueError("snapshot and image are mutually exclusive; pass at most one.")
        self._snapshot = snapshot
        self._image = image
        self._attach_id = sandbox_id
        self._env = dict(env) if env is not None else None
        self._workdir = workdir
        self._labels = dict(labels) if labels is not None else None
        self._os_user = os_user
        self._ephemeral = ephemeral
        self._network_block_all = network_block_all
        self._network_allow_list = network_allow_list
        self._domain_allow_list = domain_allow_list
        self._auto_stop_interval = auto_stop_interval
        self._auto_delete_interval = auto_delete_interval
        self._api_key = api_key
        self._api_url = api_url
        self._target = target
        self._create_timeout = create_timeout
        self._daytona: AsyncDaytona | None = None
        self._sandbox: AsyncSandbox | None = None
        self._owned = False
        self._exec_base: str | None = None
        self._exec_session_id: str | None = None

    @property
    def sandbox_id(self) -> str | None:
        """Id of the connected sandbox, or None while the session is not open."""
        return self._sandbox.id if self._sandbox is not None else None

    @property
    def workdir(self) -> str | None:
        return self._workdir

    async def __aenter__(self) -> Self:
        if self._sandbox is not None:
            raise DaytonaSandboxError("The session is already open.")
        config = None
        if self._api_key or self._api_url or self._target:
            config = DaytonaConfig(api_key=self._api_key, api_url=self._api_url, target=self._target)
        daytona = AsyncDaytona(config)
        sandbox: AsyncSandbox | None = None
        try:
            if self._attach_id is not None:
                sandbox = await daytona.get(self._attach_id)
                if sandbox.state != SandboxState.STARTED:
                    await sandbox.start()
                self._owned = False
            else:
                sandbox = await daytona.create(self._create_params(), timeout=self._create_timeout)
                self._owned = True
            self._exec_base = self._workdir or await sandbox.get_work_dir()
        except DaytonaError as e:
            if self._owned and sandbox is not None:
                await self._delete_quietly(sandbox)
            await daytona.close()
            self._owned = False
            raise self._map_error(e, "opening the sandbox session") from e
        except BaseException:
            if self._owned and sandbox is not None:
                await self._delete_quietly(sandbox)
            await daytona.close()
            self._owned = False
            raise
        self._daytona = daytona
        self._sandbox = sandbox
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        daytona, sandbox, owned = self._daytona, self._sandbox, self._owned
        self._daytona = None
        self._sandbox = None
        self._owned = False
        self._exec_base = None
        if daytona is None:
            return
        try:
            if owned and sandbox is not None:
                await self._delete_quietly(sandbox)
        finally:
            await daytona.close()

    @staticmethod
    async def _delete_quietly(sandbox: AsyncSandbox) -> None:
        try:
            await sandbox.delete()
        except DaytonaError:
            # Best-effort cleanup: the sandbox's auto-stop/auto-delete/ephemeral settings
            # are the server-side backstop, and failing the whole agent run over a cleanup
            # hiccup would discard its result.
            pass

    def _create_params(self) -> CreateSandboxFromSnapshotParams | CreateSandboxFromImageParams:
        if self._image is not None:
            return CreateSandboxFromImageParams(
                image=self._image,
                env_vars=self._env,
                labels=self._labels,
                os_user=self._os_user,
                ephemeral=self._ephemeral,
                network_block_all=self._network_block_all,
                network_allow_list=self._network_allow_list,
                domain_allow_list=self._domain_allow_list,
                auto_stop_interval=self._auto_stop_interval,
                auto_delete_interval=self._auto_delete_interval,
            )
        return CreateSandboxFromSnapshotParams(
            snapshot=self._snapshot,
            env_vars=self._env,
            labels=self._labels,
            os_user=self._os_user,
            ephemeral=self._ephemeral,
            network_block_all=self._network_block_all,
            network_allow_list=self._network_allow_list,
            domain_allow_list=self._domain_allow_list,
            auto_stop_interval=self._auto_stop_interval,
            auto_delete_interval=self._auto_delete_interval,
        )

    def _require_sandbox(self) -> AsyncSandbox:
        if self._sandbox is None:
            raise DaytonaSandboxError(
                "The session is not open. Enter it with `async with session:` first."
            )
        return self._sandbox

    def _resolve(self, path: str) -> str:
        # File-system calls resolve relative paths against the sandbox's default working
        # directory server-side; when the session pins a different `workdir`, anchor them
        # there instead so file tools and `run_command` agree on what `.` means.
        if self._workdir is not None and not posixpath.isabs(path):
            return posixpath.normpath(posixpath.join(self._workdir, path))
        return path

    @staticmethod
    def _map_error(e: DaytonaError, action: str) -> DaytonaSandboxError:
        if isinstance(e, (DaytonaAuthenticationError, DaytonaForbiddenError)):
            return DaytonaSandboxAuthError(f"Daytona rejected the credentials while {action}: {e}")
        # Order matters: file-not-found and session-ended both subclass the "gone"
        # errors below, but neither means the sandbox itself is lost, so they stay
        # retryable.
        if isinstance(e, (DaytonaFileNotFoundError, DaytonaSessionEndedError)):
            return DaytonaSandboxError(f"Failed {action}: {e}")
        if isinstance(e, (DaytonaNotFoundError, DaytonaGoneError)):
            return DaytonaSandboxTerminalError(
                f"The sandbox is gone (it may have been deleted) while {action}: {e}"
            )
        return DaytonaSandboxError(f"Failed {action}: {e}")

    def _wrap_command(self, command: str) -> str:
        # The `cd` pins the working directory: a fresh session starts in the sandbox
        # default dir, not in a caller-pinned `workdir`. The subshell contains shell
        # termination: a bare `exit` kills the session's shell and the command then
        # hangs until its timeout with all output lost (observed live), while
        # `(exit N)` reports N cleanly.
        if self._exec_base:
            return f"cd {shlex.quote(self._exec_base)} && ({command})"
        return f"({command})"

    async def exec(self, command: str, *, timeout: int) -> DaytonaSandboxExecResult:
        """Run a shell command in the sandbox and return its output streams.

        A non-zero exit code is reported in the result, not raised. A timeout is
        reported with `timed_out=True`; Daytona does not return output captured
        before the deadline.
        """
        sandbox = self._require_sandbox()
        session_id = f"pydantic-ai-{uuid4().hex[:12]}"
        request = SessionExecuteRequest(
            command=self._wrap_command(command), run_async=False, suppress_input_echo=True
        )
        try:
            await sandbox.process.create_session(session_id)
            try:
                response = await sandbox.process.execute_session_command(
                    session_id, request, timeout=timeout
                )
            finally:
                try:
                    await sandbox.process.delete_session(session_id)
                except DaytonaError:
                    # Best-effort: deleting the session also tears down a still-running
                    # timed-out command, but a cleanup failure must not mask the result
                    # (or the real error) of the command itself.
                    pass
        except (DaytonaProcessExecutionTimeoutError, DaytonaConnectionTimeoutError):
            # Session commands surface the server-enforced command deadline as a
            # connection timeout (observed live), not as the process-timeout error
            # one-shot exec uses; treat both as the command timing out.
            return DaytonaSandboxExecResult(
                stdout="", stderr="", exit_code=-1, timed_out=True, applied_timeout=timeout
            )
        except DaytonaError as e:
            raise self._map_error(e, "running the command") from e
        if response.exit_code is None:
            raise DaytonaSandboxError("The command did not report an exit code.")
        return DaytonaSandboxExecResult(
            stdout=response.stdout or "",
            stderr=response.stderr or "",
            exit_code=response.exit_code,
            timed_out=False,
            applied_timeout=timeout,
        )

    async def file_size(self, path: str) -> int:
        """Size in bytes of a file; raises if `path` is a directory."""
        sandbox = self._require_sandbox()
        resolved = self._resolve(path)
        try:
            info = await sandbox.fs.get_file_info(resolved)
        except DaytonaError as e:
            raise self._map_error(e, f"inspecting {path!r}") from e
        if info.is_dir:
            raise DaytonaSandboxError(f"{path!r} is a directory, not a file.")
        return info.size

    async def read_bytes(self, path: str) -> bytes:
        sandbox = self._require_sandbox()
        resolved = self._resolve(path)
        try:
            data = await sandbox.fs.download_file(resolved)
        except DaytonaError as e:
            raise self._map_error(e, f"reading {path!r}") from e
        if data is None:
            raise DaytonaSandboxError(f"Reading {path!r} returned no data.")
        return data

    async def write_bytes(self, path: str, data: bytes) -> None:
        """Write bytes to a file (parent directories are created by Daytona)."""
        sandbox = self._require_sandbox()
        resolved = self._resolve(path)
        try:
            await sandbox.fs.upload_file(data, resolved)
        except DaytonaError as e:
            raise self._map_error(e, f"writing {path!r}") from e

    async def list_entries(self, path: str) -> list[tuple[str, bool]]:
        """`(name, is_dir)` for each entry in a directory, sorted by name."""
        sandbox = self._require_sandbox()
        resolved = self._resolve(path)
        try:
            infos = await sandbox.fs.list_files(resolved)
        except DaytonaError as e:
            raise self._map_error(e, f"listing {path!r}") from e
        return sorted((info.name, info.is_dir) for info in infos)
