// allow: SIZE_OK — this indivisible class implements the SDK's complete 31-member browser contract and shared live event state.
import { posix } from "node:path";
import {
  BetaAbstractBrowserToolset20260801,
  ToolError,
  ToolsetConfigError,
  URLRefusedError,
  UploadRefusedError,
  type BetaBrowserMemberResult,
  type BetaBrowserNavigateResult,
  type BetaBrowserState,
  type BetaBrowserToolsetOptions,
  type BetaDialogDismissed,
  type BetaNavigationRefused,
  type BetaScreenshotResult,
  type BetaToolsetCallContext,
  type BetaURLPolicy,
} from "@anthropic-ai/sdk/helpers/beta/toolsets";
import { BetaNodeFilePolicy } from "@anthropic-ai/sdk/helpers/beta/toolsets/node";
import type {
  BetaBrowserCloseTabInput, BetaBrowserDoubleClickInput, BetaBrowserFileUploadInput,
  BetaBrowserFindInput, BetaBrowserFormInputInput, BetaBrowserGetPageTextInput,
  BetaBrowserHoldKeyInput, BetaBrowserHoverInput, BetaBrowserJavascriptExecInput,
  BetaBrowserKeyInput, BetaBrowserLeftClickDragInput, BetaBrowserLeftClickInput,
  BetaBrowserLeftMouseDownInput, BetaBrowserLeftMouseUpInput, BetaBrowserListTabsInput,
  BetaBrowserMemberInput, BetaBrowserMemberName, BetaBrowserMiddleClickInput,
  BetaBrowserMouseMoveInput, BetaBrowserNavigateInput, BetaBrowserNewTabInput,
  BetaBrowserReadConsoleInput, BetaBrowserReadNetworkInput, BetaBrowserReadPageInput,
  BetaBrowserRightClickInput, BetaBrowserScreenshotInput, BetaBrowserScrollInput,
  BetaBrowserScrollToInput, BetaBrowserStateChange, BetaBrowserStateTabEntry,
  BetaBrowserSwitchTabInput, BetaBrowserTripleClickInput, BetaBrowserTypeInput,
  BetaBrowserWaitInput, BetaBrowserZoomInput, BetaBrowserClickTarget,
} from "@anthropic-ai/sdk/resources/beta";
import type { Daytona, Sandbox } from "@daytona/sdk";
import {
  chromium as playwrightChromium,
  errors as playwrightErrors,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type ConsoleMessage,
  type Dialog,
  type Frame,
  type Page,
  type Request,
  type Response,
  type Route,
  type WebError,
  type WebSocketRoute,
} from "playwright-core";

import { createChromiumPaths, launch, shellQuote, type ChromiumPaths } from "./chromium.js";
import { DaytonaFilePolicy, isUnder } from "./files.js";
import { PLAYWRIGHT, parseChord, playwrightChord, splitSequence } from "./keys.js";
import { PAGE_JS } from "./pageJs.js";
import { SandboxLease, type CreateParams, type OnClose, type SandboxCreator } from "./sandbox.js";
import { Tab } from "./tabs.js";
import { MAX_TEXT, failurePhrase, formatRemote, normalizeUrl, rank } from "./text.js";

export const MAX_TABS = 100;
export const MAX_DURATION = 30;
export const MAX_REPEAT = 100;
export const FIND_LIMIT = 20;
export const KEEP_ALIVE = 45;
const SCRIPT_TIMEOUT_MS = 10_000;
const WHEEL_NOTCH = 100;
const MODIFIERS = { ctrl: "Control", alt: "Alt", shift: "Shift", cmd: "Meta" } as const;

type Size = readonly [number, number];
type BrowserChange = BetaBrowserStateChange | BetaNavigationRefused | BetaDialogDismissed;
type CdpRemote = Readonly<Record<string, unknown>>;
type DaytonaUrlPolicy = BetaURLPolicy | null;
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;
const recordOf = (value: unknown): Readonly<Record<string, unknown>> => isRecord(value) ? value : {};

export type DaytonaBrowserOptions = Omit<BetaBrowserToolsetOptions, "browserState" | "urlPolicy"> & {
  readonly sandbox?: Sandbox;
  readonly daytona?: Daytona | SandboxCreator<Sandbox>;
  readonly createParams?: CreateParams;
  readonly onClose?: OnClose;
  readonly viewport?: Size;
  readonly headless?: boolean;
  readonly chromium?: string;
  readonly navigationTimeout?: number;
  readonly settleDelay?: number;
  readonly createTimeout?: number;
  readonly urlPolicy?: DaytonaUrlPolicy | undefined;
};

class DaytonaBrowserClosedError extends Error { readonly name = "DaytonaBrowserClosedError"; }
class BrowserConnectionError extends Error { readonly name = "BrowserConnectionError"; }

/**
 * Daytona-backed implementation of the Anthropic browser toolset.
 *
 * DESIGN NOTE — one class, deliberately, not an oversight.
 *
 * `BetaAbstractBrowserToolset20260801` is an abstract base whose 31 members are
 * `protected` overrides on a single subclass. The SDK dispatches to `this.navigate`,
 * `this.screenshot`, ... itself, so the member handlers cannot be moved into
 * collaborator objects without re-implementing the SDK's dispatch and widening those
 * members' visibility. The contract, not the file, chooses the unit.
 *
 * The handlers are also not independent: every one of them reads and mutates the same
 * live, in-flight state — `tabs`/`byPage`/`recent`/`active` (tab identity), `changes`
 * (the per-call browser-state delta), `downloads` and `refusedTabs` (populated by CDP
 * and route listeners registered at launch), `navigating` (which makes interception
 * fail closed mid-navigation), and `lastActivity` (keep-alive). Splitting by
 * "responsibility" would convert these fields into cross-object mutable references
 * threaded through every call — strictly more coupling, and more regression risk, than
 * the private fields they are today.
 *
 * What IS separable is already separated, into single-purpose modules this class only
 * consumes: `chromium.ts` (launch + paths), `sandbox.ts` (lease lifecycle), `files.ts`
 * (upload policy), `keys.ts` (chord parsing), `pageJs.ts` (injected toolkit),
 * `tabs.ts` (tab record), `png.ts` (image scaling), `text.ts` (result vocabulary).
 * What remains is the irreducible adapter between that SDK contract and those modules.
 *
 * Regression risk is carried by tests rather than by file size: the suite asserts all
 * 31 member declarations plus their behaviour, and the whole surface is additionally
 * exercised live against a real sandbox by `examples/exerciseBrowser.ts`.
 */
