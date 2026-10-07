from __future__ import annotations

import base64
import io
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest
from anthropic.tools import ToolsetClosedError, ToolsetConfigError
from daytona import DaytonaError
from PIL import Image

from daytona_toolsets import DaytonaComputer

from .conftest import blocks_of, call, fake_sandbox, png, text_of, xtest_actions


def approve(_context: object) -> bool:
    return True


def computer(sandbox: MagicMock, **kwargs: Any) -> DaytonaComputer:
    return DaytonaComputer(sandbox, confirm=approve, settle_delay=0, **kwargs)


def test_keyboard_members_require_confirm(sandbox: MagicMock) -> None:
    with pytest.raises(ToolsetConfigError):
        DaytonaComputer(sandbox)
    # turning the keyboard members off lifts the requirement, and the configs pass through
    off = {"enabled": False}
    toolset = DaytonaComputer(sandbox, configs={"type": off, "key": off, "hold_key": off})
    assert toolset.configs is not None and toolset.configs["type"] == off


def test_every_member_is_offered(sandbox: MagicMock) -> None:
    configs: dict[str, Any] = dict(computer(sandbox).configs or {})
    assert not [name for name, config in configs.items() if config.get("enabled") is False]


def test_off_screen_coordinates_are_refused_not_clamped(sandbox: MagicMock) -> None:
    toolset = computer(sandbox)
    for point in ([1280, 10], [10, 800], [-1, 0]):
        result = call(toolset, "left_click", {"coordinate": point})
        assert result.get("is_error") is True
        assert "outside the 1280x800 screen" in text_of(result)
    sandbox.computer_use.mouse.click.assert_not_called()


def test_coordinates_are_scaled_to_the_real_screen() -> None:
    sandbox = fake_sandbox(2560, 1440)
    toolset = computer(sandbox)
    assert (toolset.width, toolset.height) == (1920, 1080)
    call(toolset, "mouse_move", {"coordinate": [960, 540]})
    sandbox.computer_use.mouse.move.assert_called_once_with(1280, 720)
    sandbox.computer_use.mouse.get_position.return_value = SimpleNamespace(x=2559, y=1439)
    assert text_of(call(toolset, "cursor_position", {})) == "X=1919,Y=1079"
    shot = call(toolset, "screenshot", {})
    image = blocks_of(shot)[0]
    decoded = Image.open(io.BytesIO(base64.b64decode(image["source"]["data"])))
    assert decoded.size == (1920, 1080)


def test_zoom_crops_and_scales_up(sandbox: MagicMock) -> None:
    sandbox.computer_use.screenshot.take_region.return_value = SimpleNamespace(
        screenshot=png(200, 100)
    )
    result = call(computer(sandbox), "zoom", {"region": [10, 20, 210, 120]})
    region = sandbox.computer_use.screenshot.take_region.call_args.args[0]
    assert (region.x, region.y, region.width, region.height) == (10, 20, 200, 100)
    data = blocks_of(result)[0]["source"]["data"]
    assert Image.open(io.BytesIO(base64.b64decode(data))).size == (1280, 640)
    refused = call(computer(sandbox), "zoom", {"region": [0, 0, 1281, 10]})
    assert refused.get("is_error") is True


@pytest.mark.parametrize(
    ("text", "key", "modifiers"),
    [
        ("Return", "enter", []),
        ("ctrl+s", "s", ["ctrl"]),
        ("Page_Up", "pageup", []),
        ("!", "1", ["shift"]),
        ("ctrl+shift+Escape", "escape", ["ctrl", "shift"]),
        ("super+e", "e", ["cmd"]),
    ],
)
def test_key_names_map_to_daytona(
    sandbox: MagicMock, text: str, key: str, modifiers: list[str]
) -> None:
    call(computer(sandbox), "key", {"text": text})
    sandbox.computer_use.keyboard.press.assert_called_once_with(key, modifiers)


def test_key_sequence_and_repeat(sandbox: MagicMock) -> None:
    call(computer(sandbox), "key", {"text": "ctrl+a BackSpace", "repeat": 2})
    presses = [c.args for c in sandbox.computer_use.keyboard.press.call_args_list]
    assert presses == [("a", ["ctrl"]), ("backspace", []), ("a", ["ctrl"]), ("backspace", [])]


def test_keys_daytona_cannot_send_go_through_xtest(sandbox: MagicMock) -> None:
    call(computer(sandbox), "key", {"text": "ctrl+KP_Enter"})
    sandbox.computer_use.keyboard.press.assert_not_called()
    assert xtest_actions(sandbox) == [
        ["keydown", "Control_L"],
        ["keydown", "KP_Enter"],
        ["keyup", "KP_Enter"],
        ["keyup", "Control_L"],
    ]


def test_modifiers_are_held_during_a_click(sandbox: MagicMock) -> None:
    call(computer(sandbox), "left_click", {"coordinate": [100, 200], "text": "ctrl+shift"})
    sandbox.computer_use.mouse.click.assert_not_called()
    assert xtest_actions(sandbox) == [
        ["move", 100, 200],
        ["keydown", "Control_L"],
        ["keydown", "Shift_L"],
        ["down", 1],
        ["up", 1],
        ["keyup", "Shift_L"],
        ["keyup", "Control_L"],
    ]


