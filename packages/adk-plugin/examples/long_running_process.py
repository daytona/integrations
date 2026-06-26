"""Example: Start and manage long-running processes.

This example demonstrates starting a long-running HTTP server in the background
and verifying it's running.

Requirements:
    - DAYTONA_API_KEY environment variable set
    - GOOGLE_API_KEY environment variable set
"""

import asyncio
from google.adk.agents import Agent
from google.adk.runners import InMemoryRunner
from daytona_adk import DaytonaPlugin


async def main() -> None:
    """Start a long-running HTTP server and verify it's running."""
    plugin = DaytonaPlugin()

    agent = Agent(
        model="gemini-2.0-flash",
        name="process_manager",
        tools=plugin.get_tools(),
    )

    async with InMemoryRunner(
        app_name="long_running_process_example",
        agent=agent,
        plugins=[plugin],
    ) as runner:
        # Start HTTP server
        print("\n" + "=" * 60)
        print("Starting Long-Running HTTP Server")
        print("=" * 60)
        response = await runner.run_debug(
            "Start a long-running command: python -m http.server 8000"
        )
        print(f"Response: {response}\n")

        # Verify server is running
        print("\n" + "=" * 60)
        print("Verifying Server is Running")
        print("=" * 60)
        response = await runner.run_debug(
            "Check if the HTTP server is running by executing: curl -s http://localhost:8000 | head -n 5"
        )
        print(f"Response: {response}\n")

        # Check process list
        print("\n" + "=" * 60)
        print("Checking Process List")
        print("=" * 60)
        response = await runner.run_debug(
            "Run command to show Python processes: ps aux | grep 'python -m http.server'"
        )
        print(f"Response: {response}\n")

    print("\nLong-running process example completed!")


if __name__ == "__main__":
    asyncio.run(main())