export class DaytonaBrowser extends BetaAbstractBrowserToolset20260801 {
  private lease: SandboxLease<Sandbox> | undefined;
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private browserCdp: CDPSession | undefined;
  private signed: { readonly port: number; readonly token: string } | undefined;
  private readonly tabs = new Map<string, Tab>();
  private readonly byPage = new Map<Page, string>();
  private readonly recent: string[] = [];
  private active: string | undefined;
  private nextTab = 1;
  private changes: BrowserChange[] = [];
  private readonly downloads = new Map<string, string>();
  private readonly refusedTabs = new Set<string>();
  private readonly navigationChecks = new Set<Promise<void>>();
  private navigating = false;
  private disconnected = false;
  private lastActivity = performance.now() / 1000;
  private constructor(
    options: BetaBrowserToolsetOptions,
    private readonly viewport: Size,
    private readonly navigationMs: number,
    private readonly settleMs: number,
    private readonly urlPolicy: BetaURLPolicy | undefined,
    private readonly filePolicy: DaytonaFilePolicy | undefined,
    private readonly policy: BetaBrowserToolsetOptions["filePolicy"],
    private readonly downloadPath: string,
    private readonly paths: ChromiumPaths,
  ) { super(options); }

  static async create(options: DaytonaBrowserOptions = {}): Promise<DaytonaBrowser> {
    if (options.filePolicy instanceof BetaNodeFilePolicy) {
      throw new ToolsetConfigError("BetaNodeFilePolicy checks paths on this machine, but the browser runs in a Daytona sandbox; pass a DaytonaFilePolicy");
    }
    const viewport = options.viewport ?? [1280, 800];
    if (!(viewport[0] > 0 && viewport[0] <= 1920 && viewport[1] > 0 && viewport[1] <= 1200)) {
      throw new RangeError("viewport must be at most 1920x1200 (screenshots are the viewport)");
    }
    const paths = createChromiumPaths();
    const boundPolicy = options.filePolicy instanceof DaytonaFilePolicy
      ? DaytonaFilePolicy.forDownloadDir(options.filePolicy, paths.downloadDir)
      : options.filePolicy;
    const downloadPath = boundPolicy instanceof DaytonaFilePolicy
      ? boundPolicy.downloadDir ?? paths.downloadDir
      : paths.downloadDir;
    const urlPolicy = options.urlPolicy === null
      ? (): never => { throw new URLRefusedError("The navigation was refused."); }
      : options.urlPolicy;
    let browser: DaytonaBrowser | undefined;
    const browserState = async (ctx: BetaToolsetCallContext): Promise<BetaBrowserState> => {
      if (browser === undefined) throw new DaytonaBrowserClosedError("this DaytonaBrowser is not ready");
      return browser.reportState(ctx);
    };
    const sdkOptions: BetaBrowserToolsetOptions = {
      browserState,
      ...(options.configs === undefined ? {} : { configs: options.configs }),
      ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
      ...(options.toolConfigs === undefined ? {} : { toolConfigs: options.toolConfigs }),
      ...(urlPolicy === undefined ? {} : { urlPolicy }),
      ...(boundPolicy === undefined ? {} : { filePolicy: boundPolicy }),
    };
    browser = new DaytonaBrowser(
      sdkOptions, viewport, (options.navigationTimeout ?? 30) * 1000,
      (options.settleDelay ?? 0.3) * 1000, urlPolicy,
      boundPolicy instanceof DaytonaFilePolicy ? boundPolicy : undefined,
      boundPolicy, downloadPath, paths,
    );
    try {
      browser.lease = await SandboxLease.acquire(options.sandbox, {
        ...(options.daytona === undefined ? {} : { daytona: options.daytona }),
        ...(options.createParams === undefined ? {} : { createParams: options.createParams }),
        defaultEnv: {}, onClose: options.onClose ?? "delete", createTimeout: options.createTimeout ?? 120,
      });
      await browser.start(options.chromium ?? "chromium", options.headless ?? true);
      return browser;
    } catch (error: unknown) {
      await browser.close();
      throw error;
    }
  }

  get sandbox(): Sandbox {
    if (this.lease === undefined) throw new DaytonaBrowserClosedError("this DaytonaBrowser is closed");
    return this.lease.sandbox;
  }
  get downloadDir(): string { return this.downloadPath; }

  override async close(): Promise<void> {
    await super.close();
    const browser = this.browser;
    const lease = this.lease;
    const signed = this.signed;
    this.browser = undefined; this.context = undefined; this.browserCdp = undefined;
    this.lease = undefined; this.signed = undefined;
    if (browser !== undefined) {
      try { await browser.close(); } catch { /* no-excuse-ok: catch — best-effort teardown of a dead CDP connection. */ }
    }
    if (lease === undefined) return;
    if (signed !== undefined) {
      try { await lease.sandbox.expireSignedPreviewUrl(signed.port, signed.token); }
      catch { /* no-excuse-ok: catch — expiring an already-expired credential is best effort. */ }
    }
    if (!lease.owned) {
      try {
        const profilePattern = this.paths.profile.replace("daytona", "[d]aytona");
        await lease.sandbox.process.executeCommand(
          `pids=$(pgrep -f ${shellQuote(profilePattern)} || true); [ -z "$pids" ] || kill $pids; rm -rf -- ${shellQuote(this.paths.profile)}`,
        );
        await lease.sandbox.process.deleteSession(this.paths.sessionId);
      } catch { /* no-excuse-ok: catch — borrowed-sandbox cleanup must not hide release. */ }
    }
    await lease.release();
  }

