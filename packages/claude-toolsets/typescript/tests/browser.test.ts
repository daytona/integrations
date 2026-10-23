import { BetaNodeFilePolicy } from "@anthropic-ai/sdk/helpers/beta/toolsets/node";
import { ToolError, ToolsetConfigError, URLRefusedError } from "@anthropic-ai/sdk/helpers/beta/toolsets";
import type { BrowserContext, Page, Route, WebSocketRoute } from "playwright-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DaytonaBrowser, KEEP_ALIVE } from "../src/browser.js";
import { DaytonaFilePolicy } from "../src/files.js";
import { BROWSER_MEMBERS, COMPUTER_MEMBERS } from "../src/members.js";
import { PAGE_JS } from "../src/pageJs.js";
import { MAX_TEXT } from "../src/text.js";
import { browserState, callMember, imageData, mockSandbox, resultText, type MockSandbox } from "./helpers.js";

const mocks = vi.hoisted(() => ({
  connectOverCDP: vi.fn(),
  launch: vi.fn(async () => 9222),
  routes: [] as Array<(route: Route) => Promise<void>>,
  sockets: [] as Array<(route: WebSocketRoute) => Promise<void>>,
}));

vi.mock("../src/chromium.js", async (original) => {
  const actual = await original<typeof import("../src/chromium.js")>();
  return { ...actual, launch: mocks.launch };
});
vi.mock("playwright-core", async (original) => {
  const actual = await original<typeof import("playwright-core")>();
  return { ...actual, chromium: { connectOverCDP: mocks.connectOverCDP } };
});

type EventHandler = (value: unknown) => void;
type MouseDouble = {
  readonly click: ReturnType<typeof vi.fn<(x: number, y: number, options?: object) => Promise<void>>>;
  readonly move: ReturnType<typeof vi.fn<(x: number, y: number, options?: object) => Promise<void>>>;
  readonly down: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly up: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly wheel: ReturnType<typeof vi.fn<(dx: number, dy: number) => Promise<void>>>;
};
type KeyboardDouble = {
  readonly down: ReturnType<typeof vi.fn<(key: string) => Promise<void>>>;
  readonly up: ReturnType<typeof vi.fn<(key: string) => Promise<void>>>;
  readonly press: ReturnType<typeof vi.fn<(key: string) => Promise<void>>>;
  readonly type: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
};
type PageDouble = Page & {
  readonly urlMock: ReturnType<typeof vi.fn<() => string>>;
  readonly gotoMock: ReturnType<typeof vi.fn>;
  readonly cdpSend: ReturnType<typeof vi.fn>;
  readonly closeMock: ReturnType<typeof vi.fn<(options?: object) => Promise<void>>>;
  readonly waitMock: ReturnType<typeof vi.fn<(ms: number) => Promise<void>>>;
  readonly scrollMock: ReturnType<typeof vi.fn<() => Promise<readonly [number, number]>>>;
  readonly mouseMock: MouseDouble;
  readonly keyboardMock: KeyboardDouble;
  /**
   * What `globalThis.__dt.<name>(...)` answers in the page's isolated world, keyed by the `__dt`
   * function name; each value is CDP's `result` payload, so a test can hand back a by-value
   * result (`{ type, value }`) or the remote object `file_upload` asks for (`{ subtype, objectId }`).
   */
  readonly world: Map<string, unknown>;
  /** The whole `Runtime.evaluate` reply for a script that is not a `__dt` call — what `javascript_exec` runs. */
  readonly script: { reply: Record<string, unknown> };
};

/** `inWorld` builds exactly this expression, so the mock reads the `__dt` function name back out of it. */
const DT_CALL = /^globalThis\.__dt\["([^"]+)"\]/u;

const pageDouble = (): PageDouble => {
  let url = "about:blank";
  const handlers = new Map<string, EventHandler>();
  const world = new Map<string, unknown>();
  const script = { reply: { result: { type: "undefined" } } as Record<string, unknown> };
  const cdpSend = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    switch (method) {
      case "Target.getTargetInfo": return { targetInfo: { targetId: "target-1", browserContextId: "context-1" } };
      case "Page.getFrameTree": return { frameTree: { frame: { id: "frame-1" } } };
      case "Page.createIsolatedWorld": return { executionContextId: 7 };
      case "Page.captureScreenshot": return { data: "png-data" };
      case "Runtime.evaluate": {
        const expression = String(params?.["expression"] ?? "");
        const called = DT_CALL.exec(expression)?.[1];
        if (called === undefined) return expression === PAGE_JS ? {} : script.reply;
        return { result: world.get(called) ?? { type: "string", value: "" } };
      }
      default: return {};
    }
  });
  const closeMock = vi.fn(async (_options?: object) => { handlers.get("close")?.(page); });
  const waitMock = vi.fn(async (_ms: number) => undefined);
  const scrollMock = vi.fn(async (): Promise<readonly [number, number]> => [0, 0]);
  const mouse: MouseDouble = {
    click: vi.fn(async () => undefined), move: vi.fn(async () => undefined),
    down: vi.fn(async () => undefined), up: vi.fn(async () => undefined), wheel: vi.fn(async () => undefined),
  };
  const keyboard: KeyboardDouble = {
    down: vi.fn(async () => undefined), up: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined), type: vi.fn(async () => undefined),
  };
  const page = {
    urlMock: vi.fn(() => url),
    gotoMock: vi.fn(async (next: string, _options?: object) => { url = next; return { status: () => 200 }; }),
    cdpSend, closeMock, waitMock, scrollMock, world, script,
    mouseMock: mouse, keyboardMock: keyboard,
    on: vi.fn((name: string, handler: EventHandler) => { handlers.set(name, handler); }),
    url: () => url,
    title: vi.fn(async () => ""),
    goto: (next: string, options?: object) => page.gotoMock(next, options),
    goBack: vi.fn(async () => null), goForward: vi.fn(async () => null), reload: vi.fn(async () => null),
    waitForLoadState: vi.fn(async () => undefined), waitForTimeout: waitMock,
    bringToFront: vi.fn(async () => undefined), close: closeMock,
    evaluate: scrollMock,
    keyboard, mouse,
  };
  return page as unknown as PageDouble;
};

