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
        # verified-correct native numpad keys stay native
        ("KP_1", DesktopKey("num1", "KP_1")),
        ("KP_Decimal", DesktopKey("num_decimal", "KP_Decimal")),
        # daemon 0.222.1 mis-types these native names, so they stay on XTest
        ("KP_Enter", DesktopKey(None, "KP_Enter")),
        ("KP_Add", DesktopKey(None, "KP_Add")),
        ("KP_Subtract", DesktopKey(None, "KP_Subtract")),
        ("KP_Multiply", DesktopKey(None, "KP_Multiply")),
        ("KP_Divide", DesktopKey(None, "KP_Divide")),
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


def playwright_split(key: str) -> list[str]:
    """Playwright's own chord splitter, from `packages/playwright-core/src/server/input.ts`:

        function split(keyString) {
          const keys = []; let building = '';
          for (const char of keyString) {
            if (char === '+' && building) { keys.push(building); building = ''; }
            else { building += char; }
          }
          keys.push(building); return keys;
        }

    The `&& building` is what keeps a `+` that no token precedes: it is a key, not a separator.
    """
    keys: list[str] = []
    building = ""
    for char in key:
        if char == "+" and building:
            keys.append(building)
            building = ""
        else:
            building += char
    keys.append(building)
    return keys


@pytest.mark.parametrize(
    ("chord", "pressed"),
    [
        ("+", ["+"]),
        ("plus", ["+"]),
        ("ctrl++", ["Control", "+"]),
        ("shift++", ["Shift", "+"]),
        ("ctrl+shift+t", ["Control", "Shift", "t"]),
        ("ctrl+plus", ["Control", "+"]),
    ],
)
def test_the_plus_key_survives_playwrights_chord_delimiter(chord: str, pressed: list[str]) -> None:
    """`+` is both the plus key and Playwright's delimiter, but not ambiguously: Playwright only
    treats one as a separator when a token precedes it, so the strings this module emits read
    back as the keys they name. Pinned here because the round trip is the whole contract."""
    assert playwright_split(playwright_chord(chord)) == pressed
