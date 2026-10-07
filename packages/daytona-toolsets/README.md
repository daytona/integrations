# daytona-toolsets

[Daytona](https://www.daytona.io) sandbox drivers for the Anthropic SDK's **computer** and **browser** toolsets (`computer_toolset_20260801`, `browser_toolset_20260801`). Hand one to `client.beta.messages.tool_runner` and Claude drives a desktop or a Chromium that runs in an isolated Daytona sandbox, while your API keys, the model loop and the toolset stay in your process.

- **`DaytonaComputer`** (and `AsyncDaytonaComputer`): the sandbox desktop, through Daytona's [Computer Use API](https://www.daytona.io/docs/en/computer-use/).
- **`DaytonaBrowser`**: Chromium inside the sandbox, driven over the Chrome DevTools Protocol with Playwright through a signed Daytona [preview URL](https://www.daytona.io/docs/en/preview/).

Every member of both toolsets is implemented, including the browser members that are off by default (`read_console`, `read_network`, `javascript_exec`, `file_upload`).

## Installation

```bash
pip install daytona-toolsets             # DaytonaComputer
pip install 'daytona-toolsets[browser]'  # + DaytonaBrowser (Playwright client only; no local browser)
```

Set your keys in the environment:

```bash
export DAYTONA_API_KEY="..."    # https://app.daytona.io/dashboard/keys
export ANTHROPIC_API_KEY="..."
```

## Quickstart

**Computer.** The SDK requires a `confirm` callable while `type`, `key` or `hold_key` is enabled. This one approves everything, which is only reasonable for a throwaway sandbox:

```python
from anthropic import Anthropic
from daytona_toolsets import DaytonaComputer

with DaytonaComputer(confirm=lambda context: True) as computer:
    for message in Anthropic().beta.messages.tool_runner(model="claude-sonnet-5-5", max_tokens=4096, tools=[computer], messages=[{"role": "user", "content": "Open a terminal, run date, and tell me the output."}]):
        print(message)
```

**Browser.** Pass a `url_policy`; see [Safety](#safety):

```python
from anthropic import Anthropic
from daytona_toolsets import DaytonaBrowser

with DaytonaBrowser(url_policy=my_policy) as browser:
    for message in Anthropic().beta.messages.tool_runner(model="claude-sonnet-5-5", max_tokens=4096, tools=[browser], messages=[{"role": "user", "content": "Open example.com and tell me the page heading."}]):
        print(message)
```

With no `sandbox` argument, each driver creates a sandbox from Daytona's default snapshot, which ships the desktop and Chromium, and deletes it when the `with` block exits.

## Sandbox lifecycle

| | How | On `close()` |
|---|---|---|
| **Owned** (default) | `DaytonaComputer(create_params=CreateSandboxFromSnapshotParams(...))`, or no arguments | deleted (`on_close="stop"` stops it instead) |
| **Borrowed** | `DaytonaComputer(sandbox)` with a running `Sandbox` | left running; `DaytonaBrowser` stops the Chromium it started |

`close()` is idempotent and safe after a failed construction: a sandbox created before the failure is still removed. Sandboxes the drivers create carry the label `created-by=daytona-toolsets`. Keyword arguments the drivers don't define (`confirm`, `configs`, `url_policy`, `file_policy`, `tool_configs`) go to the SDK unchanged.

`AsyncDaytonaComputer` takes the same arguments through `await AsyncDaytonaComputer.create(...)`, for `AsyncAnthropic`. There is no async browser driver yet.

## What's implemented

### `DaytonaComputer`

| Members | How |
|---|---|
| `screenshot`, `zoom` | Computer Use screenshots. `zoom` crops the real screen and scales the crop up to a screenshot's size. |
| `left_click`, `right_click`, `middle_click`, `double_click` (plain), `mouse_move`, `cursor_position` | Native Computer Use mouse API; plain single/double clicks use `double` and work on older daemons too. |
| `triple_click`, clicks with modifiers, `left_mouse_down`, `left_mouse_up`, `left_click_drag` (including modifier chords), `scroll` (all directions, including modifier chords) | Native Computer Use mouse API; migrated options are capability-probed and require a sandbox with native mouse hold endpoints. A click, drag or scroll chord holding a non-modifier key token uses XTest instead. |
| `type` | One native Computer Use keyboard call, including tabs; capability-probed and requires the native keyboard hold endpoints. |
| `key` | `key` takes xdotool-style names (`Return`, `Page_Up`, `ctrl+s`, `exclam`, single characters) and space-separated sequences. Named Daytona keys go through the native keyboard press; verified-correct numpad digits, decimal, equal and lock are capability-probed, while numpad Enter and operators use their `KP_*` X keysyms because daemon 0.222.1's native press emits the wrong characters. A single character with no named key is typed; modifier-only chords (`super`, `ctrl+alt`) and keysyms with no Daytona key name (`XF86…`) use XTest. |
| `hold_key` | Native keyboard down, in-process sleep, and reverse-order up; capability-probed. An exotic keysym with no Daytona key name uses XTest. |
| `wait` | sleeps in your process |

- **Coordinates** off the screen are refused with an error, never clamped.
- **Scaling**: owned sandboxes run at 1280×800 (`resolution=`). A larger screen is scaled into `max_screenshot_size` (default 1920×1200), and the model's coordinates are scaled back.
- **Freshness**: a screenshot waits `settle_delay` (0.3 s) after the last input.
- **Bounds**: `wait` and `hold_key` take 0–30 s, `key` repeats 1–100, `scroll` 1–50 notches.

### `DaytonaBrowser`

| Members | How |
|---|---|
| `navigate` | URL, `back`, `forward` or `reload`. A bare host gets `https://`. Every scheme other than http(s) and `about:blank` is refused, including `javascript:`, `view-source:`, `data:` and `file:`. |
| `read_page`, `find`, `get_page_text`, `scroll_to`, `form_input` | JavaScript in an isolated world, which shares the DOM but not the page's globals, so pages can neither read nor rewrite the `ref_N` element references. `find` is keyword matching over role, name and attributes, not a semantic search. |
| `screenshot`, `zoom` | CDP `Page.captureScreenshot`. `zoom` re-renders the region at a higher scale, so its detail is real. |
| clicks, `hover`, `mouse_move`, `left_click_drag`, `left_mouse_down`/`up`, `scroll`, `type`, `key`, `hold_key` | Playwright mouse and keyboard. Modifier chords are held during clicks, and ref targets are scrolled into view first. |
| `new_tab`, `list_tabs`, `switch_tab`, `close_tab` | Pages of one browser context. Popups become tabs, and every member honours `tab_id`. |
| `read_console`, `read_network` | Entries collected per tab since the last read (up to 1,000 each) |
| `javascript_exec` | CDP `Runtime.evaluate` in the page's own world, stopped after 10 s |
| `file_upload` | CDP `DOM.setFileInputFiles` with paths inside the sandbox; see [Files](#files) |
| `wait` | 0–30 s, pumping page events |

The `browser_state` report lists every tab (at most 100) with exactly one active. It carries `tab_opened` for new tabs and popups, download started/completed/failed with the source URL, refused page-started navigations, and dismissed dialogs, and it never raises. Native `alert`/`confirm`/`prompt` dialogs are dismissed and reported, so none can hang a tab. `beforeunload` is accepted, so the navigation the model asked for goes ahead.

## Safety

Before running either toolset, read **"Running a browser toolset safely"** / **"Running a computer toolset safely"** in the Anthropic SDK's toolset guides (`browser-toolset.md`, `computer-toolset.md`) and the [browser use tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool). What the model sees on a page or screen steers what it does next. How this package covers the guide's checklist:

1. **URL policy.** Pass `url_policy`. Nothing is checked without one, and the SDK ships no policy.
2. **Request interception.** The driver applies the same `url_policy` to every request a page makes (with `member=None`), with service workers blocked so they can't bypass it. A page-started navigation it refuses reaches the model as "A navigation was refused." It can't see every redirect hop, WebSocket handshakes or shared-worker requests. Each intercepted request also makes a round trip to your process, which slows heavy pages. Allow the CDNs a site needs, or pages render without them.
3. **Egress.** The sandbox's network is the backstop. Daytona applies your organization's network tier. On tiers that allow it, set `domain_allow_list`, `network_allow_list` or `network_block_all` in `create_params`. Chromium also runs with Local Network Access checks on.
4. **Files.** Uploads are refused unless you pass a `DaytonaFilePolicy`, and `BetaLocalFilePolicy` is refused because it checks paths on your machine, not in the sandbox. Downloads stay in the sandbox.
5. **Approval.** Gate consequential members with `confirm`. The SDK requires it for `javascript_exec` and `file_upload`, and for the computer's `type`, `key` and `hold_key`.
6. **Isolation.** Each driver gets its own sandbox by default. Chromium starts with a fresh profile, a scrubbed environment (`env -i`) and its own sandbox on (off only when the sandbox user is root). Its debugging port listens on loopback inside the sandbox.

How the browser is reached: the driver connects through a **signed preview URL for the debugging port only**, never the sandbox-wide preview token, which would also reach the sandbox's toolbox and terminal. The URL expires two minutes after it is issued; an established connection outlives that. `close()` revokes it. It never appears in logs or error text, and member errors are fixed phrases (`The navigation failed (net::ERR_NAME_NOT_RESOLVED).`) with no URLs, paths or exception text.

### Files

```python
from daytona_toolsets import DaytonaBrowser, DaytonaFilePolicy

browser = DaytonaBrowser(
    configs={"file_upload": {"enabled": True}},
    confirm=my_confirm,
    file_policy=DaytonaFilePolicy(upload_roots=["/home/daytona/uploads"], expose_download_paths=True),
)
```

Upload paths are sandbox paths. The policy admits absolute paths under a root, with `..` refused. The driver then resolves each one inside the sandbox, following symlinks, and checks it again. Files API `document_ids` are refused. Downloads are saved to `browser.download_dir` in the sandbox (created `0700`, outside the upload roots). The model sees a download's path only with `expose_download_paths=True`. Treat downloaded files as untrusted.

## Limitations

- **Computer platform floor:** migrated members (triple/multi-click, modifier clicks/drags/scrolls, horizontal scroll, `left_mouse_down`/`up`, `hold_key`, `type`, and native-routed numpad digits/decimal/equal/lock) need a sandbox on a Daytona version with the native mouse/keyboard hold endpoints. Older sandboxes return a `ToolError` telling you to recreate the sandbox. XTest remains for numpad Enter/operators, exotic keysyms without a Daytona key name and mouse click/drag/scroll chords holding a non-modifier key token.
- **Browser:** frames are not traversed by `read_page`/`find`/`get_page_text`. `find` is keyword-based. A dropped CDP connection is not re-established, so build a new `DaytonaBrowser`. Use it from one thread, outside an asyncio event loop (Playwright's sync API).
- **Both:** the default sandbox user's login shell is `/bin/sh`, so a terminal the model opens has no line editing (`ctrl+a` arrives as `^A`).

## Examples

| Script | What it does |
|---|---|
| [`examples/run_computer.py`](examples/run_computer.py) | Model-driven desktop task (default: open a terminal and run `date`) |
| [`examples/run_browser.py`](examples/run_browser.py) | Model-driven browser task with an example URL policy (`ALLOWED_DOMAINS`) |
| [`examples/exercise_computer.py`](examples/exercise_computer.py) | No model: every computer member against a real sandbox, results and refusals asserted |
| [`examples/exercise_browser.py`](examples/exercise_browser.py) | No model: every browser member against pages served inside a real sandbox |

## Development

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
pytest                               # unit tests (offline, Daytona and Playwright mocked)
python examples/exercise_computer.py # live checks (need DAYTONA_API_KEY)
python examples/exercise_browser.py
ruff check . && black --check . && mypy daytona_toolsets
```

## License

[Apache-2.0](LICENSE)
