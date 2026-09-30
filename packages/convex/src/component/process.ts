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
import {
  action,
  internalAction,
  type ActionCtx,
} from "./_generated/server.js";
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

// ---- Background execution (sessions + scheduler polling) ----
//
// `run` holds the action open until the command finishes, which couples
// command duration to Convex's action billing and 10-minute ceiling. For long
// jobs, `runBackground` starts the command in a toolbox session with
// runAsync and returns immediately; a scheduler-chained internal action polls
// status/logs (~1s each) and finishes the execution row when the command
// exits. NOTE: a running background command does not reset the sandbox's idle
// timer — create long-job sandboxes with autoStopInterval: 0.

const POLL_MIN_MS = 1_000;
const POLL_MAX_MS = 10_000;
const MAX_POLL_FAILURES = 3;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Sessions are bare shells with no cwd/env params — compose them into the command. */
function composeSessionCommand(
  command: string,
  cwd?: string,
  envs?: Record<string, string>,
): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(envs ?? {})) {
    parts.push(`export ${key}=${shellQuote(value)}`);
  }
  if (cwd) parts.push(`cd ${shellQuote(cwd)}`);
  parts.push(command);
  return parts.join(" && ");
}

export const runBackground = action({
  args: {
    config: configValidator,
    sandboxId: v.string(),
    command: v.string(),
    cwd: v.optional(v.string()),
    envs: v.optional(v.record(v.string(), v.string())),
    /** Transparently restart a stopped/archived sandbox first (default true). */
    autoStart: v.optional(v.boolean()),
  },
  returns: v.object({ executionId: v.id("executions") }),
  handler: async (ctx, args) => {
    const client = new DaytonaClient(args.config);
    if (args.autoStart !== false) {
      const sandbox = await client.ensureStarted(args.sandboxId);
      await ctx.runMutation(internal.sandboxes.upsertSandbox, {
        sandboxId: args.sandboxId,
        state: sandbox.state,
      });
    }
    const executionId: Id<"executions"> = await ctx.runMutation(
      internal.executions.startExecution,
      {
        sandboxId: args.sandboxId,
        kind: "command",
        input: truncate(args.command, MAX_STORED_INPUT),
        cwd: args.cwd,
      },
    );
    try {
      const sessionId = `convex-exec-${executionId}`;
      await client.createSession(args.sandboxId, sessionId);
      const { cmdId } = await client.sessionExec(args.sandboxId, sessionId, {
        command: composeSessionCommand(args.command, args.cwd, args.envs),
        runAsync: true,
      });
      await ctx.runMutation(internal.executions.updateExecution, {
        executionId,
        sessionId,
        commandId: cmdId,
      });
      await ctx.scheduler.runAfter(POLL_MIN_MS, internal.process.pollExecution, {
        config: args.config,
        executionId,
        delayMs: POLL_MIN_MS,
        failures: 0,
      });
      return { executionId };
    } catch (error) {
      await ctx.runMutation(internal.executions.finishExecution, {
        executionId,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});

export const pollExecution = internalAction({
  args: {
    config: configValidator,
    executionId: v.id("executions"),
    delayMs: v.number(),
    failures: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const execution = await ctx.runQuery(internal.executions.getInternal, {
      executionId: args.executionId,
    });
    if (
      !execution ||
      execution.status !== "running" ||
      !execution.sessionId ||
      !execution.commandId
    ) {
      return null;
    }
    const client = new DaytonaClient(args.config);
    try {
      const command = await client.getSessionCommand(
        execution.sandboxId,
        execution.sessionId,
        execution.commandId,
      );
      const logs = await client
        .getSessionCommandLogs(
          execution.sandboxId,
          execution.sessionId,
          execution.commandId,
        )
        .catch(() => "");
      if (command.exitCode !== undefined && command.exitCode !== null) {
        await ctx.runMutation(internal.executions.finishExecution, {
          executionId: args.executionId,
          status: command.exitCode === 0 ? "completed" : "failed",
          exitCode: command.exitCode,
          result: truncate(logs, MAX_STORED_OUTPUT),
        });
        await client
          .deleteSession(execution.sandboxId, execution.sessionId)
          .catch(() => undefined);
        return null;
      }
      // Still running: surface the logs so far (reactive), then poll again
      // with backoff. Each poll is its own short action — nothing is held open.
      await ctx.runMutation(internal.executions.updateExecution, {
        executionId: args.executionId,
        result: truncate(logs, MAX_STORED_OUTPUT),
      });
      const nextDelay = Math.min(args.delayMs * 2, POLL_MAX_MS);
      await ctx.scheduler.runAfter(nextDelay, internal.process.pollExecution, {
        config: args.config,
        executionId: args.executionId,
        delayMs: nextDelay,
        failures: 0,
      });
    } catch (error) {
      // Tolerate transient failures (network, sandbox restarting) before
      // declaring the execution dead.
      if (args.failures + 1 >= MAX_POLL_FAILURES) {
        await ctx.runMutation(internal.executions.finishExecution, {
          executionId: args.executionId,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
      await ctx.scheduler.runAfter(POLL_MAX_MS, internal.process.pollExecution, {
        config: args.config,
        executionId: args.executionId,
        delayMs: POLL_MAX_MS,
        failures: args.failures + 1,
      });
    }
    return null;
  },
});
