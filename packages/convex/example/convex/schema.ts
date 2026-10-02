import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Written by the onComplete callback when background executions finish.
  notifications: defineTable({
    executionId: v.string(),
    status: v.union(
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    exitCode: v.optional(v.number()),
    context: v.optional(v.any()),
  }),
});
