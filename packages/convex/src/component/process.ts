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

import type { FunctionHandle } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import {
  action,
  env,
  internalAction,
  type ActionCtx,
} from "./_generated/server.js";
import { DaytonaApiError, DaytonaClient } from "./daytona.js";
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
// after each poll runs), so background executions read it from the env var
// the app passes down to the component instead. That also means a rotated key
// is picked up on the next poll. The API URL isn't a secret, so it's still
// forwarded by the client and carried in the scheduled args.

const POLL_MIN_MS = 1_000;
const POLL_MAX_MS = 10_000;
/** Clamps for caller-configured polling (see runBackground's poll options). */
const POLL_FLOOR_MS = 250;
const POLL_CEILING_MS = 120_000;
const MAX_POLL_FAILURES = 3;
/** How long a poll with no key to use waits before checking again. */
const MISSING_KEY_RETRY_MS = 60_000;

function clampPoll(
  requested: number | undefined,
  fallback: number,
  floor: number,
): number {
  if (requested === undefined) return fallback;
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new Error(`Poll intervals must be positive numbers, got ${requested}`);
  }
  return Math.min(Math.max(requested, floor), POLL_CEILING_MS);
}

/**
 * Invoke the execution's onComplete handle (if any) after a terminal
 * transition. Callback failures are logged, never propagated — the execution
 * row is already terminal and must stay truthful.
 */
