"""Key names as the model writes them (xdotool / X keysym style: `Return`, `Page_Up`, `ctrl+s`, `a`)
and what each backend accepts: Daytona's keyboard API and X keysyms for the desktop, Playwright key
names for the browser."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from anthropic.tools import ToolError

MODIFIERS = {
    **dict.fromkeys(("ctrl", "control", "control_l", "control_r", "ctl"), "ctrl"),
    **dict.fromkeys(("alt", "alt_l", "alt_r", "option", "opt"), "alt"),
    **dict.fromkeys(("shift", "shift_l", "shift_r"), "shift"),
    **dict.fromkeys(
        ("cmd", "command", "super", "super_l", "super_r", "win", "windows", "meta", "meta_l"),
        "cmd",
    ),
}
"""Modifier spellings → the canonical names Daytona's keyboard API takes."""

NAMED = {
    **dict.fromkeys(("return", "enter"), "enter"),
    "kp_enter": "num_enter",
    **dict.fromkeys(("escape", "esc"), "escape"),
    "tab": "tab",
    "backspace": "backspace",
    **dict.fromkeys(("delete", "del"), "delete"),
    "space": "space",
    "home": "home",
    "end": "end",
    **dict.fromkeys(("page_up", "pageup", "prior", "pgup"), "pageup"),
    **dict.fromkeys(("page_down", "pagedown", "next", "pgdn"), "pagedown"),
    **dict.fromkeys(("insert", "ins"), "insert"),
    **{name: name for name in ("up", "down", "left", "right")},
    **{f"arrow{name}": name for name in ("up", "down", "left", "right")},
    **dict.fromkeys(("caps_lock", "capslock"), "capslock"),
    "menu": "menu",
    **dict.fromkeys(("num_lock", "numlock"), "num_lock"),
    **{f"f{n}": f"f{n}" for n in range(1, 25)},
    **{f"kp_{n}": f"num{n}" for n in range(10)},
    "kp_add": "num_plus",
    "kp_subtract": "num_minus",
    "kp_multiply": "num_asterisk",
    "kp_divide": "num_slash",
    "kp_decimal": "num_decimal",
    "kp_equal": "num_equal",
    # X keysym names of the unshifted punctuation keys
    "minus": "-",
    "equal": "=",
    "bracketleft": "[",
    "bracketright": "]",
    "backslash": "\\",
    "semicolon": ";",
    "apostrophe": "'",
    "comma": ",",
    "period": ".",
    "slash": "/",
    "grave": "`",
}
"""Key names (lower case) → canonical names, which are the names Daytona's keyboard API takes."""

SHIFTED = dict(zip('!@#$%^&*()_+{}|:"<>?~', "1234567890-=[]\\;',./`"))
"""A US-layout symbol typed with shift → the key it is on."""

SHIFTED_NAMES = {
    "exclam": "!",
    "at": "@",
    "numbersign": "#",
    "dollar": "$",
    "percent": "%",
    "asciicircum": "^",
    "ampersand": "&",
    "asterisk": "*",
    "parenleft": "(",
    "parenright": ")",
    "underscore": "_",
    "plus": "+",
    "braceleft": "{",
    "braceright": "}",
    "bar": "|",
    "colon": ":",
    "quotedbl": '"',
    "less": "<",
    "greater": ">",
    "question": "?",
    "asciitilde": "~",
}
"""X keysym names of the shifted symbols → the symbol."""

PUNCTUATION = frozenset("-=[]\\;',./`")

XKEYSYMS = {
    "enter": "Return",
    "num_enter": "KP_Enter",
    "escape": "Escape",
    "tab": "Tab",
    "backspace": "BackSpace",
    "delete": "Delete",
    "space": "space",
    "home": "Home",
    "end": "End",
    "pageup": "Prior",
    "pagedown": "Next",
    "insert": "Insert",
    "up": "Up",
    "down": "Down",
    "left": "Left",
    "right": "Right",
    "capslock": "Caps_Lock",
    "menu": "Menu",
    "num_lock": "Num_Lock",
    **{f"f{n}": f"F{n}" for n in range(1, 25)},
    **{f"num{n}": f"KP_{n}" for n in range(10)},
    "num_plus": "KP_Add",
    "num_minus": "KP_Subtract",
    "num_asterisk": "KP_Multiply",
    "num_slash": "KP_Divide",
    "num_decimal": "KP_Decimal",
    "num_equal": "KP_Equal",
    "-": "minus",
    "=": "equal",
    "[": "bracketleft",
    "]": "bracketright",
    "\\": "backslash",
    ";": "semicolon",
    "'": "apostrophe",
    ",": "comma",
    ".": "period",
    "/": "slash",
    "`": "grave",
    "ctrl": "Control_L",
    "alt": "Alt_L",
    "shift": "Shift_L",
    "cmd": "Super_L",
}
"""Canonical names → X keysym names, for the input Daytona's API cannot send (held keys, chords
held during a click)."""

# Live production evidence (daemon 0.222.1, 2026-10-07): native press emits the wrong bytes for
# these names (`num_enter` emits backtick; operators emit unrelated characters). Their KP_* X
# keysyms emit the expected bytes. Digits, decimal, equal and lock remain correct natively.
XTEST_NUMPAD = frozenset({"num_asterisk", "num_enter", "num_minus", "num_plus", "num_slash"})

