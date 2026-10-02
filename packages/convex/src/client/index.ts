/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Host-facing client for the Daytona Convex component.
 *
 * Instantiate it once with `components.daytona` and call its methods from your
 * app's queries, mutations, and actions. Credentials resolve from the options
 * you pass, falling back to the host deployment's environment variables
 * (`DAYTONA_API_KEY`, `DAYTONA_API_URL`) — components can't read your env vars
 * themselves, so the client forwards them on each call.
 */

import { createFunctionHandle } from "convex/server";
import type { FunctionReference, FunctionReturnType } from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";

export interface DaytonaOptions {
  /** Daytona API key. Defaults to `process.env.DAYTONA_API_KEY`. */
  apiKey?: string;
  /** API base URL. Defaults to `process.env.DAYTONA_API_URL` or Daytona Cloud. */
  apiUrl?: string;
}

export interface CreateSandboxArgs {
  name?: string;
  /** Snapshot (ID or name) to base the sandbox on. Mutually exclusive with `image`. */
  snapshot?: string;
  /** Docker image to build from. Required if you want to set `cpu`/`memory`/`disk`. */
  image?: string;
  target?: string;
  user?: string;
  envVars?: Record<string, string>;
  labels?: Record<string, string>;
  public?: boolean;
  cpu?: number;
  memory?: number;
  disk?: number;
  autoStopInterval?: number;
  autoArchiveInterval?: number;
  autoDeleteInterval?: number;
  userKey?: string;
  wait?: boolean;
  waitTimeoutMs?: number;
}

export interface RunCommandArgs {
  sandboxId: string;
  command: string;
  cwd?: string;
  envs?: Record<string, string>;
  timeoutSeconds?: number;
  autoStart?: boolean;
}

export interface RunCodeArgs {
  sandboxId: string;
  code: string;
  language: string;
  argv?: string[];
  envs?: Record<string, string>;
  timeoutSeconds?: number;
  autoStart?: boolean;
}

// Minimal ctx types so methods accept any host function ctx (query, mutation,
// or action) that can run the required kind of component function.
export type RunQueryCtx = {
  runQuery: <Query extends FunctionReference<"query", "public" | "internal">>(
    query: Query,
    args: Query["_args"],
  ) => Promise<FunctionReturnType<Query>>;
};
export type RunMutationCtx = RunQueryCtx & {
  runMutation: <
    Mutation extends FunctionReference<"mutation", "public" | "internal">,
  >(
    mutation: Mutation,
    args: Mutation["_args"],
  ) => Promise<FunctionReturnType<Mutation>>;
};
export type RunActionCtx = RunMutationCtx & {
  runAction: <
    Action extends FunctionReference<"action", "public" | "internal">,
  >(
    action: Action,
    args: Action["_args"],
  ) => Promise<FunctionReturnType<Action>>;
};

export class Daytona {
  constructor(
    private readonly component: ComponentApi,
    private readonly options?: DaytonaOptions,
  ) {}

