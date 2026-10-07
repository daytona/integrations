from __future__ import annotations

import base64
import io
import json
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest
from anthropic.types.beta import BetaToolResultBlockParam, BetaToolUseBlock
from PIL import Image


def png(width: int, height: int) -> str:
    out = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(out, "PNG")
    return base64.b64encode(out.getvalue()).decode()


def fake_sandbox(width: int = 1280, height: int = 800) -> MagicMock:
    """A Daytona Sandbox double with a running desktop of the given size."""
    sandbox = MagicMock(name="sandbox")
    sandbox.id = "sbx-test"
    sandbox.state = SimpleNamespace(value="started")
    cu = sandbox.computer_use
    cu.get_status.return_value = SimpleNamespace(status="active")
    cu.display.get_info.return_value = SimpleNamespace(
        displays=[SimpleNamespace(width=width, height=height, is_active=True)]
    )
    cu.screenshot.take_full_screen.return_value = SimpleNamespace(screenshot=png(width, height))
    cu.mouse.get_position.return_value = SimpleNamespace(x=5, y=6)
    sandbox.process.exec.return_value = SimpleNamespace(exit_code=0, result="")
    return sandbox


def xtest_actions(sandbox: MagicMock) -> list[list[Any]]:
    """The XTest event list of the last helper run."""
    command = sandbox.process.exec.call_args.args[0]
    actions: list[list[Any]] = json.loads(base64.b64decode(command.split()[-1]))
    return actions


def call(toolset: Any, name: str, input: dict[str, object]) -> BetaToolResultBlockParam:
    tool_use = BetaToolUseBlock(
        type="tool_use",
        id=f"toolu_{name}",
        name=name,
        input=input,
        toolset_name=toolset.toolset_name,
    )
    result: BetaToolResultBlockParam = toolset.tool_result(tool_use)
    return result


def blocks_of(result: BetaToolResultBlockParam) -> list[dict[str, Any]]:
    content = result.get("content", "")
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return [dict(block) for block in content]


def text_of(result: BetaToolResultBlockParam) -> str:
    content = result.get("content", "")
    if isinstance(content, str):
        return content
    return "\n".join(str(dict(block).get("text", "")) for block in content)


@pytest.fixture
def sandbox() -> MagicMock:
    return fake_sandbox()
