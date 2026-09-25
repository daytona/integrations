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