  private get config() {
    const apiKey = this.options?.apiKey ?? process.env.DAYTONA_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Daytona API key missing. Pass `apiKey` to the Daytona client or set the " +
          "DAYTONA_API_KEY environment variable on your Convex deployment " +
          "(npx convex env set DAYTONA_API_KEY ...).",
      );
    }
    return { apiKey, apiUrl: this.apiUrl };
  }

  private get apiUrl() {
    return this.options?.apiUrl ?? process.env.DAYTONA_API_URL;
  }

  // ---- Lifecycle ----

  /** Create a sandbox and (by default) wait until it's running. */
  async createSandbox(ctx: RunActionCtx, args: CreateSandboxArgs = {}) {
    return await ctx.runAction(this.component.sandboxes.create, {
      config: this.config,
      ...args,
    });
  }

  /** Start a stopped/archived sandbox and wait until it's running. */
  async startSandbox(
    ctx: RunActionCtx,
    args: { sandboxId: string; waitTimeoutMs?: number },
  ) {
    return await ctx.runAction(this.component.sandboxes.start, {
      config: this.config,
      ...args,
    });
  }

  /** Stop a running sandbox (filesystem is preserved). */
  async stopSandbox(
    ctx: RunActionCtx,
    args: { sandboxId: string; waitTimeoutMs?: number },
  ) {
    return await ctx.runAction(this.component.sandboxes.stop, {
      config: this.config,
      ...args,
    });
  }

  /** Delete a sandbox permanently. Its component record is kept, marked "destroyed". */
  async deleteSandbox(ctx: RunActionCtx, args: { sandboxId: string }) {
    return await ctx.runAction(this.component.sandboxes.remove, {
      config: this.config,
      ...args,
    });
  }

  /** Re-sync remote sandbox state into the component table. Null if the sandbox is gone. */
  async refreshSandbox(ctx: RunActionCtx, args: { sandboxId: string }) {
    return await ctx.runAction(this.component.sandboxes.refresh, {
      config: this.config,
      ...args,
    });
  }

  // ---- Reactive state (component tables — no Daytona API call) ----

  /** Last-observed sandbox record, or null. Reactive. */
  async getSandbox(ctx: RunQueryCtx, args: { sandboxId: string }) {
    return await ctx.runQuery(this.component.sandboxes.get, args);
  }

  /** Sandbox records, optionally scoped by `userKey` and/or `state`. Reactive. */
  async listSandboxes(
    ctx: RunQueryCtx,
    args: { userKey?: string; state?: string; limit?: number } = {},
  ) {
    return await ctx.runQuery(this.component.sandboxes.list, args);
  }

  /** Cursor-paginated sandbox records, with the same filters as `listSandboxes`. */
  async listSandboxesPaginated(
    ctx: RunQueryCtx,
    args: {
      userKey?: string;
      state?: string;
      paginationOpts: { numItems: number; cursor: string | null };
    },
  ) {
    return await ctx.runQuery(this.component.sandboxes.listPaginated, args);
  }

  /** Execution history for a sandbox, newest first. Reactive. */
  async listExecutions(
    ctx: RunQueryCtx,
    args: { sandboxId: string; limit?: number },
  ) {
    return await ctx.runQuery(this.component.executions.list, args);
  }

  /** A single execution record by ID, or null. Reactive. */
  async getExecution(ctx: RunQueryCtx, args: { executionId: string }) {
    return await ctx.runQuery(this.component.executions.get, {
      executionId: args.executionId as never,
    });
  }

  // ---- Execution ----

  /** Run a shell command in the sandbox. Records an execution row. */
  async run(ctx: RunActionCtx, args: RunCommandArgs) {
    return await ctx.runAction(this.component.process.run, {
      config: this.config,
      ...args,
    });
  }

  /** Run a code snippet (python/javascript/typescript). Records an execution row. */
  async runCode(ctx: RunActionCtx, args: RunCodeArgs) {
    return await ctx.runAction(this.component.process.runCode, {
      config: this.config,
      ...args,
    });
  }

  /**
   * Start a command in the background and return immediately with the
   * execution ID. No action is held open and the command isn't bound to
   * Convex's 10-minute ceiling: a scheduler-chained poller updates the
   * execution row (live logs while running, exit code + status when done) —
   * watch it reactively with `getExecution`/`listExecutions`.
   *
   * A running background command does not reset the sandbox's idle timer;
   * create sandboxes for long jobs with `autoStopInterval: 0`.
   *
   * The poller runs from the scheduler, so this doesn't use the client's API
   * key: it needs `DAYTONA_API_KEY` passed down to the component in your
   * `convex.config.ts` (see the README). The API URL is forwarded as usual.
   */
  async runBackground(
    ctx: RunActionCtx,
    args: {
      sandboxId: string;
      command: string;
      cwd?: string;
      envs?: Record<string, string>;
      autoStart?: boolean;
      /**
       * Mutation invoked when the execution reaches a terminal state
       * (completed, failed, or cancelled), with
       * `{ executionId, status, exitCode, result, error, context }`.
       */
      onComplete?: FunctionReference<"mutation", "public" | "internal">;
      /** Passed through to the onComplete handler as `context`. */
      onCompleteContext?: unknown;
      /** First poll delay and backoff floor in ms (default 1000, min 250). */
      minPollMs?: number;
      /** Backoff ceiling between polls in ms (default 10000, max 120000). */
      maxPollMs?: number;
    },
  ) {
    const { onComplete, ...rest } = args;
    return await ctx.runAction(this.component.process.runBackground, {
      ...rest,
      onComplete: onComplete
        ? await createFunctionHandle(onComplete)
        : undefined,
      apiUrl: this.apiUrl,
    });
  }

  /**
   * Cancel a running background execution: stops the command (kills its
   * session), marks the row "cancelled", and fires its onComplete handler.
   * Throws if the execution already reached a terminal state.
   */
  async cancelExecution(ctx: RunActionCtx, args: { executionId: string }) {
    return await ctx.runAction(this.component.process.cancelExecution, {
      executionId: args.executionId as never,
      apiUrl: this.apiUrl,
    });
  }

  /**
   * Delete terminal execution rows older than `olderThanMs`, in bounded
   * batches — call again while `hasMore` is true.
   */
  async purgeExecutions(
    ctx: RunMutationCtx,
    args: { olderThanMs: number; sandboxId?: string },
  ) {
    return await ctx.runMutation(this.component.executions.purge, args);
  }

  /**
   * Delete destroyed/errored sandbox rows older than `olderThanMs`, in
   * bounded batches — call again while `hasMore` is true. Remote sandboxes
   * are not touched.
   */
  async purgeSandboxes(ctx: RunMutationCtx, args: { olderThanMs: number }) {
    return await ctx.runMutation(this.component.sandboxes.purge, args);
  }

  // ---- Files ----

  /** Read a file from the sandbox as a UTF-8 string. */
  async readFile(ctx: RunActionCtx, args: { sandboxId: string; path: string }) {
    return await ctx.runAction(this.component.files.readFile, {
      config: this.config,
      ...args,
    });
  }

  /** Write a UTF-8 string to a file in the sandbox. */
  async writeFile(
    ctx: RunActionCtx,
    args: { sandboxId: string; path: string; content: string },
  ) {
    return await ctx.runAction(this.component.files.writeFile, {
      config: this.config,
      ...args,
    });
  }

  /**
   * Read a file's raw bytes — binary-safe for images, archives, PDFs, etc.
   * Use `readFile` for text. Bounded by Convex's function argument/return
   * size limits.
   */
  async readFileBytes(
    ctx: RunActionCtx,
    args: { sandboxId: string; path: string },
  ): Promise<ArrayBuffer> {
    return await ctx.runAction(this.component.files.readFileBytes, {
      config: this.config,
      ...args,
    });
  }

  /** Write raw bytes to a file in the sandbox (binary-safe). */
  async writeFileBytes(
    ctx: RunActionCtx,
    args: { sandboxId: string; path: string; content: ArrayBuffer },
  ) {
    return await ctx.runAction(this.component.files.writeFileBytes, {
      config: this.config,
      ...args,
    });
  }

  /** List a directory in the sandbox. */
  async listFiles(
    ctx: RunActionCtx,
    args: { sandboxId: string; path: string },
  ) {
    return await ctx.runAction(this.component.files.listFiles, {
      config: this.config,
      ...args,
    });
  }

  /** Delete a file (or directory, with `recursive`) in the sandbox. */
  async deleteFile(
    ctx: RunActionCtx,
    args: { sandboxId: string; path: string; recursive?: boolean },
  ) {
    return await ctx.runAction(this.component.files.deleteFile, {
      config: this.config,
      ...args,
    });
  }

  // ---- Preview ----

  /** Get a preview URL for a port. Signed URLs (default) embed a short-lived token. */
  async getPreviewUrl(
    ctx: RunActionCtx,
    args: {
      sandboxId: string;
      port: number;
      signed?: boolean;
      expiresInSeconds?: number;
    },
  ) {
    return await ctx.runAction(this.component.sandboxes.previewUrl, {
      config: this.config,
      ...args,
    });
  }
}

export type { ComponentApi };
