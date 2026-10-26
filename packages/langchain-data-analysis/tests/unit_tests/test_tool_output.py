from typing import Any, Iterator, List
from unittest.mock import MagicMock, Mock, patch

import pytest  # type: ignore
from daytona import Chart, ExecuteResponse, ExecutionArtifacts  # type: ignore
from langchain_core.messages import ToolMessage

from langchain_daytona_data_analysis.tools import DaytonaDataAnalysisTool

PNG_BASE64 = "iVBORw0KGgo" + "A" * 2_000_000


@pytest.fixture
def sandbox() -> Iterator[MagicMock]:
    with patch("langchain_daytona_data_analysis.tools.Daytona") as daytona:
        yield daytona.return_value.create.return_value


def _respond(
    sandbox: MagicMock, stdout: str, charts: List[Chart], exit_code: int = 0
) -> ExecutionArtifacts:
    artifacts = ExecutionArtifacts(stdout=stdout, charts=charts)
    sandbox.process.code_run.return_value = ExecuteResponse(
        exit_code=exit_code, result=stdout, artifacts=artifacts
    )
    return artifacts


def _tool_call(tool: DaytonaDataAnalysisTool) -> Any:
    return tool.invoke(
        {
            "args": {"data_analysis_python_code": "print('done')"},
            "id": "call-1",
            "name": tool.name,
            "type": "tool_call",
        }
    )


def test_chart_image_data_stays_out_of_model_content(sandbox: MagicMock) -> None:
    scatter = Chart.model_validate({"type": "scatter", "title": "50k points", "png": PNG_BASE64})
    trend = Chart.model_validate({"type": "unknown", "png": PNG_BASE64})
    artifacts = _respond(sandbox, "done\n", [scatter, trend])
    on_result = Mock()
    tool = DaytonaDataAnalysisTool(daytona_api_key="test-key", on_result=on_result)

    message = _tool_call(tool)

    assert isinstance(message, ToolMessage)
    assert message.content == (
        "done\n\n"
        "Generated 2 chart(s). The image data was passed to the application "
        "and is not included here:\n"
        "- scatter: 50k points\n"
        "- chart: untitled"
    )
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
    assert "\n... [9908 characters truncated] ...\n" in content
    assert len(content) < 200
    assert artifacts is not None and len(artifacts.stdout) == 10_008


def test_failed_run_output_is_bounded(sandbox: MagicMock) -> None:
    traceback = "row\n" * 5_000 + "ZeroDivisionError: division by zero\n"
    _respond(sandbox, traceback, [], exit_code=1)
    tool = DaytonaDataAnalysisTool(daytona_api_key="test-key", max_output_chars=200)

    content, _ = tool._run("print(df); 1 / 0")

    assert content.startswith("Python code execution exited with code 1\nResult: row")
    assert content.endswith("ZeroDivisionError: division by zero\n")
    assert len(content) < 400


def test_max_output_chars_must_be_positive(sandbox: MagicMock) -> None:
    with pytest.raises(ValueError):
        DaytonaDataAnalysisTool(daytona_api_key="test-key", max_output_chars=0)
