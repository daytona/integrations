"""Example: Execute code in multiple programming languages.

This example demonstrates executing Python, JavaScript, and TypeScript code
in the Daytona sandbox.

Requirements:
    - DAYTONA_API_KEY environment variable set
    - GOOGLE_API_KEY environment variable set
"""

import asyncio
from google.adk.agents import Agent
from google.adk.runners import InMemoryRunner
from daytona_adk import DaytonaPlugin


async def main() -> None:
    """Execute code in Python, JavaScript, and TypeScript."""
    plugin = DaytonaPlugin()

    agent = Agent(
        model="gemini-2.0-flash",
        name="multi_language_executor",
        tools=plugin.get_tools(),
    )

    async with InMemoryRunner(
        app_name="multi_language_example",
        agent=agent,
        plugins=[plugin],
    ) as runner:
        # Python
        print("\n" + "=" * 60)
        print("Testing Python Execution")
        print("=" * 60)
        response = await runner.run_debug(
            "Execute Python code: import sys; print(f'Python {sys.version}')"
        )
        print(f"Response: {response}\n")

        # JavaScript
        print("\n" + "=" * 60)
        print("Testing JavaScript Execution")
        print("=" * 60)
        response = await runner.run_debug(
            "Execute JavaScript: console.log('Hello from Node.js ' + process.version)"
        )
        print(f"Response: {response}\n")

        # TypeScript
        print("\n" + "=" * 60)
        print("Testing TypeScript Execution")
        print("=" * 60)
        response = await runner.run_debug(
            "Execute TypeScript: const msg: string = 'Hello from TypeScript'; console.log(msg)"
        )
        print(f"Response: {response}\n")

    print("\nAll languages executed successfully!")


if __name__ == "__main__":
    asyncio.run(main())