const harness = () => {
  const pages: PageDouble[] = [];
  const contextHandlers = new Map<string, EventHandler>();
  const context = {
    on: vi.fn((name: string, handler: EventHandler) => { contextHandlers.set(name, handler); }),
    route: vi.fn(async (_pattern: string, handler: (route: Route) => Promise<void>) => { mocks.routes.push(handler); }),
    routeWebSocket: vi.fn(async (_pattern: string, handler: (route: WebSocketRoute) => Promise<void>) => { mocks.sockets.push(handler); }),
    newPage: vi.fn(async () => { const page = pageDouble(); pages.push(page); return page; }),
    newCDPSession: vi.fn(async (page: PageDouble) => ({ send: page.cdpSend })),
  };
  const browserCdp = {
    on: vi.fn(),
    send: vi.fn(async (method: string) => method === "Target.getTargets" ? { targetInfos: pages.map((page, index) => ({ type: "page", targetId: `target-${index + 1}`, title: "", url: page.url() })) } : {}),
  };
  const browser = {
    on: vi.fn(), close: vi.fn(async () => undefined),
    newContext: vi.fn(async () => context),
    newBrowserCDPSession: vi.fn(async () => browserCdp),
  };
  mocks.connectOverCDP.mockResolvedValue(browser);
  return { browserRaw: browser, browserCdp, context: context as unknown as BrowserContext, contextRaw: context, pages };
};

const makeBrowser = async (options: Parameters<typeof DaytonaBrowser.create>[0] = {}) => {
  const sandbox = mockSandbox();
  const h = harness();
  const browser = await DaytonaBrowser.create({ sandbox: sandbox.sandbox, ...options });
  return { browser, sandbox, ...h };
};

/** Fires the page's `framenavigated` listener as Playwright would for a main-frame navigation. */
const navigate = (page: PageDouble, url: string): void => {
  const on = page.on as unknown as ReturnType<typeof vi.fn<(name: string, handler: EventHandler) => void>>;
  const handler = on.mock.calls.find(([name]) => name === "framenavigated")?.[1];
  if (handler === undefined) throw new Error("no framenavigated listener was registered");
  handler({ parentFrame: () => null, page: () => page, url: () => url });
};

/** Runs every pending microtask and immediate, so a settled promise cannot be mistaken for a pending one. */
const drain = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

/** The first page the harness opened — the tab every member drives unless it is given a `tab_id`. */
const firstPage = (pages: readonly PageDouble[]): PageDouble => {
  const page = pages[0];
  if (page === undefined) throw new Error("the harness opened no page");
  return page;
};

const blanked = (page: PageDouble): boolean =>
  page.gotoMock.mock.calls.some(([url]) => url === "about:blank");

const routeDouble = (url: string, navigation = false) => {
  const route = {
    request: () => ({
      url: () => url,
      frame: () => ({ page: () => null, parentFrame: () => null }),
      isNavigationRequest: () => navigation,
    }),
    continue: vi.fn(async () => undefined), abort: vi.fn(async () => undefined),
  };
  return route as unknown as Route & { readonly continue: ReturnType<typeof vi.fn>; readonly abort: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  mocks.connectOverCDP.mockReset(); mocks.launch.mockClear(); mocks.routes.length = 0; mocks.sockets.length = 0;
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1/devtools/browser/id" }) })));
});

describe("DaytonaBrowser construction and completeness", () => {
  it("defines all 17 computer wire names", () => { expect(COMPUTER_MEMBERS).toHaveLength(17); expect(COMPUTER_MEMBERS).toContain("type"); });
  it("defines all 31 browser wire names", () => { expect(BROWSER_MEMBERS).toHaveLength(31); expect(BROWSER_MEMBERS).toContain("type"); });
  it("refuses BetaNodeFilePolicy before acquiring a sandbox", async () => { await expect(DaytonaBrowser.create({ filePolicy: new BetaNodeFilePolicy() })).rejects.toThrow(ToolsetConfigError); expect(mocks.launch).not.toHaveBeenCalled(); });
  it("rejects an oversized viewport before acquiring a sandbox", async () => { await expect(DaytonaBrowser.create({ viewport: [2560, 1440] })).rejects.toThrow(RangeError); expect(mocks.launch).not.toHaveBeenCalled(); });
  it("connects through only the signed host and websocket path", async () => { const { browser } = await makeBrowser(); expect(mocks.connectOverCDP).toHaveBeenCalledWith("wss://signed.test/devtools/browser/id", { timeout: 30_000 }); await browser.close(); });
  it("requests a 120-second signed preview", async () => { const { browser, sandbox } = await makeBrowser(); expect(sandbox.raw.getSignedPreviewUrl).toHaveBeenCalledWith(9222, 120); await browser.close(); });
  it("allocates a sandbox-local download directory", async () => { const { browser } = await makeBrowser(); expect(browser.downloadDir).toMatch(/^\/tmp\/daytona-claude-toolsets-ts-/u); await browser.close(); });
  it("blocks service workers and accepts downloads", async () => { const { browser, browserRaw } = await makeBrowser(); expect(browserRaw.newContext).toHaveBeenCalledWith(expect.objectContaining({ serviceWorkers: "block", acceptDownloads: true })); await browser.close(); });
  it("uses allowAndName CDP download behavior", async () => { const { browser, browserCdp } = await makeBrowser(); expect(browserCdp.send).toHaveBeenCalledWith("Browser.setDownloadBehavior", expect.objectContaining({ behavior: "allowAndName", eventsEnabled: true })); await browser.close(); });
  it("has no unexpected disabled configs", async () => { const { browser } = await makeBrowser(); const configs = browser.toJSON().configs ?? {}; const disabled = Object.entries(configs).filter(([, config]) => config?.enabled === false).map(([name]) => name); expect(disabled).toEqual([]); await browser.close(); });
  it("keeps exactly the SDK default-off set", async () => { const { browser } = await makeBrowser(); const defaults = ["read_console", "read_network", "javascript_exec", "file_upload"]; for (const name of defaults) expect((await callMember(browser, name, {})).is_error).toBe(true); expect((await callMember(browser, "screenshot", {})).is_error).not.toBe(true); await browser.close(); });
});

describe("browser dialog handling", () => {
  const fireDialog = async (contextRaw: ReturnType<typeof harness>["contextRaw"], dialog: object): Promise<void> => {
    const handler = contextRaw.on.mock.calls.find(([name]) => name === "dialog")?.[1];
    if (handler === undefined) throw new Error("no dialog listener was registered");
    handler(dialog);
    await drain();
  };

  it("dismisses and reports confirm dialogs", async () => {
    const { browser, contextRaw } = await makeBrowser();
    const dismiss = vi.fn(async () => undefined);
    const accept = vi.fn(async () => undefined);
    await fireDialog(contextRaw, { type: () => "confirm", message: () => "Delete everything?", dismiss, accept });

    expect(dismiss).toHaveBeenCalledOnce();
    expect(accept).not.toHaveBeenCalled();
    const result = await callMember(browser, "screenshot", {});
    expect(resultText(result)).toContain('A confirm dialog "Delete everything?" was dismissed.');
    await browser.close();
  });

  it("accepts beforeunload dialogs without reporting a change", async () => {
    const { browser, contextRaw } = await makeBrowser();
    const dismiss = vi.fn(async () => undefined);
    const accept = vi.fn(async () => undefined);
    await fireDialog(contextRaw, { type: () => "beforeunload", message: () => "", dismiss, accept });

    expect(accept).toHaveBeenCalledOnce();
    expect(dismiss).not.toHaveBeenCalled();
    expect(browser["changes"]).toEqual([]);
    await callMember(browser, "screenshot", {});
    await browser.close();
  });

  it("caps dialog messages at MAX_TEXT", async () => {
    const { browser, contextRaw } = await makeBrowser();
    const dismiss = vi.fn(async () => undefined);
    await fireDialog(contextRaw, { type: () => "alert", message: () => "x".repeat(10_000), dismiss, accept: vi.fn() });

    const change = browser["changes"][0];
    expect(change?.type).toBe("dialog_dismissed");
    if (change?.type !== "dialog_dismissed") throw new Error("dialog change was not recorded");
    expect(change?.message).toHaveLength(MAX_TEXT);
    expect(change?.message).toBe("x".repeat(MAX_TEXT));
    await callMember(browser, "screenshot", {});
    expect(dismiss).toHaveBeenCalledOnce();
    await browser.close();
  });
});

