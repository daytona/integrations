"""Daytona Plugin for Google ADK.

This plugin provides tools for code execution in Daytona sandboxed environments,
with lifecycle hooks for monitoring and customization.
"""

import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, Optional

import anyio
from google.adk.agents.base_agent import BaseAgent
from google.adk.agents.callback_context import CallbackContext
from google.adk.plugins import BasePlugin
from google.adk.tools import BaseTool, ToolContext
from google.genai import types

from daytona import Daytona, DaytonaConfig
from daytona.v2 import LifecyclePolicyConfig, Sandbox, SandboxNotRunningError

from daytona_adk.tools import (
    ExecuteCodeTool,
    ExecuteCommandTool,
    UploadFileTool,
    ReadFileTool,
    StartLongRunningCommandTool,
)

logger = logging.getLogger(__name__)


class DaytonaPlugin(BasePlugin):
    """Plugin for code execution in Daytona development environments.

    Provides tools and lifecycle hooks for ADK agents:
    - Execute Python, TypeScript, and JavaScript code
    - Run shell commands and scripts
    - Upload and read files
    - Start and manage long-running processes

    The sandbox is created once during plugin initialization and shared across
    all tools for efficiency and state persistence.

    Args:
        api_key: Optional API key for Daytona authentication.
        plugin_name: Name identifier for this plugin instance.
        sandbox_name: Optional name for the sandbox.
        env_vars: Optional environment variables for the sandbox.
        labels: Optional custom labels for the sandbox.
        auto_stop_interval: Idle minutes before deletion on v2; 0 disables idle expiry.
        auto_delete_interval: Wall-clock lifetime in minutes on v2; nonpositive values inherit defaults.
        image: Registered v2 image name or ID; None uses the project's default image.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        plugin_name: str = "daytona_plugin",
        sandbox_name: Optional[str] = None,
        env_vars: Optional[Dict[str, str]] = None,
        labels: Optional[Dict[str, str]] = None,
        auto_stop_interval: Optional[int] = None,
        auto_delete_interval: Optional[int] = None,
        image: str | None = None,
    ):
        super().__init__(name=plugin_name)
        self._daytona = Daytona(DaytonaConfig(api_key=api_key))

        # v2 create is ephemeral: idle expiry deletes rather than stopping.
        # A stopped-sandbox deletion interval has no equivalent; positive values
        # become a wall-clock lifetime. Omitted/disabled values inherit v2 defaults.
        policy: LifecyclePolicyConfig = {}
        if auto_stop_interval is not None:
            policy["idle_expiry_seconds"] = auto_stop_interval * 60 if auto_stop_interval > 0 else -1
            if auto_stop_interval > 0:
                policy["on_idle_timeout"] = "delete"
        if auto_delete_interval is not None and auto_delete_interval > 0:
            policy["timeout_seconds"] = auto_delete_interval * 60
            policy["on_timeout"] = "delete"
        # The public constructor stays synchronous, including inside ADK async apps.
        with ThreadPoolExecutor(max_workers=1) as worker:
            self._sandbox: Sandbox | None = worker.submit(
                self._daytona.v2.create, image, name=sandbox_name, env=env_vars,
                labels=labels, lifecycle_policy=policy or None,
            ).result()
        logger.debug(f"Daytona sandbox created: {self._sandbox.id}")

    def get_tools(self) -> list[BaseTool]:
        """Get all Daytona tools with shared sandbox instance."""
        sandbox = self._sandbox
        if sandbox is None:
            raise SandboxNotRunningError("Plugin sandbox has been deleted")
        tools: list[BaseTool] = [
            ExecuteCodeTool(sandbox),
            ExecuteCommandTool(sandbox),
            UploadFileTool(sandbox),
            ReadFileTool(sandbox),
            StartLongRunningCommandTool(sandbox),
        ]
        return tools

    async def before_agent_callback(
        self,
        *,
        agent: BaseAgent,
        callback_context: CallbackContext,
    ) -> Optional[types.Content]:
        """Called before the agent starts processing."""
        return None

    async def after_agent_callback(
        self,
        *,
        agent: BaseAgent,
        callback_context: CallbackContext,
    ) -> Optional[types.Content]:
        """Called after the agent finishes processing."""
        return None

    async def before_tool_callback(
        self,
        *,
        tool: BaseTool,
        tool_args: Dict[str, Any],
        tool_context: ToolContext,
    ) -> Optional[Dict[str, Any]]:
        """Called before a tool is executed."""
        logger.debug(f"Before tool: {tool.name}")
        return None

    async def after_tool_callback(
        self,
        *,
        tool: BaseTool,
        tool_args: Dict[str, Any],
        tool_context: ToolContext,
        result: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        """Called after a tool is executed."""
        logger.debug(f"After tool: {tool.name}")
        if "error" in result:
            logger.warning(f"Tool {tool.name} returned error: {result['error']}")
        return None

    async def on_tool_error_callback(
        self,
        *,
        tool: BaseTool,
        tool_args: Dict[str, Any],
        tool_context: ToolContext,
        error: Exception,
    ) -> Optional[Dict[str, Any]]:
        """Called when a tool raises an uncaught exception."""
        logger.error(f"Tool {tool.name} raised uncaught exception: {error}")
        return None

    def destroy_sandbox(self) -> None:
        """Destroy the Daytona sandbox."""
        if self._sandbox:
            try:
                logger.info("Deleting Daytona sandbox...")
                self._daytona.v2.delete(self._sandbox)
                self._sandbox = None
                logger.info("Daytona sandbox deleted.")
            except Exception as e:
                logger.error(f"Error deleting Daytona sandbox: {e}")

    async def close(self) -> None:
        """Clean up the Daytona sandbox."""
        with anyio.CancelScope(shield=True):
            await anyio.to_thread.run_sync(self.destroy_sandbox)
