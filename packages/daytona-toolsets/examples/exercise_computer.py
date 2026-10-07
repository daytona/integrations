"""Exercise DaytonaComputer with the calls a model would make, against a real Daytona sandbox: no
model and no Anthropic API key.

Usage:

    python exercise_computer.py

It creates a sandbox (deleted at the end), opens a terminal on its desktop, and sends every member
the driver implements through `toolset.tool_result(...)`, the entry point the tool runner uses. It
prints each `tool_result` as the model would see it (image bytes elided) and checks it: calls that
should be answered are, the effects that can be read back (typed commands, the pointer position,
screenshot sizes) are there, and calls that should be refused come back as `is_error`. Then it checks
that a sandbox passed in by the caller survives `close()`.

The first mismatch ends the script with a failed assertion (exit status 1). Needs `DAYTONA_API_KEY`.
"""

from __future__ import annotations

import base64
import json
import struct
import sys
import time
from typing import Any

from anthropic.tools.computer import BetaAbstractComputerToolset20260801
from anthropic.types.beta import BetaToolResultBlockParam, BetaToolUseBlock
from daytona import CreateSandboxFromSnapshotParams, Daytona, SessionExecuteRequest

from daytona_toolsets import DaytonaComputer


def call(
    computer: BetaAbstractComputerToolset20260801,
    name: str,
    input: dict[str, object],
    exercised: set[str] | None = None,
) -> BetaToolResultBlockParam:
    """Send one tool call as the model would, and print the result as the model would see it."""
    if exercised is not None:
        exercised.add(name)
    tool_use = BetaToolUseBlock(
        type="tool_use", id=f"toolu_{name}", name=name, input=input, toolset_name="computer"
    )
    result = computer.tool_result(tool_use)
    print(f"\n{name} {json.dumps(input)} -> {'refused' if result.get('is_error') else 'answered'}")
    for block in blocks_of(result):
        if block.get("type") == "image":
            block = {
                **block,
                "source": {**block["source"], "data": f"<{len(png_of(result))} bytes>"},
            }
        print("  " + json.dumps(block))
    return result


def blocks_of(result: BetaToolResultBlockParam) -> list[dict[str, Any]]:
    content = result.get("content", "")
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return [dict(block) for block in content]


def text_of(result: BetaToolResultBlockParam) -> str:
    return "\n".join(str(block.get("text", "")) for block in blocks_of(result))


def png_of(result: BetaToolResultBlockParam) -> bytes:
    for block in blocks_of(result):
        if block.get("type") == "image":
            return base64.b64decode(block["source"]["data"])
    return b""


def png_size(png: bytes) -> tuple[int, int]:
    assert png[:8] == b"\x89PNG\r\n\x1a\n", "expected a PNG"
    width, height = struct.unpack(">II", png[16:24])
    return width, height


def answered(
    computer: DaytonaComputer,
    name: str,
    input: dict[str, object],
    exercised: set[str] | None = None,
) -> str:
    result = call(computer, name, input, exercised)
    assert not result.get("is_error"), f"expected that {name} {input} is answered"
    return text_of(result)


def refused(
    computer: DaytonaComputer,
    name: str,
    input: dict[str, object],
    phrase: str,
    exercised: set[str] | None = None,
) -> None:
    result = call(computer, name, input, exercised)
    assert result.get("is_error") is True and phrase in text_of(
        result
    ), f"expected that {name} {input} is refused with {phrase!r}"


def read_file(computer: DaytonaComputer, path: str, timeout: float = 10) -> str:
    """What a command typed into the terminal wrote, once it has run."""
    deadline = time.monotonic() + timeout
    while True:
        result = computer.sandbox.process.exec(f"cat {path} 2>/dev/null")
        if result.result.strip() or time.monotonic() > deadline:
            return result.result.strip()
        time.sleep(0.5)


def check_exercised_members(exercised: set[str], enabled: set[str]) -> None:
    """Reject a live exercise that misses an enabled computer member."""
    assert (
        exercised == enabled
    ), f"exercise coverage mismatch: missing={enabled - exercised}, extra={exercised - enabled}"


