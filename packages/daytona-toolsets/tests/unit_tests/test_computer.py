from __future__ import annotations

import base64
import io
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, call as mock_call, patch

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


def test_verified_numpad_key_uses_probe_gated_native_press(sandbox: MagicMock) -> None:
    sandbox.computer_use.mouse.down.side_effect = DaytonaError("probe", status_code=400)
    call(computer(sandbox), "key", {"text": "KP_Decimal"})
    sandbox.computer_use.mouse.down.assert_called_once_with(x=0)
    sandbox.computer_use.keyboard.press.assert_called_once_with("num_decimal", [])
    sandbox.process.exec.assert_not_called()


@pytest.mark.parametrize(
    ("text", "keysym"),
    [
        ("KP_Enter", "KP_Enter"),
        ("KP_Add", "KP_Add"),
        ("KP_Subtract", "KP_Subtract"),
        ("KP_Multiply", "KP_Multiply"),
        ("KP_Divide", "KP_Divide"),
    ],
)
def test_incorrect_native_numpad_keys_use_xtest(sandbox: MagicMock, text: str, keysym: str) -> None:
    call(computer(sandbox), "key", {"text": text})
    sandbox.computer_use.keyboard.press.assert_not_called()
    sandbox.computer_use.mouse.down.assert_not_called()
    assert xtest_actions(sandbox) == [["keydown", keysym], ["keyup", keysym]]


def test_unsupported_keysym_goes_through_xtest(sandbox: MagicMock) -> None:
    call(computer(sandbox), "key", {"text": "ctrl+XF86AudioPlay"})
    sandbox.computer_use.keyboard.press.assert_not_called()
    assert xtest_actions(sandbox) == [
        ["keydown", "Control_L"],
        ["keydown", "XF86AudioPlay"],
        ["keyup", "XF86AudioPlay"],
        ["keyup", "Control_L"],
    ]


def test_hold_with_unsupported_keysym_uses_only_xtest(sandbox: MagicMock) -> None:
    call(computer(sandbox), "hold_key", {"text": "ctrl+XF86AudioPlay", "duration": 2})
    assert xtest_actions(sandbox) == [
        ["keydown", "Control_L"],
        ["keydown", "XF86AudioPlay"],
        ["sleep", 2],
        ["keyup", "XF86AudioPlay"],
        ["keyup", "Control_L"],
    ]
    sandbox.computer_use.mouse.down.assert_not_called()
    sandbox.computer_use.keyboard.down.assert_not_called()


def test_modifiers_are_held_during_a_click(sandbox: MagicMock) -> None:
    sandbox.computer_use.mouse.down.side_effect = DaytonaError("probe", status_code=400)
    call(computer(sandbox), "left_click", {"coordinate": [100, 200], "text": "ctrl+shift"})
    sandbox.computer_use.mouse.click.assert_called_once_with(
        100,
        200,
        "left",
        double=False,
        clicks=1,
        modifiers=["ctrl", "shift"],
    )
    sandbox.process.exec.assert_not_called()


def test_plain_clicks_use_the_computer_use_api(sandbox: MagicMock) -> None:
    toolset = computer(sandbox)
    call(toolset, "right_click", {"coordinate": [1, 2]})
    call(toolset, "double_click", {})
    assert sandbox.computer_use.mouse.click.call_args_list == [
        mock_call(1, 2, "right", double=False, clicks=1, modifiers=[]),
        mock_call(5, 6, "left", double=True, clicks=2, modifiers=[]),
    ]
    sandbox.computer_use.mouse.down.assert_not_called()


