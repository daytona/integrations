import io
import os
from contextlib import redirect_stdout
from typing import Iterator, Type
from unittest.mock import MagicMock, patch

import pytest  # type: ignore
from langchain_tests.unit_tests import ToolsUnitTests  # type: ignore

from langchain_daytona_data_analysis.tools import DaytonaDataAnalysisTool


def _run_locally(code: str) -> str:
    output = io.StringIO()
    with redirect_stdout(output):
        exec(code, {})
    return output.getvalue()


class TestDaytonaDataAnalysisToolUnit(ToolsUnitTests):
    @pytest.fixture(autouse=True)
    def mock_daytona_client(self) -> Iterator[MagicMock]:
        with patch(
            "langchain_daytona_data_analysis.tools.Daytona"
        ) as mock_daytona:
            mock_daytona.return_value.create.return_value = MagicMock()
            yield mock_daytona

    @property
    def tool_constructor(self) -> Type[DaytonaDataAnalysisTool]:
        return DaytonaDataAnalysisTool

    @property
    def tool_constructor_params(self) -> dict:
        return { 'daytona_api_key': os.environ.get('DAYTONA_API_KEY', ''),
                 'on_result': None}

    @property
    def tool_invoke_params_example(self) -> dict:
        return { 'data_analysis_python_code': "print('Hello World')"}
    
    def test_add_last_line_print_adds_print(self, tool: DaytonaDataAnalysisTool) -> None:
        code = "x = 5\nx"
        result = tool._add_last_line_print(code)
        assert _run_locally(result) == "5\n"

    def test_add_last_line_print_leaves_print_unchanged(
        self, tool: DaytonaDataAnalysisTool
    ) -> None:
        code = "x = 5\nprint(x)"
        result = tool._add_last_line_print(code)
        assert result.strip().endswith("print(x)")

    def test_add_last_line_print_skips_none_value(
        self, tool: DaytonaDataAnalysisTool
    ) -> None:
        # Same shape as code ending in `plt.show()`, which returns None.
        code = "def show():\n    return None\nprint('real output')\nshow()"
        result = tool._add_last_line_print(code)
        assert _run_locally(result) == "real output\n"

    def test_add_last_line_print_evaluates_expression_once(
        self, tool: DaytonaDataAnalysisTool
    ) -> None:
        code = (
            "calls = []\n"
            "def record():\n"
            "    calls.append(1)\n"
            "    return len(calls)\n"
            "record()"
        )
        result = tool._add_last_line_print(code)
        assert _run_locally(result) == "1\n"

    def test_add_last_line_print_leaves_globals_untouched(
        self, tool: DaytonaDataAnalysisTool
    ) -> None:
        namespace: dict = {}
        with redirect_stdout(io.StringIO()):
            exec(tool._add_last_line_print("x = 1\nx"), namespace)
        assert set(namespace) == {"__builtins__", "x"}

    def test_add_last_line_print_ignores_trailing_statement(
        self, tool: DaytonaDataAnalysisTool
    ) -> None:
        code = "x = 1 + 1\nprint('real output')\ny = x * 2"
        result = tool._add_last_line_print(code)
        assert _run_locally(result) == "real output\n"
