import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PAGE_JS } from "../src/pageJs.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function pythonToolkit(): string {
  const source = readFileSync(
    new URL("../../python/daytona_claude_toolsets/_page_js.py", import.meta.url),
    "utf8",
  );
  const marker = 'TOOLKIT = r"""';
  const literalStart = source.indexOf(marker);
  if (literalStart < 0) {
    throw new Error("Could not find the Python TOOLKIT literal");
  }
  const contentStart = literalStart + marker.length;
  const contentEnd = source.indexOf('"""', contentStart);
  if (contentEnd < 0) {
    throw new Error("Could not find the end of the Python TOOLKIT literal");
  }
  return source.slice(contentStart, contentEnd);
}

describe("page JavaScript asset", () => {
  it("matches the checked-out Python __dt bundle byte-for-byte", () => {
    // Given: the embedded TypeScript bundle and the sibling Python source literal
    const expected = pythonToolkit();

    // When: both bundle strings are hashed as UTF-8 bytes
    const actualHash = sha256(PAGE_JS);
    const expectedHash = sha256(expected);

    // Then: the asset identity is stable across the language ports
    expect(actualHash).toBe(expectedHash);
  });
});
