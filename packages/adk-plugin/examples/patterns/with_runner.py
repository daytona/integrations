"""Example usage of DaytonaPlugin with Google ADK Runner directly.

This example demonstrates how to use the Daytona plugin by passing the agent
directly to the Runner without creating an App.

Requirements:
    - DAYTONA_API_KEY environment variable set
    - GOOGLE_API_KEY environment variable set
    - ADK Python 1.18 or higher for run_debug()
"""

import asyncio
from google.adk.agents import Agent
from google.adk.runners import InMemoryRunner
from daytona_adk import DaytonaPlugin


async def main() -> None:
    """Run the Daytona plugin example with Runner directly."""
    # Create plugin with optional configuration
    plugin = DaytonaPlugin(
        sandbox_name="example-runner-sandbox",
        env_vars={"ENV_TYPE": "development"},
        labels={"test": "runner-example"},
    )

    # Create agent with Daytona tools
    agent = Agent(
        model="gemini-2.0-flash",
        name="agent_with_sandbox",
        tools=plugin.get_tools(),
    )

    # Use async context manager - automatically calls plugin.close() on exit
    async with InMemoryRunner(
        app_name="daytona_example_runner",
        agent=agent,
        plugins=[plugin],
    ) as runner:
        # Example prompts to test different tools
        prompts = [
            "Execute this Python code: import sys; print(f'Python version: {sys.version}')",
            "Run the bash command 'uname -a' to check the system",
            "Execute this JavaScript code: console.log('Hello from Node.js')",
            'Upload a file to /tmp/example.json with content: {"message": "Hello World"}',
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
