"""One open tab, and the console and network records the driver keeps for it.

A tab owns what the page tells it: the console lines and the request entries that Playwright's
events deliver while a member is waiting on the network, bounded per tab, and read back by
`read_console` and `read_network`. Keeping that here is what lets `browser.py` hold the tab map
and the members without also holding the bookkeeping.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Optional

from ._text import MAX_TEXT

if TYPE_CHECKING:  # Playwright is an optional dependency; `browser.py` reports a missing one
    from playwright.sync_api import CDPSession, Page, Request, Response

MAX_ENTRIES = 1000
"""Console and network entries kept per tab between reads; older ones are dropped."""


@dataclass
class Tab:
    id: str
    page: Page
    cdp: Optional[CDPSession] = None
    target_id: Optional[str] = None
    world: Optional[int] = None
    """The execution context id of the driver's isolated world in the current document."""
    title: str = ""
    console: deque[str] = field(default_factory=lambda: deque(maxlen=MAX_ENTRIES))
    network: dict[Request, dict[str, Any]] = field(default_factory=dict)
    dropped_console: int = 0
    dropped_network: int = 0

    # --- console ---------------------------------------------------------------------------

    def log(self, line: str) -> None:
        """Keep one console line, bounded, counting what the deque drops to make room."""
        if len(self.console) == self.console.maxlen:
            self.dropped_console += 1
        self.console.append(line[:MAX_TEXT])

    def take_console(self) -> str:
        """The lines since the last read, and how many were dropped before them."""
        lines = list(self.console)
        if self.dropped_console:
            lines.insert(0, f"[{self.dropped_console} earlier entries were dropped]")
        self.console.clear()
        self.dropped_console = 0
        return "\n".join(lines)

    # --- network ---------------------------------------------------------------------------

    def start_request(self, request: Request) -> None:
        """Record a request the page made, dropping the oldest entry when the tab is full."""
        if len(self.network) >= MAX_ENTRIES:
            self.network.pop(next(iter(self.network)))
            self.dropped_network += 1
        # The page chooses the URL and its length; `take_network` hands back up to MAX_ENTRIES of
        # them at once, so each is bounded like every other piece of page-supplied text.
        self.network[request] = {
            "method": request.method,
            "url": request.url[:MAX_TEXT],
            "status": "pending",
        }

    def answer_request(self, response: Response) -> None:
        entry = self.network.get(response.request)
        if entry is not None:
            entry["status"] = str(response.status)
            entry["type"] = response.headers.get("content-type", "").split(";")[0][:MAX_TEXT]

    def finish_request(self, request: Request, failure: Optional[str]) -> None:
        entry = self.network.get(request)
        if entry is None:
            return
        if failure is not None:
            entry["status"] = f"failed ({failure})"
        end = request.timing.get("responseEnd", -1)
        if end >= 0:
            entry["ms"] = round(end)

    def take_network(self) -> str:
        """The requests since the last read. Ones still in flight stay, so their outcome is not
        lost; everything settled is handed over once."""
        lines = [
            " ".join(
                part
                for part in (
                    entry["method"],
                    entry["status"],
                    entry.get("type", ""),
                    f"{entry['ms']}ms" if "ms" in entry else "",
                    entry["url"],
                )
                if part
            )
            for entry in self.network.values()
        ]
        if self.dropped_network:
            lines.insert(0, f"[{self.dropped_network} earlier requests were dropped]")
        self.network = {r: e for r, e in self.network.items() if e["status"] == "pending"}
        self.dropped_network = 0
        return "\n".join(lines)
