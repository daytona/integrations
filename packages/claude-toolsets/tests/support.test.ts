import type { BetaToolResultBlockParam } from "@anthropic-ai/sdk/resources/beta";
import { describe, expect, it } from "vitest";

import { textOf } from "../examples/support.js";

describe("example result helpers", () => {
  it("joins only text blocks when browser state follows text", () => {
    // Given: an answered browser member result with text and a browser-state block.
    const result = {
      type: "tool_result",
      tool_use_id: "toolu_javascript_exec",
      content: [
        { type: "text", text: "Grace" },
        { type: "browser_state", tabs: [] },
      ],
    } satisfies BetaToolResultBlockParam;

    // When: the exercise reads the model-visible text.
    const text = textOf(result);

    // Then: non-text blocks add no separator or trailing newline.
    expect(text).toBe("Grace");
  });
});
