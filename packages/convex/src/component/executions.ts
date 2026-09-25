/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Execution records: reactive queries over the `executions` table, plus the
 * internal bookkeeping mutations used by the process actions.
 */

import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server.js";
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

export const startExecution = internalMutation({
  args: {
    sandboxId: v.string(),
    kind: v.union(v.literal("command"), v.literal("code")),
    input: v.string(),
    cwd: v.optional(v.string()),
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
    status: v.union(v.literal("completed"), v.literal("failed")),
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