async function notifyComplete(
  ctx: ActionCtx,
  executionId: Id<"executions">,
  onComplete: string | undefined,
  onCompleteContext: unknown,
): Promise<void> {
  if (!onComplete) return;
  const execution = await ctx.runQuery(internal.executions.getInternal, {
    executionId,
  });
  if (!execution) return;
  try {
    await ctx.runMutation(onComplete as FunctionHandle<"mutation">, {
      executionId,
      status: execution.status,
      exitCode: execution.exitCode,
      result: execution.result,
      error: execution.error,
      context: onCompleteContext,
    });
  } catch (error) {
    console.error(
      `onComplete handler failed for execution ${executionId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

const MISSING_API_KEY =
  "runBackground needs your Daytona API key passed down to the component. " +
  "In convex/convex.config.ts, declare it with defineApp({ env: { DAYTONA_API_KEY: v.string() } }) " +
  "and pass it with app.use(daytona, { env: { DAYTONA_API_KEY: app.env.DAYTONA_API_KEY } }). " +
  "See https://github.com/daytona/integrations/tree/main/packages/convex#installation";

/** The key the app passed down to the component, or null if it didn't. */
function backgroundConfig(apiUrl: string | undefined): DaytonaConfig | null {
  const apiKey = env.DAYTONA_API_KEY;
  return apiKey ? { apiKey, apiUrl } : null;
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
    /** API base URL, forwarded by the client. The key comes from the component's env. */
    apiUrl: v.optional(v.string()),
    /** Mutation function handle invoked when the execution reaches a terminal state. */
    onComplete: v.optional(v.string()),
    /** Caller-supplied value passed through to the onComplete handler. */
    onCompleteContext: v.optional(v.any()),
    /** First poll delay and backoff floor (default 1000ms, min 250ms). */
    minPollMs: v.optional(v.number()),
    /** Backoff ceiling between polls (default 10000ms, max 120000ms). */
    maxPollMs: v.optional(v.number()),
  },
  returns: v.object({ executionId: v.id("executions") }),
  handler: async (ctx, args) => {
    const minPollMs = clampPoll(args.minPollMs, POLL_MIN_MS, POLL_FLOOR_MS);
    const maxPollMs = Math.max(
      clampPoll(args.maxPollMs, POLL_MAX_MS, POLL_FLOOR_MS),
      minPollMs,
    );
    // Launch with the same key the poller will use.
    const config = backgroundConfig(args.apiUrl);
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
        onComplete: args.onComplete,
        onCompleteContext: args.onCompleteContext,
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
      await ctx.scheduler.runAfter(minPollMs, internal.process.pollExecution, {
        executionId,
        apiUrl: args.apiUrl,
        delayMs: minPollMs,
        maxDelayMs: maxPollMs,
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
      const transitioned = await ctx.runMutation(
        internal.executions.finishExecution,
        {
          executionId,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        },
      );
      if (transitioned) {
        await notifyComplete(ctx, executionId, args.onComplete, args.onCompleteContext);
      }
      throw error;
    }
  },
});

export const pollExecution = internalAction({
  args: {
    executionId: v.id("executions"),
    apiUrl: v.optional(v.string()),
    delayMs: v.number(),
    /** Backoff ceiling; absent on polls scheduled before it existed. */
    maxDelayMs: v.optional(v.number()),
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
    const apiUrl = args.apiUrl ?? args.config?.apiUrl;
    // A 1.1.0 poll can fall back to the key in its own args for this poll.
    const config = backgroundConfig(apiUrl) ?? args.config;
    if (!config) {
      // The command may well still be running, so failing the row would be
      // dishonest and we can't stop the command without a key. Keep it
      // running and check again once the key may be back (e.g. mid-redeploy).
      console.error(MISSING_API_KEY);
      await ctx.scheduler.runAfter(
        MISSING_KEY_RETRY_MS,
        internal.process.pollExecution,
        {
          executionId: args.executionId,
          apiUrl,
          delayMs: args.delayMs,
          maxDelayMs: args.maxDelayMs,
          failures: args.failures,
        },
      );
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
        const transitioned = await ctx.runMutation(
          internal.executions.finishExecution,
          {
            executionId: args.executionId,
            status: command.exitCode === 0 ? "completed" : "failed",
            exitCode: command.exitCode,
            result: truncate(logs, MAX_STORED_OUTPUT),
          },
        );
        await client
          .deleteSession(execution.sandboxId, execution.sessionId)
          .catch(() => undefined);
        // Lost a race (e.g. cancelled meanwhile): the winner already notified.
        if (transitioned) {
          await notifyComplete(
            ctx,
            args.executionId,
            execution.onComplete,
            execution.onCompleteContext,
          );
        }
        return null;
      }
      // Still running: surface the logs so far (reactive), then poll again
      // with backoff. Each poll is its own short action — nothing is held open.
      await ctx.runMutation(internal.executions.updateExecution, {
        executionId: args.executionId,
        result: truncate(logs, MAX_STORED_OUTPUT),
      });
      const maxDelay = args.maxDelayMs ?? POLL_MAX_MS;
      const nextDelay = Math.min(args.delayMs * 2, maxDelay);
      await ctx.scheduler.runAfter(nextDelay, internal.process.pollExecution, {
        executionId: args.executionId,
        apiUrl,
        delayMs: nextDelay,
        maxDelayMs: args.maxDelayMs,
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
        const transitioned = await ctx.runMutation(
          internal.executions.finishExecution,
          {
            executionId: args.executionId,
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          },
        );
        if (transitioned) {
          await notifyComplete(
            ctx,
            args.executionId,
            execution.onComplete,
            execution.onCompleteContext,
          );
        }
        return null;
      }
      const retryDelay = args.maxDelayMs ?? POLL_MAX_MS;
      await ctx.scheduler.runAfter(retryDelay, internal.process.pollExecution, {
        executionId: args.executionId,
        apiUrl,
        delayMs: retryDelay,
        maxDelayMs: args.maxDelayMs,
        failures: args.failures + 1,
      });
    }
    return null;
  },
});

/**
 * Cancel a running background execution. Order matters: the command is
 * killed FIRST, and only then does the row transition to "cancelled" — if
 * Daytona can't kill it (transient error), this throws and the row stays
 * "running" (truthful; the poller keeps supervising). The transition only
 * succeeds from "running", so a concurrent finish/cancel wins cleanly and
 * onComplete fires exactly once.
 */
export const cancelExecution = action({
  args: {
    executionId: v.id("executions"),
    /** API base URL, forwarded by the client. The key comes from the component's env. */
    apiUrl: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const config = backgroundConfig(args.apiUrl);
    if (!config) throw new Error(MISSING_API_KEY);
    const execution = await ctx.runQuery(internal.executions.getInternal, {
      executionId: args.executionId,
    });
    if (!execution) throw new Error("Execution not found");
    if (execution.status !== "running") {
      throw new Error(`Execution is not running (status: ${execution.status})`);
    }
    if (!execution.sessionId) {
      throw new Error("Only background executions can be cancelled");
    }
    const client = new DaytonaClient(config);
    try {
      await client.deleteSession(execution.sandboxId, execution.sessionId);
    } catch (error) {
      // Already gone (sandbox/session deleted) means it's not running: fine.
      if (!(error instanceof DaytonaApiError && error.status === 404)) {
        throw error;
      }
    }
    const transitioned = await ctx.runMutation(
      internal.executions.finishExecution,
      { executionId: args.executionId, status: "cancelled" },
    );
    if (!transitioned) {
      throw new Error("Execution finished before it could be cancelled");
    }
    await notifyComplete(
      ctx,
      args.executionId,
      execution.onComplete,
      execution.onCompleteContext,
    );
    return null;
  },
});
