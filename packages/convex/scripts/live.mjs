/**
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Live end-to-end test: runs the example app on a real (anonymous local)
 * Convex deployment against real Daytona sandboxes. Exercises the component
 * inside Convex's actual runtime — which convex-test's edge-runtime simulation
 * cannot fully match (e.g. it caught a `URLSearchParams.size` incompatibility
 * that dropped query strings). Needs DAYTONA_API_KEY.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const apiKey = process.env.DAYTONA_API_KEY;
if (!apiKey) {
  console.error("DAYTONA_API_KEY is required for live tests");
  process.exit(1);
}

// Invoke the locally installed Convex CLI through the current Node binary —
// no npx, no shell: works identically on every platform and never re-parses
// JSON arguments through cmd.exe.
const convexBin = join(
  dirname(createRequire(import.meta.url).resolve("convex/package.json")),
  "bin/main.js",
);

const convex = (...args) =>
  execFileSync(process.execPath, [convexBin, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    timeout: 300_000,
  });

const run = (fn, args = {}) => {
  const stdout = convex("run", fn, JSON.stringify(args));
  return stdout.trim() ? JSON.parse(stdout) : null;
};

const assert = (condition, message) => {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  console.log(`✓ ${message}`);
};

if (!existsSync("dist/component/convex.config.js")) {
  console.error("dist/ missing — run `npm run build` first");
  process.exit(1);
}
if (!existsSync(".env.local")) {
  convex("init");
}
convex("env", "set", "DAYTONA_API_KEY", apiKey);
// A throwaway webhook secret: the suite signs deliveries itself (Daytona can't
// reach a local backend), exercising the mounted route in the real runtime.
const webhookSecret = `whsec_${randomBytes(24).toString("base64")}`;
convex("env", "set", "DAYTONA_WEBHOOK_SECRET", webhookSecret);
if (process.env.DAYTONA_API_URL) {
  convex("env", "set", "DAYTONA_API_URL", process.env.DAYTONA_API_URL);
}
convex("dev", "--once");
// Scheduled functions (runBackground's poller) only execute while a dev
// process is attached to the local backend — keep one alive for the test.
const devProcess = spawn(process.execPath, [convexBin, "dev"], {
  stdio: "ignore",
  detached: false,
});
// Unreferenced so the child can't keep this script's event loop alive after
// the assertions finish; the exit handler then reaps it.
devProcess.unref();
process.on("exit", () => devProcess.kill());
await new Promise((resolve) => setTimeout(resolve, 5000));
console.log("✓ example app deployed to local Convex with the daytona component");

let sandboxId;
try {
  const created = run("example:createSandbox", {
    // Background commands don't reset the idle timer — never auto-stop a sandbox
    // that hosts the long-running cancellation target.
    autoStopInterval: 0,
  });
  sandboxId = created.sandboxId;
  assert(created.state === "started", `createSandbox → started (${sandboxId})`);

  const exec = run("example:runCommand", { sandboxId, command: "echo live-e2e" });
  assert(exec.exitCode === 0 && exec.result.includes("live-e2e"), "runCommand round-trip");

  const py = run("example:runPython", { sandboxId, code: "print(6*7)" });
  assert(py.result.trim() === "42", "runCode(python) returns 42");

  const content = run("example:writeAndReadFile", {
    sandboxId,
    path: "/home/daytona/live-e2e.txt",
    content: "convex-live-e2e",
  });
  assert(content === "convex-live-e2e", "writeFile/readFile round-trip (upload-v2)");

  const binary = run("example:binaryRoundTrip", { sandboxId });
  assert(
    binary.roundTripOk,
    "writeFileBytes/readFileBytes round-trip all 256 byte values intact",
  );
  assert(
    binary.pngSignatureOk,
    "readFileBytes reads a sandbox-generated binary (PNG signature) intact",
  );

  const bg = run("example:runBackgroundCommand", {
    sandboxId,
    command: "sleep 5 && echo background-done",
    withCallback: true,
  });
  assert(typeof bg.executionId === "string", "runBackground returned immediately with executionId");
  let bgRow;
  for (let i = 0; i < 30; i++) {
    const executions = run("example:executions", { sandboxId });
    bgRow = executions.find((e) => e._id === bg.executionId);
    if (bgRow && bgRow.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  assert(
    bgRow?.status === "completed" && bgRow.result.includes("background-done"),
    `background execution completed via scheduler polling (exit ${bgRow?.exitCode})`,
  );

  let notification;
  for (let i = 0; i < 10; i++) {
    notification = run("example:notifications", {}).find(
      (n) => n.executionId === bg.executionId,
    );
    if (notification) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert(
    notification?.status === "completed" && notification.exitCode === 0,
    "onComplete callback wrote a notification into the app's table",
  );

  const cancelTarget = run("example:runBackgroundCommand", {
    sandboxId,
    command: "sleep 600",
    withCallback: true,
  });
  run("example:cancelBackgroundCommand", {
    executionId: cancelTarget.executionId,
  });
  const cancelledRow = run("example:executions", { sandboxId }).find(
    (e) => e._id === cancelTarget.executionId,
  );
  assert(
    cancelledRow?.status === "cancelled",
    "cancelExecution stopped the command and marked the row cancelled",
  );
  let cancelNote;
  for (let i = 0; i < 10; i++) {
    cancelNote = run("example:notifications", {}).find(
      (n) => n.executionId === cancelTarget.executionId,
    );
    if (cancelNote) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert(
    cancelNote?.status === "cancelled",
    "onComplete fired for the cancelled execution too",
  );

  const siteUrl = readFileSync(".env.local", "utf8").match(
    /CONVEX_SITE_URL=(\S+)/,
  )?.[1];
  const deliverStateEvent = async (newState, secret = webhookSecret) => {
    const now = new Date().toISOString();
    const body = JSON.stringify({
      event: "sandbox.state.updated",
      timestamp: now,
      id: sandboxId,
      organizationId: "live-test",
      oldState: "started",
      newState,
      updatedAt: now,
    });
    const msgId = `msg_live_${Date.now()}`;
    const ts = String(Math.floor(Date.now() / 1000));
    const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
    const signature = createHmac("sha256", key)
      .update(`${msgId}.${ts}.${body}`)
      .digest("base64");
    return fetch(`${siteUrl}/daytona/webhook`, {
      method: "POST",
      headers: {
        "svix-id": msgId,
        "svix-timestamp": ts,
        "svix-signature": `v1,${signature}`,
      },
      body,
    });
  };
  const forged = await deliverStateEvent(
    "archived",
    `whsec_${randomBytes(24).toString("base64")}`,
  );
  assert(forged.status === 401, "webhook route rejects a wrongly-signed delivery");
  const delivered = await deliverStateEvent("stopped");
  const synced = run("example:sandboxes", {}).find(
    (s) => s.sandboxId === sandboxId,
  );
  assert(
    delivered.status === 200 && synced?.state === "stopped",
    "signed sandbox.state.updated webhook synced the sandbox record",
  );

  const preview = run("example:previewUrl", { sandboxId, port: 3000 });
  assert(
    typeof preview.url === "string" && preview.url.startsWith("https://"),
    `signed preview URL (${preview.url})`,
  );

  const executions = run("example:executions", { sandboxId });
  const byStatus = (status) =>
    executions.filter((e) => e.status === status).length;
  assert(
    executions.length === 5 && byStatus("completed") === 4 && byStatus("cancelled") === 1,
    "executions table recorded 4 completed runs + 1 cancelled",
  );

  run("example:deleteSandbox", { sandboxId });
  const sandboxes = run("example:sandboxes", {});
  const record = sandboxes.find((s) => s.sandboxId === sandboxId);
  assert(record?.state === "destroyed", "deleteSandbox marks record destroyed");
  sandboxId = undefined;

  console.log("\nALL LIVE E2E CHECKS PASSED");
} finally {
  if (sandboxId) {
    try {
      run("example:deleteSandbox", { sandboxId });
      console.log(`✓ cleanup: deleted sandbox ${sandboxId}`);
    } catch (error) {
      console.error(`cleanup failed for sandbox ${sandboxId}:`, error.message);
    }
  }
}
