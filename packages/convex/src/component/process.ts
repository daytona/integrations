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
  env,
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
  type DaytonaConfig,
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
//
// The poller runs from the scheduler, outside any call from the app, so it
// can't be handed the API key like the other actions are. Passing it in the
// scheduled args would store it in `_scheduled_functions` (kept for 7 days
// after each poll runs), so background executions read it from the env vars
// the app passes down to the component instead. That also means a rotated key
// is picked up on the next poll.

const POLL_MIN_MS = 1_000;
const POLL_MAX_MS = 10_000;
const MAX_POLL_FAILURES = 3;

const MISSING_API_KEY =
  "runBackground needs your Daytona API key passed down to the component. " +
  "In convex/convex.config.ts, declare it with defineApp({ env: { DAYTONA_API_KEY: v.string() } }) " +
  "and pass it with app.use(daytona, { env: { DAYTONA_API_KEY: app.env.DAYTONA_API_KEY } }). " +
  "See https://github.com/daytona/integrations/tree/main/packages/convex#installation";

/** The config the app passed down to the component, or null if it didn't. */
function backgroundConfig(): DaytonaConfig | null {
  const apiKey = env.DAYTONA_API_KEY;
  return apiKey ? { apiKey, apiUrl: env.DAYTONA_API_URL } : null;
}

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
    // Keys are interpolated as shell syntax — reject anything that isn't a
    // valid identifier so they can't smuggle in extra commands.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment variable name: ${key}`);
    }
    parts.push(`export ${key}=${shellQuote(value)}`);
  }
  if (cwd) parts.push(`cd ${shellQuote(cwd)}`);
  parts.push(command);
  return parts.join(" && ");
}

export const runBackground = action({
  args: {
    sandboxId: v.string(),
    command: v.string(),
    cwd: v.optional(v.string()),
    envs: v.optional(v.record(v.string(), v.string())),
    /** Transparently restart a stopped/archived sandbox first (default true). */
    autoStart: v.optional(v.boolean()),
  },
  returns: v.object({ executionId: v.id("executions") }),
  handler: async (ctx, args) => {
    // Launch with the same key the poller will use.
    const config = backgroundConfig();
    if (!config) throw new Error(MISSING_API_KEY);
    const client = new DaytonaClient(config);
    // Record the row first so every call leaves a history entry, even when
    // sandbox startup fails.
    const executionId: Id<"executions"> = await ctx.runMutation(
      internal.executions.startExecution,
      {
        sandboxId: args.sandboxId,
        kind: "command",
        input: truncate(args.command, MAX_STORED_INPUT),
        cwd: args.cwd,
      },
    );
    const sessionId = `convex-exec-${executionId}`;
    let sessionCreated = false;
    try {
      if (args.autoStart !== false) {
        const sandbox = await client.ensureStarted(args.sandboxId);
        await ctx.runMutation(internal.sandboxes.upsertSandbox, {
          sandboxId: args.sandboxId,
          state: sandbox.state,
        });
      }
      await client.createSession(args.sandboxId, sessionId);
      sessionCreated = true;
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
        executionId,
        delayMs: POLL_MIN_MS,
        failures: 0,
      });
      return { executionId };
    } catch (error) {
      // Don't leave an orphaned session (and possibly a started command)
      // running with no poller attached.
      if (sessionCreated) {
        await client
          .deleteSession(args.sandboxId, sessionId)
          .catch(() => undefined);
      }
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
    executionId: v.id("executions"),
    delayMs: v.number(),
    failures: v.number(),
    /**
     * Only set on polls scheduled by 1.1.0, which passed the key here. Still
     * accepted so those keep going after an upgrade, but never passed on.
     */
    config: v.optional(configValidator),
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
    const config = backgroundConfig();
    if (!config) {
      // Nothing to poll with. If a 1.1.0 poll brought its own key, use it to
      // kill the session so the command doesn't outlive its "failed" row.
      if (args.config) {
        await new DaytonaClient(args.config)
          .deleteSession(execution.sandboxId, execution.sessionId)
          .catch(() => undefined);
      }
      await ctx.runMutation(internal.executions.finishExecution, {
        executionId: args.executionId,
        status: "failed",
        error: MISSING_API_KEY,
      });
      return null;
    }
    const client = new DaytonaClient(config);
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
        executionId: args.executionId,
        delayMs: nextDelay,
        failures: 0,
      });
    } catch (error) {
      // Tolerate transient failures (network, sandbox restarting) before
      // declaring the execution dead.
      if (args.failures + 1 >= MAX_POLL_FAILURES) {
        // Make the terminal state honest: kill the session so the command
        // can't keep running after its row says "failed".
        await client
          .deleteSession(execution.sandboxId, execution.sessionId)
          .catch(() => undefined);
        await ctx.runMutation(internal.executions.finishExecution, {
          executionId: args.executionId,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
      await ctx.scheduler.runAfter(POLL_MAX_MS, internal.process.pollExecution, {
        executionId: args.executionId,
        delayMs: POLL_MAX_MS,
        failures: args.failures + 1,
      });
    }
    return null;
  },
});
