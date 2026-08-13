# Daytona Workspace Plugin for OpenCode

OpenCode plugin that provisions Daytona sandboxes as remote workspaces.

> **Not published to npm.** This plugin is installed from a local checkout — see [Installation](#installation). If you want the published, npm-installable Daytona plugin instead, see [`packages/opencode-plugin`](../../packages/opencode-plugin) ([`@daytona/opencode`](https://www.npmjs.com/package/@daytona/opencode)) and the comparison in [Relationship to `@daytona/opencode`](#relationship-to-daytonaopencode).

## Features

- Create Daytona sandboxes as remote OpenCode workspaces
- Automatic repository upload to sandbox
- Preview URLs for web servers running in sandboxes
- Sandbox cleanup when workspaces are removed

## Requirements

- OpenCode 1.14.x or later
- Daytona account and API key
- `OPENCODE_EXPERIMENTAL_WORKSPACES=true` environment flag

## Usage

### Installation

Clone this repository, then point OpenCode at the plugin source by absolute path.

```bash
git clone https://github.com/daytona/integrations
cd integrations/apps/opencode-workspaces-plugin
npm ci
pwd   # note this path; it is used below
```

Add a `file://` plugin spec to your project's `.opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///ABSOLUTE/PATH/TO/integrations/apps/opencode-workspaces-plugin/.opencode/plugin/index.ts"],
}
```

To install for every project, edit `~/.config/opencode/opencode.jsonc` instead.

Alternatively, symlink the whole `.opencode` directory into your project — see [Local Development](#local-development). Either way OpenCode loads the TypeScript source directly, so no build step is required.

### Environment Configuration

This plugin requires a [Daytona account](https://www.daytona.io/) and [Daytona API key](https://app.daytona.io/dashboard/keys).

Set your Daytona API key as an environment variable:

```bash
export DAYTONA_API_KEY="your-api-key"
```

Or create a `.env` file in your project root:

```env
DAYTONA_API_KEY=your-api-key
```

### Running OpenCode

Start OpenCode with the experimental workspaces flag:

```bash
OPENCODE_EXPERIMENTAL_WORKSPACES=true opencode
```

### Creating a Daytona Workspace

1. Type `/warp` in the prompt
2. Select "Daytona" as the workspace type
3. The plugin will create a sandbox, upload your repository, and start the OpenCode server

Once created, all commands run inside the remote sandbox.

### Limitations

The workspace is a snapshot of your repo, not a live mirror:

- **Only the last commit is uploaded.** The plugin clones your repo at `--depth 1`, so uncommitted or unstaged changes don't travel to the sandbox — commit before `/warp`.
- **A repo's own OpenCode config is not carried over.** Any committed `.opencode/` is excluded from the upload and `opencode.json` is overwritten with the plugin's own config, so per-repo OpenCode settings don't apply remotely (yet).
- **Provider credentials are forwarded to the sandbox.** Model keys are passed in as sandbox environment variables (so the remote can call models) and are therefore visible in the Daytona dashboard.

### Removing a Workspace

When you delete a Daytona workspace from OpenCode, the associated sandbox is automatically cleaned up.

## Troubleshooting

### Source parse

Verify the plugin source parses and ESM-links through bun's CLI:

```bash
cd apps/opencode-workspaces-plugin
bun -e 'import("./.opencode/plugin/index.ts").catch(e => { console.error(e); process.exit(1) })'
```

Bun's CLI honors the project's `tsconfig.json` while OpenCode's embedded runtime does not, so a pass here is necessary but not sufficient.

### Adapter registration

Confirm OpenCode itself registers the Daytona adapter:

```bash
cd /tmp/myproject
OPENCODE_EXPERIMENTAL_WORKSPACES=true DAYTONA_API_KEY=x opencode serve --port 4096 >/dev/null 2>&1 &
sleep 4
curl -s http://127.0.0.1:4096/experimental/workspace/adapter | grep -q daytona && echo OK || echo FAIL
kill %1 2>/dev/null
```

Starts a headless OpenCode server, queries `/experimental/workspace/adapter`, and prints `OK` if the `daytona` type appears in the response.

### Plugin log

The plugin logs workspace lifecycle events to a fixed file (stdout is kept clean for the UI):

```bash
tail -f /tmp/daytona-plugin.log
```

### Latest log

Grep the most recent OpenCode log for plugin-loading errors:

```bash
ls -t ~/.local/share/opencode/log/*.log | head -1 | xargs grep -E "ERROR|daytona|opencode/plugin/index"
```

## Development

### Running Tests

Three suites test the plugin at increasing depth: an in-process registration/cleanup check, an API-level workspace create/delete, and a full terminal-UI round-trip.

Before running, install the following prerequisites:

- `bun` on your PATH (the test runner).
- `npm ci` — installs everything else, including the `opencode` binary (from the `opencode-ai` devDependency); resolved from `node_modules`, no global install needed.
- `DAYTONA_API_KEY` — required by the sandbox tests.
- `tmux` — required only by the e2e TUI test.

Missing `DAYTONA_API_KEY`/`tmux` causes **skips, not failures** — read the skip count rather than trusting a green run.

Then run the tests:

| Command | Covers |
|---|---|
| `npm test` | Runs all three files. |
| `npm test -- test/plugin.test.ts` | Checks the plugin registers with OpenCode, and that a workspace whose creation fails partway deletes its sandbox instead of leaving it running (and billing). |
| `npm test -- test/integration.test.ts` | Creates a workspace through the OpenCode API, confirms the sandbox exists, then deletes it. |
| `npm test -- test/e2e-tui.test.ts` | Drives the real OpenCode terminal UI end to end: runs `/warp`, creates a Daytona workspace, and sends a chat message to confirm the sandbox replies. |

### Local Development

To test the plugin locally, create a symlink in your test project:

```bash
mkdir /tmp/myproject && cd /tmp/myproject
ln -s [ABSOLUTE_PATH_TO_INTEGRATIONS]/apps/opencode-workspaces-plugin/.opencode .opencode
git init
OPENCODE_EXPERIMENTAL_WORKSPACES=true opencode
```

### Running against a local OpenCode build

To test against a from-source OpenCode checkout (e.g. `~/opencode`) instead of the installed binary, run its `dev` script with the test project (`/tmp/myproject` from above) as a trailing argument:

```bash
cd ~/opencode
OPENCODE_EXPERIMENTAL_WORKSPACES=true bun dev /tmp/myproject
```

### Type-checking

OpenCode loads the `.ts` directly, so there's no build to run. Run the typecheck after changes — it catches drift in `@opencode-ai/plugin`'s experimental workspace-adapter API:

```bash
npm run typecheck
```

## Relationship to `@daytona/opencode`

This plugin and [`packages/opencode-plugin`](../../packages/opencode-plugin) both run OpenCode against Daytona sandboxes, but they take opposite approaches:

| | This plugin | `@daytona/opencode` |
|---|---|---|
| Mechanism | Registers a **workspace adapter**; the sandbox runs its own `opencode serve` and tool calls are proxied to it | Reimplements each **tool** (bash, edit, grep, …) to execute against the sandbox |
| Activation | Opt-in per workspace via `/warp` | Every session |
| Requires | `OPENCODE_EXPERIMENTAL_WORKSPACES=true` | — |
| Distribution | This repo, `file://` spec | npm |

Features present in `@daytona/opencode` that this plugin deliberately does **not** carry over:

- Bidirectional git sync between local and sandbox
- Auto-commit on session idle
- Custom tool implementations (bash, edit, grep, etc.)

The sandbox runs a real OpenCode server, so tools work there natively rather than being reimplemented.

## Project Structure

```
apps/opencode-workspaces-plugin/
├── .opencode/
│   └── plugin/
│       ├── daytona/
│       │   ├── index.ts
│       │   └── instructions.ts
│       └── index.ts
├── test/
│   ├── e2e-tui.test.ts
│   ├── integration.test.ts
│   └── plugin.test.ts
├── package.json
├── tsconfig.json
└── README.md
```

## License

Apache-2.0
