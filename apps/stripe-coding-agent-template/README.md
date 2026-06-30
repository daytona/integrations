# Daytona Coding Agent — CopilotKit + OpenRouter + Vercel

A generative-UI coding agent that **writes and runs code in a [Daytona](https://www.daytona.io/) sandbox**, live-previewed right inside the chat. An LLM (via [OpenRouter](https://openrouter.ai/)) drives a [CopilotKit](https://docs.copilotkit.ai/) Built-in Agent with shell + filesystem tools; every tool call streams in as generative UI — terminal cards, syntax-highlighted file edits, directory/grep results, and a live `<iframe>` preview of any dev server the agent starts.

This is a **[Stripe Projects](https://docs.stripe.com/projects) build template**. It wires up three Stripe Projects services:

| Role | Service | What it does |
|---|---|---|
| Code execution | `daytona/sandbox` | Ephemeral cloud sandbox the agent builds in |
| LLM brain | `openrouter/api` | One key → 400+ models (default: `anthropic/claude-sonnet-4.5`) |
| Hosting | `vercel/project` | Next.js-native deploy |

## Quick start (Stripe Projects)

```bash
# 1. Scaffold this template
stripe projects build          # → choose "Daytona Coding Agent"

# 2. Provision the services (a Daytona plan is required before a sandbox)
stripe projects add daytona/top-up-0025
stripe projects add daytona/sandbox
stripe projects add openrouter/api

# 3. Pull the credentials into .env.local
stripe projects env --pull

# 4. Install + run
npm install
npm run dev
```

`stripe projects build` runs steps 1–4 for you (it provisions the listed
services, pulls env, installs, and prints next steps); the commands above are
the manual equivalent.

Open <http://localhost:3000> and ask for something:

> Build the classic Snake game in Vite + React with HTML canvas — arrow keys, score, game-over on collision, restart button. Dark-green board, bright-green snake.

The agent creates a sandbox, scaffolds the project, installs deps, starts the dev server, and surfaces the preview as an iframe in the chat. Follow-up edits like “make it red-themed” hot-reload the iframe in place.

## Manual setup (no Stripe Projects)

Copy `.env.example` to `.env` and fill in two keys:

```bash
cp .env.example .env
```

```bash
DAYTONA_API_KEY=...      # https://app.daytona.io/dashboard/keys
OPENROUTER_API_KEY=...   # https://openrouter.ai/keys
```

```bash
npm install
npm run dev
```

## How credentials are wired

The SDKs and the Stripe Projects providers use different variable names, so the app **bridges them for you** in `app/api/copilotkit/route.ts` — no manual `export` step needed.

| SDK expects | Stripe Projects exports (`env --pull`) | Bridged in code |
|---|---|---|
| `DAYTONA_API_KEY` | `DAYTONA_SANDBOX_API_KEY` | ✅ |
| `DAYTONA_API_URL` | `DAYTONA_SANDBOX_API_URL` (public: `https://app.daytona.io/api`) | ✅ |
| `DAYTONA_ORGANIZATION_ID` | `DAYTONA_SANDBOX_ORGANIZATION_ID` | ✅ |
| `OPENROUTER_API_KEY` | `OPENROUTER_*_API_KEY` (service-prefixed) | ✅ (auto-discovered) |

The route reads `DAYTONA_API_KEY ?? DAYTONA_SANDBOX_API_KEY` (etc.), and discovers any `OPENROUTER_*_API_KEY` if the canonical `OPENROUTER_API_KEY` isn't set.

## The OpenRouter wiring (important)

CopilotKit's `BuiltInAgent` accepts either a `"provider:model"` string or a ready-made AI SDK model instance. We pass an **explicit instance** so the request goes to OpenRouter's OpenAI-compatible **Chat Completions** endpoint:

```ts
import { createOpenAI } from '@ai-sdk/openai'

const openrouter = createOpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
})

new BuiltInAgent({
  model: openrouter.chat(process.env.OPENROUTER_MODEL ?? 'anthropic/claude-sonnet-4.5'),
  // ...
})
```

> ⚠️ Use `.chat(model)`, **not** the default `openrouter(model)`. In `@ai-sdk/openai` v3 the default callable targets the OpenAI **Responses API** (`POST /responses`), which OpenRouter does not implement. `.chat()` targets `POST /chat/completions`, which it does. Likewise the built-in `model: 'openai:...'` string path resolves to the Responses API and will not work against OpenRouter.

Pick any model from <https://openrouter.ai/models> via the `OPENROUTER_MODEL` env var.

## Deploy to Vercel

The agent loop runs server-side inside the `/api/copilotkit` request, so the route sets:

```ts
export const runtime = 'nodejs'   // Daytona SDK needs Node, not Edge
export const maxDuration = 300    // 300s works on Hobby & Pro (Fluid Compute, default)
```

`vercel.json` mirrors `maxDuration` for the function. Then:

```bash
stripe projects add vercel/project
stripe projects env --pull        # populates VERCEL_TOKEN / VERCEL_PROJECT_ID / VERCEL_ORG_ID …
npm run deploy                    # scripts/deploy-vercel.mjs
```

`npm run deploy` (`scripts/deploy-vercel.mjs`) uploads the app and creates a production deployment via the Vercel API using the pulled credentials — no `vercel login`/`link` needed — and syncs your non-Vercel env vars (Daytona, OpenRouter) to the project. With [Fluid Compute](https://vercel.com/docs/fluid-compute) (on by default) the function can run up to **300s on both Hobby and Pro**; Pro/Enterprise can extend to 800s (1800s in beta). For unbounded runtimes, use [Vercel Workflows](https://vercel.com/docs/workflows) or a persistent-server host (Railway / Render / Fly.io).

## Customize it

`stripe projects build` prints "Customize with Codex / Claude" next steps that point an AI coding agent at [`prompts/starter-to-product.md`](prompts/starter-to-product.md); [`AGENTS.md`](AGENTS.md) lists what to change first (system prompt, model, tools, branding) and the wiring to keep intact.

## Tool surface

The backend exposes 11 tools to the agent, all defined with `defineTool` from `@copilotkit/runtime/v2`:

| Tool | What it does | Daytona SDK call |
|---|---|---|
| `createSandbox({envVars?, labels?, autoStopInterval?})` | Create an ephemeral sandbox (auto-deletes on stop) | `daytona.create({ public: true, ephemeral: true, ... })` |
| `runCommand({sandboxId, command, background?})` | Run a shell command; `background:true` for watchers/log tails | `process.executeCommand` / `executeSessionCommand({runAsync:true})` |
| `writeFile({sandboxId, path, content})` | Overwrite a file with full new content | `fs.uploadFile` |
| `readFile({sandboxId, path})` | Read a file's text | `fs.downloadFile` |
| `listFiles({sandboxId, path})` | Directory listing with metadata | `fs.listFiles` |
| `findFiles({sandboxId, path, pattern})` | Grep file CONTENTS | `fs.findFiles` |
| `searchFiles({sandboxId, path, pattern})` | Glob file NAMES | `fs.searchFiles` |
| `replaceInFiles({sandboxId, files, pattern, newValue})` | Codemod-style find/replace across files | `fs.replaceInFiles` |
| `getFileDetails({sandboxId, path})` | File metadata | `fs.getFileDetails` |
| `startWebServer({sandboxId, command, port})` | Start a dev server AND return its preview URL atomically (polls logs up to 90s) | `createSession` + `executeSessionCommand` + `getSessionCommandLogs` + `getPreviewLink` |
| `getPreviewUrl({sandboxId, port})` | Public preview URL for an open port | `getPreviewLink` |

On the React side, `app/page.tsx` registers one `useRenderTool` per tool; each renders streaming `{ status, parameters, result }` as a card. The `PreviewCard` iframe stays mounted across turns so dev-server HMR reloads it in place when the agent edits files.

## Prerequisites

- **Node.js 20.18+** (or 22.9+) — for `node --env-file` support used by `npm test`
- A **Daytona** key (or `daytona/sandbox` via Stripe Projects) — note a Daytona plan must be active before a sandbox can be provisioned
- An **OpenRouter** key (or `openrouter/api` via Stripe Projects). The default model needs the `pay_as_you_go` plan; on the `free` plan, set `OPENROUTER_MODEL` to a free model

## Stack

`@copilotkit/react-core` + `@copilotkit/runtime` (v2 `BuiltInAgent` / `defineTool`) · `@daytona/sdk` · `@ai-sdk/openai` · Next.js (App Router) · React · `zod`.

## References

- [Daytona](https://www.daytona.io/)
- [CopilotKit](https://docs.copilotkit.ai/)
- [OpenRouter](https://openrouter.ai/docs) · [Models](https://openrouter.ai/models)
- [Vercel](https://vercel.com/docs) · [Function max duration](https://vercel.com/docs/functions/configuring-functions/duration)