def exercise(computer: DaytonaComputer) -> None:
    exercised: set[str] = set()
    first = call(computer, "screenshot", {}, exercised)
    assert png_size(png_of(first)) == (
        computer.width,
        computer.height,
    ), "expected that screenshot is a PNG of the whole screen"

    # A bash terminal (the sandbox user's login shell is /bin/sh, which has no line editing) to type
    # into, opened on the desktop by the harness, not by the model.
    sandbox = computer.sandbox
    sandbox.process.create_session("exercise-terminal")
    sandbox.process.execute_session_command(
        "exercise-terminal",
        SessionExecuteRequest(
            command=(
                "DISPLAY=:0 xfce4-terminal --geometry=100x30+40+40 --command=bash >/dev/null 2>&1"
            ),
            run_async=True,
        ),
    )
    time.sleep(4)
    answered(computer, "left_click", {"coordinate": [300, 200]}, exercised)

    # type + key: a command typed into the terminal and run with Return writes its answer to a file.
    answered(computer, "type", {"text": "echo $((6*7)) > /tmp/exercise-type.txt"}, exercised)
    answered(computer, "key", {"text": "Return"}, exercised)
    assert read_file(computer, "/tmp/exercise-type.txt") == "42", "expected that the command ran"
    answered(computer, "type", {"text": "printf 'tab\tok' > /tmp/exercise-tab.txt"}, exercised)
    answered(computer, "key", {"text": "Return"}, exercised)
    assert read_file(computer, "/tmp/exercise-tab.txt") == "tab\tok", "expected tab typing"

    # a chord: type the command without its first letter, go to the line start with ctrl+a, add it.
    answered(computer, "type", {"text": "cho chord-ok > /tmp/exercise-chord.txt"}, exercised)
    answered(computer, "key", {"text": "ctrl+a"}, exercised)
    answered(computer, "type", {"text": "e"}, exercised)
    answered(computer, "key", {"text": "Return", "repeat": 1}, exercised)
    assert read_file(computer, "/tmp/exercise-chord.txt") == "chord-ok", "expected ctrl+a to work"

    # a key sequence with a shifted symbol sent as a key: `echo x! > file` built key by key.
    answered(computer, "type", {"text": "echo x"}, exercised)
    answered(computer, "key", {"text": "exclam space greater space"}, exercised)
    answered(computer, "type", {"text": "/tmp/exercise-keys.txt"}, exercised)
    answered(computer, "key", {"text": "KP_Enter"}, exercised)
    answered(computer, "key", {"text": "XF86AudioPlay"}, exercised)
    assert read_file(computer, "/tmp/exercise-keys.txt") == "x!", "expected the key sequence"

    second = call(computer, "screenshot", {}, exercised)
    assert png_of(second) != png_of(first), "expected that the screen changed after the typing"

    # pointer
    answered(computer, "mouse_move", {"coordinate": [10, 20]}, exercised)
    position = answered(computer, "cursor_position", {}, exercised)
    assert "X=10,Y=20" in position.replace(" ", ""), f"expected the pointer at 10,20: {position}"
    for name in ("right_click", "middle_click", "double_click", "triple_click"):
        answered(computer, name, {"coordinate": [600, 20]}, exercised)
        answered(computer, "key", {"text": "Escape"}, exercised)
    answered(computer, "left_click", {"coordinate": [600, 20], "text": "shift"}, exercised)
    answered(computer, "left_click", {}, exercised)
    answered(
        computer,
        "left_click_drag",
        {"start_coordinate": [50, 50], "coordinate": [90, 90]},
        exercised,
    )
    answered(
        computer,
        "left_click_drag",
        {"start_coordinate": [50, 50], "coordinate": [90, 90], "text": "ctrl"},
        exercised,
    )
    answered(computer, "left_mouse_down", {}, exercised)
    answered(computer, "mouse_move", {"coordinate": [120, 120]}, exercised)
    answered(computer, "left_mouse_up", {}, exercised)
    position = answered(computer, "cursor_position", {}, exercised)
    assert "X=120,Y=120" in position.replace(
        " ", ""
    ), f"expected the pointer at 120,120: {position}"
    answered(
        computer,
        "scroll",
        {"coordinate": [300, 200], "scroll_direction": "down", "scroll_amount": 3},
        exercised,
    )
    answered(
        computer,
        "scroll",
        {"coordinate": [300, 200], "scroll_direction": "left", "scroll_amount": 2},
        exercised,
    )
    answered(
        computer,
        "scroll",
        {"scroll_direction": "up", "scroll_amount": 1, "text": "ctrl"},
        exercised,
    )

    # keys held and waits
    answered(computer, "hold_key", {"text": "shift", "duration": 1}, exercised)
    answered(computer, "wait", {"duration": 1}, exercised)

    # zoom: a 200x100 region comes back scaled up, keeping its shape, within a screenshot's size
    zoomed = png_size(png_of(call(computer, "zoom", {"region": [0, 0, 200, 100]}, exercised)))
    assert zoomed[0] <= computer.width and zoomed[1] <= computer.height, "zoom fits the budget"
    assert zoomed[0] > 200 and abs(zoomed[0] / zoomed[1] - 2) < 0.02, f"zoom scaled up: {zoomed}"

    # refusals
    refused(
        computer,
        "left_click",
        {"coordinate": [computer.width, computer.height]},
        "outside",
        exercised,
    )
    refused(computer, "mouse_move", {"coordinate": [-1, 5]}, "outside", exercised)
    refused(computer, "zoom", {"region": [100, 100, 50, 50]}, "region must satisfy", exercised)
    refused(computer, "wait", {"duration": 31}, "between 0 and 30", exercised)
    refused(computer, "hold_key", {"text": "shift", "duration": 60}, "between 0 and 30", exercised)
    refused(computer, "key", {"text": "NoSuchKeyName"}, "Unknown key", exercised)
    refused(computer, "key", {"text": "a+ctrl"}, "not a modifier", exercised)
    refused(computer, "type", {"text": "bell\x07"}, "control keys", exercised)
    refused(
        computer,
        "scroll",
        {"scroll_direction": "down", "scroll_amount": 0},
        "scroll_amount",
        exercised,
    )
    enabled: set[str] = {
        name
        for name in computer._toolset_options.registry.names
        if computer._toolset_options.is_enabled(name)
    }
    check_exercised_members(exercised, enabled)


