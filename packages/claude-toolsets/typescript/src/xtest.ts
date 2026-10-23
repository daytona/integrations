import { randomBytes } from "node:crypto";

import { ToolError } from "@anthropic-ai/sdk/helpers/beta/toolsets";

import { debug, errorName } from "./logging.js";

export type ActionValue = string | number;
export type Action = readonly ActionValue[];

export const SCRIPT = String.raw`
import ctypes, json, os, sys, time, base64
x11 = ctypes.cdll.LoadLibrary("libX11.so.6")
xtst = ctypes.cdll.LoadLibrary("libXtst.so.6")
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XStringToKeysym.restype = ctypes.c_ulong
x11.XStringToKeysym.argtypes = [ctypes.c_char_p]
x11.XKeysymToKeycode.restype = ctypes.c_ubyte
x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XFlush.argtypes = [ctypes.c_void_p]
x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
x11.XDefaultScreen.argtypes = [ctypes.c_void_p]
xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
display = x11.XOpenDisplay((os.environ.get("DISPLAY") or ":0").encode())
if not display:
    print("no-display"); sys.exit(3)
actions = json.loads(base64.b64decode(sys.argv[1]))
codes = {}
for action in actions:
    if action[0] in ("keydown", "keyup") and action[1] not in codes:
        keysym = x11.XStringToKeysym(action[1].encode())
        # NoSymbol (0) would map to a spare keycode, so an unknown name is caught here first.
        code = x11.XKeysymToKeycode(display, keysym) if keysym else 0
        if not code:
            print("unknown-key:" + action[1]); sys.exit(4)
        codes[action[1]] = code
for action in actions:
    kind = action[0]
    if kind == "move":
        xtst.XTestFakeMotionEvent(display, x11.XDefaultScreen(display), int(action[1]), int(action[2]), 0)
    elif kind in ("down", "up"):
        xtst.XTestFakeButtonEvent(display, int(action[1]), kind == "down", 0)
    elif kind in ("keydown", "keyup"):
        xtst.XTestFakeKeyEvent(display, codes[action[1]], kind == "keydown", 0)
    elif kind == "sleep":
        x11.XFlush(display); time.sleep(float(action[1])); continue
    x11.XFlush(display)
    time.sleep(0.012)
x11.XCloseDisplay(display)
`;

export const BUTTONS = {
  left: 1,
  middle: 2,
  right: 3,
  up: 4,
  down: 5,
  wheel_left: 6,
  wheel_right: 7,
} as const;

export type XTestSandbox = {
  readonly id: string;
  readonly fs: {
    readonly uploadFile: (file: Buffer, remotePath: string) => Promise<void>;
    readonly deleteFile: (path: string) => Promise<void>;
  };
  readonly process: {
    readonly executeCommand: (
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeout?: number,
    ) => Promise<{ readonly exitCode: number; readonly result: string }>;
  };
};

export const encodeActions = (actions: readonly Action[]): string =>
  Buffer.from(JSON.stringify(actions), "utf8").toString("base64");

const helperPath = (): string =>
  `/tmp/daytona-claude-toolsets-ts-xtest-${randomBytes(4).toString("hex")}.py`;

export class XTest {
  private path: string | undefined;

  constructor(private readonly sandbox: XTestSandbox) {}

  async run(actions: readonly Action[]): Promise<void> {
    if (actions.length === 0) {
      return;
    }
    const seconds = actions.reduce(
      (total, action) =>
        action[0] === "sleep" && typeof action[1] === "number" ? total + action[1] : total,
      0.02 * actions.length,
    );
    const script = await this.script();
    const command = `python3 ${script} ${encodeActions(actions)}`;
    const response = await this.sandbox.process.executeCommand(command, undefined, undefined, Math.trunc(seconds) + 30);
    if (response.exitCode === 0) {
      return;
    }
    for (const line of response.result.split(/\r?\n/)) {
      if (line.startsWith("unknown-key:")) {
        const name = line.slice("unknown-key:".length);
        throw new ToolError(
          `Unknown key '${name}'; use a key name such as Return, Page_Up or F5, or a single character.`,
        );
      }
    }
    if (response.result.includes("no-display")) {
      throw new ToolError("The desktop is not running; the X display could not be opened.");
    }
    throw new ToolError("The desktop did not accept the input.");
  }

  async cleanup(): Promise<void> {
    const path = this.path;
    this.path = undefined;
    if (path === undefined) {
      return;
    }
    try {
      await this.sandbox.fs.deleteFile(path);
    } catch (error: unknown) {
      // no-excuse-ok: catch — best effort: a leftover file in /tmp is harmless.
      debug(`could not remove the XTest helper: ${errorName(error)}`);
    }
  }

  private async script(): Promise<string> {
    if (this.path !== undefined) {
      return this.path;
    }
    const path = helperPath();
    await this.sandbox.fs.uploadFile(Buffer.from(SCRIPT, "utf8"), path);
    this.path = path;
    return path;
  }
}
