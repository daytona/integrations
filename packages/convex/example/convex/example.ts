import { Daytona } from "@daytona/convex";
import { v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import { action, internalMutation, query } from "./_generated/server.js";

// Reads DAYTONA_API_KEY (and optional DAYTONA_API_URL) from this deployment's
// environment variables: `npx convex env set DAYTONA_API_KEY ...`
const daytona = new Daytona(components.daytona);

// NOTE: in a real app, authenticate the caller (ctx.auth) in each of these
// functions and scope sandboxes with `userKey` — the component can't see your
// app's auth, so authorization belongs here in the host app.

/** Create a sandbox and wait until it's running. */
export const createSandbox = action({
  args: {
    snapshot: v.optional(v.string()),
    // Sandboxes for long background jobs should pass 0 (never idle-stop) —
    // a running background command does not reset the idle timer.
    autoStopInterval: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await daytona.createSandbox(ctx, {
      snapshot: args.snapshot,
      labels: { "created-by": "convex-example" },
      autoStopInterval: args.autoStopInterval ?? 15,
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

/** Start a long-running command in the background — watch it via `executions`. */
export const runBackgroundCommand = action({
  args: {
    sandboxId: v.string(),
    command: v.string(),
    cwd: v.optional(v.string()),
    withCallback: v.optional(v.boolean()),
  },
  // Explicit return type: referencing internal.example.* from this module
  // would otherwise make the export's inferred type self-referential.
  handler: async (ctx, args): Promise<{ executionId: string }> => {
    return await daytona.runBackground(ctx, {
      sandboxId: args.sandboxId,
      command: args.command,
      cwd: args.cwd,
      // The component calls this mutation when the command finishes — no
      // polling loop needed on the app side.
      onComplete: args.withCallback ? internal.example.backgroundFinished : undefined,
      onCompleteContext: args.withCallback ? { source: "example" } : undefined,
    });
  },
});

/** Called by the component when a background execution reaches a terminal state. */
export const backgroundFinished = internalMutation({
  args: {
    executionId: v.string(),
    status: v.union(
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    exitCode: v.optional(v.number()),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    context: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("notifications", {
      executionId: args.executionId,
      status: args.status,
      exitCode: args.exitCode,
      context: args.context,
    });
  },
});

/** Reactive: callback notifications written by `backgroundFinished`. */
export const notifications = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("notifications").order("desc").take(20);
  },
});

/** Cancel a running background execution. */
export const cancelBackgroundCommand = action({
  args: { executionId: v.string() },
  handler: async (ctx, args) => {
    return await daytona.cancelExecution(ctx, args);
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
