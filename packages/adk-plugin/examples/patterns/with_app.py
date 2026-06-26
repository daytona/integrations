"""Example usage of DaytonaPlugin with Google ADK App.

This example demonstrates how to use the Daytona plugin with the App pattern,
which is the recommended approach for production applications.

Requirements:
    - DAYTONA_API_KEY environment variable set
    - GOOGLE_API_KEY environment variable set
    - ADK Python 1.18 or higher for run_debug()
"""

import asyncio
from google.adk.agents import Agent
from google.adk.apps import App
from google.adk.runners import InMemoryRunner
from daytona_adk import DaytonaPlugin


async def main() -> None:
    """Run the Daytona plugin example with App."""
    # Create plugin with optional configuration
    plugin = DaytonaPlugin(
        sandbox_name="example-sandbox",
        env_vars={"EXAMPLE_VAR": "example_value"},
        labels={"env": "development", "example": "true"},
        auto_stop_interval=30,
        auto_delete_interval=60,
    )

    # Create agent with Daytona tools
    agent = Agent(
        model="gemini-2.0-flash",
        name="agent_with_sandbox",
        tools=plugin.get_tools(),
    )

    # Create app with plugin
    app = App(
        name="daytona_example_app",
        root_agent=agent,
        plugins=[plugin],
    )

    # Use async context manager - automatically calls plugin.close() on exit
    async with InMemoryRunner(app=app) as runner:
        # Example prompts to test different tools
        prompts = [
            "Execute this Python code: print('Hello from Daytona sandbox!')",
            "Run the command 'echo $EXAMPLE_VAR' to check the environment variable",
            "Create a file at /tmp/test.txt with content 'Test content'",
            "Read the file /tmp/test.txt",
        ]

        for prompt in prompts:
            print(f"\n{'=' * 60}")
            print(f"Prompt: {prompt}")
            print("=" * 60)

            # run_debug() requires ADK Python 1.18 or higher
            response = await runner.run_debug(prompt)
            print(f"Response: {response}\n")

    print("\nRunner closed, sandbox cleaned up.")


if __name__ == "__main__":
    asyncio.run(main())
