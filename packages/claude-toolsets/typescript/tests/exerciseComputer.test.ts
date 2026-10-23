import { describe, expect, it } from "vitest";

import { checkExercisedMembers, enabledMembers } from "../examples/exerciseComputer.js";
import { COMPUTER_MEMBERS } from "../src/index.js";

const allEnabled = (): Set<string> => enabledMembers({ configs: null });

describe("enabledMembers", () => {
  it("offers every computer member when the toolset carries no configs", () => {
    expect([...allEnabled()].sort()).toEqual([...COMPUTER_MEMBERS].sort());
  });

  it("leaves a member on when its config entry says nothing about enabled", () => {
    expect(enabledMembers({ configs: { zoom: { defer_loading: false } } }).has("zoom")).toBe(true);
  });

  it("leaves a member on when its config entry is null", () => {
    expect(enabledMembers({ configs: { zoom: null } }).has("zoom")).toBe(true);
  });

  it("drops a member switched off in configs", () => {
    const enabled = enabledMembers({ configs: { zoom: { enabled: false } } });
    expect(enabled.has("zoom")).toBe(false);
    expect(enabled.size).toBe(COMPUTER_MEMBERS.length - 1);
  });
});

describe("checkExercisedMembers", () => {
  it("accepts an exercise that covered exactly the enabled members", () => {
    const enabled = allEnabled();
    expect(() => {
      checkExercisedMembers(new Set(enabled), enabled);
    }).not.toThrow();
  });

  // The canary the live exercise rests on: dropping one member from the exercised set must fail.
  it("rejects an exercise that missed one enabled member", () => {
    const enabled = allEnabled();
    const exercised = new Set(enabled);
    exercised.delete("zoom");
    expect(() => {
      checkExercisedMembers(exercised, enabled);
    }).toThrow(/missing=\["zoom"\]/u);
  });

  it("rejects an exercise that reached a member the toolset does not offer", () => {
    const enabled = enabledMembers({ configs: { zoom: { enabled: false } } });
    expect(() => {
      checkExercisedMembers(new Set(COMPUTER_MEMBERS), enabled);
    }).toThrow(/extra=\["zoom"\]/u);
  });

  it("names every member a sweep of one-member-short exercises forgot", () => {
    const enabled = allEnabled();
    for (const forgotten of COMPUTER_MEMBERS) {
      const exercised = new Set(enabled);
      exercised.delete(forgotten);
      expect(() => {
        checkExercisedMembers(exercised, enabled);
      }).toThrow(new RegExp(`missing=\\["${forgotten}"\\]`, "u"));
    }
  });
});
