from __future__ import annotations

import inspect
import re
import subprocess
from collections.abc import Callable, Iterator, Sequence
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, call as mock_call

import pytest
from anthropic.tools import ToolError, ToolsetConfigError
from anthropic.tools.browser import BetaDialogDismissed, BetaLocalFilePolicy, BetaNavigationRefused
from anthropic.tools.browser import BetaURLContext

from daytona_toolsets import DaytonaBrowser, DaytonaFilePolicy
from daytona_toolsets._files import is_under
from daytona_toolsets.browser import (
    KEEP_ALIVE,
    MAX_TEXT,
    failure_phrase,
    format_remote,
    normalize_url,
    rank,
)

from .conftest import blocks_of, call, fake_sandbox, text_of

REAL_LAUNCH = DaytonaBrowser._launch
"""Captured before any fixture replaces it, so the launch itself can be tested."""


def approve(_context: object) -> bool:
    return True


# --- normalize_url ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("url", "opened"),
    [
        ("example.com", "https://example.com"),
        ("example.com/a?b=1", "https://example.com/a?b=1"),
        ("localhost:3000/x", "https://localhost:3000/x"),
        ("HTTP://Example.com", "HTTP://Example.com"),
        ("https://example.com", "https://example.com"),
        ("  https://example.com\n", "https://example.com"),
        ("about:blank", "about:blank"),
    ],
)
def test_normalize_url_opens_web_addresses(url: str, opened: str) -> None:
    assert normalize_url(url) == opened


@pytest.mark.parametrize(
    "url",
    [
        "javascript:alert(1)",
        "JavaScript:alert(1)",
        "\x01 javascript:alert(1)",
        "java\tscript:alert(1)",
        "view-source:https://example.com",
        "data:text/html,<h1>hi</h1>",
        "file:///etc/passwd",
        "chrome://settings",
        "blob:https://example.com/uuid",
        "ftp://example.com/file",
        "about:srcdoc",
    ],
)
def test_normalize_url_refuses_other_schemes(url: str) -> None:
    with pytest.raises(ToolError, match="does not open"):
        normalize_url(url)


def test_normalize_url_refuses_a_control_character_it_cannot_drop() -> None:
    """Only tab, LF and CR are dropped by a URL parser. Anything else C0 survives, re-spelled —
    percent-encoded in a path, rejected in a host — so the policy would judge one address and
    Chromium would open another."""
    for url in ("https://ex\x00ample.com", "https://a.test/\x0bx", "https://a.test/\x7f"):
        with pytest.raises(ToolError, match="control characters"):
            normalize_url(url)
    # The ones a parser really does drop or trim are still handled, not refused.
    assert normalize_url("https://a.te\tst.com/\r\n") == "https://a.test.com/"
    assert normalize_url("\x01\x02 https://a.test ") == "https://a.test"


def test_failure_phrase_keeps_urls_out() -> None:
    error = Exception(
        "net::ERR_NAME_NOT_RESOLVED at https://secret.example/?token=abc\nCall log: ..."
    )
    assert failure_phrase(error) == "The navigation failed (net::ERR_NAME_NOT_RESOLVED)."
    assert (
        failure_phrase(Exception("net::ERR_BLOCKED_BY_CLIENT at x"))
        == "The navigation was refused."
    )
    assert failure_phrase(Exception("Target closed https://x")) == "The navigation failed."


def test_failure_phrase_keeps_the_whole_error_code() -> None:
    """Chromium's codes carry digits (`ERR_HTTP2_PROTOCOL_ERROR`, `ERR_SSL_VERSION_OR_CIPHER_
    MISMATCH` after an `SSL3`). Stopping at the first one reports a code that does not exist."""
    assert (
        failure_phrase(Exception("net::ERR_HTTP2_PROTOCOL_ERROR at https://a.test"))
        == "The navigation failed (net::ERR_HTTP2_PROTOCOL_ERROR)."
    )
    assert (
        failure_phrase(Exception("net::ERR_SPDY_PROTOCOL_ERROR"))
        == "The navigation failed (net::ERR_SPDY_PROTOCOL_ERROR)."
    )
    # A trailing digit is part of the code too, and lower case still ends it.
    assert (
        failure_phrase(Exception("net::ERR_QUIC_PROTOCOL_ERROR2 while loading"))
        == "The navigation failed (net::ERR_QUIC_PROTOCOL_ERROR2)."
    )


# --- DaytonaFilePolicy -----------------------------------------------------------------------

CONTEXT = BetaURLContext(member="file_upload")


@pytest.mark.parametrize(
    ("path", "root", "contained"),
    [
        # The filesystem root contains every absolute path, so accepting it as a containing root
        # would turn the check into a no-op — which is what an upload root that resolves to `/`
        # would otherwise buy.
        ("/etc/shadow", "/", False),
        ("/", "/", False),
        ("/etc/shadow", "//", False),
        # A root is a directory however it is spelled.
        ("/tmp/up", "/tmp/up/", True),
        ("/tmp/up/a.txt", "/tmp/up/", True),
        ("/tmp/up", "/tmp/up", True),
        # Whole components only: a sibling whose name starts with the root's name is outside it.
        ("/tmp/upload/a.txt", "/tmp/up", False),
        ("/tmp/up-other", "/tmp/up", False),
        ("/tmp/up.txt", "/tmp/up", False),
        # A parent step is refused, not walked: `/tmp/up/../etc/passwd` is not in `/tmp/up`.
        ("/tmp/up/../etc/passwd", "/tmp/up", False),
        ("/etc/passwd", "/tmp/up/..", False),
        # Relative paths are not sandbox paths.
        ("tmp/up/a.txt", "/tmp/up", False),
        ("/tmp/up/a.txt", "tmp/up", False),
    ],
)
def test_is_under_compares_whole_path_components(path: str, root: str, contained: bool) -> None:
    assert is_under(path, root) is contained


