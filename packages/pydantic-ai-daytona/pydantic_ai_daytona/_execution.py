"""File-backed command capture with sandbox-side byte limits."""

from __future__ import annotations

import base64
import binascii
import logging
import shlex
import time
from collections.abc import Mapping
from dataclasses import dataclass
from uuid import uuid4

from daytona import (
    AsyncSandbox,
    DaytonaConnectionTimeoutError,
    DaytonaError,
    DaytonaProcessExecutionTimeoutError,
    SessionExecuteRequest,
)

from ._asyncio import run_to_completion
from ._errors import DaytonaSandboxError, operation_error

logger = logging.getLogger(__name__)


@dataclass(kw_only=True, frozen=True, slots=True)
class DaytonaSandboxExecResult:
    """Outcome with bounded tails, including output written before a timeout.

    Truncation flags cover sandbox-side byte cuts and UTF-8 preview byte capping.
    A timeout has exit_code=-1; otherwise the command's exact exit status is preserved.
    """

    stdout: str
    stderr: str
    exit_code: int
    timed_out: bool
    applied_timeout: int
    stdout_truncated: bool = False
    stderr_truncated: bool = False


class CapturedCommand:
    """One short-lived process session and its private output files."""

    def __init__(self, sandbox: AsyncSandbox, *, max_bytes: int, shell: str) -> None:
        self.sandbox = sandbox
        self.max_bytes = max_bytes
        self.shell = shell
        self.session_id = f"pydantic-ai-{uuid4().hex}"
        self.paths = (f"/tmp/{self.session_id}.out", f"/tmp/{self.session_id}.err")
        self.collected = False

    def wrap(self, command: str, *, cwd: str | None, env: Mapping[str, str] | None) -> str:
        argv = [
            "env",
            "--",
            *(f"{k}={v}" for k, v in (env or {}).items()),
            self.shell,
            "-c",
            command,
        ]
        invocation = shlex.join(argv)
        # Keep the subshell: bare `exit` otherwise hangs Daytona's session (verified live).
        body = f"cd {shlex.quote(cwd)} && ({invocation})" if cwd else f"({invocation})"
        return shlex.join(["sh", "-c", f"({body}) </dev/null >{self.paths[0]} 2>{self.paths[1]}"])

    async def run(self, line: str, *, timeout: int) -> DaytonaSandboxExecResult:
        try:
            # Setup connection timeouts are infrastructure errors, not command deadlines.
            await self.sandbox.process.create_session(self.session_id)
        except DaytonaError as error:
            raise await operation_error(
                self.sandbox, error, "creating the command session"
            ) from error
        try:
            timed_out = False
            exit_code = -1
            started = time.monotonic()
            try:
                response = await self.sandbox.process.execute_session_command(
                    self.session_id,
                    SessionExecuteRequest(command=line, run_async=False, suppress_input_echo=True),
                    timeout=timeout,
                )
                if response.exit_code is None:
                    raise DaytonaSandboxError("The command did not report an exit code.")
                exit_code = response.exit_code
            except DaytonaProcessExecutionTimeoutError:
                timed_out = True
            except DaytonaConnectionTimeoutError:
                # Daytona session deadlines arrive as connection timeouts (verified live).
                if time.monotonic() - started < timeout - 0.1:
                    raise
                timed_out = True
            finally:
                await run_to_completion(self._delete_session())
            stdout, stderr, out_cut, err_cut = await self._collect()
            return DaytonaSandboxExecResult(
                stdout=stdout,
                stderr=stderr,
                stdout_truncated=out_cut,
                stderr_truncated=err_cut,
                exit_code=exit_code,
                timed_out=timed_out,
                applied_timeout=timeout,
            )
        except DaytonaError as error:
            raise await operation_error(self.sandbox, error, "running the command") from error
        finally:
            if not self.collected:
                await run_to_completion(self._remove_files())

    async def _collect(self) -> tuple[str, str, bool, bool]:
        # Base64 frames arbitrary bytes without delimiter collisions or broken UTF-8.
        script = "; ".join(
            f"if [ -f {path} ]; then wc -c < {path}; "
            f"tail -c {self.max_bytes} {path} | base64 | tr -d '\\n'; "
            f'else printf "0\\n"; fi; printf "\\n"'
            for path in self.paths
        )
        script = f"set -e; {script}; rm -f {' '.join(self.paths)} || :"
        response = await self.sandbox.process.exec(script, timeout=30)
        if response.exit_code != 0:
            raise DaytonaSandboxError("Could not collect the command output.")
        self.collected = True
        try:
            out_size, out, err_size, err = response.result.splitlines()
            sizes = (int(out_size), int(err_size))
            streams = tuple(base64.b64decode(value, validate=True) for value in (out, err))
        except (ValueError, binascii.Error) as error:
            raise DaytonaSandboxError("Invalid command output framing.") from error
        if any(size < 0 for size in sizes) or any(len(data) > self.max_bytes for data in streams):
            raise DaytonaSandboxError("Invalid command output sizes.")
        encoded = [data.decode("utf-8", errors="replace").encode("utf-8") for data in streams]
        return (
            encoded[0][-self.max_bytes :].decode("utf-8", errors="ignore"),
            encoded[1][-self.max_bytes :].decode("utf-8", errors="ignore"),
            sizes[0] > self.max_bytes or len(encoded[0]) > self.max_bytes,
            sizes[1] > self.max_bytes or len(encoded[1]) > self.max_bytes,
        )

    async def _delete_session(self) -> None:
        try:
            await self.sandbox.process.delete_session(self.session_id, request_timeout=30)
        except DaytonaError as error:
            logger.warning("Could not delete Daytona process session %s: %s", self.session_id, error)

    async def _remove_files(self) -> None:
        try:
            await self.sandbox.process.exec(f"rm -f {' '.join(self.paths)}", timeout=30)
        except DaytonaError:
            # Only scratch files in the sandbox are left behind on cleanup failure.
            return
