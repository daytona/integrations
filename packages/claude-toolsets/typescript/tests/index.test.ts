import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BROWSER_MEMBERS,
  COMPUTER_MEMBERS,
  DaytonaBrowser,
  DaytonaComputer,
  DaytonaFilePolicy,
} from "../src/index.js";

const README = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");

/** Every backticked name in the "Members" column of a README routing table. */
const readmeMembers = (heading: string): string[] => {
  const start = README.indexOf(heading);
  expect(start).toBeGreaterThan(-1);
  const section = README.slice(start);
  const table = section.slice(0, section.indexOf("\n\n", section.indexOf("|---")));
  const rows = table.split("\n").filter((line) => line.startsWith("| `"));
  const cells = rows.map((row) => row.split("|")[1] ?? "");
  return [...new Set(cells.flatMap((cell) => [...cell.matchAll(/`([a-z_]+)`/g)].map((m) => m[1] as string)))];
};

describe("package entry point", () => {
  it("exports the three public drivers as constructible values", () => {
    // Given: the package's src/index.ts compiled under module/moduleResolution NodeNext
    // When: a consumer imports the documented public surface
    // Then: each name resolves to a class, so `new`/`create` is reachable from the entry point
    expect(typeof DaytonaComputer).toBe("function");
    expect(typeof DaytonaBrowser).toBe("function");
    expect(typeof DaytonaFilePolicy).toBe("function");
    expect(typeof DaytonaComputer.create).toBe("function");
    expect(typeof DaytonaBrowser.create).toBe("function");
  });
});

describe("README routing tables", () => {
  it("names only real computer members", () => {
    // Given: the README's DaytonaComputer routing table
    // When: every backticked identifier in it is collected
    // Then: each one is a canonical wire member — no hand-copied typo survives
    const named = readmeMembers("### `DaytonaComputer`");
    expect(named.length).toBeGreaterThan(0);
    for (const member of named) expect(COMPUTER_MEMBERS).toContain(member);
  });

  it("names only real browser members", () => {
    const named = readmeMembers("### `DaytonaBrowser`");
    expect(named.length).toBeGreaterThan(0);
    for (const member of named) expect(BROWSER_MEMBERS).toContain(member);
  });

  // Searching the whole README would let a member drop out of its routing table and still pass
  // on a mention in prose, so each table must itself list every member of its toolset.
  it("routes every computer member in the DaytonaComputer table", () => {
    const named = readmeMembers("### `DaytonaComputer`");
    for (const member of COMPUTER_MEMBERS) expect(named).toContain(member);
  });

  it("routes every browser member in the DaytonaBrowser table", () => {
    const named = readmeMembers("### `DaytonaBrowser`");
    for (const member of BROWSER_MEMBERS) expect(named).toContain(member);
  });
});