  private async start(binary: string, headless: boolean): Promise<void> {
    if (this.sandbox.state !== "started") await this.sandbox.start();
    if (!headless && (await this.sandbox.computerUse.getStatus()).status !== "active") await this.sandbox.computerUse.start();
    const port = await launch(this.sandbox, { chromium: binary, headless, ...this.paths, downloadDir: this.downloadPath, viewport: this.viewport });
    await this.connect(port);
  }

  private async connect(port: number): Promise<void> {
    const { url, token } = await this.sandbox.getSignedPreviewUrl(port, 120);
    this.signed = { port, token };
    let browser: Browser;
    try {
      const base = url.replace(/\/+$/u, "");
      const response = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new BrowserConnectionError("version endpoint failed");
      const version: unknown = await response.json();
      if (typeof version !== "object" || version === null || !("webSocketDebuggerUrl" in version) || typeof version.webSocketDebuggerUrl !== "string") {
        throw new BrowserConnectionError("version endpoint returned invalid data");
      }
      const signedHost = new URL(base).host;
      const path = new URL(version.webSocketDebuggerUrl).pathname;
      browser = await playwrightChromium.connectOverCDP(`wss://${signedHost}${path}`, { timeout: 30_000 });
    } catch {
      throw new BrowserConnectionError("could not connect to Chromium in the sandbox over CDP");
    }
    this.browser = browser;
    browser.on("disconnected", () => { this.disconnected = true; });
    const [width, height] = this.viewport;
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block", acceptDownloads: true });
    this.context = context;
    context.on("page", (page) => { void this.onPage(page); });
    context.on("dialog", (dialog) => { void this.onDialog(dialog); });
    context.on("console", (message) => { this.onConsole(message); });
    context.on("weberror", (error) => { this.onWebError(error); });
    context.on("request", (request) => { this.onRequest(request); });
    context.on("response", (response) => { this.onResponse(response); });
    context.on("requestfinished", (request) => { this.finishRequest(request, undefined); });
    context.on("requestfailed", (request) => { this.finishRequest(request, request.failure()?.errorText); });
    await this.installInterception(context);
    const page = await context.newPage();
    await this.onPage(page);
    const tab = this.tabOf(page);
    if (tab === undefined) throw new BrowserConnectionError("could not initialize the first browser tab");
    const target = await this.cdp(tab).then((session) => session.send("Target.getTargetInfo"));
    const browserCdp = await browser.newBrowserCDPSession();
    this.browserCdp = browserCdp;
    browserCdp.on("Browser.downloadWillBegin", (event) => { this.onDownloadBegin(event); });
    browserCdp.on("Browser.downloadProgress", (event) => { void this.onDownloadProgress(event); });
    const browserContextId = target.targetInfo.browserContextId;
    if (browserContextId === undefined) throw new BrowserConnectionError("could not identify the Chromium browser context");
    await browserCdp.send("Browser.setDownloadBehavior", {
      behavior: "allowAndName", browserContextId,
      downloadPath: this.downloadPath, eventsEnabled: true,
    });
    this.changes = [];
  }

  private async onPage(page: Page): Promise<void> {
    if (this.byPage.has(page)) return;
    if (this.tabs.size >= MAX_TABS) { await page.close(); return; }
    const id = `tab_${this.nextTab}`; this.nextTab += 1;
    this.tabs.set(id, new Tab(id, page)); this.byPage.set(page, id);
    page.on("close", () => { this.forget(page); });
    page.on("framenavigated", (frame) => { this.trackNavigated(frame); });
    this.changes.push({ type: "tab_opened", tab_id: id }); this.activate(id);
  }

  private forget(page: Page): void {
    const id = this.byPage.get(page); if (id === undefined) return;
    this.byPage.delete(page); this.tabs.delete(id);
    const index = this.recent.indexOf(id); if (index >= 0) this.recent.splice(index, 1);
    if (this.active === id) this.active = this.recent.at(-1);
  }
  private activate(id: string): void {
    const index = this.recent.indexOf(id); if (index >= 0) this.recent.splice(index, 1);
    this.recent.push(id); this.active = id;
  }
  private async onDialog(dialog: Dialog): Promise<void> {
    try {
      if (dialog.type() === "beforeunload") { await dialog.accept(); return; }
      this.changes.push({ type: "dialog_dismissed", kind: dialog.type(), message: dialog.message().slice(0, MAX_TEXT) });
      await dialog.dismiss();
    } catch { /* no-excuse-ok: catch — the page may close before dialog handling finishes. */ }
  }
  private tabOf(page: Page | null | undefined): Tab | undefined {
    if (page === null || page === undefined) return undefined;
    const id = this.byPage.get(page); return id === undefined ? undefined : this.tabs.get(id);
  }
  private onConsole(message: ConsoleMessage): void { this.tabOf(message.page())?.log(`[${message.type()}] ${message.text()}`); }
  private onWebError(error: WebError): void { this.tabOf(error.page())?.log(`[error] ${String(error.error())}`); }
  private requestTab(request: Request): Tab | undefined {
    try { return this.tabOf(request.frame().page()); } catch { return undefined; }
  }
  private onRequest(request: Request): void { this.requestTab(request)?.startRequest(request); }
  private onResponse(response: Response): void { this.requestTab(response.request())?.answerRequest(response); }
  private finishRequest(request: Request, failure: string | undefined): void { this.requestTab(request)?.finishRequest(request, failure); }

