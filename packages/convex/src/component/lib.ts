/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Component state: reactive queries over sandbox/execution records, plus the
 * internal mutations that actions use to keep those records up to date.
 */

import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server.js";
import { executionFields, sandboxFields } from "./schema.js";

export const sandboxDoc = v.object({
  ...sandboxFields,
  _id: v.id("sandboxes"),
  _creationTime: v.number(),
});

export const executionDoc = v.object({
  ...executionFields,
  _id: v.id("executions"),
  _creationTime: v.number(),
});

// ---- Queries (host-facing, reactive) ----

export const get = query({
  args: { sandboxId: v.string() },
  returns: v.union(v.null(), sandboxDoc),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("sandboxes")
      .withIndex("sandboxId", (q) => q.eq("sandboxId", args.sandboxId))
      .unique();
  },
});

export const list = query({
  args: { userKey: v.optional(v.string()), limit: v.optional(v.number()) },
  returns: v.array(sandboxDoc),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;
    if (args.userKey !== undefined) {
      const userKey = args.userKey;
      return await ctx.db
        .query("sandboxes")
        .withIndex("userKey", (q) => q.eq("userKey", userKey))
        .order("desc")
        .take(limit);
    }
    return await ctx.db.query("sandboxes").order("desc").take(limit);
  },
});

export const listExecutions = query({
  args: { sandboxId: v.string(), limit: v.optional(v.number()) },
  returns: v.array(executionDoc),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("executions")
      .withIndex("sandboxId", (q) => q.eq("sandboxId", args.sandboxId))
      .order("desc")
      .take(args.limit ?? 50);
  },
});

export const getExecution = query({
  args: { executionId: v.id("executions") },
  returns: v.union(v.null(), executionDoc),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.executionId);
  },
});

// ---- Internal mutations (bookkeeping for actions) ----

export const upsertSandbox = internalMutation({
  args: {
    sandboxId: v.string(),
    state: v.string(),
    name: v.optional(v.string()),
    snapshot: v.optional(v.string()),
    target: v.optional(v.string()),
    public: v.optional(v.boolean()),
    labels: v.optional(v.record(v.string(), v.string())),
    userKey: v.optional(v.string()),
    lastError: v.optional(v.string()),
  },
  returns: v.id("sandboxes"),
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("sandboxes")
      .withIndex("sandboxId", (q) => q.eq("sandboxId", args.sandboxId))
      .unique();
    // Skip undefined fields so a partial update never clears known values.
    const defined = Object.fromEntries(
      Object.entries(args).filter(([, value]) => value !== undefined),
    ) as typeof args;
    if (existing) {
      await ctx.db.patch(existing._id, { ...defined, updatedAt: now });
      return existing._id;
    }
    return await ctx.db.insert("sandboxes", {
      ...defined,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const setSandboxError = internalMutation({
  args: { sandboxId: v.string(), error: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("sandboxes")
      .withIndex("sandboxId", (q) => q.eq("sandboxId", args.sandboxId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        lastError: args.error,
        updatedAt: Date.now(),
      });
    }
    return null;
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
