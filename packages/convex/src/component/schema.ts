import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Sandbox records mirror the Daytona sandboxes this component has created or
 * touched. They are the component's durable, reactive view of remote state —
 * the source of truth is always the Daytona API (see `refresh`).
 */
export const sandboxFields = {
  /** Daytona sandbox ID (external — not a Convex document ID). */
  sandboxId: v.string(),
  name: v.optional(v.string()),
  /** Last observed Daytona sandbox state (e.g. "started", "stopped"). */
  state: v.string(),
  snapshot: v.optional(v.string()),
  target: v.optional(v.string()),
  public: v.optional(v.boolean()),
  labels: v.optional(v.record(v.string(), v.string())),
  /**
   * Opaque owner/tenant key provided by the host app (components can't read
   * the app's `ctx.auth`). Use it to scope sandboxes to a user or agent.
   */
  userKey: v.optional(v.string()),
  lastError: v.optional(v.string()),
  /**
   * Daytona's timestamp (ms) of the last webhook state event applied. Events
   * can arrive duplicated or out of order; older ones are discarded.
   */
  remoteUpdatedAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
};

/** One row per command/code execution — history readable via reactive queries. */
export const executionFields = {
  sandboxId: v.string(),
  kind: v.union(v.literal("command"), v.literal("code")),
  /** The command or code that ran (truncated for storage). */
  input: v.string(),
  cwd: v.optional(v.string()),
  status: v.union(
    v.literal("running"),
    v.literal("completed"),
    v.literal("failed"),
    v.literal("cancelled"),
  ),
  exitCode: v.optional(v.number()),
  /** Combined output (truncated for storage — full output is the action's return value). */
  result: v.optional(v.string()),
  /** Set for background executions: the toolbox session/command driving them. */
  sessionId: v.optional(v.string()),
  commandId: v.optional(v.string()),
  /** Function handle invoked when a background execution reaches a terminal state. */
  onComplete: v.optional(v.string()),
  /** Caller-supplied value passed through to the onComplete handler. */
  onCompleteContext: v.optional(v.any()),
  error: v.optional(v.string()),
  startedAt: v.number(),
  finishedAt: v.optional(v.number()),
};

export default defineSchema({
  sandboxes: defineTable(sandboxFields)
    .index("sandboxId", ["sandboxId"])
    .index("userKey", ["userKey"])
    .index("state", ["state"])
    .index("userKey_state", ["userKey", "state"]),
  executions: defineTable(executionFields).index("sandboxId", ["sandboxId"]),
});
