import os
from typing import Type

from langchain_tests.unit_tests import ToolsUnitTests  # type: ignore

from langchain_daytona_data_analysis.tools import DaytonaDataAnalysisTool


class TestDaytonaDataAnalysisToolUnit(ToolsUnitTests):
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
        assert "print(x)" in result

    def test_add_last_line_print_leaves_print_unchanged(self, tool: DaytonaDataAnalysisTool) -> None:
        code = "x = 5\nprint(x)"
        result = tool._add_last_line_print(code)
        assert result.strip().endswith("print(x)")