describe("urlPolicy tri-state and interception", () => {
  it("omitted policy installs no interception", async () => { const { browser } = await makeBrowser(); expect(mocks.routes).toHaveLength(0); expect(mocks.sockets).toHaveLength(0); await browser.close(); });
  it("explicit undefined installs no interception", async () => { const { browser } = await makeBrowser({ urlPolicy: undefined }); expect(mocks.routes).toHaveLength(0); await browser.close(); });
  it("null policy is adapted to a rejecting SDK policy", async () => { const { browser } = await makeBrowser({ urlPolicy: null }); const result = await callMember(browser, "navigate", { url: "https://a.test" }); expect(result.is_error).toBe(true); expect(resultText(result)).toContain("The navigation was refused."); await browser.close(); });
  it("null policy aborts every intercepted request", async () => { const { browser } = await makeBrowser({ urlPolicy: null }); const route = routeDouble("https://a.test"); await mocks.routes[0]?.(route); expect(route.abort).toHaveBeenCalledWith("blockedbyclient"); await browser.close(); });
  it("callable policy is shared with SDK navigate", async () => { const seen: string[] = []; const policy = vi.fn((_ctx, url: string) => { seen.push(url); }); const { browser } = await makeBrowser({ urlPolicy: policy }); await callMember(browser, "navigate", { url: "https://a.test" }); expect(seen).toContain("https://a.test"); await browser.close(); });
  it("callable policy allows an ordinary request", async () => { const { browser } = await makeBrowser({ urlPolicy: () => undefined }); const route = routeDouble("https://good.test/app.js"); await mocks.routes[0]?.(route); expect(route.continue).toHaveBeenCalledOnce(); await browser.close(); });
  it("callable policy blocks a ToolError refusal", async () => { const { browser } = await makeBrowser({ urlPolicy: () => { throw new ToolError("blocked"); } }); const route = routeDouble("https://evil.test"); await mocks.routes[0]?.(route); expect(route.abort).toHaveBeenCalledOnce(); await browser.close(); });
  it("fails closed when a callable policy throws unexpectedly", async () => { const { browser } = await makeBrowser({ urlPolicy: () => { throw new TypeError("bug"); } }); const route = routeDouble("https://evil.test"); await mocks.routes[0]?.(route); expect(route.abort).toHaveBeenCalledWith("blockedbyclient"); expect(route.continue).not.toHaveBeenCalled(); await browser.close(); });
  it("blocks refused websocket handshakes", async () => { const { browser } = await makeBrowser({ urlPolicy: () => { throw new URLRefusedError("blocked"); } }); const socket = { url: () => "wss://evil.test", connectToServer: vi.fn(), close: vi.fn(async () => undefined) }; await mocks.sockets[0]?.(socket as unknown as WebSocketRoute); expect(socket.close).toHaveBeenCalledWith({ code: 1008, reason: "Policy violation" }); await browser.close(); });
  it("connects allowed websocket handshakes", async () => { const { browser } = await makeBrowser({ urlPolicy: () => undefined }); const socket = { url: () => "wss://good.test", connectToServer: vi.fn(), close: vi.fn() }; await mocks.sockets[0]?.(socket as unknown as WebSocketRoute); expect(socket.connectToServer).toHaveBeenCalledOnce(); await browser.close(); });

  it("leaves a page-triggered refused navigation before the next member observes it", async () => {
    let admit = (): void => undefined;
    const consulted = new Promise<void>((resolve) => { admit = resolve; });
    const { browser, pages } = await makeBrowser({
      urlPolicy: async (_context: unknown, url: string): Promise<void> => {
        if (!url.includes("evil.test")) return;
        await consulted;
        throw new URLRefusedError("blocked");
      },
    });
    const page = pages[0];
    if (page === undefined) throw new Error("the harness opened no page");
    await page.gotoMock("https://evil.test/landing");
    navigate(page, "https://evil.test/landing");

    let resolved = false;
    const call = callMember(browser, "screenshot", {}).then((result) => { resolved = true; return result; });
    await drain();
    expect(resolved).toBe(false);
    expect(blanked(page)).toBe(false);

    admit();
    const result = await call;
    expect(result.is_error).not.toBe(true);
    expect(blanked(page)).toBe(true);
    await browser.close();
  });
});

