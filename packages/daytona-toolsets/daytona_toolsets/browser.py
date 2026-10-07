"""`DaytonaBrowser`: the browser toolset (`browser_toolset_20260801`) on Chromium inside a Daytona
sandbox.

Chromium runs in the sandbox; the model loop, the API key and the toolset stay in your process and
drive it over the Chrome DevTools Protocol (CDP) with Playwright's `connect_over_cdp`, through a
signed Daytona preview URL for the debugging port. The signed URL is bound to that one port, lives
only long enough to connect (an established connection outlives it), and is revoked on `close()`.

Layout, deliberately one module. The SDK dispatches every browser member to a method on one
subclass of `BetaAbstractBrowserToolset20260801`, and those methods share mutable live state — the
tab map, the per-tab CDP sessions and isolated worlds, and the state changes queued for the next
report — that the Playwright event handlers write to while a member is waiting on the network.
Splitting the class across collaborators would mean threading that state between them for no
isolation gained. What does not need it lives next door, each testable on its own: starting
Chromium in the sandbox in `_chromium.py`, the sandbox lease in `_sandbox.py`, the file policy in
`_files.py`, one tab's console and network records in `_tabs.py`, the URL, ranking and
value-formatting vocabulary in `_text.py`, the key tables in `_keys.py`, the in-page JavaScript in
`_page_js.py`. Read what is left by its section banners: setup, events, helpers, then the members
in the toolset's own groups.
"""

from __future__ import annotations

import json
import logging
import posixpath
import secrets
import shlex
import time
from typing import Any, Literal, Optional, Union
from urllib.parse import urlsplit

import httpx
from anthropic.tools import ToolError, ToolsetConfigError
from anthropic.tools.browser import (
    BetaAbstractBrowserToolset20260801,
    BetaBrowserMemberResult,
    BetaBrowserNavigateResult,
    BetaBrowserState,
    BetaDialogDismissed,
    BetaLocalFilePolicy,
    BetaNavigationRefused,
    BetaScreenshotResult,
    BetaToolsetCallContext,
    BetaURLContext,
    TabMissingError,
)
from anthropic.types.beta import (
    BetaBrowserCloseTabInput,
    BetaBrowserMemberInput,
    BetaBrowserMemberName,
    BetaBrowserCoordinateTarget,
    BetaBrowserDoubleClickInput,
    BetaBrowserFileUploadInput,
    BetaBrowserFindInput,
    BetaBrowserFormInputInput,
    BetaBrowserGetPageTextInput,
    BetaBrowserHoldKeyInput,
    BetaBrowserHoverInput,
    BetaBrowserJavascriptExecInput,
    BetaBrowserKeyInput,
    BetaBrowserLeftClickDragInput,
    BetaBrowserLeftClickInput,
    BetaBrowserLeftMouseDownInput,
    BetaBrowserLeftMouseUpInput,
    BetaBrowserListTabsInput,
    BetaBrowserMiddleClickInput,
    BetaBrowserMouseMoveInput,
    BetaBrowserNavigateInput,
    BetaBrowserNewTabInput,
    BetaBrowserReadConsoleInput,
    BetaBrowserReadNetworkInput,
    BetaBrowserReadPageInput,
    BetaBrowserRefTarget,
    BetaBrowserRightClickInput,
    BetaBrowserScreenshotInput,
    BetaBrowserScrollInput,
    BetaBrowserScrollToInput,
    BetaBrowserStateTabEntryParam,
    BetaBrowserSwitchTabInput,
    BetaBrowserTripleClickInput,
    BetaBrowserTypeInput,
    BetaBrowserWaitInput,
    BetaBrowserZoomInput,
)
from daytona import Daytona, Sandbox
from typing_extensions import override

from . import _chromium, _page_js
from ._files import DaytonaFilePolicy as DaytonaFilePolicy, is_under
from ._keys import parse_chord, playwright_chord, split_sequence, PLAYWRIGHT
from ._sandbox import CreateParams, OnClose, SandboxLease
from ._tabs import Tab
from ._text import (
    MAX_TEXT as MAX_TEXT,
    failure_phrase as failure_phrase,
    format_remote as format_remote,
    normalize_url as normalize_url,
    rank as rank,
)

try:
    from playwright.sync_api import (
        Browser,
        BrowserContext,
        CDPSession,
        ConsoleMessage,
        Dialog,
        Error as PlaywrightError,
        Frame,
        Page,
        Playwright,
        Request,
        Response,
        Route,
        TimeoutError as PlaywrightTimeoutError,
        WebSocketRoute,
        sync_playwright,
    )
except ImportError as exc:  # pragma: no cover - depends on the environment
    raise ImportError(
        "DaytonaBrowser needs Playwright: pip install 'daytona-toolsets[browser]'"
    ) from exc

log = logging.getLogger("daytona_toolsets")

MAX_TABS = 100
MAX_DURATION = 30.0
MAX_REPEAT = 100
FIND_LIMIT = 20
WHEEL_NOTCH = 100
"""Pixels one scroll-wheel notch moves."""
SCRIPT_TIMEOUT = 10.0
"""Seconds a `javascript_exec` script may run before the page terminates it."""
KEEP_ALIVE = 45.0
"""The longest the sandbox may go unheard from while the browser is in use. Under Daytona's
shortest auto-stop interval (one minute) with room for the round trip, and counted across a
member's own wait, not just between calls."""

PLAYWRIGHT_MODIFIERS = {"ctrl": "Control", "alt": "Alt", "shift": "Shift", "cmd": "Meta"}

Button = Literal["left", "middle", "right"]


