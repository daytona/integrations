"""Minimal CodeAgent executing its code steps in a Daytona sandbox.

Requires DAYTONA_API_KEY and an LLM provider key (here HF_TOKEN for Inference
Providers). Installing smolagents-daytona is all the wiring needed: the
`executor_type="daytona"` string resolves through the `smolagents.executors`
entry-point group.
"""

from smolagents import CodeAgent, InferenceClientModel


def main() -> None:
    with CodeAgent(
        model=InferenceClientModel(),
        tools=[],
        executor_type="daytona",
    ) as agent:
        result = agent.run("Give me the 100th Fibonacci number.")
    print(result)


if __name__ == "__main__":
    main()
