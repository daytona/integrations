"""Daytona sandbox code executor for smolagents CodeAgents.

`DaytonaExecutor` implements the smolagents remote-executor contract on top of
Daytona sandboxes. Installing this package registers it under the
``smolagents.executors`` entry-point group, so it can be selected with
``CodeAgent(executor_type="daytona")``.
"""

from smolagents_daytona._executor import DaytonaExecutor

__all__ = ["DaytonaExecutor"]
