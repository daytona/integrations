/**
 * Exercise DaytonaComputer with the calls a model would make, against a real Daytona sandbox: no
 * model and no Anthropic API key.
 *
 * Usage:
 *
 *     npm run example:exercise-computer
 *     CTTS_SANDBOX_ID=sbx-… npm run example:exercise-computer   # borrow a sandbox you already have
 *
 * It creates a sandbox (deleted at the end), opens a terminal on its desktop, and sends every
 * member the driver implements through `toolset.toolResult(...)`, the entry point the tool runner
 * uses. It prints each `tool_result` as the model would see it (image bytes elided) and checks it:
 * calls that should be answered are, the effects that can be read back (typed commands, the pointer
 * position, screenshot sizes) are there, and calls that should be refused come back as `is_error`.
 * Then it checks that a sandbox passed in by the caller survives `close()`.
 *
 * `exercise(computer)` is exported on its own, so a harness that already holds a sandbox can run
 * the same checks against a driver it built itself. `main()` is the standalone path: with
 * `CTTS_SANDBOX_ID` set it borrows that sandbox and checks it outlives the run, and without it the
 * script owns a sandbox of its own and checks it is deleted. The two extra scenarios below (a
 * larger desktop, and a sandbox passed in by the caller) create sandboxes of their own, so they run
 * only when the script was not handed one.
 *
 * The first mismatch ends the script with a failed assertion (exit status 1). Needs `DAYTONA_API_KEY`.
 */
import { strict as assert } from "node:assert";

