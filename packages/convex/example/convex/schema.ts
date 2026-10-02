import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Written by the onComplete callback when background executions finish.
  notifications: defineTable({
    executionId: v.string(),
    status: v.string(),
    exitCode: v.optional(v.number()),
  }),
});
