import { randomBytes } from "node:crypto";

import type { SessionExecuteRequest } from "@daytona/toolbox-api-client";

export const ACTIVE_PORT_FILE = "DevToolsActivePort" as const;
export const START_TIMEOUT = 30 as const;
export const POLL = 0.5 as const;

export type ChromiumCommandResponse = {
  readonly exitCode: number;
  readonly result: string;
};

export type ChromiumProcess = {
  readonly executeCommand: (
    command: string,
    cwd?: string,
    env?: Record<string, string>,
    timeout?: number,
  ) => Promise<ChromiumCommandResponse>;
  readonly createSession: (sessionId: string) => Promise<void>;
  readonly executeSessionCommand: (
    sessionId: string,
    request: SessionExecuteRequest,
    timeout?: number,
  ) => Promise<unknown>;
};

export type ChromiumSandbox = {
  readonly process: ChromiumProcess;
};

export type ChromiumPaths = {
  readonly sessionId: string;
  readonly profile: string;
  readonly downloadDir: string;
};

export type ChromiumLaunchOptions = {
  readonly chromium: string;
  readonly headless: boolean;
  readonly sessionId: string;
  readonly profile: string;
  readonly downloadDir: string;
  readonly viewport: readonly [number, number];
};

export class ChromiumLaunchError extends Error {
  readonly name = "ChromiumLaunchError";

  constructor(readonly profile: string) {
    super(`Chromium did not start in the sandbox; see ${profile}/chromium.log there`);
  }
}

export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export const createChromiumPaths = (): ChromiumPaths => {
  const id = randomBytes(4).toString("hex");
  const prefix = `/tmp/daytona-claude-toolsets-ts-${id}`;
  return {
    sessionId: `daytona-claude-toolsets-ts-${id}`,
    profile: `${prefix}-profile`,
    downloadDir: `${prefix}-downloads`,
  };
};

const activePortPath = (profile: string): string => `${profile}/${ACTIVE_PORT_FILE}`;

export const boundPort = async (
  sandbox: ChromiumSandbox,
  active: string,
): Promise<number | undefined> => {
  const response = await sandbox.process.executeCommand(
    `head -n 1 -- ${shellQuote(active)} 2>/dev/null`,
  );
  const line = response.result.split(/\r?\n/u)[0]?.trim();
  if (response.exitCode !== 0 || line === undefined || !/^\d+$/u.test(line)) {
    return undefined;
  }

  const port = Number(line);
  if (!Number.isSafeInteger(port)) {
    return undefined;
  }

  const probe =
    "command -v curl >/dev/null 2>&1 || exit 0; " +
    `curl -sf -o /dev/null http://127.0.0.1:${port}/json/version`;
  return (await sandbox.process.executeCommand(probe)).exitCode === 0 ? port : undefined;
};

const launchCommand = (
  chromium: string,
  headless: boolean,
  profile: string,
  viewport: readonly [number, number],
  isRoot: boolean,
): string => {
  const [width, height] = viewport;
  const flags: readonly string[] = [
    ...(headless ? ["--headless=new"] : []),
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
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
    ...(isRoot ? ["--no-sandbox"] : []),
    "about:blank",
  ];
  const env = [
    `HOME=${profile}`,
    "PATH=/usr/local/bin:/usr/bin:/bin",
    "LANG=C.UTF-8",
    ...(headless ? [] : ["DISPLAY=:0"]),
  ];
  return `env -i ${env.map(shellQuote).join(" ")} ${shellQuote(chromium)} ${flags.map(shellQuote).join(" ")} >${shellQuote(`${profile}/chromium.log`)} 2>&1`;
};

export const launch = async (
  sandbox: ChromiumSandbox,
  options: ChromiumLaunchOptions,
): Promise<number> => {
  const root = await sandbox.process.executeCommand("id -u");
  const isRoot = root.result.trim() === "0";
  const active = activePortPath(options.profile);
  const directories = [options.profile, options.downloadDir].map(shellQuote).join(" ");
  await sandbox.process.executeCommand(
    `mkdir -p -m 700 ${directories} && rm -f -- ${shellQuote(active)}`,
  );

  await sandbox.process.createSession(options.sessionId);
  const command = launchCommand(
    options.chromium,
    options.headless,
    options.profile,
    options.viewport,
    isRoot,
  );
  const request = { command, runAsync: true } satisfies SessionExecuteRequest;
  await sandbox.process.executeSessionCommand(options.sessionId, request);

  const deadline = Date.now() + START_TIMEOUT * 1000;
  while (true) {
    const port = await boundPort(sandbox, active);
    if (port !== undefined) {
      return port;
    }
    if (Date.now() > deadline) {
      throw new ChromiumLaunchError(options.profile);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, POLL * 1000);
    });
  }
};