import type {
  BetaComputerToolsetConfigs,
  BetaToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/beta";

import { COMPUTER_MEMBERS, DaytonaComputer } from "../src/index.js";
import {
  borrowedSandbox,
  invokedDirectly,
  pngOf,
  pngSize,
  printBlocks,
  reportFailure,
  sleep,
  stateOfSandbox,
  textOf,
  throwawaySandbox,
} from "./support.js";

const TERMINAL_SESSION = "exercise-terminal";

type ComputerMember = (typeof COMPUTER_MEMBERS)[number];

/** Send tool calls as the model would, printing each result and recording which members ran. */
class ComputerCalls {
  readonly exercised = new Set<string>();

  constructor(private readonly computer: DaytonaComputer) {}

  async call(name: string, input: object): Promise<BetaToolResultBlockParam> {
    this.exercised.add(name);
    const result = await this.computer.toolResult({
      type: "tool_use",
      id: `toolu_${name}`,
      name,
      input,
      toolset_name: "computer",
    });
    console.log(`\n${name} ${JSON.stringify(input)} -> ${result.is_error === true ? "refused" : "answered"}`);
    printBlocks(result, `<${pngOf(result).length} bytes>`);
    return result;
  }

  async answered(name: string, input: object): Promise<string> {
    const result = await this.call(name, input);
    assert.ok(result.is_error !== true, `expected that ${name} ${JSON.stringify(input)} is answered`);
    return textOf(result);
  }

  async refused(name: string, input: object, phrase: string): Promise<void> {
    const result = await this.call(name, input);
    assert.ok(
      result.is_error === true && textOf(result).includes(phrase),
      `expected that ${name} ${JSON.stringify(input)} is refused with ${JSON.stringify(phrase)}`,
    );
  }
}

/** What a command typed into the terminal wrote, once it has run. */
const readFile = async (computer: DaytonaComputer, path: string, timeout = 10): Promise<string> => {
  const deadline = Date.now() + timeout * 1000;
  for (;;) {
    const result = await computer.sandbox.process.executeCommand(`cat ${path} 2>/dev/null`);
    const text = result.result.trim();
    if (text !== "" || Date.now() > deadline) return text;
    await sleep(0.5);
  }
};

/**
 * Whether the toolset still serves `name`, read from the public wire `configs`.
 *
 * Every computer member is enabled by default, so only a real `false` turns one off; a `configs`
 * entry that leaves `enabled` unset (or sets it to `null`) leaves the member on. The SDK writes
 * `enabled: false` into these same wire `configs` for any member the class does not implement, so
 * this sees the members a model would actually be offered.
 */
const memberEnabled = (configs: BetaComputerToolsetConfigs | null, name: ComputerMember): boolean => {
  const entry = configs === null ? undefined : configs[name];
  if (entry === undefined || entry === null) return true;
  return entry.enabled ?? true;
};

/** The computer members this toolset offers the model. */
export const enabledMembers = (toolset: {
  readonly configs: BetaComputerToolsetConfigs | null;
}): Set<string> => new Set(COMPUTER_MEMBERS.filter((name) => memberEnabled(toolset.configs, name)));

/** Reject a live exercise that misses an enabled computer member. */
export const checkExercisedMembers = (
  exercised: ReadonlySet<string>,
  enabled: ReadonlySet<string>,
): void => {
  const missing = [...enabled].filter((name) => !exercised.has(name));
  const extra = [...exercised].filter((name) => !enabled.has(name));
  assert.ok(
    missing.length === 0 && extra.length === 0,
    `exercise coverage mismatch: missing=${JSON.stringify(missing)}, extra=${JSON.stringify(extra)}`,
  );
};

export const exercise = async (computer: DaytonaComputer): Promise<void> => {
  const calls = new ComputerCalls(computer);
  const first = await calls.call("screenshot", {});
  assert.deepEqual(
    pngSize(pngOf(first)),
    [computer.width, computer.height],
    "expected that screenshot is a PNG of the whole screen",
  );

  // A bash terminal (the sandbox user's login shell is /bin/sh, which has no line editing) to type
  // into, opened on the desktop by the harness, not by the model.
  const sandbox = computer.sandbox;
  await sandbox.process.createSession(TERMINAL_SESSION);
  await sandbox.process.executeSessionCommand(TERMINAL_SESSION, {
    command: "DISPLAY=:0 xfce4-terminal --geometry=100x30+40+40 --command=bash >/dev/null 2>&1",
    runAsync: true,
  });
  await sleep(4);
  await calls.answered("left_click", { coordinate: [300, 200] });

  // type + key: a command typed into the terminal and run with Return writes its answer to a file.
  await calls.answered("type", { text: "echo $((6*7)) > /tmp/exercise-type.txt" });
  await calls.answered("key", { text: "Return" });
  assert.equal(await readFile(computer, "/tmp/exercise-type.txt"), "42", "expected that the command ran");
  // Readline consumes Tab as completion, so type it into cat rather than a shell prompt.
  await calls.answered("type", { text: "cat > /tmp/exercise-tab.txt" });
  await calls.answered("key", { text: "Return" });
  await calls.answered("type", { text: "tab\tok" });
  await calls.answered("key", { text: "Return" });
  await calls.answered("key", { text: "ctrl+d" });
  assert.equal(await readFile(computer, "/tmp/exercise-tab.txt"), "tab\tok", "expected tab typing");

  // a chord: type the command without its first letter, go to the line start with ctrl+a, add it.
  await calls.answered("type", { text: "cho chord-ok > /tmp/exercise-chord.txt" });
  await calls.answered("key", { text: "ctrl+a" });
  await calls.answered("type", { text: "e" });
  await calls.answered("key", { text: "Return", repeat: 1 });
  assert.equal(await readFile(computer, "/tmp/exercise-chord.txt"), "chord-ok", "expected ctrl+a to work");

  // a key sequence with a shifted symbol sent as a key: `echo x! > file` built key by key.
  await calls.answered("type", { text: "echo x" });
  await calls.answered("key", { text: "exclam space greater space" });
  await calls.answered("type", { text: "/tmp/exercise-keys.txt" });
  await calls.answered("key", { text: "KP_Enter" });
  await calls.answered("key", { text: "XF86AudioPlay" });
  assert.equal(await readFile(computer, "/tmp/exercise-keys.txt"), "x!", "expected the key sequence");

  const second = await calls.call("screenshot", {});
  assert.ok(!pngOf(second).equals(pngOf(first)), "expected that the screen changed after the typing");

  // pointer
  await calls.answered("mouse_move", { coordinate: [10, 20] });
  const start = await calls.answered("cursor_position", {});
  assert.ok(start.replaceAll(" ", "").includes("X=10,Y=20"), `expected the pointer at 10,20: ${start}`);
  for (const name of ["right_click", "middle_click", "double_click", "triple_click"]) {
    await calls.answered(name, { coordinate: [600, 20] });
    await calls.answered("key", { text: "Escape" });
  }
  await calls.answered("left_click", { coordinate: [600, 20], text: "shift" });
  await calls.answered("left_click", {});
  await calls.answered("left_click_drag", { start_coordinate: [50, 50], coordinate: [90, 90] });
  await calls.answered("left_click_drag", { start_coordinate: [50, 50], coordinate: [90, 90], text: "ctrl" });
  await calls.answered("left_mouse_down", {});
  await calls.answered("mouse_move", { coordinate: [120, 120] });
  await calls.answered("left_mouse_up", {});
  const dragged = await calls.answered("cursor_position", {});
  assert.ok(
    dragged.replaceAll(" ", "").includes("X=120,Y=120"),
    `expected the pointer at 120,120: ${dragged}`,
  );
  await calls.answered("scroll", { coordinate: [300, 200], scroll_direction: "down", scroll_amount: 3 });
  await calls.answered("scroll", { coordinate: [300, 200], scroll_direction: "left", scroll_amount: 2 });
  await calls.answered("scroll", { scroll_direction: "up", scroll_amount: 1, text: "ctrl" });

  // keys held and waits
  await calls.answered("hold_key", { text: "shift", duration: 1 });
  await calls.answered("wait", { duration: 1 });

  // zoom: a 200x100 region comes back scaled up, keeping its shape, within a screenshot's size
  const [zoomWidth, zoomHeight] = pngSize(pngOf(await calls.call("zoom", { region: [0, 0, 200, 100] })));
  assert.ok(zoomWidth <= computer.width && zoomHeight <= computer.height, "zoom fits the budget");
  assert.ok(
    zoomWidth > 200 && Math.abs(zoomWidth / zoomHeight - 2) < 0.02,
    `zoom scaled up: ${zoomWidth}x${zoomHeight}`,
  );

  // refusals
  await calls.refused("left_click", { coordinate: [computer.width, computer.height] }, "outside");
  await calls.refused("mouse_move", { coordinate: [-1, 5] }, "outside");
  await calls.refused("zoom", { region: [100, 100, 50, 50] }, "region must satisfy");
  await calls.refused("wait", { duration: 31 }, "between 0 and 30");
  await calls.refused("hold_key", { text: "shift", duration: 60 }, "between 0 and 30");
  await calls.refused("key", { text: "NoSuchKeyName" }, "Unknown key");
  await calls.refused("key", { text: "a+ctrl" }, "not a modifier");
  await calls.refused("type", { text: "bell\u0007" }, "control keys");
  await calls.refused("scroll", { scroll_direction: "down", scroll_amount: 0 }, "scroll_amount");

  checkExercisedMembers(calls.exercised, enabledMembers(computer));
};

/** A desktop larger than the screenshot budget: screenshots are scaled down, coordinates scaled up. */
const exerciseScaledDesktop = async (): Promise<void> => {
  const computer = await DaytonaComputer.create({ resolution: [2560, 1440], confirm: () => true });
  const calls = new ComputerCalls(computer);
  try {
    assert.deepEqual([computer.width, computer.height], [1920, 1080], "expected a 0.75 scale");
    const shot = pngSize(pngOf(await calls.call("screenshot", {})));
    assert.deepEqual(shot, [1920, 1080], `expected the screenshot scaled to 1920x1080: ${shot.join("x")}`);
    await calls.answered("mouse_move", { coordinate: [960, 540] });
    const real = await computer.sandbox.computerUse.mouse.getPosition();
    assert.deepEqual([real.x, real.y], [1280, 720], `expected the real pointer at 1280,720: ${real.x},${real.y}`);
    const position = await calls.answered("cursor_position", {});
    assert.ok(position.replaceAll(" ", "").includes("X=960,Y=540"), `expected 960,540: ${position}`);
    await calls.refused("left_click", { coordinate: [1920, 100] }, "outside the 1920x1080");
  } finally {
    await computer.close();
  }
};

/** A sandbox the caller passes in is not the driver's to delete. */
const exerciseBorrowedSandbox = async (): Promise<void> => {
  const borrowed = await throwawaySandbox();
  try {
    const computer = await DaytonaComputer.create({ sandbox: borrowed, confirm: () => true });
    try {
      await new ComputerCalls(computer).call("screenshot", {});
    } finally {
      await computer.close();
    }
    await borrowed.refreshData();
    assert.equal(String(borrowed.state), "started", "expected that a passed-in sandbox survives close()");
  } finally {
    await borrowed.delete();
  }
};

const main = async (): Promise<void> => {
  const borrowed = await borrowedSandbox();
  let computer: DaytonaComputer;
  try {
    // No one is at the terminal, so this confirm approves every call.
    computer = await DaytonaComputer.create({
      ...(borrowed === undefined ? {} : { sandbox: borrowed }),
      confirm: () => true,
    });
  } catch (error: unknown) {
    // no Daytona credentials, or the sandbox did not come up
    return reportFailure(error);
  }
  const sandboxId = computer.sandbox.id;
  console.log(`sandbox ${sandboxId}: screen ${computer.width}x${computer.height}`);
  try {
    await exercise(computer);
  } finally {
    await computer.close();
  }
  await computer.close(); // a second close is a no-op
  await sleep(2);

  if (borrowed === undefined) {
    const state = await stateOfSandbox(sandboxId);
    assert.ok(
      ["gone", "destroyed", "destroying"].includes(state),
      `expected the owned sandbox deleted: ${state}`,
    );
    await exerciseScaledDesktop();
    await exerciseBorrowedSandbox();
  } else {
    await borrowed.refreshData();
    assert.equal(String(borrowed.state), "started", "expected that a passed-in sandbox survives close()");
  }
  console.log("\nAll calls came back as expected.");
};

if (invokedDirectly(import.meta.url)) {
  await main();
}
