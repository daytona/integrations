"""In-memory stand-ins for the parts of the Daytona async SDK the provider uses.

Each fake records the calls it receives and answers from scriptable state, so tests assert on what
the provider sent and what it did with the answers, without a network.
"""

from __future__ import annotations

import asyncio
import itertools
import shlex
from dataclasses import dataclass, field
from typing import Any, Callable

from daytona import DaytonaNotFoundError

# (exit_code, stdout, stderr), or an exception to raise, for one session command.
Outcome = tuple[int | None, str, str] | BaseException
Handler = Callable[[list[str]], Outcome]


def argv_of(command: str) -> list[str]:
    """The argv a ``bash -c <quoted>`` session command runs."""
    words = shlex.split(command)
    assert words[:2] == ["bash", "-c"], command
    return shlex.split(words[2])


@dataclass
class _Response:
    exit_code: int | None
    stdout: str | None
    stderr: str | None
    cmd_id: str = "cmd"


@dataclass
class FakeProcess:
    """Sessions run ``handler`` on each command's argv; default: exit 0, no output."""

    handler: Handler = lambda argv: (0, "", "")
    commands: list[list[str]] = field(default_factory=list)
    open_sessions: set[str] = field(default_factory=set)
    deleted_sessions: list[str] = field(default_factory=list)

    async def create_session(self, session_id: str, request_timeout: float | None = None) -> None:
        self.open_sessions.add(session_id)

    async def execute_session_command(
        self, session_id: str, req: Any, timeout: int | None = None
    ) -> _Response:
        assert session_id in self.open_sessions
        argv = argv_of(req.command)
        self.commands.append(argv)
        outcome = self.handler(argv)
        if isinstance(outcome, BaseException):
            raise outcome
        code, out, err = outcome
        return _Response(code, out, err)

    async def delete_session(self, session_id: str, request_timeout: float | None = None) -> None:
        self.open_sessions.discard(session_id)
        self.deleted_sessions.append(session_id)


@dataclass
class FakeFs:
    files: dict[str, bytes] = field(default_factory=dict)
    fail_on: Callable[[str], BaseException | None] = lambda path: None

    async def upload_file(self, file: bytes, remote_path: str, timeout: int = 1800) -> None:
        if (error := self.fail_on(remote_path)) is not None:
            raise error
        self.files[remote_path] = file


_ids = itertools.count(1)


@dataclass
class FakeRaw:
    """A Daytona ``AsyncSandbox``."""

    id: str = field(default_factory=lambda: f"sb-{next(_ids)}")
    name: str = ""
    labels: dict[str, str] = field(default_factory=dict)
    state: str = "started"
    desired_state: str = "started"
    domain_allow_list: str | None = None
    network_allow_list: str | None = None
    network_block_all: bool = False
    preview_domain: str = "proxy-x.example"
    cpu: int = 2
    memory: int = 4
    disk: int = 10
    process: FakeProcess = field(default_factory=FakeProcess)
    fs: FakeFs = field(default_factory=FakeFs)
    deletes: int = 0
    network_updates: list[dict[str, Any]] = field(default_factory=list)
    delete_error: BaseException | None = None
    # Raised by the next deletes, one each, before they succeed.
    delete_failures: list[BaseException] = field(default_factory=list)
    # Raised by the next network updates, one each, before they succeed.
    network_update_failures: list[BaseException] = field(default_factory=list)
    # When set, a delete waits for it before doing anything.
    delete_gate: asyncio.Event | None = None

    async def delete(self, timeout: float | None = 60, wait: bool = False) -> None:
        if self.delete_gate is not None:
            await self.delete_gate.wait()
        self.deletes += 1
        if self.delete_failures:
            raise self.delete_failures.pop(0)
        if self.delete_error is not None:
            raise self.delete_error
        self.state = self.desired_state = "destroyed"

    async def get_preview_link(self, port: int, request_timeout: float | None = None) -> Any:
        return _Preview(url=f"https://{port}-{self.id}.{self.preview_domain}", token="tok")

    async def update_network_settings(self, **fields: Any) -> None:
        if self.network_update_failures:
            raise self.network_update_failures.pop(0)
        self.network_updates.append(fields)
        self.network_block_all = bool(fields.get("network_block_all"))
        self.domain_allow_list = fields.get("domain_allow_list") or None
        self.network_allow_list = fields.get("network_allow_list") or None

    async def refresh_data(self) -> None:
        return None


@dataclass
class _Preview:
    url: str
    token: str


@dataclass
class FakeDaytona:
    """An ``AsyncDaytona``. ``create_hook`` may raise, sleep or mutate before a create returns."""

    sandboxes: dict[str, FakeRaw] = field(default_factory=dict)
    created_params: list[Any] = field(default_factory=list)
    create_timeouts: list[float] = field(default_factory=list)
    create_hook: Callable[[Any, FakeRaw], Any] | None = None
    closed: bool = False
    lookups: list[str] = field(default_factory=list)
    make_raw: Callable[[], FakeRaw] = FakeRaw

    async def create(
        self, params: Any = None, *, timeout: float = 60, on_snapshot_create_logs: Any = None
    ) -> FakeRaw:
        self.created_params.append(params)
        self.create_timeouts.append(timeout)
        raw = self.make_raw()
        raw.name = params.name or ""
        raw.labels = dict(params.labels or {})
        raw.domain_allow_list = params.domain_allow_list
        raw.network_allow_list = params.network_allow_list
        raw.network_block_all = bool(params.network_block_all)
        if self.create_hook is not None:
            result = self.create_hook(params, raw)
            if asyncio.iscoroutine(result):
                await result
        self.sandboxes[raw.id] = raw
        return raw

    async def get(self, sandbox_id_or_name: str, request_timeout: float | None = None) -> FakeRaw:
        self.lookups.append(sandbox_id_or_name)
        for raw in self.sandboxes.values():
            if sandbox_id_or_name in (raw.id, raw.name) and raw.state != "destroyed":
                return raw
        raise DaytonaNotFoundError(f"Sandbox with ID or name {sandbox_id_or_name} not found")

    async def close(self) -> None:
        self.closed = True
