import { describe, expect, it, vi } from "vitest";

import {
  BUTTONS,
  SCRIPT,
  XTest,
  encodeActions,
  type XTestSandbox,
} from "../src/xtest.js";
import { readPythonXtestScript, sha256 } from "./helpers/extractPythonXtest.js";

type FakeXTestSandbox = XTestSandbox & {
  readonly fs: {
    readonly uploadFile: ReturnType<typeof vi.fn<(file: Buffer, path: string) => Promise<void>>>;
    readonly deleteFile: ReturnType<typeof vi.fn<(path: string) => Promise<void>>>;
  };
  readonly process: {
    readonly executeCommand: ReturnType<
      typeof vi.fn<(command: string, cwd?: string, env?: Record<string, string>, timeout?: number) => Promise<{
        readonly exitCode: number;
        readonly result: string;
      }>>
    >;
  };
};

const fakeSandbox = (): FakeXTestSandbox => ({
  id: "sbx-test",
  fs: {
    uploadFile: vi.fn<(file: Buffer, path: string) => Promise<void>>(
      async (_file, _path) => undefined,
    ),
    deleteFile: vi.fn<(path: string) => Promise<void>>(async (_path) => undefined),
  },
  process: {
    executeCommand: vi.fn<
      (
        command: string,
        cwd?: string,
        env?: Record<string, string>,
        timeout?: number,
      ) => Promise<{ readonly exitCode: number; readonly result: string }>
    >(async (_command, _cwd, _env, _timeout) => ({ exitCode: 0, result: "" })),
  },
});

describe("XTest helper runner", () => {
  it("preserves the Python helper asset byte-for-byte", () => {
    // Given: the checked-out Python helper and embedded TypeScript helper.
    // When: both helper assets are hashed.
    const pythonScript = readPythonXtestScript();

    // Then: the hashes match exactly.
    expect(sha256(SCRIPT)).toBe(sha256(pythonScript));
  });

  it("encodes actions in the Python-compatible base64 JSON codec", () => {
    // Given: an XTest action list.
    const actions = [["keydown", "Control_L"], ["sleep", 0.25], ["up", BUTTONS.left]] as const;

    // When: actions are encoded.
    const encoded = encodeActions(actions);

    // Then: decoding the final command argument reconstructs the fixture exactly.
    expect(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))).toEqual(actions);
  });

  it("uploads the helper once and executes the expected command", async () => {
    // Given: a sandbox with successful command execution.
    const sandbox = fakeSandbox();
    const runner = new XTest(sandbox);
    const actions = [["keydown", "a"], ["keyup", "a"]] as const;

    // When: the same runner executes twice.
    await runner.run(actions);
    await runner.run(actions);

    // Then: one namespaced upload backs both commands.
    expect(sandbox.fs.uploadFile).toHaveBeenCalledOnce();
    const upload = sandbox.fs.uploadFile.mock.calls[0];
    expect(upload?.[0]).toEqual(Buffer.from(SCRIPT));
    expect(upload?.[1]).toMatch(/^\/tmp\/daytona-claude-toolsets-ts-xtest-[0-9a-f]{8}\.py$/);
    expect(sandbox.process.executeCommand).toHaveBeenCalledTimes(2);
    expect(sandbox.process.executeCommand.mock.calls[0]?.[0]).toMatch(
      /^python3 \/tmp\/daytona-claude-toolsets-ts-xtest-[0-9a-f]{8}\.py /,
    );
  });

  it("removes an uploaded helper during cleanup", async () => {
    // Given: a runner that has uploaded its helper.
    const sandbox = fakeSandbox();
    const runner = new XTest(sandbox);
    await runner.run([["keydown", "a"]]);

    // When: cleanup runs twice.
    await runner.cleanup();
    await runner.cleanup();

    // Then: the borrowed sandbox receives one best-effort delete.
    expect(sandbox.fs.deleteFile).toHaveBeenCalledOnce();
    expect(sandbox.fs.deleteFile).toHaveBeenCalledWith(
      expect.stringMatching(/^\/tmp\/daytona-claude-toolsets-ts-xtest-[0-9a-f]{8}\.py$/),
    );
  });

  it.each([
    ["unknown-key:XF86AudioMute", "Unknown key 'XF86AudioMute'; use a key name such as Return, Page_Up or F5, or a single character."],
    ["no-display", "The desktop is not running; the X display could not be opened."],
    ["other failure", "The desktop did not accept the input."],
  ])("converts helper output %s to a ToolError", async (output, message) => {
    // Given: a helper process failure with a known output marker.
    const sandbox = fakeSandbox();
    sandbox.process.executeCommand.mockResolvedValue({ exitCode: 4, result: output });
    const runner = new XTest(sandbox);

    // When: the action is run.
    const result = runner.run([["keydown", "a"]]);

    // Then: the stable user-facing error is returned.
    await expect(result).rejects.toThrow(message);
  });
});
