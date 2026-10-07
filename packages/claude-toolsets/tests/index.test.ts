import { describe, expect, it } from "vitest";

import { PACKAGE_NAME } from "../src/index.js";

describe("package entry point", () => {
  it("loads the ESM entry module and exposes its public surface", () => {
    // Given: the package's src/index.ts compiled under module/moduleResolution NodeNext
    // When: a test imports it through an explicit .js specifier
    // Then: the binding resolves — proving the ESM + NodeNext + vitest wiring is live
    expect(PACKAGE_NAME).toBe("@daytona/claude-toolsets");
  });
});