  /**
   * Every main-frame navigation is policy-checked here, whichever way it was triggered — a link
   * click, a script assignment to `location`, a meta refresh, or a server redirect the route
   * interception did not see. `navigate()` is the one exception, and only because it suppresses this
   * observer (`navigating`) and runs {@link checkLanded} instead, which refuses the call outright.
   */
  private async onNavigated(frame: Frame): Promise<void> {
    if (this.navigating || this.urlPolicy === undefined || frame.parentFrame() !== null) return;
    const tab = this.tabOf(frame.page()); const url = frame.url();
    if (tab === undefined || url === "" || url === "about:blank" || !(await this.refuses(url, tab.id))) return;
    this.refusedTabs.add(tab.id); this.changes.push({ type: "navigation_refused" });
  }
  /**
   * `urlPolicy` may be asynchronous, so the check {@link onNavigated} starts is kept here and
   * settled before anything observes the tab. Without that, a page-triggered navigation to a refused
   * address could still be the live page — and its URL still in the reported browser state — while
   * the policy was being consulted.
   */
  private trackNavigated(frame: Frame): void {
    const check: Promise<void> = this.onNavigated(frame)
      .catch(() => { /* no-excuse-ok: catch — observing a navigation never fails the navigation. */ })
      .then(() => { this.navigationChecks.delete(check); });
    this.navigationChecks.add(check);
  }
  private async leaveRefusedPages(): Promise<void> {
    if (this.navigationChecks.size > 0) await Promise.all([...this.navigationChecks]);
    for (const id of [...this.refusedTabs]) { const tab = this.tabs.get(id); if (tab !== undefined) await this.blank(tab); }
  }
  private async blank(tab: Tab): Promise<void> {
    this.navigating = true;
    try { await tab.page.goto("about:blank", { waitUntil: "commit", timeout: this.navigationMs }); }
    catch { /* no-excuse-ok: catch — leaving a refused page never masks the original refusal. */ }
    finally { this.navigating = false; this.refusedTabs.delete(tab.id); tab.world = null; }
  }
  private async installInterception(context: BrowserContext): Promise<void> {
    if (this.urlPolicy === undefined) return;
    await context.route("**/*", async (route) => this.guard(route));
    await context.routeWebSocket("**/*", async (route) => this.guardWebSocket(route));
  }
  private async refuses(url: string, tabId?: string): Promise<boolean> {
    if (this.urlPolicy === undefined) return false;
    try { await this.urlPolicy(tabId === undefined ? {} : { tabId }, url); return false; }
    catch { return true; }
  }
  private async guardWebSocket(route: WebSocketRoute): Promise<void> {
    if (!(await this.refuses(route.url()))) { route.connectToServer(); return; }
    await route.close({ code: 1008, reason: "Policy violation" });
  }
  /**
   * Playwright follows a redirect without routing it again, so this guard sees first hops only.
   * For a MAIN-FRAME navigation that gap is closed downstream: `navigate()` re-asks the policy about
   * the address the page actually landed on ({@link checkLanded}) and refuses the call, and a
   * navigation a click or a script started is caught by {@link onNavigated} and the tab is blanked
   * before the next member runs. For a SUB-RESOURCE redirect chain there is no such second look —
   * a permitted URL can redirect a subresource to a refused one. That residual is deliberate and is
   * stated in the README's Safety section, alongside shared workers, because closing it would mean
   * proxying every request through this process with `maxRedirects: 0`, which is a far larger
   * change and attack surface than the one it removes. The sandbox's egress rules
   * (`domainAllowList`/`networkAllowList`) are the backstop for it.
   */
  private async guard(route: Route): Promise<void> {
    const request = route.request(); const tab = this.requestTab(request);
    if (!(await this.refuses(request.url(), tab?.id))) { await route.continue(); return; }
    try { await route.abort("blockedbyclient"); } catch { return; }
    if (request.isNavigationRequest() && request.frame().parentFrame() === null && !this.navigating) {
      this.changes.push({ type: "navigation_refused" });
    }
  }

  private onDownloadBegin(event: { readonly guid: string; readonly url: string }): void {
    const url = event.url.slice(0, MAX_TEXT);
    this.downloads.set(event.guid, url);
    this.changes.push({ type: "download_started", download_id: event.guid, url });
  }
  private async onDownloadProgress(event: { readonly guid: string; readonly state: string; readonly receivedBytes: number }): Promise<void> {
    const url = this.downloads.get(event.guid); if (url === undefined || event.state === "inProgress") return;
    this.downloads.delete(event.guid);
    if (event.state !== "completed") {
      this.changes.push({ type: "download_failed", download_id: event.guid, url, error: "The download was cancelled or failed." }); return;
    }
    const path = posix.join(this.downloadPath, event.guid);
    const change: BetaBrowserStateChange = { type: "download_completed", download_id: event.guid, url, size_bytes: event.receivedBytes };
    try { if (await this.policy?.isPathVisible(path)) change.path = path; }
    catch { /* no-excuse-ok: catch — file-policy failure hides the sensitive path. */ }
    this.changes.push(change);
  }

