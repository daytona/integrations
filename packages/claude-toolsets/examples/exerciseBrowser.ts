// allow: SIZE_OK — one indivisible linear scenario. `exercise()` drives all 31 browser members in
// the single order their state allows (a ref read from one page is spent by the next click), so
// every split would thread the page, the tree and five live refs between the pieces. It is a
// statement-for-statement port of examples/exercise_browser.py, and stays readable against it.
/**
 * Exercise DaytonaBrowser with the calls a model would make, against a real Daytona sandbox: no
 * model and no Anthropic API key.
 *
 * Usage:
 *
 *     npm run example:exercise-browser
 *     CTTS_SANDBOX_ID=sbx-… npm run example:exercise-browser   # borrow a sandbox you already have
 *
 * It creates a sandbox (deleted at the end), serves a few test pages inside it on localhost, and
 * sends every member the driver implements through `toolset.toolResult(...)`, the entry point the
 * tool runner uses. It prints each `tool_result` as the model would see it and checks it: what
 * should be answered is, the effects show up in the page, and what should be refused (other
 * schemes, addresses the URL policy refuses, bad coordinates, stale refs, uploads outside the
 * upload directory) comes back as `is_error`. Every browser-state block is checked against the
 * API's rules. Finally it checks that a sandbox passed in by the caller survives `close()` with the
 * driver's Chromium stopped.
 *
 * `exercise(browser)` is exported on its own, so a harness that already holds a sandbox can run the
 * same checks against a driver it built itself. `main()` is the standalone path: with
 * `CTTS_SANDBOX_ID` set it borrows that sandbox and checks it outlives the run, and without it the
 * script owns a sandbox of its own and checks it is deleted. The passed-in-sandbox scenario below
 * creates a sandbox of its own, so it runs only when the script was not handed one.
 *
 * The first mismatch ends the script with a failed assertion (exit status 1). Needs `DAYTONA_API_KEY`.
 */
import { strict as assert } from "node:assert";

