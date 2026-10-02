/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";

function stubDaytonaApi() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("/process/execute")) {
        return new Response(JSON.stringify({ exitCode: 0, result: "hi\n" }));
      }
      if (method === "POST" && url.endsWith("/api/sandbox")) {
        return new Response(JSON.stringify({ id: "sbx-1", state: "creating" }));
      }
      if (method === "GET" && url.includes("/api/sandbox/sbx-1")) {
        return new Response(
          JSON.stringify({
            id: "sbx-1",
            state: "started",
            toolboxProxyUrl: "https://proxy.daytona.test/toolbox",
          }),
        );
      }
      return new Response(`no stub for ${method} ${url}`, { status: 500 });
    }),
  );
}

beforeEach(() => {
  process.env.DAYTONA_API_KEY = "test-key";
  process.env.DAYTONA_API_URL = "https://daytona.test/api";
  stubDaytonaApi();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DAYTONA_API_KEY;
  delete process.env.DAYTONA_API_URL;
});

describe("example app (full consumer path: app → client → component)", () => {
  test("createSandbox, runCommand, and reactive queries", async () => {
    const t = initConvexTest();

    const created = await t.action(api.example.createSandbox, {});
    expect(created).toEqual({ sandboxId: "sbx-1", state: "started" });

    const execution = await t.action(api.example.runCommand, {
      sandboxId: "sbx-1",
      command: "echo hi",
    });
    expect(execution.exitCode).toBe(0);
    expect(execution.result).toBe("hi\n");

    const sandboxes = await t.query(api.example.sandboxes, {});
    expect(sandboxes).toHaveLength(1);
    expect(sandboxes[0].state).toBe("started");

    const executions = await t.query(api.example.executions, {
      sandboxId: "sbx-1",
    });
    expect(executions).toHaveLength(1);
    expect(executions[0].status).toBe("completed");
  });
});

describe("onComplete callbacks (app mutation invoked by the component)", () => {
  let commandDone = false;

  function stubSessionApi() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (method === "GET" && url.includes("/api/sandbox/sbx-1")) {
          return new Response(
            JSON.stringify({
              id: "sbx-1",
              state: "started",
              toolboxProxyUrl: "https://proxy.daytona.test/toolbox",
            }),
          );
        }
        if (method === "POST" && url.includes("/exec")) {
          return new Response(JSON.stringify({ cmdId: "cmd-1" }));
        }
        if (method === "POST" && url.endsWith("/process/session")) {
          return new Response("{}");
        }
        if (method === "GET" && url.includes("/command/cmd-1/logs")) {
          return new Response("build ok\n");
        }
        if (method === "GET" && url.includes("/command/cmd-1")) {
          return new Response(
            JSON.stringify(
              commandDone
                ? { id: "cmd-1", command: "cargo build", exitCode: 0 }
                : { id: "cmd-1", command: "cargo build" },
            ),
          );
        }
        if (method === "DELETE" && url.includes("/process/session/")) {
          return new Response("", { status: 200 });
        }
        return new Response(`no stub for ${method} ${url}`, { status: 500 });
      }),
    );
  }

  beforeEach(() => {
    vi.useFakeTimers();
    commandDone = false;
    stubSessionApi();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("fires with the outcome and context when the command completes", async () => {
    const t = initConvexTest();
    const { executionId } = await t.action(api.example.runBackgroundCommand, {
      sandboxId: "sbx-1",
      command: "cargo build",
      withCallback: true,
    });

    commandDone = true;
    // Runs the component's scheduled poller to completion, which invokes the
    // app's backgroundFinished mutation through the stored function handle.
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const notifications = await t.query(api.example.notifications, {});
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      executionId,
      status: "completed",
      exitCode: 0,
      context: { source: "example" },
    });
  });

  test("fires exactly once with status cancelled on cancellation", async () => {
    const t = initConvexTest();
    const { executionId } = await t.action(api.example.runBackgroundCommand, {
      sandboxId: "sbx-1",
      command: "sleep 600",
      withCallback: true,
    });

    await t.action(api.example.cancelBackgroundCommand, { executionId });
    // The poll that was already scheduled must see the terminal row and
    // neither overwrite it nor notify a second time.
    commandDone = true;
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const notifications = await t.query(api.example.notifications, {});
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      executionId,
      status: "cancelled",
      context: { source: "example" },
    });
    expect(notifications[0].exitCode).toBeUndefined();
  });
});
