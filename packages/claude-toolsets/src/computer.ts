// allow: SIZE_OK — this indivisible class implements the SDK's complete 17-member computer contract.
import {
  BetaAbstractComputerToolset20260801,
  ToolError,
  type BetaComputerCursorPositionResult,
  type BetaComputerToolsetOptions,
  type BetaScreenshotResult,
  type BetaToolsetCallContext,
} from "@anthropic-ai/sdk/helpers/beta/toolsets";
import type {
  BetaComputerCursorPositionInput,
  BetaComputerDoubleClickInput,
  BetaComputerHoldKeyInput,
  BetaComputerKeyInput,
  BetaComputerLeftClickDragInput,
  BetaComputerLeftClickInput,
  BetaComputerLeftMouseDownInput,
  BetaComputerLeftMouseUpInput,
  BetaComputerMiddleClickInput,
  BetaComputerMouseMoveInput,
  BetaComputerRightClickInput,
  BetaComputerScreenshotInput,
  BetaComputerScrollInput,
  BetaComputerTripleClickInput,
  BetaComputerTypeInput,
  BetaComputerWaitInput,
  BetaComputerZoomInput,
} from "@anthropic-ai/sdk/resources/beta";
import { DaytonaError } from "@daytona/sdk";
import type { Daytona, Sandbox } from "@daytona/sdk";

import { XKEYSYMS, desktopKey, parseChord, splitSequence } from "./keys.js";
import { decodePng, encodePng, resizePng, type PngImage } from "./png.js";
import {
  SandboxLease,
  type CreateParams,
  type OnClose,
  type SandboxCreator,
} from "./sandbox.js";
import { BUTTONS, XTest, type Action } from "./xtest.js";

export const MAX_DURATION = 30;
export const MAX_REPEAT = 100;
export const MAX_SCROLL = 50;
export const NATIVE_INPUT_FLOOR_ERROR = "This sandbox's platform does not support native held input; recreate the sandbox on a current Daytona version.";

const WHEEL = {
  up: "up",
  down: "down",
  left: "wheel_left",
  right: "wheel_right",
} as const;

type Size = readonly [number, number];
type Point = readonly [number, number];

export type DaytonaComputerOptions = BetaComputerToolsetOptions & {
  readonly sandbox?: Sandbox;
  readonly daytona?: Daytona | SandboxCreator<Sandbox>;
  readonly createParams?: CreateParams;
  readonly onClose?: OnClose;
  readonly resolution?: Size;
  readonly maxScreenshotSize?: Size;
  readonly settleDelay?: number;
  readonly createTimeout?: number;
};

class DaytonaComputerClosedError extends Error {
  readonly name = "DaytonaComputerClosedError";
}

class DesktopStartError extends Error {
  readonly name = "DesktopStartError";
}