import { ToolError } from "@anthropic-ai/sdk/helpers/beta/toolsets";
import type { BetaURLPolicy } from "@anthropic-ai/sdk/helpers/beta/toolsets";
import type {
  BetaBrowserStateBlockParam,
  BetaToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/beta";
import type { Sandbox } from "@daytona/sdk";

import { DaytonaBrowser, DaytonaFilePolicy } from "../src/index.js";
import { decodePng } from "../src/png.js";
import {
  blocksOf,
  borrowedSandbox,
  invokedDirectly,
  pngOf,
  pngSize,
  printBlocks,
  reportFailure,
  sleep,
  stateOfSandbox,
  textOf,
  throwawaySandbox,
} from "./support.js";

const ORIGIN = "http://localhost:8000";
const UPLOADS = "/tmp/exercise-uploads";
const MAX_TABS = 100;
const PRINT_LIMIT = 600;
const SERVER_SESSION = "exercise-server";

const INDEX = `<!doctype html>
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
`;

// String.raw, so the `\n` below reaches the sandbox as the two characters Python's own string
// literal needs rather than as a newline that would cut that literal in half.
const SERVER = String.raw`
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
`;

/**
 * Admits this exercise's own server (and the empty tab), refuses every other web address. It passes
 * other schemes on, so the exercise sees the driver's own scheme refusal.
 */
const policy: BetaURLPolicy = (_context, url: string): void => {
  // urlsplit's shape, not the URL constructor's: a scheme the constructor rejects must reach the
  // driver untouched so its own refusal is what the exercise observes.
  const parts = /^(?:([a-zA-Z][a-zA-Z0-9+.-]*):)?(?:\/\/([^/?#]*))?/u.exec(url);
  const scheme = (parts?.[1] ?? "").toLowerCase();
  const netloc = parts?.[2] ?? "";
  if (url === "about:blank" || !["http", "https", ""].includes(scheme)) return;
  if (`${scheme}://${netloc}` !== ORIGIN) throw new ToolError("blocked: not this exercise's server");
};

const stateOf = (result: BetaToolResultBlockParam): BetaBrowserStateBlockParam => {
  const [state, ...rest] = blocksOf(result).filter((block) => block.type === "browser_state");
  assert.ok(state !== undefined && rest.length === 0, "expected one browser_state block on an answered call");
  return state;
};

/**
 * The API's rules for a browser-state block: unique tab ids, exactly one active tab when any is
 * open, at most 100 tabs.
 */
const checkState = (result: BetaToolResultBlockParam): void => {
  const tabs = stateOf(result).tabs;
  const ids = tabs.map((tab) => tab.tab_id);
  assert.equal(new Set(ids).size, ids.length, `duplicate tab ids: ${ids.join(", ")}`);
  assert.ok(tabs.length <= MAX_TABS);
  if (tabs.length > 0) {
    const active = tabs.filter((tab) => Boolean(tab.active));
    assert.equal(active.length, 1, `not exactly one active: ${JSON.stringify(tabs)}`);
  }
};

const activeTab = (result: BetaToolResultBlockParam): string => {
  const tab = stateOf(result).tabs.find((entry) => Boolean(entry.active));
  assert.ok(tab !== undefined, "expected an active tab");
  return tab.tab_id;
};

const refOf = (tree: string, needle: string): string => {
  const line = tree.split("\n").find((candidate) => candidate.includes(needle)) ?? "";
  const match = /\[(ref_\d+)\]/u.exec(line);
  assert.ok(match?.[1] !== undefined, `expected a ref for ${JSON.stringify(needle)} in:\n${tree}`);
  return match[1];
};

/** Send tool calls as the model would, printing and checking each result. */
class BrowserCalls {
  constructor(private readonly browser: DaytonaBrowser) {}

  async call(name: string, input: object): Promise<BetaToolResultBlockParam> {
    const result = await this.browser.toolResult({
      type: "tool_use",
      id: `toolu_${name}`,
      name,
      input,
      toolset_name: "browser",
    });
    console.log(`\n${name} ${JSON.stringify(input)} -> ${result.is_error === true ? "refused" : "answered"}`);
    printBlocks(result, "<png>", PRINT_LIMIT);
    if (result.is_error !== true) checkState(result);
    return result;
  }

  async answered(name: string, input: object): Promise<BetaToolResultBlockParam> {
    const result = await this.call(name, input);
    assert.ok(result.is_error !== true, `expected that ${name} ${JSON.stringify(input)} is answered`);
    return result;
  }

  async text(name: string, input: object): Promise<string> {
    return textOf(await this.answered(name, input));
  }

  async refused(name: string, input: object, phrase: string): Promise<void> {
    const result = await this.call(name, input);
    assert.ok(
      result.is_error === true && textOf(result).includes(phrase),
      `expected that ${name} ${JSON.stringify(input)} is refused with ${JSON.stringify(phrase)}`,
    );
  }

  async js(script: string, tabId?: string): Promise<string> {
    return this.text("javascript_exec", { text: script, ...(tabId === undefined ? {} : { tab_id: tabId }) });
  }
}

const serve = async (sandbox: Sandbox): Promise<void> => {
  await sandbox.fs.uploadFile(Buffer.from(INDEX), "/tmp/exercise-index.html");
  await sandbox.fs.uploadFile(Buffer.from(SERVER), "/tmp/exercise-server.py");
  await sandbox.process.createSession(SERVER_SESSION);
  await sandbox.process.executeSessionCommand(SERVER_SESSION, {
    command: "python3 /tmp/exercise-server.py /tmp/exercise-index.html",
    runAsync: true,
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const probe = await sandbox.process.executeCommand(`curl -sf -o /dev/null ${ORIGIN}/`);
    if (probe.exitCode === 0) return;
    await sleep(0.25);
  }
  throw new Error("the exercise's page server did not start");
};

export const exercise = async (browser: DaytonaBrowser): Promise<void> => {
  const calls = new BrowserCalls(browser);
  await serve(browser.sandbox);
  await browser.sandbox.process.executeCommand(
    `mkdir -p ${UPLOADS} && printf 'hello upload' > ${UPLOADS}/hello.txt && ` +
      `ln -sf /etc/passwd ${UPLOADS}/escape.txt`,
  );

  // navigation
  const first = await calls.answered("navigate", { url: `${ORIGIN}/` });
  assert.ok(textOf(first).includes(`Navigated to ${ORIGIN}/ — Exercise page (HTTP 200)`), textOf(first));
  assert.equal(activeTab(first), "tab_1");
  let tree = await calls.text("read_page", {});
  assert.ok(tree.includes('heading "Exercise page"') && tree.includes("level=1"), tree);
  const button = refOf(tree, '"Click me"');

  // clicks by ref, and what they did
  await calls.answered("left_click", { target: { type: "ref", ref: button } });
  assert.ok((await calls.text("get_page_text", {})).includes("The button was clicked."));
  const found = await calls.text("find", { query: "click me button" });
  assert.ok(
    found.split("\n")[0]?.endsWith(`[${button}]`) === true,
    `expected find to rank the button first:\n${found}`,
  );

  // forms
  const name = refOf(tree, 'textbox "Name"');
  const colour = refOf(tree, 'combobox "Colour"');
  const agree = refOf(tree, 'checkbox "I agree"');
  await calls.answered("form_input", { target: { type: "ref", ref: name }, value: "Ada" });
  await calls.answered("form_input", { target: { type: "ref", ref: colour }, value: "Green option" });
  await calls.answered("form_input", { target: { type: "ref", ref: agree }, value: true });
  const read = await calls.text("read_page", { filter: "interactive" });
  assert.ok(
    read.includes('value="Ada"') && read.includes('selected="Green option"') && read.includes("checked"),
    read,
  );
  await calls.refused("form_input", { target: { type: "ref", ref: agree }, value: "yes" }, "true or false");

  // keyboard
  await calls.answered("left_click", { target: { type: "ref", ref: name } });
  await calls.answered("key", { text: "ctrl+a" });
  await calls.answered("type", { text: "typed text" });
  await calls.answered("key", { text: "shift+Home BackSpace", repeat: 1 });
  await calls.answered("type", { text: "Grace" });
  assert.equal(await calls.js("document.querySelector('#name').value"), "Grace");
  await calls.answered("hold_key", { text: "shift", duration: 0.5 });
  await calls.answered("key", { text: "Tab" });
  await calls.refused("key", { text: "NoSuchKey" }, "Unknown key");

  // the pointer
  for (const member of ["double_click", "triple_click", "right_click", "middle_click"]) {
    await calls.answered(member, { target: { type: "coordinate", x: 300, y: 30 } });
  }
  await calls.answered("left_click", { target: { type: "coordinate", x: 300, y: 30 }, modifiers: "shift" });
  await calls.answered("hover", { target: { type: "ref", ref: button } });
  await calls.answered("mouse_move", { target: { type: "coordinate", x: 10, y: 10 } });
  await calls.answered("left_mouse_down", { target: { type: "coordinate", x: 10, y: 10 } });
  await calls.answered("left_mouse_up", { target: { type: "coordinate", x: 50, y: 10 } });
  await calls.answered("left_click_drag", {
    from: { type: "coordinate", x: 10, y: 10 },
    target: { type: "coordinate", x: 60, y: 10 },
  });
  await calls.refused(
    "left_click",
    { target: { type: "coordinate", x: 1280, y: 5 } },
    "outside the 1280x800 viewport",
  );

  // screenshots: the viewport, and a zoom on the fixed red box in the top-right corner
  const shot = await calls.answered("screenshot", {});
  assert.deepEqual(pngSize(pngOf(shot)), [1280, 800]);
  await calls.answered("scroll", {
    target: { type: "coordinate", x: 640, y: 400 },
    scroll_direction: "down",
    scroll_amount: 5,
  });
  assert.ok(Number(await calls.js("window.scrollY")) > 0, "expected the page to scroll");
  const zoomed = await calls.answered("zoom", { region: [1190, 10, 1270, 50] });
  const image = decodePng(pngOf(zoomed));
  const centre = (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)) * 4;
  assert.ok(
    image.width > 80 &&
      image.data[centre] === 255 &&
      image.data[centre + 1] === 0 &&
      image.data[centre + 2] === 0,
    "expected the zoom to show the red box, scaled up, while the page is scrolled",
  );
  await calls.refused("zoom", { region: [10, 10, 5, 5] }, "region must satisfy");
  const everything = await calls.text("read_page", { filter: "all" });
  await calls.answered("scroll_to", {
    target: { type: "ref", ref: refOf(everything, "Bottom marker") },
  });
  assert.ok(Number(await calls.js("window.scrollY")) > 2000, "expected scroll_to to reach the bottom");
  await calls.refused(
    "scroll",
    { target: { type: "coordinate", x: 5, y: 5 }, scroll_direction: "up", scroll_amount: 11 },
    "between 1 and 10",
  );

  // dialogs are dismissed and reported
  const alerted = await calls.text("left_click", { target: { type: "ref", ref: refOf(tree, '"Show alert"') } });
  assert.ok(alerted.includes("alert") && alerted.includes("Hello from the page"), "expected the alert reported");
  await calls.answered("left_click", { target: { type: "ref", ref: refOf(tree, '"Ask confirm"') } });
  assert.ok((await calls.text("get_page_text", {})).includes("confirm returned false"));

  // console and network
  await calls.answered("navigate", { url: "reload" });
  const console_ = await calls.text("read_console", {});
  assert.ok(
    console_.includes("[log] exercise page loaded") && console_.includes("[warning] a warning"),
    console_,
  );
  const network = await calls.text("read_network", {});
  assert.ok(
    network.includes("GET 200 text/html") && network.includes("ERR_BLOCKED_BY_CLIENT"),
    "expected the page load and the intercepted tracker request",
  );

  // javascript_exec in the page's world
  assert.equal(await calls.js("({a: 1, b: [2, 3]})"), '{"a":1,"b":[2,3]}');
  assert.equal(await calls.js("let x = 6; x * 7"), "42");
  await calls.refused("javascript_exec", { text: "throw new Error('nope')" }, "The script threw");

  // a page-started navigation that the URL policy refuses
  tree = await calls.text("read_page", {});
  const clicked = await calls.text("left_click", { target: { type: "ref", ref: refOf(tree, '"Refused link"') } });
  const after = await calls.text("wait", { duration: 1 });
  assert.ok((clicked + after).includes("A navigation was refused."));
  // Chromium shows its error page for the refused address, as for any blocked navigation.
  await calls.answered("navigate", { url: `${ORIGIN}/` });
  tree = await calls.text("read_page", {});

  // downloads land in the sandbox, reported with their source URL
  // (a small file completes within the click's own call, so its report says completed at once)
  const download = await calls.answered("left_click", {
    target: { type: "ref", ref: refOf(tree, '"Download the file"') },
  });
  const settled = await calls.answered("wait", { duration: 2 });
  const seen = [download, settled].flatMap((result) => stateOf(result).state_changes ?? []);
  const completed = seen.filter((change) => change.type === "download_completed");
  const firstCompleted = completed[0];
  assert.ok(
    firstCompleted !== undefined &&
      firstCompleted.url === `${ORIGIN}/file.txt` &&
      firstCompleted.path === undefined,
    JSON.stringify(seen),
  );
  const listing = await browser.sandbox.process.executeCommand(`cat ${browser.downloadDir}/*`);
  assert.ok(
    listing.result.includes("downloaded content"),
    "expected the download in the sandbox's download directory",
  );

  // uploads: a path in the upload directory, resolved inside the sandbox
  const upload = refOf(tree, "type=file");
  await calls.answered("file_upload", {
    target: { type: "ref", ref: upload },
    paths: [`${UPLOADS}/hello.txt`],
  });
  assert.ok((await calls.text("get_page_text", {})).includes("uploaded: hello.txt 12"));
  await calls.refused(
    "file_upload",
    { target: { type: "ref", ref: upload }, paths: ["/etc/passwd"] },
    "outside the upload directory",
  );
  await calls.refused(
    "file_upload",
    { target: { type: "ref", ref: upload }, paths: [`${UPLOADS}/escape.txt`] },
    "outside the upload directory",
  );
  await calls.refused(
    "file_upload",
    { target: { type: "ref", ref: upload }, document_ids: ["file_x"] },
    "Files API",
  );

  // tabs: a popup opens a tab, which becomes active; every member honours tab_id
  const popup = await calls.answered("left_click", {
    target: { type: "ref", ref: refOf(tree, '"Second page in a new tab"') },
  });
  const popupState = stateOf(popup);
  assert.ok(popupState.tabs.length === 2 && activeTab(popup) === "tab_2", JSON.stringify(popupState));
  assert.ok(
    (popupState.state_changes ?? []).some(
      (change) => change.type === "tab_opened" && change.tab_id === "tab_2",
    ),
    JSON.stringify(popupState),
  );
  const listed = await calls.answered("list_tabs", {});
  assert.deepEqual(stateOf(listed).tabs.map((tab) => tab.tab_id), ["tab_1", "tab_2"]);
  assert.equal(activeTab(await calls.answered("switch_tab", { tab_id: "tab_1" })), "tab_1");
  assert.ok((await calls.text("get_page_text", { tab_id: "tab_2" })).includes("Second page"));
  assert.equal(await calls.js("document.title", "tab_2"), "Second page");
  assert.equal(await calls.js("document.title"), "Exercise page", "expected the active tab to be tab_1");
  assert.equal(activeTab(await calls.answered("new_tab", {})), "tab_3");
  await calls.refused("navigate", { url: "back" }, "no page to go back");
  await calls.answered("navigate", { url: `${ORIGIN}/second`, tab_id: "tab_3" });
  await calls.answered("navigate", { url: `${ORIGIN}/`, tab_id: "tab_3" });
  assert.ok((await calls.text("navigate", { url: "back", tab_id: "tab_3" })).includes("Second page"));
  assert.ok((await calls.text("navigate", { url: "forward", tab_id: "tab_3" })).includes("Exercise page"));
  const closed = await calls.answered("close_tab", { tab_id: "tab_3" });
  assert.deepEqual(stateOf(closed).tabs.map((tab) => tab.tab_id), ["tab_1", "tab_2"]);
  await calls.answered("close_tab", { tab_id: "tab_2" });
  await calls.refused("switch_tab", { tab_id: "tab_2" }, "not open");

  // refusals: other schemes (the driver), other hosts (the URL policy), stale refs, bounds
  for (const url of [
    "javascript:alert(1)",
    "view-source:http://localhost:8000/",
    "data:text/html,hi",
    "file:///etc/passwd",
  ]) {
    await calls.refused("navigate", { url }, "does not open");
  }
  await calls.refused("navigate", { url: "http://127.0.0.1:8000/" }, "blocked");
  await calls.answered("navigate", { url: `${ORIGIN}/second` });
  await calls.refused("left_click", { target: { type: "ref", ref: button } }, "stale ref");
  await calls.answered("wait", { duration: 1 });
  await calls.refused("wait", { duration: 31 }, "between 0 and 30");
  await calls.refused("hold_key", { text: "shift", duration: 31 }, "between 0 and 30");
};

/** A sandbox the caller passes in survives `close()`; the driver's Chromium does not. */
const exerciseBorrowedSandbox = async (): Promise<void> => {
  const borrowed = await throwawaySandbox();
  try {
    const browser = await DaytonaBrowser.create({ sandbox: borrowed, urlPolicy: policy });
    try {
      await new BrowserCalls(browser).answered("navigate", { url: "about:blank" });
    } finally {
      await browser.close();
    }
    await borrowed.refreshData();
    assert.equal(String(borrowed.state), "started");
    // `[d]aytona-claude-toolsets-ts-`: the shell running this very command has the pattern in its
    // own command line, and `pgrep -f` matches that too, so a plain pattern always finds itself and
    // the check can never pass. The bracket matches the same literal text without matching the
    // pattern as written.
    const running = await borrowed.process.executeCommand(
      "pgrep -f '[d]aytona-claude-toolsets-ts-' || true",
    );
    assert.equal(running.result.trim(), "", `expected the driver's Chromium stopped: ${running.result}`);
  } finally {
    await borrowed.delete();
  }
};

const main = async (): Promise<void> => {
  const borrowed = await borrowedSandbox();
  let browser: DaytonaBrowser;
  try {
    browser = await DaytonaBrowser.create({
      ...(borrowed === undefined ? {} : { sandbox: borrowed }),
      urlPolicy: policy,
      filePolicy: new DaytonaFilePolicy({ uploadRoots: [UPLOADS] }),
      configs: {
        read_console: { enabled: true },
        read_network: { enabled: true },
        javascript_exec: { enabled: true },
        file_upload: { enabled: true },
      },
      confirm: () => true, // no one is at the terminal: approve every call
    });
  } catch (error: unknown) {
    return reportFailure(error);
  }
  const sandboxId = browser.sandbox.id;
  console.log(`sandbox ${sandboxId}`);
  try {
    await exercise(browser);
  } finally {
    await browser.close();
  }
  await browser.close(); // a second close is a no-op
  await sleep(2);

  if (borrowed === undefined) {
    const state = await stateOfSandbox(sandboxId);
    assert.ok(
      state.includes("destroy") || state === "gone",
      `expected the owned sandbox deleted: ${state}`,
    );
    await exerciseBorrowedSandbox();
  } else {
    await borrowed.refreshData();
    assert.equal(String(borrowed.state), "started", "expected that a passed-in sandbox survives close()");
  }
  console.log("\nAll calls came back as expected.");
};

if (invokedDirectly(import.meta.url)) {
  await main();
}