PLAYWRIGHT = {
    "enter": "Enter",
    "num_enter": "NumpadEnter",
    "escape": "Escape",
    "tab": "Tab",
    "backspace": "Backspace",
    "delete": "Delete",
    "space": "Space",
    "home": "Home",
    "end": "End",
    "pageup": "PageUp",
    "pagedown": "PageDown",
    "insert": "Insert",
    "up": "ArrowUp",
    "down": "ArrowDown",
    "left": "ArrowLeft",
    "right": "ArrowRight",
    "capslock": "CapsLock",
    "menu": "ContextMenu",
    "num_lock": "NumLock",
    **{f"f{n}": f"F{n}" for n in range(1, 25)},
    **{f"num{n}": f"Numpad{n}" for n in range(10)},
    "num_plus": "NumpadAdd",
    "num_minus": "NumpadSubtract",
    "num_asterisk": "NumpadMultiply",
    "num_slash": "NumpadDivide",
    "num_decimal": "NumpadDecimal",
    "num_equal": "=",
    "ctrl": "Control",
    "alt": "Alt",
    "shift": "Shift",
    "cmd": "Meta",
}
"""Canonical names → Playwright key names."""


def split_sequence(text: str) -> list[str]:
    """The chords of a key sequence: `"ctrl+a BackSpace"` is two presses. A lone space is the space
    key."""
    if text and not text.strip():
        return ["space"]
    chords = text.split()
    if not chords:
        raise ToolError(
            "No key was given; send a key name such as Return, or a chord such as ctrl+s."
        )
    return chords


def parse_chord(chord: str) -> tuple[list[str], Optional[str]]:
    """Split `ctrl+shift+t` into canonical modifiers and the key token as written (`None` for a chord
    of modifiers alone, such as `shift` or `ctrl+alt`). `ctrl++` and `+` name the plus key."""
    if chord == "+":
        return [], "+"
    tokens = chord[:-2].split("+") + ["+"] if chord.endswith("++") else chord.split("+")
    if any(not token for token in tokens):
        raise ToolError(f"Could not read the key chord {chord!r}; join keys with +, as in ctrl+s.")
    modifiers: list[str] = []
    for token in tokens[:-1]:
        modifier = MODIFIERS.get(token.lower())
        if modifier is None:
            raise ToolError(
                f"{token!r} is not a modifier; only the last key of a chord may be a plain key."
            )
        if modifier not in modifiers:
            modifiers.append(modifier)
    last = tokens[-1]
    final = MODIFIERS.get(last.lower())
    if final is not None:
        if final not in modifiers:
            modifiers.append(final)
        return modifiers, None
    return modifiers, last


@dataclass(frozen=True)
class DesktopKey:
    """One non-modifier key for the desktop."""

    daytona: Optional[str]
    """The name Daytona's `keyboard.press` takes, or `None` when only an X keysym can send it."""
    keysym: str
    """The X keysym name, for input sent with XTest."""
    shift: bool = False
    """The key is typed with shift held: an uppercase letter or a shifted symbol."""
    char: Optional[str] = None
    """The single character the key types, when it types one."""


def desktop_key(token: str) -> DesktopKey:
    if len(token) == 1:
        if token == " ":
            return DesktopKey("space", "space", char=" ")
        if token in SHIFTED:
            base = SHIFTED[token]  # a digit or unshifted punctuation; a digit is its own keysym
            return DesktopKey(base, XKEYSYMS.get(base, base), shift=True, char=token)
        if token.isascii() and token.isalpha() and token.isupper():
            return DesktopKey(token.lower(), token.lower(), shift=True, char=token)
        if token.isascii() and token.isalnum():
            return DesktopKey(token, token, char=token)
        if token in PUNCTUATION:
            return DesktopKey(token, XKEYSYMS[token], char=token)
        return DesktopKey(None, f"U{ord(token):04X}", char=token)
    lower = token.lower()
    if lower in NAMED:
        canonical = NAMED[lower]
        if len(canonical) == 1:
            return desktop_key(canonical)
        if canonical in XTEST_NUMPAD:
            return DesktopKey(None, XKEYSYMS[canonical])
        return DesktopKey(canonical, XKEYSYMS[canonical])
    if lower in SHIFTED_NAMES:
        return desktop_key(SHIFTED_NAMES[lower])
    # Not in the tables: an X keysym name such as Print or XF86AudioMute, sent as written.
    return DesktopKey(None, token)


def playwright_chord(chord: str) -> str:
    """A model chord as the `keyboard.press` string Playwright takes, such as `Control+Shift+T`."""
    modifiers, token = parse_chord(chord)
    parts = [PLAYWRIGHT[modifier] for modifier in modifiers]
    if token is not None:
        parts.append(playwright_key(token))
    return "+".join(parts)


def playwright_key(token: str) -> str:
    if len(token) == 1:
        return "Space" if token == " " else token
    lower = token.lower()
    if lower in NAMED:
        canonical = NAMED[lower]
        return canonical if len(canonical) == 1 else PLAYWRIGHT[canonical]
    if lower in SHIFTED_NAMES:
        return SHIFTED_NAMES[lower]
    return token  # Playwright's own names (PrintScreen, AudioVolumeMute, KeyA ...) pass through
