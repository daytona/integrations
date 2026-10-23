import asyncio
import os
import signal
from pathlib import Path
from types import SimpleNamespace

import pytest
from daytona import DaytonaConnectionTimeoutError, DaytonaError, SandboxState, SessionExecuteRequest


class FakeProcess:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.running: dict[str, asyncio.subprocess.Process] = {}
        self.created: list[str] = []
        self.deleted: list[str] = []
        self.killed: list[str] = []
        self.transferred: list[int] = []
        self.setup_error: DaytonaError | None = None
        self.execute_error: DaytonaError | None = None
        self.force_timeout = False
        self.shell_probe = SimpleNamespace(exit_code=0, result="/bin/bash\n")
        self.shell_probe_error: DaytonaError | None = None
        self.shell_probes = 0
        self.commands: list[str] = []

    async def create_session(self, session_id: str) -> None:
        if self.setup_error:
            raise self.setup_error
        self.created.append(session_id)

    async def execute_session_command(
        self, session_id: str, request: SessionExecuteRequest, *, timeout: int
    ) -> SimpleNamespace:
        self.commands.append(request.command)
        if self.execute_error:
            raise self.execute_error
        process = await self._spawn(request.command)
        self.running[session_id] = process
        try:
            if self.force_timeout:
                await asyncio.wait_for(process.wait(), timeout)
            out, err = await asyncio.wait_for(process.communicate(), timeout)
        except asyncio.TimeoutError:
            raise DaytonaConnectionTimeoutError("command deadline") from None
        return SimpleNamespace(
            exit_code=process.returncode, stdout=out.decode(), stderr=err.decode()
        )

    async def _spawn(self, command: str) -> asyncio.subprocess.Process:
        command = command.replace("/tmp/pydantic-ai-", f"{self.root}/pydantic-ai-")
        return await asyncio.create_subprocess_shell(
            command,
            cwd=self.root,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )

    async def exec(self, command: str, *, timeout: int) -> SimpleNamespace:
        if command == "command -v bash":
            self.shell_probes += 1
            if self.shell_probe_error:
                raise self.shell_probe_error
            return self.shell_probe
        process = await self._spawn(command)
        out, err = await asyncio.wait_for(process.communicate(), timeout)
        self.transferred.append(len(out) + len(err))
        return SimpleNamespace(exit_code=process.returncode, result=out.decode())

    async def delete_session(self, session_id: str, *, request_timeout: float = 30) -> None:
        assert request_timeout == 30
        self.deleted.append(session_id)
        process = self.running.pop(session_id, None)
        if process is not None:
            if process.returncode is None:
                assert process.pid is not None
                os.killpg(process.pid, signal.SIGKILL)
                self.killed.append(session_id)
            await process.wait()


class FakeSandbox:
    def __init__(self, root: Path) -> None:
        self.id = "sb-fake"
        self.root = root
        self.state = SandboxState.STARTED
        self.process = FakeProcess(root)
        self.starts = 0
        self.waits = 0
        self.refreshes = 0
        self.refresh_error: DaytonaError | None = None
        self.deleted = False
        self.delete_error: DaytonaError | None = None
        self.delete_started = asyncio.Event()
        self.delete_release = asyncio.Event()
        self.delete_release.set()

    async def get_work_dir(self) -> str:
        return str(self.root)

    async def start(self, *, timeout: float) -> None:
        self.starts += 1
        self.state = SandboxState.STARTED

    async def wait_for_sandbox_start(self, *, timeout: float) -> None:
        self.waits += 1
        if self.state in (SandboxState.ERROR, SandboxState.BUILD_FAILED):
            raise DaytonaError("sandbox failed to start")
        self.state = SandboxState.STARTED

    async def refresh_data(self, *, request_timeout: int) -> None:
        self.refreshes += 1
        if self.refresh_error:
            raise self.refresh_error

    async def delete(self, *, wait: bool, timeout: float) -> None:
        assert wait
        assert timeout == 60
        self.delete_started.set()
        await self.delete_release.wait()
        if self.delete_error:
            raise self.delete_error
        self.deleted = True


class FakeDaytona:
    def __init__(self, sandbox: FakeSandbox) -> None:
        self.sandbox = sandbox
        self.create_started = asyncio.Event()
        self.create_release = asyncio.Event()
        self.create_release.set()
        self.create_error: DaytonaError | None = None
        self.closed = False

    async def create(self, params: object, *, timeout: float) -> FakeSandbox:
        self.create_started.set()
        await self.create_release.wait()
        if self.create_error:
            raise self.create_error
        return self.sandbox

    async def get(self, sandbox_id: str) -> FakeSandbox:
        return self.sandbox

    async def close(self) -> None:
        self.closed = True


@pytest.fixture
def sdk(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> FakeDaytona:
    client = FakeDaytona(FakeSandbox(tmp_path))
    monkeypatch.setattr("pydantic_ai_daytona._session.AsyncDaytona", lambda config: client)
    return client
