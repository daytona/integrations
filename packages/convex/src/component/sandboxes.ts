/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sandbox lifecycle actions. Each action calls the Daytona API and records the
 * observed state in the component's `sandboxes` table so the host app can
 * subscribe to it reactively.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { action } from "./_generated/server.js";
import { DaytonaApiError, DaytonaClient } from "./daytona.js";
import { configValidator } from "./types.js";

const sandboxSummary = v.object({
  sandboxId: v.string(),
  state: v.string(),
});

export const create = action({
  args: {
    config: configValidator,
    name: v.optional(v.string()),
    /** Snapshot (ID or name) to base the sandbox on. Omit for the org default. */
    snapshot: v.optional(v.string()),
    /** Docker image to build the sandbox from. Mutually exclusive with `snapshot`. */
    image: v.optional(v.string()),
    target: v.optional(v.string()),
    user: v.optional(v.string()),
    envVars: v.optional(v.record(v.string(), v.string())),
    labels: v.optional(v.record(v.string(), v.string())),
    public: v.optional(v.boolean()),
    /** CPU cores — only valid with `image` (snapshots define their own resources). */
    cpu: v.optional(v.number()),
    memory: v.optional(v.number()),
    disk: v.optional(v.number()),
    /** Minutes idle before Daytona pauses the sandbox. */
    autoStopInterval: v.optional(v.number()),
    autoArchiveInterval: v.optional(v.number()),
    /** Minutes before auto-delete; -1 disables. */
    autoDeleteInterval: v.optional(v.number()),
    /** Opaque owner/tenant key from the host app (see schema). */
    userKey: v.optional(v.string()),
    /** Wait until the sandbox is started (default true). */
    wait: v.optional(v.boolean()),
    waitTimeoutMs: v.optional(v.number()),
  },
  returns: sandboxSummary,
  handler: async (ctx, args) => {
    if (args.snapshot && args.image) {
      throw new Error(
        "Pass either `snapshot` or `image`, not both — a snapshot already defines its base image.",
      );
    }
    const hasResources =
      args.cpu !== undefined ||
      args.memory !== undefined ||
      args.disk !== undefined;
    if (hasResources && !args.image) {
      throw new Error(
        "`cpu`/`memory`/`disk` are only valid with image-based creation (pass `image`). " +
          "Snapshot-based sandboxes get their resources from the snapshot.",
      );
    }
    const client = new DaytonaClient(args.config);
    const created = await client.createSandbox({
      name: args.name,
      snapshot: args.snapshot,
      buildInfo: args.image
        ? { dockerfileContent: `FROM ${args.image}` }
        : undefined,
      target: args.target,
      user: args.user,
      env: args.envVars,
      labels: args.labels,
      public: args.public,
      cpu: args.cpu,
      memory: args.memory,
      disk: args.disk,
      autoStopInterval: args.autoStopInterval,
      autoArchiveInterval: args.autoArchiveInterval,
      autoDeleteInterval: args.autoDeleteInterval,
    });
    await ctx.runMutation(internal.lib.upsertSandbox, {
      sandboxId: created.id,
      state: created.state,
      name: created.name,
      snapshot: created.snapshot,
      target: created.target,
      public: created.public,
      labels: created.labels,
      userKey: args.userKey,
    });
    let state = created.state as string;
    if (args.wait !== false) {
      try {
        const started = await client.waitForState(created.id, ["started"], {
          timeoutMs: args.waitTimeoutMs,
        });
        state = started.state;
      } catch (error) {
        // Best-effort: capture the observed failure state (e.g. "build_failed")
        // so the reactive record doesn't stay "creating" forever.
        const observed = await client
          .getSandbox(created.id)
          .then((s) => s.state as string)
          .catch(() => undefined);
        await ctx.runMutation(internal.lib.setSandboxError, {
          sandboxId: created.id,
          error: error instanceof Error ? error.message : String(error),
          state: observed,
        });
        throw error;
      }
      await ctx.runMutation(internal.lib.upsertSandbox, {
        sandboxId: created.id,
        state,
      });
    }
    return { sandboxId: created.id, state };
  },
});

