import { Daytona } from "@daytona/convex";
import { v } from "convex/values";
import { components } from "./_generated/api.js";
import { action, query } from "./_generated/server.js";

// Reads DAYTONA_API_KEY (and optional DAYTONA_API_URL) from this deployment's
// environment variables: `npx convex env set DAYTONA_API_KEY ...`
const daytona = new Daytona(components.daytona);

// NOTE: in a real app, authenticate the caller (ctx.auth) in each of these
// functions and scope sandboxes with `userKey` — the component can't see your
// app's auth, so authorization belongs here in the host app.

/** Create a sandbox and wait until it's running. */
export const createSandbox = action({
  args: { snapshot: v.optional(v.string()) },
  handler: async (ctx, args) => {
    return await daytona.createSandbox(ctx, {
      snapshot: args.snapshot,
      labels: { "created-by": "convex-example" },
      // Pause after 15 idle minutes (filesystem preserved); never auto-delete.
      autoStopInterval: 15,
      autoDeleteInterval: -1,
    });
  },
});

/** Run a shell command inside a sandbox. */
export const runCommand = action({
  args: {
    sandboxId: v.string(),
    command: v.string(),
    cwd: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await daytona.run(ctx, args);
  },
});

/** Run a Python snippet inside a sandbox. */
export const runPython = action({
  args: { sandboxId: v.string(), code: v.string() },
  handler: async (ctx, args) => {
    return await daytona.runCode(ctx, { ...args, language: "python" });
  },
});

/** Write then read back a file in the sandbox. */
export const writeAndReadFile = action({
  args: { sandboxId: v.string(), path: v.string(), content: v.string() },
  handler: async (ctx, args) => {
    await daytona.writeFile(ctx, args);
    return await daytona.readFile(ctx, {
      sandboxId: args.sandboxId,
      path: args.path,
    });
  },
});

/** Get a signed preview URL for a port (e.g. after starting a dev server). */
export const previewUrl = action({
  args: { sandboxId: v.string(), port: v.number() },
  handler: async (ctx, args) => {
    return await daytona.getPreviewUrl(ctx, args);
  },
});

/** Stop / delete a sandbox. */
export const stopSandbox = action({
  args: { sandboxId: v.string() },
  handler: async (ctx, args) => daytona.stopSandbox(ctx, args),
});

export const deleteSandbox = action({
  args: { sandboxId: v.string() },
  handler: async (ctx, args) => daytona.deleteSandbox(ctx, args),
});

// ---- Reactive state — drive your UI from these ----

/** All sandbox records (reactive — updates as actions record state). */
export const sandboxes = query({
  args: {},
  handler: async (ctx) => daytona.listSandboxes(ctx),
});

/** Execution history for one sandbox (reactive). */
export const executions = query({
  args: { sandboxId: v.string() },
  handler: async (ctx, args) => daytona.listExecutions(ctx, args),
});
