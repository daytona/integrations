/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    executions: {
      get: FunctionReference<
        "query",
        "internal",
        { executionId: string },
        null | {
          _creationTime: number;
          _id: string;
          cwd?: string;
          error?: string;
          exitCode?: number;
          finishedAt?: number;
          input: string;
          kind: "command" | "code";
          result?: string;
          sandboxId: string;
          startedAt: number;
          status: "running" | "completed" | "failed";
        },
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        { limit?: number; sandboxId: string },
        Array<{
          _creationTime: number;
          _id: string;
          cwd?: string;
          error?: string;
          exitCode?: number;
          finishedAt?: number;
          input: string;
          kind: "command" | "code";
          result?: string;
          sandboxId: string;
          startedAt: number;
          status: "running" | "completed" | "failed";
        }>,
        Name
      >;
    };
    files: {
      deleteFile: FunctionReference<
        "action",
        "internal",
        {
          config: { apiKey: string; apiUrl?: string };
          path: string;
          recursive?: boolean;
          sandboxId: string;
        },
        null,
        Name
      >;
      listFiles: FunctionReference<
        "action",
        "internal",
        {
          config: { apiKey: string; apiUrl?: string };
          path: string;
          sandboxId: string;
        },
        Array<{
          isDir: boolean;
          modTime?: string;
          name: string;
          size?: number;
        }>,
        Name
      >;
      readFile: FunctionReference<
        "action",
        "internal",
        {
          config: { apiKey: string; apiUrl?: string };
          path: string;
          sandboxId: string;
        },
        string,
        Name
      >;
      writeFile: FunctionReference<
        "action",
        "internal",
        {
          config: { apiKey: string; apiUrl?: string };
          content: string;
          path: string;
          sandboxId: string;
        },
        null,
        Name
      >;
    };
    process: {
      run: FunctionReference<
        "action",
        "internal",
        {
          autoStart?: boolean;
          command: string;
          config: { apiKey: string; apiUrl?: string };
          cwd?: string;
          envs?: Record<string, string>;
          sandboxId: string;
          timeoutSeconds?: number;
        },
        { executionId: string; exitCode: number; result: string },
        Name
      >;
      runCode: FunctionReference<
        "action",
        "internal",
        {
          argv?: Array<string>;
          autoStart?: boolean;
          code: string;
          config: { apiKey: string; apiUrl?: string };
          envs?: Record<string, string>;
          language: string;
          sandboxId: string;
          timeoutSeconds?: number;
        },
        { executionId: string; exitCode: number; result: string },
        Name
      >;
    };
    sandboxes: {
      create: FunctionReference<
        "action",
        "internal",
        {
          autoArchiveInterval?: number;
          autoDeleteInterval?: number;
          autoStopInterval?: number;
          config: { apiKey: string; apiUrl?: string };
          cpu?: number;
          disk?: number;
          envVars?: Record<string, string>;
          image?: string;
          labels?: Record<string, string>;
          memory?: number;
          name?: string;
          public?: boolean;
          snapshot?: string;
          target?: string;
          user?: string;
          userKey?: string;
          wait?: boolean;
          waitTimeoutMs?: number;
        },
        { sandboxId: string; state: string },
        Name
      >;
      get: FunctionReference<
        "query",
        "internal",
        { sandboxId: string },
        null | {
          _creationTime: number;
          _id: string;
          createdAt: number;
          labels?: Record<string, string>;
          lastError?: string;
          name?: string;
          public?: boolean;
          sandboxId: string;
          snapshot?: string;
          state: string;
          target?: string;
          updatedAt: number;
          userKey?: string;
        },
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        { limit?: number; userKey?: string },
        Array<{
          _creationTime: number;
          _id: string;
          createdAt: number;
          labels?: Record<string, string>;
          lastError?: string;
          name?: string;
          public?: boolean;
          sandboxId: string;
          snapshot?: string;
          state: string;
          target?: string;
          updatedAt: number;
          userKey?: string;
        }>,
        Name
      >;
      previewUrl: FunctionReference<
        "action",
        "internal",
        {
          config: { apiKey: string; apiUrl?: string };
          expiresInSeconds?: number;
          port: number;
          sandboxId: string;
          signed?: boolean;
        },
        { port: number; token?: string; url: string },
        Name
      >;
      refresh: FunctionReference<
        "action",
        "internal",
        { config: { apiKey: string; apiUrl?: string }; sandboxId: string },
        null | { sandboxId: string; state: string },
        Name
      >;
      remove: FunctionReference<
        "action",
        "internal",
        { config: { apiKey: string; apiUrl?: string }; sandboxId: string },
        null,
        Name
      >;
      start: FunctionReference<
        "action",
        "internal",
        {
          config: { apiKey: string; apiUrl?: string };
          sandboxId: string;
          waitTimeoutMs?: number;
        },
        { sandboxId: string; state: string },
        Name
      >;
      stop: FunctionReference<
        "action",
        "internal",
        {
          config: { apiKey: string; apiUrl?: string };
          sandboxId: string;
          waitTimeoutMs?: number;
        },
        { sandboxId: string; state: string },
        Name
      >;
    };
  };
