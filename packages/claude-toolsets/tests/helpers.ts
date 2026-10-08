import type { BetaToolResultBlockParam, BetaToolUseBlock } from "@anthropic-ai/sdk/resources/beta";
import type { Sandbox } from "@daytona/sdk";
import { vi } from "vitest";

import { encodePng } from "../src/png.js";
import type { Action } from "../src/xtest.js";

/**
 * A coordinate-coded fixture: pixel (x, y) is `rgb(x & 0xff, y & 0xff, ((x >> 8) << 4) | (y >> 8))`.
 *
 * A flat fill cannot tell a correct crop from a wrong one — every region of it looks the same —
 * so a zoom that copied the wrong rectangle still passed. Encoding the coordinates into the
 * pixels lets a test read a decoded pixel back and prove which part of the screen it came from.
 */
const png = (width: number, height: number): string => {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      data[at] = x & 0xff;
      data[at + 1] = y & 0xff;
      data[at + 2] = ((x >> 8) << 4) | (y >> 8);
      data[at + 3] = 255;
    }
  }
  return encodePng({ width, height, data }).toString("base64");
};

export const daytonaMethod = <TArgs extends readonly unknown[], TResult>(result: TResult) =>
  vi.fn<(...args: TArgs) => Promise<TResult>>(async (..._args) => result);

export type MockSandbox = {
  readonly sandbox: Sandbox;
  readonly raw: {
    readonly id: string;
    state: string;
    /** Daytona's own `Sandbox.public`; writable here so a test can lease a public sandbox. */
    public: boolean;
    readonly start: ReturnType<typeof vi.fn<() => Promise<void>>>;
    readonly stop: ReturnType<typeof vi.fn<() => Promise<void>>>;
    readonly delete: ReturnType<typeof vi.fn<() => Promise<void>>>;
    readonly refreshActivity: ReturnType<typeof vi.fn<() => Promise<void>>>;
    readonly getSignedPreviewUrl: ReturnType<typeof vi.fn<(port: number, expires: number) => Promise<{ readonly sandboxId: string; readonly port: number; readonly token: string; readonly url: string }>>>;
    readonly expireSignedPreviewUrl: ReturnType<typeof vi.fn<(port: number, token: string) => Promise<void>>>;
    readonly fs: {
      readonly uploadFile: ReturnType<typeof vi.fn<(data: Buffer, path: string) => Promise<void>>>;
      readonly deleteFile: ReturnType<typeof vi.fn<(path: string) => Promise<void>>>;
    };
    readonly process: {
      readonly executeCommand: ReturnType<typeof vi.fn<(command: string, cwd?: string, env?: Record<string, string>, timeout?: number) => Promise<{ readonly exitCode: number; readonly result: string }>>>;
      readonly createSession: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>;
      readonly executeSessionCommand: ReturnType<typeof vi.fn<(id: string, request: object) => Promise<unknown>>>;
      readonly deleteSession: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>;
    };
    readonly computerUse: {
      readonly getStatus: ReturnType<typeof vi.fn<() => Promise<{ readonly status: string }>>>;
      readonly start: ReturnType<typeof vi.fn<() => Promise<{ readonly message: string }>>>;
      readonly display: { readonly getInfo: ReturnType<typeof vi.fn<() => Promise<{ readonly displays: readonly { readonly width: number; readonly height: number; readonly isActive: boolean }[] }>>> };
      readonly screenshot: {
        readonly takeFullScreen: ReturnType<typeof vi.fn<() => Promise<{ readonly screenshot: string }>>>;
        readonly takeRegion: ReturnType<typeof vi.fn<(region: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }) => Promise<{ readonly screenshot: string }>>>;
      };
      readonly mouse: {
        readonly getPosition: ReturnType<typeof vi.fn<() => Promise<{ readonly x: number; readonly y: number }>>>;
        readonly move: ReturnType<typeof vi.fn<(x: number, y: number) => Promise<{ readonly x: number; readonly y: number }>>>;
        readonly click: ReturnType<typeof vi.fn<(x: number, y: number, button?: string, double?: boolean, clicks?: number, modifiers?: string[]) => Promise<{ readonly x: number; readonly y: number }>>>;
        readonly down: ReturnType<typeof vi.fn<(x?: number, y?: number, button?: string) => Promise<{ readonly x: number; readonly y: number }>>>;
        readonly up: ReturnType<typeof vi.fn<(x?: number, y?: number, button?: string) => Promise<{ readonly x: number; readonly y: number }>>>;
        readonly drag: ReturnType<typeof vi.fn<(startX: number, startY: number, endX: number, endY: number, button?: string, modifiers?: string[]) => Promise<{ readonly x: number; readonly y: number }>>>;
        readonly scroll: ReturnType<typeof vi.fn<(x: number, y: number, direction: "up" | "down" | "left" | "right", amount?: number, modifiers?: string[]) => Promise<boolean>>>;
      };
      readonly keyboard: {
        readonly press: ReturnType<typeof vi.fn<(key: string, modifiers?: string[]) => Promise<void>>>;
        readonly type: ReturnType<typeof vi.fn<(text: string, delay?: number) => Promise<void>>>;
        readonly down: ReturnType<typeof vi.fn<(key: string) => Promise<void>>>;
        readonly up: ReturnType<typeof vi.fn<(key: string) => Promise<void>>>;
      };
    };
  };
};

