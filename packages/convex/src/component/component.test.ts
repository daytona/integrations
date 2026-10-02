/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
    await t.mutation(internal.sandboxes.upsertSandbox, {
      sandboxId: "sbx-1",
      state: "creating",
      snapshot: "snap-a",
      userKey: "user-1",
    });
    await t.mutation(internal.sandboxes.upsertSandbox, {
      sandboxId: "sbx-1",
      state: "started",
    });

    const sandbox = await t.query(api.sandboxes.get, { sandboxId: "sbx-1" });
    expect(sandbox?.state).toBe("started");
    // Partial update must not clear previously known fields.
    expect(sandbox?.snapshot).toBe("snap-a");
    expect(sandbox?.userKey).toBe("user-1");
  });

  test("list scopes by userKey", async () => {
    const t = initConvexTest();
    await t.mutation(internal.sandboxes.upsertSandbox, {
      sandboxId: "sbx-1",
      state: "started",
      userKey: "user-1",
    });
    await t.mutation(internal.sandboxes.upsertSandbox, {
      sandboxId: "sbx-2",
      state: "started",
      userKey: "user-2",
    });

    expect(await t.query(api.sandboxes.list, {})).toHaveLength(2);
    const scoped = await t.query(api.sandboxes.list, { userKey: "user-1" });
    expect(scoped).toHaveLength(1);
    expect(scoped[0].sandboxId).toBe("sbx-1");
  });

  test("execution lifecycle: running → completed", async () => {
    const t = initConvexTest();
    const executionId = await t.mutation(internal.executions.startExecution, {
      sandboxId: "sbx-1",
      kind: "command",
      input: "echo hi",
    });
    let execution = await t.query(api.executions.get, { executionId });
    expect(execution?.status).toBe("running");

    await t.mutation(internal.executions.finishExecution, {
      executionId,
      status: "completed",
      exitCode: 0,
      result: "hi",
    });
    execution = await t.query(api.executions.get, { executionId });
    expect(execution?.status).toBe("completed");
    expect(execution?.exitCode).toBe(0);
    expect(execution?.finishedAt).toBeDefined();

    const history = await t.query(api.executions.list, {
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

    const sandbox = await t.query(api.sandboxes.get, { sandboxId: "sbx-1" });
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
    const sandbox = await t.query(api.sandboxes.get, { sandboxId: "sbx-1" });
    expect(sandbox?.lastError).toMatch(/build_failed/);
  });

  test("refresh returns null and marks destroyed on 404", async () => {
    const t = initConvexTest();
    await t.mutation(internal.sandboxes.upsertSandbox, {
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
    const sandbox = await t.query(api.sandboxes.get, { sandboxId: "sbx-gone" });
    expect(sandbox?.state).toBe("destroyed");
  });

  test("stop treats an already-deleted sandbox (404) as destroyed", async () => {
    const t = initConvexTest();
    await t.mutation(internal.sandboxes.upsertSandbox, {
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
    const sandbox = await t.query(api.sandboxes.get, { sandboxId: "sbx-ephemeral" });
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

    const history = await t.query(api.executions.list, {
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

    const history = await t.query(api.executions.list, {
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

    const history = await t.query(api.executions.list, {
      sandboxId: "sbx-1",
    });
    expect(history[0].kind).toBe("code");
  });

  test("run rejects non-positive timeoutSeconds", async () => {
    const t = initConvexTest();
    stubFetch([]);
    await expect(
      t.action(api.process.run, {
        config,
        sandboxId: "sbx-1",
        command: "true",
        timeoutSeconds: -5,
      }),
    ).rejects.toThrow(/positive number/);
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

describe("background execution", () => {
  // runBackground reads the key from the component's env vars (passed down by
  // the app in convex.config.ts). convex-test runs everything in this process,
  // so the component sees process.env directly.
  beforeEach(() => {
    process.env.DAYTONA_API_KEY = config.apiKey;
    process.env.DAYTONA_API_URL = config.apiUrl;
  });

  afterEach(() => {
    delete process.env.DAYTONA_API_KEY;
    delete process.env.DAYTONA_API_URL;
  });

  const sessionRoutes = (commandDone: () => boolean, exitCode = 0) => [
    {
      method: "GET",
      match: "/api/sandbox/sbx-1",
      response: () => json(startedSandbox),
    },
    {
      method: "POST",
      match: "/process/session/convex-exec-",
      response: () => json({ cmdId: "cmd-1" }),
    },
    {
      method: "POST",
      match: "/process/session",
      response: () => json({}),
    },
    {
      // The toolbox serves logs as text/plain.
      method: "GET",
      match: "/command/cmd-1/logs",
      response: () => new Response("partial output\n"),
    },
    {
      method: "GET",
      match: "/command/cmd-1",
      response: () =>
        json(
          commandDone()
            ? { id: "cmd-1", command: "sleep 5", exitCode }
            : { id: "cmd-1", command: "sleep 5" },
        ),
    },
    {
      method: "DELETE",
      match: "/process/session/convex-exec-",
      response: () => new Response("", { status: 200 }),
    },
  ];

  type Test = ReturnType<typeof initConvexTest>;

  const scheduledPolls = (t: Test) =>
    t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).map(
        (job) => job.args,
      ),
    );

  /** A running background execution as 1.1.0 left it, mid-poll. */
  const legacyExecution = (t: Test) =>
    t.run(
      async (ctx) =>
        await ctx.db.insert("executions", {
          sandboxId: "sbx-1",
          kind: "command",
          input: "sleep 5",
          status: "running",
          sessionId: "convex-exec-legacy",
          commandId: "cmd-1",
          startedAt: Date.now(),
        }),
    );

  test("runBackground starts a session command and returns immediately", async () => {
    const t = initConvexTest();
    const { calls } = stubFetch(sessionRoutes(() => false));

    const { executionId } = await t.action(api.process.runBackground, {
      sandboxId: "sbx-1",
      command: "sleep 5 && echo done",
      cwd: "/home/daytona",
    });

    const execution = await t.query(api.executions.get, { executionId });
    expect(execution?.status).toBe("running");
    expect(execution?.sessionId).toContain("convex-exec-");
    expect(execution?.commandId).toBe("cmd-1");

    const exec = calls.find((c) => c.url.includes("/exec"));
    const body = JSON.parse(exec?.body ?? "{}");
    expect(body.runAsync).toBe(true);
    // cwd is composed into the command — sessions have no cwd param.
    expect(body.command).toBe("cd '/home/daytona' && sleep 5 && echo done");
  });

  test("pollExecution patches logs while running, finishes on exit", async () => {
    const t = initConvexTest();
    let done = false;
    stubFetch(sessionRoutes(() => done));

    const { executionId } = await t.action(api.process.runBackground, {
      sandboxId: "sbx-1",
      command: "sleep 5",
    });

    await t.action(internal.process.pollExecution, {
      executionId,
      delayMs: 1000,
      failures: 0,
    });
    let execution = await t.query(api.executions.get, { executionId });
    expect(execution?.status).toBe("running");
    expect(execution?.result).toBe("partial output\n");

    done = true;
    await t.action(internal.process.pollExecution, {
      executionId,
      delayMs: 1000,
      failures: 0,
    });
    execution = await t.query(api.executions.get, { executionId });
    expect(execution?.status).toBe("completed");
    expect(execution?.exitCode).toBe(0);
    expect(execution?.finishedAt).toBeDefined();
  });

  test("runBackground rejects shell-unsafe env var names", async () => {
    const t = initConvexTest();
    stubFetch(sessionRoutes(() => false));
    await expect(
      t.action(api.process.runBackground, {
        sandboxId: "sbx-1",
        command: "true",
        envs: { "X=1; touch /tmp/pwn; #": "oops" },
      }),
    ).rejects.toThrow(/Invalid environment variable name/);
  });

  test("pollExecution marks failed on non-zero exit", async () => {
    const t = initConvexTest();
    stubFetch(sessionRoutes(() => true, 2));

    const { executionId } = await t.action(api.process.runBackground, {
      sandboxId: "sbx-1",
      command: "false",
    });
    await t.action(internal.process.pollExecution, {
      executionId,
      delayMs: 1000,
      failures: 0,
    });
    const execution = await t.query(api.executions.get, { executionId });
    expect(execution?.status).toBe("failed");
    expect(execution?.exitCode).toBe(2);
  });

  test("scheduled polls never carry the API key", async () => {
    const t = initConvexTest();
    stubFetch(sessionRoutes(() => false));

    const { executionId } = await t.action(api.process.runBackground, {
      sandboxId: "sbx-1",
      command: "sleep 5",
    });
    // Still running: reschedules with backoff.
    await t.action(internal.process.pollExecution, {
      executionId,
      delayMs: 1000,
      failures: 0,
    });
    // Daytona unreachable: reschedules on the failure path.
    stubFetch([]);
    await t.action(internal.process.pollExecution, {
      executionId,
      delayMs: 1000,
      failures: 0,
    });

    const polls = await scheduledPolls(t);
    expect(polls).toHaveLength(3);
    expect(JSON.stringify(polls)).not.toContain(config.apiKey);
  });

  test("runBackground needs the key passed down to the component", async () => {
    const t = initConvexTest();
    const { calls } = stubFetch(sessionRoutes(() => false));
    delete process.env.DAYTONA_API_KEY;

    await expect(
      t.action(api.process.runBackground, {
        sandboxId: "sbx-1",
        command: "sleep 5",
      }),
    ).rejects.toThrow(/DAYTONA_API_KEY: app\.env\.DAYTONA_API_KEY/);
    // Checked before anything is recorded or started.
    expect(await t.query(api.executions.list, { sandboxId: "sbx-1" })).toEqual(
      [],
    );
    expect(calls).toEqual([]);
  });

  test("polls pick up a rotated key", async () => {
    const t = initConvexTest();
    let done = false;
    const { calls } = stubFetch(sessionRoutes(() => done));
    const { executionId } = await t.action(api.process.runBackground, {
      sandboxId: "sbx-1",
      command: "sleep 5",
    });

    // `npx convex env set DAYTONA_API_KEY ...` while the command runs, then
    // the poll runBackground scheduled fires with its stored args.
    process.env.DAYTONA_API_KEY = "rotated-key";
    const [[pollArgs]] = await scheduledPolls(t);
    const before = calls.length;
    done = true;
    await t.action(internal.process.pollExecution, pollArgs);

    expect((await t.query(api.executions.get, { executionId }))?.status).toBe(
      "completed",
    );
    // Status, logs and the session cleanup all used the new key.
    const pollCalls = calls.slice(before);
    expect(pollCalls.map((c) => c.method)).toContain("DELETE");
    expect(new Set(pollCalls.map((c) => c.headers.Authorization))).toEqual(
      new Set(["Bearer rotated-key"]),
    );
  });

  test("polls scheduled by 1.1.0 keep going without passing the key on", async () => {
    const t = initConvexTest();
    const { calls } = stubFetch(sessionRoutes(() => false));
    const executionId = await legacyExecution(t);

    // 1.1.0 scheduled its polls with the config in their args.
    await t.action(internal.process.pollExecution, {
      config: { ...config, apiKey: "old-key" },
      executionId,
      delayMs: 1000,
      failures: 0,
    });

    expect((await t.query(api.executions.get, { executionId }))?.result).toBe(
      "partial output\n",
    );
    // It polls with the key passed down to the component, not the old one...
    expect(new Set(calls.map((c) => c.headers.Authorization))).toEqual(
      new Set([`Bearer ${config.apiKey}`]),
    );
    // ...and the next poll doesn't carry either.
    const polls = await scheduledPolls(t);
    expect(polls).toHaveLength(1);
    expect(JSON.stringify(polls)).not.toMatch(/old-key|test-key/);
  });

  test("without a key, a 1.1.0 poll kills its session and fails the execution", async () => {
    const t = initConvexTest();
    const { calls } = stubFetch(sessionRoutes(() => false));
    const executionId = await legacyExecution(t);
    delete process.env.DAYTONA_API_KEY;

    await t.action(internal.process.pollExecution, {
      config: { ...config, apiKey: "old-key" },
      executionId,
      delayMs: 1000,
      failures: 0,
    });

    const execution = await t.query(api.executions.get, { executionId });
    expect(execution?.status).toBe("failed");
    expect(execution?.error).toMatch(/passed down to the component/);
    const cleanup = calls.find((c) => c.method === "DELETE");
    expect(cleanup?.url).toContain("/process/session/convex-exec-legacy");
    expect(cleanup?.headers.Authorization).toBe("Bearer old-key");
    expect(await scheduledPolls(t)).toHaveLength(0);
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
