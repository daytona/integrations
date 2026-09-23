/// <reference types="vite/client" />

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";

const config = { apiKey: "test-key", apiUrl: "https://daytona.test/api" };

/** Build a fetch stub that routes by method + URL substring. */
function stubFetch(
  routes: Array<{
    method: string;
    match: string;
    response: () => Response;
  }>,
) {
  const calls: Array<{
    method: string;
    url: string;
    body?: string;
    headers: Record<string, string>;
  }> = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      body: typeof init?.body === "string" ? init.body : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const route = routes.find(
      (r) => r.method === method && url.includes(r.match),
    );
    if (!route) {
      return new Response(`no stub for ${method} ${url}`, { status: 500 });
    }
    return route.response();
  });
  vi.stubGlobal("fetch", mock);
  return { calls, mock };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const startedSandbox = {
  id: "sbx-1",
  state: "started",
  toolboxProxyUrl: "https://proxy.daytona.test/toolbox",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("state bookkeeping (queries + internal mutations)", () => {
  test("upsertSandbox inserts then patches without clearing fields", async () => {
    const t = initConvexTest();
    await t.mutation(internal.lib.upsertSandbox, {
      sandboxId: "sbx-1",
      state: "creating",
      snapshot: "snap-a",
      userKey: "user-1",
    });
    await t.mutation(internal.lib.upsertSandbox, {
      sandboxId: "sbx-1",
      state: "started",
    });

    const sandbox = await t.query(api.lib.get, { sandboxId: "sbx-1" });
    expect(sandbox?.state).toBe("started");
    // Partial update must not clear previously known fields.
    expect(sandbox?.snapshot).toBe("snap-a");
    expect(sandbox?.userKey).toBe("user-1");
  });

  test("list scopes by userKey", async () => {
    const t = initConvexTest();
    await t.mutation(internal.lib.upsertSandbox, {
      sandboxId: "sbx-1",
      state: "started",
      userKey: "user-1",
    });
    await t.mutation(internal.lib.upsertSandbox, {
      sandboxId: "sbx-2",
      state: "started",
      userKey: "user-2",
    });

    expect(await t.query(api.lib.list, {})).toHaveLength(2);
    const scoped = await t.query(api.lib.list, { userKey: "user-1" });
    expect(scoped).toHaveLength(1);
    expect(scoped[0].sandboxId).toBe("sbx-1");
  });

  test("execution lifecycle: running → completed", async () => {
    const t = initConvexTest();
    const executionId = await t.mutation(internal.lib.startExecution, {
      sandboxId: "sbx-1",
      kind: "command",
      input: "echo hi",
    });
    let execution = await t.query(api.lib.getExecution, { executionId });
    expect(execution?.status).toBe("running");

    await t.mutation(internal.lib.finishExecution, {
      executionId,
      status: "completed",
      exitCode: 0,
      result: "hi",
    });
    execution = await t.query(api.lib.getExecution, { executionId });
    expect(execution?.status).toBe("completed");
    expect(execution?.exitCode).toBe(0);
    expect(execution?.finishedAt).toBeDefined();

    const history = await t.query(api.lib.listExecutions, {
      sandboxId: "sbx-1",
    });
    expect(history).toHaveLength(1);
  });
});

describe("sandbox lifecycle actions", () => {
  test("create records the sandbox and waits for started", async () => {
    const t = initConvexTest();
    let polls = 0;
    stubFetch([
      {
        method: "POST",
        match: "/api/sandbox",
        response: () => json({ id: "sbx-1", state: "creating" }),
      },
      {
        method: "GET",
        match: "/api/sandbox/sbx-1",
        response: () =>
          json(++polls < 2 ? { id: "sbx-1", state: "creating" } : startedSandbox),
      },
    ]);

    const result = await t.action(api.sandboxes.create, {
      config,
      snapshot: "snap-a",
      userKey: "user-1",
    });
    expect(result).toEqual({ sandboxId: "sbx-1", state: "started" });

    const sandbox = await t.query(api.lib.get, { sandboxId: "sbx-1" });
    expect(sandbox?.state).toBe("started");
    expect(sandbox?.userKey).toBe("user-1");
  });

  test("create rejects resources without image, and snapshot+image together", async () => {
    const t = initConvexTest();
    stubFetch([]);

    await expect(
      t.action(api.sandboxes.create, { config, cpu: 2 }),
    ).rejects.toThrow(/only valid with image-based creation/);
    await expect(
      t.action(api.sandboxes.create, {
        config,
        snapshot: "snap-a",
        image: "python:3.12",
      }),
    ).rejects.toThrow(/not both/);
  });

  test("create from image sends buildInfo and allows resources", async () => {
    const t = initConvexTest();
    const { calls } = stubFetch([
      {
        method: "POST",
        match: "/api/sandbox",
        response: () => json({ id: "sbx-img", state: "pending_build" }),
      },
      {
        method: "GET",
        match: "/api/sandbox/sbx-img",
        response: () => json({ id: "sbx-img", state: "started" }),
      },
    ]);

    const result = await t.action(api.sandboxes.create, {
      config,
      image: "python:3.12",
      cpu: 2,
      memory: 4,
    });
    expect(result).toEqual({ sandboxId: "sbx-img", state: "started" });

    const createCall = calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/api/sandbox"),
    );
    expect(JSON.parse(createCall?.body ?? "{}")).toMatchObject({
      buildInfo: { dockerfileContent: "FROM python:3.12" },
      cpu: 2,
      memory: 4,
    });
  });

  test("create surfaces failure states and records the error", async () => {
    const t = initConvexTest();
    stubFetch([
      {
        method: "POST",
        match: "/api/sandbox",
        response: () => json({ id: "sbx-1", state: "creating" }),
      },
      {
        method: "GET",
        match: "/api/sandbox/sbx-1",
        response: () =>
          json({ id: "sbx-1", state: "build_failed", errorReason: "bad image" }),
      },
    ]);

    await expect(
      t.action(api.sandboxes.create, { config }),
    ).rejects.toThrow(/build_failed/);
    const sandbox = await t.query(api.lib.get, { sandboxId: "sbx-1" });
    expect(sandbox?.lastError).toMatch(/build_failed/);
  });

  test("refresh returns null and marks destroyed on 404", async () => {
    const t = initConvexTest();
    await t.mutation(internal.lib.upsertSandbox, {
      sandboxId: "sbx-gone",
      state: "started",
    });
    stubFetch([
      {
        method: "GET",
        match: "/api/sandbox/sbx-gone",
        response: () => new Response("not found", { status: 404 }),
      },
    ]);

    const result = await t.action(api.sandboxes.refresh, {
      config,
      sandboxId: "sbx-gone",
    });
    expect(result).toBeNull();
    const sandbox = await t.query(api.lib.get, { sandboxId: "sbx-gone" });
    expect(sandbox?.state).toBe("destroyed");
  });

  test("stop treats an already-deleted sandbox (404) as destroyed", async () => {
    const t = initConvexTest();
    await t.mutation(internal.lib.upsertSandbox, {
      sandboxId: "sbx-ephemeral",
      state: "started",
    });
    stubFetch([
      {
        method: "POST",
        match: "/api/sandbox/sbx-ephemeral/stop",
        response: () => new Response("not found", { status: 404 }),
      },
    ]);

    const result = await t.action(api.sandboxes.stop, {
      config,
      sandboxId: "sbx-ephemeral",
    });
    expect(result).toEqual({ sandboxId: "sbx-ephemeral", state: "destroyed" });
    const sandbox = await t.query(api.lib.get, { sandboxId: "sbx-ephemeral" });
    expect(sandbox?.state).toBe("destroyed");
  });

  test("previewUrl returns signed URL fields", async () => {
    const t = initConvexTest();
    stubFetch([
      {
        method: "GET",
        match: "/ports/3000/signed-preview-url",
        response: () =>
          json({ url: "https://3000-sbx-1.preview.daytona.test?tkn=abc", port: 3000 }),
      },
    ]);

    const result = await t.action(api.sandboxes.previewUrl, {
      config,
      sandboxId: "sbx-1",
      port: 3000,
    });
    expect(result.url).toContain("preview.daytona.test");
    expect(result.port).toBe(3000);
  });
});

