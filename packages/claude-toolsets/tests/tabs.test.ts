import { describe, expect, it } from "vitest";
import { MAX_ENTRIES, Tab, type TabRequest, type TabResponse } from "../src/tabs.js";
import { MAX_TEXT } from "../src/text.js";

describe("tab records", () => {
  const request = (url: string, method = "GET", responseEnd = -1): TabRequest => ({
    method: () => method,
    url: () => url,
    timing: () => ({ responseEnd }),
  });

  const response = (requestValue: TabRequest, status: number, contentType: string): TabResponse => ({
    request: () => requestValue,
    status: () => status,
    headers: () => ({ "content-type": contentType }),
  });

  it("caps console records, counts drops, and drains on read", () => {
    const tab = new Tab("tab_1", {});
    tab.log("x".repeat(MAX_TEXT + 1));
    expect(tab.takeConsole()).toHaveLength(MAX_TEXT);
    for (let index = 0; index <= MAX_ENTRIES; index += 1) {
      tab.log(`line-${index}`);
    }

    const lines = tab.takeConsole().split("\n");
    expect(lines[0]).toBe("[1 earlier entries were dropped]");
    expect(lines[1]).toBe("line-1");
    expect(lines.at(-1)).toBe(`line-${MAX_ENTRIES}`);
    expect(tab.takeConsole()).toBe("");
  });

  it("records request outcomes and keeps in-flight requests after a destructive read", () => {
    const tab = new Tab("tab_1", {});
    const settled = request("/settled", "POST", 12.4);
    const pending = request("/pending");
    tab.startRequest(settled);
    tab.answerRequest(response(settled, 204, "text/plain; charset=utf-8"));
    tab.finishRequest(settled, null);
    tab.startRequest(pending);

    expect(tab.takeNetwork()).toBe("POST 204 text/plain 12ms /settled\nGET pending /pending");
    expect(tab.takeNetwork()).toBe("GET pending /pending");
  });

  it("caps network records and counts dropped requests", () => {
    const tab = new Tab("tab_1", {});
    for (let index = 0; index <= MAX_ENTRIES; index += 1) {
      tab.startRequest(request(`/request-${index}`));
    }

    const lines = tab.takeNetwork().split("\n");
    expect(lines[0]).toBe("[1 earlier requests were dropped]");
    expect(lines[1]).toContain("/request-1");
    expect(lines).not.toContain(expect.stringContaining("/request-0"));
    expect(lines).toHaveLength(MAX_ENTRIES + 1);
  });
});
