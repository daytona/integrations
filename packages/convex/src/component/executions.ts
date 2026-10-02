/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Execution records: reactive queries over the `executions` table, plus the
 * internal bookkeeping mutations used by the process actions.
 */

import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server.js";
import { executionFields } from "./schema.js";
import { clampLimit } from "./types.js";

export const executionDoc = v.object({
  ...executionFields,
  _id: v.id("executions"),
  _creationTime: v.number(),
});

export const list = query({
  args: { sandboxId: v.string(), limit: v.optional(v.number()) },
  returns: v.array(executionDoc),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("executions")
      .withIndex("sandboxId", (q) => q.eq("sandboxId", args.sandboxId))
      .order("desc")
      .take(clampLimit(args.limit, 50));
  },
});

export const get = query({
  args: { executionId: v.id("executions") },
  returns: v.union(v.null(), executionDoc),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.executionId);
  },
});

export const getInternal = internalQuery({
  args: { executionId: v.id("executions") },
  returns: v.union(v.null(), executionDoc),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.executionId);
  },
});

export const updateExecution = internalMutation({
  args: {
    executionId: v.id("executions"),
    sessionId: v.optional(v.string()),
    commandId: v.optional(v.string()),
    result: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { executionId, ...fields } = args;
    const defined = Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    );
    await ctx.db.patch(executionId, defined);
    return null;
  },
});

export const startExecution = internalMutation({
  args: {
    sandboxId: v.string(),
    kind: v.union(v.literal("command"), v.literal("code")),
    input: v.string(),
    cwd: v.optional(v.string()),
    onComplete: v.optional(v.string()),
    onCompleteContext: v.optional(v.any()),
  },
  returns: v.id("executions"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("executions", {
      ...args,
      status: "running",
      startedAt: Date.now(),
    });
  },
});

export const finishExecution = internalMutation({
  args: {
    executionId: v.id("executions"),
    status: v.union(
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    exitCode: v.optional(v.number()),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { executionId, ...rest } = args;
    await ctx.db.patch(executionId, { ...rest, finishedAt: Date.now() });
    return null;
  },
});

/**
 * Atomically claim a running background execution for cancellation. Losing a
 * race against the poller's finish (or a concurrent cancel) throws instead of
 * overwriting a terminal state.
 */
export const beginCancel = internalMutation({
  args: { executionId: v.id("executions") },
  returns: executionDoc,
  handler: async (ctx, args) => {
    const execution = await ctx.db.get(args.executionId);
    if (!execution) throw new Error("Execution not found");
    if (execution.status !== "running") {
      throw new Error(`Execution is not running (status: ${execution.status})`);
    }
    if (!execution.sessionId) {
      throw new Error("Only background executions can be cancelled");
    }
    await ctx.db.patch(args.executionId, {
      status: "cancelled",
      finishedAt: Date.now(),
    });
    return { ...execution, status: "cancelled" as const };
  },
});

/**
 * Delete terminal execution rows older than a cutoff, in bounded batches.
 * Returns how many were deleted and whether more remain — call again until
 * `hasMore` is false. Host apps gate access with their own auth.
 */
export const purge = mutation({
  args: {
    olderThanMs: v.number(),
    sandboxId: v.optional(v.string()),
  },
  returns: v.object({ deleted: v.number(), hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const cutoff = Date.now() - args.olderThanMs;
    const batch = args.sandboxId
      ? await ctx.db
          .query("executions")
          .withIndex("sandboxId", (q) => q.eq("sandboxId", args.sandboxId!))
          .take(200)
      : await ctx.db.query("executions").take(200);
    const victims = batch.filter(
      (execution) =>
        execution.status !== "running" && execution.startedAt <= cutoff,
    );
    for (const victim of victims) {
      await ctx.db.delete(victim._id);
    }
    return { deleted: victims.length, hasMore: batch.length === 200 };
  },
});
