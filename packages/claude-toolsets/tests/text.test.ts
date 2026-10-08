import { describe, expect, it } from "vitest";
import {
  MAX_TEXT,
  failurePhrase,
  formatRemote,
  normalizeUrl,
  rank,
  trimTrailingSlashes,
} from "../src/text.js";

describe("text utilities", () => {
  it("normalizes web addresses and preserves about:blank", () => {
    expect(normalizeUrl("example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(normalizeUrl("localhost:3000/x")).toBe("https://localhost:3000/x");
    expect(normalizeUrl("HTTP://Example.com")).toBe("HTTP://Example.com");
    expect(normalizeUrl("  https://example.com\n")).toBe("https://example.com");
    expect(normalizeUrl("about:blank")).toBe("about:blank");
  });

  it("refuses non-web schemes and controls it cannot drop", () => {
    for (const url of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "\x01 javascript:alert(1)",
      "java\tscript:alert(1)",
      "view-source:https://example.com",
      "data:text/html,<h1>hi</h1>",
      "file:///etc/passwd",
      "chrome://settings",
      "blob:https://example.com/uuid",
      "ftp://example.com/file",
      "about:srcdoc",
    ]) {
      expect(() => normalizeUrl(url)).toThrow(/does not open|control characters/);
    }
    for (const url of ["https://ex\x00ample.com", "https://a.test/\x0bx", "https://a.test/\x7f"]) {
      expect(() => normalizeUrl(url)).toThrow(/control characters/);
    }
    expect(normalizeUrl("https://a.te\tst.com/\r\n")).toBe("https://a.test.com/");
    expect(normalizeUrl("\x01\x02 https://a.test ")).toBe("https://a.test");
  });

  it("keeps navigation failure phrases fixed and preserves digit-bearing codes", () => {
    expect(failurePhrase(new Error("net::ERR_NAME_NOT_RESOLVED at https://secret.example/?token=abc"))).toBe(
      "The navigation failed (net::ERR_NAME_NOT_RESOLVED).",
    );
    expect(failurePhrase(new Error("net::ERR_BLOCKED_BY_CLIENT at https://x"))).toBe(
      "The navigation was refused.",
    );
    expect(failurePhrase(new Error("net::ERR_HTTP2_PROTOCOL_ERROR"))).toBe(
      "The navigation failed (net::ERR_HTTP2_PROTOCOL_ERROR).",
    );
    expect(failurePhrase(new Error("net::ERR_QUIC_PROTOCOL_ERROR2"))).toBe(
      "The navigation failed (net::ERR_QUIC_PROTOCOL_ERROR2).",
    );
    expect(failurePhrase(new Error("Target closed https://x"))).toBe("The navigation failed.");
  });

  it("formats remote values and ranks matching candidates", () => {
    expect(formatRemote({ type: "undefined" })).toBe("undefined");
    expect(formatRemote({ unserializableValue: "-0" })).toBe("-0");
    expect(formatRemote({ value: "hello" })).toBe("hello");
    expect(formatRemote({ value: { greeting: "héllo" } })).toBe('{"greeting":"héllo"}');
    expect(formatRemote({ description: "a remote value" })).toBe("a remote value");

    const button = { name: "Submit form", role: "button", interactive: true, visible: true };
    const attributeMatch = { name: "", role: "link", attrs: "aria-label=submit" };
    const textNode = { name: "Submit form", role: "text" };
    expect(rank("submit button", [attributeMatch, textNode, button])).toEqual([
      button,
      attributeMatch,
    ]);
  });

  it("bounds page-supplied text to MAX_TEXT", () => {
    expect(MAX_TEXT).toBe(2000);
  });

  it("drops trailing slashes exactly as the replaced regex did", () => {
    for (const text of ["", "/", "//", "///", "a", "a/", "a//", "/a", "/a/", "/a//b///", "https://h", "https://h/"]) {
      expect(trimTrailingSlashes(text)).toBe(text.replace(/\/+$/u, ""));
    }
  });

  it("drops trailing slashes in linear time", () => {
    // The replaced `/\/+$/` is O(n^2) here: 40k slashes cost ~0.5 s, 60k ~1.2 s.
    // A linear scan is microseconds, so this bound has a ~1000x margin and only
    // fails if the polynomial regex comes back.
    const pathological = "/".repeat(60_000) + "x";
    const started = performance.now();
    expect(trimTrailingSlashes(pathological)).toBe(pathological);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
