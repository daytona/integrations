import { describe, expect, it, vi } from "vitest";

import {
  boundPort,
  createChromiumPaths,
  launch,
  shellQuote,
  type ChromiumSandbox,
} from "../src/chromium.js";

type FakeSandbox = ChromiumSandbox & {
  readonly process: {
    readonly executeCommand: ReturnType<typeof vi.fn<ChromiumSandbox["process"]["executeCommand"]>>;
    readonly createSession: ReturnType<typeof vi.fn<ChromiumSandbox["process"]["createSession"]>>;
    readonly executeSessionCommand: ReturnType<
      typeof vi.fn<ChromiumSandbox["process"]["executeSessionCommand"]>
    >;
  };
};

const fakeSandbox = (uid = "1000", activePort = "9222\n"): FakeSandbox => {
  const executeCommand = vi.fn<ChromiumSandbox["process"]["executeCommand"]>();
  executeCommand.mockImplementation(async (command) => {
    if (command === "id -u") {
      return { exitCode: 0, result: `${uid}\n` };
    }
    if (command.startsWith("head -n 1 --")) {
      return { exitCode: 0, result: activePort };
    }
    return { exitCode: 0, result: "" };
  });

  return {
    process: {
      executeCommand,
      createSession: vi.fn<ChromiumSandbox["process"]["createSession"]>(async () => undefined),
      executeSessionCommand: vi.fn<ChromiumSandbox["process"]["executeSessionCommand"]>(
        async () => ({})
      ),
    },
  };
};

const launchOptions = {
  chromium: "/opt/Chromium's/chromium",
  headless: true,
  sessionId: "daytona-claude-toolsets-ts-session",
  profile: "/tmp/daytona-claude-toolsets-ts-profile's",
  downloadDir: "/tmp/daytona-claude-toolsets-ts-downloads",
  viewport: [1280, 800] as const,
};

describe("Chromium launcher", () => {
  it("allocates fresh profile and download paths in the TS namespace", () => {
    // Given: two independent Chromium launches.
    const first = createChromiumPaths();
    const second = createChromiumPaths();

    // When: their sandbox paths are inspected.
    // Then: every path is fresh and uses the package-owned temporary namespace.
    expect(first.sessionId).toMatch(/^daytona-claude-toolsets-ts-[0-9a-f]{8}$/u);
    expect(first.profile).toMatch(/^\/tmp\/daytona-claude-toolsets-ts-[0-9a-f]{8}-profile$/u);
    expect(first.downloadDir).toMatch(
      /^\/tmp\/daytona-claude-toolsets-ts-[0-9a-f]{8}-downloads$/u,
    );
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it("quotes shell arguments and assembles the scrubbed headless command", async () => {
    // Given: a non-root sandbox and paths containing a shell metacharacter.
    const sandbox = fakeSandbox();

    // When: Chromium is launched.
    const port = await launch(sandbox, launchOptions);

    // Then: the browser uses the background session and the exact isolated flag/env contract.
    expect(port).toBe(9222);
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
    expect(sandbox.process.createSession).toHaveBeenCalledWith(launchOptions.sessionId);
    expect(sandbox.process.executeSessionCommand).toHaveBeenCalledOnce();
    const request = sandbox.process.executeSessionCommand.mock.calls[0]?.[1];
    expect(request?.runAsync).toBe(true);
    expect(request?.command).toContain(
      `env -i ${shellQuote(`HOME=${launchOptions.profile}`)} ${shellQuote("PATH=/usr/local/bin:/usr/bin:/bin")} ${shellQuote("LANG=C.UTF-8")}`,
    );
    expect(request?.command).not.toContain("DISPLAY=:0");
    for (const flag of [
      "--remote-debugging-port=0",
      `--user-data-dir=${launchOptions.profile}`,
      "--window-size=1280,800",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--password-store=basic",
      "--enable-features=LocalNetworkAccessChecks",
      "--disable-features=BackForwardCache",
      "about:blank",
    ]) {
      expect(request?.command).toContain(shellQuote(flag));
    }
    expect(request?.command).toContain(shellQuote(launchOptions.chromium));
    expect(request?.command).toContain(
      `>${shellQuote(`${launchOptions.profile}/chromium.log`)} 2>&1`,
    );
    expect(sandbox.process.executeCommand.mock.calls[1]?.[0]).toBe(
      `mkdir -p -m 700 ${shellQuote(launchOptions.profile)} ${shellQuote(launchOptions.downloadDir)} && rm -f -- ${shellQuote(`${launchOptions.profile}/DevToolsActivePort`)}`,
    );
    // `toContain` never unwraps an asymmetric matcher, so the matcher form of this
    // assertion could never fail. `toEqual(arrayContaining(...))` does unwrap it.
    expect(sandbox.process.executeCommand.mock.calls.map(([command]) => command)).not.toEqual(
      expect.arrayContaining([expect.stringContaining(launchOptions.chromium)]),
    );
  });

  it("adds the no-sandbox flag for a root sandbox and keeps DISPLAY for headed mode", async () => {
    // Given: a root sandbox running a headed browser.
    const sandbox = fakeSandbox("0");

    // When: Chromium is launched without headless mode.
    await launch(sandbox, { ...launchOptions, headless: false });

    // Then: root isolation and the display environment are explicit.
    const request = sandbox.process.executeSessionCommand.mock.calls[0]?.[1];
    expect(request?.command).toContain(shellQuote("--no-sandbox"));
    expect(request?.command).toContain(shellQuote("DISPLAY=:0"));
  });

  it("returns the port only after the optional curl probe succeeds", async () => {
    // Given: a DevToolsActivePort file and a successful curl-optional shell probe.
    const sandbox = fakeSandbox();

    // When: readiness is checked.
    const port = await boundPort(sandbox, "/tmp/daytona-claude-toolsets-ts-profile/DevToolsActivePort");

    // Then: the parsed port is returned and the exact optional probe is used.
    expect(port).toBe(9222);
    expect(sandbox.process.executeCommand.mock.calls.at(-1)?.[0]).toBe(
      "command -v curl >/dev/null 2>&1 || exit 0; curl -sf -o /dev/null http://127.0.0.1:9222/json/version",
    );
  });

  it("treats a missing DevToolsActivePort file as not ready", async () => {
    // Given: the sandbox cannot read the active-port file yet.
    const sandbox = fakeSandbox();
    sandbox.process.executeCommand.mockResolvedValueOnce({ exitCode: 1, result: "" });

    // When: readiness is checked.
    const port = await boundPort(sandbox, "/tmp/daytona-claude-toolsets-ts-profile/DevToolsActivePort");

    // Then: the caller can poll again without a probe or exception.
    expect(port).toBeUndefined();
    expect(sandbox.process.executeCommand).toHaveBeenCalledOnce();
  });

  it("rejects malformed DevToolsActivePort content without probing a false port", async () => {
    // Given: Chromium wrote non-numeric content while the file is incomplete.
    const sandbox = fakeSandbox("1000", "not-a-port\n");

    // When: readiness is checked.
    const port = await boundPort(sandbox, "/tmp/daytona-claude-toolsets-ts-profile/DevToolsActivePort");

    // Then: malformed content remains not ready and curl is not invoked.
    expect(port).toBeUndefined();
    expect(sandbox.process.executeCommand).toHaveBeenCalledOnce();
  });
});
