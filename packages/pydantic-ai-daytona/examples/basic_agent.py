"""Minimal agent with a per-run Daytona sandbox.

Requires DAYTONA_API_KEY and an LLM provider key (here ANTHROPIC_API_KEY).
"""

from pydantic_ai import Agent

from pydantic_ai_daytona import DaytonaSandbox

agent = Agent(
    "anthropic:claude-sonnet-4-6",
    capabilities=[DaytonaSandbox()],
)


def main() -> None:
    result = agent.run_sync(
        "Write a Python script that prints the first 10 prime numbers, run it, "
        "and report the output."
    )
    print(result.output)


if __name__ == "__main__":
    main()
