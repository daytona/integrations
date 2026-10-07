from __future__ import annotations

from collections.abc import Callable, Iterator
from typing import Any
from unittest.mock import MagicMock

import pytest
from anthropic.tools import ToolError, ToolsetConfigError
from anthropic.tools.browser import BetaDialogDismissed, BetaLocalFilePolicy, BetaNavigationRefused
from anthropic.tools.browser import BetaURLContext

from daytona_toolsets import DaytonaBrowser, DaytonaFilePolicy
from daytona_toolsets.browser import failure_phrase, format_remote, normalize_url, rank

from .conftest import blocks_of, call, fake_sandbox, text_of


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


# --- DaytonaFilePolicy -----------------------------------------------------------------------

CONTEXT = BetaURLContext(member="file_upload")


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
    assert changes[1]["path"] == f"{browser.download_dir}/g1"
    assert changes[3] == {
        "type": "download_failed",
        "download_id": "g2",
        "url": "https://a.test/g.zip",
        "error": "The download was cancelled or failed.",
    }


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
