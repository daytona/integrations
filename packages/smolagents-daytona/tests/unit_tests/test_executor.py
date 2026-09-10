"""Offline unit tests for DaytonaExecutor (the Daytona SDK is mocked throughout)."""

from unittest.mock import MagicMock, patch

import pytest
from smolagents import AgentError, CodeOutput, FinalAnswerTool

from smolagents_daytona import DaytonaExecutor


def make_executor(logger=None, **kwargs):
    """Build a DaytonaExecutor with a fully mocked Daytona SDK.

    Returns the executor together with the SDK mocks so tests can assert on them.
    """
    logger = logger if logger is not None else MagicMock()
    with patch("smolagents_daytona._executor.Daytona") as daytona_cls:
        daytona = MagicMock()
        sandbox = MagicMock()
        context = MagicMock()
        daytona.create.return_value = sandbox
        sandbox.code_interpreter.create_context.return_value = context
        daytona_cls.return_value = daytona
        executor = DaytonaExecutor(additional_imports=[], logger=logger, **kwargs)
    return executor, daytona, sandbox, context


def make_run_result(stdout="", stderr="", error=None):
    result = MagicMock()
    result.stdout = stdout
    result.stderr = stderr
    result.error = error
    return result


def make_error(name, value, traceback="Traceback ..."):
    error = MagicMock()
    error.name = name
    error.value = value
    error.traceback = traceback
    return error


class TestInstantiation:
    def test_wires_sandbox_and_context(self):
        logger = MagicMock()
        executor, daytona, sandbox, context = make_executor(logger=logger)

        assert executor.logger is logger
        assert executor.sandbox is sandbox
        assert executor.context is context
        daytona.create.assert_called_once_with()
        sandbox.code_interpreter.create_context.assert_called_once_with()

    def test_forwards_kwargs_to_sandbox_creation(self):
        params = MagicMock()
        executor, daytona, _, _ = make_executor(params=params, timeout=120)

        daytona.create.assert_called_once_with(params=params, timeout=120)

    def test_releases_sandbox_when_initialization_fails_after_creation(self):
        """A failure after the sandbox exists must not leak the remote resource."""
        with patch("smolagents_daytona._executor.Daytona") as daytona_cls:
            daytona = MagicMock()
            sandbox = MagicMock()
            daytona.create.return_value = sandbox
            sandbox.code_interpreter.create_context.side_effect = RuntimeError("interpreter down")
            daytona_cls.return_value = daytona

            with pytest.raises(RuntimeError, match="interpreter down"):
                DaytonaExecutor(additional_imports=[], logger=MagicMock())

            sandbox.delete.assert_called_once_with()


class TestRunCode:
    def test_success_returns_output_and_logs(self):
        executor, _, sandbox, context = make_executor()
        sandbox.code_interpreter.run_code.return_value = make_run_result(stdout="hello world")

        output = executor.run_code_raise_errors("print('hello world')")

        assert output.output == "hello world"
        assert output.logs == "hello world"
        assert output.is_final_answer is False
        sandbox.code_interpreter.run_code.assert_called_once_with(
            "print('hello world')", context=context
        )

    def test_stderr_is_merged_into_logs(self):
        executor, _, sandbox, _ = make_executor()
        sandbox.code_interpreter.run_code.return_value = make_run_result(
            stdout="out", stderr="warning: something"
        )

        output = executor.run_code_raise_errors("code")

        assert "out" in output.logs
        assert "warning: something" in output.logs

    def test_execution_error_raises_agent_error(self):
        executor, _, sandbox, _ = make_executor()
        sandbox.code_interpreter.run_code.return_value = make_run_result(
            error=make_error("ZeroDivisionError", "division by zero")
        )

        with pytest.raises(AgentError) as excinfo:
            executor.run_code_raise_errors("1/0")

        assert "ZeroDivisionError" in str(excinfo.value)
        assert "division by zero" in str(excinfo.value)

    def test_final_answer_exception_returns_final_answer(self):
        executor, _, sandbox, _ = make_executor()
        sandbox.code_interpreter.run_code.return_value = make_run_result(
            error=make_error("FinalAnswerException", 'safe:"the answer"')
        )

        output = executor.run_code_raise_errors("final_answer('the answer')")

        assert output.is_final_answer is True
        assert output.output == "the answer"


