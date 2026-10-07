"""`DaytonaComputer`: the computer toolset (`computer_toolset_20260801`) on a Daytona sandbox desktop."""

from __future__ import annotations

import base64
import io
import logging
import time
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any, Optional

from anthropic.tools import ToolError
from anthropic.tools.computer import (
    BetaAbstractComputerToolset20260801,
    BetaComputerCursorPositionResult,
    BetaScreenshotResult,
    BetaToolsetCallContext,
)
from anthropic.types.beta import (
    BetaComputerCursorPositionInput,
    BetaComputerDoubleClickInput,
    BetaComputerHoldKeyInput,
    BetaComputerKeyInput,
    BetaComputerLeftClickDragInput,
    BetaComputerLeftClickInput,
    BetaComputerLeftMouseDownInput,
    BetaComputerLeftMouseUpInput,
    BetaComputerMiddleClickInput,
    BetaComputerMouseMoveInput,
    BetaComputerRightClickInput,
    BetaComputerScreenshotInput,
    BetaComputerScrollInput,
    BetaComputerTripleClickInput,
    BetaComputerTypeInput,
    BetaComputerWaitInput,
    BetaComputerZoomInput,
)
from daytona import Daytona, DaytonaError, Sandbox, ScreenshotRegion
from PIL import Image
from typing_extensions import override

from ._keys import XKEYSYMS, desktop_key, parse_chord, split_sequence
from ._sandbox import CreateParams, OnClose, SandboxLease
from ._xtest import BUTTONS, Action, XTest

log = logging.getLogger("daytona_toolsets")

MAX_DURATION = 30
"""Longest `wait` or `hold_key` the driver runs, in seconds. The SDK does not bound either."""
MAX_REPEAT = 100
MAX_SCROLL = 50
WHEEL = {"up": "up", "down": "down", "left": "wheel_left", "right": "wheel_right"}
NATIVE_INPUT_FLOOR_ERROR = (
    "This sandbox's platform does not support native held input; recreate the sandbox on a current "
    "Daytona version."
)


