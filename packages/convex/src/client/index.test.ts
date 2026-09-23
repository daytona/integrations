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
      delete process.env.DAYTONA_API_KEY;
    }
  });
});
