"""Daytona sandbox lifecycle and file access; commands use independent file-backed sessions."""

from __future__ import annotations

import logging
import posixpath
from collections.abc import Mapping
from types import TracebackType

from daytona import (
    AsyncDaytona,
    AsyncSandbox,
    CreateSandboxFromImageParams,
    CreateSandboxFromSnapshotParams,
    DaytonaConfig,
    DaytonaError,
    SandboxState,
)
from typing_extensions import Self

from ._asyncio import run_to_completion
from ._errors import DaytonaSandboxAuthError as DaytonaSandboxAuthError
from ._errors import DaytonaSandboxError, DaytonaSandboxTerminalError, map_error, operation_error
from ._execution import CapturedCommand
from ._execution import DaytonaSandboxExecResult as DaytonaSandboxExecResult
from ._tool_output import DEFAULT_MAX_BYTES

logger = logging.getLogger(__name__)

DEFAULT_SANDBOX_CREATE_TIMEOUT = 120.0


class DaytonaSandboxSession:
    """Lifecycle, command, and file access for one Daytona sandbox.

    Use as an async context manager. With `sandbox_id` the session attaches to an
    existing sandbox (resuming it if stopped, archived, or paused) and leaves it running
    on exit; otherwise
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
        self._shell = "/bin/sh"

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
            config = DaytonaConfig(
                api_key=self._api_key, api_url=self._api_url, target=self._target
            )
        daytona = AsyncDaytona(config)
        sandbox: AsyncSandbox | None = None
        try:
            if self._attach_id is not None:
                sandbox = await daytona.get(self._attach_id)
                if sandbox.state in (SandboxState.DESTROYING, SandboxState.DESTROYED):
                    raise DaytonaSandboxTerminalError("The sandbox is gone (it was deleted).")
                if sandbox.state in (
                    SandboxState.STOPPED,
                    SandboxState.ARCHIVED,
                    SandboxState.PAUSED,
                ):
                    await sandbox.start(timeout=self._create_timeout)
                elif sandbox.state != SandboxState.STARTED:
                    await sandbox.wait_for_sandbox_start(timeout=self._create_timeout)
                self._owned = False
            else:

                async def create() -> None:
                    nonlocal sandbox
                    sandbox = await daytona.create(
                        self._create_params(), timeout=self._create_timeout
                    )
                    self._owned = True

                await run_to_completion(create())
            assert sandbox is not None
            try:
                probe = await sandbox.process.exec("command -v bash", timeout=30)
            except DaytonaError:
                # Discovery is optional: a failed probe keeps the portable shell default.
                self._shell = "/bin/sh"
            else:
                self._shell = (probe.result.strip() or "/bin/sh") if not probe.exit_code else "/bin/sh"
            self._exec_base = self._workdir or await sandbox.get_work_dir()
        except DaytonaError as e:
            await run_to_completion(self._close(daytona, sandbox))
            raise self._map_error(e, "opening the sandbox session") from e
        except BaseException:
            await run_to_completion(self._close(daytona, sandbox))
            raise
        self._daytona = daytona
        self._sandbox = sandbox
        return self

    async def _close(self, daytona: AsyncDaytona, sandbox: AsyncSandbox | None) -> None:
        try:
            if self._owned and sandbox is not None:
                await self._delete_quietly(sandbox)
        finally:
            self._owned = False
            await daytona.close()

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
            await sandbox.delete(wait=True)
        except DaytonaError as error:
            # Reported, not raised: teardown runs after the agent's work is done, and failing
            # the run here would discard its result. The id lets the user delete it manually.
            logger.warning("Could not delete Daytona sandbox %s: %s", sandbox.id, error)

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

    _map_error = staticmethod(map_error)

    async def exec(
        self, command: str, *, timeout: int, max_output_bytes: int = DEFAULT_MAX_BYTES
    ) -> DaytonaSandboxExecResult:
        """Return bounded output tails and exact exit status, including partial output on timeout."""
        if max_output_bytes <= 0:
            raise ValueError("max_output_bytes must be positive.")
        sandbox = self._require_sandbox()
        captured = CapturedCommand(sandbox, max_bytes=max_output_bytes, shell=self._shell)
        return await captured.run(
            captured.wrap(command, cwd=self._exec_base, env=self._env), timeout=timeout
        )

    async def file_size(self, path: str) -> int:
        """Size in bytes of a file; raises if `path` is a directory."""
        sandbox = self._require_sandbox()
        resolved = self._resolve(path)
        try:
            info = await sandbox.fs.get_file_info(resolved)
        except DaytonaError as e:
            raise await operation_error(sandbox, e, f"inspecting {path!r}") from e
        if info.is_dir:
            raise DaytonaSandboxError(f"{path!r} is a directory, not a file.")
        return info.size

    async def read_bytes(self, path: str) -> bytes:
        sandbox = self._require_sandbox()
        resolved = self._resolve(path)
        try:
            data = await sandbox.fs.download_file(resolved)
        except DaytonaError as e:
            raise await operation_error(sandbox, e, f"reading {path!r}") from e
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
            raise await operation_error(sandbox, e, f"writing {path!r}") from e

    async def list_entries(self, path: str) -> list[tuple[str, bool]]:
        """`(name, is_dir)` for each entry in a directory, sorted by name."""
        sandbox = self._require_sandbox()
        resolved = self._resolve(path)
        try:
            infos = await sandbox.fs.list_files(resolved)
        except DaytonaError as e:
            raise await operation_error(sandbox, e, f"listing {path!r}") from e
        return sorted((info.name, info.is_dir) for info in infos)
