/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command/code execution actions. Every execution is recorded in the
 * `executions` table (running → completed/failed) so the host app can render
 * live status and history via reactive queries.
 *
 * Executions are synchronous within the action: Daytona's toolbox `execute`
 * resolves when the command finishes. Convex actions have a 10-minute ceiling —
 * for longer-running work, start a background process inside the sandbox (e.g.
 * `nohup … &`) and poll it with follow-up executions.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { action, type ActionCtx } from "./_generated/server.js";
import { DaytonaClient } from "./daytona.js";
import {
  MAX_RETURNED_OUTPUT,
  MAX_STORED_INPUT,
  MAX_STORED_OUTPUT,
  configValidator,
  truncate,
  type ProcessExecutionResponse,
} from "./types.js";

/**
 * Convex actions hard-timeout at 10 minutes — a command outliving the action
 * would leave its execution row stuck "running" (the catch below never runs).
 * So the remote command is always bounded BELOW the action ceiling: default
 * 9 minutes, capped at 9.5.
 */
const DEFAULT_EXEC_TIMEOUT_SECONDS = 540;
const MAX_EXEC_TIMEOUT_SECONDS = 570;

function boundedTimeout(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_EXEC_TIMEOUT_SECONDS;
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new Error(
      `timeoutSeconds must be a positive number, got ${requested}`,
    );
  }
  return Math.min(requested, MAX_EXEC_TIMEOUT_SECONDS);
}

const executionResult = v.object({
  executionId: v.id("executions"),
  exitCode: v.number(),
  result: v.string(),
});

async function recordAndRun(
  ctx: ActionCtx,
  args: {
    sandboxId: string;
    kind: "command" | "code";
    input: string;
    cwd?: string;
    autoStart?: boolean;
  },
  client: DaytonaClient,
  execute: () => Promise<ProcessExecutionResponse>,
): Promise<{ executionId: Id<"executions">; exitCode: number; result: string }> {
  const executionId: Id<"executions"> = await ctx.runMutation(
    internal.executions.startExecution,
    {
      sandboxId: args.sandboxId,
      kind: args.kind,
      input: truncate(args.input, MAX_STORED_INPUT),
      cwd: args.cwd,
    },
  );
  try {
    if (args.autoStart !== false) {
      const sandbox = await client.ensureStarted(args.sandboxId);
      await ctx.runMutation(internal.sandboxes.upsertSandbox, {
        sandboxId: args.sandboxId,
        state: sandbox.state,
      });
    }
    const response = await execute();
    const output = response.result ?? response.artifacts?.stdout ?? "";
    await ctx.runMutation(internal.executions.finishExecution, {
      executionId,
      status: "completed",
      exitCode: response.exitCode,
      result: truncate(output, MAX_STORED_OUTPUT),
    });
    return {
      executionId,
      exitCode: response.exitCode ?? 0,
      // Bounded so huge outputs can't blow Convex's function return limits
      // after the execution was already marked completed.
      result: truncate(output, MAX_RETURNED_OUTPUT),
    };
  } catch (error) {
    await ctx.runMutation(internal.executions.finishExecution, {
      executionId,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export const run = action({
  args: {
    config: configValidator,
    sandboxId: v.string(),
    command: v.string(),
    cwd: v.optional(v.string()),
    envs: v.optional(v.record(v.string(), v.string())),
    /** Max seconds for the command (default 540, capped at 570 — below Convex's 10-min action ceiling). */
    timeoutSeconds: v.optional(v.number()),
    /** Transparently restart a stopped/archived sandbox first (default true). */
    autoStart: v.optional(v.boolean()),
  },
  returns: executionResult,
  handler: async (ctx, args) => {
    // Validate before any remote call or execution row is created.
    const timeoutSeconds = boundedTimeout(args.timeoutSeconds);
    const client = new DaytonaClient(args.config);
    return await recordAndRun(
      ctx,
      {
        sandboxId: args.sandboxId,
        kind: "command",
        input: args.command,
        cwd: args.cwd,
        autoStart: args.autoStart,
      },
      client,
      () =>
        client.execute(args.sandboxId, {
          command: args.command,
          cwd: args.cwd,
          envs: args.envs,
          timeoutSeconds,
        }),
    );
  },
});

export const runCode = action({
  args: {
    config: configValidator,
    sandboxId: v.string(),
    code: v.string(),
    /** Required by the Daytona toolbox: e.g. "python", "javascript", "typescript". */
    language: v.string(),
    argv: v.optional(v.array(v.string())),
    envs: v.optional(v.record(v.string(), v.string())),
    timeoutSeconds: v.optional(v.number()),
    autoStart: v.optional(v.boolean()),
  },
  returns: executionResult,
  handler: async (ctx, args) => {
    const timeoutSeconds = boundedTimeout(args.timeoutSeconds);
    const client = new DaytonaClient(args.config);
    return await recordAndRun(
      ctx,
      {
        sandboxId: args.sandboxId,
        kind: "code",
        input: args.code,
        autoStart: args.autoStart,
      },
      client,
      () =>
        client.runCode(args.sandboxId, {
          code: args.code,
          language: args.language,
          argv: args.argv,
          envs: args.envs,
          timeoutSeconds,
        }),
    );
  },
});