class DaytonaBrowser(BetaAbstractBrowserToolset20260801):
    """The browser toolset, driving Chromium inside a Daytona sandbox over CDP.

    Pass an existing `sandbox` (never stopped or deleted; the Chromium the driver started in it is
    stopped on `close()`), or leave it out and the driver creates one from `create_params`
    (Daytona's default snapshot, which ships Chromium) and deletes it on `close()`, or stops it with
    `on_close="stop"`.

    Keyword arguments not listed here are the SDK's toolset options (`url_policy`, `file_policy`,
    `confirm`, `configs`, `tool_configs`) and are passed on unchanged. A `url_policy` is also applied
    to every request the pages make (`member=None`); a page-started navigation it refuses reaches the
    model as a refused navigation. `file_policy` must be a `DaytonaFilePolicy` or your own
    `BetaFilePolicy` for sandbox paths: `BetaLocalFilePolicy` is refused.

    Use it from one thread: Playwright's sync API is bound to the thread that started it, and cannot
    run inside an asyncio event loop.

    It is one large class on purpose. The SDK dispatches every member of `browser_toolset_20260801`
    to a method it looks up on this class (`anthropic.lib.tools._toolsets._base.overridden`: a
    member it does not find here is sent to the model as `enabled: False`), and those methods share
    one piece of mutable live state — the tab map, each tab's CDP session and isolated world, the
    signed preview URL, and the changes queued for the next `browser_state` — which Playwright's
    event handlers write to while a member is waiting on the network. Collaborators would have to
    be handed that same state, so the class would be no smaller and the state no better isolated.
    Everything that does not need it already lives in its own module; see the module docstring for
    the list.

    Args:
        sandbox: A running Daytona sandbox with Chromium on `PATH` (Daytona's default snapshot).
        daytona: The client used to create a sandbox; `Daytona()` when omitted.
        create_params: How to create the sandbox when none is passed. Its `domain_allow_list` /
            `network_allow_list` / `network_block_all` are the browser's egress policy.
        on_close: What `close()` does to a sandbox the driver created: `"delete"` or `"stop"`.
        viewport: The page size in CSS pixels, which is also the screenshot size (at most
            1920x1200, inside the API's image limits).
        headless: Run Chromium headless. `False` shows it on the sandbox desktop (VNC).
        chromium: The Chromium binary in the sandbox.
        navigation_timeout: Seconds `navigate` waits for the new document.
        settle_delay: Seconds an input waits for the page to react before the call returns.
    """

    def __init__(
        self,
        sandbox: Optional[Sandbox] = None,
        *,
        daytona: Optional[Daytona] = None,
        create_params: Optional[CreateParams] = None,
        on_close: OnClose = "delete",
        viewport: tuple[int, int] = (1280, 800),
        headless: bool = True,
        chromium: str = "chromium",
        navigation_timeout: float = 30.0,
        settle_delay: float = 0.3,
        create_timeout: float = 120,
        **options: Any,
    ) -> None:
        if isinstance(options.get("file_policy"), BetaLocalFilePolicy):
            raise ToolsetConfigError(
                "BetaLocalFilePolicy checks paths on this machine, but the browser runs in a Daytona "
                "sandbox; pass a DaytonaFilePolicy"
            )
        width, height = viewport
        if not (0 < width <= 1920 and 0 < height <= 1200):
            raise ValueError("viewport must be at most 1920x1200 (screenshots are the viewport)")
        # Kept for request interception, which applies the same policy to what pages request.
        # Presence, not `is None`: the SDK's default is `NOT_GIVEN`, so leaving `url_policy` out
        # means navigate is unchecked and nothing is intercepted — pages load as they would
        # without a policy at all. Passing `url_policy=None` explicitly is a value the SDK does
        # treat as a policy, and one that refuses every navigation it is asked about, so
        # interception matches it by refusing every page request.
        self._url_policy = options.get("url_policy")
        self._has_url_policy = "url_policy" in options
        self._session_id = f"daytona-toolsets-{secrets.token_hex(4)}"
        self._profile = f"/tmp/{self._session_id}-profile"
        self._download_dir = f"/tmp/{self._session_id}-downloads"
        policy = options.get("file_policy")
        if isinstance(policy, DaytonaFilePolicy):
            # Bind where this browser actually downloads to, so a policy that named no directory
            # can still expose paths, and so the SDK's render-time check of the same hook is
            # answered by the policy this driver asks. A copy, never this one: a caller may share
            # a policy between browsers.
            policy = options["file_policy"] = policy.for_download_dir(self._download_dir)
            self._download_dir = policy.download_dir or self._download_dir
        super().__init__(**options)

        self._policy: Any = policy
        """The file policy as configured, of whatever class, for the download-path check."""
        self._file_policy = policy if isinstance(policy, DaytonaFilePolicy) else None
        self._viewport = viewport
        self._navigation_ms = navigation_timeout * 1000
        self._settle_ms = settle_delay * 1000
        self._lease: Optional[SandboxLease] = None
        self._playwright: Optional[Playwright] = None
        self._browser: Optional[Browser] = None
        self._context: Optional[BrowserContext] = None
        self._browser_cdp: Optional[CDPSession] = None
        self._signed: Optional[tuple[int, str]] = None
        self._tabs: dict[str, Tab] = {}
        self._by_page: dict[Page, str] = {}
        self._recent: list[str] = []
        """Tab ids, most recently active last."""
        self._active: Optional[str] = None
        self._next_tab = 1
        self._changes: list[Any] = []
        self._downloads: dict[str, str] = {}
        self._refused_tabs: set[str] = set()
        """Tabs a page-started navigation left on an address the url policy refuses."""
        self._navigating = False
        self._disconnected = False
        self._last_activity = time.monotonic()
        """When the sandbox last saw something Daytona counts as activity. Construction does."""
        try:
            self._lease = SandboxLease.acquire(
                sandbox,
                daytona=daytona,
                create_params=create_params,
                default_env={},
                on_close=on_close,
                create_timeout=create_timeout,
            )
            port = self._launch(chromium, headless)
            self._connect(port)
        except BaseException:
            self.close()
            raise

    @property
    def sandbox(self) -> Sandbox:
        """The sandbox Chromium runs in."""
        if self._lease is None:
            raise RuntimeError("this DaytonaBrowser is closed")
        return self._lease.sandbox

    @property
    def download_dir(self) -> str:
        """Where downloads are saved, inside the sandbox."""
        return self._download_dir

    @override
    def close(self) -> None:
        """Disconnect, stop Chromium and release the sandbox: delete (or stop) it if the driver
        created it. Safe to call more than once, and after a failed construction."""
        super().close()
        browser, self._browser = self._browser, None
        playwright, self._playwright = self._playwright, None
        self._context = self._browser_cdp = None
        for step in (
            (lambda: browser.close()) if browser is not None else None,
            (lambda: playwright.stop()) if playwright is not None else None,
        ):
            if step is not None:
                try:
                    step()
                except Exception as exc:  # the connection may be gone already
                    log.debug("browser close step failed: %s", type(exc).__name__)
        lease, self._lease = self._lease, None
        if lease is None:
            return
        signed, self._signed = self._signed, None
        if signed is not None:
            try:
                lease.sandbox.expire_signed_preview_url(signed[0], signed[1])
            except Exception as exc:
                log.debug("could not revoke the preview URL: %s", type(exc).__name__)
        if not lease.owned:
            try:
                lease.sandbox.process.exec(
                    f"pkill -f -- {shlex.quote('--user-data-dir=' + self._profile)}; "
                    f"rm -rf -- {shlex.quote(self._profile)}"
                )
                lease.sandbox.process.delete_session(self._session_id)
            except Exception as exc:
                log.debug("could not stop Chromium in the sandbox: %s", type(exc).__name__)
        lease.release()

    # --- setup -----------------------------------------------------------------------------------

    def _launch(self, chromium: str, headless: bool) -> int:
        """Start Chromium in the sandbox and return the debugging port it bound."""
        sandbox = self.sandbox
        if str(getattr(sandbox.state, "value", sandbox.state)) != "started":
            sandbox.start()
        if not headless:
            computer_use = sandbox.computer_use
            if computer_use.get_status().status != "active":
                computer_use.start()
        return _chromium.launch(
            sandbox,
            chromium=chromium,
            headless=headless,
            session_id=self._session_id,
            profile=self._profile,
            download_dir=self._download_dir,
            viewport=self._viewport,
        )

    def _connect(self, port: int) -> None:
        """Connect Playwright over a signed preview URL for the debugging port, then open the first
        tab in a fresh browser context."""
        signed = self.sandbox.create_signed_preview_url(port, expires_in_seconds=120)
        self._signed = (port, signed.token)
        try:
            base = signed.url.rstrip("/")
            version = httpx.get(f"{base}/json/version", timeout=30).raise_for_status().json()
            path = urlsplit(str(version["webSocketDebuggerUrl"])).path
            self._playwright = sync_playwright().start()
            browser = self._playwright.chromium.connect_over_cdp(
                "wss://" + urlsplit(base).netloc + path, timeout=30000
            )
        except Exception:
            # The signed URL is a credential: its text stays out of the error and the traceback.
            raise RuntimeError("could not connect to Chromium in the sandbox over CDP") from None
        self._browser = browser
        browser.on("disconnected", lambda _browser: self._on_disconnected())
        width, height = self._viewport
        context = browser.new_context(
            viewport={"width": width, "height": height},
            service_workers="block",  # service-worker requests would bypass request interception
            accept_downloads=True,
        )
        self._context = context
        context.on("page", self._on_page)
        context.on("dialog", self._on_dialog)
        context.on("console", self._on_console)
        context.on(
            "weberror", lambda error: self._log_console(error.page, f"[error] {error.error}")
        )
        context.on("request", self._on_request)
        context.on("response", self._on_response)
        context.on("requestfinished", lambda request: self._finish_request(request, None))
        context.on("requestfailed", lambda request: self._finish_request(request, request.failure))
        self._install_interception(context)
        page = context.new_page()
        self._on_page(page)
        tab = self._tabs[self._by_page[page]]
        info = self._cdp(tab).send("Target.getTargetInfo")["targetInfo"]
        browser_cdp = browser.new_browser_cdp_session()
        self._browser_cdp = browser_cdp
        browser_cdp.on("Browser.downloadWillBegin", self._on_download_begin)
        browser_cdp.on("Browser.downloadProgress", self._on_download_progress)
        # Downloads land in the sandbox, reported through this session's events: Playwright's own
        # download objects cannot reach a file on a remote browser.
        browser_cdp.send(
            "Browser.setDownloadBehavior",
            {
                "behavior": "allowAndName",
                "browserContextId": info["browserContextId"],
                "downloadPath": self._download_dir,
                "eventsEnabled": True,
            },
        )
        self._changes.clear()  # the first tab was not opened by a call

    # --- events (they run while Playwright waits on the network) ---------------------------------

    def _on_page(self, page: Page) -> None:
        if page in self._by_page:
            return
        if len(self._tabs) >= MAX_TABS:
            try:
                page.close()
            except PlaywrightError:
                pass
            return
        tab_id = f"tab_{self._next_tab}"
        self._next_tab += 1
        self._tabs[tab_id] = Tab(id=tab_id, page=page)
        self._by_page[page] = tab_id
        page.on("close", self._forget)
        page.on("framenavigated", self._on_navigated)
        self._changes.append({"type": "tab_opened", "tab_id": tab_id})
        self._activate(tab_id)  # a new tab or popup takes focus, as in a desktop browser

    def _forget(self, page: Page) -> None:
        tab_id = self._by_page.pop(page, None)
        if tab_id is None:
            return
        self._tabs.pop(tab_id, None)
        if tab_id in self._recent:
            self._recent.remove(tab_id)
        if self._active == tab_id:
            self._active = self._recent[-1] if self._recent else None

    def _activate(self, tab_id: str) -> None:
        if tab_id in self._recent:
            self._recent.remove(tab_id)
        self._recent.append(tab_id)
        self._active = tab_id

    def _on_disconnected(self) -> None:
        self._disconnected = True

    def _on_dialog(self, dialog: Dialog) -> None:
        """Dismiss every native dialog so none hangs the tab, and tell the model the page asked. A
        `beforeunload` prompt is accepted instead, so the navigation or close the model asked for
        goes ahead."""
        try:
            if dialog.type == "beforeunload":
                dialog.accept()
                return
            # The message is the page's text, as long as the page cares to make it: bounded here
            # like every other page-supplied text the driver keeps.
            self._changes.append(
                BetaDialogDismissed(kind=dialog.type, message=dialog.message[:MAX_TEXT])
            )
            dialog.dismiss()
        except PlaywrightError as exc:  # the page went away first
            log.debug("dialog handling failed: %s", type(exc).__name__)

    def _tab_of(self, page: Optional[Page]) -> Optional[Tab]:
        tab_id = self._by_page.get(page) if page is not None else None
        return self._tabs.get(tab_id) if tab_id is not None else None

    def _log_console(self, page: Optional[Page], line: str) -> None:
        tab = self._tab_of(page)
        if tab is not None:
            tab.log(line)

    def _on_console(self, message: ConsoleMessage) -> None:
        self._log_console(message.page, f"[{message.type}] {message.text}")

    def _request_tab(self, request: Request) -> Optional[Tab]:
        try:
            return self._tab_of(request.frame.page)
        except PlaywrightError:  # a service worker's request has no frame
            return None

    def _on_request(self, request: Request) -> None:
        tab = self._request_tab(request)
        if tab is not None:
            tab.start_request(request)

    def _on_response(self, response: Response) -> None:
        tab = self._request_tab(response.request)
        if tab is not None:
            tab.answer_request(response)

    def _finish_request(self, request: Request, failure: Optional[str]) -> None:
        tab = self._request_tab(request)
        if tab is not None:
            tab.finish_request(request, failure)

    def _on_navigated(self, frame: Frame) -> None:
        """A navigation the page started itself, landing where the URL policy does not allow.

        Interception sees first hops only, and `navigate`'s own check covers that member alone,
        so a click or a script that reaches an allowed address which then redirects would
        otherwise leave the model reading a page the policy bars. The tab is only marked here —
        an event handler runs while Playwright is waiting and must not call back into it — and
        is taken off the page before the next member runs."""
        if self._navigating or not self._has_url_policy:
            return
        try:
            if frame.parent_frame is not None:
                return  # a sub-frame is not what the model reads as "the page"
            tab, url = self._tab_of(frame.page), frame.url
        except PlaywrightError:
            return  # the page went away meanwhile
        if tab is None or url in ("", "about:blank") or not self._refuses(url, tab.id):
            return
        self._refused_tabs.add(tab.id)
        self._changes.append(BetaNavigationRefused())

    def _leave_refused_pages(self) -> None:
        """Take every tab `_on_navigated` marked back to a blank page. Never raises."""
        while self._refused_tabs:
            tab = self._tabs.get(self._refused_tabs.pop())
            if tab is not None:
                self._blank(tab)

    def _blank(self, tab: Tab) -> None:
        """Leave a page the URL policy refuses, without reporting a second refusal for it."""
        self._navigating = True
        try:
            tab.page.goto("about:blank", wait_until="commit", timeout=self._navigation_ms)
        except Exception as exc:
            log.debug("could not leave a page the url policy refused: %s", type(exc).__name__)
        finally:
            self._navigating = False
            self._refused_tabs.discard(tab.id)
            tab.world = None

    def _install_interception(self, context: BrowserContext) -> None:
        """Apply the URL policy to everything a page reaches for, not only what `route` sees.

        Ordinary requests and WebSocket handshakes are two separate Playwright hooks, so both are
        registered; with no `url_policy` neither is, and pages load as they would without one."""
        if not self._has_url_policy:
            return
        context.route("**/*", self._guard)
        context.route_web_socket("**/*", self._guard_websocket)

    def _refuses(self, url: str, tab_id: Optional[str]) -> bool:
        """Whether the URL policy refuses an address a page reached for, failing closed."""
        policy = self._url_policy
        if policy is None:
            return True  # url_policy=None refuses everything, as the SDK treats navigate
        try:
            policy(BetaURLContext(member=None, tab_id=tab_id), url)
        except ToolError:
            return True
        except Exception as exc:  # the policy failed: fail closed
            log.warning("url_policy raised %s on a page request; refused it", type(exc).__name__)
            return True
        return False

    def _guard_websocket(self, route: WebSocketRoute) -> None:
        """The URL policy applied to a WebSocket a page opens.

        Playwright's request interception never sees a handshake, so without this a page could
        hold a socket open to an address every ordinary request to it is refused. An allowed one
        is connected straight through, with messages forwarded in both directions as if the route
        were not there; a refused one is closed with the WebSocket policy-violation code and never
        reaches the network. Sockets opened by a shared worker are still outside this, as are the
        redirect hops of an ordinary request; the sandbox's network tier is the backstop."""
        if not self._refuses(route.url, None):
            route.connect_to_server()
            return
        log.debug("url_policy refused a WebSocket a page opened")
        route.close(code=1008, reason="Policy violation")

    def _guard(self, route: Route) -> None:
        """Request interception: the URL policy applied to every request a page makes.

        First hops only: Playwright continues a redirected request itself rather than routing it
        again, so a `302` from an allowed address is not asked about here. `navigate` closes that
        for the document by checking where the page landed; a sub-resource's chain is not
        checked, and the sandbox's network tier is the backstop."""
        request = route.request
        tab = self._request_tab(request)
        refused = self._refuses(request.url, tab.id if tab else None)
        try:
            if not refused:
                route.continue_()
                return
            route.abort("blockedbyclient")
        except PlaywrightError:
            return  # the page went away meanwhile
        try:
            top_level = request.is_navigation_request() and request.frame.parent_frame is None
        except PlaywrightError:
            top_level = False
        if top_level and not self._navigating:
            self._changes.append(BetaNavigationRefused())

    def _on_download_begin(self, event: dict[str, Any]) -> None:
        guid, url = str(event.get("guid", "")), str(event.get("url", ""))
        self._downloads[guid] = url
        self._changes.append({"type": "download_started", "download_id": guid, "url": url})

    def _path_visible(self, path: str) -> bool:
        """Whether the file policy shows the model where a completed download was saved.

        Only `True` shows it, and anything the policy raises hides it, matching the SDK's own check
        of the same hook. The driver asks before it records the path, so a path the policy does not
        expose is never held in a change at all — `expose_download_paths=False` is what the
        `DaytonaFilePolicy` docstring and the README promise, and the SDK's check at render time
        cannot cover a change this driver still holds when a call fails or `close()` runs."""
        policy = self._policy
        if policy is None:
            return False
        try:
            return bool(policy.is_path_visible(path) is True)
        except Exception as exc:  # fail closed: a policy that cannot answer hides the path
            log.debug("the file policy could not judge a download path: %s", type(exc).__name__)
            return False

    def _on_download_progress(self, event: dict[str, Any]) -> None:
        guid = str(event.get("guid", ""))
        state = event.get("state")
        if guid not in self._downloads or state == "inProgress":
            return
        url = self._downloads.pop(guid)
        if state == "completed":
            change: dict[str, Any] = {
                "type": "download_completed",
                "download_id": guid,
                "url": url,
                "size_bytes": int(event.get("receivedBytes") or 0),
            }
            path = posixpath.join(self._download_dir, guid)
            if self._path_visible(path):
                change["path"] = path
            self._changes.append(change)
        else:
            self._changes.append(
                {
                    "type": "download_failed",
                    "download_id": guid,
                    "url": url,
                    "error": "The download was cancelled or failed.",
                }
            )

    # --- helpers ---------------------------------------------------------------------------------

    def _tab(self, tab_id: Optional[str]) -> Tab:
        if self._disconnected or self._context is None:
            raise ToolError("The browser in the sandbox is no longer connected.")
        if tab_id is None:
            if self._active is None:
                raise ToolError("No tab is open; open one with new_tab.")
            tab_id = self._active
        tab = self._tabs.get(tab_id)
        if tab is None:
            raise TabMissingError()
        return tab

    def _cdp(self, tab: Tab) -> CDPSession:
        if tab.cdp is None:
            assert self._context is not None
            tab.cdp = self._context.new_cdp_session(tab.page)
        return tab.cdp

    def _target_id(self, tab: Tab) -> str:
        if tab.target_id is None:
            tab.target_id = str(
                self._cdp(tab).send("Target.getTargetInfo")["targetInfo"]["targetId"]
            )
        return tab.target_id

    def _in_world(self, tab: Tab, function: str, *args: object, by_value: bool = True) -> Any:
        """Call the driver's in-page toolkit in its isolated world, creating the world (and
        installing the toolkit) for a new document."""
        cdp = self._cdp(tab)
        for attempt in range(2):
            if tab.world is None:
                frame_id = cdp.send("Page.getFrameTree")["frameTree"]["frame"]["id"]
                tab.world = int(
                    cdp.send(
                        "Page.createIsolatedWorld",
                        {"frameId": frame_id, "worldName": "daytona-toolsets"},
                    )["executionContextId"]
                )
                cdp.send(
                    "Runtime.evaluate", {"expression": _page_js.TOOLKIT, "contextId": tab.world}
                )
            try:
                result = cdp.send(
                    "Runtime.evaluate",
                    {
                        "expression": _page_js.call(function, *args),
                        "contextId": tab.world,
                        "returnByValue": by_value,
                    },
                )
            except PlaywrightError as exc:
                if attempt == 0 and "context" in str(exc).lower():
                    tab.world = None  # the document changed: a fresh world for the new one
                    continue
                raise
            if "exceptionDetails" in result:
                if attempt == 0:
                    tab.world = None
                    continue
                raise ToolError("The page could not be read.")
            remote = result["result"]
            return remote.get("value") if by_value else remote
        raise ToolError("The page could not be read.")

    def _stale(self, ref: str) -> ToolError:
        return ToolError(f"Unknown or stale ref {ref}; call read_page or find for current refs.")

    def _point(
        self, tab: Tab, target: Union[BetaBrowserCoordinateTarget, BetaBrowserRefTarget]
    ) -> tuple[float, float]:
        """A target as a viewport point: a coordinate, checked against the viewport, or the centre
        of a referenced element, scrolled into view."""
        if isinstance(target, BetaBrowserRefTarget):
            result = self._in_world(tab, "center", target.ref) or {}
            if result.get("error") == "invisible":
                raise ToolError(f"The element {target.ref} is not visible.")
            if "x" not in result:
                raise self._stale(target.ref)
            return float(result["x"]), float(result["y"])
        width, height = self._viewport
        if not (0 <= target.x < width and 0 <= target.y < height):
            raise ToolError(f"({target.x}, {target.y}) is outside the {width}x{height} viewport.")
        return float(target.x), float(target.y)

    def _modifiers(self, text: Optional[str]) -> list[str]:
        if not text:
            return []
        modifiers, token = parse_chord(text.strip())
        if token is not None:
            raise ToolError("modifiers takes modifier keys only, such as shift or ctrl+shift.")
        return [PLAYWRIGHT_MODIFIERS[modifier] for modifier in modifiers]

    def _settle(self, tab: Tab) -> None:
        # Waited on the page, not with time.sleep, so dialogs and popups are handled meanwhile.
        try:
            tab.page.wait_for_timeout(self._settle_ms)
        except PlaywrightError:
            pass  # the action closed the tab

    def _click(
        self,
        tab_id: Optional[str],
        target: Union[BetaBrowserCoordinateTarget, BetaBrowserRefTarget],
        modifiers: Optional[str],
        button: Button = "left",
        count: int = 1,
    ) -> None:
        tab = self._tab(tab_id)
        held = self._modifiers(modifiers)
        x, y = self._point(tab, target)
        keyboard = tab.page.keyboard
        for key in held:
            keyboard.down(key)
        try:
            tab.page.mouse.click(x, y, button=button, click_count=count)
        finally:
            for key in reversed(held):
                keyboard.up(key)
        self._settle(tab)

    def _screenshot(
        self, tab: Tab, clip: Optional[dict[str, float]] = None
    ) -> BetaScreenshotResult:
        params: dict[str, Any] = {"format": "png"}
        if clip is not None:
            params["clip"] = clip
        data = self._cdp(tab).send("Page.captureScreenshot", params)["data"]
        return BetaScreenshotResult(data=str(data), media_type="image/png")

    def _entry(self, tab: Tab, titles: dict[str, tuple[str, str]]) -> BetaBrowserStateTabEntryParam:
        url = tab.page.url
        title = tab.title
        if tab.target_id is not None and tab.target_id in titles:
            title, url = titles[tab.target_id]
            tab.title = title
        return {"tab_id": tab.id, "title": title, "url": url, "active": tab.id == self._active}

    def _targets(self) -> dict[str, tuple[str, str]]:
        """Every page's title and URL in one CDP round trip."""
        if self._browser_cdp is None or self._disconnected:
            return {}
        infos = self._browser_cdp.send("Target.getTargets")["targetInfos"]
        return {
            str(info["targetId"]): (str(info.get("title", "")), str(info.get("url", "")))
            for info in infos
            if info.get("type") == "page"
        }

    # --- browser state ---------------------------------------------------------------------------

    def _keep_alive(self, reserve: float = 0.0) -> None:
        """Tell Daytona the sandbox is in use, at most once every `KEEP_ALIVE` seconds.

        Daytona's auto-stop (and auto-pause) counts interactions made through the SDK and
        explicitly not traffic through a preview URL — which, once Chromium is up, is everything
        this driver sends: clicks, screenshots and page reads all ride the CDP connection. A long
        browsing session would look idle and the sandbox would be stopped underneath it.

        `reserve` is how long the caller is about to be busy without being able to say anything.
        Counting it in is what keeps the quiet window at `KEEP_ALIVE` rather than `KEEP_ALIVE`
        plus a whole member: a refresh that would otherwise be skipped as too recent happens now,
        before the wait, so a sandbox on Daytona's shortest auto-stop interval (one minute) is not
        stopped in the middle of a navigation.

        Refreshing the activity timestamp is all this does, so a borrowed sandbox keeps whatever
        auto-stop interval its owner chose, and an owned one keeps Daytona's default as the
        backstop against a leaked sandbox. A failure here is never worth failing a call for."""
        now = time.monotonic()
        if now - self._last_activity + reserve < KEEP_ALIVE:
            return
        self._last_activity = now
        try:
            self.sandbox.refresh_activity()
        except Exception as exc:
            log.debug("could not refresh the sandbox activity: %s", type(exc).__name__)

    @override
    def execute(
        self,
        context: BetaToolsetCallContext,
        name: BetaBrowserMemberName,
        input: BetaBrowserMemberInput,
    ) -> BetaBrowserMemberResult:
        """Every member, with the sandbox told it is in use before the member runs as well as
        after it (`_browser_state`).

        A member is itself bounded — `navigation_timeout` for a navigation, `MAX_DURATION` for
        `wait` and `hold_key`, ten seconds for a script — and that bound is reserved here, so the
        refresh happens before a member that could outlast the remaining quiet budget rather than
        after it. The sandbox is therefore never left unheard from for longer than `KEEP_ALIVE`,
        however long the browsing session runs. The one case left is a `navigation_timeout` set
        longer than the sandbox's own auto-stop interval: a single navigation can then outlast it
        whatever this does."""
        self._keep_alive(reserve=self._member_bound())
        self._leave_refused_pages()
        return super().execute(context, name, input)

    def _member_bound(self) -> float:
        """The longest any one member can keep the driver busy before it can speak again."""
        return (
            max(self._navigation_ms / 1000, MAX_DURATION, SCRIPT_TIMEOUT) + self._settle_ms / 1000
        )

    @override
    def _browser_state(self, context: BetaToolsetCallContext) -> BetaBrowserState:
        """Every open tab, exactly one active, and the changes since the last report. Never raises:
        a browser that stopped answering is reported from what the driver last knew."""
        self._keep_alive()  # after the member, as `execute` did before it
        self._leave_refused_pages()
        try:
            for tab in list(self._tabs.values()):
                if tab.target_id is None and not self._disconnected:
                    self._target_id(tab)
            titles = self._targets()
        except Exception as exc:
            log.debug("could not read the tab titles: %s", type(exc).__name__)
            titles = {}
        if self._active not in self._tabs:
            self._active = self._recent[-1] if self._recent else next(iter(self._tabs), None)
        tabs = [self._entry(tab, titles) for tab in list(self._tabs.values())[:MAX_TABS]]
        # Drained last: events (a popup's tab_opened) arrive during the round trips above, and a
        # change must go out with the first report whose tabs include what it describes.
        changes, self._changes = self._changes, []
        return BetaBrowserState(tabs=tabs, state_changes=changes)

    # --- navigation ------------------------------------------------------------------------------

    @override
    def navigate(
        self, context: BetaToolsetCallContext, input: BetaBrowserNavigateInput
    ) -> BetaBrowserNavigateResult:
        tab = self._tab(input.tab_id)
        page = tab.page
        before = page.url
        self._navigating = True
        try:
            if input.url in ("back", "forward", "reload"):
                history = {"back": page.go_back, "forward": page.go_forward, "reload": page.reload}
                # Wait for the commit, then for the document: a history entry can be restored
                # without a new DOMContentLoaded.
                response = history[input.url](wait_until="commit", timeout=self._navigation_ms)
                if response is None and input.url != "reload" and page.url == before:
                    raise ToolError(f"There is no page to go {input.url} to.")
                try:
                    page.wait_for_load_state("domcontentloaded", timeout=self._navigation_ms)
                except PlaywrightTimeoutError:
                    pass  # committed; the model reads the page as it is
            else:
                response = page.goto(
                    normalize_url(input.url),
                    wait_until="domcontentloaded",
                    timeout=self._navigation_ms,
                )
        except PlaywrightTimeoutError:
            raise ToolError(
                f"The page did not load within {self._navigation_ms / 1000:g} seconds."
            ) from None
        except PlaywrightError as exc:
            if "Download is starting" not in str(exc):
                raise ToolError(failure_phrase(exc)) from None
            response = None  # the address is a download, reported in the browser state
        finally:
            self._navigating = False
        tab.world = None
        self._check_where_it_landed(tab, before)
        return BetaBrowserNavigateResult(
            url=page.url,
            status=response.status if response is not None else None,
            title=(safe_title(page) or None),
        )

    def _check_where_it_landed(self, tab: Tab, before: str) -> None:
        """Refuse a navigation that redirected onto an address the URL policy does not allow.

        Request interception only ever sees the first hop: Playwright continues a redirected
        request itself instead of handing it to the route handler, so an allowed address that
        answers `302` can walk the page anywhere. Asking the policy once more about where the
        page actually ended closes that for the document, which is what decides what the model
        then reads. A sub-resource's redirect chain is still unchecked, and so is a redirect a
        page triggers for itself later; the sandbox's network tier is the backstop for those."""
        landed = tab.page.url
        if not self._has_url_policy or landed in (before, "about:blank"):
            return
        if not self._refuses(landed, tab.id):
            return
        self._blank(tab)
        raise ToolError(
            "The navigation was refused: it redirected to an address that is not allowed."
        )

    # --- seeing ----------------------------------------------------------------------------------

    @override
    def screenshot(
        self, context: BetaToolsetCallContext, input: BetaBrowserScreenshotInput
    ) -> BetaScreenshotResult:
        return self._screenshot(self._tab(input.tab_id))

    @override
    def zoom(
        self, context: BetaToolsetCallContext, input: BetaBrowserZoomInput
    ) -> BetaScreenshotResult:
        tab = self._tab(input.tab_id)
        x0, y0, x1, y1 = input.region
        width, height = self._viewport
        if not (0 <= x0 < x1 <= width and 0 <= y0 < y1 <= height):
            raise ToolError(
                f"region must satisfy 0 <= x0 < x1 <= {width} and 0 <= y0 < y1 <= {height} "
                "(viewport pixels)."
            )
        # Rendered at a higher scale rather than upscaled, so the detail is real. CDP clips in
        # document coordinates, so the scroll offset is added.
        scroll = tab.page.evaluate("[window.scrollX, window.scrollY]")
        scale = min(width / (x1 - x0), height / (y1 - y0), 8.0)
        clip = {
            "x": x0 + float(scroll[0]),
            "y": y0 + float(scroll[1]),
            "width": float(x1 - x0),
            "height": float(y1 - y0),
            "scale": scale,
        }
        return self._screenshot(tab, clip)

    @override
    def read_page(self, context: BetaToolsetCallContext, input: BetaBrowserReadPageInput) -> str:
        tab = self._tab(input.tab_id)
        depth = 15 if input.depth is None else input.depth
        if depth < 1:
            raise ToolError("depth must be at least 1.")
        options = {
            "ref": input.ref,
            "depth": depth,
            "all": input.filter == "all",
            "interactive": input.filter == "interactive",
        }
        result = self._in_world(tab, "readPage", options) or {}
        if result.get("error") == "stale" and input.ref:
            raise self._stale(input.ref)
        return str(result.get("text", ""))

    @override
    def find(self, context: BetaToolsetCallContext, input: BetaBrowserFindInput) -> str:
        """Keyword matching over the page's elements (their role, name and attributes), not a
        semantic search: this driver has no model of its own."""
        tab = self._tab(input.tab_id)
        candidates = self._in_world(tab, "candidates") or []
        matches = rank(input.query, candidates)[:FIND_LIMIT]
        if not matches:
            return f"No element matched {json.dumps(input.query)}. Try read_page."
        return "\n".join(str(candidate["line"]) for candidate in matches)

    @override
    def get_page_text(
        self, context: BetaToolsetCallContext, input: BetaBrowserGetPageTextInput
    ) -> str:
        return str(self._in_world(self._tab(input.tab_id), "pageText") or "")

    @override
    def read_console(
        self, context: BetaToolsetCallContext, input: BetaBrowserReadConsoleInput
    ) -> str:
        return self._tab(input.tab_id).take_console()

    @override
    def read_network(
        self, context: BetaToolsetCallContext, input: BetaBrowserReadNetworkInput
    ) -> str:
        return self._tab(input.tab_id).take_network()

    @override
    def javascript_exec(
        self, context: BetaToolsetCallContext, input: BetaBrowserJavascriptExecInput
    ) -> str:
        """Runs in the page's own world (its globals and variables), stopped after 10 seconds.

        Deliberately the page's own world and not the isolated one the read members use: a script
        the model wrote is only useful if it sees what the page sees. That makes this member the
        model acting *as* the page, so it can read whatever the page can — same-origin storage, a
        logged-in session, the DOM — and `url_policy` does not contain it: that policy decides
        which addresses may be opened and requested, not what a script may touch in a page already
        open. Which is why the SDK leaves `javascript_exec` disabled unless you enable it in
        `configs` and refuses to enable it without a `confirm`. Enable it for pages whose contents
        you would hand the model anyway."""
        tab = self._tab(input.tab_id)
        result = self._cdp(tab).send(
            "Runtime.evaluate",
            {
                "expression": input.text,
                "returnByValue": True,
                "awaitPromise": True,
                "userGesture": True,
                "replMode": True,
                "timeout": SCRIPT_TIMEOUT * 1000,
            },
        )
        details = result.get("exceptionDetails")
        if details:
            description = str(
                (details.get("exception") or {}).get("description") or details.get("text") or ""
            )
            if "terminated" in description.lower():
                raise ToolError("The script did not finish within 10 seconds.")
            raise ToolError(f"The script threw: {description[:MAX_TEXT]}")
        return format_remote(result.get("result") or {})

    # --- mouse -----------------------------------------------------------------------------------

    @override
    def left_click(self, context: BetaToolsetCallContext, input: BetaBrowserLeftClickInput) -> None:
        self._click(input.tab_id, input.target, input.modifiers)

    @override
    def right_click(
        self, context: BetaToolsetCallContext, input: BetaBrowserRightClickInput
    ) -> None:
        self._click(input.tab_id, input.target, input.modifiers, "right")

    @override
    def middle_click(
        self, context: BetaToolsetCallContext, input: BetaBrowserMiddleClickInput
    ) -> None:
        self._click(input.tab_id, input.target, input.modifiers, "middle")

    @override
    def double_click(
        self, context: BetaToolsetCallContext, input: BetaBrowserDoubleClickInput
    ) -> None:
        self._click(input.tab_id, input.target, input.modifiers, count=2)

    @override
    def triple_click(
        self, context: BetaToolsetCallContext, input: BetaBrowserTripleClickInput
    ) -> None:
        self._click(input.tab_id, input.target, input.modifiers, count=3)

    @override
    def hover(self, context: BetaToolsetCallContext, input: BetaBrowserHoverInput) -> None:
        tab = self._tab(input.tab_id)
        x, y = self._point(tab, input.target)
        tab.page.mouse.move(x, y)
        self._settle(tab)

    @override
    def mouse_move(self, context: BetaToolsetCallContext, input: BetaBrowserMouseMoveInput) -> None:
        tab = self._tab(input.tab_id)
        tab.page.mouse.move(*self._point(tab, input.target))

    @override
    def left_mouse_down(
        self, context: BetaToolsetCallContext, input: BetaBrowserLeftMouseDownInput
    ) -> None:
        tab = self._tab(input.tab_id)
        tab.page.mouse.move(*self._point(tab, input.target))
        tab.page.mouse.down()

    @override
    def left_mouse_up(
        self, context: BetaToolsetCallContext, input: BetaBrowserLeftMouseUpInput
    ) -> None:
        tab = self._tab(input.tab_id)
        tab.page.mouse.move(*self._point(tab, input.target))
        tab.page.mouse.up()
        self._settle(tab)

    @override
    def left_click_drag(
        self, context: BetaToolsetCallContext, input: BetaBrowserLeftClickDragInput
    ) -> None:
        tab = self._tab(input.tab_id)
        start = self._point(tab, input.from_)
        end = self._point(tab, input.target)
        mouse = tab.page.mouse
        mouse.move(*start)
        mouse.down()
        mouse.move(*end, steps=10)
        mouse.up()
        self._settle(tab)

    @override
    def scroll(self, context: BetaToolsetCallContext, input: BetaBrowserScrollInput) -> None:
        tab = self._tab(input.tab_id)
        amount = 3 if input.scroll_amount is None else input.scroll_amount
        if not 1 <= amount <= 10:
            raise ToolError("scroll_amount must be between 1 and 10.")
        x, y = self._point(tab, input.target)
        distance = amount * WHEEL_NOTCH
        dx, dy = {
            "up": (0, -distance),
            "down": (0, distance),
            "left": (-distance, 0),
            "right": (distance, 0),
        }[input.scroll_direction]
        tab.page.mouse.move(x, y)
        tab.page.mouse.wheel(dx, dy)
        self._settle(tab)

    @override
    def scroll_to(self, context: BetaToolsetCallContext, input: BetaBrowserScrollToInput) -> None:
        tab = self._tab(input.tab_id)
        result = self._in_world(tab, "scrollTo", input.target.ref) or {}
        if result.get("error"):
            raise self._stale(input.target.ref)

    # --- keyboard and forms ----------------------------------------------------------------------

    @override
    def type(self, context: BetaToolsetCallContext, input: BetaBrowserTypeInput) -> None:
        tab = self._tab(input.tab_id)
        tab.page.keyboard.type(input.text)
        self._settle(tab)

    @override
    def key(self, context: BetaToolsetCallContext, input: BetaBrowserKeyInput) -> None:
        tab = self._tab(input.tab_id)
        repeat = 1 if input.repeat is None else input.repeat
        if not 1 <= repeat <= MAX_REPEAT:
            raise ToolError(f"repeat must be between 1 and {MAX_REPEAT}.")
        chords = [playwright_chord(chord) for chord in split_sequence(input.text)]
        for _ in range(repeat):
            for chord in chords:
                try:
                    tab.page.keyboard.press(chord)
                except PlaywrightError as exc:
                    if "Unknown key" in str(exc):
                        raise ToolError(
                            f"Unknown key in {chord!r}; use a key name such as Return, Tab or "
                            "Page_Up, or a single character."
                        ) from None
                    raise
        self._settle(tab)

    @override
    def hold_key(self, context: BetaToolsetCallContext, input: BetaBrowserHoldKeyInput) -> None:
        tab = self._tab(input.tab_id)
        if not 0 <= input.duration <= MAX_DURATION:
            raise ToolError(f"duration must be between 0 and {MAX_DURATION:g} seconds.")
        chords = split_sequence(input.text)
        if len(chords) != 1:
            raise ToolError("hold_key holds one key or chord, such as shift or ctrl+a.")
        modifiers, token = parse_chord(chords[0])
        keys = [PLAYWRIGHT[modifier] for modifier in modifiers]
        if token is not None:
            keys.append(playwright_chord(token))
        keyboard = tab.page.keyboard
        pressed: list[str] = []
        try:
            for key in keys:
                keyboard.down(key)
                pressed.append(key)
            tab.page.wait_for_timeout(input.duration * 1000)
        except PlaywrightError as exc:
            if "Unknown key" in str(exc):
                raise ToolError(f"Unknown key in {chords[0]!r}.") from None
            raise
        finally:
            for key in reversed(pressed):
                keyboard.up(key)

    @override
    def form_input(self, context: BetaToolsetCallContext, input: BetaBrowserFormInputInput) -> None:
        tab = self._tab(input.tab_id)
        ref = input.target.ref
        result = self._in_world(tab, "setValue", ref, input.value) or {}
        error = result.get("error")
        if error is None:
            self._settle(tab)
            return
        raise ToolError(
            {
                "stale": f"Unknown or stale ref {ref}; call read_page or find for current refs.",
                "no-option": f"The select {ref} has no option with that value or text.",
                "want-boolean": f"{ref} is a checkbox or radio button; set it to true or false.",
                "radio-off": (
                    f"{ref} is a radio button and cannot be cleared; set the one you want in "
                    "its group to true instead."
                ),
                "not-checkable": f"{ref} is not a checkbox; give it a text or number value.",
                "file-input": f"{ref} is a file input; use file_upload.",
                "not-a-field": f"{ref} is not a form field.",
            }.get(str(error), "The value could not be set.")
        )

    @override
    def file_upload(
        self, context: BetaToolsetCallContext, input: BetaBrowserFileUploadInput
    ) -> None:
        """Hand the sandbox's own files to a file input on the page.

        The approval this member needs has already happened: the SDK asks `confirm` before it
        dispatches any member and refuses to construct a toolset that enables `file_upload` (or
        `javascript_exec`) without one, so asking again here would only prompt twice for one call.
        The file policy has likewise already ruled on `input.paths`."""
        tab = self._tab(input.tab_id)
        if input.document_ids:
            raise ToolError(
                "This browser runs in a Daytona sandbox and cannot upload Files API documents."
            )
        paths = list(input.paths or [])
        if not paths:
            raise ToolError("file_upload needs at least one path.")
        paths = self._resolve_in_sandbox(paths)
        element = self._in_world(tab, "fileInput", input.target.ref, by_value=False)
        if element.get("subtype") != "node" or "objectId" not in element:
            value = element.get("value") or {}
            if isinstance(value, dict) and value.get("error") == "not-file":
                raise ToolError(f"{input.target.ref} is not a file input.")
            raise self._stale(input.target.ref)
        self._cdp(tab).send(
            "DOM.setFileInputFiles", {"files": paths, "objectId": element["objectId"]}
        )
        self._settle(tab)

    def _resolve_in_sandbox(self, paths: list[str]) -> list[str]:
        """Each path with symlinks resolved inside the sandbox, where the browser reads it, checked
        again now that it is resolved — the policy's check ran on the path as written.

        A `DaytonaFilePolicy` declares upload roots the driver can re-check the resolved path
        against (the roots are resolved too, so a root that is itself a link still matches). A
        policy of another class declares nothing the driver can re-check, so a path that resolved
        to somewhere else is refused outright.

        The check and the upload are two steps against a filesystem, not one atomic operation:
        the toolbox API resolves a path, it does not hand back a handle the driver could hold, so
        anything else running in the sandbox that can write to the upload directory can swap a
        checked file for a link between the two. The sandbox is the trust boundary — the model
        drives the browser and has no shell in it — so keep the upload directory writable only by
        you, and hold it to the task's own files, as the README says."""
        quoted = " ".join(shlex.quote(p) for p in paths)
        result = self.sandbox.process.exec(f"realpath -e -- {quoted}")
        resolved = (result.result or "").splitlines()
        if result.exit_code != 0 or len(resolved) != len(paths):
            raise ToolError("An upload path does not exist in the sandbox.")
        if self._file_policy is not None:
            # The roots go through the sandbox too, so a root that is itself a link is compared as
            # what it points at, like the paths are. `-m` and not `-e`: a root that does not exist
            # yet still has an answer, and answers for all of them or the check cannot be made.
            declared = self._file_policy.upload_roots
            roots_result = self.sandbox.process.exec(
                "realpath -m -- " + " ".join(shlex.quote(r) for r in declared)
            )
            roots = (roots_result.result or "").splitlines()
            if roots_result.exit_code != 0 or len(roots) != len(declared):
                raise ToolError("An upload path could not be checked against the upload directory.")
            if not all(any(is_under(path, root) for root in roots) for path in resolved):
                raise ToolError("An upload path is outside the upload directory.")
        elif resolved != [posixpath.normpath(path) for path in paths]:
            # A policy of another class has no roots the driver can re-check, and it judged these
            # paths before the sandbox resolved them. Anything that resolves elsewhere is refused
            # rather than read from wherever the link points: a link planted in an upload
            # directory must not carry the upload out of it.
            raise ToolError("An upload path is a link to another path; upload the file itself.")
        return resolved

    # --- tabs ------------------------------------------------------------------------------------

    @override
    def new_tab(
        self, context: BetaToolsetCallContext, input: BetaBrowserNewTabInput
    ) -> BetaBrowserStateTabEntryParam:
        if self._disconnected or self._context is None:
            raise ToolError("The browser in the sandbox is no longer connected.")
        if len(self._tabs) >= MAX_TABS:
            raise ToolError(f"{MAX_TABS} tabs are open; close one first.")
        page = self._context.new_page()
        self._on_page(page)  # the context's page event may not have run yet
        tab = self._tabs[self._by_page[page]]
        self._activate(tab.id)
        return {"tab_id": tab.id, "title": "", "url": page.url, "active": True}

    @override
    def list_tabs(
        self, context: BetaToolsetCallContext, input: BetaBrowserListTabsInput
    ) -> list[BetaBrowserStateTabEntryParam]:
        return [
            {
                "tab_id": tab.id,
                "title": tab.title,
                "url": tab.page.url,
                "active": tab.id == self._active,
            }
            for tab in self._tabs.values()
        ]

    @override
    def switch_tab(
        self, context: BetaToolsetCallContext, input: BetaBrowserSwitchTabInput
    ) -> BetaBrowserStateTabEntryParam:
        tab = self._tab(input.tab_id)
        tab.page.bring_to_front()
        self._activate(tab.id)
        return {"tab_id": tab.id, "title": tab.title, "url": tab.page.url, "active": True}

    @override
    def close_tab(self, context: BetaToolsetCallContext, input: BetaBrowserCloseTabInput) -> None:
        tab = self._tab(input.tab_id)
        page = tab.page
        page.close(run_before_unload=False)
        self._forget(page)

    # --- waiting ---------------------------------------------------------------------------------

    @override
    def wait(self, context: BetaToolsetCallContext, input: BetaBrowserWaitInput) -> None:
        if not 0 <= input.duration <= MAX_DURATION:
            raise ToolError(f"duration must be between 0 and {MAX_DURATION:g} seconds.")
        if self._active is not None and self._active in self._tabs:
            self._settle_for(self._tabs[self._active], input.duration)
        else:
            time.sleep(input.duration)

    def _settle_for(self, tab: Tab, seconds: float) -> None:
        try:
            tab.page.wait_for_timeout(seconds * 1000)
        except PlaywrightError:
            time.sleep(seconds)


def safe_title(page: Page) -> str:
    try:
        return page.title()
    except PlaywrightError:
        return ""


__all__ = ["DaytonaBrowser", "DaytonaFilePolicy"]
