"""Daytona sandbox drivers for the Anthropic SDK's computer and browser toolsets.

- `DaytonaComputer` / `AsyncDaytonaComputer`: `computer_toolset_20260801` on a sandbox desktop
  (Daytona Computer Use API).
- `DaytonaBrowser`: `browser_toolset_20260801` on Chromium inside a sandbox, over CDP
  (needs the `browser` extra: `pip install 'daytona-toolsets[browser]'`).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .async_computer import AsyncDaytonaComputer
from .computer import DaytonaComputer

if TYPE_CHECKING:
    from .browser import DaytonaBrowser, DaytonaFilePolicy

__all__ = ["DaytonaComputer", "AsyncDaytonaComputer", "DaytonaBrowser", "DaytonaFilePolicy"]


def __getattr__(name: str) -> Any:
    # The browser driver imports Playwright, an optional dependency, so it loads on first use.
    if name in ("DaytonaBrowser", "DaytonaFilePolicy"):
        from . import browser

        return getattr(browser, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
