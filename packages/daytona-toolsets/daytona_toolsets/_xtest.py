"""XTest fallback for input the Daytona Computer Use API does not represent natively: exotic
keysyms without a Daytona key name, and mouse click, drag or scroll chords holding a non-modifier
key token.

A small Python script is uploaded into the sandbox once and replays a list of XTest events on the
sandbox's X display (libX11 and libXtst through ctypes: nothing to install). It uses the same
X server the Computer Use API drives, so the two can be mixed freely.
"""

from __future__ import annotations

import base64
import logging
import json
import secrets
import shlex
from typing import Union

from anthropic.tools import ToolError
from daytona import Sandbox

log = logging.getLogger("daytona_toolsets")

Action = list[Union[str, int, float]]

SCRIPT = r"""
import ctypes, json, os, sys, time, base64
x11 = ctypes.cdll.LoadLibrary("libX11.so.6")
xtst = ctypes.cdll.LoadLibrary("libXtst.so.6")
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XStringToKeysym.restype = ctypes.c_ulong
x11.XStringToKeysym.argtypes = [ctypes.c_char_p]
x11.XKeysymToKeycode.restype = ctypes.c_ubyte
x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XFlush.argtypes = [ctypes.c_void_p]
x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
x11.XDefaultScreen.argtypes = [ctypes.c_void_p]
xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
display = x11.XOpenDisplay((os.environ.get("DISPLAY") or ":0").encode())
if not display:
    print("no-display"); sys.exit(3)
actions = json.loads(base64.b64decode(sys.argv[1]))
codes = {}
for action in actions:
    if action[0] in ("keydown", "keyup") and action[1] not in codes:
        keysym = x11.XStringToKeysym(action[1].encode())
        # NoSymbol (0) would map to a spare keycode, so an unknown name is caught here first.
        code = x11.XKeysymToKeycode(display, keysym) if keysym else 0
        if not code:
            print("unknown-key:" + action[1]); sys.exit(4)
        codes[action[1]] = code
for action in actions:
    kind = action[0]
    if kind == "move":
        xtst.XTestFakeMotionEvent(display, x11.XDefaultScreen(display), int(action[1]), int(action[2]), 0)
    elif kind in ("down", "up"):
        xtst.XTestFakeButtonEvent(display, int(action[1]), kind == "down", 0)
    elif kind in ("keydown", "keyup"):
        xtst.XTestFakeKeyEvent(display, codes[action[1]], kind == "keydown", 0)
    elif kind == "sleep":
        x11.XFlush(display); time.sleep(float(action[1])); continue
    x11.XFlush(display)
    time.sleep(0.012)
x11.XCloseDisplay(display)
"""

BUTTONS = {
    "left": 1,
    "middle": 2,
    "right": 3,
    "up": 4,
    "down": 5,
    "wheel_left": 6,
    "wheel_right": 7,
}
"""X pointer button numbers; the wheel is buttons 4-7."""


class XTest:
    """Runs XTest event lists in one sandbox."""

    def __init__(self, sandbox: Sandbox) -> None:
        self._sandbox = sandbox
        self._path: str | None = None

    def run(self, actions: list[Action]) -> None:
        if not actions:
            return
        seconds = sum(float(a[1]) for a in actions if a[0] == "sleep") + 0.02 * len(actions)
        encoded = base64.b64encode(json.dumps(actions).encode()).decode()
        command = f"python3 {shlex.quote(self._script())} {encoded}"
        response = self._sandbox.process.exec(command, timeout=int(seconds) + 30)
        if response.exit_code == 0:
            return
        output = response.result or ""
        for line in output.splitlines():
            if line.startswith("unknown-key:"):
                name = line.split(":", 1)[1]
                raise ToolError(
                    f"Unknown key {name!r}; use a key name such as Return, Page_Up or F5, or a "
                    "single character."
                )
        if "no-display" in output:
            raise ToolError("The desktop is not running; the X display could not be opened.")
        raise ToolError("The desktop did not accept the input.")

    def cleanup(self) -> None:
        """Remove the uploaded script (from a sandbox the driver does not own)."""
        path, self._path = self._path, None
        if path is None:
            return
        try:
            self._sandbox.fs.delete_file(path)
        except Exception as exc:  # best effort: a leftover file in /tmp is harmless
            log.debug("could not remove the XTest helper: %s", type(exc).__name__)

    def _script(self) -> str:
        if self._path is None:
            path = f"/tmp/daytona-toolsets-xtest-{secrets.token_hex(4)}.py"
            self._sandbox.fs.upload_file(SCRIPT.encode(), path)
            self._path = path
        return self._path
