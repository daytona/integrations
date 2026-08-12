"""Daytona sandbox toolset: the model-facing tools backed by a sandbox session."""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Annotated

from pydantic import Field
from pydantic_ai import RunContext
from pydantic_ai.exceptions import ModelRetry
from pydantic_ai.tools import AgentDepsT
from pydantic_ai.toolsets import AbstractToolset, FunctionToolset
from typing_extensions import Self

from pydantic_ai_daytona._session import (
    DaytonaSandboxError,
    DaytonaSandboxSession,
    DaytonaSandboxTerminalError,
)
from pydantic_ai_daytona._tool_output import (
    guard_read_size,
    render_file_window,
    truncate_output,
)


class DaytonaSandboxToolset(FunctionToolset[AgentDepsT]):
    """Gives an agent a Daytona sandbox to run commands and manage files in.

    Holds the sandbox configuration and, for each run, opens a `DaytonaSandboxSession`
    (creating a fresh sandbox, or attaching to `sandbox_id`) that the tools execute
    against. An owned session's sandbox is deleted when the run ends.
    """

    def __init__(
        self,
        *,
        snapshot: str | None,
        image: str | None,
        sandbox_id: str | None,
        env: Mapping[str, str] | None,
        workdir: str | None,
        labels: Mapping[str, str] | None,
        os_user: str | None,
        ephemeral: bool | None,
        network_block_all: bool | None,
        network_allow_list: str | None,
        domain_allow_list: str | None,
        auto_stop_interval: int | None,
        auto_delete_interval: int | None,
        api_key: str | None,
        api_url: str | None,
        target: str | None,
        default_command_timeout: float,
        max_command_timeout: int,
        max_output_bytes: int,
        max_output_lines: int,
        max_read_bytes: int,
        session: DaytonaSandboxSession | None = None,
        _run_scoped: bool = False,
    ) -> None:
        super().__init__()
        self._snapshot = snapshot
        self._image = image
        self._sandbox_id = sandbox_id
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
        self._default_command_timeout = default_command_timeout
        self._max_command_timeout = max_command_timeout
        self._max_output_bytes = max_output_bytes
        self._max_output_lines = max_output_lines
        self._max_read_bytes = max_read_bytes
        # A caller-owned session to reuse instead of opening one per run; when set, this
        # toolset uses it but never opens or closes it.
        self._external_session = session
        self._session: DaytonaSandboxSession | None = None
        self._run_scoped = _run_scoped

        self.add_function(self.run_command, name="run_command")
        self.add_function(self.read_file, name="read_file")
        self.add_function(self.write_file, name="write_file")
        self.add_function(self.list_directory, name="list_directory")

    async def for_run(self, ctx: RunContext[AgentDepsT]) -> AbstractToolset[AgentDepsT]:
        """Return a fresh instance per run so each run gets its own sandbox session."""
        return DaytonaSandboxToolset[AgentDepsT](
            snapshot=self._snapshot,
            image=self._image,
            sandbox_id=self._sandbox_id,
            env=self._env,
            workdir=self._workdir,
            labels=self._labels,
            os_user=self._os_user,
            ephemeral=self._ephemeral,
            network_block_all=self._network_block_all,
            network_allow_list=self._network_allow_list,
            domain_allow_list=self._domain_allow_list,
            auto_stop_interval=self._auto_stop_interval,
            auto_delete_interval=self._auto_delete_interval,
            api_key=self._api_key,
            api_url=self._api_url,
            target=self._target,
            default_command_timeout=self._default_command_timeout,
            max_command_timeout=self._max_command_timeout,
            max_output_bytes=self._max_output_bytes,
            max_output_lines=self._max_output_lines,
            max_read_bytes=self._max_read_bytes,
            session=self._external_session,
            _run_scoped=True,
        )

    async def __aenter__(self) -> Self:
        if not self._run_scoped:
            return self
        if self._external_session is not None:
            if self._external_session.sandbox_id is None:
                raise DaytonaSandboxError(
                    "The injected session is not open. Enter it with `async with session:` "
                    "before running the agent."
                )
            self._session = self._external_session
            return self
        session = DaytonaSandboxSession(
            snapshot=self._snapshot,
            image=self._image,
            sandbox_id=self._sandbox_id,
            env=self._env,
            workdir=self._workdir,
            labels=self._labels,
            os_user=self._os_user,
            ephemeral=self._ephemeral,
            network_block_all=self._network_block_all,
            network_allow_list=self._network_allow_list,
            domain_allow_list=self._domain_allow_list,
            auto_stop_interval=self._auto_stop_interval,
            auto_delete_interval=self._auto_delete_interval,
            api_key=self._api_key,
            api_url=self._api_url,
            target=self._target,
        )
        await session.__aenter__()
        self._session = session
        return self

    async def __aexit__(self, *args: object) -> None:
        session = self._session
        self._session = None
        if session is not None and self._external_session is None:
            await session.__aexit__(None, None, None)

    def _require_session(self) -> DaytonaSandboxSession:
        if self._session is None:
            # Reachable by calling a tool on an instance that was never entered; a caller
            # error, not a model mistake, so it propagates rather than becoming ModelRetry.
            raise DaytonaSandboxError("The Daytona sandbox session is not open.")
        return self._session

    def _command_timeout(self, timeout_seconds: float | None) -> int:
        if timeout_seconds is not None and (
            not math.isfinite(timeout_seconds) or timeout_seconds <= 0
        ):
            raise ModelRetry(f"timeout_seconds must be greater than 0, got {timeout_seconds}.")
        requested = (
            timeout_seconds if timeout_seconds is not None else self._default_command_timeout
        )
        return min(max(1, math.ceil(requested)), self._max_command_timeout)

    async def run_command(
        self,
        command: str,
        *,
        timeout_seconds: Annotated[
            float | None, Field(description="Timeout for this command in seconds")
        ] = None,
    ) -> str:
        """Run a shell command in the sandbox and return its output.

        The command runs through a shell, so pipes, redirection, `&&`, and globs work.
        A non-zero exit is reported, not raised, so you can react to it. A timed-out
        command's output is not captured.

        Args:
            command: The shell command to run.
            timeout_seconds: Timeout for this command; defaults to the configured
                default and is capped at the configured maximum.
        """
        session = self._require_session()
        try:
            result = await session.exec(command, timeout=self._command_timeout(timeout_seconds))
        except DaytonaSandboxTerminalError:
            raise
        except DaytonaSandboxError as e:
            raise ModelRetry(str(e))
        if result.timed_out:
            return f"[timed out after {result.applied_timeout}s; output was not captured]"
        # Truncate each stream separately and label it afterwards, so the `[stdout]` /
        # `[stderr]` markers always survive truncation and a large stderr cannot crowd
        # stdout out of a shared budget.
        parts: list[str] = []
        for label, text in (("stdout", result.stdout), ("stderr", result.stderr)):
            if text:
                truncated = truncate_output(
                    text, max_lines=self._max_output_lines, max_bytes=self._max_output_bytes
                )
                parts.append(f"[{label}]\n{truncated}")
        output = "\n".join(parts) if parts else "(no output)"
        if result.exit_code:
            return f"{output}\n[exit code: {result.exit_code}]"
        return output

    async def read_file(
        self,
        path: str,
        *,
        offset: Annotated[
            int | None, Field(description="Line number to start reading from (1-indexed)")
        ] = None,
        limit: Annotated[int | None, Field(description="Maximum number of lines to read")] = None,
    ) -> str:
        """Read a text file from the sandbox and return its contents.

        Large files are truncated to a safety cap; the result ends with the next
        `offset` to use to page through the rest. Each page re-transfers the whole
        file from the sandbox (Daytona has no ranged download), so for files of
        megabytes prefer slicing server-side via `run_command` (e.g. `sed -n`,
        `head`, `tail`, or `grep`).

        Args:
            path: Path to the file inside the sandbox. Relative paths are resolved
                against the working directory used by `run_command`.
            offset: Line number to start reading from (1-indexed).
            limit: Maximum number of lines to read.
        """
        session = self._require_session()
        try:
            # Check size before transferring: read_bytes pulls the whole file, so an
            # oversized file should be refused from metadata alone.
            guard_read_size(await session.file_size(path), max_bytes=self._max_read_bytes)
            data = await session.read_bytes(path)
        except DaytonaSandboxTerminalError:
            raise
        except DaytonaSandboxError as e:
            raise ModelRetry(f"Could not read {path!r}: {e}")
        # Re-check the bytes actually returned: the file could have grown between the
        # metadata check and the transfer.
        guard_read_size(len(data), max_bytes=self._max_read_bytes)
        return render_file_window(
            data,
            offset=offset,
            limit=limit,
            max_lines=self._max_output_lines,
            max_bytes=self._max_output_bytes,
        )

    async def write_file(self, path: str, content: str) -> str:
        """Write text to a file in the sandbox, creating the parent directory.

        Args:
            path: Path to the file inside the sandbox. Relative paths are resolved
                against the working directory used by `run_command`.
            content: The text to write.
        """
        session = self._require_session()
        try:
            data = content.encode("utf-8")
        except UnicodeEncodeError:
            raise ModelRetry(
                "content contains characters that cannot be encoded as UTF-8 "
                "(unpaired surrogates)."
            )
        try:
            await session.write_bytes(path, data)
        except DaytonaSandboxTerminalError:
            raise
        except DaytonaSandboxError as e:
            raise ModelRetry(f"Could not write {path!r}: {e}")
        return f"Wrote {len(data)} bytes to {path!r}."

    async def list_directory(self, path: str = ".") -> str:
        """List the entries in a sandbox directory (directories shown with a trailing `/`).

        Args:
            path: Directory to list. Relative paths (including the default `.`) are
                resolved against the working directory used by `run_command`.
        """
        session = self._require_session()
        try:
            entries = await session.list_entries(path)
        except DaytonaSandboxTerminalError:
            raise
        except DaytonaSandboxError as e:
            raise ModelRetry(f"Could not list {path!r}: {e}")
        if not entries:
            return "(empty directory)"
        lines = [f"{name}/" if is_dir else name for name, is_dir in entries]
        return truncate_output(
            "\n".join(lines),
            max_lines=self._max_output_lines,
            max_bytes=self._max_output_bytes,
            direction="head",
        )