def test_file_policy_admits_paths_under_a_root() -> None:
    policy = DaytonaFilePolicy(upload_roots=["/task/uploads/"])
    assert policy.resolve_upload_paths(CONTEXT, ["/task/uploads/a.txt", "/task/uploads//b/c"]) == [
        "/task/uploads/a.txt",
        "/task/uploads/b/c",
    ]


@pytest.mark.parametrize(
    "path", ["/etc/passwd", "/task/uploads/../secret", "relative.txt", "/task/uploads-other/x"]
)
def test_file_policy_refuses_paths_outside(path: str) -> None:
    policy = DaytonaFilePolicy(upload_roots=["/task/uploads"])
    with pytest.raises(ToolError):
        policy.resolve_upload_paths(CONTEXT, [path])


def test_file_policy_without_roots_and_documents_refuse() -> None:
    with pytest.raises(ToolError):
        DaytonaFilePolicy().resolve_upload_paths(CONTEXT, ["/x"])
    with pytest.raises(ToolError):
        DaytonaFilePolicy(upload_roots=["/x"]).resolve_upload_documents(CONTEXT, ["file_1"])


def test_file_policy_checks_its_arguments() -> None:
    with pytest.raises(ValueError):
        DaytonaFilePolicy(upload_roots=["/task"], download_dir="/task/downloads")
    with pytest.raises(ValueError):
        DaytonaFilePolicy(upload_roots=["relative"])
    with pytest.raises(ValueError):
        DaytonaFilePolicy(upload_roots=["/"])
    with pytest.raises(TypeError):
        DaytonaFilePolicy(upload_roots="/task")


def test_a_configured_path_with_a_parent_step_is_refused_not_normalized() -> None:
    """Normalizing `..` away would authorize a directory the caller never wrote down:
    `/safe/../private` would quietly become `/private`."""
    with pytest.raises(ValueError, match=r"must not contain"):
        DaytonaFilePolicy(upload_roots=["/safe/../private"])
    with pytest.raises(ValueError, match=r"must not contain"):
        DaytonaFilePolicy(download_dir="/safe/../private")
    # A root that only looks like one is still fine.
    assert DaytonaFilePolicy(upload_roots=["/safe/..private"]).upload_roots == ("/safe/..private",)


def test_file_policy_download_path_visibility() -> None:
    hidden = DaytonaFilePolicy(download_dir="/dl")
    shown = DaytonaFilePolicy(download_dir="/dl", expose_download_paths=True)
    assert not hidden.is_path_visible("/dl/x")
    assert shown.is_path_visible("/dl/x")
    assert not shown.is_path_visible("/dl/../etc/passwd")
    assert not shown.is_path_visible("/dl-other/x")


# --- a DaytonaBrowser over fake Playwright objects -------------------------------------------


class FakePage:
    counter = 0

    def __init__(self, url: str = "about:blank", title: str = "") -> None:
        FakePage.counter += 1
        self.target = f"target-{FakePage.counter}"
        self.url = url
        self.title_ = title
        self.handlers: dict[str, list[Callable[..., Any]]] = {}
        self.keyboard = MagicMock()
        self.mouse = MagicMock()
        self.goto = MagicMock()

    def on(self, event: str, handler: Callable[..., Any]) -> None:
        self.handlers.setdefault(event, []).append(handler)

    def close(self, run_before_unload: bool = False) -> None:
        for handler in self.handlers.get("close", []):
            handler(self)

    def wait_for_timeout(self, ms: float) -> None:
        pass

    def bring_to_front(self) -> None:
        pass

    def title(self) -> str:
        return self.title_


class FakeContext:
    def __init__(self) -> None:
        self.pages: list[FakePage] = []

    def new_page(self) -> FakePage:
        page = FakePage()
        self.pages.append(page)
        return page

    def new_cdp_session(self, page: FakePage) -> MagicMock:
        session = MagicMock()
        session.send.return_value = {"targetInfo": {"targetId": page.target}}
        return session


@pytest.fixture
def browser(monkeypatch: pytest.MonkeyPatch) -> Iterator[DaytonaBrowser]:
    yield make_browser(monkeypatch)


def make_browser(monkeypatch: pytest.MonkeyPatch, **options: Any) -> DaytonaBrowser:
    context = FakeContext()

    def launch(self: DaytonaBrowser, chromium: str, headless: bool) -> int:
        return 9222

    def connect(self: Any, port: int) -> None:
        self._context = context
        cdp = MagicMock()

        def send(method: str, params: object = None) -> dict[str, Any]:
            infos = [
                {"targetId": p.target, "type": "page", "title": p.title_, "url": p.url}
                for p in context.pages
            ]
            return {"targetInfos": infos}

        cdp.send.side_effect = send
        self._browser_cdp = cdp
        self._signed = (port, "signed-token")
        self._on_page(context.new_page())
        self._changes.clear()

    monkeypatch.setattr(DaytonaBrowser, "_launch", launch)
    monkeypatch.setattr(DaytonaBrowser, "_connect", connect)
    sandbox = options.pop("sandbox", None) or fake_sandbox()
    return DaytonaBrowser(sandbox, **options)


def state(browser: DaytonaBrowser) -> dict[str, Any]:
    report = browser._browser_state(MagicMock())
    return {"tabs": report.tabs, "changes": report.state_changes}


def assert_valid(tabs: list[Any]) -> None:
    ids = [tab["tab_id"] for tab in tabs]
    assert len(ids) == len(set(ids)) and len(ids) <= 100
    if tabs:
        assert sum(1 for tab in tabs if tab["active"]) == 1