export const start = action({
  args: {
    config: configValidator,
    sandboxId: v.string(),
    waitTimeoutMs: v.optional(v.number()),
  },
  returns: sandboxSummary,
  handler: async (ctx, args) => {
    const client = new DaytonaClient(args.config);
    try {
      const sandbox = await client.ensureStarted(args.sandboxId, {
        timeoutMs: args.waitTimeoutMs,
      });
      await ctx.runMutation(internal.lib.upsertSandbox, {
        sandboxId: args.sandboxId,
        state: sandbox.state,
      });
      return { sandboxId: args.sandboxId, state: sandbox.state };
    } catch (error) {
      await ctx.runMutation(internal.lib.setSandboxError, {
        sandboxId: args.sandboxId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});

export const stop = action({
  args: {
    config: configValidator,
    sandboxId: v.string(),
    waitTimeoutMs: v.optional(v.number()),
  },
  returns: sandboxSummary,
  handler: async (ctx, args) => {
    const client = new DaytonaClient(args.config);
    try {
      await client.stopSandbox(args.sandboxId);
      // `destroyed` is a valid terminal outcome: autoDeleteInterval 0 deletes
      // a sandbox as soon as it stops.
      const sandbox = await client.waitForState(
        args.sandboxId,
        ["stopped", "destroyed"],
        { timeoutMs: args.waitTimeoutMs },
      );
      await ctx.runMutation(internal.lib.upsertSandbox, {
        sandboxId: args.sandboxId,
        state: sandbox.state,
      });
      return { sandboxId: args.sandboxId, state: sandbox.state };
    } catch (error) {
      if (error instanceof DaytonaApiError && error.status === 404) {
        await ctx.runMutation(internal.lib.upsertSandbox, {
          sandboxId: args.sandboxId,
          state: "destroyed",
        });
        return { sandboxId: args.sandboxId, state: "destroyed" };
      }
      await ctx.runMutation(internal.lib.setSandboxError, {
        sandboxId: args.sandboxId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});

export const remove = action({
  args: { config: configValidator, sandboxId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const client = new DaytonaClient(args.config);
    await client.deleteSandbox(args.sandboxId);
    // Keep the row (with its execution history) as an audit record.
    await ctx.runMutation(internal.lib.upsertSandbox, {
      sandboxId: args.sandboxId,
      state: "destroyed",
    });
    return null;
  },
});

/** Re-read remote state into the component table. Returns null if the sandbox is gone. */
export const refresh = action({
  args: { config: configValidator, sandboxId: v.string() },
  returns: v.union(v.null(), sandboxSummary),
  handler: async (ctx, args) => {
    const client = new DaytonaClient(args.config);
    try {
      const sandbox = await client.getSandbox(args.sandboxId);
      await ctx.runMutation(internal.lib.upsertSandbox, {
        sandboxId: args.sandboxId,
        state: sandbox.state,
        name: sandbox.name,
        snapshot: sandbox.snapshot,
        target: sandbox.target,
        public: sandbox.public,
        labels: sandbox.labels,
      });
      return { sandboxId: args.sandboxId, state: sandbox.state };
    } catch (error) {
      if (error instanceof DaytonaApiError && error.status === 404) {
        await ctx.runMutation(internal.lib.upsertSandbox, {
          sandboxId: args.sandboxId,
          state: "destroyed",
        });
        return null;
      }
      throw error;
    }
  },
});

export const previewUrl = action({
  args: {
    config: configValidator,
    sandboxId: v.string(),
    port: v.number(),
    /** Signed URLs embed a short-lived token in the URL itself (default true). */
    signed: v.optional(v.boolean()),
    expiresInSeconds: v.optional(v.number()),
  },
  returns: v.object({
    url: v.string(),
    token: v.optional(v.string()),
    port: v.number(),
  }),
  handler: async (_ctx, args) => {
    const client = new DaytonaClient(args.config);
    const response =
      args.signed === false
        ? await client.previewUrl(args.sandboxId, args.port)
        : await client.signedPreviewUrl(
            args.sandboxId,
            args.port,
            args.expiresInSeconds,
          );
    return {
      url: response.url,
      token: response.token,
      port: response.port ?? args.port,
    };
  },
});
