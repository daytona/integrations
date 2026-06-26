"""Daytona Plugin for Google ADK.

This plugin provides tools for code execution in Daytona sandboxed environments,
with lifecycle hooks for monitoring and customization.
"""

import logging
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

from google.adk.agents.base_agent import BaseAgent
from google.adk.agents.callback_context import CallbackContext
from google.adk.plugins import BasePlugin
from google.adk.tools import BaseTool, ToolContext
from google.genai import types

from daytona import Daytona, DaytonaConfig, CreateSandboxBaseParams  # type: ignore

from daytona_adk.tools import (
    ExecuteCodeTool,
    ExecuteCommandTool,
    UploadFileTool,
    ReadFileTool,
    StartLongRunningCommandTool,
)


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
        auto_stop_interval: Interval in minutes after which sandbox auto-stops. Default is 15. 0 means no auto-stop.
        auto_delete_interval: Interval in minutes after which stopped sandbox auto-deletes. Negative means disabled.
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
    ):
        super().__init__(name=plugin_name)
        self._daytona = Daytona(DaytonaConfig(api_key=api_key))

        # Create sandbox with optional parameters
        params = CreateSandboxBaseParams(
            name=sandbox_name,
            env_vars=env_vars,
            labels=labels,
            auto_stop_interval=auto_stop_interval,
            auto_delete_interval=auto_delete_interval,
        )
        self._sandbox = self._daytona.create(params)
        logger.debug(f"Daytona sandbox created: {self._sandbox.id}")

    def get_tools(self) -> list[BaseTool]:
        """Get all Daytona tools with shared sandbox instance."""
        return [
            ExecuteCodeTool(self._sandbox),
            ExecuteCommandTool(self._sandbox),
            UploadFileTool(self._sandbox),
            ReadFileTool(self._sandbox),
            StartLongRunningCommandTool(self._sandbox),
        ]

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
                self._daytona.delete(self._sandbox)
                self._sandbox = None
                logger.info("Daytona sandbox deleted.")
            except Exception as e:
                logger.error(f"Error deleting Daytona sandbox: {e}")

    async def close(self) -> None:
        """Clean up the Daytona sandbox."""
        self.destroy_sandbox()