describe("members and bounds", () => {
  it.each([
    ["wait", { duration: 31 }, "between 0 and 30"],
    ["hold_key", { text: "shift", duration: 31 }, "between 0 and 30"],
    ["key", { text: "a", repeat: 0 }, "repeat"],
    ["scroll", { target: { type: "coordinate", x: 1, y: 1 }, scroll_direction: "down", scroll_amount: 11 }, "between 1 and 10"],
    ["left_click", { target: { type: "coordinate", x: 1280, y: 0 } }, "outside the 1280x800 viewport"],
  ])("refuses invalid %s bounds", async (name, input, phrase) => { const { browser } = await makeBrowser(); const result = await callMember(browser, name, input); expect(resultText(result)).toContain(phrase); await browser.close(); });

  it.each(["screenshot", "new_tab", "list_tabs", "read_console", "read_network"])("dispatches %s", async (name) => {
    const configs = ["read_console", "read_network"].includes(name) ? { [name]: { enabled: true } } : undefined;
    const { browser } = await makeBrowser({ ...(configs === undefined ? {} : { configs }) });
    const result = await callMember(browser, name, {}); expect(result.is_error).not.toBe(true); await browser.close();
  });

  it("normalizes a bare navigation host", async () => { const { browser, pages } = await makeBrowser(); await callMember(browser, "navigate", { url: "example.com" }); expect(pages[0]?.gotoMock).toHaveBeenCalledWith("https://example.com", expect.anything()); await browser.close(); });
  it("refuses javascript navigation schemes before Playwright", async () => { const { browser, pages } = await makeBrowser(); const result = await callMember(browser, "navigate", { url: "javascript:alert(1)" }); expect(result.is_error).toBe(true); expect(pages[0]?.gotoMock).not.toHaveBeenCalled(); await browser.close(); });
  it("reports no-history back navigation", async () => { const { browser } = await makeBrowser(); const result = await callMember(browser, "navigate", { url: "back" }); expect(resultText(result)).toContain("There is no page to go back to"); await browser.close(); });
  it("returns a viewport screenshot", async () => { const { browser } = await makeBrowser(); const result = await callMember(browser, "screenshot", {}); expect(JSON.stringify(result.content)).toContain("png-data"); await browser.close(); });
  it("opens and lists tabs", async () => { const { browser } = await makeBrowser(); await callMember(browser, "new_tab", {}); const result = await callMember(browser, "list_tabs", {}); expect(JSON.stringify(result.content)).toContain("tab_2"); await browser.close(); });
  it("refuses unknown tabs", async () => { const { browser } = await makeBrowser(); const result = await callMember(browser, "switch_tab", { tab_id: "tab_9" }); expect(resultText(result)).toContain("not open"); await browser.close(); });
  it("drains console reads", async () => { const { browser } = await makeBrowser({ configs: { read_console: { enabled: true } } }); const first = await callMember(browser, "read_console", {}); const second = await callMember(browser, "read_console", {}); expect(resultText(first)).toContain("(empty)"); expect(resultText(second)).toContain("(empty)"); await browser.close(); });
  it("refuses upload without paths", async () => { const policy = new DaytonaFilePolicy({ uploadRoots: ["/up"] }); const { browser } = await makeBrowser({ configs: { file_upload: { enabled: true } }, confirm: () => true, filePolicy: policy }); const result = await callMember(browser, "file_upload", { target: { type: "ref", ref: "ref_1" } }); expect(resultText(result)).toContain("at least one path"); await browser.close(); });
  it("still checks a navigation another tab starts while one tab is navigating", async () => {
    // Given: two tabs, and a policy refusing only the second tab's destination.
    const { browser, pages } = await makeBrowser({
      urlPolicy: (_context: unknown, url: string): void => { if (url.includes("evil.test")) throw new URLRefusedError("blocked"); },
    });
    await callMember(browser, "new_tab", {});
    const [first, second] = pages;
    if (first === undefined || second === undefined) throw new Error("the harness opened too few pages");

    // When: the second tab commits a refused navigation while the first tab's navigate is in flight.
    first.gotoMock.mockImplementationOnce(async () => {
      await second.gotoMock("https://evil.test/landing");
      navigate(second, "https://evil.test/landing");
      await drain();
      return { status: () => 200 };
    });
    await callMember(browser, "navigate", { url: "https://good.test", tab_id: "tab_1" });

    // Then: the other tab's navigation was not suppressed — it is blanked before the next member.
    await callMember(browser, "screenshot", {});
    expect(blanked(second)).toBe(true);
    await browser.close();
  });

  it("caps page-controlled titles and URLs in the browser state", async () => {
    // Given: a page reporting a title and URL far longer than the text limit.
    const { browser, browserCdp } = await makeBrowser();
    const title = "T".repeat(MAX_TEXT * 2);
    const url = `https://evil.test/${"u".repeat(MAX_TEXT * 2)}`;
    browserCdp.send.mockImplementation(async (method: string) => method === "Target.getTargets"
      ? { targetInfos: [{ type: "page", targetId: "target-1", title, url }] }
      : {});

    // When: a member reports the browser state.
    const state = JSON.stringify((await callMember(browser, "list_tabs", {})).content);

    // Then: both are truncated to the limit, not copied whole.
    expect(state).toContain("T".repeat(MAX_TEXT));
    expect(state).not.toContain("T".repeat(MAX_TEXT + 1));
    expect(state).not.toContain("u".repeat(MAX_TEXT + 1));
    await browser.close();
  });

  it("caps page-controlled titles and URLs in member results, not only the state", async () => {
    // Given: a page whose own URL and title are far longer than the limit. navigate, list_tabs
    // and switch_tab build their results from `page.url()`/`page.title()` directly, so they
    // bypassed the cap that `entry()` applies to the browser state.
    const { browser, pages } = await makeBrowser();
    const longPath = "u".repeat(MAX_TEXT * 2);
    const longTitle = "T".repeat(MAX_TEXT * 2);
    const titleMock = pages[0]?.title as unknown as ReturnType<typeof vi.fn<() => Promise<string>>>;
    titleMock.mockResolvedValue(longTitle);

    // When: each member that returns a tab entry of its own is called.
    const rendered = [
      await callMember(browser, "navigate", { url: `https://evil.test/${longPath}` }),
      await callMember(browser, "list_tabs", {}),
      await callMember(browser, "switch_tab", { tab_id: "tab_1" }),
    ].map((result) => JSON.stringify(result.content));

    // Then: none of them carries more than the limit.
    for (const text of rendered) {
      expect(text).not.toContain("u".repeat(MAX_TEXT + 1));
      expect(text).not.toContain("T".repeat(MAX_TEXT + 1));
    }
    expect(rendered[0]).toContain("u".repeat(100));
    await browser.close();
  });

  it("caps a page-controlled download URL in the browser state", async () => {
    // Given: a download whose source URL is far longer than the text limit.
    const { browser, browserCdp } = await makeBrowser();
    const begin = browserCdp.on.mock.calls.find(([event]) => event === "Browser.downloadWillBegin")?.[1];
    if (begin === undefined) throw new Error("no downloadWillBegin listener was registered");
    begin({ guid: "dl-1", url: `https://evil.test/${"d".repeat(MAX_TEXT * 2)}` });

    // When: the next member reports the browser state.
    const state = JSON.stringify((await callMember(browser, "list_tabs", {})).content);

    // Then: the stored URL is truncated to the limit.
    expect(state).toContain("d".repeat(MAX_TEXT - "https://evil.test/".length));
    expect(state).not.toContain("d".repeat(MAX_TEXT + 1));
    await browser.close();
  });

  it("refuses Files API documents", async () => { const policy = new DaytonaFilePolicy({ uploadRoots: ["/up"] }); const { browser } = await makeBrowser({ configs: { file_upload: { enabled: true } }, confirm: () => true, filePolicy: policy }); const result = await callMember(browser, "file_upload", { target: { type: "ref", ref: "ref_1" }, document_ids: ["doc_1"] }); expect(resultText(result)).toContain("cannot upload Files API documents"); await browser.close(); });
});

