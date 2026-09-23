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

Create or update `convex/convex.config.ts` in your app:

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import daytona from "@daytona/convex/convex.config.js";

const app = defineApp();
app.use(daytona);

export default app;
```

Set your Daytona API key on your deployment (create one at [app.daytona.io/dashboard/keys](https://app.daytona.io/dashboard/keys)):

```bash
npx convex env set DAYTONA_API_KEY dtn_...
```

Optional: `DAYTONA_API_URL` (self-hosted instances; defaults to `https://app.daytona.io/api`).

## Usage

Instantiate the client with the installed component. Credentials resolve from your deployment's environment variables, or pass them explicitly:

```ts
import { Daytona } from "@daytona/convex";
import { components } from "./_generated/api";

const daytona = new Daytona(components.daytona);
// or: new Daytona(components.daytona, { apiKey: "dtn_..." })
```

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

File content crosses the function boundary as UTF-8 strings; keep individual files under Convex's 16 MiB argument/return limits.

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

### Limits & long-running work

- Convex actions time out after 10 minutes, so commands are always bounded below that ceiling: `timeoutSeconds` defaults to 540 and is capped at 570. For longer jobs, start a background process in the sandbox (`nohup … &`) and poll with follow-up `run` calls.
- Stored execution output is truncated (64 KB); the action's return value carries up to 4 MB.
- Sandboxes cost money while running: set `autoStopInterval`, and delete sandboxes you're done with. `refreshSandbox` reconciles records whose remote sandbox was removed out-of-band.

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
