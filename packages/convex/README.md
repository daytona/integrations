# Daytona Component for Convex

[![npm version](https://img.shields.io/npm/v/@daytona/convex)](https://www.npmjs.com/package/@daytona/convex)

<!-- START: Include on https://convex.dev/components -->

Run [Daytona](https://www.daytona.io) sandboxes from your Convex backend: create isolated sandboxes, execute shell commands and code, read/write files, and get live preview URLs — with sandbox and execution state tracked in reactive Convex tables your UI can subscribe to.

```ts
// convex/agent.ts
import { Daytona } from "@daytona/convex";
import { v } from "convex/values";
import { components } from "./_generated/api";
import { action } from "./_generated/server";

const daytona = new Daytona(components.daytona);

export const codeInterpreter = action({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    const { sandboxId } = await daytona.createSandbox(ctx, {
      autoStopInterval: 15,
    });
    const { result, exitCode } = await daytona.runCode(ctx, {
      sandboxId,
      code: args.code,
      language: "python",
    });
    return { result, exitCode };
  },
});
```

Why a component instead of calling the Daytona API directly?

- **Reactive state** — every sandbox and execution is recorded in component tables. Drive agent UIs ("running…", exit codes, output history) from live Convex queries instead of polling.
- **Isolated bookkeeping** — the component keeps its tables in its own namespace; it can't touch your app's data, and your app manages it through one typed client.
- **No SDK bundle** — the component talks to the Daytona REST API with plain `fetch` in Convex's default runtime: no `"use node"`, no heavy dependencies, fast cold starts.

## Installation

```bash
npm install @daytona/convex
```

Set your Daytona API key on your deployment (create one at [app.daytona.io/dashboard/keys](https://app.daytona.io/dashboard/keys)):

```bash
npx convex env set DAYTONA_API_KEY dtn_...
```

Then create or update `convex/convex.config.ts` in your app. Components can't read your app's env vars, so pass the key down to the component:

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import { v } from "convex/values";
import daytona from "@daytona/convex/convex.config.js";

const app = defineApp({
  env: { DAYTONA_API_KEY: v.string() },
});
app.use(daytona, {
  env: { DAYTONA_API_KEY: app.env.DAYTONA_API_KEY },
});

export default app;
```

Passing it by reference means the component always sees the current value, so rotating the key doesn't need a redeploy.

Optional: `DAYTONA_API_URL` (self-hosted instances; defaults to `https://app.daytona.io/api`). Set it the same way. It isn't a secret, so it doesn't need passing down: the client forwards it with each call.

## Usage

Instantiate the client with the installed component. Credentials resolve from your deployment's environment variables, or pass them explicitly:

```ts
import { Daytona } from "@daytona/convex";
import { components } from "./_generated/api";

const daytona = new Daytona(components.daytona);
// or: new Daytona(components.daytona, { apiKey: "dtn_..." })
```

`runBackground` is the exception: it always uses the key passed down to the component in `convex.config.ts`.

### Sandbox lifecycle

```ts
export const create = action({
  args: {},
  handler: async (ctx) => {
    return await daytona.createSandbox(ctx, {
      snapshot: "my-snapshot",     // optional — org default when omitted
      autoStopInterval: 15,        // pause after 15 idle minutes (fs preserved)
      autoDeleteInterval: -1,      // never auto-delete
      userKey: "user_123",         // scope sandboxes to a user/agent (see below)
    });
    // → { sandboxId: "…", state: "started" }
  },
});
```

Sandboxes are created from a **snapshot** (yours, or the org default) *or* built from a Docker **image** — pass one or the other. `cpu`/`memory`/`disk` only apply to image-based creation; snapshots define their own resources:

```ts
await daytona.createSandbox(ctx, { image: "python:3.12", cpu: 2, memory: 4 });
```

Also available: `startSandbox`, `stopSandbox`, `deleteSandbox`, and `refreshSandbox` (re-syncs remote state into the component's tables; returns `null` if the sandbox no longer exists).

### Run commands and code

```ts
const { executionId, exitCode, result } = await daytona.run(ctx, {
  sandboxId,
  command: "python train.py",
  cwd: "/home/daytona/project",
  timeoutSeconds: 300,
});

const py = await daytona.runCode(ctx, {
  sandboxId,
  code: "print(sum(range(10)))",
  language: "python",
});
```

A stopped or archived sandbox is transparently restarted first (disable with `autoStart: false`). Every call records an execution row (`running` → `completed`/`failed`) with truncated output, so history and status are queryable.

For long-running commands, `runBackground` starts the command in a sandbox session and returns immediately — the launch action isn't held open for the command's duration (a lightweight scheduler-driven poller checks in periodically instead), and the command isn't bound to the 10-minute action ceiling:

```ts
const { executionId } = await daytona.runBackground(ctx, {
  sandboxId,
  command: "python train.py",
  cwd: "/home/daytona/project",
});
// Watch it reactively: a scheduler-driven poller streams logs into the row
// while it runs and records the exit code when it finishes.
export const training = query({
  // Component table IDs cross the boundary as plain strings.
  args: { executionId: v.string() },
  handler: async (ctx, args) => daytona.getExecution(ctx, args),
});
```

To let your backend react when the command finishes (instead of polling the row), pass an `onComplete` mutation — the component invokes it on every terminal state (`completed`, `failed`, or `cancelled`) with the outcome and an optional `context` you supply:

```ts
const { executionId } = await daytona.runBackground(ctx, {
  sandboxId,
  command: "cargo build",
  onComplete: internal.build.buildFinished, // (ctx, { executionId, status, exitCode, result, error, context })
  onCompleteContext: { appId },
  minPollMs: 500,   // first poll + backoff floor (default 1000, min 250)
  maxPollMs: 5000,  // backoff ceiling (default 10000, max 120000)
});
```

Cancel a running background execution with `daytona.cancelExecution(ctx, { executionId })` — it stops the command (kills its session), marks the row `cancelled`, and fires the `onComplete` handler.

A running background command does not reset the sandbox's [idle auto-stop timer](https://www.daytona.io/docs/sandboxes#what-resets-the-timer) — create sandboxes for long jobs with `autoStopInterval: 0`.

`runBackground` needs the key passed down as shown in [Installation](#installation). Its poller runs from the scheduler, outside any of your calls, so it reads `DAYTONA_API_KEY` from the component's env on every poll instead of carrying it in scheduled function args.

### Reactive state

These read the component's tables — no Daytona API call, and they update live:

```ts
export const sandboxes = query({
  args: {},
  handler: async (ctx) => daytona.listSandboxes(ctx, { userKey: "user_123" }),
});

export const executions = query({
  args: { sandboxId: v.string() },
  handler: async (ctx, args) => daytona.listExecutions(ctx, args),
});
```

Also: `getSandbox`, `getExecution`.

### Files

```ts
await daytona.writeFile(ctx, { sandboxId, path: "/home/daytona/app.py", content });
const text = await daytona.readFile(ctx, { sandboxId, path: "/home/daytona/app.py" });
const entries = await daytona.listFiles(ctx, { sandboxId, path: "/home/daytona" });
await daytona.deleteFile(ctx, { sandboxId, path: "/home/daytona/tmp", recursive: true });
```

`readFile`/`writeFile` move content as UTF-8 strings — the right default for code, configs, and logs. For binary files (images, PDFs, archives), use the byte variants, which pass raw `ArrayBuffer`s through untouched:

```ts
const png = await daytona.readFileBytes(ctx, { sandboxId, path: "/home/daytona/chart.png" });
await ctx.storage.store(new Blob([png], { type: "image/png" })); // e.g. into Convex file storage

await daytona.writeFileBytes(ctx, { sandboxId, path: "/home/daytona/data.zip", content: zipBuffer });
```

Either way, file content crosses the Convex function boundary, so keep individual files under Convex's 16 MiB argument/return limits.

### Preview URLs

```ts
const { url } = await daytona.getPreviewUrl(ctx, { sandboxId, port: 3000 });
```

Signed URLs (default) embed a short-lived token; pass `signed: false` for a standard URL + token pair.

### Authorization

Components can't see your app's `ctx.auth` — authenticate callers in your own functions and scope sandboxes with `userKey`:

```ts
export const mySandboxes = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthorized");
    return await daytona.listSandboxes(ctx, { userKey: identity.subject });
  },
});
```

### Keeping sandbox state in sync (webhooks)

Sandbox records reflect what the component last observed. When Daytona changes a sandbox on its own (auto-stop, auto-archive, auto-delete), the record lags until you call `refreshSandbox`. To keep the `sandboxes` table in sync in real time, connect a Daytona webhook. It's opt-in, and it takes three steps:

**1. Mount the component's webhook route and pass the secret down** in `convex/convex.config.ts`:

```ts
const app = defineApp({
  env: {
    DAYTONA_API_KEY: v.string(),
    DAYTONA_WEBHOOK_SECRET: v.optional(v.string()),
  },
});
app.use(daytona, {
  httpPrefix: "/daytona/",
  env: {
    DAYTONA_API_KEY: app.env.DAYTONA_API_KEY,
    DAYTONA_WEBHOOK_SECRET: app.env.DAYTONA_WEBHOOK_SECRET,
  },
});
```

**2. Create a webhook endpoint in the Daytona Dashboard** ([how to create an endpoint](https://www.daytona.io/docs/en/webhooks#create-webhook-endpoints)):

- **Endpoint URL**: `https://<your-deployment>.convex.site/daytona/webhook` (your deployment's HTTP actions URL, plus the prefix above)
- **Events**: subscribe to `sandbox.state.updated`. The component ignores every other event, so subscribing to anything else only creates extra deliveries.

Create the endpoint in the **same Daytona organization as your `DAYTONA_API_KEY`**: webhooks are per organization, so an endpoint in another org never receives your sandboxes' events.

**3. Copy the endpoint's signing secret into your deployment.** Daytona generates a signing secret (starting with `whsec_`) for each endpoint you create and signs every delivery with it. In the Daytona Dashboard's **Webhooks** page, click your endpoint in the endpoints table; its details show the signing secret, ready to copy. Set it on your Convex deployment:

```bash
npx convex env set DAYTONA_WEBHOOK_SECRET whsec_...
```

From then on, every state change Daytona makes shows up in `getSandbox`/`listSandboxes` as it happens. For example, `listSandboxes(ctx, { state: "started" })` becomes an accurate live count. Every delivery's signature is verified (deliveries older than 5 minutes are rejected as possible replays). Duplicate and out-of-order deliveries are handled automatically. Events for sandboxes this deployment doesn't track are acknowledged and ignored, since an endpoint receives every sandbox in your organization. If the secret isn't set, the route refuses all deliveries.

### Limits & long-running work

- Convex actions time out after 10 minutes, so synchronous `run`/`runCode` commands are always bounded below that ceiling: `timeoutSeconds` defaults to 540 and is capped at 570. For longer jobs, use `runBackground` — it has no duration bound and holds no action open.
- Sandbox and execution rows are kept as audit history. They never clean themselves up — prune them in batches with `daytona.purgeSandboxes(ctx, { olderThanMs })` and `daytona.purgeExecutions(ctx, { olderThanMs })` (each call returns `hasMore`; terminal rows only, remote sandboxes untouched). `listSandboxes` accepts a `state` filter (e.g. `"started"` for a live count) and `listSandboxesPaginated` provides cursor pagination.
- Stored execution output is truncated (64 KB); the action's return value carries up to 4 MB.
- Sandboxes cost money while running: set `autoStopInterval`, and delete sandboxes you're done with. `refreshSandbox` reconciles a record on demand; [webhooks](#keeping-sandbox-state-in-sync-webhooks) keep all records in sync automatically.

See [example/convex/example.ts](./example/convex/example.ts) for a complete example app.

Found a bug? Feature request? [File it here](https://github.com/daytona/integrations/issues).

<!-- END: Include on https://convex.dev/components -->

## Development

This package lives in the [`daytona/integrations`](https://github.com/daytona/integrations) monorepo under `packages/convex` and is self-contained (own `package.json`, lockfile, no workspace tooling).

```bash
git clone https://github.com/daytona/integrations
cd integrations/packages/convex
npm install
```

The component's `src/component/_generated` code is committed; regenerate it after changing component functions:

```bash
npx convex init           # one-time: bootstrap a local anonymous deployment
npm run codegen           # component codegen (src/component/_generated)
npx convex codegen        # example app codegen (example/convex/_generated)
```

Checks:

```bash
npm run build             # compile to dist/
npm run typecheck         # package sources
npm run typecheck:example # example app (needs codegen above)
npm test                  # offline unit tests (mocked Daytona API)
npm run test:live         # live E2E: local Convex deployment + real Daytona (needs DAYTONA_API_KEY)
```

`npm run dev` starts a Convex dev deployment serving the example app — set `DAYTONA_API_KEY` on it to exercise the component against real sandboxes.

### Publishing

Releases are automated with [release-please](https://github.com/googleapis/release-please): merging this package's Release PR tags it and publishes to npm (public, with provenance) from the repo's release workflow.

## License

Apache-2.0