describe("process actions", () => {
  test("run executes via the toolbox and records a completed execution", async () => {
    const t = initConvexTest();
    const { calls } = stubFetch([
      {
        method: "GET",
        match: "/api/sandbox/sbx-1",
        response: () => json(startedSandbox),
      },
      {
        method: "POST",
        match: "/process/execute",
        response: () => json({ exitCode: 0, result: "hello\n" }),
      },
    ]);

    const result = await t.action(api.process.run, {
      config,
      sandboxId: "sbx-1",
      command: "echo hello",
    });
    expect(result.exitCode).toBe(0);
    expect(result.result).toBe("hello\n");

    // Toolbox URL is composed as {toolboxProxyUrl}/{sandboxId}{path}.
    const executeCall = calls.find((c) => c.url.includes("/process/execute"));
    expect(executeCall?.url).toBe(
      "https://proxy.daytona.test/toolbox/sbx-1/process/execute",
    );
    expect(executeCall?.headers.Authorization).toBe("Bearer test-key");
    expect(JSON.parse(executeCall?.body ?? "{}")).toMatchObject({
      command: "echo hello",
      // Default timeout is bounded below Convex's 10-minute action ceiling.
      timeout: 540,
    });

    const history = await t.query(api.lib.listExecutions, {
      sandboxId: "sbx-1",
    });
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("completed");
    expect(history[0].result).toBe("hello\n");
  });

  test("run records a failed execution when the toolbox errors", async () => {
    const t = initConvexTest();
    stubFetch([
      {
        method: "GET",
        match: "/api/sandbox/sbx-1",
        response: () => json(startedSandbox),
      },
      {
        method: "POST",
        match: "/process/execute",
        response: () => new Response("boom", { status: 500 }),
      },
    ]);

    await expect(
      t.action(api.process.run, {
        config,
        sandboxId: "sbx-1",
        command: "exit 1",
      }),
    ).rejects.toThrow(/500/);

    const history = await t.query(api.lib.listExecutions, {
      sandboxId: "sbx-1",
    });
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("failed");
    expect(history[0].error).toMatch(/500/);
  });

  test("runCode posts to code-run and records kind=code", async () => {
    const t = initConvexTest();
    const { calls } = stubFetch([
      {
        method: "GET",
        match: "/api/sandbox/sbx-1",
        response: () => json(startedSandbox),
      },
      {
        method: "POST",
        match: "/process/code-run",
        response: () => json({ exitCode: 0, result: "42" }),
      },
    ]);

    const result = await t.action(api.process.runCode, {
      config,
      sandboxId: "sbx-1",
      code: "print(42)",
      language: "python",
    });
    expect(result.result).toBe("42");
    const call = calls.find((c) => c.url.includes("/process/code-run"));
    expect(JSON.parse(call?.body ?? "{}")).toMatchObject({
      code: "print(42)",
      language: "python",
    });

    const history = await t.query(api.lib.listExecutions, {
      sandboxId: "sbx-1",
    });
    expect(history[0].kind).toBe("code");
  });

  test("run auto-starts a stopped sandbox before executing", async () => {
    const t = initConvexTest();
    let state = "stopped";
    const { calls } = stubFetch([
      {
        method: "GET",
        match: "/api/sandbox/sbx-1",
        response: () => json({ ...startedSandbox, state }),
      },
      {
        method: "POST",
        match: "/api/sandbox/sbx-1/start",
        response: () => {
          state = "started";
          return json({});
        },
      },
      {
        method: "POST",
        match: "/process/execute",
        response: () => json({ exitCode: 0, result: "ok" }),
      },
    ]);

    const result = await t.action(api.process.run, {
      config,
      sandboxId: "sbx-1",
      command: "true",
    });
    expect(result.exitCode).toBe(0);
    expect(calls.some((c) => c.url.endsWith("/sandbox/sbx-1/start"))).toBe(true);
  });
});