def test_triple_click_and_horizontal_scroll_use_native_api(sandbox: MagicMock) -> None:
    sandbox.computer_use.mouse.down.side_effect = DaytonaError("probe", status_code=400)
    toolset = computer(sandbox)
    call(toolset, "triple_click", {"coordinate": [3, 4]})
    sandbox.computer_use.mouse.click.assert_called_once_with(
        3, 4, "left", double=False, clicks=3, modifiers=[]
    )
    call(toolset, "scroll", {"coordinate": [3, 4], "scroll_direction": "left", "scroll_amount": 2})
    sandbox.computer_use.mouse.scroll.assert_called_once_with(3, 4, "left", 2, modifiers=[])
    call(toolset, "scroll", {"scroll_direction": "down", "scroll_amount": 3})
    assert sandbox.computer_use.mouse.scroll.call_args_list[-1] == mock_call(
        5, 6, "down", 3, modifiers=[]
    )
    sandbox.process.exec.assert_not_called()


def test_click_with_non_modifier_token_uses_xtest(sandbox: MagicMock) -> None:
    call(computer(sandbox), "left_click", {"coordinate": [3, 4], "text": "ctrl+a"})
    sandbox.computer_use.mouse.click.assert_not_called()
    sandbox.computer_use.mouse.down.assert_not_called()
    assert xtest_actions(sandbox) == [
        ["move", 3, 4],
        ["keydown", "Control_L"],
        ["keydown", "a"],
        ["down", 1],
        ["up", 1],
        ["keyup", "a"],
        ["keyup", "Control_L"],
    ]


def test_native_mouse_down_up_and_modifier_drag(sandbox: MagicMock) -> None:
    def down(*_args: object, **kwargs: object) -> SimpleNamespace:
        if kwargs == {"x": 0}:
            raise DaytonaError("probe", status_code=400)
        return SimpleNamespace(x=5, y=6)

    sandbox.computer_use.mouse.down.side_effect = down
    toolset = computer(sandbox)
    call(toolset, "left_mouse_down", {})
    call(toolset, "left_mouse_up", {})
    call(
        toolset,
        "left_click_drag",
        {"start_coordinate": [1, 2], "coordinate": [3, 4], "text": "shift"},
    )
    assert sandbox.computer_use.mouse.down.call_args_list == [mock_call(x=0), mock_call()]
    sandbox.computer_use.mouse.up.assert_called_once_with()
    sandbox.computer_use.mouse.drag.assert_called_once_with(1, 2, 3, 4, modifiers=["shift"])
    sandbox.process.exec.assert_not_called()


def test_successful_probe_releases_button_before_native_path(sandbox: MagicMock) -> None:
    toolset = computer(sandbox)
    call(toolset, "triple_click", {"coordinate": [3, 4]})
    sandbox.computer_use.mouse.down.assert_called_once_with(x=0)
    sandbox.computer_use.mouse.up.assert_called_once_with()
    assert toolset._native_input_capability is True
    sandbox.computer_use.mouse.click.assert_called_once_with(
        3, 4, "left", double=False, clicks=3, modifiers=[]
    )


def test_probe_404_blocks_every_gated_mouse_member_and_is_cached(sandbox: MagicMock) -> None:
    floor = (
        "This sandbox's platform does not support native held input; recreate the sandbox on a "
        "current Daytona version."
    )
    sandbox.computer_use.mouse.down.side_effect = DaytonaError("missing route", status_code=404)
    toolset = computer(sandbox)
    cases: list[tuple[str, dict[str, object]]] = [
        ("triple_click", {"coordinate": [3, 4]}),
        ("left_click", {"coordinate": [3, 4], "text": "ctrl"}),
        ("left_mouse_down", {}),
        ("left_mouse_up", {}),
        (
            "left_click_drag",
            {"start_coordinate": [1, 2], "coordinate": [3, 4], "text": "shift"},
        ),
        ("scroll", {"scroll_direction": "left", "scroll_amount": 2}),
        ("scroll", {"scroll_direction": "up", "scroll_amount": 2, "text": "ctrl"}),
    ]
    for name, input in cases:
        result = call(toolset, name, input)
        assert result.get("is_error") is True
        assert text_of(result) == floor
    sandbox.computer_use.mouse.down.assert_called_once_with(x=0)
    sandbox.computer_use.mouse.click.assert_not_called()
    sandbox.computer_use.mouse.up.assert_not_called()
    sandbox.computer_use.mouse.drag.assert_not_called()
    sandbox.computer_use.mouse.scroll.assert_not_called()


