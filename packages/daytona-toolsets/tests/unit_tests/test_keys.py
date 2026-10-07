from __future__ import annotations

import pytest
from anthropic.tools import ToolError

from daytona_toolsets._keys import (
    DesktopKey,
    desktop_key,
    parse_chord,
    playwright_chord,
    split_sequence,
)


@pytest.mark.parametrize(
    ("chord", "expected"),
    [
        ("Return", ([], "Return")),
        ("ctrl+s", (["ctrl"], "s")),
        ("ctrl+shift+Escape", (["ctrl", "shift"], "Escape")),
        ("Control_L+alt+Tab", (["ctrl", "alt"], "Tab")),
        ("super", (["cmd"], None)),
        ("ctrl+alt", (["ctrl", "alt"], None)),
        ("cmd+Win+a", (["cmd"], "a")),
        ("ctrl++", (["ctrl"], "+")),
        ("+", ([], "+")),
    ],
)
def test_parse_chord(chord: str, expected: tuple[list[str], str | None]) -> None:
    assert parse_chord(chord) == expected


@pytest.mark.parametrize("chord", ["a+ctrl", "ctrl+", "ctrl++shift", "Return+a"])
def test_parse_chord_refuses_malformed_chords(chord: str) -> None:
    with pytest.raises(ToolError):
        parse_chord(chord)


def test_split_sequence() -> None:
    assert split_sequence("ctrl+a BackSpace") == ["ctrl+a", "BackSpace"]
    assert split_sequence(" ") == ["space"]
    with pytest.raises(ToolError):
        split_sequence("")


@pytest.mark.parametrize(
    ("token", "expected"),
    [
        ("Return", DesktopKey("enter", "Return")),
        ("enter", DesktopKey("enter", "Return")),
        ("Page_Up", DesktopKey("pageup", "Prior")),
        ("pagedown", DesktopKey("pagedown", "Next")),
        ("BackSpace", DesktopKey("backspace", "BackSpace")),
        ("F5", DesktopKey("f5", "F5")),
        ("a", DesktopKey("a", "a", char="a")),
        ("7", DesktopKey("7", "7", char="7")),
        ("A", DesktopKey("a", "a", shift=True, char="A")),
        ("!", DesktopKey("1", "1", shift=True, char="!")),
        ("exclam", DesktopKey("1", "1", shift=True, char="!")),
        ("?", DesktopKey("/", "slash", shift=True, char="?")),
        ("minus", DesktopKey("-", "minus", char="-")),
        ("/", DesktopKey("/", "slash", char="/")),
        (" ", DesktopKey("space", "space", char=" ")),
        # the numpad goes by keysym (Daytona's press("num_enter") types a backtick)
        ("KP_Enter", DesktopKey(None, "KP_Enter")),
        ("é", DesktopKey(None, "U00E9", char="é")),
        # not in the tables: an X keysym name, sent as written
        ("XF86AudioMute", DesktopKey(None, "XF86AudioMute")),
    ],
)
def test_desktop_key(token: str, expected: DesktopKey) -> None:
    assert desktop_key(token) == expected


@pytest.mark.parametrize(
    ("chord", "expected"),
    [
        ("Return", "Enter"),
        ("ctrl+shift+t", "Control+Shift+t"),
        ("cmd+a", "Meta+a"),
        ("Page_Up", "PageUp"),
        ("BackSpace", "Backspace"),
        ("Escape", "Escape"),
        ("alt+Left", "Alt+ArrowLeft"),
        ("A", "A"),
        ("exclam", "!"),
        ("space", "Space"),
        ("shift", "Shift"),
        ("PrintScreen", "PrintScreen"),
    ],
)
def test_playwright_chord(chord: str, expected: str) -> None:
    assert playwright_chord(chord) == expected
