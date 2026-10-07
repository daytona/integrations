"""Run the computer toolset on a Daytona sandbox desktop, driven by the model through the tool runner.

Usage:

    python run_computer.py "Open a terminal, run date, and tell me the output."
    python run_computer.py --yes "..."   # approve every action without asking

It creates a sandbox (deleted when the run ends), hands `DaytonaComputer` to
`client.beta.messages.tool_runner`, and prints each of the model's messages until it finishes.
Before each action other than a screenshot it shows you the call and runs it only if you answer y,
through the toolset's `confirm` option.

Needs `ANTHROPIC_API_KEY` and `DAYTONA_API_KEY`. `MODEL` picks the model.
"""

from __future__ import annotations

import argparse
import json
import os

from anthropic import Anthropic
from anthropic.tools.computer import BetaComputerConfirmContext

from daytona_toolsets import DaytonaComputer

TASK = "Open a terminal, run `date`, and tell me exactly what it printed."


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the computer toolset on a Daytona sandbox.")
    parser.add_argument("task", nargs="*", help=f"what the model should do (default: {TASK!r})")
    parser.add_argument("--yes", action="store_true", help="approve every action without asking")
    args = parser.parse_args()
    task = " ".join(args.task) or TASK

    def confirm(context: BetaComputerConfirmContext) -> bool:
        if args.yes or context.member == "screenshot":
            return True
        call = json.dumps(context.input.model_dump(exclude_none=True))  # escapes control chars
        return input(f"Allow {context.member} {call}? [y/N] ").strip().lower() == "y"

    client = Anthropic()
    with DaytonaComputer(confirm=confirm) as computer:
        print(f"sandbox {computer.sandbox.id}, screen {computer.width}x{computer.height}")
        runner = client.beta.messages.tool_runner(
            model=os.environ.get("MODEL", "claude-sonnet-5-5"),
            max_tokens=4096,
            tools=[computer],
            messages=[{"role": "user", "content": task}],
        )
        for message in runner:
            for block in message.content:
                if block.type == "text":
                    print(f"[text] {block.text}")
                elif block.type == "tool_use":
                    print(f"[{block.name}] {json.dumps(block.input)}")


if __name__ == "__main__":
    main()
