import { BetaNodeFilePolicy } from "@anthropic-ai/sdk/helpers/beta/toolsets/node";
import { ToolError, ToolsetConfigError, URLRefusedError } from "@anthropic-ai/sdk/helpers/beta/toolsets";
import type { BrowserContext, Page, Route, WebSocketRoute } from "playwright-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DaytonaBrowser, KEEP_ALIVE } from "../src/browser.js";
import { DaytonaFilePolicy } from "../src/files.js";
import { BROWSER_MEMBERS, COMPUTER_MEMBERS } from "../src/members.js";
import { MAX_TEXT } from "../src/text.js";
import { callMember, mockSandbox, resultText, type MockSandbox } from "./helpers.js";

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
type PageDouble = Page & {
  readonly urlMock: ReturnType<typeof vi.fn<() => string>>;
  readonly gotoMock: ReturnType<typeof vi.fn>;
  readonly cdpSend: ReturnType<typeof vi.fn>;
};

const pageDouble = (): PageDouble => {
  let url = "about:blank";
  const handlers = new Map<string, EventHandler>();
  const cdpSend = vi.fn(async (method: string) => {
    switch (method) {
      case "Target.getTargetInfo": return { targetInfo: { targetId: "target-1", browserContextId: "context-1" } };
      case "Page.getFrameTree": return { frameTree: { frame: { id: "frame-1" } } };
      case "Page.createIsolatedWorld": return { executionContextId: 7 };
      case "Page.captureScreenshot": return { data: "png-data" };
      case "Runtime.evaluate": return { result: { type: "string", value: "" } };
      default: return {};
    }
  });
  const page = {
    urlMock: vi.fn(() => url),
    gotoMock: vi.fn(async (next: string, _options?: object) => { url = next; return { status: () => 200 }; }),
    cdpSend,
    on: vi.fn((name: string, handler: EventHandler) => { handlers.set(name, handler); }),
    url: () => url,
    title: vi.fn(async () => ""),
    goto: (next: string, options?: object) => page.gotoMock(next, options),
    goBack: vi.fn(async () => null), goForward: vi.fn(async () => null), reload: vi.fn(async () => null),
    waitForLoadState: vi.fn(async () => undefined), waitForTimeout: vi.fn(async () => undefined),
    bringToFront: vi.fn(async () => undefined), close: vi.fn(async () => { handlers.get("close")?.(page); }),
    evaluate: vi.fn(async () => [0, 0]),
    keyboard: { down: vi.fn(async () => undefined), up: vi.fn(async () => undefined), press: vi.fn(async () => undefined), type: vi.fn(async () => undefined) },
    mouse: { click: vi.fn(async () => undefined), move: vi.fn(async () => undefined), down: vi.fn(async () => undefined), up: vi.fn(async () => undefined), wheel: vi.fn(async () => undefined) },
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
    expect(resultText(await callMember(browser, "screenshot", {}))).not.toContain("dialog_dismissed");
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