describe("lifecycle and activity", () => {
  it("close is idempotent", async () => { const { browser, sandbox } = await makeBrowser(); await browser.close(); await browser.close(); expect(sandbox.raw.expireSignedPreviewUrl).toHaveBeenCalledOnce(); });
  it("revokes the signed preview token", async () => { const { browser, sandbox } = await makeBrowser(); await browser.close(); expect(sandbox.raw.expireSignedPreviewUrl).toHaveBeenCalledWith(9222, "signed-token"); });
  it("cleans borrowed Chromium with a self-excluding pgrep", async () => { const { browser, sandbox } = await makeBrowser(); await browser.close(); expect(sandbox.raw.process.executeCommand.mock.calls.some(([command]) => command.includes("pgrep -f") && command.includes("[d]aytona"))).toBe(true); });
  it("does not delete a borrowed sandbox", async () => { const { browser, sandbox } = await makeBrowser(); await browser.close(); expect(sandbox.raw.delete).not.toHaveBeenCalled(); });
  it("keeps the activity interval below one minute", () => { expect(KEEP_ALIVE).toBeLessThan(60); });
  it("refreshes activity before a member after a quiet period", async () => { const { browser, sandbox } = await makeBrowser(); browser["lastActivity"] -= 61; await callMember(browser, "wait", { duration: 0 }); expect(sandbox.raw.refreshActivity).toHaveBeenCalled(); await browser.close(); });
  it("survives a failed keep-alive", async () => { const { browser, sandbox } = await makeBrowser(); sandbox.raw.refreshActivity.mockRejectedValueOnce(new Error("gone")); browser["lastActivity"] -= 61; const result = await callMember(browser, "wait", { duration: 0 }); expect(result.is_error).not.toBe(true); await browser.close(); });
  it("redacts signed credentials from connection errors", async () => { const sandbox: MockSandbox = mockSandbox(); mocks.connectOverCDP.mockRejectedValue(new Error("https://signed.test/token")); await expect(DaytonaBrowser.create({ sandbox: sandbox.sandbox })).rejects.not.toThrow("signed.test"); });
});

/**
 * Every member below is one the rest of the suite never dispatched through `toolResult()`. Each
 * asserts both halves of what the README's "What's implemented" table promises: the Playwright or
 * CDP call the driver makes, with its arguments, AND the result the model is handed back.
 *
 * Nothing here reads a tab inventory out of `resultText()`: that data lives in the `browser_state`
 * block, which carries no text, so such an assertion compares against "" and passes regardless.
 * `browserState()` reads it instead.
 */
describe("dispatching the mouse and keyboard members", () => {
  it.each([
    ["right_click", "right", 1, "Right-clicked."],
    ["middle_click", "middle", 1, "Middle-clicked."],
    ["double_click", "left", 2, "Double-clicked."],
    ["triple_click", "left", 3, "Triple-clicked."],
  ])("dispatches %s as a %s Playwright click of %i", async (name, button, clickCount, reply) => {
    const { browser, pages } = await makeBrowser();
    const page = firstPage(pages);

    const result = await callMember(browser, name, { target: { type: "coordinate", x: 11, y: 22 } });

    expect(result.is_error).not.toBe(true);
    expect(resultText(result)).toContain(reply);
    expect(page.mouseMock.click).toHaveBeenCalledWith(11, 22, { button, clickCount });
    await browser.close();
  });

  it("holds a modifier chord across a click and releases it in reverse order", async () => {
    // README: "Modifier chords are held during clicks."
    const { browser, pages } = await makeBrowser();
    const page = firstPage(pages);

    await callMember(browser, "middle_click", { target: { type: "coordinate", x: 4, y: 5 }, modifiers: "ctrl+shift" });

    expect(page.keyboardMock.down.mock.calls).toEqual([["Control"], ["Shift"]]);
    expect(page.mouseMock.click).toHaveBeenCalledWith(4, 5, { button: "middle", clickCount: 1 });
    expect(page.keyboardMock.up.mock.calls).toEqual([["Shift"], ["Control"]]);
    await browser.close();
  });

  it("refuses a chord holding a non-modifier key before touching the mouse", async () => {
    const { browser, pages } = await makeBrowser();
    const page = firstPage(pages);

    const result = await callMember(browser, "right_click", { target: { type: "coordinate", x: 1, y: 1 }, modifiers: "ctrl+a" });

    expect(result.is_error).toBe(true);
    expect(resultText(result)).toContain("modifiers takes modifier keys only, such as shift or ctrl+shift.");
    expect(page.mouseMock.click).not.toHaveBeenCalled();
    expect(page.keyboardMock.down).not.toHaveBeenCalled();
    await browser.close();
  });

  it("resolves a ref target in the isolated world and aims at the centre it reports", async () => {
    // README: "ref targets are scrolled into view first" — `center` is the function that does it.
    const { browser, pages } = await makeBrowser();
    const page = firstPage(pages);
    page.world.set("center", { type: "object", value: { x: 120, y: 240 } });

    const result = await callMember(browser, "hover", { target: { type: "ref", ref: "ref_7" } });

    expect(resultText(result)).toContain("Hovered.");
    expect(page.cdpSend).toHaveBeenCalledWith("Runtime.evaluate", expect.objectContaining({
      expression: 'globalThis.__dt["center"](...["ref_7"])', contextId: 7, returnByValue: true,
    }));
    expect(page.mouseMock.move).toHaveBeenCalledWith(120, 240);
    expect(page.mouseMock.click).not.toHaveBeenCalled();
    await browser.close();
  });

  it("refuses a ref the page no longer shows", async () => {
    const { browser, pages } = await makeBrowser();
    const page = firstPage(pages);
    page.world.set("center", { type: "object", value: { error: "invisible" } });

    const result = await callMember(browser, "hover", { target: { type: "ref", ref: "ref_9" } });

    expect(result.is_error).toBe(true);
    expect(resultText(result)).toContain("The element ref_9 is not visible.");
    expect(page.mouseMock.move).not.toHaveBeenCalled();
    await browser.close();
  });

  it("refuses a coordinate outside the viewport instead of clamping it", async () => {
    const { browser, pages } = await makeBrowser();
    const page = firstPage(pages);

    const result = await callMember(browser, "middle_click", { target: { type: "coordinate", x: 1280, y: 0 } });

    expect(result.is_error).toBe(true);
    expect(resultText(result)).toContain("(1280, 0) is outside the 1280x800 viewport.");
    expect(page.mouseMock.click).not.toHaveBeenCalled();
    await browser.close();
  });

  it("moves the mouse without waiting for the page to settle", async () => {
    // `mouse_move` is the one pointer member with no settle: it is how the model aims, not acts.
    const { browser, pages } = await makeBrowser();
    const page = firstPage(pages);

    const result = await callMember(browser, "mouse_move", { target: { type: "coordinate", x: 30, y: 40 } });

    expect(resultText(result)).toContain("Moved the mouse.");
    expect(page.mouseMock.move).toHaveBeenCalledWith(30, 40);
    expect(page.mouseMock.down).not.toHaveBeenCalled();
    expect(page.waitMock).not.toHaveBeenCalled();
    await browser.close();
  });

  it("settles after a hover, unlike mouse_move", async () => {
    const { browser, pages } = await makeBrowser({ settleDelay: 0.25 });
    const page = firstPage(pages);

    await callMember(browser, "hover", { target: { type: "coordinate", x: 30, y: 40 } });

    expect(page.waitMock).toHaveBeenCalledWith(250);
    await browser.close();
  });

  it("presses the left button down and leaves it down", async () => {
    const { browser, pages } = await makeBrowser();
    const page = firstPage(pages);

    const result = await callMember(browser, "left_mouse_down", { target: { type: "coordinate", x: 60, y: 70 } });

    expect(resultText(result)).toContain("Mouse button pressed.");
    expect(page.mouseMock.move).toHaveBeenCalledWith(60, 70);
    expect(page.mouseMock.down).toHaveBeenCalledOnce();
    expect(page.mouseMock.up).not.toHaveBeenCalled();
    await browser.close();
  });

  it("releases the left button where it is told to", async () => {
    const { browser, pages } = await makeBrowser();
    const page = firstPage(pages);

    const result = await callMember(browser, "left_mouse_up", { target: { type: "coordinate", x: 80, y: 90 } });

    expect(resultText(result)).toContain("Mouse button released.");
    expect(page.mouseMock.move).toHaveBeenCalledWith(80, 90);
    expect(page.mouseMock.up).toHaveBeenCalledOnce();
    expect(page.mouseMock.down).not.toHaveBeenCalled();
    await browser.close();
  });

  it("drags in steps between the two points, pressing before and releasing after", async () => {
    const { browser, pages } = await makeBrowser();
    const page = firstPage(pages);

    const result = await callMember(browser, "left_click_drag", {
      from: { type: "coordinate", x: 10, y: 20 },
      target: { type: "coordinate", x: 110, y: 120 },
    });

    expect(resultText(result)).toContain("Dragged.");
    // Order matters: a press before the first move, or a move after the release, drops the drag.
    expect(page.mouseMock.move.mock.calls).toEqual([[10, 20], [110, 120, { steps: 10 }]]);
    expect(page.mouseMock.down).toHaveBeenCalledOnce();
    expect(page.mouseMock.up).toHaveBeenCalledOnce();
    await browser.close();
  });

  it("types text through the Playwright keyboard", async () => {
    const { browser, pages } = await makeBrowser();
    const page = firstPage(pages);

    const result = await callMember(browser, "type", { text: "hello world" });

    expect(resultText(result)).toContain("Typed.");
    expect(page.keyboardMock.type).toHaveBeenCalledWith("hello world");
    expect(page.keyboardMock.press).not.toHaveBeenCalled();
    await browser.close();
  });
});

