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

## Sandbox lifecycle

**Owned (default)** — each run creates a sandbox and deletes it when the run ends:

```python
DaytonaSandbox(snapshot='my-snapshot')          # or image='python:3.12-slim'
```

For fully untrusted code, block outbound network access at creation. Independently, `ephemeral=True` hardens cleanup: Daytona deletes the sandbox the moment it stops, even if your process crashed before its own cleanup ran.

```python
DaytonaSandbox(network_block_all=True, ephemeral=True, labels={'app': 'support-agent'})
```

**Attached** — reuse a sandbox you manage elsewhere; it is started if stopped and never deleted:

```python
DaytonaSandbox(sandbox_id='my-sandbox-id')
```

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
| `env` | `None` | Environment variables for owned sandboxes. |
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
| `max_output_bytes` | `51200` | Byte cap per command output or file read. |
| `max_output_lines` | `2000` | Line cap per command output or file read. |
| `max_read_bytes` | `5242880` | Largest file `read_file` will read whole. |
| `instructions` | `None` | Override the system-prompt instructions (`''` disables them). |

## Development

```bash
pip install -e ".[dev]"
pytest                          # unit tests (offline)
pytest tests/integration_tests  # live tests (needs DAYTONA_API_KEY)
ruff check .
```

## License

[Apache-2.0](LICENSE)