class DaytonaComputer(BetaAbstractComputerToolset20260801):
    """The computer toolset, driving the desktop of a Daytona sandbox through its Computer Use API.

    Pass an existing `sandbox` to drive it (it is never stopped or deleted), or leave it out and
    the driver creates one from `create_params` (Daytona's default snapshot when omitted) and
    deletes it on `close()`, or stops it with `on_close="stop"`.

    Keyword arguments not listed here are the SDK's toolset options (`confirm`, `configs`,
    `tool_configs`) and are passed on unchanged. The SDK requires a `confirm` callable while
    `type`, `key` or `hold_key` is enabled.

    Args:
        sandbox: A running Daytona sandbox whose image has the desktop (Daytona's default
            snapshot does). Computer use is started on it if it is not running.
        daytona: The client used to create a sandbox; `Daytona()` (configured from
            `DAYTONA_API_KEY` and the other `DAYTONA_*` variables) when omitted.
        create_params: How to create the sandbox when none is passed.
        on_close: What `close()` does to a sandbox the driver created: `"delete"` or `"stop"`.
        resolution: The desktop size of a sandbox the driver creates (`VNC_RESOLUTION`), unless
            `create_params` sets it.
        max_screenshot_size: Screenshots larger than this are scaled down to fit, and the model's
            coordinates are scaled back up.
        settle_delay: Seconds a screenshot waits after the last input, so it shows its effect.
    """

    def __init__(
        self,
        sandbox: Optional[Sandbox] = None,
        *,
        daytona: Optional[Daytona] = None,
        create_params: Optional[CreateParams] = None,
        on_close: OnClose = "delete",
        resolution: tuple[int, int] = (1280, 800),
        max_screenshot_size: tuple[int, int] = (1920, 1200),
        settle_delay: float = 0.3,
        create_timeout: float = 120,
        **options: Any,
    ) -> None:
        super().__init__(**options)
        self._lease: Optional[SandboxLease] = None
        self._xtest: Optional[XTest] = None
        self._max_size = max_screenshot_size
        self._settle_delay = settle_delay
        self._last_input = 0.0
        self._screen = (0, 0)
        self._scale = 1.0
        self._native_input_capability: Optional[bool] = None
        try:
            self._lease = SandboxLease.acquire(
                sandbox,
                daytona=daytona,
                create_params=create_params,
                default_env={"VNC_RESOLUTION": f"{resolution[0]}x{resolution[1]}"},
                on_close=on_close,
                create_timeout=create_timeout,
            )
            self._xtest = XTest(self._lease.sandbox)
            self._start_desktop()
        except BaseException:
            self.close()
            raise

    @property
    def sandbox(self) -> Sandbox:
        """The sandbox whose desktop this toolset drives."""
        if self._lease is None:
            raise RuntimeError("this DaytonaComputer is closed")
        return self._lease.sandbox

    @property
    def width(self) -> int:
        """The screen width the model sees, in screenshot pixels."""
        return round(self._screen[0] * self._scale)

    @property
    def height(self) -> int:
        """The screen height the model sees, in screenshot pixels."""
        return round(self._screen[1] * self._scale)

    @override
    def close(self) -> None:
        """Release the sandbox: delete (or stop) it if the driver created it, leave it running if
        it was passed in. Safe to call more than once."""
        super().close()
        lease, self._lease = self._lease, None
        xtest, self._xtest = self._xtest, None
        if lease is None:
            return
        if xtest is not None and not lease.owned:
            xtest.cleanup()
        lease.release()

    # --- setup -----------------------------------------------------------------------------------

    def _start_desktop(self) -> None:
        sandbox = self.sandbox
        if str(getattr(sandbox.state, "value", sandbox.state)) != "started":
            sandbox.start()
        computer_use = sandbox.computer_use
        if computer_use.get_status().status != "active":
            computer_use.start()
        deadline = time.monotonic() + 60
        while True:
            try:
                displays = computer_use.display.get_info().displays or []
                if computer_use.get_status().status == "active" and displays:
                    break
            except DaytonaError:
                pass  # the desktop is still coming up
            if time.monotonic() > deadline:
                raise RuntimeError("the sandbox desktop did not start within 60 seconds")
            time.sleep(1)
        primary = next((d for d in displays if d.is_active), displays[0])
        self._set_screen(int(primary.width or 0), int(primary.height or 0))

    def _set_screen(self, width: int, height: int) -> None:
        if width <= 0 or height <= 0:
            raise RuntimeError("the sandbox desktop reported no screen size")
        max_width, max_height = self._max_size
        self._screen = (width, height)
        self._scale = min(1.0, max_width / width, max_height / height)

    # --- helpers ---------------------------------------------------------------------------------

    @contextmanager
    def _desktop(self, action: str, *, is_input: bool = True) -> Iterator[None]:
        """Run Daytona calls for one action, turning a Daytona failure into a fixed phrase. An
        input restarts the settle delay the next screenshot waits out."""
        try:
            yield
        except DaytonaError as exc:
            log.debug("computer use call failed: %s", type(exc).__name__)
            raise ToolError(f"The sandbox desktop could not {action}.") from exc
        finally:
            if is_input:
                self._last_input = time.monotonic()

    def _to_screen(self, x: int, y: int) -> tuple[int, int]:
        """A point in screenshot pixels, checked against the screen, in screen pixels. A point off
        the screen is refused, not clamped, so the model sees its mistake."""
        if not (0 <= x < self.width and 0 <= y < self.height):
            raise ToolError(f"({x}, {y}) is outside the {self.width}x{self.height} screen.")
        if self._scale == 1.0:
            return x, y
        return (
            min(self._screen[0] - 1, int(x / self._scale)),
            min(self._screen[1] - 1, int(y / self._scale)),
        )

    def _point(self, coordinate: Optional[list[int]]) -> tuple[int, int]:
        """The coordinate in screen pixels, or where the pointer is when there is none."""
        if coordinate is not None:
            return self._to_screen(coordinate[0], coordinate[1])
        with self._desktop("read the pointer position", is_input=False):
            position = self.sandbox.computer_use.mouse.get_position()
        return int(position.x or 0), int(position.y or 0)

    def _held_keysyms(self, text: Optional[str]) -> list[str]:
        """The X keysyms of a key chord held during a mouse action (`ctrl`, `ctrl+shift`)."""
        if not text:
            return []
        modifiers, token = parse_chord(text.strip())
        keysyms = [XKEYSYMS[modifier] for modifier in modifiers]
        if token is not None:
            key = desktop_key(token)
            if key.shift and "Shift_L" not in keysyms:
                keysyms.append("Shift_L")
            keysyms.append(key.keysym)
        return keysyms

    def _run_xtest(self, actions: list[Action]) -> None:
        if self._xtest is None:
            raise RuntimeError("this DaytonaComputer is closed")
        with self._desktop("send the input"):
            self._xtest.run(actions)

    def _native_input_supported(self) -> bool:
        """Whether the sandbox daemon has the native held-input endpoints."""
        if self._native_input_capability is None:
            try:
                self.sandbox.computer_use.mouse.down(x=0)
            except DaytonaError as exc:
                match exc.status_code:
                    case 400:
                        self._native_input_capability = True
                    case 404:
                        self._native_input_capability = False
                    case _:
                        raise
            else:
                try:
                    self.sandbox.computer_use.mouse.up()
                except DaytonaError:
                    pass
                self._native_input_capability = True
        return self._native_input_capability

    def _require_native_input(self) -> None:
        if not self._native_input_supported():
            raise ToolError(NATIVE_INPUT_FLOOR_ERROR)

    def _with_keys_held(self, keysyms: list[str], actions: list[Action]) -> list[Action]:
        downs: list[Action] = [["keydown", k] for k in keysyms]
        ups: list[Action] = [["keyup", k] for k in reversed(keysyms)]
        return downs + actions + ups

    def _click(
        self, coordinate: Optional[list[int]], text: Optional[str], button: str, count: int = 1
    ) -> None:
        x, y = self._point(coordinate)
        modifiers, token = parse_chord(text.strip()) if text else ([], None)
        if token is None:
            if count > 2 or modifiers:
                self._require_native_input()
            with self._desktop("click"):
                self.sandbox.computer_use.mouse.click(
                    x,
                    y,
                    button,
                    double=count == 2,
                    clicks=count,
                    modifiers=modifiers,
                )
            return
        held = self._held_keysyms(text)
        number = BUTTONS[button]
        presses: list[Action] = [["down", number], ["up", number]] * count
        self._run_xtest([["move", x, y], *self._with_keys_held(held, presses)])

    def _screenshot_png(self) -> tuple[bytes, Image.Image]:
        wait = self._last_input + self._settle_delay - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        with self._desktop("take a screenshot", is_input=False):
            response = self.sandbox.computer_use.screenshot.take_full_screen()
        png = base64.b64decode(response.screenshot or "")
        image = Image.open(io.BytesIO(png))
        if image.size != self._screen:
            self._set_screen(*image.size)  # the display changed size since the last look
        return png, image

    # --- members ---------------------------------------------------------------------------------

    @override
    def screenshot(
        self, context: BetaToolsetCallContext, input: BetaComputerScreenshotInput
    ) -> BetaScreenshotResult:
        png, image = self._screenshot_png()
        if self._scale < 1.0:
            png = encode_png(image.resize((self.width, self.height), Image.Resampling.LANCZOS))
        return BetaScreenshotResult(data=base64.b64encode(png).decode(), media_type="image/png")

    @override
    def zoom(
        self, context: BetaToolsetCallContext, input: BetaComputerZoomInput
    ) -> BetaScreenshotResult:
        x0, y0, x1, y1 = input.region
        if not (0 <= x0 < x1 <= self.width and 0 <= y0 < y1 <= self.height):
            raise ToolError(
                f"region must satisfy 0 <= x0 < x1 <= {self.width} and 0 <= y0 < y1 <= "
                f"{self.height} (the screen in screenshot pixels)."
            )
        left, top = (int(x0 / self._scale), int(y0 / self._scale))
        right = min(self._screen[0], max(left + 1, round(x1 / self._scale)))
        bottom = min(self._screen[1], max(top + 1, round(y1 / self._scale)))
        region = ScreenshotRegion(x=left, y=top, width=right - left, height=bottom - top)
        with self._desktop("take a screenshot", is_input=False):
            response = self.sandbox.computer_use.screenshot.take_region(region)
        crop = Image.open(io.BytesIO(base64.b64decode(response.screenshot or "")))
        # Scaled up to fill a full screenshot's size, so small detail becomes legible.
        factor = min(self.width / crop.width, self.height / crop.height)
        size = (max(1, round(crop.width * factor)), max(1, round(crop.height * factor)))
        png = encode_png(crop.resize(size, Image.Resampling.LANCZOS))
        return BetaScreenshotResult(data=base64.b64encode(png).decode(), media_type="image/png")

    @override
    def cursor_position(
        self, context: BetaToolsetCallContext, input: BetaComputerCursorPositionInput
    ) -> BetaComputerCursorPositionResult:
        x, y = self._point(None)
        return BetaComputerCursorPositionResult(
            x=min(self.width - 1, int(x * self._scale)),
            y=min(self.height - 1, int(y * self._scale)),
        )

    @override
    def mouse_move(
        self, context: BetaToolsetCallContext, input: BetaComputerMouseMoveInput
    ) -> None:
        x, y = self._point(input.coordinate)
        with self._desktop("move the pointer"):
            self.sandbox.computer_use.mouse.move(x, y)

    @override
    def left_click(
        self, context: BetaToolsetCallContext, input: BetaComputerLeftClickInput
    ) -> None:
        self._click(input.coordinate, input.text, "left")

    @override
    def right_click(
        self, context: BetaToolsetCallContext, input: BetaComputerRightClickInput
    ) -> None:
        self._click(input.coordinate, input.text, "right")

    @override
    def middle_click(
        self, context: BetaToolsetCallContext, input: BetaComputerMiddleClickInput
    ) -> None:
        self._click(input.coordinate, input.text, "middle")

    @override
    def double_click(
        self, context: BetaToolsetCallContext, input: BetaComputerDoubleClickInput
    ) -> None:
        self._click(input.coordinate, input.text, "left", count=2)

    @override
    def triple_click(
        self, context: BetaToolsetCallContext, input: BetaComputerTripleClickInput
    ) -> None:
        self._click(input.coordinate, input.text, "left", count=3)

    @override
    def left_click_drag(
        self, context: BetaToolsetCallContext, input: BetaComputerLeftClickDragInput
    ) -> None:
        start = self._point(input.start_coordinate)
        end = self._point(input.coordinate)
        modifiers, token = parse_chord(input.text.strip()) if input.text else ([], None)
        if token is None:
            if modifiers:
                self._require_native_input()
            with self._desktop("drag"):
                self.sandbox.computer_use.mouse.drag(
                    start[0], start[1], end[0], end[1], modifiers=modifiers
                )
            return
        held = self._held_keysyms(input.text)
        drag: list[Action] = [["down", 1], ["move", end[0], end[1]], ["up", 1]]
        self._run_xtest([["move", start[0], start[1]], *self._with_keys_held(held, drag)])

    @override
    def left_mouse_down(
        self, context: BetaToolsetCallContext, input: BetaComputerLeftMouseDownInput
    ) -> None:
        self._require_native_input()
        with self._desktop("press the mouse button"):
            self.sandbox.computer_use.mouse.down()

    @override
    def left_mouse_up(
        self, context: BetaToolsetCallContext, input: BetaComputerLeftMouseUpInput
    ) -> None:
        self._require_native_input()
        with self._desktop("release the mouse button"):
            self.sandbox.computer_use.mouse.up()

    @override
    def scroll(self, context: BetaToolsetCallContext, input: BetaComputerScrollInput) -> None:
        if not 1 <= input.scroll_amount <= MAX_SCROLL:
            raise ToolError(f"scroll_amount must be between 1 and {MAX_SCROLL}.")
        x, y = self._point(input.coordinate)
        modifiers, token = parse_chord(input.text.strip()) if input.text else ([], None)
        direction = input.scroll_direction
        if token is None:
            if direction in ("left", "right") or modifiers:
                self._require_native_input()
            with self._desktop("scroll"):
                self.sandbox.computer_use.mouse.scroll(
                    x, y, direction, input.scroll_amount, modifiers=modifiers
                )
            return
        held = self._held_keysyms(input.text)
        number = BUTTONS[WHEEL[direction]]
        notches: list[Action] = [["down", number], ["up", number]] * input.scroll_amount
        self._run_xtest([["move", x, y], *self._with_keys_held(held, notches)])

    @override
    def key(self, context: BetaToolsetCallContext, input: BetaComputerKeyInput) -> None:
        repeat = 1 if input.repeat is None else input.repeat
        if not 1 <= repeat <= MAX_REPEAT:
            raise ToolError(f"repeat must be between 1 and {MAX_REPEAT}.")
        chords = [parse_chord(chord) for chord in split_sequence(input.text)]
        for _ in range(repeat):
            for modifiers, token in chords:
                self._press(modifiers, token)

    def _press(self, modifiers: list[str], token: Optional[str]) -> None:
        if token is None:  # modifiers alone, such as `super` or `ctrl+alt`
            keysyms = [XKEYSYMS[modifier] for modifier in modifiers]
            self._run_xtest(self._with_keys_held(keysyms, []))
            return
        key = desktop_key(token)
        held = modifiers + (["shift"] if key.shift and "shift" not in modifiers else [])
        if key.daytona is not None:
            with self._desktop("press the key"):
                self.sandbox.computer_use.keyboard.press(key.daytona, held)
        elif not modifiers and key.char is not None:
            with self._desktop("type the character"):
                self.sandbox.computer_use.keyboard.type(key.char)
        else:
            keysyms = [XKEYSYMS[modifier] for modifier in held]
            self._run_xtest(
                self._with_keys_held(keysyms, [["keydown", key.keysym], ["keyup", key.keysym]])
            )

    @override
    def hold_key(self, context: BetaToolsetCallContext, input: BetaComputerHoldKeyInput) -> None:
        if not 0 <= input.duration <= MAX_DURATION:
            raise ToolError(f"duration must be between 0 and {MAX_DURATION} seconds.")
        chords = split_sequence(input.text)
        if len(chords) != 1:
            raise ToolError("hold_key holds one key or chord, such as shift or ctrl+a.")
        keysyms = self._held_keysyms(chords[0])
        self._run_xtest(self._with_keys_held(keysyms, [["sleep", input.duration]]))

    @override
    def type(self, context: BetaToolsetCallContext, input: BetaComputerTypeInput) -> None:
        text = input.text
        if any(ord(c) < 0x20 and c not in "\n\r\t" or c == "\x7f" for c in text):
            raise ToolError("type sends text; send control keys with key, as in ctrl+c.")
        keyboard = self.sandbox.computer_use.keyboard
        # Daytona types newlines as Enter but refuses a tab, so tabs are pressed between segments.
        for index, segment in enumerate(text.split("\t")):
            if index:
                with self._desktop("press the key"):
                    keyboard.press("tab")
            if segment:
                with self._desktop("type the text"):
                    keyboard.type(segment, request_timeout=max(30.0, len(segment) / 20))

    @override
    def wait(self, context: BetaToolsetCallContext, input: BetaComputerWaitInput) -> None:
        if not 0 <= input.duration <= MAX_DURATION:
            raise ToolError(f"duration must be between 0 and {MAX_DURATION} seconds.")
        time.sleep(input.duration)


def encode_png(image: Image.Image) -> bytes:
    out = io.BytesIO()
    image.save(out, "PNG")
    return out.getvalue()