describe("dispatching the page-reading members", () => {
  /** Every `__dt` call the driver made, in order, with the bootstrap of the toolkit itself left out. */
  const worldCalls = (page: PageDouble): string[] =>
    page.cdpSend.mock.calls
      .filter((call): call is [string, { readonly expression: string }] => call[0] === "Runtime.evaluate")
      .map(([, params]) => params.expression)
      .filter((expression) => expression.startsWith("globalThis.__dt["));

  it("reads the page with the filter and depth the model asked for", async () => {
    const { browser, pages } = await makeBrowser();
    const page = firstPage(pages);
    page.world.set("readPage", { type: "object", value: { text: 'heading "Daytona" [ref_1]\n  link "Docs" [ref_2]' } });

    const result = await callMember(browser, "read_page", { depth: 3, filter: "interactive" });

    expect(result.is_error).not.toBe(true);
    expect(resultText(result)).toContain('heading "Daytona" [ref_1]');
    expect(resultText(result)).toContain('link "Docs" [ref_2]');
    expect(worldCalls(page)).toEqual(['globalThis.__dt["readPage"](...[{"depth":3,"all":false,"interactive":true}])']);
    await browser.close();
  });

  it("passes filter=all through as the all flag, not the interactive one", async () => {
    const { browser, pages } = await makeBrowser();
    const page = firstPage(pages);

    await callMember(browser, "read_page", { ref: "ref_5", filter: "all" });

    expect(worldCalls(page)).toEqual(['globalThis.__dt["readPage"](...[{"ref":"ref_5","depth":15,"all":true,"interactive":false}])']);
    await browser.close();
  });

  it("refuses a read_page depth below one before reaching the page", async () => {
    const { browser, pages } = await makeBrowser();
    const page = firstPage(pages);

    const result = await callMember(browser, "read_page", { depth: 0 });

    expect(result.is_error).toBe(true);
    expect(resultText(result)).toContain("depth must be at least 1.");
    expect(worldCalls(page)).toEqual([]);
    await browser.close();
  });

  it("refuses a read_page ref the page has forgotten", async () => {
    const { browser, pages } = await makeBrowser();
    const page = firstPage(pages);
    page.world.set("readPage", { type: "object", value: { error: "stale" } });

    const result = await callMember(browser, "read_page", { ref: "ref_1" });

    expect(result.is_error).toBe(true);
    expect(resultText(result)).toContain("Unknown or stale ref ref_1; call read_page or find for current refs.");
    await browser.close();
  });

  it("ranks find candidates by keyword over role, name and attributes", async () => {
    // README: "`find` is keyword matching over role, name and attributes, not a semantic search."
    const { browser, pages } = await makeBrowser();
    const page = firstPage(pages);
    page.world.set("candidates", { type: "object", value: [
      { line: 'paragraph "Signing in is easy" [ref_6]', role: "paragraph", name: "signing in is easy", attrs: "", interactive: false, visible: true },
      { line: 'link "Sign up" [ref_5]', role: "link", name: "sign up", attrs: "", interactive: true, visible: true },
      { line: 'button "Sign in" [ref_4]', role: "button", name: "sign in", attrs: "id=signin", interactive: true, visible: true },
      { line: 'heading "Pricing" [ref_7]', role: "heading", name: "pricing", attrs: "", interactive: false, visible: true },
    ]});

    const result = await callMember(browser, "find", { query: "sign in button" });

    // The button outranks the link because "button" matched its role as well as "sign" matching
    // its name; the link beats the paragraph because "sign" is a whole word in "sign up" but only
    // a prefix in "signing"; and "Pricing" matched nothing at all, so it is not offered.
    expect(resultText(result).trimEnd().split("\n")).toEqual([
      'button "Sign in" [ref_4]',
      'link "Sign up" [ref_5]',
      'paragraph "Signing in is easy" [ref_6]',
    ]);
    expect(worldCalls(page)).toEqual(['globalThis.__dt["candidates"](...[])']);
    await browser.close();
  });

  it("tells the model to read the page when find matches nothing", async () => {
    const { browser, pages } = await makeBrowser();
    firstPage(pages).world.set("candidates", { type: "object", value: [
      { line: 'heading "Pricing" [ref_7]', role: "heading", name: "pricing", attrs: "", interactive: false, visible: true },
    ]});

    const result = await callMember(browser, "find", { query: "checkout" });

    expect(result.is_error).not.toBe(true);
    expect(resultText(result)).toContain('No element matched "checkout". Try read_page.');
    await browser.close();
  });

  it("returns the page's rendered text", async () => {
    const { browser, pages } = await makeBrowser();
    const page = firstPage(pages);
    page.world.set("pageText", { type: "string", value: "Daytona\n\nSandboxes for agents" });

    const result = await callMember(browser, "get_page_text", {});

    expect(resultText(result).trimEnd()).toBe("Daytona\n\nSandboxes for agents");
    expect(worldCalls(page)).toEqual(['globalThis.__dt["pageText"](...[])']);
    await browser.close();
  });

  it("scrolls a ref into view", async () => {
    const { browser, pages } = await makeBrowser();
    const page = firstPage(pages);
    page.world.set("scrollTo", { type: "object", value: {} });

    const result = await callMember(browser, "scroll_to", { target: { type: "ref", ref: "ref_3" } });

    expect(result.is_error).not.toBe(true);
    expect(resultText(result)).toContain("Scrolled to ref_3.");
    expect(worldCalls(page)).toEqual(['globalThis.__dt["scrollTo"](...["ref_3"])']);
    await browser.close();
  });

  it("refuses a scroll_to ref the page has forgotten", async () => {
    const { browser, pages } = await makeBrowser();
    firstPage(pages).world.set("scrollTo", { type: "object", value: { error: "stale" } });

    const result = await callMember(browser, "scroll_to", { target: { type: "ref", ref: "ref_3" } });

    expect(result.is_error).toBe(true);
    expect(resultText(result)).toContain("Unknown or stale ref ref_3; call read_page or find for current refs.");
    await browser.close();
  });

  it("sets a form value through the isolated world", async () => {
    const { browser, pages } = await makeBrowser();
    const page = firstPage(pages);
    page.world.set("setValue", { type: "object", value: {} });

    const result = await callMember(browser, "form_input", { target: { type: "ref", ref: "ref_2" }, value: "Ada" });

    expect(result.is_error).not.toBe(true);
    expect(resultText(result)).toContain("Set the value of ref_2.");
    expect(worldCalls(page)).toEqual(['globalThis.__dt["setValue"](...["ref_2","Ada"])']);
    await browser.close();
  });

  it.each([
    ["no-option", "The select ref_2 has no option with that value or text."],
    ["want-boolean", "ref_2 is a checkbox or radio button; set it to true or false."],
    ["file-input", "ref_2 is a file input; use file_upload."],
    ["not-a-field", "ref_2 is not a form field."],
  ])("turns the form_input %s refusal into its own sentence", async (error, message) => {
    const { browser, pages } = await makeBrowser();
    firstPage(pages).world.set("setValue", { type: "object", value: { error } });

    const result = await callMember(browser, "form_input", { target: { type: "ref", ref: "ref_2" }, value: "Ada" });

    expect(result.is_error).toBe(true);
    expect(resultText(result)).toContain(message);
    await browser.close();
  });

  it("re-renders a zoom region at a real higher scale, in document coordinates", async () => {
    // README: "`zoom` re-renders the region at a higher scale, so its detail is real." The clip is
    // in DOCUMENT coordinates while the model's region is in viewport ones, so the scroll offset
    // is added — a region below the fold is correct, not out of bounds.
    const { browser, pages } = await makeBrowser();
    const page = firstPage(pages);
    page.scrollMock.mockResolvedValue([40, 25]);

    const result = await callMember(browser, "zoom", { region: [10, 20, 210, 120] });

    expect(result.is_error).not.toBe(true);
    expect(imageData(result)).toBe("png-data");
    expect(page.cdpSend).toHaveBeenCalledWith("Page.captureScreenshot", {
      format: "png",
      // 1280/200 = 6.4 is the smaller of the two fits, and below the cap of 8.
      clip: { x: 50, y: 45, width: 200, height: 100, scale: 6.4 },
    });
    await browser.close();
  });

  it("refuses a zoom region outside the viewport before capturing anything", async () => {
    const { browser, pages } = await makeBrowser();
    const page = firstPage(pages);

    const result = await callMember(browser, "zoom", { region: [0, 0, 1281, 10] });

    expect(result.is_error).toBe(true);
    expect(resultText(result)).toContain("region must satisfy 0 <= x0 < x1 <= 1280 and 0 <= y0 < y1 <= 800 (viewport pixels).");
    expect(page.cdpSend).not.toHaveBeenCalledWith("Page.captureScreenshot", expect.anything());
    await browser.close();
  });
});

