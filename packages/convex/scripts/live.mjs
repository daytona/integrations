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

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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
if (process.env.DAYTONA_API_URL) {
  convex("env", "set", "DAYTONA_API_URL", process.env.DAYTONA_API_URL);
}
convex("dev", "--once");
console.log("✓ example app deployed to local Convex with the daytona component");

let sandboxId;
try {
  const created = run("example:createSandbox", {});
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

  const preview = run("example:previewUrl", { sandboxId, port: 3000 });
  assert(
    typeof preview.url === "string" && preview.url.startsWith("https://"),
    `signed preview URL (${preview.url})`,
  );

  const executions = run("example:executions", { sandboxId });
  assert(
    executions.length === 2 && executions.every((e) => e.status === "completed"),
    "executions table recorded 2 completed runs",
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
