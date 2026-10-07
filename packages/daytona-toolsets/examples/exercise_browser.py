"""Exercise DaytonaBrowser with the calls a model would make, against a real Daytona sandbox: no
model and no Anthropic API key.

Usage:

    python exercise_browser.py

It creates a sandbox (deleted at the end), serves a few test pages inside it on localhost, and sends
every member the driver implements through `toolset.tool_result(...)`, the entry point the tool
runner uses. It prints each `tool_result` as the model would see it and checks it: what should be
answered is, the effects show up in the page, and what should be refused (other schemes, addresses
the URL policy refuses, bad coordinates, stale refs, uploads outside the upload directory) comes back
as `is_error`. Every `browser_state` block is checked against the API's rules. Finally it checks that
a sandbox passed in by the caller survives `close()` with the driver's Chromium stopped.

The first mismatch ends the script with a failed assertion (exit status 1). Needs `DAYTONA_API_KEY`.
"""

from __future__ import annotations

import base64
import io
import json
import re
import sys
import time
from typing import Any
from urllib.parse import urlsplit

from anthropic.tools import ToolError
from anthropic.tools.browser import BetaURLContext
from anthropic.types.beta import BetaToolResultBlockParam, BetaToolUseBlock
from daytona import CreateSandboxFromSnapshotParams, Daytona, Sandbox, SessionExecuteRequest
from PIL import Image

from daytona_toolsets import DaytonaBrowser, DaytonaFilePolicy

ORIGIN = "http://localhost:8000"
UPLOADS = "/tmp/exercise-uploads"

INDEX = """<!doctype html>
<title>Exercise page</title>
<h1>Exercise page</h1>
<p id="status">The button has not been clicked.</p>
<button onclick="document.getElementById('status').textContent = 'The button was clicked.'">Click me</button>
<button onclick="alert('Hello from the page')">Show alert</button>
<button onclick="document.getElementById('status').textContent = 'confirm returned ' + confirm('Delete everything?')">Ask confirm</button>
<p><a href="/second">Second page</a> · <a href="/second" target="_blank">Second page in a new tab</a>
 · <a href="/file.txt">Download the file</a> · <a href="http://127.0.0.1:8000/elsewhere">Refused link</a></p>
<label>Name <input id="name" placeholder="Your name"></label>
<label>Colour <select id="colour"><option value="r">Red option</option><option value="g">Green option</option></select></label>
<label><input type="checkbox" id="agree"> I agree</label>
<label>Attachment <input type="file" id="upload" onchange="document.getElementById('status').textContent = 'uploaded: ' + Array.from(this.files, f => f.name + ' ' + f.size).join(', ')"></label>
<img src="http://127.0.0.1:8000/tracker.png" alt="">
<div style="position: fixed; top: 10px; right: 10px; width: 80px; height: 40px; background: rgb(255, 0, 0)"></div>
<div style="height: 3000px"></div>
<h2>Bottom marker</h2>
<script>console.log('exercise page loaded'); console.warn('a warning')</script>
"""

SERVER = r"""
import http.server, sys
PAGES = {"/": ("text/html", open(sys.argv[1]).read().encode()),
         "/second": ("text/html", b"<!doctype html><title>Second page</title><h1>Second page</h1>")}
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/file.txt":
            body = b"downloaded content\n"
            self.send_response(200); self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Disposition", "attachment; filename=file.txt")
        elif self.path in PAGES:
            kind, body = PAGES[self.path]
            self.send_response(200); self.send_header("Content-Type", kind + "; charset=utf-8")
        else:
            body = b"not found"; self.send_response(404)
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *args): pass
http.server.ThreadingHTTPServer(("127.0.0.1", 8000), Handler).serve_forever()
"""


def policy(_context: BetaURLContext, url: str) -> None:
    """Admits this exercise's own server (and the empty tab), refuses every other web address. It
    passes other schemes on, so the exercise sees the driver's own scheme refusal."""
    parts = urlsplit(url)
    if url == "about:blank" or parts.scheme not in ("http", "https", ""):
        return
    if f"{parts.scheme}://{parts.netloc}" != ORIGIN:
        raise ToolError("blocked: not this exercise's server")