  private tab(tabId: string | null | undefined): Tab {
    if (this.disconnected || this.context === undefined) throw new ToolError("The browser in the sandbox is no longer connected.");
    const id = tabId ?? this.active;
    if (id === undefined) throw new ToolError("No tab is open; open one with new_tab.");
    const tab = this.tabs.get(id); if (tab === undefined) throw new ToolError("The requested tab is not open.");
    return tab;
  }
  private async cdp(tab: Tab): Promise<CDPSession> {
    if (tab.cdp === null) tab.cdp = await this.context?.newCDPSession(tab.page) ?? null;
    if (tab.cdp === null) throw new ToolError("The browser in the sandbox is no longer connected.");
    return tab.cdp;
  }
  private async targetId(tab: Tab): Promise<string> {
    if (tab.targetId === null) tab.targetId = (await (await this.cdp(tab)).send("Target.getTargetInfo")).targetInfo.targetId;
    return tab.targetId;
  }
  private async inWorld(tab: Tab, functionName: string, args: readonly unknown[] = [], byValue = true): Promise<unknown> {
    const cdp = await this.cdp(tab);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (tab.world === null) {
        const tree = await cdp.send("Page.getFrameTree");
        tab.world = (await cdp.send("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: "daytona-claude-toolsets" })).executionContextId;
        await cdp.send("Runtime.evaluate", { expression: PAGE_JS, contextId: tab.world });
      }
      const expression = `globalThis.__dt[${JSON.stringify(functionName)}](...${JSON.stringify(args)})`;
      try {
        const result = await cdp.send("Runtime.evaluate", { expression, contextId: tab.world, returnByValue: byValue });
        if (result.exceptionDetails === undefined) return byValue ? result.result.value : result.result;
      } catch (error: unknown) {
        if (!(error instanceof Error) || attempt > 0 || !error.message.toLowerCase().includes("context")) throw error;
      }
      tab.world = null;
    }
    throw new ToolError("The page could not be read.");
  }
  private stale(ref: string): ToolError { return new ToolError(`Unknown or stale ref ${ref}; call read_page or find for current refs.`); }
  private async point(tab: Tab, target: BetaBrowserClickTarget): Promise<readonly [number, number]> {
    if (target.type === "ref") {
      const value = await this.inWorld(tab, "center", [target.ref]);
      const result = recordOf(value);
      if ("error" in result && result.error === "invisible") throw new ToolError(`The element ${target.ref} is not visible.`);
      if (!("x" in result) || !("y" in result) || typeof result.x !== "number" || typeof result.y !== "number") throw this.stale(target.ref);
      return [result.x, result.y];
    }
    const [width, height] = this.viewport;
    if (!(0 <= target.x && target.x < width && 0 <= target.y && target.y < height)) throw new ToolError(`(${target.x}, ${target.y}) is outside the ${width}x${height} viewport.`);
    return [target.x, target.y];
  }
  private modifiers(text: string | null | undefined): string[] {
    if (!text) return [];
    const [modifiers, token] = parseChord(text.trim());
    if (token !== null) throw new ToolError("modifiers takes modifier keys only, such as shift or ctrl+shift.");
    return modifiers.map((name) => MODIFIERS[name as keyof typeof MODIFIERS]);
  }
  private async settle(tab: Tab): Promise<void> { try { await tab.page.waitForTimeout(this.settleMs); } catch { /* page closed */ } }
  private async click(tabId: string | null | undefined, target: BetaBrowserClickTarget, modifiers: string | null | undefined, button: "left" | "middle" | "right" = "left", count = 1): Promise<void> {
    const tab = this.tab(tabId); const held = this.modifiers(modifiers); const [x, y] = await this.point(tab, target);
    for (const key of held) await tab.page.keyboard.down(key);
    try { await tab.page.mouse.click(x, y, { button, clickCount: count }); }
    finally { for (const key of [...held].reverse()) await tab.page.keyboard.up(key); }
    await this.settle(tab);
  }
  private async capture(tab: Tab, clip?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly scale: number }): Promise<BetaScreenshotResult> {
    const result = await (await this.cdp(tab)).send("Page.captureScreenshot", { format: "png", ...(clip === undefined ? {} : { clip }) });
    return { data: result.data, mediaType: "image/png" };
  }
  /** Titles and URLs are page-controlled, so they are capped like every other page-authored string. */
  private entry(tab: Tab, titles: ReadonlyMap<string, readonly [string, string]>): BetaBrowserStateTabEntry {
    const known = tab.targetId === null ? undefined : titles.get(tab.targetId);
    if (known !== undefined) tab.title = known[0].slice(0, MAX_TEXT);
    return {
      tab_id: tab.id, title: tab.title,
      url: (known?.[1] ?? tab.page.url()).slice(0, MAX_TEXT),
      active: tab.id === this.active,
    };
  }
  private async targets(): Promise<ReadonlyMap<string, readonly [string, string]>> {
    if (this.browserCdp === undefined || this.disconnected) return new Map();
    const infos = (await this.browserCdp.send("Target.getTargets")).targetInfos;
    return new Map(infos.filter((info) => info.type === "page").map((info) => [info.targetId, [info.title, info.url] as const]));
  }
  private async keepAlive(reserve = 0): Promise<void> {
    const now = performance.now() / 1000; if (now - this.lastActivity + reserve < KEEP_ALIVE) return;
    this.lastActivity = now; try { await this.sandbox.refreshActivity(); } catch { /* keep-alive cannot fail a call */ }
  }
  private memberBound(): number { return Math.max(this.navigationMs / 1000, MAX_DURATION, SCRIPT_TIMEOUT_MS / 1000) + this.settleMs / 1000; }

  protected override async execute(ctx: BetaToolsetCallContext, name: BetaBrowserMemberName, input: BetaBrowserMemberInput): Promise<BetaBrowserMemberResult> {
    await this.keepAlive(this.memberBound()); await this.leaveRefusedPages(); return super.execute(ctx, name, input);
  }
  private async reportState(_ctx: BetaToolsetCallContext): Promise<BetaBrowserState> {
    await this.keepAlive(); await this.leaveRefusedPages(); let titles: ReadonlyMap<string, readonly [string, string]> = new Map();
    try { for (const tab of this.tabs.values()) await this.targetId(tab); titles = await this.targets(); } catch { /* report last-known state */ }
    if (this.active === undefined || !this.tabs.has(this.active)) this.active = this.recent.at(-1) ?? this.tabs.keys().next().value;
    const tabs = [...this.tabs.values()].slice(0, MAX_TABS).map((tab) => this.entry(tab, titles));
    const state_changes = this.changes; this.changes = [];
    return state_changes.length === 0 ? { tabs } : { tabs, state_changes };
  }