def main() -> None:
    try:
        # No one is at the terminal, so this confirm approves every call.
        computer = DaytonaComputer(confirm=lambda context: True)
    except Exception as error:  # no Daytona credentials, or the sandbox did not come up
        print(f"error: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
    sandbox_id = computer.sandbox.id
    print(f"sandbox {sandbox_id}: screen {computer.width}x{computer.height}")
    with computer:
        exercise(computer)
    computer.close()  # a second close is a no-op
    time.sleep(2)
    state = Daytona().get(sandbox_id).state if _exists(sandbox_id) else "gone"
    assert state in (
        "gone",
        "destroyed",
        "destroying",
    ), f"expected the owned sandbox deleted: {state}"

    # A desktop larger than the screenshot budget: screenshots are scaled down, and the model's
    # coordinates are scaled back up to the real screen.
    with DaytonaComputer(resolution=(2560, 1440), confirm=lambda context: True) as computer:
        assert (computer.width, computer.height) == (1920, 1080), "expected a 0.75 scale"
        shot = png_size(png_of(call(computer, "screenshot", {})))
        assert shot == (1920, 1080), f"expected the screenshot scaled to 1920x1080: {shot}"
        answered(computer, "mouse_move", {"coordinate": [960, 540]})
        real = computer.sandbox.computer_use.mouse.get_position()
        assert (real.x, real.y) == (1280, 720), f"expected the real pointer at 1280,720: {real}"
        position = answered(computer, "cursor_position", {})
        assert "X=960,Y=540" in position.replace(" ", ""), f"expected 960,540: {position}"
        refused(computer, "left_click", {"coordinate": [1920, 100]}, "outside the 1920x1080")

    # A sandbox the caller passes in is not the driver's to delete.
    daytona = Daytona()
    borrowed = daytona.create(
        CreateSandboxFromSnapshotParams(labels={"created-by": "daytona-toolsets"})
    )
    try:
        with DaytonaComputer(borrowed, confirm=lambda context: True) as computer:
            call(computer, "screenshot", {})
        borrowed.refresh_data()
        assert (
            str(getattr(borrowed.state, "value", borrowed.state)) == "started"
        ), "expected that a passed-in sandbox survives close()"
    finally:
        borrowed.delete()
    print("\nAll calls came back as expected.")


def _exists(sandbox_id: str) -> bool:
    try:
        Daytona().get(sandbox_id)
        return True
    except Exception:
        return False


if __name__ == "__main__":
    main()
