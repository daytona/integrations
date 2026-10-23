from __future__ import annotations

import json
import shlex
from typing import TYPE_CHECKING

import pytest
from daytona import DaytonaConnectionTimeoutError

from pydantic_ai_daytona import DaytonaSandboxError, DaytonaSandboxSession

if TYPE_CHECKING:
    from tests.unit_tests.conftest import FakeDaytona


@pytest.mark.parametrize("timed_out", [False, True])
async def test_bounded_stream_tails_survive_timeout(sdk: FakeDaytona, timed_out: bool) -> None:
    sdk.sandbox.process.force_timeout = timed_out
    async with DaytonaSandboxSession() as session:
        result = await session.exec(
            "printf 'discarded-stdout'; printf 'discarded-stderr' >&2; exit 7",
            timeout=5,
            max_output_bytes=6,
        )
    assert (result.stdout, result.stderr) == ("stdout", "stderr")
    assert result.stdout_truncated and result.stderr_truncated
    assert result.timed_out is timed_out
    assert result.exit_code == (-1 if timed_out else 7)
    assert sdk.sandbox.process.deleted == sdk.sandbox.process.created
    assert not list(sdk.sandbox.root.glob("pydantic-ai-*"))
    assert len(sdk.sandbox.process.transferred) == 1
    assert sdk.sandbox.process.transferred[0] < 64


@pytest.mark.parametrize("length,cut", [(7, False), (8, False), (9, True)])
async def test_output_cap_boundary(sdk: FakeDaytona, length: int, cut: bool) -> None:
    async with DaytonaSandboxSession() as session:
        result = await session.exec(f"printf {'x' * length}", timeout=5, max_output_bytes=8)
    assert result.stdout == "x" * min(length, 8)
    assert result.stdout_truncated is cut
    assert result.stderr == ""
    assert not result.stderr_truncated


async def test_binary_output_is_framed_without_stream_confusion(sdk: FakeDaytona) -> None:
    async with DaytonaSandboxSession() as session:
        result = await session.exec("printf '\\377\\000\\n'; printf 'err\\n' >&2", timeout=5)
    assert result.stdout == "\ufffd\x00\n"
    assert result.stderr == "err\n"


async def test_decoded_binary_output_still_respects_byte_cap(sdk: FakeDaytona) -> None:
    async with DaytonaSandboxSession() as session:
        result = await session.exec("printf '\\377\\377\\377'", timeout=5, max_output_bytes=3)
    assert result.stdout == "\ufffd"
    assert result.stdout_truncated


async def test_multibyte_tail_respects_byte_cap(sdk: FakeDaytona) -> None:
    async with DaytonaSandboxSession() as session:
        result = await session.exec("printf 'ééé'", timeout=5, max_output_bytes=3)
    assert len(result.stdout.encode()) <= 3
    assert result.stdout.endswith("é")
    assert result.stdout_truncated


async def test_setup_timeout_is_not_a_command_deadline(sdk: FakeDaytona) -> None:
    sdk.sandbox.process.setup_error = DaytonaConnectionTimeoutError("setup")
    async with DaytonaSandboxSession() as session:
        with pytest.raises(DaytonaSandboxError, match="setup"):
            await session.exec("true", timeout=5)


async def test_timeout_before_output_files_exist_returns_no_output(sdk: FakeDaytona) -> None:
    sdk.sandbox.process.execute_error = DaytonaConnectionTimeoutError("deadline")
    async with DaytonaSandboxSession() as session:
        result = await session.exec("true", timeout=5)
    assert result.timed_out
    assert (result.stdout, result.stderr) == ("", "")


async def test_stdin_is_closed(sdk: FakeDaytona) -> None:
    async with DaytonaSandboxSession() as session:
        result = await session.exec("cat", timeout=1)
    assert not result.timed_out
    assert result.exit_code == 0
    assert result.stdout == ""


async def test_attached_commands_get_exact_env(sdk: FakeDaytona) -> None:
    env = {"SPECIAL": "a b'\"$HOME\nlast", "-dashed-name": "literal value"}
    code = (
        "import os,json; print(json.dumps({k:os.environ[k] for k in ['SPECIAL','-dashed-name']}))"
    )
    async with DaytonaSandboxSession(sandbox_id=sdk.sandbox.id, env=env) as session:
        result = await session.exec(f"python3 -c {shlex.quote(code)}", timeout=5)
    assert json.loads(result.stdout) == env
    assert not sdk.sandbox.deleted


async def test_invalid_workdir_returns_shell_failure(sdk: FakeDaytona) -> None:
    async with DaytonaSandboxSession(workdir=str(sdk.sandbox.root / "missing")) as session:
        result = await session.exec("echo must-not-run", timeout=5)
    assert result.exit_code != 0
    assert result.stdout == ""
    assert result.stderr


async def test_resolve_anchors_only_relative_paths(sdk: FakeDaytona) -> None:
    session = DaytonaSandboxSession(workdir="/workspace")
    assert session._resolve("a/../b") == "/workspace/b"
    assert session._resolve("/elsewhere/b") == "/elsewhere/b"