  protected override async navigate(_ctx: BetaToolsetCallContext, input: BetaBrowserNavigateInput): Promise<BetaBrowserNavigateResult> {
    const tab = this.tab(input.tab_id); const page = tab.page; const before = page.url(); let response: Response | null = null;
    this.navigating = true;
    try {
      if (input.url === "back" || input.url === "forward" || input.url === "reload") {
        response = input.url === "back" ? await page.goBack({ waitUntil: "commit", timeout: this.navigationMs })
          : input.url === "forward" ? await page.goForward({ waitUntil: "commit", timeout: this.navigationMs })
            : await page.reload({ waitUntil: "commit", timeout: this.navigationMs });
        if (response === null && input.url !== "reload" && page.url() === before) throw new ToolError(`There is no page to go ${input.url} to.`);
        try { await page.waitForLoadState("domcontentloaded", { timeout: this.navigationMs }); } catch (error: unknown) { if (!(error instanceof playwrightErrors.TimeoutError)) throw error; }
      } else response = await page.goto(normalizeUrl(input.url), { waitUntil: "domcontentloaded", timeout: this.navigationMs });
    } catch (error: unknown) {
      if (error instanceof ToolError) throw error;
      if (error instanceof playwrightErrors.TimeoutError) throw new ToolError(`The page did not load within ${this.navigationMs / 1000} seconds.`);
      if (!(error instanceof Error) || !error.message.includes("Download is starting")) throw new ToolError(failurePhrase(error));
    } finally { this.navigating = false; }
    tab.world = null; await this.checkLanded(tab, before);
    let title = ""; try { title = await page.title(); } catch { /* closed page has no title */ }
    return { url: page.url(), ...(response === null ? {} : { status: response.status() }), ...(title ? { title } : {}) };
  }
  private async checkLanded(tab: Tab, before: string): Promise<void> {
    const landed = tab.page.url(); if (this.urlPolicy === undefined || landed === before || landed === "about:blank" || !(await this.refuses(landed, tab.id))) return;
    await this.blank(tab); throw new URLRefusedError("The navigation was refused: it redirected to an address that is not allowed.");
  }
  protected override async screenshot(_ctx: BetaToolsetCallContext, input: BetaBrowserScreenshotInput): Promise<BetaScreenshotResult> { return this.capture(this.tab(input.tab_id)); }
  protected override async zoom(_ctx: BetaToolsetCallContext, input: BetaBrowserZoomInput): Promise<BetaScreenshotResult> {
    const [x0, y0, x1, y1] = input.region; const [width, height] = this.viewport;
    if (x0 === undefined || y0 === undefined || x1 === undefined || y1 === undefined || !(0 <= x0 && x0 < x1 && x1 <= width && 0 <= y0 && y0 < y1 && y1 <= height)) throw new ToolError(`region must satisfy 0 <= x0 < x1 <= ${width} and 0 <= y0 < y1 <= ${height} (viewport pixels).`);
    const tab = this.tab(input.tab_id); const scroll = await tab.page.evaluate(() => [window.scrollX, window.scrollY]);
    // Rendered at a higher scale rather than upscaled, so the detail is real. `Page.captureScreenshot`
    // clips in DOCUMENT coordinates, not viewport ones, so the scroll offset is added — the same
    // conversion Playwright itself performs (`documentRect.x = visualViewport.pageX + viewportRect.x`).
    // A clip below the fold is therefore correct, not out of bounds; the region input stays in
    // viewport pixels because that is the coordinate space of the screenshots the model is looking at.
    return this.capture(tab, { x: x0 + (scroll[0] ?? 0), y: y0 + (scroll[1] ?? 0), width: x1 - x0, height: y1 - y0, scale: Math.min(width / (x1 - x0), height / (y1 - y0), 8) });
  }
  protected override async read_page(_ctx: BetaToolsetCallContext, input: BetaBrowserReadPageInput): Promise<string> {
    const depth = input.depth ?? 15; if (depth < 1) throw new ToolError("depth must be at least 1.");
    const value = await this.inWorld(this.tab(input.tab_id), "readPage", [{ ref: input.ref, depth, all: input.filter === "all", interactive: input.filter === "interactive" }]);
    const result = recordOf(value);
    if (result["error"] === "stale" && input.ref) throw this.stale(input.ref);
    return String(result["text"] ?? "");
  }
  protected override async find(_ctx: BetaToolsetCallContext, input: BetaBrowserFindInput): Promise<string> {
    const value = await this.inWorld(this.tab(input.tab_id), "candidates"); const candidates = Array.isArray(value) ? value.filter((item): item is Readonly<Record<string, unknown>> => typeof item === "object" && item !== null) : [];
    const matches = rank(input.query, candidates).slice(0, FIND_LIMIT); return matches.length === 0 ? `No element matched ${JSON.stringify(input.query)}. Try read_page.` : matches.map((candidate) => String(candidate["line"] ?? "")).join("\n");
  }
  protected override async get_page_text(_ctx: BetaToolsetCallContext, input: BetaBrowserGetPageTextInput): Promise<string> { return String(await this.inWorld(this.tab(input.tab_id), "pageText") ?? ""); }
  protected override async read_console(_ctx: BetaToolsetCallContext, input: BetaBrowserReadConsoleInput): Promise<string> { return this.tab(input.tab_id).takeConsole(); }
  protected override async read_network(_ctx: BetaToolsetCallContext, input: BetaBrowserReadNetworkInput): Promise<string> { return this.tab(input.tab_id).takeNetwork(); }
  protected override async javascript_exec(_ctx: BetaToolsetCallContext, input: BetaBrowserJavascriptExecInput): Promise<string> {
    // `timeout` is a documented optional parameter of the CDP `Runtime.evaluate` command
    // ("Terminate execution after timing out (number of milliseconds)") and is what enforces the
    // advertised 10-second limit: V8 terminates the script and reports it through
    // `exceptionDetails`, which is why the "terminated" description below maps to the timeout
    // phrase. There is no `Runtime.setTimeout` command in the protocol.
    const result = await (await this.cdp(this.tab(input.tab_id))).send("Runtime.evaluate", { expression: input.text, returnByValue: true, awaitPromise: true, userGesture: true, replMode: true, timeout: SCRIPT_TIMEOUT_MS });
    if (result.exceptionDetails !== undefined) {
      const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      if (description.toLowerCase().includes("terminated")) throw new ToolError("The script did not finish within 10 seconds.");
      throw new ToolError(`The script threw: ${description.slice(0, MAX_TEXT)}`);
    }
    const remote: CdpRemote = {
      type: result.result.type,
      ...(result.result.value === undefined ? {} : { value: result.result.value }),
      ...(result.result.unserializableValue === undefined ? {} : { unserializableValue: result.result.unserializableValue }),
      ...(result.result.description === undefined ? {} : { description: result.result.description }),
    };
    return formatRemote(remote);
  }