describe("file actions", () => {
  test("readFile and writeFile round-trip through the toolbox", async () => {
    const t = initConvexTest();
    const { calls } = stubFetch([
      {
        method: "GET",
        match: "/api/sandbox/sbx-1",
        response: () => json(startedSandbox),
      },
      {
        method: "POST",
        match: "/files/upload-v2",
        response: () => new Response("", { status: 200 }),
      },
      {
        method: "GET",
        match: "/files/download",
        response: () => new Response("file-content"),
      },
    ]);

    await t.action(api.files.writeFile, {
      config,
      sandboxId: "sbx-1",
      path: "/home/daytona/hello.txt",
      content: "file-content",
    });
    const content = await t.action(api.files.readFile, {
      config,
      sandboxId: "sbx-1",
      path: "/home/daytona/hello.txt",
    });
    expect(content).toBe("file-content");

    const upload = calls.find((c) => c.url.includes("/files/upload-v2"));
    expect(upload?.url).toContain("path=%2Fhome%2Fdaytona%2Fhello.txt");
  });

  test("listFiles maps toolbox file info", async () => {
    const t = initConvexTest();
    stubFetch([
      {
        method: "GET",
        match: "/api/sandbox/sbx-1",
        response: () => json(startedSandbox),
      },
      {
        method: "GET",
        match: "/files?",
        response: () =>
          json([
            { name: "src", isDir: true, extra: "dropped" },
            { name: "main.py", isDir: false, size: 12 },
          ]),
      },
    ]);

    const files = await t.action(api.files.listFiles, {
      config,
      sandboxId: "sbx-1",
      path: "/home/daytona",
    });
    expect(files).toEqual([
      { name: "src", isDir: true, size: undefined, modTime: undefined },
      { name: "main.py", isDir: false, size: 12, modTime: undefined },
    ]);
  });
});
