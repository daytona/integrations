/**
 * What the two live exercise scripts share: reading a `tool_result` the way the model receives it,
 * and the sandbox bookkeeping around a run.
 *
 * Nothing here talks to a toolset. Each exercise keeps its own calling convention, because the two
 * differ (the computer exercise tracks which members it has covered, the browser exercise checks a
 * `browser_state` block on every answered call).
 */
import { strict as assert } from "node:assert";
import { pathToFileURL } from "node:url";

import type { BetaToolResultBlockParam } from "@anthropic-ai/sdk/resources/beta";
import { Daytona, DaytonaError } from "@daytona/sdk";
import type { Sandbox } from "@daytona/sdk";

/** One block of a `tool_result`, as the model receives it. */
export type ResultBlock = Exclude<BetaToolResultBlockParam["content"], string | undefined>[number];

/** The PNG magic number, so a screenshot is read as an image rather than taken on trust. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const sleep = (seconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });

export const blocksOf = (result: BetaToolResultBlockParam): readonly ResultBlock[] => {
  const content = result.content ?? "";
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
};

export const textOf = (result: BetaToolResultBlockParam): string =>
  blocksOf(result)
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

export const pngOf = (result: BetaToolResultBlockParam): Buffer => {
  for (const block of blocksOf(result)) {
    if (block.type === "image" && block.source.type === "base64") {
      return Buffer.from(block.source.data, "base64");
    }
  }
  return Buffer.alloc(0);
};

export const pngSize = (png: Buffer): readonly [number, number] => {
  assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE), "expected a PNG");
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
};

/**
 * Print a result's blocks as the model would see them, with the image bytes replaced by `elided`
 * and each line cut at `limit` characters.
 */
export const printBlocks = (
  result: BetaToolResultBlockParam,
  elided: string,
  limit = Number.POSITIVE_INFINITY,
): void => {
  for (const block of blocksOf(result)) {
    const shown =
      block.type === "image" ? { ...block, source: { ...block.source, data: elided } } : block;
    const text = JSON.stringify(shown);
    console.log(`  ${text.length < limit ? text : `${text.slice(0, limit)} …`}`);
  }
};

/**
 * The sandbox named by `CTTS_SANDBOX_ID`, or `undefined` to let the driver create its own.
 *
 * This is the handoff the live-exercise harness uses: it leases one sandbox, names it here, and the
 * script borrows it instead of paying for another one. A borrowed sandbox is not the script's to
 * delete, so the run ends by checking it is still there rather than that it is gone.
 */
export const borrowedSandbox = async (): Promise<Sandbox | undefined> => {
  const id = process.env["CTTS_SANDBOX_ID"];
  return id === undefined || id === "" ? undefined : new Daytona().get(id);
};

/**
 * Whether the sandbox is still there.
 *
 * Only a not-found answer means gone. Reading every failure as "gone" would let a transient API
 * error or a bad credential satisfy the deletion check while the sandbox is still running.
 */
export const exists = async (sandboxId: string): Promise<boolean> => {
  try {
    await new Daytona().get(sandboxId);
  } catch (error: unknown) {
    if (error instanceof DaytonaError && error.statusCode === 404) return false;
    throw error;
  }
  return true;
};

/** The sandbox's state, or `gone` once it has been deleted. */
export const stateOfSandbox = async (sandboxId: string): Promise<string> =>
  (await exists(sandboxId)) ? String((await new Daytona().get(sandboxId)).state) : "gone";

/** A sandbox of this package's own making, for the checks about a sandbox the caller passes in. */
export const throwawaySandbox = async (): Promise<Sandbox> =>
  new Daytona().create({ labels: { "created-by": "daytona-claude-toolsets" } });

/** Whether this module's file is the one node was asked to run, rather than one a harness imported. */
export const invokedDirectly = (moduleUrl: string): boolean => {
  const entry = process.argv[1];
  return entry !== undefined && moduleUrl === pathToFileURL(entry).href;
};

/** Report a failure the way the Python examples do, and leave a non-zero exit status behind. */
export const reportFailure = (error: unknown): never => {
  const described =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(`error: ${described}`);
  return process.exit(1);
};