def call(browser: DaytonaBrowser, name: str, input: dict[str, object]) -> BetaToolResultBlockParam:
    tool_use = BetaToolUseBlock(
        type="tool_use", id=f"toolu_{name}", name=name, input=input, toolset_name="browser"
    )
    result = browser.tool_result(tool_use)
    print(f"\n{name} {json.dumps(input)} -> {'refused' if result.get('is_error') else 'answered'}")
    for block in blocks_of(result):
        if block.get("type") == "image":
            block = {**block, "source": {**block["source"], "data": "<png>"}}
        text = json.dumps(block)
        print("  " + (text if len(text) < 600 else text[:600] + " …"))
    if not result.get("is_error"):
        check_state(result)
    return result


def blocks_of(result: BetaToolResultBlockParam) -> list[dict[str, Any]]:
    content = result.get("content", "")
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return [dict(block) for block in content]


def text_of(result: BetaToolResultBlockParam) -> str:
    return "\n".join(str(b.get("text", "")) for b in blocks_of(result) if b.get("type") == "text")


def state_of(result: BetaToolResultBlockParam) -> dict[str, Any]:
    states = [b for b in blocks_of(result) if b.get("type") == "browser_state"]
    assert len(states) == 1, "expected one browser_state block on an answered call"
    return states[0]


def check_state(result: BetaToolResultBlockParam) -> None:
    """The API's rules for a browser_state block: unique tab ids, exactly one active tab when any
    is open, at most 100 tabs."""
    tabs = list(state_of(result)["tabs"])
    ids = [tab["tab_id"] for tab in tabs]
    assert len(ids) == len(set(ids)), f"duplicate tab ids: {ids}"
    assert len(tabs) <= 100
    if tabs:
        assert sum(1 for tab in tabs if tab.get("active")) == 1, f"not exactly one active: {tabs}"


def active_tab(result: BetaToolResultBlockParam) -> str:
    return str(next(t["tab_id"] for t in state_of(result)["tabs"] if t.get("active")))


def answered(
    browser: DaytonaBrowser, name: str, input: dict[str, object]
) -> BetaToolResultBlockParam:
    result = call(browser, name, input)
    assert not result.get("is_error"), f"expected that {name} {input} is answered"
    return result


def refused(browser: DaytonaBrowser, name: str, input: dict[str, object], phrase: str) -> None:
    result = call(browser, name, input)
    assert result.get("is_error") is True and phrase in text_of(
        result
    ), f"expected that {name} {input} is refused with {phrase!r}"


def ref_of(tree: str, needle: str) -> str:
    line = next((line for line in tree.splitlines() if needle in line), "")
    match = re.search(r"\[(ref_\d+)\]", line)
    assert match, f"expected a ref for {needle!r} in:\n{tree}"
    return match.group(1)


def js(browser: DaytonaBrowser, script: str, **extra: object) -> str:
    return text_of(answered(browser, "javascript_exec", {"text": script, **extra}))


def serve(sandbox: Sandbox) -> None:
    sandbox.fs.upload_file(INDEX.encode(), "/tmp/exercise-index.html")
    sandbox.fs.upload_file(SERVER.encode(), "/tmp/exercise-server.py")
    sandbox.process.create_session("exercise-server")
    sandbox.process.execute_session_command(
        "exercise-server",
        SessionExecuteRequest(
            command="python3 /tmp/exercise-server.py /tmp/exercise-index.html", run_async=True
        ),
    )
    for _ in range(40):
        if sandbox.process.exec(f"curl -sf -o /dev/null {ORIGIN}/").exit_code == 0:
            return
        time.sleep(0.25)
    raise RuntimeError("the exercise's page server did not start")


