from pydantic_ai_daytona._session import DaytonaSandboxExecResult
from pydantic_ai_daytona._tool_output import render_command_result


def test_timeout_keeps_bounded_partial_streams() -> None:
    result = DaytonaSandboxExecResult(
        stdout="before",
        stderr="warn",
        exit_code=-1,
        timed_out=True,
        applied_timeout=1,
        stdout_truncated=True,
    )
    output = render_command_result(result, max_lines=2000, max_bytes=6)
    assert output == (
        "[stdout]\n[... output truncated to the last 6B ...]\nbefore\n"
        "[stderr]\nwarn\n[timed out after 1s]"
    )
