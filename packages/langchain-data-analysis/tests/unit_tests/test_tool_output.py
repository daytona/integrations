from typing import Iterator, List
from unittest.mock import MagicMock, Mock, patch

import pytest  # type: ignore
from daytona.v2 import (
    InterpreterError,
    InterpreterLogs,
    InterpreterOutput,
    InterpreterProcess,
    InterpreterResult,
)
from langchain_core.messages import ToolMessage

from langchain_daytona_data_analysis.tools import DaytonaDataAnalysisTool

PNG_BASE64 = "iVBORw0KGgo" + "A" * 2_000_000


@pytest.fixture
def sandbox() -> Iterator[MagicMock]:
    with patch("langchain_daytona_data_analysis.tools.Daytona") as daytona:
        yield daytona.return_value.v2.create.return_value


def _respond(
    sandbox: MagicMock, stdout: str, charts: List[InterpreterOutput]
) -> InterpreterResult:
    result = InterpreterResult(
        process=InterpreterProcess(
            process_id="test-process", exit_code=0, signal=None, reason="exited"
        ),
        logs=InterpreterLogs(stdout=stdout),
        results=charts,
    )
    sandbox.run_code.return_value = result
    return result


def _tool_call(tool: DaytonaDataAnalysisTool) -> ToolMessage:
    return tool.invoke(
        {
            "args": {"data_analysis_python_code": "print('done')"},
            "id": "call-1",
            "name": tool.name,
            "type": "tool_call",
        }
    )


def test_chart_image_data_stays_out_of_model_content(sandbox: MagicMock) -> None:
    # Given: a real v2 result with a large MIME-keyed image payload.
    chart = InterpreterOutput(
        data={"image/png": PNG_BASE64}, is_main_result=False, png=PNG_BASE64
    )
    artifacts = _respond(sandbox, "done\n", [chart])
    on_result = Mock()
    tool = DaytonaDataAnalysisTool(daytona_api_key="test-key", on_result=on_result)

    # When: LangChain builds the model-facing ToolMessage.
    message = _tool_call(tool)

    assert isinstance(message, ToolMessage)
    # Then: the image stays application-side, while the model sees its MIME summary.
    assert isinstance(message.content, str)
    assert message.content.startswith("done\n\nGenerated 1 chart(s).")
    assert "image/png" in message.content
    assert PNG_BASE64 not in message.content
    assert len(message.content) < 300
    assert message.artifact is artifacts
    on_result.assert_called_once_with(artifacts)


def test_invoke_with_args_returns_model_text(sandbox: MagicMock) -> None:
    _respond(sandbox, "Hello World\n", [])
    tool = DaytonaDataAnalysisTool(daytona_api_key="test-key")

    assert tool.invoke({"data_analysis_python_code": "print('Hello World')"}) == "Hello World"


def test_run_without_output_says_so(sandbox: MagicMock) -> None:
    _respond(sandbox, "", [])
    tool = DaytonaDataAnalysisTool(daytona_api_key="test-key")

    content, _ = tool._run("x = 1")

    assert content == "Python code executed successfully with no output."


def test_long_output_keeps_beginning_and_end(sandbox: MagicMock) -> None:
    _respond(sandbox, "HEAD" + "x" * 10_000 + "TAIL", [])
    tool = DaytonaDataAnalysisTool(daytona_api_key="test-key", max_output_chars=100)

    content, artifacts = tool._run("print(df)")

    assert content.startswith("HEAD")
    assert content.endswith("TAIL")
    assert "\n... [9946 characters truncated] ...\n" in content
    assert len(content) <= 100
    assert len(artifacts.logs.stdout) == 10_008


@pytest.mark.parametrize("limit", [1, 10, 37, 38, 39, 100, 5_000])
def test_truncation_never_exceeds_max_output_chars(sandbox: MagicMock, limit: int) -> None:
    tool = DaytonaDataAnalysisTool(daytona_api_key="test-key", max_output_chars=limit)

    assert len(tool._truncate("x" * 10_008)) <= limit


def test_failed_run_output_is_bounded(sandbox: MagicMock) -> None:
    traceback = "row\n" * 5_000 + "ZeroDivisionError: division by zero\n"
    sandbox.run_code.return_value = InterpreterResult(
        process=InterpreterProcess(
            process_id="test-error", exit_code=1, signal=None, reason="exited"
        ),
        error=InterpreterError(name="ZeroDivisionError", value="division by zero",
                               traceback=[traceback]),
    )
    tool = DaytonaDataAnalysisTool(daytona_api_key="test-key", max_output_chars=200)

    content, _ = tool._run("print(df); 1 / 0")

    assert content.startswith("Python code execution exited with code 1\nResult: row")
    assert content.endswith("ZeroDivisionError: division by zero\n")
    assert len(content) <= len("Python code execution exited with code 1\nResult: ") + 200


def test_max_output_chars_must_be_positive(sandbox: MagicMock) -> None:
    with pytest.raises(ValueError):
        DaytonaDataAnalysisTool(daytona_api_key="test-key", max_output_chars=0)


def test_interpreter_error_is_reported_when_process_exits_zero(sandbox: MagicMock) -> None:
    # Given: the interpreter reports a Python exception despite a successful runner exit.
    sandbox.run_code.return_value = InterpreterResult(
        process=InterpreterProcess(
            process_id="test-error", exit_code=0, signal=None, reason="exited"
        ),
        error=InterpreterError(name="NameError", value="missing", traceback=["NameError: missing"]),
    )
    callback = Mock()
    tool = DaytonaDataAnalysisTool(daytona_api_key="test-key", on_result=callback)

    # When: the tool executes the failing Python snippet.
    content, result = tool._run("missing")

    # Then: the error is visible, not mistaken for a successful empty result.
    assert "NameError: missing" in content
    assert result.error is not None
    callback.assert_not_called()


def test_default_create_passes_only_the_image() -> None:
    with patch("langchain_daytona_data_analysis.tools.Daytona") as daytona:
        DaytonaDataAnalysisTool(daytona_api_key="test-key", image="img_test")

    daytona.return_value.v2.create.assert_called_once_with("img_test")


def test_create_kwargs_are_forwarded_to_create() -> None:
    options = {"labels": {"team": "data"}, "lifecycle_policy": {"timeout_seconds": 300}}
    with patch("langchain_daytona_data_analysis.tools.Daytona") as daytona:
        DaytonaDataAnalysisTool(daytona_api_key="test-key", create_kwargs=options)

    daytona.return_value.v2.create.assert_called_once_with(
        None, labels={"team": "data"}, lifecycle_policy={"timeout_seconds": 300}
    )
