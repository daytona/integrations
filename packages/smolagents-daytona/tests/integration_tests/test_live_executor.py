"""Live integration tests against a real Daytona backend (needs DAYTONA_API_KEY)."""

import io
import os
from textwrap import dedent

import pytest
from rich.console import Console
from smolagents import AgentError, AgentLogger, FinalAnswerTool, LogLevel

from smolagents_daytona import DaytonaExecutor

pytestmark = pytest.mark.skipif(
    not os.environ.get("DAYTONA_API_KEY"),
    reason="DAYTONA_API_KEY not set; these tests require a live Daytona backend",
)


def make_logger() -> AgentLogger:
    return AgentLogger(LogLevel.INFO, Console(force_terminal=False, file=io.StringIO()))


# One sandbox is shared across this module's tests to keep the suite fast and cheap;
# `additional_imports` exercises the plain-Python `install_packages` default live.
@pytest.fixture(scope="module")
def executor():
    executor = DaytonaExecutor(additional_imports=["numpy"], logger=make_logger())
    yield executor
    executor.cleanup()


class TestLiveExecution:
    def test_basic_execution(self, executor):
        code_output = executor("a = 2 + 2; print(f'Result: {a}')")
        assert "Result: 4" in code_output.logs

    def test_state_persists_between_executions(self, executor):
        executor("import numpy as np; a = 2")
        code_output = executor("print(np.sqrt(a))")
        assert "1.41421" in code_output.logs

    def test_installed_package_is_importable(self, executor):
        code_output = executor("import numpy; print(numpy.__version__)")
        assert code_output.logs.strip()

    def test_final_answer(self, executor):
        executor.send_tools({"final_answer": FinalAnswerTool()})
        code_output = executor('final_answer("This is the final answer")')
        assert code_output.is_final_answer is True
        assert code_output.output == "This is the final answer"

    def test_runtime_error_raises_agent_error(self, executor):
        with pytest.raises(AgentError) as excinfo:
            executor("1/0")
        assert "ZeroDivisionError" in str(excinfo.value)

    def test_syntax_error_raises_agent_error(self, executor):
        with pytest.raises(AgentError) as excinfo:
            executor('print("Missing parenthesis')
        assert "SyntaxError" in str(excinfo.value)

    @pytest.mark.parametrize(
        "code_action, expected_result",
        [
            (
                dedent('''
                    final_answer("""This is
                    a multiline
                    final answer""")
                '''),
                "This is\na multiline\nfinal answer",
            ),
            (
                dedent("""
                    text = '''Text containing
                    final_answer(5)
                    '''
                    final_answer(text)
                """),
                "Text containing\nfinal_answer(5)\n",
            ),
            (
                dedent("""
                    num = 2
                    if num == 1:
                        final_answer("One")
                    elif num == 2:
                        final_answer("Two")
                """),
                "Two",
            ),
        ],
    )
    def test_final_answer_patterns(self, executor, code_action, expected_result):
        executor.send_tools({"final_answer": FinalAnswerTool()})
        code_output = executor(code_action)
        assert code_output.is_final_answer is True
        assert code_output.output == expected_result

    def test_custom_final_answer_tool(self, executor):
        class CustomFinalAnswerTool(FinalAnswerTool):
            def forward(self, answer: str) -> str:
                return "CUSTOM" + answer

        executor.send_tools({"final_answer": CustomFinalAnswerTool()})
        code_output = executor('final_answer(answer="_answer")')
        assert code_output.is_final_answer is True
        assert code_output.output == "CUSTOM_answer"

    def test_custom_final_answer_tool_with_custom_inputs(self, executor):
        class CustomFinalAnswerToolWithCustomInputs(FinalAnswerTool):
            inputs = {
                "answer1": {"type": "string", "description": "First part of the answer."},
                "answer2": {"type": "string", "description": "Second part of the answer."},
            }

            def forward(self, answer1: str, answer2: str) -> str:
                return answer1 + "CUSTOM" + answer2

        executor.send_tools({"final_answer": CustomFinalAnswerToolWithCustomInputs()})
        code_output = executor(
            dedent("""
                final_answer(
                    answer1="answer1_",
                    answer2="_answer2"
                )
            """)
        )
        assert code_output.is_final_answer is True
        assert code_output.output == "answer1_CUSTOM_answer2"


class TestLiveEntryPointDiscovery:
    def test_code_agent_runs_code_in_daytona_through_entry_point(self):
        """End-to-end: entry-point discovery, real sandbox, final answer, cleanup.

        Uses the agent as a context manager, the exact usage documented in the
        README: `CodeAgent.__exit__` calls `cleanup()`, which releases the sandbox.
        """
        from unittest.mock import MagicMock

        from smolagents import CodeAgent

        with CodeAgent(tools=[], model=MagicMock(), executor_type="daytona") as agent:
            assert isinstance(agent.python_executor, DaytonaExecutor)
            agent.python_executor.send_tools({"final_answer": FinalAnswerTool()})
            code_output = agent.python_executor('final_answer(f"result: {6 * 7}")')
            assert code_output.is_final_answer is True
            assert code_output.output == "result: 42"