def exercise(browser: DaytonaBrowser) -> None:
    serve(browser.sandbox)
    browser.sandbox.process.exec(
        f"mkdir -p {UPLOADS} && printf 'hello upload' > {UPLOADS}/hello.txt && "
        f"ln -sf /etc/passwd {UPLOADS}/escape.txt"
    )

    # navigation
    first = answered(browser, "navigate", {"url": f"{ORIGIN}/"})
    assert f"Navigated to {ORIGIN}/ — Exercise page (HTTP 200)" in text_of(first)
    assert active_tab(first) == "tab_1"
    tree = text_of(answered(browser, "read_page", {}))
    assert 'heading "Exercise page"' in tree and "level=1" in tree
    button = ref_of(tree, '"Click me"')

    # clicks by ref, and what they did
    answered(browser, "left_click", {"target": {"type": "ref", "ref": button}})
    assert "The button was clicked." in text_of(answered(browser, "get_page_text", {}))
    found = text_of(answered(browser, "find", {"query": "click me button"}))
    assert found.splitlines()[0].endswith(
        f"[{button}]"
    ), f"expected find to rank the button first:\n{found}"

    # forms
    name, colour, agree = (
        ref_of(tree, 'textbox "Name"'),
        ref_of(tree, 'combobox "Colour"'),
        ref_of(tree, 'checkbox "I agree"'),
    )
    answered(browser, "form_input", {"target": {"type": "ref", "ref": name}, "value": "Ada"})
    answered(
        browser, "form_input", {"target": {"type": "ref", "ref": colour}, "value": "Green option"}
    )
    answered(browser, "form_input", {"target": {"type": "ref", "ref": agree}, "value": True})
    read = text_of(answered(browser, "read_page", {"filter": "interactive"}))
    assert 'value="Ada"' in read and 'selected="Green option"' in read and "checked" in read
    refused(
        browser,
        "form_input",
        {"target": {"type": "ref", "ref": agree}, "value": "yes"},
        "true or false",
    )

    # keyboard
    answered(browser, "left_click", {"target": {"type": "ref", "ref": name}})
    answered(browser, "key", {"text": "ctrl+a"})
    answered(browser, "type", {"text": "typed text"})
    answered(browser, "key", {"text": "shift+Home BackSpace", "repeat": 1})
    answered(browser, "type", {"text": "Grace"})
    assert js(browser, "document.querySelector('#name').value") == "Grace"
    answered(browser, "hold_key", {"text": "shift", "duration": 0.5})
    answered(browser, "key", {"text": "Tab"})
    refused(browser, "key", {"text": "NoSuchKey"}, "Unknown key")

    # the pointer
    for member in ("double_click", "triple_click", "right_click", "middle_click"):
        answered(browser, member, {"target": {"type": "coordinate", "x": 300, "y": 30}})
    answered(
        browser,
        "left_click",
        {"target": {"type": "coordinate", "x": 300, "y": 30}, "modifiers": "shift"},
    )
    answered(browser, "hover", {"target": {"type": "ref", "ref": button}})
    answered(browser, "mouse_move", {"target": {"type": "coordinate", "x": 10, "y": 10}})
    answered(browser, "left_mouse_down", {"target": {"type": "coordinate", "x": 10, "y": 10}})
    answered(browser, "left_mouse_up", {"target": {"type": "coordinate", "x": 50, "y": 10}})
    answered(
        browser,
        "left_click_drag",
        {
            "from": {"type": "coordinate", "x": 10, "y": 10},
            "target": {"type": "coordinate", "x": 60, "y": 10},
        },
    )
    refused(
        browser,
        "left_click",
        {"target": {"type": "coordinate", "x": 1280, "y": 5}},
        "outside the 1280x800 viewport",
    )

    # screenshots: the viewport, and a zoom on the fixed red box in the top-right corner
    shot = answered(browser, "screenshot", {})
    png = base64.b64decode(
        next(b for b in blocks_of(shot) if b["type"] == "image")["source"]["data"]
    )
    assert Image.open(io.BytesIO(png)).size == (1280, 800)
    answered(
        browser,
        "scroll",
        {
            "target": {"type": "coordinate", "x": 640, "y": 400},
            "scroll_direction": "down",
            "scroll_amount": 5,
        },
    )
    assert float(js(browser, "window.scrollY")) > 0, "expected the page to scroll"
    zoomed = answered(browser, "zoom", {"region": [1190, 10, 1270, 50]})
    data = base64.b64decode(
        next(b for b in blocks_of(zoomed) if b["type"] == "image")["source"]["data"]
    )
    image = Image.open(io.BytesIO(data)).convert("RGB")
    assert image.width > 80 and image.getpixel((image.width // 2, image.height // 2)) == (
        255,
        0,
        0,
    ), "expected the zoom to show the red box, scaled up, while the page is scrolled"
    refused(browser, "zoom", {"region": [10, 10, 5, 5]}, "region must satisfy")
    everything = text_of(answered(browser, "read_page", {"filter": "all"}))
    answered(
        browser,
        "scroll_to",
        {"target": {"type": "ref", "ref": ref_of(everything, "Bottom marker")}},
    )
    assert float(js(browser, "window.scrollY")) > 2000, "expected scroll_to to reach the bottom"
    refused(
        browser,
        "scroll",
        {
            "target": {"type": "coordinate", "x": 5, "y": 5},
            "scroll_direction": "up",
            "scroll_amount": 11,
        },
        "between 1 and 10",
    )

    # dialogs are dismissed and reported
    alert_ref = ref_of(tree, '"Show alert"')
    alerted = answered(browser, "left_click", {"target": {"type": "ref", "ref": alert_ref}})
    assert "alert" in text_of(alerted) and "Hello from the page" in text_of(
        alerted
    ), "expected the alert reported"
    answered(
        browser, "left_click", {"target": {"type": "ref", "ref": ref_of(tree, '"Ask confirm"')}}
    )
    assert "confirm returned false" in text_of(answered(browser, "get_page_text", {}))

    # console and network
    answered(browser, "navigate", {"url": "reload"})
    console = text_of(answered(browser, "read_console", {}))
    assert "[log] exercise page loaded" in console and "[warning] a warning" in console, console
    network = text_of(answered(browser, "read_network", {}))
    assert (
        "GET 200 text/html" in network and "ERR_BLOCKED_BY_CLIENT" in network
    ), "expected the page load and the intercepted tracker request"

    # javascript_exec in the page's world
    assert js(browser, "({a: 1, b: [2, 3]})") == '{"a": 1, "b": [2, 3]}'
    assert js(browser, "let x = 6; x * 7") == "42"
    refused(browser, "javascript_exec", {"text": "throw new Error('nope')"}, "The script threw")

    # a page-started navigation that the URL policy refuses
    tree = text_of(answered(browser, "read_page", {}))
    clicked = answered(
        browser, "left_click", {"target": {"type": "ref", "ref": ref_of(tree, '"Refused link"')}}
    )
    after = answered(browser, "wait", {"duration": 1})
    assert "A navigation was refused." in text_of(clicked) + text_of(after)
    # Chromium shows its error page for the refused address, as for any blocked navigation.
    answered(browser, "navigate", {"url": f"{ORIGIN}/"})
    tree = text_of(answered(browser, "read_page", {}))

    # downloads land in the sandbox, reported with their source URL
    # (a small file completes within the click's own call, so its report says completed at once)
    download = answered(
        browser,
        "left_click",
        {"target": {"type": "ref", "ref": ref_of(tree, '"Download the file"')}},
    )
    seen: list[dict[str, Any]] = [
        change
        for result in (download, answered(browser, "wait", {"duration": 2}))
        for change in state_of(result).get("state_changes") or []
    ]
    completed = [c for c in seen if c["type"] == "download_completed"]
    assert (
        completed and completed[0]["url"] == f"{ORIGIN}/file.txt" and "path" not in completed[0]
    ), seen
    listing = browser.sandbox.process.exec(f"cat {browser.download_dir}/*").result
    assert (
        "downloaded content" in listing
    ), "expected the download in the sandbox's download directory"

    # uploads: a path in the upload directory, resolved inside the sandbox
    upload = ref_of(tree, "type=file")
    answered(
        browser,
        "file_upload",
        {"target": {"type": "ref", "ref": upload}, "paths": [f"{UPLOADS}/hello.txt"]},
    )
    assert "uploaded: hello.txt 12" in text_of(answered(browser, "get_page_text", {}))
    refused(
        browser,
        "file_upload",
        {"target": {"type": "ref", "ref": upload}, "paths": ["/etc/passwd"]},
        "outside the upload directory",
    )
    refused(
        browser,
        "file_upload",
        {"target": {"type": "ref", "ref": upload}, "paths": [f"{UPLOADS}/escape.txt"]},
        "outside the upload directory",
    )
    refused(
        browser,
        "file_upload",
        {"target": {"type": "ref", "ref": upload}, "document_ids": ["file_x"]},
        "Files API",
    )

    # tabs: a popup opens a tab, which becomes active; every member honours tab_id
    popup = answered(
        browser,
        "left_click",
        {"target": {"type": "ref", "ref": ref_of(tree, '"Second page in a new tab"')}},
    )
    state = state_of(popup)
    assert len(state["tabs"]) == 2 and active_tab(popup) == "tab_2", state
    assert {"type": "tab_opened", "tab_id": "tab_2"} in list(state.get("state_changes") or [])
    listed = answered(browser, "list_tabs", {})
    assert [t["tab_id"] for t in state_of(listed)["tabs"]] == ["tab_1", "tab_2"]
    assert active_tab(answered(browser, "switch_tab", {"tab_id": "tab_1"})) == "tab_1"
    assert "Second page" in text_of(answered(browser, "get_page_text", {"tab_id": "tab_2"}))
    assert js(browser, "document.title", tab_id="tab_2") == "Second page"
    assert js(browser, "document.title") == "Exercise page", "expected the active tab to be tab_1"
    opened = answered(browser, "new_tab", {})
    assert active_tab(opened) == "tab_3"
    refused(browser, "navigate", {"url": "back"}, "no page to go back")
    answered(browser, "navigate", {"url": f"{ORIGIN}/second", "tab_id": "tab_3"})
    answered(browser, "navigate", {"url": f"{ORIGIN}/", "tab_id": "tab_3"})
    back = answered(browser, "navigate", {"url": "back", "tab_id": "tab_3"})
    assert "Second page" in text_of(back)
    forward = answered(browser, "navigate", {"url": "forward", "tab_id": "tab_3"})
    assert "Exercise page" in text_of(forward)
    closed = answered(browser, "close_tab", {"tab_id": "tab_3"})
    assert [t["tab_id"] for t in state_of(closed)["tabs"]] == ["tab_1", "tab_2"]
    answered(browser, "close_tab", {"tab_id": "tab_2"})
    refused(browser, "switch_tab", {"tab_id": "tab_2"}, "not open")

    # refusals: other schemes (the driver), other hosts (the URL policy), stale refs, bounds
    for url in (
        "javascript:alert(1)",
        "view-source:http://localhost:8000/",
        "data:text/html,hi",
        "file:///etc/passwd",
    ):
        refused(browser, "navigate", {"url": url}, "does not open")
    refused(browser, "navigate", {"url": "http://127.0.0.1:8000/"}, "blocked")
    answered(browser, "navigate", {"url": f"{ORIGIN}/second"})
    refused(browser, "left_click", {"target": {"type": "ref", "ref": button}}, "stale ref")
    answered(browser, "wait", {"duration": 1})
    refused(browser, "wait", {"duration": 31}, "between 0 and 30")
    refused(browser, "hold_key", {"text": "shift", "duration": 31}, "between 0 and 30")


def main() -> None:
    options: dict[str, Any] = {
        "url_policy": policy,
        "file_policy": DaytonaFilePolicy(upload_roots=[UPLOADS]),
        "configs": {
            name: {"enabled": True}
            for name in ("read_console", "read_network", "javascript_exec", "file_upload")
        },
        "confirm": lambda context: True,  # no one is at the terminal: approve every call
    }
    try:
        browser = DaytonaBrowser(**options)
    except Exception as error:
        print(f"error: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
    sandbox_id = browser.sandbox.id
    print(f"sandbox {sandbox_id}")
    with browser:
        exercise(browser)
    browser.close()
    time.sleep(2)
    try:
        state = str(Daytona().get(sandbox_id).state)
    except Exception:
        state = "gone"
    assert "destroy" in state or state == "gone", f"expected the owned sandbox deleted: {state}"

    # A sandbox the caller passes in survives close(); the driver's Chromium does not.
    borrowed = Daytona().create(
        CreateSandboxFromSnapshotParams(labels={"created-by": "daytona-toolsets"})
    )
    try:
        with DaytonaBrowser(borrowed, url_policy=policy) as browser:
            answered(browser, "navigate", {"url": "about:blank"})
        borrowed.refresh_data()
        assert str(getattr(borrowed.state, "value", borrowed.state)) == "started"
        running = borrowed.process.exec("pgrep -f daytona-toolsets- || true").result.strip()
        assert not running, f"expected the driver's Chromium stopped: {running}"
    finally:
        borrowed.delete()
    print("\nAll calls came back as expected.")


if __name__ == "__main__":
    main()