def test_constructor_refuses_a_local_file_policy() -> None:
    with pytest.raises(ToolsetConfigError, match="DaytonaFilePolicy"):
        DaytonaBrowser(fake_sandbox(), file_policy=BetaLocalFilePolicy(upload_roots=["/tmp/x"]))


def test_constructor_checks_options_before_creating_a_sandbox() -> None:
    client = MagicMock()
    with pytest.raises(ToolsetConfigError):  # javascript_exec needs confirm (the SDK's rule)
        DaytonaBrowser(daytona=client, configs={"javascript_exec": {"enabled": True}})
    with pytest.raises(ValueError):
        DaytonaBrowser(daytona=client, viewport=(2560, 1440))
    client.create.assert_not_called()


def test_every_member_is_implemented(browser: DaytonaBrowser) -> None:
    configs: dict[str, Any] = dict(browser.configs or {})
    # the SDK adds enabled: False only for members the class does not override
    assert [name for name, config in configs.items() if config.get("enabled") is False] == []


def test_the_members_that_reach_past_the_url_policy_are_off_until_enabled(
    browser: DaytonaBrowser,
) -> None:
    """`javascript_exec` runs in the page's own world, so it reads whatever the page can and the
    URL policy does not contain it. The SDK keeps it, and the other reach-further members, off
    until a caller enables them — and refuses to enable it without a `confirm`."""
    options = browser._toolset_options
    for member in ("javascript_exec", "file_upload", "read_console", "read_network"):
        assert options.is_enabled(member) is False, member
    assert options.is_enabled("navigate") is True


def test_the_sdk_gates_file_upload_and_javascript_exec_on_confirm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The driver deliberately does not call `confirm` itself: the SDK asks before it dispatches
    any member, and refuses to build a toolset that enables either of these without one. Calling
    it again in the member would prompt twice for one call."""
    for member in ("file_upload", "javascript_exec"):
        with pytest.raises(ToolsetConfigError, match="requires a confirm callable"):
            make_browser(monkeypatch, configs={member: {"enabled": True}})

    asked: list[str] = []
    browser = make_browser(
        monkeypatch,
        configs={"file_upload": {"enabled": True}},
        confirm=lambda context: asked.append(context.member) is None and False,
        file_policy=DaytonaFilePolicy(upload_roots=["/up"]),
    )
    sandbox: Any = browser.sandbox
    refused = call(
        browser,
        "file_upload",
        {"target": {"type": "ref", "ref": "ref_1"}, "paths": ["/up/a.txt"]},
    )
    assert asked == ["file_upload"]  # asked once, by the SDK, before the driver ran
    assert refused.get("is_error")
    sandbox.process.exec.assert_not_called()  # nothing was resolved, let alone uploaded


def test_state_reports_one_active_tab_with_titles(browser: DaytonaBrowser) -> None:
    context: Any = browser._context
    context.pages[0].url, context.pages[0].title_ = "https://a.test/", "A"
    report = state(browser)
    assert report["tabs"] == [
        {"tab_id": "tab_1", "title": "A", "url": "https://a.test/", "active": True}
    ]
    assert report["changes"] == []


def test_popups_open_active_tabs_and_are_reported_once(browser: DaytonaBrowser) -> None:
    context: Any = browser._context
    popup = context.new_page()
    browser._on_page(popup)
    browser._on_page(popup)  # a repeated event is ignored
    report = state(browser)
    assert_valid(report["tabs"])
    assert [t["tab_id"] for t in report["tabs"] if t["active"]] == ["tab_2"]
    assert report["changes"] == [{"type": "tab_opened", "tab_id": "tab_2"}]
    assert state(browser)["changes"] == []  # drained


def test_closing_the_active_tab_activates_the_previous_one(browser: DaytonaBrowser) -> None:
    for _ in range(2):
        call(browser, "new_tab", {})
    call(browser, "switch_tab", {"tab_id": "tab_2"})
    result = call(browser, "close_tab", {"tab_id": "tab_2"})
    assert not result.get("is_error")
    tabs = state(browser)["tabs"]
    assert_valid(tabs)
    assert [t["tab_id"] for t in tabs if t["active"]] == ["tab_3"]
    call(browser, "close_tab", {"tab_id": "tab_3"})
    call(browser, "close_tab", {"tab_id": "tab_1"})
    assert state(browser)["tabs"] == []
    refused = call(browser, "navigate", {"url": "https://a.test"})
    assert refused.get("is_error") and "No tab is open" in text_of(refused)


def test_new_tab_result_passes_the_sdk_rules(browser: DaytonaBrowser) -> None:
    result = call(browser, "new_tab", {})
    assert not result.get("is_error"), text_of(result)
    block = blocks_of(result)[-1]
    assert block["type"] == "browser_state"
    assert [t["tab_id"] for t in block["tabs"] if t["active"]] == ["tab_2"]
    assert block["state_changes"] == [{"type": "tab_opened", "tab_id": "tab_2"}]


def test_tab_limit(browser: DaytonaBrowser) -> None:
    context: Any = browser._context
    for _ in range(99):
        browser._on_page(context.new_page())
    refused = call(browser, "new_tab", {})
    assert refused.get("is_error") and "100 tabs" in text_of(refused)
    extra = context.new_page()
    browser._on_page(extra)  # a popup past the limit is closed
    assert all(page is not extra for page in browser._by_page)
    assert len(state(browser)["tabs"]) == 100


def test_unknown_tab_ids_are_refused(browser: DaytonaBrowser) -> None:
    result = call(browser, "switch_tab", {"tab_id": "tab_9"})
    assert result.get("is_error") and "not open" in text_of(result)


def test_navigate_refuses_schemes_before_the_browser(browser: DaytonaBrowser) -> None:
    result = call(browser, "navigate", {"url": "javascript:alert(document.cookie)"})
    assert result.get("is_error") and "does not open javascript: URLs" in text_of(result)
    page: Any = browser._tabs["tab_1"].page
    page.goto.assert_not_called()


def test_a_navigation_that_redirects_somewhere_refused_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Playwright continues a redirected request itself instead of routing it, so interception
    only ever saw the first hop; where the page landed has to be asked about separately."""

    def policy(context: BetaURLContext, url: str) -> None:
        if "evil" in url:
            raise ToolError("blocked")

    browser = make_browser(monkeypatch, url_policy=policy)
    page: Any = browser._tabs["tab_1"].page

    def land(url: str, **kwargs: object) -> MagicMock:
        page.url = "https://evil.test/landed" if "a.test" in url else url
        return MagicMock(status=200)

    page.goto = MagicMock(side_effect=land)
    refused = call(browser, "navigate", {"url": "https://a.test"})
    assert refused.get("is_error")
    assert "redirected to an address that is not allowed" in text_of(refused)
    assert page.goto.call_args_list[-1].args[0] == "about:blank"  # the page is left behind
    assert state(browser)["changes"] == []  # retreating is not reported as a refused navigation


