import { ToolError, URLRefusedError, type BetaFilePolicy } from "@anthropic-ai/sdk/helpers/beta/toolsets";
import { DaytonaError } from "@daytona/sdk";
import type { BrowserContext, Page, Route, WebSocketRoute } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DaytonaBrowser } from "../src/browser.js";
import { DaytonaComputer } from "../src/computer.js";
import { debug, errorName, warn } from "../src/logging.js";
import { XTest } from "../src/xtest.js";
import { callMember, mockSandbox } from "./helpers.js";

const PREFIX = "[daytona-claude-toolsets] ";

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
type PageDouble = Page & { readonly gotoMock: ReturnType<typeof vi.fn> };

/** The smallest Playwright page a `DaytonaBrowser` can be built on and driven through. */
const pageDouble = (): PageDouble => {
  let url = "about:blank";
  const handlers = new Map<string, EventHandler>();
  const page = {
    gotoMock: vi.fn(async (next: string, _options?: object) => { url = next; return { status: () => 200 }; }),
    cdpSend: vi.fn(async (method: string) => {
      switch (method) {
        case "Target.getTargetInfo": return { targetInfo: { targetId: "target-1", browserContextId: "context-1" } };
        case "Page.getFrameTree": return { frameTree: { frame: { id: "frame-1" } } };
        case "Page.createIsolatedWorld": return { executionContextId: 7 };
        case "Page.captureScreenshot": return { data: "png-data" };
        default: return {};
      }
    }),
    on: vi.fn((name: string, handler: EventHandler) => { handlers.set(name, handler); }),
    fire: (name: string, value: unknown) => { handlers.get(name)?.(value); },
    url: () => url,
    title: vi.fn(async () => ""),
    goto: (next: string, options?: object) => page.gotoMock(next, options),
    waitForLoadState: vi.fn(async () => undefined), waitForTimeout: vi.fn(async () => undefined),
    bringToFront: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => [0, 0]),
  };
  return page as unknown as PageDouble;
};

const harness = () => {
  const pages: PageDouble[] = [];
  const contextHandlers = new Map<string, EventHandler>();
  const cdpHandlers = new Map<string, EventHandler>();
  const context = {
    on: vi.fn((name: string, handler: EventHandler) => { contextHandlers.set(name, handler); }),
    route: vi.fn(async (_pattern: string, handler: (route: Route) => Promise<void>) => { mocks.routes.push(handler); }),
    routeWebSocket: vi.fn(async (_pattern: string, handler: (route: WebSocketRoute) => Promise<void>) => { mocks.sockets.push(handler); }),
    newPage: vi.fn(async () => { const page = pageDouble(); pages.push(page); return page; }),
    newCDPSession: vi.fn(async (page: PageDouble & { readonly cdpSend: unknown }) => ({ send: page.cdpSend })),
  };
  const browserCdp = {
    on: vi.fn((name: string, handler: EventHandler) => { cdpHandlers.set(name, handler); }),
    send: vi.fn(async (method: string) => method === "Target.getTargets" ? { targetInfos: [] } : {}),
  };
  const browserRaw = {
    on: vi.fn(), close: vi.fn(async () => undefined),
    newContext: vi.fn(async () => context),
    newBrowserCDPSession: vi.fn(async () => browserCdp),
  };
  mocks.connectOverCDP.mockResolvedValue(browserRaw);
  return {
    browserRaw, browserCdp, pages,
    context: context as unknown as BrowserContext,
    fireContext: (name: string, value: unknown) => { contextHandlers.get(name)?.(value); },
    fireCdp: (name: string, value: unknown) => { cdpHandlers.get(name)?.(value); },
  };
};

const makeBrowser = async (options: Parameters<typeof DaytonaBrowser.create>[0] = {}) => {
  const sandbox = mockSandbox();
  const h = harness();
  const browser = await DaytonaBrowser.create({ sandbox: sandbox.sandbox, ...options });
  return { browser, sandbox, ...h };
};

/** Runs every pending microtask and immediate, so a `void`-dispatched handler has finished. */
const drain = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

/** Fires a page's `framenavigated` listener as Playwright would for a main-frame navigation. */
const navigated = async (page: PageDouble, url: string): Promise<void> => {
  (page as unknown as { fire(name: string, value: unknown): void })
    .fire("framenavigated", { parentFrame: () => null, page: () => page, url: () => url });
  await drain();
};

const routeDouble = (url: string) => {
  const route = {
    request: () => ({ url: () => url, frame: () => ({ page: () => null, parentFrame: () => null }), isNavigationRequest: () => false }),
    continue: vi.fn(async () => undefined), abort: vi.fn(async () => undefined),
  };
  return route as unknown as Route;
};

const silence = (level: "debug" | "warn") => vi.spyOn(console, level).mockImplementation(() => undefined);