const sleep = (seconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/**
 * Daytona-backed implementation of the Anthropic computer toolset.
 *
 * DESIGN NOTE — one class, deliberately, not an oversight.
 *
 * `BetaAbstractComputerToolset20260801` is an abstract base whose 17 members are `protected`
 * overrides on a single subclass; the SDK dispatches to `this.left_click`, `this.key`, ... itself.
 * The member handlers therefore cannot move into collaborator objects without re-implementing that
 * dispatch and widening their visibility. The contract, not the file, chooses the unit.
 *
 * What looks like several responsibilities is one: translating a model coordinate or keystroke into
 * the input the sandbox desktop will actually accept. That decision is not separable, because every
 * part of it reads the same pinned state — `screen`/`scale` (set once at startup, see
 * {@link cursor_position}), `nativeInputCapability` (the one-shot probe whose result decides between
 * the native endpoints and XTest for EVERY member), and `lastInput` (the screenshot freshness
 * delay). Routing a single `key` call needs the key model, the probe result and the XTest runner at
 * once; splitting them would thread the same three values through every hop.
 *
 * What IS separable is already separated, into single-purpose modules this class only consumes:
 * `keys.ts` (the key model and chord parsing), `xtest.ts` (the helper-script runner), `png.ts`
 * (decode/encode/resize), `sandbox.ts` (lease lifecycle), `text.ts` (result vocabulary). What
 * remains is the irreducible adapter between the SDK contract and those modules.
 *
 * Regression risk is carried by tests rather than by file size: the suite asserts all 17 member
 * declarations plus their behaviour, and the whole surface is additionally exercised live against a
 * real sandbox by `examples/exerciseComputer.ts`.
 */
export class DaytonaComputer extends BetaAbstractComputerToolset20260801 {
  private lease: SandboxLease<Sandbox> | undefined;
  private xtest: XTest | undefined;
  private readonly maxSize: Size;
  private readonly settleDelay: number;
  private lastInput = 0;
  private screen: Size = [0, 0];
  private scale = 1;
  private nativeInputCapability: boolean | undefined;

  private constructor(options: BetaComputerToolsetOptions, maxSize: Size, settleDelay: number) {
    super(options);
    this.maxSize = maxSize;
    this.settleDelay = settleDelay;
  }

  static async create(options: DaytonaComputerOptions = {}): Promise<DaytonaComputer> {
    const {
      sandbox,
      daytona,
      createParams,
      onClose = "delete",
      resolution = [1280, 800],
      maxScreenshotSize = [1920, 1200],
      settleDelay = 0.3,
      createTimeout = 120,
      configs,
      confirm,
      toolConfigs,
    } = options;
    const computer = new DaytonaComputer({ configs, confirm, toolConfigs }, maxScreenshotSize, settleDelay);
    try {
      computer.lease = await SandboxLease.acquire(sandbox, {
        ...(daytona === undefined ? {} : { daytona }),
        ...(createParams === undefined ? {} : { createParams }),
        defaultEnv: { VNC_RESOLUTION: `${resolution[0]}x${resolution[1]}` },
        onClose,
        createTimeout,
      });
      computer.xtest = new XTest(computer.lease.sandbox);
      await computer.startDesktop();
      return computer;
    } catch (error: unknown) {
      await computer.close();
      throw error;
    }
  }

  get sandbox(): Sandbox {
    if (this.lease === undefined) {
      throw new DaytonaComputerClosedError("this DaytonaComputer is closed");
    }
    return this.lease.sandbox;
  }

  get width(): number {
    return Math.round(this.screen[0] * this.scale);
  }

  get height(): number {
    return Math.round(this.screen[1] * this.scale);
  }

  override async close(): Promise<void> {
    await super.close();
    const lease = this.lease;
    const xtest = this.xtest;
    this.lease = undefined;
    this.xtest = undefined;
    if (lease === undefined) return;
    if (!lease.owned && xtest !== undefined) await xtest.cleanup();
    await lease.release();
  }

  private async startDesktop(): Promise<void> {
    const sandbox = this.sandbox;
    if (sandbox.state !== "started") await sandbox.start();
    if ((await sandbox.computerUse.getStatus()).status !== "active") await sandbox.computerUse.start();
    const deadline = performance.now() + 60_000;
    while (true) {
      try {
        const displays = (await sandbox.computerUse.display.getInfo()).displays ?? [];
        if ((await sandbox.computerUse.getStatus()).status === "active" && displays.length > 0) {
          const primary = displays.find((display) => display.isActive) ?? displays[0];
          if (primary === undefined) throw new DesktopStartError("the sandbox desktop reported no displays");
          this.setScreen(primary.width ?? 0, primary.height ?? 0);
          return;
        }
      } catch (error: unknown) {
        if (!(error instanceof DaytonaError)) throw error;
      }
      if (performance.now() > deadline) throw new DesktopStartError("the sandbox desktop did not start within 60 seconds");
      await sleep(1);
    }
  }

  private setScreen(width: number, height: number): void {
    if (width <= 0 || height <= 0) throw new DesktopStartError("the sandbox desktop reported no screen size");
    this.screen = [width, height];
    this.scale = Math.min(1, this.maxSize[0] / width, this.maxSize[1] / height);
  }

  private async desktop<T>(action: string, isInput: boolean, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error: unknown) {
      if (error instanceof DaytonaError) {
        throw new ToolError(`The sandbox desktop could not ${action}.`);
      }
      throw error;
    } finally {
      if (isInput) this.lastInput = performance.now() / 1000;
    }
  }

  private toScreen(x: number, y: number): Point {
    if (!(0 <= x && x < this.width && 0 <= y && y < this.height)) {
      throw new ToolError(`(${x}, ${y}) is outside the ${this.width}x${this.height} screen.`);
    }
    if (this.scale === 1) return [x, y];
    return [
      Math.min(this.screen[0] - 1, Math.trunc(x / this.scale)),
      Math.min(this.screen[1] - 1, Math.trunc(y / this.scale)),
    ];
  }

  /**
   * The point in NATIVE screen pixels. A supplied model coordinate is bounds-checked and converted
   * by {@link toScreen}; with no coordinate the live pointer position is already native, so it is
   * returned as-is. Every caller but {@link cursor_position} wants native pixels because that is
   * what the desktop API takes — `cursor_position` is the one that reports back to the model, and
   * it does the inverse scaling and the clamp into the advertised screenshot bounds itself.
   */
  private async point(coordinate: number[] | null | undefined): Promise<Point> {
    if (coordinate !== null && coordinate !== undefined) {
      const [x, y] = coordinate;
      if (x === undefined || y === undefined) throw new ToolError("coordinate must contain x and y values.");
      return this.toScreen(x, y);
    }
    const position = await this.desktop("read the pointer position", false, () => this.sandbox.computerUse.mouse.getPosition());
    return [position.x ?? 0, position.y ?? 0];
  }

  private heldKeysyms(text: string | null | undefined): string[] {
    if (!text) return [];
    const [modifiers, token] = parseChord(text.trim());
    const keysyms: string[] = modifiers.map((modifier) => XKEYSYMS[modifier as keyof typeof XKEYSYMS]);
    if (token !== null) {
      const key = desktopKey(token);
      if (key.shift && !keysyms.includes("Shift_L")) keysyms.push("Shift_L");
      keysyms.push(key.keysym);
    }
    return keysyms;
  }

  private async runXtest(actions: readonly Action[]): Promise<void> {
    if (this.xtest === undefined) throw new DaytonaComputerClosedError("this DaytonaComputer is closed");
    await this.desktop("send the input", true, () => this.xtest?.run(actions) ?? Promise.reject(new DaytonaComputerClosedError("this DaytonaComputer is closed")));
  }

  private async nativeInputSupported(): Promise<boolean> {
    if (this.nativeInputCapability !== undefined) return this.nativeInputCapability;
    try {
      await this.sandbox.computerUse.mouse.down(0);
    } catch (error: unknown) {
      if (!(error instanceof DaytonaError)) throw error;
      switch (error.statusCode) {
        case 400:
          this.nativeInputCapability = true;
          break;
        case 404:
          this.nativeInputCapability = false;
          break;
        default:
          throw error;
      }
    }
    if (this.nativeInputCapability === undefined) {
      this.nativeInputCapability = true;
      await this.desktop("release the mouse button", true, () => this.sandbox.computerUse.mouse.up());
    }
    return this.nativeInputCapability;
  }

  private async requireNativeInput(): Promise<void> {
    if (!(await this.nativeInputSupported())) throw new ToolError(NATIVE_INPUT_FLOOR_ERROR);
  }

  private withKeysHeld(keysyms: readonly string[], actions: readonly Action[]): Action[] {
    return [
      ...keysyms.map((keysym): Action => ["keydown", keysym]),
      ...actions,
      ...[...keysyms].reverse().map((keysym): Action => ["keyup", keysym]),
    ];
  }

  private async click(coordinate: number[] | null | undefined, text: string | null | undefined, button: keyof Pick<typeof BUTTONS, "left" | "right" | "middle">, count = 1): Promise<void> {
    const [x, y] = await this.point(coordinate);
    const [modifiers, token] = text ? parseChord(text.trim()) : [[], null];
    if (token === null) {
      if (count > 2 || modifiers.length > 0) await this.requireNativeInput();
      await this.desktop("click", true, () => this.sandbox.computerUse.mouse.click(x, y, button, count === 2, count, modifiers));
      return;
    }
    const presses = Array.from({ length: count }, (): readonly Action[] => [["down", BUTTONS[button]], ["up", BUTTONS[button]]]).flat();
    await this.runXtest([["move", x, y], ...this.withKeysHeld(this.heldKeysyms(text), presses)]);
  }

  private async settle(): Promise<void> {
    const remaining = this.lastInput + this.settleDelay - performance.now() / 1000;
    if (remaining > 0) await sleep(remaining);
  }

  private async screenshotPng(): Promise<{ readonly png: Buffer; readonly image: PngImage }> {
    await this.settle();
    const response = await this.desktop("take a screenshot", false, () => this.sandbox.computerUse.screenshot.takeFullScreen());
    const png = Buffer.from(response.screenshot ?? "", "base64");
    const image = decodePng(png);
    if (image.width !== this.screen[0] || image.height !== this.screen[1]) this.setScreen(image.width, image.height);
    return { png, image };
  }

  protected override async screenshot(_context: BetaToolsetCallContext, _input: BetaComputerScreenshotInput): Promise<BetaScreenshotResult> {
    const { png, image } = await this.screenshotPng();
    const output = this.scale < 1 ? encodePng(resizePng(image, this.width, this.height)) : png;
    return { data: output.toString("base64"), mediaType: "image/png" };
  }

  protected override async zoom(_context: BetaToolsetCallContext, input: BetaComputerZoomInput): Promise<BetaScreenshotResult> {
    const [x0, y0, x1, y1] = input.region;
    if (x0 === undefined || y0 === undefined || x1 === undefined || y1 === undefined || !(0 <= x0 && x0 < x1 && x1 <= this.width && 0 <= y0 && y0 < y1 && y1 <= this.height)) {
      throw new ToolError(`region must satisfy 0 <= x0 < x1 <= ${this.width} and 0 <= y0 < y1 <= ${this.height} (the screen in screenshot pixels).`);
    }
    const left = Math.trunc(x0 / this.scale);
    const top = Math.trunc(y0 / this.scale);
    const right = Math.min(this.screen[0], Math.max(left + 1, Math.round(x1 / this.scale)));
    const bottom = Math.min(this.screen[1], Math.max(top + 1, Math.round(y1 / this.scale)));
    const { image } = await this.screenshotPng();
    const crop: PngImage = {
      width: right - left,
      height: bottom - top,
      data: Buffer.alloc((right - left) * (bottom - top) * 4),
    };
    for (let row = 0; row < crop.height; row += 1) {
      image.data.copy(
        crop.data,
        row * crop.width * 4,
        ((top + row) * image.width + left) * 4,
        ((top + row) * image.width + right) * 4,
      );
    }
    const factor = Math.min(this.width / crop.width, this.height / crop.height);
    const output = resizePng(crop, Math.max(1, Math.round(crop.width * factor)), Math.max(1, Math.round(crop.height * factor)));
    return { data: encodePng(output).toString("base64"), mediaType: "image/png" };
  }

  /**
   * The screen geometry and `scale` are read once, at construction, on purpose: the SDK advertises
   * `display_width_px`/`display_height_px` to the model a single time, so re-reading a display that
   * changed mid-session would make the driver's reports disagree with the size the model was told.
   * The result is clamped into those advertised bounds regardless, so it can never name a pixel
   * outside the screenshots the model has seen.
   */
  protected override async cursor_position(_context: BetaToolsetCallContext, _input: BetaComputerCursorPositionInput): Promise<BetaComputerCursorPositionResult> {
    const [x, y] = await this.point(undefined);
    return { x: Math.min(this.width - 1, Math.trunc(x * this.scale)), y: Math.min(this.height - 1, Math.trunc(y * this.scale)) };
  }

  protected override async mouse_move(_context: BetaToolsetCallContext, input: BetaComputerMouseMoveInput): Promise<void> {
    const [x, y] = await this.point(input.coordinate);
    await this.desktop("move the pointer", true, () => this.sandbox.computerUse.mouse.move(x, y));
  }

  protected override async left_click(_context: BetaToolsetCallContext, input: BetaComputerLeftClickInput): Promise<void> { await this.click(input.coordinate, input.text, "left"); }
  protected override async right_click(_context: BetaToolsetCallContext, input: BetaComputerRightClickInput): Promise<void> { await this.click(input.coordinate, input.text, "right"); }
  protected override async middle_click(_context: BetaToolsetCallContext, input: BetaComputerMiddleClickInput): Promise<void> { await this.click(input.coordinate, input.text, "middle"); }
  protected override async double_click(_context: BetaToolsetCallContext, input: BetaComputerDoubleClickInput): Promise<void> { await this.click(input.coordinate, input.text, "left", 2); }
  protected override async triple_click(_context: BetaToolsetCallContext, input: BetaComputerTripleClickInput): Promise<void> { await this.click(input.coordinate, input.text, "left", 3); }

  protected override async left_click_drag(_context: BetaToolsetCallContext, input: BetaComputerLeftClickDragInput): Promise<void> {
    const start = await this.point(input.start_coordinate);
    const end = await this.point(input.coordinate);
    const [modifiers, token] = input.text ? parseChord(input.text.trim()) : [[], null];
    if (token === null) {
      if (modifiers.length > 0) await this.requireNativeInput();
      await this.desktop("drag", true, () => this.sandbox.computerUse.mouse.drag(start[0], start[1], end[0], end[1], "left", modifiers));
      return;
    }
    const drag: readonly Action[] = [["down", 1], ["move", end[0], end[1]], ["up", 1]];
    await this.runXtest([["move", start[0], start[1]], ...this.withKeysHeld(this.heldKeysyms(input.text), drag)]);
  }

  protected override async left_mouse_down(_context: BetaToolsetCallContext, _input: BetaComputerLeftMouseDownInput): Promise<void> {
    await this.requireNativeInput();
    await this.desktop("press the mouse button", true, () => this.sandbox.computerUse.mouse.down());
  }

  protected override async left_mouse_up(_context: BetaToolsetCallContext, _input: BetaComputerLeftMouseUpInput): Promise<void> {
    await this.requireNativeInput();
    await this.desktop("release the mouse button", true, () => this.sandbox.computerUse.mouse.up());
  }

  protected override async scroll(_context: BetaToolsetCallContext, input: BetaComputerScrollInput): Promise<void> {
    if (!(1 <= input.scroll_amount && input.scroll_amount <= MAX_SCROLL)) throw new ToolError(`scroll_amount must be between 1 and ${MAX_SCROLL}.`);
    const [x, y] = await this.point(input.coordinate);
    const [modifiers, token] = input.text ? parseChord(input.text.trim()) : [[], null];
    if (token === null) {
      if (input.scroll_direction === "left" || input.scroll_direction === "right" || modifiers.length > 0) await this.requireNativeInput();
      await this.desktop("scroll", true, () => this.sandbox.computerUse.mouse.scroll(x, y, input.scroll_direction, input.scroll_amount, modifiers));
      return;
    }
    const number = BUTTONS[WHEEL[input.scroll_direction]];
    const notches = Array.from({ length: input.scroll_amount }, (): readonly Action[] => [["down", number], ["up", number]]).flat();
    await this.runXtest([["move", x, y], ...this.withKeysHeld(this.heldKeysyms(input.text), notches)]);
  }

  protected override async key(_context: BetaToolsetCallContext, input: BetaComputerKeyInput): Promise<void> {
    const repeat = input.repeat ?? 1;
    if (!(1 <= repeat && repeat <= MAX_REPEAT)) throw new ToolError(`repeat must be between 1 and ${MAX_REPEAT}.`);
    const chords = splitSequence(input.text).map((chord) => parseChord(chord));
    for (let iteration = 0; iteration < repeat; iteration += 1) {
      for (const [modifiers, token] of chords) await this.press(modifiers, token);
    }
  }

  private async press(modifiers: string[], token: string | null): Promise<void> {
    if (token === null) {
      await this.runXtest(this.withKeysHeld(modifiers.map((modifier) => XKEYSYMS[modifier as keyof typeof XKEYSYMS]), []));
      return;
    }
    const key = desktopKey(token);
    const held = [...modifiers];
    if (key.shift && !held.includes("shift")) held.push("shift");
    if (key.daytona !== null) {
      if (key.daytona.startsWith("num")) await this.requireNativeInput();
      await this.desktop("press the key", true, () => this.sandbox.computerUse.keyboard.press(key.daytona ?? "", held));
    } else if (modifiers.length === 0 && key.char !== null) {
      await this.desktop("type the character", true, () => this.sandbox.computerUse.keyboard.type(key.char ?? ""));
    } else {
      await this.runXtest(this.withKeysHeld(held.map((modifier) => XKEYSYMS[modifier as keyof typeof XKEYSYMS]), [["keydown", key.keysym], ["keyup", key.keysym]]));
    }
  }

  protected override async hold_key(_context: BetaToolsetCallContext, input: BetaComputerHoldKeyInput): Promise<void> {
    if (!(0 <= input.duration && input.duration <= MAX_DURATION)) throw new ToolError(`duration must be between 0 and ${MAX_DURATION} seconds.`);
    const chords = splitSequence(input.text);
    if (chords.length !== 1) throw new ToolError("hold_key holds one key or chord, such as shift or ctrl+a.");
    const chord = chords[0];
    if (chord === undefined) throw new ToolError("hold_key holds one key or chord, such as shift or ctrl+a.");
    const [modifiers, token] = parseChord(chord);
    const key = token === null ? null : desktopKey(token);
    if (key !== null && key.daytona === null) {
      await this.runXtest(this.withKeysHeld(this.heldKeysyms(chord), [["sleep", input.duration]]));
      return;
    }
    const held = [...modifiers];
    if (key !== null) {
      if (key.shift && !held.includes("shift")) held.push("shift");
      if (key.daytona !== null) held.push(key.daytona);
    }
    await this.requireNativeInput();
    const keyboard = this.sandbox.computerUse.keyboard;
    await this.desktop("hold the key", true, async () => {
      const pressed: string[] = [];
      let primaryError: unknown;
      try {
        for (const name of held) {
          await keyboard.down(name);
          pressed.push(name);
        }
        await sleep(input.duration);
      } catch (error: unknown) {
        primaryError = error;
        throw error;
      } finally {
        // Every key must be released even if one release fails, so no error — of any type —
        // leaves the rest of the chord held down. The first one is kept and rethrown after the
        // loop, and only when it would not mask the error that brought us into this `finally`.
        let releaseError: unknown;
        let released = false;
        for (const name of [...pressed].reverse()) {
          try {
            await keyboard.up(name);
          } catch (error: unknown) {
            if (!released) { releaseError = error; released = true; }
          }
        }
        if (primaryError === undefined && released) throw releaseError;
      }
    });
  }

  protected override async type_(_context: BetaToolsetCallContext, input: BetaComputerTypeInput): Promise<void> {
    if ([...input.text].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (code < 0x20 && !"\n\r\t".includes(character)) || code === 0x7f;
    })) throw new ToolError("type sends text; send control keys with key, as in ctrl+c.");
    await this.requireNativeInput();
    await this.desktop("type the text", true, () => this.sandbox.computerUse.keyboard.type(input.text));
  }

  protected override async wait(_context: BetaToolsetCallContext, input: BetaComputerWaitInput): Promise<void> {
    if (!(0 <= input.duration && input.duration <= MAX_DURATION)) throw new ToolError(`duration must be between 0 and ${MAX_DURATION} seconds.`);
    await sleep(input.duration);
  }
}
