# @daytona/n8n-nodes-daytona

The official [Daytona](https://www.daytona.io) community node for [n8n](https://n8n.io).

## Overview

[Daytona](https://www.daytona.io) provides secure, elastic sandbox infrastructure for AI agents. Each sandbox is a complete, isolated environment that is fully programmable, spun up on demand, and built for autonomous use without human intervention.

Using n8n, you can integrate Daytona into any automated workflow: create sandboxes from snapshots or custom Docker images, manage the full sandbox lifecycle, execute code and shell commands, expose running services via preview URLs, drive a complete Git pipeline (clone, status, add, commit, push, pull, checkout), and manage the sandbox filesystem (upload, download, list, move, delete, folder creation) — all as composable steps alongside thousands of other n8n nodes.

## Contents

- [@daytona/n8n-nodes-daytona](#daytonan8n-nodes-daytona)
  - [Overview](#overview)
  - [Contents](#contents)
  - [Installation](#installation)
  - [Credentials](#credentials)
  - [Operations](#operations)
    - [Operation behavior notes](#operation-behavior-notes)
    - [AI Agent integration](#ai-agent-integration)
  - [Examples](#examples)
  - [Compatibility](#compatibility)
  - [Development](#development)
    - [Tests](#tests)
    - [Lint + build](#lint--build)
  - [Resources](#resources)
  - [License](#license)

## Installation

Once published, install from inside n8n:

1. Go to **Settings → Community Nodes**.
2. Click **Install a community node**.
3. Enter `@daytona/n8n-nodes-daytona` and click **Install**.
4. The Daytona node appears in the node search panel after refresh.

For local development against an unpublished version, see [Development](#development).

## Credentials

Create an API key at [app.daytona.io/dashboard/keys](https://app.daytona.io/dashboard/keys), then add a **Daytona API** credential in n8n.

| Field | Required | Description |
|---|---|---|
| **API Key** | Yes | Bearer token from the Daytona dashboard. Stored encrypted by n8n. |
| **Base URL** | No (default `https://app.daytona.io/api`) | Override only when targeting a self-hosted Daytona instance. |
| **Organization ID** | No | Required when authenticating with a JWT token. Always safe to set with an API key — Daytona accepts the header on every request. Sent as `X-Daytona-Organization-ID`. |

The credential is verified against `GET /api-keys/current` when you save — n8n reports success or failure inline.

## Operations

| Resource | Operation | Description |
|---|---|---|
| **Sandbox** | Create | Create a sandbox. Set **Snapshot** (pre-built template ID/name) or **Image** (Docker image reference like `python:3.11`). Snapshot takes precedence if both are set; if neither is set, Daytona's organization default snapshot is used. Optional name, ephemeral flag, and advanced options (CPU/memory/disk, region, env vars, labels, network policy, auto-stop/archive/delete intervals). Optional poll-until-`started`. |
| | Get | Fetch a single sandbox by ID. |
| | Get Many | List sandboxes (paginated when **Return All** is checked). |
| | Delete | Permanently delete a sandbox. |
| | Start | Start a stopped sandbox. Optional poll-until-`started`. |
| | Stop | Stop a running sandbox. Optional poll-until-`stopped`. |
| | Get Preview URL | Generate a public URL for a port exposed inside a sandbox. **Signed** (default, browser-friendly, token in URL) or **Standard** (token returned separately, sent via `x-daytona-preview-token` header). |
| **Code** | Run Code | Execute Python, JavaScript, or TypeScript inside a sandbox. With **Use Ephemeral Sandbox** checked (default), creates a temporary sandbox just for this execution and auto-deletes afterward. |
| | Run Command | Execute a shell command inside a sandbox. Same ephemeral-or-existing modes as Run Code. Supports working directory and environment variables. |
| **File** | Upload | Upload an n8n binary field to a sandbox path. Multipart with content-type preservation. |
| | Download | Read a file from a sandbox path and emit it as binary output for downstream nodes. |
| | List | List entries in a directory. Returns structured metadata (name, isDir, size, mode, modTime, owner, group, permissions) plus a `count` summary. |
| | Create Folder | Create a directory with Unix-style octal permissions (e.g. `0755`). |
| | Move | Move or rename a file/directory. Atomic — handles both renames and cross-directory moves. |
| | Delete | Delete a file or directory. Set **Recursive** to remove non-empty folders. |
| **Git** | Clone | Clone a Git repository into a sandbox path. Supports branch, commit ID pinning, and HTTPS basic auth for private repositories. |
| | Status | Return working tree status: current branch, ahead/behind counts vs the tracked remote, and per-file staging/worktree changes. |
| | Add | Stage one or more files for the next commit. |
| | Commit | Commit staged changes with required author/email/message. Optional **Allow Empty Commit** for re-triggering CI when nothing changed. |
| | Push | Push local commits to the remote. Optional HTTPS basic auth for private remotes. |
| | Pull | Fetch and merge updates from the remote tracking branch. Optional HTTPS basic auth for private remotes. |
| | Checkout | Check out a branch (existing local or remote-tracking) or a specific commit SHA. |
| **Snapshot** | Create | Create a snapshot from a Docker image with optional resource specs (CPU/memory/disk) and entrypoint. |
| | Get | Fetch a single snapshot by ID or name. |
| | Get Many | List snapshots with optional name filter, sort (by `createdAt`, `lastUsedAt`, `name`, `state`), and order. |
| | Delete | Permanently delete a snapshot. |
| | Activate | Mark a snapshot as active so it becomes usable for sandbox creation. |
| | Deactivate | Mark a snapshot as inactive. |
| **Volume** | Create | Create a persistent volume that can be mounted into sandboxes. |
| | Get | Fetch a single volume by ID or name. |
| | Get Many | List volumes; optionally include soft-deleted ones. |
| | Delete | Delete a volume. |

### Operation behavior notes

- **Run Code / Run Command output:** `result` contains stdout and stderr combined. `artifacts` carries any extra metadata Daytona returns (e.g. matplotlib `charts` for Python). Branch on `$json.exitCode` for success/failure — non-zero exit codes are returned as data, not thrown as errors.
- **Ephemeral mode** creates a sandbox with `autoDeleteInterval: 0` so it auto-deletes as soon as it stops. Cleanup also runs in a `try/finally` so the sandbox is deleted even if the operation throws.
- **Preview URL Signed flavor** embeds the auth token directly in the URL — no need for downstream nodes to add headers. The Standard flavor returns `{ url, token }` separately for callers that prefer header-based auth.
- **Toolbox URL caching** — Daytona returns a per-sandbox `toolboxProxyUrl` from `GET /sandbox/{id}` that all toolbox operations (code/command/file/git) use to route requests. Within a single node execution this URL is fetched once per sandbox and reused for subsequent toolbox operations. The cache is invalidated on Start, Stop, and Delete so that subsequent calls re-fetch the URL and reflect any state change.

### Snapshot picker on Sandbox.Create

The **Snapshot** field on `Sandbox.Create` is a dropdown populated dynamically from your Daytona organization. Pick from the list, leave at *(Use Daytona Default)*, or switch to expression mode to pass a dynamic value.

### AI Agent integration

This node is marked `usableAsTool: true` and appears in n8n's AI Agent tool picker. Each operation's `description` and `action` strings are exposed to the agent's LLM as tool metadata.

## Examples

Three importable example workflows live in [`docs/examples/`](./docs/examples):

1. [**`run-python-ephemeral.json`**](./docs/examples/run-python-ephemeral.json) — AI agent runs ad-hoc Python in a one-shot ephemeral sandbox. The simplest possible code-execution workflow.
2. [**`clone-build-download.json`**](./docs/examples/clone-build-download.json) — Persistent sandbox: clone a Git repo, run a build command, download the build artifact back to n8n as binary. Good template for CI-style flows.
3. [**`web-app-with-preview.json`**](./docs/examples/web-app-with-preview.json) — Spin up a long-lived sandbox, upload a server script, run it on port 3000, return a signed preview URL. Demonstrates web-service exposure for sharing demos.

To use them: in n8n, click **Workflows → Import from File** and select the JSON. You'll need to configure the Daytona credential after import.

## Compatibility

- **n8n version:** 1.x and later. Tested against the latest stable n8n at the time of release.
- **Node.js:** 20.x and later (matches n8n's runtime requirements).
- **Daytona API:** v1 (current stable as of 2026-05). Self-hosted Daytona instances supported via the **Base URL** credential field.

## Development

```bash
git clone https://github.com/daytona/integrations.git
cd integrations/packages/n8n-nodes-daytona
npm install
npm run dev          # boots n8n on http://localhost:5678 with hot reload
```

The dev server symlinks the node into `~/.n8n-node-cli/.n8n/custom/`. First run downloads n8n and takes 1–2 minutes; subsequent runs are fast.

### Tests

```bash
DAYTONA_API_KEY=… npm test
```

Or set values in `.env.local` (gitignored). Set `DAYTONA_TEST_INCLUDE_EPHEMERAL=1` to also run ephemeral-mode tests (creates extra real sandboxes).

The integration suite covers the core operations across all six resources end-to-end against the real Daytona API in ~20–30 seconds.

### Lint + build

```bash
npm run lint
npm run build
```

The lint config is locked by `n8n.strict: true` for n8n Cloud compatibility — don't modify `eslint.config.mjs`.

## Resources

- [Daytona documentation](https://www.daytona.io/docs)
- [Daytona API reference](https://www.daytona.io/docs/en/tools/api)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
- [n8n verified community node submission](https://creators.n8n.io/nodes)
- [Source code](https://github.com/daytona/integrations/tree/main/packages/n8n-nodes-daytona)
- [Issues](https://github.com/daytona/integrations/issues)

## License

[MIT](./LICENSE) © Daytona Platforms Inc.