export const mockSandbox = (width = 1280, height = 800): MockSandbox => {
  const raw = {
    id: "sbx-test",
    state: "started",
    public: false,
    start: daytonaMethod<[], void>(undefined),
    stop: daytonaMethod<[], void>(undefined),
    delete: daytonaMethod<[], void>(undefined),
    refreshActivity: daytonaMethod<[], void>(undefined),
    getSignedPreviewUrl: daytonaMethod<[number, number], { readonly sandboxId: string; readonly port: number; readonly token: string; readonly url: string }>({ sandboxId: "sbx-test", port: 9222, token: "signed-token", url: "https://signed.test/token" }),
    expireSignedPreviewUrl: daytonaMethod<[number, string], void>(undefined),
    fs: {
      uploadFile: daytonaMethod<[Buffer, string], void>(undefined),
      deleteFile: daytonaMethod<[string], void>(undefined),
    },
    process: {
      executeCommand: daytonaMethod<[string, string?, Record<string, string>?, number?], { readonly exitCode: number; readonly result: string }>({ exitCode: 0, result: "" }),
      createSession: daytonaMethod<[string], void>(undefined),
      executeSessionCommand: daytonaMethod<[string, object], unknown>(undefined),
      deleteSession: daytonaMethod<[string], void>(undefined),
    },
    computerUse: {
      getStatus: daytonaMethod<[], { readonly status: string }>({ status: "active" }),
      start: daytonaMethod<[], { readonly message: string }>({ message: "started" }),
      display: { getInfo: daytonaMethod<[], { readonly displays: readonly { readonly width: number; readonly height: number; readonly isActive: boolean }[] }>({ displays: [{ width, height, isActive: true }] }) },
      screenshot: {
        takeFullScreen: daytonaMethod<[], { readonly screenshot: string }>({ screenshot: png(width, height) }),
        takeRegion: daytonaMethod<[{ readonly x: number; readonly y: number; readonly width: number; readonly height: number }], { readonly screenshot: string }>({ screenshot: png(200, 100) }),
      },
      mouse: {
        getPosition: daytonaMethod<[], { readonly x: number; readonly y: number }>({ x: 5, y: 6 }),
        move: daytonaMethod<[number, number], { readonly x: number; readonly y: number }>({ x: 5, y: 6 }),
        click: daytonaMethod<[number, number, string?, boolean?, number?, string[]?], { readonly x: number; readonly y: number }>({ x: 5, y: 6 }),
        down: daytonaMethod<[number?, number?, string?], { readonly x: number; readonly y: number }>({ x: 5, y: 6 }),
        up: daytonaMethod<[number?, number?, string?], { readonly x: number; readonly y: number }>({ x: 5, y: 6 }),
        drag: daytonaMethod<[number, number, number, number, string?, string[]?], { readonly x: number; readonly y: number }>({ x: 5, y: 6 }),
        scroll: daytonaMethod<[number, number, "up" | "down" | "left" | "right", number?, string[]?], boolean>(true),
      },
      keyboard: {
        press: daytonaMethod<[string, string[]?], void>(undefined),
        type: daytonaMethod<[string, number?], void>(undefined),
        down: daytonaMethod<[string], void>(undefined),
        up: daytonaMethod<[string], void>(undefined),
      },
    },
  };
  return { raw, sandbox: raw as unknown as Sandbox };
};

export const xtestActions = (sandbox: MockSandbox): readonly Action[] => {
  const command = sandbox.raw.process.executeCommand.mock.calls.at(-1)?.[0];
  if (command === undefined) throw new Error("XTest was not run");
  const encoded = command.split(" ").at(-1);
  if (encoded === undefined) throw new Error("XTest command has no action payload");
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as readonly Action[];
};

export const callMember = async (
  toolset: { readonly toolsetName: string; toolResult(toolUse: BetaToolUseBlock): Promise<BetaToolResultBlockParam> },
  name: string,
  input: object,
): Promise<BetaToolResultBlockParam> => toolset.toolResult({
  type: "tool_use",
  id: `toolu_${name}`,
  name,
  input,
  toolset_name: toolset.toolsetName,
});

export const resultText = (result: BetaToolResultBlockParam): string => {
  if (typeof result.content === "string") return result.content;
  return (result.content ?? []).map((block) => "text" in block ? block.text : "").join("\n");
};

export const imageData = (result: BetaToolResultBlockParam): string => {
  if (!Array.isArray(result.content)) throw new Error("tool result did not contain blocks");
  const image = result.content.find((block) => block.type === "image");
  if (image === undefined || image.source.type !== "base64") throw new Error("tool result did not contain a base64 image");
  return image.source.data;
};