let debugSpy: ReturnType<typeof silence>;
let warnSpy: ReturnType<typeof silence>;

beforeEach(() => {
  mocks.connectOverCDP.mockReset(); mocks.launch.mockClear();
  mocks.routes.length = 0; mocks.sockets.length = 0;
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1/devtools/browser/id" }) })));
  debugSpy = silence("debug");
  warnSpy = silence("warn");
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("log line shape", () => {
  it("prefixes a warning with the package name", () => {
    // Given / When: the module warns.
    warn("something to act on");

    // Then: the host can tell whose line it is.
    expect(warnSpy).toHaveBeenCalledWith("[daytona-claude-toolsets] something to act on");
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("prefixes a debug line with the package name and routes it to console.debug", () => {
    // Given / When: the module logs a swallowed failure.
    debug("best effort failed");

    // Then: it goes out at debug level, prefixed.
    expect(debugSpy).toHaveBeenCalledWith("[daytona-claude-toolsets] best effort failed");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("names the thrown class and never its message", () => {
    // Given: an error whose message carries a secret, and a non-Error throw.
    // When / Then: only the class name is logged, as Python's type(exc).__name__ does.
    expect(errorName(new TypeError("https://signed.test/secret-token"))).toBe("TypeError");
    expect(errorName(new DaytonaError("boom"))).toBe("DaytonaError");
    expect(errorName("not an error")).toBe("UnknownError");
  });

  it("resists a tampered error.name and still returns the real class name", () => {
    // Given: an error whose writable name is replaced with a signed URL-looking string.
    const error = new TypeError("boom");
    error.name = "https://fake-signed-url.example/leaked-secret";

    // When / Then: the class identity is used instead of the mutable instance name.
    expect(errorName(error)).toBe("TypeError");
  });
});

describe("browser teardown logging", () => {
  it("logs a failed browser close step", async () => {
    // Given: the CDP connection is already gone when close() runs.
    const { browser, browserRaw } = await makeBrowser();
    browserRaw.close.mockRejectedValueOnce(new TypeError("socket gone"));

    // When: the driver is closed.
    await browser.close();

    // Then: the swallowed teardown failure is still observable.
    expect(debugSpy).toHaveBeenCalledWith(`${PREFIX}browser close step failed: TypeError`);
  });

  it("logs a preview URL that could not be revoked", async () => {
    // Given: revoking the signed preview credential fails.
    const { browser, sandbox } = await makeBrowser();
    sandbox.raw.expireSignedPreviewUrl.mockRejectedValueOnce(new DaytonaError("expired"));

    // When: the driver is closed.
    await browser.close();

    // Then: the credential that may still be live is reported.
    expect(debugSpy).toHaveBeenCalledWith(`${PREFIX}could not revoke the preview URL: DaytonaError`);
  });

  it("logs Chromium that could not be stopped in a borrowed sandbox", async () => {
    // Given: the borrowed sandbox refuses the cleanup command.
    const { browser, sandbox } = await makeBrowser();
    sandbox.raw.process.executeCommand.mockRejectedValueOnce(new DaytonaError("exec failed"));

    // When: the driver is closed.
    await browser.close();

    // Then: the Chromium left running in someone else's sandbox is reported.
    expect(debugSpy).toHaveBeenCalledWith(`${PREFIX}could not stop Chromium in the sandbox: DaytonaError`);
  });
});

describe("browser policy logging", () => {
  it("warns when a url policy throws instead of answering, and still refuses", async () => {
    // Given: a url policy with a bug in it, not a refusal.
    const { browser } = await makeBrowser({ urlPolicy: () => { throw new TypeError("bug"); } });
    const route = routeDouble("https://evil.test");

    // When: a page requests an address.
    await mocks.routes[0]?.(route);

    // Then: the request fails closed AND the broken policy is surfaced to its author.
    expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(warnSpy).toHaveBeenCalledWith(`${PREFIX}url_policy raised TypeError on a page request; refused it`);
    await browser.close();
  });

  it("stays silent when a url policy refuses rather than fails", async () => {
    // Given: a policy that answers "no" the way the SDK expects.
    const { browser } = await makeBrowser({ urlPolicy: () => { throw new URLRefusedError("blocked"); } });

    // When: a page requests a refused address.
    await mocks.routes[0]?.(routeDouble("https://evil.test"));

    // Then: an ordinary refusal is not a warning.
    expect(warnSpy).not.toHaveBeenCalled();
    await browser.close();
  });

  it("logs a refused WebSocket a page opened", async () => {
    // Given: a policy that refuses everything.
    const { browser } = await makeBrowser({ urlPolicy: () => { throw new ToolError("blocked"); } });
    const socket = { url: () => "wss://evil.test", connectToServer: vi.fn(), close: vi.fn(async () => undefined) };

    // When: the page opens a socket.
    await mocks.sockets[0]?.(socket as unknown as WebSocketRoute);

    // Then: the closed handshake is recorded, with no exception to interpolate.
    expect(socket.close).toHaveBeenCalledWith({ code: 1008, reason: "Policy violation" });
    expect(debugSpy).toHaveBeenCalledWith(`${PREFIX}url_policy refused a WebSocket a page opened`);
    await browser.close();
  });

  it("logs a refused page that could not be left", async () => {
    // Given: a tab that navigated itself somewhere the policy refuses, and a page that will not blank.
    const { browser, pages } = await makeBrowser({ urlPolicy: () => { throw new ToolError("blocked"); } });
    const page = pages[0];
    if (page === undefined) throw new Error("the harness opened no page");
    await navigated(page, "https://evil.test");
    page.gotoMock.mockRejectedValueOnce(new DaytonaError("page is gone"));

    // When: the next member runs, which is when refused pages are left.
    await callMember(browser, "screenshot", {});

    // Then: a refused page that is still live is reported.
    expect(debugSpy).toHaveBeenCalledWith(`${PREFIX}could not leave a page the url policy refused: DaytonaError`);
    await browser.close();
  });

  it("logs a file policy that could not judge a download path", async () => {
    // Given: a file policy that throws when asked about a completed download.
    const filePolicy: BetaFilePolicy = {
      resolveUploadPaths: async () => [],
      resolveUploadDocuments: async () => [],
      isPathVisible: () => { throw new TypeError("policy is broken"); },
    };
    const { browser, fireCdp } = await makeBrowser({ filePolicy });

    // When: a download completes.
    fireCdp("Browser.downloadWillBegin", { guid: "dl-1", url: "https://files.test/report.pdf" });
    fireCdp("Browser.downloadProgress", { guid: "dl-1", state: "completed", receivedBytes: 12 });
    await drain();

    // Then: the path is hidden AND the policy failure that hid it is recorded.
    expect(debugSpy).toHaveBeenCalledWith(`${PREFIX}the file policy could not judge a download path: TypeError`);
    await browser.close();
  });
});

describe("browser sandbox logging", () => {
  it("logs a keep-alive refresh the sandbox refused", async () => {
    // Given: a member bound long enough to force a refresh, and a sandbox that will not accept it.
    const { browser, sandbox } = await makeBrowser({ navigationTimeout: 60 });
    sandbox.raw.refreshActivity.mockRejectedValueOnce(new DaytonaError("no such sandbox"));

    // When: a member runs.
    await callMember(browser, "screenshot", {});

    // Then: the sandbox that may auto-stop underneath the driver is reported.
    expect(debugSpy).toHaveBeenCalledWith(`${PREFIX}could not refresh the sandbox activity: DaytonaError`);
    await browser.close();
  });

  it("logs tab titles the browser stopped answering for", async () => {
    // Given: a browser whose target list has stopped answering.
    const { browser, browserCdp } = await makeBrowser();
    browserCdp.send.mockRejectedValueOnce(new TypeError("connection closed"));

    // When: a member runs and the state is reported.
    await callMember(browser, "screenshot", {});

    // Then: the state reported from last-known data says so.
    expect(debugSpy).toHaveBeenCalledWith(`${PREFIX}could not read the tab titles: TypeError`);
    await browser.close();
  });
});

describe("computer and helper logging", () => {
  it("logs the Daytona failure behind a fixed desktop error phrase", async () => {
    // Given: a desktop whose mouse call fails.
    const mock = mockSandbox();
    mock.raw.computerUse.mouse.move.mockRejectedValueOnce(new DaytonaError("daemon is down"));
    const computer = await DaytonaComputer.create({ sandbox: mock.sandbox, confirm: () => true, settleDelay: 0 });

    // When: the model moves the mouse.
    const result = await callMember(computer, "mouse_move", { coordinate: [10, 20] });

    // Then: the model sees the fixed phrase and the operator sees what actually failed.
    expect(result.is_error).toBe(true);
    expect(debugSpy).toHaveBeenCalledWith(`${PREFIX}computer use call failed: DaytonaError`);
    await computer.close();
  });

  it("logs an XTest helper that could not be removed", async () => {
    // Given: an uploaded helper the sandbox will not delete.
    const mock = mockSandbox();
    mock.raw.fs.deleteFile.mockRejectedValueOnce(new DaytonaError("read-only filesystem"));
    const runner = new XTest(mock.sandbox);
    await runner.run([["keydown", "a"]]);

    // When: cleanup runs.
    await runner.cleanup();

    // Then: the leftover file in the borrowed sandbox is recorded.
    expect(debugSpy).toHaveBeenCalledWith(`${PREFIX}could not remove the XTest helper: DaytonaError`);
  });
});