def test_cached_unsupported_capability_does_not_gate_plain_clicks(sandbox: MagicMock) -> None:
    toolset = computer(sandbox)
    toolset._native_input_capability = False
    call(toolset, "left_click", {"coordinate": [3, 4]})
    call(toolset, "double_click", {"coordinate": [5, 6]})
    assert sandbox.computer_use.mouse.click.call_args_list == [
        mock_call(3, 4, "left", double=False, clicks=1, modifiers=[]),
        mock_call(5, 6, "left", double=True, clicks=2, modifiers=[]),
    ]
    sandbox.computer_use.mouse.down.assert_not_called()


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


def test_hold_modifier_chord_uses_native_down_and_reverse_up(sandbox: MagicMock) -> None:
    sandbox.computer_use.mouse.down.side_effect = DaytonaError("probe", status_code=400)
    with patch("daytona_toolsets.computer.time.sleep") as sleep:
        events = MagicMock()
        events.attach_mock(sandbox.computer_use.keyboard.down, "down")
        events.attach_mock(sleep, "sleep")
        events.attach_mock(sandbox.computer_use.keyboard.up, "up")
        call(computer(sandbox), "hold_key", {"text": "ctrl+shift", "duration": 2})
    assert events.mock_calls == [
        mock_call.down("ctrl"),
        mock_call.down("shift"),
        mock_call.sleep(2),
        mock_call.up("shift"),
        mock_call.up("ctrl"),
    ]
    sandbox.process.exec.assert_not_called()


def test_hold_incorrect_native_numpad_key_uses_xtest(sandbox: MagicMock) -> None:
    with patch("daytona_toolsets.computer.time.sleep"):
        call(computer(sandbox), "hold_key", {"text": "KP_Add", "duration": 0})
    assert xtest_actions(sandbox) == [
        ["keydown", "KP_Add"],
        ["sleep", 0],
        ["keyup", "KP_Add"],
    ]
    sandbox.computer_use.mouse.down.assert_not_called()
    sandbox.computer_use.keyboard.down.assert_not_called()


@pytest.mark.parametrize("text", ["A", "exclam", "shift+exclam"])
def test_hold_shifted_key_uses_implicit_deduplicated_shift(sandbox: MagicMock, text: str) -> None:
    sandbox.computer_use.mouse.down.side_effect = DaytonaError("probe", status_code=400)
    with patch("daytona_toolsets.computer.time.sleep"):
        call(computer(sandbox), "hold_key", {"text": text, "duration": 0})
    assert sandbox.computer_use.keyboard.mock_calls == [
        mock_call.down("shift"),
        mock_call.down("a" if text == "A" else "1"),
        mock_call.up("a" if text == "A" else "1"),
        mock_call.up("shift"),
    ]
    sandbox.process.exec.assert_not_called()


def test_hold_runtime_failure_releases_held_keys_and_uses_desktop_error(
    sandbox: MagicMock,
) -> None:
    sandbox.computer_use.mouse.down.side_effect = DaytonaError("probe", status_code=400)
    sandbox.computer_use.keyboard.down.side_effect = [None, DaytonaError("down failed")]
    result = call(computer(sandbox), "hold_key", {"text": "ctrl+a", "duration": 1})
    assert result.get("is_error") is True
    assert text_of(result) == "The sandbox desktop could not hold the key."
    sandbox.computer_use.keyboard.up.assert_called_once_with("ctrl")
    assert "native held input" not in text_of(result)


def test_type_sends_tab_in_one_native_call(sandbox: MagicMock) -> None:
    sandbox.computer_use.mouse.down.side_effect = DaytonaError("probe", status_code=400)
    call(computer(sandbox), "type", {"text": "a\tb\n"})
    keyboard = sandbox.computer_use.keyboard
    keyboard.type.assert_called_once_with("a\tb\n", request_timeout=30.0)
    keyboard.press.assert_not_called()


