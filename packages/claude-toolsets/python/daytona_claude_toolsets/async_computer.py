"""`AsyncDaytonaComputer`: `DaytonaComputer` for `AsyncAnthropic` and the async tool runner.

Each member runs the synchronous driver's member in a worker thread, so the event loop is never
blocked on the sandbox. The SDK runs one member call at a time, so the synchronous driver is never
used from two threads at once.
"""

from __future__ import annotations

from collections.abc import Callable
from functools import partial
from typing import Any, Optional, TypeVar

import anyio.to_thread
from anthropic.tools.computer import (
    BetaAsyncAbstractComputerToolset20260801,
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
from daytona import Sandbox
from typing_extensions import override

from .computer import DaytonaComputer

T = TypeVar("T")


class AsyncDaytonaComputer(BetaAsyncAbstractComputerToolset20260801):
    """The computer toolset on a Daytona sandbox desktop, for the async tool runner.

    Build it with `await AsyncDaytonaComputer.create(...)`, which takes the same arguments as
    `DaytonaComputer` (creating a sandbox blocks, so it runs in a worker thread). The SDK's toolset
    options (`confirm`, `configs`, `tool_configs`) apply here; `confirm` may be async.

    One `async def` per member, forwarding to the same member on `DaytonaComputer`, is what the SDK
    requires — not a style choice. It decides which members a toolset serves by looking the name up
    on the *class* and comparing it with the abstract base's own method, calling nothing
    (`anthropic.lib.tools._toolsets._base.overridden`); a member it does not find there is sent to
    the model as `enabled: False` and never dispatched. So `__getattr__`, `getattr`-based dispatch
    or a shared generic forwarder would silently disable all seventeen members. The SDK then checks
    each one it did find is an `async def` on an async toolset (`check_flavour`), and each takes its
    own input type, which is what keeps the forwarding type-checked. The drift this inventory could
    cause is held shut by a test: `test_the_async_toolset_mirrors_every_computer_member` compares
    both classes against the SDK's own `BetaComputerMemberName`, so a member added, renamed or
    dropped on either side fails the suite.
    """

    def __init__(self, **options: Any) -> None:
        """Use `create`; this only validates the toolset options."""
        super().__init__(**options)
        self._inner: Optional[DaytonaComputer] = None

    @classmethod
    async def create(
        cls,
        sandbox: Optional[Sandbox] = None,
        *,
        confirm: Any = None,
        configs: Any = None,
        tool_configs: Any = None,
        **driver_options: Any,
    ) -> AsyncDaytonaComputer:
        # Options first: a mistake in them raises before any sandbox exists.
        toolset = cls(confirm=confirm, configs=configs, tool_configs=tool_configs)
        # The inner driver's own pipeline is never used (its members are called directly), so its
        # confirm is a formality; this toolset's `confirm` is the one the SDK asks.
        toolset._inner = await anyio.to_thread.run_sync(
            partial(DaytonaComputer, sandbox, confirm=lambda _context: True, **driver_options)
        )
        return toolset

    @property
    def _computer(self) -> DaytonaComputer:
        if self._inner is None:
            raise RuntimeError(
                "build AsyncDaytonaComputer with `await AsyncDaytonaComputer.create()`"
            )
        return self._inner

    @property
    def sandbox(self) -> Sandbox:
        return self._computer.sandbox

    @property
    def width(self) -> int:
        return self._computer.width

    @property
    def height(self) -> int:
        return self._computer.height

    @override
    async def close(self) -> None:
        await super().close()
        inner, self._inner = self._inner, None
        if inner is not None:
            await anyio.to_thread.run_sync(inner.close)

    async def _run(self, member: Callable[..., T], *args: Any) -> T:
        return await anyio.to_thread.run_sync(partial(member, *args))

    @override
    async def screenshot(
        self, context: BetaToolsetCallContext, input: BetaComputerScreenshotInput
    ) -> BetaScreenshotResult:
        return await self._run(self._computer.screenshot, context, input)

    @override
    async def zoom(
        self, context: BetaToolsetCallContext, input: BetaComputerZoomInput
    ) -> BetaScreenshotResult:
        return await self._run(self._computer.zoom, context, input)

    @override
    async def cursor_position(
        self, context: BetaToolsetCallContext, input: BetaComputerCursorPositionInput
    ) -> BetaComputerCursorPositionResult:
        return await self._run(self._computer.cursor_position, context, input)

    @override
    async def mouse_move(
        self, context: BetaToolsetCallContext, input: BetaComputerMouseMoveInput
    ) -> None:
        await self._run(self._computer.mouse_move, context, input)

    @override
    async def left_click(
        self, context: BetaToolsetCallContext, input: BetaComputerLeftClickInput
    ) -> None:
        await self._run(self._computer.left_click, context, input)

    @override
    async def right_click(
        self, context: BetaToolsetCallContext, input: BetaComputerRightClickInput
    ) -> None:
        await self._run(self._computer.right_click, context, input)

    @override
    async def middle_click(
        self, context: BetaToolsetCallContext, input: BetaComputerMiddleClickInput
    ) -> None:
        await self._run(self._computer.middle_click, context, input)

    @override
    async def double_click(
        self, context: BetaToolsetCallContext, input: BetaComputerDoubleClickInput
    ) -> None:
        await self._run(self._computer.double_click, context, input)

    @override
    async def triple_click(
        self, context: BetaToolsetCallContext, input: BetaComputerTripleClickInput
    ) -> None:
        await self._run(self._computer.triple_click, context, input)

    @override
    async def left_click_drag(
        self, context: BetaToolsetCallContext, input: BetaComputerLeftClickDragInput
    ) -> None:
        await self._run(self._computer.left_click_drag, context, input)

    @override
    async def left_mouse_down(
        self, context: BetaToolsetCallContext, input: BetaComputerLeftMouseDownInput
    ) -> None:
        await self._run(self._computer.left_mouse_down, context, input)

    @override
    async def left_mouse_up(
        self, context: BetaToolsetCallContext, input: BetaComputerLeftMouseUpInput
    ) -> None:
        await self._run(self._computer.left_mouse_up, context, input)

    @override
    async def scroll(self, context: BetaToolsetCallContext, input: BetaComputerScrollInput) -> None:
        await self._run(self._computer.scroll, context, input)

    @override
    async def key(self, context: BetaToolsetCallContext, input: BetaComputerKeyInput) -> None:
        await self._run(self._computer.key, context, input)

    @override
    async def hold_key(
        self, context: BetaToolsetCallContext, input: BetaComputerHoldKeyInput
    ) -> None:
        await self._run(self._computer.hold_key, context, input)

    @override
    async def type(self, context: BetaToolsetCallContext, input: BetaComputerTypeInput) -> None:
        await self._run(self._computer.type, context, input)

    @override
    async def wait(self, context: BetaToolsetCallContext, input: BetaComputerWaitInput) -> None:
        await self._run(self._computer.wait, context, input)