  protected override async left_click(_ctx: BetaToolsetCallContext, input: BetaBrowserLeftClickInput): Promise<void> { await this.click(input.tab_id, input.target, input.modifiers); }
  protected override async right_click(_ctx: BetaToolsetCallContext, input: BetaBrowserRightClickInput): Promise<void> { await this.click(input.tab_id, input.target, input.modifiers, "right"); }
  protected override async middle_click(_ctx: BetaToolsetCallContext, input: BetaBrowserMiddleClickInput): Promise<void> { await this.click(input.tab_id, input.target, input.modifiers, "middle"); }
  protected override async double_click(_ctx: BetaToolsetCallContext, input: BetaBrowserDoubleClickInput): Promise<void> { await this.click(input.tab_id, input.target, input.modifiers, "left", 2); }
  protected override async triple_click(_ctx: BetaToolsetCallContext, input: BetaBrowserTripleClickInput): Promise<void> { await this.click(input.tab_id, input.target, input.modifiers, "left", 3); }
  protected override async hover(_ctx: BetaToolsetCallContext, input: BetaBrowserHoverInput): Promise<void> { const tab = this.tab(input.tab_id); const [x, y] = await this.point(tab, input.target); await tab.page.mouse.move(x, y); await this.settle(tab); }
  protected override async mouse_move(_ctx: BetaToolsetCallContext, input: BetaBrowserMouseMoveInput): Promise<void> { const tab = this.tab(input.tab_id); const [x, y] = await this.point(tab, input.target); await tab.page.mouse.move(x, y); }
  protected override async left_mouse_down(_ctx: BetaToolsetCallContext, input: BetaBrowserLeftMouseDownInput): Promise<void> { const tab = this.tab(input.tab_id); const [x, y] = await this.point(tab, input.target); await tab.page.mouse.move(x, y); await tab.page.mouse.down(); }
  protected override async left_mouse_up(_ctx: BetaToolsetCallContext, input: BetaBrowserLeftMouseUpInput): Promise<void> { const tab = this.tab(input.tab_id); const [x, y] = await this.point(tab, input.target); await tab.page.mouse.move(x, y); await tab.page.mouse.up(); await this.settle(tab); }
  protected override async left_click_drag(_ctx: BetaToolsetCallContext, input: BetaBrowserLeftClickDragInput): Promise<void> { const tab = this.tab(input.tab_id); const [x0, y0] = await this.point(tab, input.from); const [x1, y1] = await this.point(tab, input.target); await tab.page.mouse.move(x0, y0); await tab.page.mouse.down(); await tab.page.mouse.move(x1, y1, { steps: 10 }); await tab.page.mouse.up(); await this.settle(tab); }
  protected override async scroll(_ctx: BetaToolsetCallContext, input: BetaBrowserScrollInput): Promise<void> {
    const amount = input.scroll_amount ?? 3; if (!(1 <= amount && amount <= 10)) throw new ToolError("scroll_amount must be between 1 and 10.");
    const tab = this.tab(input.tab_id); const [x, y] = await this.point(tab, input.target); const distance = amount * WHEEL_NOTCH;
    const delta = { up: [0, -distance], down: [0, distance], left: [-distance, 0], right: [distance, 0] }[input.scroll_direction];
    const [dx, dy] = delta; if (dx === undefined || dy === undefined) throw new ToolError("Unknown scroll direction.");
    await tab.page.mouse.move(x, y); await tab.page.mouse.wheel(dx, dy); await this.settle(tab);
  }
  protected override async scroll_to(_ctx: BetaToolsetCallContext, input: BetaBrowserScrollToInput): Promise<void> { const value = await this.inWorld(this.tab(input.tab_id), "scrollTo", [input.target.ref]); if (typeof value === "object" && value !== null && "error" in value) throw this.stale(input.target.ref); }

