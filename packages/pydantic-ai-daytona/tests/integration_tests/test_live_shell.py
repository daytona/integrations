import pytest

from pydantic_ai_daytona import DaytonaSandboxSession
from .test_live_sandbox import backend as backend
from .test_live_sandbox import pytestmark as pytestmark
from .test_live_sandbox import session as session


async def test_command_contract_when_sh_is_forced(
    session: DaytonaSandboxSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Given the default live sandbox, with an attached session forced onto sh internally.
    value = "spaces 'single' \"double\" $HOME\nsecond line; $(printf injected)"
    async with DaytonaSandboxSession(
        sandbox_id=session.sandbox_id, env={"SH_VALUE": value}
    ) as attached:
        monkeypatch.setattr(attached, "_shell", "/bin/sh")
        # When commands exercise normal execution, timeout, then bare exit on that shell.
        normal = await attached.exec(
            "cat; printf '%s' \"$SH_VALUE\"; printf warning >&2; exit 23", timeout=5
        )
        partial = await attached.exec(
            "printf discarded-stdout; printf discarded-stderr >&2; sleep 30",
            timeout=1,
            max_output_bytes=6,
        )
        bare_exit = await attached.exec("exit 7", timeout=5)
    # Then stdin is closed, env is literal, streams stay separate, and statuses stay exact.
    assert (normal.stdout, normal.stderr, normal.exit_code) == (value, "warning", 23)
    assert not normal.timed_out
    assert (partial.stdout, partial.stderr, partial.exit_code) == ("stdout", "stderr", -1)
    assert partial.timed_out
    assert partial.stdout_truncated and partial.stderr_truncated
    assert (bare_exit.stdout, bare_exit.stderr, bare_exit.exit_code) == ("", "", 7)
    assert not bare_exit.timed_out