def test_type_refuses_control_characters_before_native_call(sandbox: MagicMock) -> None:
    refused = call(computer(sandbox), "type", {"text": "\x1b[A"})
    assert refused.get("is_error") is True
    sandbox.computer_use.keyboard.type.assert_not_called()


def test_probe_404_blocks_keyboard_migrations_and_is_cached(sandbox: MagicMock) -> None:
    floor = (
        "This sandbox's platform does not support native held input; recreate the sandbox on a "
        "current Daytona version."
    )
    sandbox.computer_use.mouse.down.side_effect = DaytonaError("missing route", status_code=404)
    toolset = computer(sandbox)
    cases: list[tuple[str, dict[str, object]]] = [
        ("hold_key", {"text": "ctrl", "duration": 0}),
        ("type", {"text": "a\tb"}),
        ("key", {"text": "KP_Decimal"}),
    ]
    for name, input in cases:
        result = call(toolset, name, input)
        assert result.get("is_error") is True
        assert text_of(result) == floor
    sandbox.computer_use.mouse.down.assert_called_once_with(x=0)
    sandbox.computer_use.keyboard.down.assert_not_called()
    sandbox.computer_use.keyboard.type.assert_not_called()
    sandbox.computer_use.keyboard.press.assert_not_called()


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


async def test_async_computer_delegates_mouse_down_to_the_sync_driver(sandbox: MagicMock) -> None:
    from anthropic.types.beta import BetaToolUseBlock

    from daytona_toolsets import AsyncDaytonaComputer

    with pytest.raises(ToolsetConfigError):  # options are checked before a sandbox is touched
        await AsyncDaytonaComputer.create(sandbox)
    sandbox.computer_use.get_status.assert_not_called()

    async def confirm(_context: object) -> bool:
        return True

    def down(*_args: object, **kwargs: object) -> SimpleNamespace:
        if kwargs == {"x": 0}:
            raise DaytonaError("probe", status_code=400)
        return SimpleNamespace(x=5, y=6)

    sandbox.computer_use.mouse.down.side_effect = down
    toolset = await AsyncDaytonaComputer.create(sandbox, confirm=confirm, settle_delay=0)
    async with toolset:
        tool_use = BetaToolUseBlock(
            type="tool_use",
            id="toolu_1",
            name="left_mouse_down",
            input={},
            toolset_name="computer",
        )
        result = await toolset.tool_result(tool_use)
        assert result.get("is_error") is not True
    assert sandbox.computer_use.mouse.down.call_args_list == [mock_call(x=0), mock_call()]
    sandbox.delete.assert_not_called()


async def test_async_computer_delegates_native_hold_to_the_sync_driver(sandbox: MagicMock) -> None:
    from anthropic.types.beta import BetaToolUseBlock

    from daytona_toolsets import AsyncDaytonaComputer

    async def confirm(_context: object) -> bool:
        return True

    sandbox.computer_use.mouse.down.side_effect = DaytonaError("probe", status_code=400)
    toolset = await AsyncDaytonaComputer.create(sandbox, confirm=confirm, settle_delay=0)
    async with toolset:
        tool_use = BetaToolUseBlock(
            type="tool_use",
            id="toolu_1",
            name="hold_key",
            input={"text": "ctrl+a", "duration": 2},
            toolset_name="computer",
        )
        with patch("daytona_toolsets.computer.time.sleep") as sleep:
            events = MagicMock()
            events.attach_mock(sandbox.computer_use.keyboard.down, "down")
            events.attach_mock(sleep, "sleep")
            events.attach_mock(sandbox.computer_use.keyboard.up, "up")
            result = await toolset.tool_result(tool_use)
        assert result.get("is_error") is not True
    assert events.mock_calls == [
        mock_call.down("ctrl"),
        mock_call.down("a"),
        mock_call.sleep(2),
        mock_call.up("a"),
        mock_call.up("ctrl"),
    ]
    sandbox.process.exec.assert_not_called()
