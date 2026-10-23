# pydantic-ai-daytona

[Daytona](https://www.daytona.io) sandbox capability for [Pydantic AI](https://ai.pydantic.dev) agents. `DaytonaSandbox` gives an agent an isolated cloud sandbox for running commands and working with files — a place to execute untrusted or model-generated code without touching the application host.

## Installation

```bash
pip install pydantic-ai-daytona
```

## Configuration

Get your API key from the [Daytona Dashboard](https://app.daytona.io/dashboard/keys) and set it in the environment (or a `.env` file):

```bash
export DAYTONA_API_KEY="your-daytona-api-key"
```

You can also pass `api_key` (plus optional `api_url` / `target`) directly to `DaytonaSandbox`.

## Quickstart

```python
from pydantic_ai import Agent
from pydantic_ai_daytona import DaytonaSandbox

agent = Agent(
    'anthropic:claude-sonnet-4-6',
    capabilities=[DaytonaSandbox()],
)

result = agent.run_sync('Write a Python script that prints the first 10 primes and run it.')
print(result.output)
```

By default every agent run gets a fresh sandbox, created from the Daytona default snapshot and deleted when the run ends.

The capability contributes four tools:

| Tool | Purpose |
|---|---|
| `run_command` | Run a shell command (pipes, redirection, and `&&` work). |
| `read_file` | Read a UTF-8 text file (up to `max_read_bytes`); pageable with explicit `offset`/`limit`. |
| `write_file` | Write a UTF-8 text file, creating the parent directory. |
| `list_directory` | List directory entries, marking directories with `/`. |

Command output labels stdout and stderr separately, reports non-zero exit codes, and is truncated tail-first per stream, so errors and exit status remain visible. When a file read is cut short by the safety caps (or by `limit`), the result ends with the next `offset` to pass to continue reading — the model pages through large files the way `grep -n` numbers them.

Commands receive stdin from `/dev/null` (`cat` without arguments exits rather than waiting for input). Each command has its own process session, so concurrent tool calls can run in parallel. Bash is used when available; images without bash fall back to `/bin/sh`. The shell is detected once per opened session (owned or attached), with `/bin/sh` also used if the probe fails. Pipes, redirection, and bare `exit N` preserve their usual behavior.

Stdout and stderr are captured separately in unique sandbox temporary files. After completion or timeout, each stream is cut to its last `max_output_bytes` **inside the sandbox before transfer**; line limits are applied afterwards. Truncated streams retain a `[... output truncated ...]` marker. Output collection combines sizes, both bounded tails, and file removal in one API call (base64 framing adds bounded transfer overhead). Temporary files are removed best-effort, including on errors/cancellation.

A timeout now retains partial output rather than discarding it, followed by the applied deadline:

```text
[stdout]
before
[timed out after 1s]
```

If neither stream has output, the first line is `(no output)`. A timeout stops its process session without blocking the next command. Low-level `DaytonaSandboxSession.exec()` also returns bounded tails (50 KiB per stream by default; override with `max_output_bytes=`), with `stdout_truncated` / `stderr_truncated` flags and `exit_code=-1` on timeout.

## Sandbox lifecycle

**Owned (default)** — each run creates a sandbox and deletes it when the run ends:

```python
DaytonaSandbox(snapshot='my-snapshot')          # or image='python:3.12-slim'
```

Cancellation during creation is deferred until the SDK create call finishes and the newly owned sandbox is deleted; only then is cancellation re-raised. Owned cleanup waits for deletion to finish. If deletion fails, the run's result is kept and a warning naming the sandbox id is logged (logger `pydantic_ai_daytona._session`), so you can delete it yourself. This can delay cancellation while creation/deletion completes; server-side auto-stop/auto-delete remains the backstop for failures or a process crash.

For fully untrusted code, block outbound network access at creation. Independently, `ephemeral=True` hardens cleanup: Daytona deletes the sandbox the moment it stops, even if your process crashed before its own cleanup ran.

```python
DaytonaSandbox(network_block_all=True, ephemeral=True, labels={'app': 'support-agent'})
```

**Attached** — reuse a sandbox you manage elsewhere; stopped, archived, and paused sandboxes are restarted and never deleted by this package. Startup transitions are awaited with a deadline; destroyed/destroying sandboxes are rejected rather than restarted:

```python
DaytonaSandbox(sandbox_id='my-sandbox-id', env={'APP_MODE': 'agent'})
```

`env` is applied per command in both owned and attached sessions, and also at creation for owned sandboxes. Values are shell-quoted literally (including spaces, quotes, `$HOME`, and newlines). Bash preserves dashed variable names; on the `sh` fallback, environment variable names that aren't valid shell identifiers are dropped. Per-command values do not permanently change an attached sandbox's environment. An injected session supplies its own `env`; do not also pass `env` to `DaytonaSandbox(session=...)`.

Unclassified Daytona operation errors trigger a control-plane probe. If the sandbox is deleted/destroying, or was stopped while idle, the operation raises `DaytonaSandboxTerminalError` instead of asking the model to retry. An inconclusive probe keeps the original retryable error; known missing-file/session-ended errors remain retryable and authentication errors remain terminal. Reattach to resume an idle-stopped sandbox.

**Injected session** — share one sandbox across several runs while controlling its lifetime yourself:

```python
from pydantic_ai_daytona import DaytonaSandbox, DaytonaSandboxSession

async def main():
    async with DaytonaSandboxSession(snapshot='my-snapshot') as session:
        agent = Agent('anthropic:claude-sonnet-4-6', capabilities=[DaytonaSandbox(session=session)])
        await agent.run('Create /workspace/app.py with a hello-world FastAPI app.')
        await agent.run('Now add a /health endpoint to the app you created.')
```

## Configuration reference

| Parameter | Default | Description |
|---|---|---|
| `snapshot` | `None` | Snapshot for owned sandboxes (`None` = Daytona default). |
| `image` | `None` | Registry image for owned sandboxes (mutually exclusive with `snapshot`). |
| `sandbox_id` | `None` | Attach to an existing sandbox instead of creating one. |
| `session` | `None` | An entered `DaytonaSandboxSession` you own. |
| `env` | `None` | Variables applied to every command (owned or attached), also at creation when owned. For injected sessions, configure the session's own `env`. |
| `workdir` | `None` | Working directory for commands and relative file paths. |
| `labels` | `None` | Labels attached to owned sandboxes (cost attribution, filtering). |
| `os_user` | `None` | OS user commands run as in owned sandboxes. |
| `ephemeral` | `None` | Delete an owned sandbox as soon as it stops. |
| `network_block_all` | `None` | Block all outbound network access from owned sandboxes. |
| `network_allow_list` | `None` | Comma-separated CIDRs owned sandboxes may reach. |
| `domain_allow_list` | `None` | Comma-separated domains owned sandboxes may reach. |
| `auto_stop_interval` | `None` | Minutes of inactivity before Daytona stops an owned sandbox. |
| `auto_delete_interval` | `None` | Minutes after stopping before Daytona deletes an owned sandbox (`0` = immediately, `-1` = never). |
| `api_key` | `None` | Daytona API key (falls back to `DAYTONA_API_KEY`). |
| `api_url` | `None` | Daytona API URL (falls back to `DAYTONA_API_URL`). |
| `target` | `None` | Daytona target region (falls back to `DAYTONA_TARGET`). |
| `default_command_timeout` | `60.0` | Seconds a command may run when the model omits `timeout_seconds`. |
| `max_command_timeout` | `300` | Hard ceiling in seconds for any single command. |
| `max_output_bytes` | `51200` | Byte cap per command stream (cut before transfer, even on timeout) or file read. Labels/truncation markers are additional. |
| `max_output_lines` | `2000` | Line cap per command output or file read. |
| `max_read_bytes` | `5242880` | Largest file `read_file` will read whole. |
| `instructions` | `None` | Override the system-prompt instructions (`''` disables them). |

## Development

```bash
pip install -e ".[dev]"
pytest                          # unit tests (offline)
pytest tests/integration_tests  # live tests (needs DAYTONA_API_KEY)
ruff check .
mypy pydantic_ai_daytona
```

## License

[Apache-2.0](LICENSE)