  protected override async type_(_ctx: BetaToolsetCallContext, input: BetaBrowserTypeInput): Promise<void> { const tab = this.tab(input.tab_id); await tab.page.keyboard.type(input.text); await this.settle(tab); }
  protected override async key(_ctx: BetaToolsetCallContext, input: BetaBrowserKeyInput): Promise<void> {
    const tab = this.tab(input.tab_id); const repeat = input.repeat ?? 1; if (!(1 <= repeat && repeat <= MAX_REPEAT)) throw new ToolError(`repeat must be between 1 and ${MAX_REPEAT}.`);
    const chords = splitSequence(input.text).map(playwrightChord); for (let index = 0; index < repeat; index += 1) for (const chord of chords) await tab.page.keyboard.press(chord); await this.settle(tab);
  }
  protected override async hold_key(_ctx: BetaToolsetCallContext, input: BetaBrowserHoldKeyInput): Promise<void> {
    if (!(0 <= input.duration && input.duration <= MAX_DURATION)) throw new ToolError(`duration must be between 0 and ${MAX_DURATION} seconds.`);
    const tab = this.tab(input.tab_id); const chords = splitSequence(input.text); if (chords.length !== 1 || chords[0] === undefined) throw new ToolError("hold_key holds one key or chord, such as shift or ctrl+a.");
    const [modifiers, token] = parseChord(chords[0]); const keys: string[] = modifiers.map((name) => PLAYWRIGHT[name as keyof typeof PLAYWRIGHT]); if (token !== null) keys.push(playwrightChord(token));
    const pressed: string[] = []; try { for (const key of keys) { await tab.page.keyboard.down(key); pressed.push(key); } await tab.page.waitForTimeout(input.duration * 1000); } finally { for (const key of [...pressed].reverse()) await tab.page.keyboard.up(key); }
  }
  protected override async form_input(_ctx: BetaToolsetCallContext, input: BetaBrowserFormInputInput): Promise<void> {
    const tab = this.tab(input.tab_id); const ref = input.target.ref; const value = await this.inWorld(tab, "setValue", [ref, input.value]); const result = recordOf(value); const error = result["error"];
    if (error === undefined) { await this.settle(tab); return; }
    const messages: Readonly<Record<string, string>> = { stale: `Unknown or stale ref ${ref}; call read_page or find for current refs.`, "no-option": `The select ${ref} has no option with that value or text.`, "want-boolean": `${ref} is a checkbox or radio button; set it to true or false.`, "radio-off": `${ref} is a radio button and cannot be cleared; set the one you want in its group to true instead.`, disabled: `${ref} is disabled, so it cannot be ticked or cleared.`, "not-checkable": `${ref} is not a checkbox; give it a text or number value.`, "file-input": `${ref} is a file input; use file_upload.`, "not-a-field": `${ref} is not a form field.` };
    throw new ToolError(messages[String(error)] ?? "The value could not be set.");
  }
  protected override async file_upload(_ctx: BetaToolsetCallContext, input: BetaBrowserFileUploadInput): Promise<void> {
    if ((input.document_ids?.length ?? 0) > 0) throw new ToolError("This browser runs in a Daytona sandbox and cannot upload Files API documents.");
    const paths = input.paths ?? []; if (paths.length === 0) throw new ToolError("file_upload needs at least one path."); const resolved = await this.resolveInSandbox(paths);
    const tab = this.tab(input.tab_id); const value = await this.inWorld(tab, "fileInput", [input.target.ref], false); const remote = recordOf(value);
    if (remote["subtype"] !== "node" || typeof remote["objectId"] !== "string") { const inner = remote["value"]; if (typeof inner === "object" && inner !== null && "error" in inner && inner.error === "not-file") throw new ToolError(`${input.target.ref} is not a file input.`); throw this.stale(input.target.ref); }
    await (await this.cdp(tab)).send("DOM.setFileInputFiles", { files: resolved, objectId: remote["objectId"] }); await this.settle(tab);
  }
  private async resolveInSandbox(paths: readonly string[]): Promise<string[]> {
    const result = await this.sandbox.process.executeCommand(`realpath -e -- ${paths.map(shellQuote).join(" ")}`); const resolved = result.result.split(/\r?\n/u).filter(Boolean);
    if (result.exitCode !== 0 || resolved.length !== paths.length) throw new UploadRefusedError("An upload path does not exist in the sandbox.");
    if (this.filePolicy !== undefined) {
      const rootsResult = await this.sandbox.process.executeCommand(`realpath -m -- ${this.filePolicy.uploadRoots.map(shellQuote).join(" ")}`); const roots = rootsResult.result.split(/\r?\n/u).filter(Boolean);
      if (rootsResult.exitCode !== 0 || roots.length !== this.filePolicy.uploadRoots.length) throw new UploadRefusedError("An upload path could not be checked against the upload directory.");
      if (!resolved.every((path) => roots.some((root) => isUnder(path, root)))) throw new UploadRefusedError("An upload path is outside the upload directory.");
    } else if (resolved.some((path, index) => path !== posix.normalize(paths[index] ?? ""))) throw new UploadRefusedError("An upload path is a link to another path; upload the file itself.");
    return resolved;
  }

  protected override async new_tab(_ctx: BetaToolsetCallContext, _input: BetaBrowserNewTabInput): Promise<BetaBrowserStateTabEntry> {
    if (this.disconnected || this.context === undefined) throw new ToolError("The browser in the sandbox is no longer connected."); if (this.tabs.size >= MAX_TABS) throw new ToolError(`${MAX_TABS} tabs are open; close one first.`);
    const page = await this.context.newPage(); await this.onPage(page); const tab = this.tabOf(page); if (tab === undefined) throw new ToolError("The new tab could not be opened."); this.activate(tab.id); return { tab_id: tab.id, title: "", url: page.url(), active: true };
  }
  protected override async list_tabs(_ctx: BetaToolsetCallContext, _input: BetaBrowserListTabsInput): Promise<BetaBrowserStateTabEntry[]> { return [...this.tabs.values()].map((tab) => ({ tab_id: tab.id, title: tab.title, url: tab.page.url(), active: tab.id === this.active })); }
  protected override async switch_tab(_ctx: BetaToolsetCallContext, input: BetaBrowserSwitchTabInput): Promise<BetaBrowserStateTabEntry> { const tab = this.tab(input.tab_id); await tab.page.bringToFront(); this.activate(tab.id); return { tab_id: tab.id, title: tab.title, url: tab.page.url(), active: true }; }
  protected override async close_tab(_ctx: BetaToolsetCallContext, input: BetaBrowserCloseTabInput): Promise<void> { const tab = this.tab(input.tab_id); await tab.page.close({ runBeforeUnload: false }); this.forget(tab.page); }
  protected override async wait(_ctx: BetaToolsetCallContext, input: BetaBrowserWaitInput): Promise<void> { if (!(0 <= input.duration && input.duration <= MAX_DURATION)) throw new ToolError(`duration must be between 0 and ${MAX_DURATION} seconds.`); const tab = this.active === undefined ? undefined : this.tabs.get(this.active); if (tab === undefined) await new Promise<void>((resolve) => setTimeout(resolve, input.duration * 1000)); else await tab.page.waitForTimeout(input.duration * 1000); }
}