def test_a_navigation_that_stays_allowed_is_not_second_guessed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    asked: list[tuple[str | None, str]] = []

    def policy(context: BetaURLContext, url: str) -> None:
        asked.append((context.member, url))

    browser = make_browser(monkeypatch, url_policy=policy)
    page: Any = browser._tabs["tab_1"].page

    def land(url: str, **kwargs: object) -> MagicMock:
        page.url = url
        return MagicMock(status=200)

    page.goto = MagicMock(side_effect=land)
    result = call(browser, "navigate", {"url": "https://a.test"})
    assert not result.get("is_error"), text_of(result)
    # The SDK asks about the address the model gave; the driver asks about where it landed.
    assert asked == [("navigate", "https://a.test"), (None, "https://a.test")]
    assert page.goto.call_count == 1


def test_a_page_started_navigation_that_lands_somewhere_refused_is_left(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A click or a script can reach an allowed address that redirects; interception only saw
    the first hop, and `navigate`'s own check does not cover a navigation the page started."""

    def policy(context: BetaURLContext, url: str) -> None:
        if "evil" in url:
            raise ToolError("blocked")

    browser = make_browser(monkeypatch, url_policy=policy)
    page: Any = browser._tabs["tab_1"].page
    page.goto = MagicMock()
    frame = SimpleNamespace(parent_frame=None, page=page, url="https://evil.test/landed")
    browser._on_navigated(frame)  # type: ignore[arg-type]
    assert browser._refused_tabs == {"tab_1"}
    page.goto.assert_not_called()  # an event handler must not call back into Playwright

    result = call(browser, "wait", {"duration": 0})  # the next member leaves the page first
    assert browser._refused_tabs == set()
    assert page.goto.call_args_list[0].args[0] == "about:blank"
    blocks = blocks_of(result)
    assert {"type": "text", "text": "A navigation was refused."} in blocks
    assert blocks[-1]["tabs"] == [
        {"tab_id": "tab_1", "title": "", "url": "about:blank", "active": True}
    ]


def test_a_page_started_navigation_the_policy_allows_is_left_alone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    browser = make_browser(monkeypatch, url_policy=lambda context, url: None)
    page: Any = browser._tabs["tab_1"].page
    browser._on_navigated(
        SimpleNamespace(parent_frame=None, page=page, url="https://good.test/")  # type: ignore[arg-type]
    )
    # A sub-frame and the driver's own navigation are not the model's page either.
    browser._on_navigated(
        SimpleNamespace(parent_frame=object(), page=page, url="https://evil.test/")  # type: ignore[arg-type]
    )
    assert browser._refused_tabs == set()
    assert state(browser)["changes"] == []


def test_state_never_raises(browser: DaytonaBrowser) -> None:
    cdp: Any = browser._browser_cdp
    cdp.send.side_effect = RuntimeError("connection lost")
    report = state(browser)
    assert_valid(report["tabs"])
    assert report["tabs"][0]["tab_id"] == "tab_1"


def test_dialogs_are_dismissed_and_reported(browser: DaytonaBrowser) -> None:
    dialog = MagicMock(type="confirm", message="Delete everything?")
    browser._on_dialog(dialog)
    dialog.dismiss.assert_called_once_with()
    before_unload = MagicMock(type="beforeunload", message="")
    browser._on_dialog(before_unload)
    before_unload.accept.assert_called_once_with()
    assert state(browser)["changes"] == [
        BetaDialogDismissed(kind="confirm", message="Delete everything?")
    ]


def test_page_supplied_text_is_bounded(browser: DaytonaBrowser) -> None:
    """A dialog message, like a console line, is written by the page and has no length of its own."""
    browser._on_dialog(MagicMock(type="alert", message="x" * 10_000))
    browser._log_console(browser._tabs["tab_1"].page, "y" * 10_000)
    change = state(browser)["changes"][0]
    assert isinstance(change, BetaDialogDismissed) and change.message == "x" * MAX_TEXT
    assert browser._tabs["tab_1"].console[-1] == "y" * MAX_TEXT


def test_a_recorded_request_url_is_bounded(browser: DaytonaBrowser) -> None:
    """A page chooses the URLs it requests and can make them any length. `read_network` hands
    back up to 1,000 of them at once, so an uncapped one is both per-tab memory and tool output."""
    tab = browser._tabs["tab_1"]
    long_url = "https://a.test/?q=" + "z" * 10_000
    tab.start_request(MagicMock(url=long_url, method="GET"))
    assert tab.network[next(iter(tab.network))]["url"] == long_url[:MAX_TEXT]
    assert len(tab.take_network()) < MAX_TEXT + 100


def test_interception_applies_the_url_policy(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[tuple[str | None, str]] = []

    def policy(context: BetaURLContext, url: str) -> None:
        seen.append((context.member, url))
        if "evil" in url:
            raise ToolError("blocked")

    browser = make_browser(monkeypatch, url_policy=policy)
    page = browser._tabs["tab_1"].page

    def route(url: str, navigation: bool) -> MagicMock:
        route = MagicMock()
        route.request.url = url
        route.request.frame.page = page
        route.request.frame.parent_frame = None
        route.request.is_navigation_request.return_value = navigation
        return route

    allowed = route("https://good.test/app.js", False)
    browser._guard(allowed)
    allowed.continue_.assert_called_once_with()
    image = route("https://evil.test/pixel.png", False)
    browser._guard(image)
    image.abort.assert_called_once_with("blockedbyclient")
    assert state(browser)["changes"] == []  # a sub-resource is not a navigation
    link = route("https://evil.test/", True)
    browser._guard(link)
    assert state(browser)["changes"] == [BetaNavigationRefused()]
    assert seen[0] == (None, "https://good.test/app.js")  # member=None for page requests


def test_interception_follows_whether_a_url_policy_was_passed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The SDK's default is `NOT_GIVEN`, not `None`. No argument: navigate is unchecked and the
    driver installs no interception, so pages load normally. An explicit `url_policy=None` is a
    policy to the SDK, and one that refuses every navigation, so interception matches it."""
    assert make_browser(monkeypatch)._has_url_policy is False
    explicit = make_browser(monkeypatch, url_policy=None)
    assert explicit._has_url_policy is True
    refused = call(explicit, "navigate", {"url": "https://a.test"})
    assert refused.get("is_error"), text_of(refused)  # the SDK refuses before the driver runs
    assert explicit._tabs["tab_1"].page.goto.call_count == 0
    route = MagicMock()
    route.request.is_navigation_request.return_value = False
    explicit._guard(route)
    route.abort.assert_called_once_with("blockedbyclient")


def test_a_radio_button_cannot_be_cleared(monkeypatch: pytest.MonkeyPatch) -> None:
    """Clicking a selected radio leaves it selected, so `false` must not report a change that
    did not happen."""
    browser = make_browser(monkeypatch)
    monkeypatch.setattr(
        DaytonaBrowser,
        "_in_world",
        lambda self, tab, function, *args, **kwargs: {"error": "radio-off"},
    )
    refused = call(
        browser, "form_input", {"target": {"type": "ref", "ref": "ref_3"}, "value": False}
    )
    assert refused.get("is_error")
    assert "cannot be cleared" in text_of(refused)


def set_value_body() -> str:
    """The `setValue` entry point of the in-page toolkit, as source."""
    from daytona_toolsets import _page_js

    return _page_js.TOOLKIT.split("setValue(ref, value) {", 1)[1].split("\n    fileInput(", 1)[0]


def test_every_set_value_refusal_has_a_message() -> None:
    """The in-page `setValue` and the member's message table are one contract; a code added to
    the script with no message would reach the model as "The value could not be set."."""
    body = set_value_body()
    codes = set(re.findall(r"error: '([a-z-]+)'", body))
    assert {"radio-off", "disabled"} <= codes
    source = inspect.getsource(DaytonaBrowser.form_input)
    missing = sorted(code for code in codes if f'"{code}":' not in source)
    assert missing == []


def test_set_value_refuses_clearing_only_a_radio_that_is_set() -> None:
    """A radio that is already clear is in the state `false` asks for, so the call is a no-op
    success; only clearing a *selected* one is something a click cannot do."""
    body = set_value_body()
    assert "type === 'radio' && value === false && el.checked" in body
    # The already-correct state returns before anything can refuse it.
    assert body.index("el.checked === value") < body.index("':disabled'")


def test_set_value_refuses_a_checkable_it_cannot_click() -> None:
    """A click is the only way to change a checkbox or radio, and a disabled one ignores it, so
    clicking and returning success would report a change that did not happen."""
    body = set_value_body()
    assert "el.matches(':disabled')" in body
    assert body.index("':disabled'") < body.index("el.click()")


def test_interception_covers_websocket_handshakes(monkeypatch: pytest.MonkeyPatch) -> None:
    """`context.route` never sees a handshake, so a page could otherwise hold a socket open to an
    address every ordinary request to it is refused."""

    def policy(context: BetaURLContext, url: str) -> None:
        if "evil" in url:
            raise ToolError("blocked")

    browser = make_browser(monkeypatch, url_policy=policy)
    context = MagicMock()
    browser._install_interception(context)
    assert context.route.call_args_list == [mock_call("**/*", browser._guard)]
    assert context.route_web_socket.call_args_list == [mock_call("**/*", browser._guard_websocket)]

    allowed = MagicMock(url="wss://good.test/live")
    browser._guard_websocket(allowed)
    allowed.connect_to_server.assert_called_once_with()
    allowed.close.assert_not_called()

    refused = MagicMock(url="wss://evil.test/live")
    browser._guard_websocket(refused)
    refused.connect_to_server.assert_not_called()
    refused.close.assert_called_once_with(code=1008, reason="Policy violation")


def test_no_url_policy_installs_neither_interception(monkeypatch: pytest.MonkeyPatch) -> None:
    context = MagicMock()
    make_browser(monkeypatch)._install_interception(context)
    context.route.assert_not_called()
    context.route_web_socket.assert_not_called()


def test_interception_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    def broken(context: BetaURLContext, url: str) -> None:
        raise KeyError("bug")

    browser = make_browser(monkeypatch, url_policy=broken)
    route = MagicMock()
    route.request.is_navigation_request.return_value = False
    browser._guard(route)
    route.abort.assert_called_once_with("blockedbyclient")


def test_downloads_are_reported_with_their_url(browser: DaytonaBrowser) -> None:
    browser._on_download_begin({"guid": "g1", "url": "https://a.test/f.zip"})
    browser._on_download_progress({"guid": "g1", "state": "inProgress", "receivedBytes": 5})
    browser._on_download_progress({"guid": "g1", "state": "completed", "receivedBytes": 10})
    browser._on_download_begin({"guid": "g2", "url": "https://a.test/g.zip"})
    browser._on_download_progress({"guid": "g2", "state": "canceled"})
    changes = state(browser)["changes"]
    assert changes[0] == {
        "type": "download_started",
        "download_id": "g1",
        "url": "https://a.test/f.zip",
    }
    assert changes[1]["type"] == "download_completed" and changes[1]["size_bytes"] == 10
    assert "path" not in changes[1]  # no file policy: nothing exposes the path
    assert changes[3] == {
        "type": "download_failed",
        "download_id": "g2",
        "url": "https://a.test/g.zip",
        "error": "The download was cancelled or failed.",
    }


def completed_download(browser: DaytonaBrowser) -> dict[str, Any]:
    browser._on_download_begin({"guid": "g1", "url": "https://a.test/f.zip"})
    browser._on_download_progress({"guid": "g1", "state": "completed", "receivedBytes": 10})
    change: dict[str, Any] = dict(state(browser)["changes"][1])
    return change


def test_download_paths_need_expose_download_paths(monkeypatch: pytest.MonkeyPatch) -> None:
    hidden = make_browser(monkeypatch, file_policy=DaytonaFilePolicy(download_dir="/dl"))
    assert "path" not in completed_download(hidden)
    shown = make_browser(
        monkeypatch,
        file_policy=DaytonaFilePolicy(download_dir="/dl", expose_download_paths=True),
    )
    assert completed_download(shown)["path"] == "/dl/g1"


def test_the_default_download_dir_is_exposed_when_asked(monkeypatch: pytest.MonkeyPatch) -> None:
    # No download_dir: the driver picks one, so expose_download_paths must still show it.
    browser = make_browser(monkeypatch, file_policy=DaytonaFilePolicy(expose_download_paths=True))
    assert browser.download_dir.startswith("/tmp/daytona-toolsets-")
    assert completed_download(browser)["path"] == f"{browser.download_dir}/g1"


def test_binding_the_download_dir_leaves_the_callers_policy_alone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    shared = DaytonaFilePolicy(expose_download_paths=True)
    first = make_browser(monkeypatch, file_policy=shared)
    second = make_browser(monkeypatch, file_policy=shared)
    assert shared.download_dir is None  # the caller's object is never bound
    assert first.download_dir != second.download_dir
    assert completed_download(first)["path"] == f"{first.download_dir}/g1"
    assert completed_download(second)["path"] == f"{second.download_dir}/g1"


def test_the_sdk_is_handed_the_same_bound_policy(monkeypatch: pytest.MonkeyPatch) -> None:
    # The SDK checks is_path_visible again when it renders browser_state; both must agree.
    browser = make_browser(monkeypatch, file_policy=DaytonaFilePolicy(expose_download_paths=True))
    sdk_policy = browser._toolset_options.file_policy
    assert sdk_policy is browser._policy
    assert sdk_policy.is_path_visible(f"{browser.download_dir}/g1") is True


def test_a_named_download_dir_is_kept_as_the_caller_gave_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    policy = DaytonaFilePolicy(download_dir="/dl", expose_download_paths=True)
    browser = make_browser(monkeypatch, file_policy=policy)
    assert browser.download_dir == "/dl"
    assert browser._policy is policy  # nothing to bind, so no copy


def test_a_file_policy_that_raises_hides_the_download_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    policy = DaytonaFilePolicy(download_dir="/dl", expose_download_paths=True)
    monkeypatch.setattr(
        type(policy), "is_path_visible", lambda self, path: 1 / 0, raising=True  # noqa: ARG005
    )
    browser = make_browser(monkeypatch, file_policy=policy)
    assert "path" not in completed_download(browser)


def test_durations_and_bounds(browser: DaytonaBrowser) -> None:
    cases: list[tuple[str, dict[str, object], str]] = [
        ("wait", {"duration": 30.5}, "between 0 and 30"),
        ("hold_key", {"text": "shift", "duration": 31}, "between 0 and 30"),
        ("key", {"text": "a", "repeat": 0}, "repeat"),
        (
            "left_click",
            {"target": {"type": "coordinate", "x": 1280, "y": 0}},
            "outside the 1280x800 viewport",
        ),
        (
            "scroll",
            {
                "target": {"type": "coordinate", "x": 1, "y": 1},
                "scroll_direction": "down",
                "scroll_amount": 11,
            },
            "between 1 and 10",
        ),
    ]
    for name, input, phrase in cases:
        result = call(browser, name, input)
        assert result.get("is_error") and phrase in text_of(result), (name, text_of(result))


def test_click_holds_modifiers(browser: DaytonaBrowser) -> None:
    call(
        browser,
        "left_click",
        {"target": {"type": "coordinate", "x": 5, "y": 6}, "modifiers": "ctrl+shift"},
    )
    page: Any = browser._tabs["tab_1"].page
    assert [c.args[0] for c in page.keyboard.down.call_args_list] == ["Control", "Shift"]
    assert [c.args[0] for c in page.keyboard.up.call_args_list] == ["Shift", "Control"]
    page.mouse.click.assert_called_once_with(5.0, 6.0, button="left", click_count=1)


def test_close_is_idempotent_and_releases_a_borrowed_sandbox(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sandbox = fake_sandbox()
    browser = make_browser(monkeypatch, sandbox=sandbox)
    browser.close()
    browser.close()
    sandbox.expire_signed_preview_url.assert_called_once_with(9222, "signed-token")
    assert "pkill" in sandbox.process.exec.call_args_list[-1].args[0]
    sandbox.delete.assert_not_called()


def test_owned_sandbox_is_deleted_even_if_launch_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    sandbox = fake_sandbox()
    client = MagicMock()
    client.create.return_value = sandbox

    def launch(self: DaytonaBrowser, chromium: str, headless: bool) -> int:
        raise RuntimeError("Chromium did not start")

    monkeypatch.setattr(DaytonaBrowser, "_launch", launch)
    with pytest.raises(RuntimeError):
        DaytonaBrowser(daytona=client)
    sandbox.delete.assert_called_once_with()


class OwnPolicy:
    """A `BetaFilePolicy` of the caller's own, judging sandbox paths it knows by name."""

    def resolve_upload_paths(self, context: BetaURLContext, paths: Sequence[str]) -> list[str]:
        return [path for path in paths if path.startswith("/task/uploads/")]

    def resolve_upload_documents(
        self, context: BetaURLContext, document_ids: Sequence[str]
    ) -> list[str]:
        raise ToolError("no documents")

    def is_path_visible(self, path: str) -> bool:
        return False


def test_a_custom_policy_does_not_let_a_link_carry_an_upload_out(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A custom policy judges the path as written; only the sandbox knows where it resolves to.
    Without roots to re-check against, a path that moved is refused rather than read."""
    browser = make_browser(monkeypatch, file_policy=OwnPolicy())
    sandbox: Any = browser.sandbox
    sandbox.process.exec.return_value = SimpleNamespace(exit_code=0, result="/etc/shadow\n")
    with pytest.raises(ToolError, match="link to another path"):
        browser._resolve_in_sandbox(["/task/uploads/notes.txt"])
    sandbox.process.exec.return_value = SimpleNamespace(
        exit_code=0, result="/task/uploads/notes.txt\n"
    )
    assert browser._resolve_in_sandbox(["/task/uploads/./notes.txt"]) == ["/task/uploads/notes.txt"]


def test_a_symlinked_upload_root_is_resolved_before_the_containment_check(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The roots go through the sandbox like the paths do, so a root that is a link to the real
    directory still admits what is under it — and a path that leaves it is still refused."""
    browser = make_browser(monkeypatch, file_policy=DaytonaFilePolicy(upload_roots=["/link"]))
    sandbox: Any = browser.sandbox
    sandbox.process.exec.side_effect = exec_script(
        {"realpath -e": (0, "/srv/real/a.txt\n"), "realpath -m": (0, "/srv/real\n")}
    )
    assert browser._resolve_in_sandbox(["/link/a.txt"]) == ["/srv/real/a.txt"]
    sandbox.process.exec.side_effect = exec_script(
        {"realpath -e": (0, "/etc/shadow\n"), "realpath -m": (0, "/srv/real\n")}
    )
    with pytest.raises(ToolError, match="outside the upload directory"):
        browser._resolve_in_sandbox(["/link/a.txt"])
    sandbox.process.exec.side_effect = exec_script(
        {"realpath -e": (0, "/srv/real/a.txt\n"), "realpath -m": (1, "")}
    )
    with pytest.raises(ToolError, match="could not be checked"):
        browser._resolve_in_sandbox(["/link/a.txt"])


def test_an_upload_root_that_resolves_to_the_filesystem_root_admits_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The constructor refuses `/` as a root, but only the sandbox knows where a root points. A
    root that is a link to `/` would otherwise re-check every path against a root that contains
    the whole filesystem, which is no check at all."""
    browser = make_browser(monkeypatch, file_policy=DaytonaFilePolicy(upload_roots=["/link"]))
    sandbox: Any = browser.sandbox
    sandbox.process.exec.side_effect = exec_script(
        {"realpath -e": (0, "/etc/shadow\n"), "realpath -m": (0, "/\n")}
    )
    with pytest.raises(ToolError, match="outside the upload directory"):
        browser._resolve_in_sandbox(["/link/../etc/shadow"])
    # Not even a path that really is under the link's target gets through it.
    sandbox.process.exec.side_effect = exec_script(
        {"realpath -e": (0, "/srv/real/a.txt\n"), "realpath -m": (0, "/\n")}
    )
    with pytest.raises(ToolError, match="outside the upload directory"):
        browser._resolve_in_sandbox(["/link/a.txt"])


def test_every_member_tells_the_sandbox_it_is_in_use_before_it_runs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A member is bounded, but it can take seconds; the refresh after it is not the only one."""
    browser = make_browser(monkeypatch)
    sandbox: Any = browser.sandbox
    browser._last_activity -= 61
    seen: list[bool] = []
    browser._tabs["tab_1"].page.wait_for_timeout = lambda ms: seen.append(  # type: ignore[method-assign]
        bool(sandbox.refresh_activity.call_args_list)
    )
    call(browser, "wait", {"duration": 0})
    assert seen == [True]  # refreshed before the member, not only in the report after it


def test_a_member_that_could_outlast_the_quiet_budget_refreshes_first(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The throttle counts the member's own bound, so the sandbox is never unheard from for
    `KEEP_ALIVE` plus a whole navigation — only `KEEP_ALIVE`."""
    browser = make_browser(monkeypatch)
    sandbox: Any = browser.sandbox
    bound = browser._member_bound()
    assert bound >= 30  # navigation_timeout dominates at the defaults
    # Too recent to refresh on its own, but not with a whole member still to come.
    browser._last_activity -= KEEP_ALIVE - bound + 1
    browser._keep_alive()
    sandbox.refresh_activity.assert_not_called()
    browser._keep_alive(reserve=bound)
    sandbox.refresh_activity.assert_called_once_with()
    assert KEEP_ALIVE < 60  # a sandbox on Daytona's shortest auto-stop interval stays up


def test_a_browsing_session_keeps_the_sandbox_from_auto_stopping(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """CDP traffic rides a preview URL, which Daytona does not count as activity, so the driver
    says so itself — throttled, and without touching the sandbox's own auto-stop interval."""
    browser = make_browser(monkeypatch)
    sandbox: Any = browser.sandbox
    state(browser)  # construction just talked to the sandbox; nothing to refresh yet
    sandbox.refresh_activity.assert_not_called()
    browser._last_activity -= 61
    state(browser)
    state(browser)
    sandbox.refresh_activity.assert_called_once_with()
    sandbox.set_autostop_interval.assert_not_called()


def test_a_failed_keep_alive_does_not_break_the_report(monkeypatch: pytest.MonkeyPatch) -> None:
    browser = make_browser(monkeypatch)
    sandbox: Any = browser.sandbox
    sandbox.refresh_activity.side_effect = RuntimeError("gone")
    browser._last_activity -= 61
    assert state(browser)["tabs"][0]["tab_id"] == "tab_1"


# --- launching Chromium in the sandbox -------------------------------------------------------


def exec_script(answers: dict[str, tuple[int, str]]) -> Callable[[str], Any]:
    """A `sandbox.process.exec` double answering by the first key the command contains."""

    def run(command: str, *args: Any, **kwargs: Any) -> SimpleNamespace:
        for fragment, (exit_code, out) in answers.items():
            if fragment in command:
                return SimpleNamespace(exit_code=exit_code, result=out)
        return SimpleNamespace(exit_code=0, result="")

    return run


def test_launch_takes_the_port_chromium_bound(monkeypatch: pytest.MonkeyPatch) -> None:
    browser = make_browser(monkeypatch)
    sandbox: Any = browser.sandbox
    sandbox.process.exec.side_effect = exec_script(
        {"head -n 1": (0, "45725\n/devtools/browser/abc\n"), "127.0.0.1:45725": (0, "")}
    )
    assert REAL_LAUNCH(browser, "chromium", True) == 45725
    commands = [c.args[0] for c in sandbox.process.exec.call_args_list]
    started = sandbox.process.execute_session_command.call_args.args[1].command
    # The kernel picks the port, so nothing can collide with a browser already in the sandbox.
    assert "--remote-debugging-port=0" in started
    assert any("rm -f --" in c and "DevToolsActivePort" in c for c in commands)
    assert any("127.0.0.1:45725/json/version" in c for c in commands)


def test_launch_waits_instead_of_probing_a_port_it_does_not_own(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Another Chromium answering on some port is not this driver's: without DevToolsActivePort
    in its own profile the launch times out loudly rather than attaching to it."""
    browser = make_browser(monkeypatch)
    sandbox: Any = browser.sandbox
    sandbox.process.exec.side_effect = exec_script({"head -n 1": (1, "")})
    monkeypatch.setattr("daytona_toolsets._chromium.time.sleep", lambda seconds: None)
    clock = iter([0.0, 0.0, 1.0, 100.0, 100.0])
    monkeypatch.setattr("daytona_toolsets._chromium.time.monotonic", lambda: next(clock))
    with pytest.raises(RuntimeError, match="Chromium did not start"):
        REAL_LAUNCH(browser, "chromium", True)
    assert not any(
        "/json/version" in c.args[0] for c in sandbox.process.exec.call_args_list
    )  # never probed a port it had no proof of


def test_launch_does_not_need_curl_in_the_sandbox(monkeypatch: pytest.MonkeyPatch) -> None:
    """The documented contract for a borrowed sandbox is Chromium on `PATH`. `curl` confirms the
    endpoint answers where it exists, but a sandbox without it must still come up: Chromium
    writes DevToolsActivePort only once the DevTools server is listening."""
    browser = make_browser(monkeypatch)
    sandbox: Any = browser.sandbox
    monkeypatch.setattr("daytona_toolsets._chromium.START_TIMEOUT", 0.5)
    monkeypatch.setattr("daytona_toolsets._chromium.POLL", 0.01)

    def run(command: str, *args: Any, **kwargs: Any) -> SimpleNamespace:
        if "head -n 1" in command:
            return SimpleNamespace(exit_code=0, result="45725\n/devtools/browser/abc\n")
        if "127.0.0.1:45725" in command:
            # The probe is a shell command; run this one for real, with nothing on PATH.
            done = subprocess.run(  # noqa: S603
                ["/bin/sh", "-c", command],
                env={"PATH": "/nonexistent"},
                capture_output=True,
            )
            return SimpleNamespace(exit_code=done.returncode, result=done.stdout.decode())
        return SimpleNamespace(exit_code=0, result="")

    sandbox.process.exec.side_effect = run
    assert REAL_LAUNCH(browser, "chromium", True) == 45725


def test_rank_prefers_elements_of_the_named_role() -> None:
    candidates: list[dict[str, Any]] = [
        {"line": "p", "role": "paragraph", "name": "The button was clicked.", "attrs": ""},
        {"line": "b", "role": "button", "name": "Click me", "attrs": "", "interactive": True},
        {"line": "s", "role": "textbox", "name": "", "attrs": "Search the docs q"},
    ]
    assert [c["line"] for c in rank("click me button", candidates)][:1] == ["b"]
    assert [c["line"] for c in rank("search box", candidates)][:1] == ["s"]
    assert rank("nothing like it", candidates) == []


def test_format_remote() -> None:
    assert format_remote({"type": "undefined"}) == "undefined"
    assert format_remote({"type": "string", "value": "hi"}) == "hi"
    assert format_remote({"type": "object", "value": {"a": [1]}}) == '{"a": [1]}'
    assert format_remote({"type": "number", "unserializableValue": "NaN"}) == "NaN"