class TestCleanup:
    def test_cleanup_deletes_sandbox(self):
        executor, _, sandbox, _ = make_executor()

        executor.cleanup()

        sandbox.delete.assert_called_once_with()
        assert not hasattr(executor, "sandbox")

    def test_cleanup_is_idempotent(self):
        executor, _, sandbox, _ = make_executor()

        executor.cleanup()
        executor.cleanup()

        sandbox.delete.assert_called_once_with()

    def test_cleanup_swallows_provider_errors(self):
        executor, _, sandbox, _ = make_executor()
        sandbox.delete.side_effect = RuntimeError("already gone")

        executor.cleanup()  # must not raise


class TestSmolagentsContract:
    """Validates this package against the public smolagents executor contract."""

    def test_final_answer_exception_base_renders_exception_subclass(self):
        """`FINAL_ANSWER_EXCEPTION_BASE = "Exception"` must reach the generated source.

        Daytona's interpreter only reports `Exception` subclasses in structured
        errors, so the final-answer exception shipped to the sandbox must derive
        from `Exception`, not `BaseException`.
        """
        executor, _, _, _ = make_executor()
        executor.run_code_raise_errors = MagicMock(
            return_value=CodeOutput(output=None, logs="", is_final_answer=False)
        )
        tool = FinalAnswerTool()

        executor.send_tools({"final_answer": tool})

        assert "class FinalAnswerException(Exception):" in tool.forward.__source__
        sent_code = executor.run_code_raise_errors.call_args.args[0]
        assert "class FinalAnswerException(Exception):" in sent_code

    def test_install_packages_repairs_user_site_visibility(self):
        """Packages must be importable by the live interpreter, not just pip-installed.

        Daytona sandboxes have a non-writable system site-packages: pip silently
        falls back to a user-site install (exit code 0), and the long-running
        interpreter does not have that directory on its `sys.path`. The override
        runs a plain pip install and then exposes user-site to the live context.
        """
        executor, _, _, _ = make_executor()
        executor.run_code_raise_errors = MagicMock(
            return_value=CodeOutput(output=None, logs="installed", is_final_answer=False)
        )

        installed = executor.install_packages(["numpy", "emoji"])

        assert installed == ["numpy", "emoji"]
        sent_code = executor.run_code_raise_errors.call_args.args[0]
        assert "sys.executable" in sent_code
        assert "site.getusersitepackages()" in sent_code
        # User site must be inserted before system site-packages (mirroring site.py
        # startup ordering), not appended, so requested versions shadow preinstalled.
        assert "sys.path.insert" in sent_code
        assert "getsitepackages" in sent_code
        assert "sys.path.append" not in sent_code
        assert "importlib.invalidate_caches()" in sent_code
        assert "!pip" not in sent_code

    def test_install_packages_propagates_agent_error(self):
        executor, _, _, _ = make_executor()
        executor.run_code_raise_errors = MagicMock(
            side_effect=AgentError("installation failed", executor.logger)
        )

        with pytest.raises(AgentError, match="installation failed"):
            executor.install_packages(["numpy"])

    def test_entry_point_resolves_to_executor(self):
        """The installed distribution must register the `daytona` executor type."""
        from importlib import metadata

        entry_points = [
            entry_point
            for entry_point in metadata.entry_points(group="smolagents.executors")
            if entry_point.name == "daytona"
        ]

        assert len(entry_points) == 1
        assert entry_points[0].load() is DaytonaExecutor

    def test_code_agent_creates_executor_through_entry_point(self):
        """End-to-end offline: `executor_type="daytona"` resolves through smolagents."""
        from smolagents import CodeAgent

        with patch("smolagents_daytona._executor.Daytona") as daytona_cls:
            daytona = MagicMock()
            sandbox = MagicMock()
            daytona.create.return_value = sandbox
            sandbox.code_interpreter.create_context.return_value = MagicMock()
            daytona_cls.return_value = daytona

            agent = CodeAgent(tools=[], model=MagicMock(), executor_type="daytona")

            assert isinstance(agent.python_executor, DaytonaExecutor)
            agent.cleanup()
            sandbox.delete.assert_called_once_with()