describe("dispatching close_tab", () => {
  it("closes the tab without running beforeunload and drops it from the browser state", async () => {
    const { browser, pages } = await makeBrowser();
    await callMember(browser, "new_tab", {});
    const second = pages[1];
    if (second === undefined) throw new Error("the harness opened too few pages");

    const result = await callMember(browser, "close_tab", { tab_id: "tab_2" });

    expect(result.is_error).not.toBe(true);
    // README: `beforeunload` is accepted elsewhere so navigation goes ahead, but closing a tab the
    // model asked to close must not be stoppable by the page.
    expect(second.closeMock).toHaveBeenCalledWith({ runBeforeUnload: false });
    const state = browserState(result);
    expect(state.tabs.map((tab) => tab.tab_id)).toEqual(["tab_1"]);
    expect(state.tabs.filter((tab) => tab.active).map((tab) => tab.tab_id)).toEqual(["tab_1"]);
    await browser.close();
  });

  it("refuses to close a tab that is not open", async () => {
    const { browser, pages } = await makeBrowser();
    const page = firstPage(pages);

    const result = await callMember(browser, "close_tab", { tab_id: "tab_9" });

    expect(result.is_error).toBe(true);
    expect(resultText(result)).toContain("The requested tab is not open.");
    expect(page.closeMock).not.toHaveBeenCalled();
    await browser.close();
  });
});

/**
 * The four members the SDK ships disabled. Each is dispatched the way an application that wants it
 * must configure it — `configs: { <member>: { enabled: true } }` plus a `confirm` — so these are
 * the only tests that reach their bodies at all; the committed suite only ever called them
 * disabled, which the SDK refuses before the driver sees the call.
 */
