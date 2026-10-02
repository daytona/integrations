import { describe, expect, test } from "vitest";
import { componentsGeneric } from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";
import { Daytona, type RunActionCtx } from "./index.js";

const components = componentsGeneric() as unknown as { daytona: ComponentApi };

const nullCtx: RunActionCtx = {
  runQuery: async () => null,
  runMutation: async () => null,
  runAction: async () => null,
};

describe("Daytona client configuration", () => {
  test("throws a clear error when no API key is configured", async () => {
    const previous = process.env.DAYTONA_API_KEY;
    delete process.env.DAYTONA_API_KEY;
    try {
      const daytona = new Daytona(components.daytona);
      await expect(
        daytona.getPreviewUrl(nullCtx, { sandboxId: "sbx-1", port: 3000 }),
      ).rejects.toThrow(/DAYTONA_API_KEY/);
    } finally {
      if (previous !== undefined) process.env.DAYTONA_API_KEY = previous;
    }
  });

  test("explicit options win over environment variables", async () => {
    const previous = process.env.DAYTONA_API_KEY;
    process.env.DAYTONA_API_KEY = "env-key";
    try {
      let sent: Record<string, unknown> | undefined;
      const capturingCtx: RunActionCtx = {
        ...nullCtx,
        runAction: async (_ref, args) => {
          sent = args as Record<string, unknown>;
          return null;
        },
      };
      const daytona = new Daytona(components.daytona, { apiKey: "opt-key" });
      await daytona.getPreviewUrl(capturingCtx, { sandboxId: "sbx-1", port: 80 });
      expect(sent?.config).toMatchObject({ apiKey: "opt-key" });
    } finally {
      if (previous === undefined) delete process.env.DAYTONA_API_KEY;
      else process.env.DAYTONA_API_KEY = previous;
    }
  });

  test("runBackground forwards the API URL but never the key", async () => {
    let sent: Record<string, unknown> | undefined;
    const capturingCtx: RunActionCtx = {
      ...nullCtx,
      runAction: async (_ref, args) => {
        sent = args as Record<string, unknown>;
        return null;
      },
    };
    const daytona = new Daytona(components.daytona, {
      apiKey: "opt-key",
      apiUrl: "https://daytona.example/api",
    });
    await daytona.runBackground(capturingCtx, {
      sandboxId: "sbx-1",
      command: "sleep 5",
    });
    // The component reads the key passed down to it in convex.config.ts.
    expect(sent).toEqual({
      sandboxId: "sbx-1",
      command: "sleep 5",
      apiUrl: "https://daytona.example/api",
    });
  });
});

describe("writeFileBytes content normalization", () => {
  const capture = () => {
    let sent: { content?: ArrayBuffer } | undefined;
    const ctx: RunActionCtx = {
      ...nullCtx,
      runAction: async (_ref, args) => {
        sent = args as { content?: ArrayBuffer };
        return null;
      },
    };
    return { ctx, sent: () => sent };
  };
  const daytona = new Daytona(components.daytona, { apiKey: "k" });

  test("a view into a larger buffer sends only the view's bytes", async () => {
    // Like Node's pooled Buffers: the view's .buffer is much bigger than it.
    const backing = Uint8Array.from({ length: 64 }, (_, i) => i);
    const view = backing.subarray(10, 14);
    const { ctx, sent } = capture();
    await daytona.writeFileBytes(ctx, {
      sandboxId: "sbx-1",
      path: "/tmp/x.bin",
      content: view,
    });
    const content = sent()!.content!;
    expect(content).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(content))).toEqual([10, 11, 12, 13]);
  });

  test("a plain ArrayBuffer passes through unchanged", async () => {
    const buffer = Uint8Array.from([1, 2, 3]).buffer;
    const { ctx, sent } = capture();
    await daytona.writeFileBytes(ctx, {
      sandboxId: "sbx-1",
      path: "/tmp/x.bin",
      content: buffer,
    });
    expect(sent()!.content).toBe(buffer);
  });
});
