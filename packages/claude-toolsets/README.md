# @daytona/claude-toolsets

[Daytona](https://www.daytona.io) sandbox drivers for the Anthropic SDK's **computer** and **browser** toolsets (`computer_toolset_20260801`, `browser_toolset_20260801`), in TypeScript. Hand one to `client.beta.messages.toolRunner` and Claude drives a desktop or a Chromium that runs in an isolated Daytona sandbox, while your API keys, the model loop and the toolset stay in your process.

- **`DaytonaComputer`**: the sandbox desktop, through Daytona's [Computer Use API](https://www.daytona.io/docs/en/computer-use/).
- **`DaytonaBrowser`**: Chromium inside the sandbox, driven over the Chrome DevTools Protocol with Playwright through a signed Daytona [preview URL](https://www.daytona.io/docs/en/preview/).

Every member of both toolsets is implemented, including the browser members that are off by default (`read_console`, `read_network`, `javascript_exec`, `file_upload`).

## Installation

```bash
npm install @daytona/claude-toolsets @anthropic-ai/sdk
```

`@anthropic-ai/sdk` is a peer dependency — install it yourself so the toolset base classes this package extends come from the exact SDK version your application runs. Version `0.132.0` or newer is required; that is the first release exporting the toolset helpers from `@anthropic-ai/sdk/helpers/beta/toolsets`. Chromium is driven with `playwright-core`, which is a direct dependency and downloads no browser: the one that matters already lives in the sandbox.

Set your keys in the environment:

```bash
export DAYTONA_API_KEY="..."    # https://app.daytona.io/dashboard/keys
export ANTHROPIC_API_KEY="..."
```

## Quickstart

Both drivers are built by an `async` factory, not `new`, because construction reaches the network: it leases a sandbox and starts the desktop or Chromium in it.

**Computer.** The SDK requires a `confirm` callback while `type`, `key` or `hold_key` is enabled. This one approves everything, which is only reasonable for a throwaway sandbox:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { DaytonaComputer } from "@daytona/claude-toolsets";

const computer = await DaytonaComputer.create({ confirm: () => true });
try {
  for await (const message of new Anthropic().beta.messages.toolRunner({
    model: "claude-sonnet-5-5",
    max_tokens: 4096,
    tools: [computer],
    messages: [{ role: "user", content: "Open a terminal, run date, and tell me the output." }],
  })) {
    console.log(message);
  }
} finally {
  await computer.close();
}
```

**Browser.** Pass a `urlPolicy`; see [Safety](#safety):

```ts
import Anthropic from "@anthropic-ai/sdk";
import { DaytonaBrowser } from "@daytona/claude-toolsets";

const browser = await DaytonaBrowser.create({ urlPolicy: myPolicy });
try {
  for await (const message of new Anthropic().beta.messages.toolRunner({
    model: "claude-sonnet-5-5",
    max_tokens: 4096,
    tools: [browser],
    messages: [{ role: "user", content: "Open example.com and tell me the page heading." }],
  })) {
    console.log(message);
  }
} finally {
  await browser.close();
}
```

`try`/`finally` is the portable shape and the one these examples use. On a runtime and TypeScript target with [explicit resource management](https://github.com/tc39/proposal-explicit-resource-management), `await using computer = await DaytonaComputer.create(...)` works too — the SDK's toolset base class is async-disposable and disposal calls the same `close()`.

With no `sandbox` option and no custom snapshot or image in `createParams`, each driver creates a sandbox from Daytona's default snapshot, which ships the desktop and Chromium, and deletes it on `close()`.

## Requirements

- **Node.js 20 or newer.**
- **ESM only.** The package ships ES modules with no CommonJS build, so import it from a package with `"type": "module"` (or from `.mts` files, or through a bundler). `require("@daytona/claude-toolsets")` will not work; from CommonJS use dynamic `await import(...)`.
- A **Daytona account and API key**, plus an Anthropic API key for the model loop.

## Sandbox lifecycle

| | How | On `close()` |
|---|---|---|
| **Owned** (default) | `DaytonaComputer.create({ createParams: { … } })`, or no options at all | deleted (`onClose: "stop"` stops it instead) |
| **Borrowed** | `DaytonaComputer.create({ sandbox })` with a running `Sandbox` | left running; `DaytonaBrowser` stops the Chromium it started |

`close()` is idempotent and safe after a failed construction: `create()` closes the half-built driver itself before rethrowing, so a sandbox created before the failure is still removed. Sandboxes the drivers create always carry the label `created-by=daytona-claude-toolsets`, so a leftover one can be found and removed by it; `createParams.labels` adds your own labels but cannot change that one. Options the drivers don't define (`confirm`, `configs`, `urlPolicy`, `filePolicy`, `toolConfigs`) go to the SDK unchanged.

Daytona auto-stops an idle sandbox, and counts only interactions made through the SDK — not traffic through a preview URL, which is how `DaytonaBrowser` reaches Chromium. It therefore refreshes the sandbox's activity itself **around each browser member call**, counting the waiting that member is about to do rather than only the gap since the last one, so no single call leaves the sandbox unheard from for more than 45 seconds. That covers a busy tool-calling loop, not an idle one: the driver refreshes nothing between calls, so a pause in the model loop (or in your own code) that is longer than the auto-stop interval can still stop the sandbox underneath you, and so can a single navigation if you raise `navigationTimeout` past that interval. It never changes the sandbox's auto-stop interval, so a borrowed sandbox keeps the lifecycle you configured.

## What's implemented

### `DaytonaComputer`

| Members | How |
|---|---|
| `screenshot`, `zoom` | Computer Use screenshots. `zoom` crops the real screen and scales the crop up to a screenshot's size. |
| `left_click`, `right_click`, `middle_click`, `double_click` (plain), `mouse_move`, `cursor_position` | Native Computer Use mouse API; plain single and double clicks work on older daemons too. |
| `triple_click`, clicks with modifiers, `left_mouse_down`, `left_mouse_up`, `left_click_drag` (including modifier chords), `scroll` (all directions, including modifier chords) | Native Computer Use mouse API; migrated options are capability-probed and require a sandbox with native mouse hold endpoints. A click, drag or scroll chord holding a non-modifier key token uses XTest instead. |
| `type` | One native Computer Use keyboard call, including tabs; capability-probed and requires the native keyboard hold endpoints. |
| `key` | Takes xdotool-style names (`Return`, `Page_Up`, `ctrl+s`, `exclam`, single characters) and space-separated sequences. Named Daytona keys go through the native keyboard press; verified-correct numpad digits, decimal, equal and lock are capability-probed, while numpad Enter and operators use their `KP_*` X keysyms because daemon 0.222.1's native press emits the wrong characters. A single character with no named key is typed; modifier-only chords (`super`, `ctrl+alt`) and keysyms with no Daytona key name (`XF86…`) use XTest. |
| `hold_key` | Native keyboard down, an awaited sleep, and reverse-order up; capability-probed. An exotic keysym with no Daytona key name uses XTest. |
| `wait` | sleeps in your process |

- **Coordinates** off the screen are refused with an error, never clamped.
- **Scaling**: owned sandboxes run at 1280×800 (`resolution`). A larger screen is scaled into `maxScreenshotSize` (default 1920×1200), and the model's coordinates are scaled back.
- **Freshness**: a screenshot waits `settleDelay` (0.3 s) after the last input.
- **Bounds**: `wait` and `hold_key` take 0–30 s, `key` repeats 1–100, `scroll` 1–50 notches.

### `DaytonaBrowser`

| Members | How |
|---|---|
| `navigate` | URL, `back`, `forward` or `reload`. A bare host gets `https://`. Every scheme other than http(s) and `about:blank` is refused, including `javascript:`, `view-source:`, `data:` and `file:`. |
| `read_page`, `find`, `get_page_text`, `scroll_to`, `form_input` | JavaScript in an isolated world, which shares the DOM but not the page's globals, so pages can neither read nor rewrite the `ref_N` element references. `find` is keyword matching over role, name and attributes, not a semantic search. |
| `screenshot`, `zoom` | CDP `Page.captureScreenshot`. `zoom` re-renders the region at a higher scale, so its detail is real. |
| `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click`, `hover`, `mouse_move`, `left_click_drag`, `left_mouse_down`, `left_mouse_up`, `scroll`, `type`, `key`, `hold_key` | Playwright mouse and keyboard. Modifier chords are held during clicks, and ref targets are scrolled into view first. |
| `new_tab`, `list_tabs`, `switch_tab`, `close_tab` | Pages of one browser context. Popups become tabs, and every member honours `tab_id`. |
| `read_console`, `read_network` | Entries collected per tab since the last read (up to 1,000 each) |
| `javascript_exec` | CDP `Runtime.evaluate` in the page's own world, stopped after 10 s |
| `file_upload` | CDP `DOM.setFileInputFiles` with paths inside the sandbox; see [Files](#files) |
| `wait` | 0–30 s, pumping page events |

The browser-state report lists every tab (at most 100) with exactly one active. It carries `tab_opened` for new tabs and popups, download started/completed/failed with the source URL, refused page-started navigations, and dismissed dialogs, and it never throws. Native `alert`/`confirm`/`prompt` dialogs are dismissed and reported, so none can hang a tab. `beforeunload` is accepted, so the navigation the model asked for goes ahead.

## Safety

Before running either toolset, read **"Running a browser toolset safely"** / **"Running a computer toolset safely"** in the Anthropic SDK's toolset guides (`browser-toolset.md`, `computer-toolset.md`) and the [browser use tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool). What the model sees on a page or screen steers what it does next. How this package covers the guide's checklist:

1. **URL policy.** Pass `urlPolicy`. Nothing is checked without one, and the SDK ships no policy. Passing `urlPolicy: null` installs a policy that refuses everything, which is the useful shape for a locked-down run.
2. **Request interception.** The driver applies the same `urlPolicy` to every request a page makes, with service workers blocked so they can't bypass it. A page-started navigation it refuses reaches the model as "A navigation was refused." WebSocket handshakes go through the same policy on their own hook, and a refused one is closed before it reaches the network. Playwright follows a redirect without routing it again, so interception sees first hops only; the driver therefore asks the policy once more about the address a page actually landed on. For `navigate` that refuses the call; for a navigation a click or a script started, the tab is taken back to a blank page before the next member runs and the model is told the navigation was refused. A sub-resource's redirect chain and the requests and sockets a shared worker makes are still outside it. Each intercepted request also makes a round trip to your process, which slows heavy pages. Allow the CDNs a site needs, or pages render without them.
3. **Egress.** The sandbox's network is the backstop. Daytona applies your organization's network tier. On tiers that allow it, set `domainAllowList`, `networkAllowList` or `networkBlockAll` in `createParams`. Chromium also runs with Local Network Access checks on.
4. **Files.** Uploads are refused unless you pass a `DaytonaFilePolicy`. The SDK's own `BetaNodeFilePolicy` is rejected at construction with a `ToolsetConfigError`, because it checks paths on the machine running your code, not in the sandbox. Downloads stay in the sandbox.
5. **Approval.** Gate consequential members with `confirm`. The SDK requires it for `javascript_exec` and `file_upload`, and for the computer's `type`, `key` and `hold_key`. `javascript_exec` runs in the page's own world, so an enabled one is the model acting as the page: it reads whatever the page can, and the URL policy does not contain it — that policy decides which addresses may be opened and requested, not what a script may touch in a page already open. It stays disabled unless you enable it in `configs`.
6. **Isolation.** Each driver gets its own sandbox by default. Chromium starts with a fresh profile, a scrubbed environment and its own sandbox on (off only when the sandbox user is root). Its debugging port listens on loopback inside the sandbox, and is one the kernel chose: the driver reads it back from `DevToolsActivePort` in that fresh profile, so on a borrowed sandbox it can never attach to a browser someone else started.

How the browser is reached: the driver connects through a **signed preview URL for the debugging port only**, never the sandbox-wide preview token, which would also reach the sandbox's toolbox and terminal. The URL expires two minutes after it is issued; an established connection outlives that. `close()` revokes it. It never appears in logs or error text, and member errors are fixed phrases (`The navigation failed (net::ERR_NAME_NOT_RESOLVED).`) with no URLs, paths or exception text.

### Files

```ts
import { DaytonaBrowser, DaytonaFilePolicy } from "@daytona/claude-toolsets";

const browser = await DaytonaBrowser.create({
  configs: { file_upload: { enabled: true } },
  confirm: myConfirm,
  filePolicy: new DaytonaFilePolicy({
    uploadRoots: ["/home/daytona/uploads"],
    exposeDownloadPaths: true,
  }),
});
```

Upload paths are sandbox paths. The policy admits absolute paths under a root, with `..` refused. The driver then resolves each one inside the sandbox, following symlinks, and checks the resolved path against the roots again. A file policy of your own declares no roots to re-check against, so there a path that resolves to somewhere else is refused outright — a link planted in an upload directory cannot carry the upload out of it. Resolving and uploading are two steps, not one, because the toolbox API hands back a path rather than a handle to hold; anything else running in the sandbox that can write to the upload directory could swap a checked file in between, so keep that directory writable only by you. Files API document ids are refused. Downloads are saved to `browser.downloadDir` in the sandbox (created `0700`, outside the upload roots). The model sees a download's path only with `exposeDownloadPaths: true`. Treat downloaded files as untrusted.

## Limitations

- **Computer platform floor:** migrated members (triple and multi-click, modifier clicks, drags and scrolls, horizontal scroll, `left_mouse_down` and `left_mouse_up`, `hold_key`, `type`, and native-routed numpad digits, decimal, equal and lock) need a sandbox on a Daytona version with the native mouse and keyboard hold endpoints. Older sandboxes return a `ToolError`: _"This sandbox's platform does not support native held input; recreate the sandbox on a current Daytona version."_ XTest remains for numpad Enter and operators, exotic keysyms without a Daytona key name, and mouse click, drag or scroll chords holding a non-modifier key token.
  - A sandbox created from a custom or older **image** may run an older daemon than the default snapshot does: `daytonaio/sandbox:latest` came up on daemon 0.217.0, where the capability probe gets a 404 and every migrated member returns that `ToolError`. Omit `createParams` (or pass an empty snapshot params object) to get the default snapshot, unless you have a reason not to.
- **Browser:** frames are not traversed by `read_page`, `find` or `get_page_text`. `find` is keyword-based. A dropped CDP connection is not re-established, so build a new `DaytonaBrowser`.
- **Both:** the default sandbox user's login shell is `/bin/sh`, so a terminal the model opens has no line editing (`ctrl+a` arrives as `^A`).

## Examples

| Script | What it does |
|---|---|
| [`examples/runComputer.ts`](examples/runComputer.ts) | Model-driven desktop task (default: open a terminal and run `date`) |
| [`examples/runBrowser.ts`](examples/runBrowser.ts) | Model-driven browser task with an example URL policy (`ALLOWED_DOMAINS`) |
| [`examples/exerciseComputer.ts`](examples/exerciseComputer.ts) | No model: every computer member against a real sandbox, results and refusals asserted |
| [`examples/exerciseBrowser.ts`](examples/exerciseBrowser.ts) | No model: every browser member against pages served inside a real sandbox |

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit over src, tests and examples
npm run build       # ESM + declarations into dist/
npm test            # unit tests (offline; Daytona and Playwright are stubbed)
npx tsx examples/exerciseComputer.ts  # live checks (need DAYTONA_API_KEY)
npx tsx examples/exerciseBrowser.ts
```

## License

[Apache-2.0](LICENSE)
