"""Daytona sandboxes for Scale AI's AgentEnv framework.

Installing this package registers the ``daytona`` sandbox provider through the
``agent_env.sandbox_providers`` entry point; select it with ``--sandbox daytona``.
"""

from agentenv_daytona.provider import DaytonaSandboxProvider
from agentenv_daytona.sandbox import DaytonaSandbox

__all__ = ["DaytonaSandbox", "DaytonaSandboxProvider"]