def test_plain_clicks_use_the_computer_use_api(sandbox: MagicMock) -> None:
    toolset = computer(sandbox)
    call(toolset, "right_click", {"coordinate": [1, 2]})
    call(toolset, "double_click", {})
    assert [
        c.args + (c.kwargs["double"],) for c in sandbox.computer_use.mouse.click.call_args_list
    ] == [
        (1, 2, "right", False),
        (5, 6, "left", True),  # no coordinate: at the pointer
    ]


def test_triple_click_and_horizontal_scroll_use_xtest(sandbox: MagicMock) -> None:
    toolset = computer(sandbox)
    call(toolset, "triple_click", {"coordinate": [3, 4]})
    assert xtest_actions(sandbox) == [["move", 3, 4]] + [["down", 1], ["up", 1]] * 3
    call(toolset, "scroll", {"coordinate": [3, 4], "scroll_direction": "left", "scroll_amount": 2})
    assert xtest_actions(sandbox) == [["move", 3, 4]] + [["down", 6], ["up", 6]] * 2
    call(toolset, "scroll", {"scroll_direction": "down", "scroll_amount": 3})
    sandbox.computer_use.mouse.scroll.assert_called_once_with(5, 6, "down", 3)


def test_durations_are_bounded(sandbox: MagicMock) -> None:
    toolset = computer(sandbox)
    cases: list[tuple[str, dict[str, object]]] = [
        ("wait", {"duration": 31}),
        ("wait", {"duration": -1}),
        ("hold_key", {"text": "shift", "duration": 31}),
    ]
    for name, input in cases:
        result = call(toolset, name, input)
        assert result.get("is_error") is True and "between 0 and 30" in text_of(result)
    call(toolset, "hold_key", {"text": "shift", "duration": 2})
    assert xtest_actions(sandbox) == [["keydown", "Shift_L"], ["sleep", 2], ["keyup", "Shift_L"]]


def test_type_presses_tab_between_segments(sandbox: MagicMock) -> None:
    call(computer(sandbox), "type", {"text": "a\tb\n"})
    keyboard = sandbox.computer_use.keyboard
    assert [c.args[0] for c in keyboard.type.call_args_list] == ["a", "b\n"]
    keyboard.press.assert_called_once_with("tab")
    refused = call(computer(sandbox), "type", {"text": "\x1b[A"})
    assert refused.get("is_error") is True


def test_daytona_errors_become_fixed_phrases(sandbox: MagicMock) -> None:
    sandbox.computer_use.mouse.move.side_effect = DaytonaError("boom https://secret.example/x")
    result = call(computer(sandbox), "mouse_move", {"coordinate": [1, 1]})
    assert result.get("is_error") is True
    assert text_of(result) == "The sandbox desktop could not move the pointer."


def test_borrowed_sandbox_is_never_deleted(sandbox: MagicMock) -> None:
    toolset = computer(sandbox)
    toolset.close()
    toolset.close()
    sandbox.delete.assert_not_called()
    sandbox.stop.assert_not_called()
    with pytest.raises(ToolsetClosedError):
        call(toolset, "screenshot", {})


def test_owned_sandbox_is_deleted_once() -> None:
    sandbox = fake_sandbox()
    client = MagicMock()
    client.create.return_value = sandbox
    toolset = DaytonaComputer(daytona=client, confirm=approve, resolution=(1024, 768))
    params = client.create.call_args.args[0]
    assert params.env_vars["VNC_RESOLUTION"] == "1024x768"
    assert params.labels["created-by"] == "daytona-toolsets"
    with toolset:
        pass
    toolset.close()
    sandbox.delete.assert_called_once_with()


def test_owned_sandbox_can_be_stopped_instead() -> None:
    sandbox = fake_sandbox()
    client = MagicMock()
    client.create.return_value = sandbox
    DaytonaComputer(daytona=client, confirm=approve, on_close="stop").close()
    sandbox.stop.assert_called_once_with()
    sandbox.delete.assert_not_called()


def test_partial_construction_failure_cleans_up() -> None:
    sandbox = fake_sandbox()
    sandbox.computer_use.start.side_effect = RuntimeError("desktop failed")
    sandbox.computer_use.get_status.return_value = SimpleNamespace(status="inactive")
    client = MagicMock()
    client.create.return_value = sandbox
    with pytest.raises(RuntimeError, match="desktop failed"):
        DaytonaComputer(daytona=client, confirm=approve)
    sandbox.delete.assert_called_once_with()


def test_sandbox_and_create_params_are_exclusive(sandbox: MagicMock) -> None:
    with pytest.raises(ValueError):
        DaytonaComputer(sandbox, create_params=MagicMock(), confirm=approve)


async def test_async_computer_delegates_to_the_sync_driver(sandbox: MagicMock) -> None:
    from anthropic.types.beta import BetaToolUseBlock

    from daytona_toolsets import AsyncDaytonaComputer

    with pytest.raises(ToolsetConfigError):  # options are checked before a sandbox is touched
        await AsyncDaytonaComputer.create(sandbox)
    sandbox.computer_use.get_status.assert_not_called()

    async def confirm(_context: object) -> bool:
        return True

    toolset = await AsyncDaytonaComputer.create(sandbox, confirm=confirm, settle_delay=0)
    async with toolset:
        tool_use = BetaToolUseBlock(
            type="tool_use",
            id="toolu_1",
            name="left_click",
            input={"coordinate": [3, 4]},
            toolset_name="computer",
        )
        result = await toolset.tool_result(tool_use)
        assert text_of(result) == "Clicked."
    sandbox.computer_use.mouse.click.assert_called_once_with(3, 4, "left", double=False)
    sandbox.delete.assert_not_called()
