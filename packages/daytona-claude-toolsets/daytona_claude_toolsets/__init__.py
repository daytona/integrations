"""Daytona sandbox drivers for the Anthropic SDK's computer and browser toolsets.

- `DaytonaComputer` / `AsyncDaytonaComputer`: `computer_toolset_20260801` on a sandbox desktop
  (Daytona Computer Use API).
- `DaytonaBrowser`: `browser_toolset_20260801` on Chromium inside a sandbox, over CDP
  (needs the `browser` extra: `pip install 'daytona-claude-toolsets[browser]'`).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .async_computer import AsyncDaytonaComputer
from .computer import DaytonaComputer

if TYPE_CHECKING:
    from ._files import DaytonaFilePolicy

    # Re-exported under its own name: a type checker resolves
    # `daytona_claude_toolsets.DaytonaBrowser` through this, while `__all__` below leaves it
    # out of `import *` on purpose.
    from .browser import DaytonaBrowser as DaytonaBrowser

# `DaytonaBrowser` is deliberately not here. `import *` binds every name in `__all__`, which
# would load the browser driver and its Playwright import, so a computer-only install would get
# an ImportError instead of the names it can use. It stays available by name — `from
# daytona_claude_toolsets import DaytonaBrowser` — through `__getattr__` below, which is also what
# reports the missing extra.
__all__ = ["DaytonaComputer", "AsyncDaytonaComputer", "DaytonaFilePolicy"]


def __getattr__(name: str) -> Any:
    if name == "DaytonaFilePolicy":  # no Playwright needed to configure one
        from ._files import DaytonaFilePolicy

        return DaytonaFilePolicy
    # The browser driver imports Playwright, an optional dependency, so it loads on first use.
    if name == "DaytonaBrowser":
        from .browser import DaytonaBrowser

        return DaytonaBrowser
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