describe("dispatching the default-off members", () => {
  const enabled = (member: string, extra: Parameters<typeof makeBrowser>[0] = {}) =>
    makeBrowser({ configs: { [member]: { enabled: true } }, confirm: () => true, ...extra });

  /** Hands the context listener the driver registered the event Playwright would. */
  const fire = (contextRaw: ReturnType<typeof harness>["contextRaw"], name: string, value: unknown): void => {
    const handler = contextRaw.on.mock.calls.find(([event]) => event === name)?.[1];
    if (handler === undefined) throw new Error(`no ${name} listener was registered`);
    handler(value);
  };

  it("collects console entries per tab and drains them on read", async () => {
    // README: "Entries collected per tab since the last read".
    const { browser, contextRaw, pages } = await enabled("read_console");
    const page = firstPage(pages);
    fire(contextRaw, "console", { page: () => page, type: () => "error", text: () => "boom" });
    fire(contextRaw, "console", { page: () => page, type: () => "log", text: () => "hello" });

    const first = await callMember(browser, "read_console", {});
    const second = await callMember(browser, "read_console", {});

    expect(first.is_error).not.toBe(true);
    expect(resultText(first).trimEnd().split("\n")).toEqual(["[error] boom", "[log] hello"]);
    // Drained, not repeated: the second read must not hand the model the same two lines again.
    expect(resultText(second)).toContain("(empty)");
    await browser.close();
  });

  it("reports a finished request with its method, status, type and timing", async () => {
    const { browser, contextRaw, pages } = await enabled("read_network");
    const page = firstPage(pages);
    const request = {
      method: () => "GET", url: () => "https://a.test/app.js",
      timing: () => ({ responseEnd: 12.4 }), frame: () => ({ page: () => page }),
    };
    fire(contextRaw, "request", request);
    fire(contextRaw, "response", { request: () => request, status: () => 200, headers: () => ({ "content-type": "application/javascript; charset=utf-8" }) });
    fire(contextRaw, "requestfinished", request);

    const result = await callMember(browser, "read_network", {});

    expect(result.is_error).not.toBe(true);
    expect(resultText(result).trimEnd()).toBe("GET 200 application/javascript 12ms https://a.test/app.js");
    await browser.close();
  });

  it("runs javascript_exec in the page's own world with the ten-second CDP timeout", async () => {
    // README: "CDP `Runtime.evaluate` in the page's own world, stopped after 10 s". The page's own
    // world, not the isolated one: no `contextId` is sent.
    const { browser, pages } = await enabled("javascript_exec");
    const page = firstPage(pages);
    page.script.reply = { result: { type: "string", value: "Daytona" } };

    const result = await callMember(browser, "javascript_exec", { text: "document.title" });

    expect(result.is_error).not.toBe(true);
    expect(resultText(result).trimEnd()).toBe("Daytona");
    expect(page.cdpSend).toHaveBeenCalledWith("Runtime.evaluate", {
      expression: "document.title", returnByValue: true, awaitPromise: true,
      userGesture: true, replMode: true, timeout: 10_000,
    });
    await browser.close();
  });

  it("reports a javascript_exec script V8 terminated as the ten-second limit", async () => {
    const { browser, pages } = await enabled("javascript_exec");
    const page = firstPage(pages);
    page.script.reply = { exceptionDetails: { text: "Uncaught", exception: { description: "Execution terminated." } } };

    const result = await callMember(browser, "javascript_exec", { text: "while (true) {}" });

    expect(result.is_error).toBe(true);
    expect(resultText(result)).toContain("The script did not finish within 10 seconds.");
    await browser.close();
  });

  it("refuses javascript_exec when confirm says no", async () => {
    const { browser, pages } = await makeBrowser({ configs: { javascript_exec: { enabled: true } }, confirm: () => false });
    const page = firstPage(pages);

    const result = await callMember(browser, "javascript_exec", { text: "document.cookie" });

    expect(result.is_error).toBe(true);
    expect(page.cdpSend).not.toHaveBeenCalledWith("Runtime.evaluate", expect.objectContaining({ expression: "document.cookie" }));
    await browser.close();
  });

  it("uploads a sandbox path the file policy admits through CDP", async () => {
    // README: "CDP `DOM.setFileInputFiles` with paths inside the sandbox".
    const { browser, pages, sandbox } = await enabled("file_upload", { filePolicy: new DaytonaFilePolicy({ uploadRoots: ["/up"] }) });
    const page = firstPage(pages);
    // `/up/link.txt` is a symlink the sandbox resolves to `/up/real.txt`, still inside the root.
    sandbox.raw.process.executeCommand.mockImplementation(async (command: string) =>
      command.startsWith("realpath -e") ? { exitCode: 0, result: "/up/real.txt\n" } : { exitCode: 0, result: "/up\n" });
    page.world.set("fileInput", { type: "object", subtype: "node", objectId: "node-9" });

    const result = await callMember(browser, "file_upload", { target: { type: "ref", ref: "ref_1" }, paths: ["/up/link.txt"] });

    expect(result.is_error).not.toBe(true);
    expect(resultText(result)).toContain("Uploaded.");
    // The RESOLVED path is uploaded, not the one the model wrote: the driver resolves symlinks in
    // the sandbox and re-checks the result against the roots, so the path CDP gets is the real one.
    expect(page.cdpSend).toHaveBeenCalledWith("DOM.setFileInputFiles", { files: ["/up/real.txt"], objectId: "node-9" });
    expect(sandbox.raw.process.executeCommand).toHaveBeenCalledWith("realpath -e -- '/up/link.txt'");
    await browser.close();
  });

  it("refuses an upload whose resolved path leaves the upload roots", async () => {
    // README: "a link planted in an upload directory cannot carry the upload out of it."
    const { browser, pages, sandbox } = await enabled("file_upload", { filePolicy: new DaytonaFilePolicy({ uploadRoots: ["/up"] }) });
    const page = firstPage(pages);
    sandbox.raw.process.executeCommand.mockImplementation(async (command: string) =>
      command.startsWith("realpath -e") ? { exitCode: 0, result: "/etc/shadow\n" } : { exitCode: 0, result: "/up\n" });
    page.world.set("fileInput", { type: "object", subtype: "node", objectId: "node-9" });

    const result = await callMember(browser, "file_upload", { target: { type: "ref", ref: "ref_1" }, paths: ["/up/link"] });

    expect(result.is_error).toBe(true);
    expect(resultText(result)).toContain("An upload path is outside the upload directory.");
    expect(page.cdpSend).not.toHaveBeenCalledWith("DOM.setFileInputFiles", expect.anything());
    await browser.close();
  });

  it("refuses an upload aimed at something that is not a file input", async () => {
    const { browser, pages, sandbox } = await enabled("file_upload", { filePolicy: new DaytonaFilePolicy({ uploadRoots: ["/up"] }) });
    const page = firstPage(pages);
    sandbox.raw.process.executeCommand.mockImplementation(async (command: string) =>
      command.startsWith("realpath -e") ? { exitCode: 0, result: "/up/a.txt\n" } : { exitCode: 0, result: "/up\n" });
    page.world.set("fileInput", { type: "object", value: { error: "not-file" } });

    const result = await callMember(browser, "file_upload", { target: { type: "ref", ref: "ref_1" }, paths: ["/up/a.txt"] });

    expect(result.is_error).toBe(true);
    expect(resultText(result)).toContain("ref_1 is not a file input.");
    expect(page.cdpSend).not.toHaveBeenCalledWith("DOM.setFileInputFiles", expect.anything());
    await browser.close();
  });
});
