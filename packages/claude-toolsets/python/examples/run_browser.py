"""Run the browser toolset on Chromium in a Daytona sandbox, driven by the model through the tool
runner.

Usage:

    python run_browser.py "Open example.com and tell me the page heading."

It creates a sandbox (deleted when the run ends), hands `DaytonaBrowser` to
`client.beta.messages.tool_runner` with an example URL policy, and prints each of the model's
messages until it finishes. The policy admits http(s) pages on the hosts in `ALLOWED_DOMAINS`
(subdomains included) and the empty tab; the driver applies it to the pages' own requests too. It
is an example, not a production policy.

Needs `ANTHROPIC_API_KEY` and `DAYTONA_API_KEY`. `ALLOWED_DOMAINS` (default `example.com,iana.org`)
and `MODEL` are read from the environment. Sandbox egress follows your Daytona organization's
network tier; pass `create_params` with a `domain_allow_list` to narrow it further.
"""

from __future__ import annotations

import argparse
import json
import os
import re
from urllib.parse import urlsplit

from anthropic import Anthropic
from anthropic.tools import ToolError
from anthropic.tools.browser import BetaURLContext, BetaURLPolicy

from daytona_claude_toolsets import DaytonaBrowser

TASK = "Open example.com and tell me the page heading."


def example_policy(allowed_hosts: list[str]) -> BetaURLPolicy:
    """http(s) pages on the allowed hosts or their subdomains, and the empty tab."""
    # Dropped after normalizing, not before: `.` is not blank, but it normalizes to the empty
    # host, which `host.endswith("." + allowed)` then matches for every name written as a fully
    # qualified one (`evil.test.`). One such entry would switch the allowlist off.
    hosts = [normal for h in allowed_hosts if (normal := h.strip().lower().rstrip("."))]

    def policy(_context: BetaURLContext, url: str) -> None:
        if url.lower() == "about:blank":
            return
        has_scheme = re.match(r"[a-z][a-z0-9+.-]*://", url, re.I)
        try:
            parts = urlsplit((url if has_scheme else f"https://{url}").replace("\\", "/"))
        except ValueError:
            raise ToolError("blocked: the address could not be parsed") from None
        host = (parts.hostname or "").lower()
        if parts.scheme not in ("http", "https") or not any(
            host == allowed or host.endswith("." + allowed) for allowed in hosts
        ):
            raise ToolError(f"blocked: {host or url} is not an allowed host")

    return policy


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the browser toolset on a Daytona sandbox.")
    parser.add_argument("task", nargs="*", help=f"what the model should do (default: {TASK!r})")
    args = parser.parse_args()
    task = " ".join(args.task) or TASK
    allowed = os.environ.get("ALLOWED_DOMAINS", "example.com,iana.org").split(",")

    client = Anthropic()
    with DaytonaBrowser(url_policy=example_policy(allowed)) as browser:
        print(f"sandbox {browser.sandbox.id}, allowed hosts: {', '.join(allowed)}")
        runner = client.beta.messages.tool_runner(
            model=os.environ.get("MODEL", "claude-sonnet-5-5"),
            max_tokens=4096,
            tools=[browser],
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
