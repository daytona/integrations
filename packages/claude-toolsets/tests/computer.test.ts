import { ToolsetClosedError, ToolsetConfigError } from "@anthropic-ai/sdk/helpers/beta/toolsets";
import { DaytonaError } from "@daytona/sdk";
import pngjs from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DaytonaComputer, INVALID_SCREENSHOT_ERROR, NATIVE_INPUT_FLOOR_ERROR } from "../src/computer.js";
import { SCREENSHOT_BOUNDS, decodePng, encodePng } from "../src/png.js";
import { callMember, imageData, mockSandbox, resultText, xtestActions } from "./helpers.js";

const { PNG } = pngjs;

/** The 33 bytes of signature + IHDR that are enough to claim any dimensions at all. */
const pngHeader = (width: number, height: number): string => {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "latin1");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer.writeUInt8(8, 24);
  buffer.writeUInt8(6, 25);
  return buffer.toString("base64");
};

const approve = async (): Promise<boolean> => true;

const computer = async (mock = mockSandbox(), options: { readonly maxScreenshotSize?: readonly [number, number]; readonly settleDelay?: number } = {}) => ({
  mock,
  toolset: await DaytonaComputer.create({ sandbox: mock.sandbox, confirm: approve, settleDelay: 0, ...options }),
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DaytonaComputer setup and members", () => {
  it("requires confirmation while keyboard members are enabled", async () => {
    const mock = mockSandbox();
    await expect(DaytonaComputer.create({ sandbox: mock.sandbox })).rejects.toBeInstanceOf(ToolsetConfigError);
    expect(mock.raw.computerUse.getStatus).not.toHaveBeenCalled();
  });

  it("passes disabled keyboard configs through without requiring confirmation", async () => {
    const off = { enabled: false } as const;
    const mock = mockSandbox();
    const toolset = await DaytonaComputer.create({ sandbox: mock.sandbox, configs: { type: off, key: off, hold_key: off }, settleDelay: 0 });
    expect(toolset.configs?.type).toEqual(off);
    await toolset.close();
  });

  it("offers every SDK computer member", async () => {
    const { toolset } = await computer();
    expect(Object.values(toolset.toJSON().configs ?? {}).filter((config) => config?.enabled === false)).toEqual([]);
    await toolset.close();
  });

  it("starts a stopped sandbox and inactive desktop", async () => {
    const mock = mockSandbox();
    mock.raw.state = "stopped";
    mock.raw.computerUse.getStatus.mockResolvedValueOnce({ status: "inactive" }).mockResolvedValue({ status: "active" });
    const toolset = await DaytonaComputer.create({ sandbox: mock.sandbox, confirm: approve, settleDelay: 0 });
    expect(mock.raw.start).toHaveBeenCalledOnce();
    expect(mock.raw.computerUse.start).toHaveBeenCalledOnce();
    await toolset.close();
  });
});

describe("DaytonaComputer coordinates and screenshots", () => {
  it.each([[1280, 10], [10, 800], [-1, 0]])("refuses off-screen coordinate (%s, %s) instead of clamping", async (x, y) => {
    const { mock, toolset } = await computer();
    const result = await callMember(toolset, "left_click", { coordinate: [x, y] });
    expect(result.is_error).toBe(true);
    expect(resultText(result)).toContain("outside the 1280x800 screen");
    expect(mock.raw.computerUse.mouse.click).not.toHaveBeenCalled();
    await toolset.close();
  });

  it("scales model coordinates and cursor position against a larger display", async () => {
    const { mock, toolset } = await computer(mockSandbox(2560, 1440));
    expect([toolset.width, toolset.height]).toEqual([1920, 1080]);
    await callMember(toolset, "mouse_move", { coordinate: [960, 540] });
    expect(mock.raw.computerUse.mouse.move).toHaveBeenCalledWith(1280, 720);
    mock.raw.computerUse.mouse.getPosition.mockResolvedValue({ x: 2559, y: 1439 });
    expect(resultText(await callMember(toolset, "cursor_position", {}))).toBe("X=1919,Y=1079");
    const image = decodePng(Buffer.from(imageData(await callMember(toolset, "screenshot", {})), "base64"), SCREENSHOT_BOUNDS);
    expect([image.width, image.height]).toEqual([1920, 1080]);
    await toolset.close();
  });

  // The bounds are a ceiling, not an equality check against the known screen, precisely because
  // the desktop may be resized under the driver — in either direction.
  it.each([[640, 480], [1920, 1080]])("always decodes screenshots and updates dimensions after a resize to %sx%s", async (width, height) => {
    const { mock, toolset } = await computer();
    mock.raw.computerUse.screenshot.takeFullScreen.mockResolvedValue({ screenshot: encodePng({ width, height, data: Buffer.alloc(width * height * 4, 255) }).toString("base64") });
    await callMember(toolset, "screenshot", {});
    expect([toolset.width, toolset.height]).toEqual([width, height]);
    await toolset.close();
  });

  it("crops zoom regions in display pixels and scales the crop up", async () => {
    const { mock, toolset } = await computer();
    const result = await callMember(toolset, "zoom", { region: [10, 20, 210, 120] });
    expect(mock.raw.computerUse.screenshot.takeFullScreen).toHaveBeenCalledOnce();
    expect(mock.raw.computerUse.screenshot.takeRegion).not.toHaveBeenCalled();
    const image = decodePng(Buffer.from(imageData(result), "base64"), SCREENSHOT_BOUNDS);
    expect([image.width, image.height]).toEqual([1280, 640]);

    // The fixture encodes each source coordinate into its pixel, so the corners prove WHICH
    // rectangle was copied — not just that something 1280x640 came back. The region is
    // [10, 20, 210, 120] in model space on a 1280x800 display (scale 1), so the crop's
    // top-left is source (10, 20) and its bottom-right is source (209, 119).
    const pixelAt = (x: number, y: number): ReadonlyArray<number | undefined> => {
      const at = (y * image.width + x) * 4;
      return [image.data[at], image.data[at + 1], image.data[at + 2]];
    };
    expect(pixelAt(0, 0)).toEqual([10, 20, 0]);
    expect(pixelAt(image.width - 1, image.height - 1)).toEqual([209, 119, 0]);
    await toolset.close();
  });

  it("refuses an invalid zoom region", async () => {
    const { toolset } = await computer();
    const result = await callMember(toolset, "zoom", { region: [0, 0, 1281, 10] });
    expect(result.is_error).toBe(true);
    expect(resultText(result)).toContain("region must satisfy 0 <= x0 < x1 <= 1280");
    await toolset.close();
  });

  it.each(["screenshot", "zoom"])("waits for the settle delay before %s", async (member) => {
    vi.useFakeTimers();
    const { toolset } = await computer(mockSandbox(), { settleDelay: 0.3 });
    await callMember(toolset, "left_click", { coordinate: [10, 10] });
    const result = callMember(toolset, member, member === "zoom" ? { region: [10, 20, 210, 120] } : {});
    await vi.advanceTimersByTimeAsync(299);
    expect(await Promise.race([result.then(() => "done"), Promise.resolve("waiting")])).toBe("waiting");
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBeDefined();
    await toolset.close();
  });
});

describe("DaytonaComputer screenshot decoding bounds", () => {
  it.each(["screenshot", "zoom"])("refuses an oversized IHDR from the sandbox before inflating, during %s", async (member) => {
    // Given: a sandbox that answers with 33 header bytes claiming a 100000x100000 screen
    const { mock, toolset } = await computer();
    mock.raw.computerUse.screenshot.takeFullScreen.mockResolvedValue({ screenshot: pngHeader(100_000, 100_000) });
    const inflate = vi.spyOn(PNG.sync, "read");

    // When: the member that decodes a screenshot runs
    const result = await callMember(toolset, member, member === "zoom" ? { region: [10, 20, 210, 120] } : {});

    // Then: it fails with the fixed phrase and pngjs never allocated 40 GB from that header
    expect(result.is_error).toBe(true);
    expect(resultText(result)).toBe(INVALID_SCREENSHOT_ERROR);
    expect(inflate).not.toHaveBeenCalled();
    await toolset.close();
  });

  it.each([
    ["truncated PNG bytes", encodePng({ width: 8, height: 8, data: Buffer.alloc(8 * 8 * 4, 255) }).subarray(0, 40).toString("base64")],
    ["bytes that are not a PNG at all", Buffer.alloc(64, 0x42).toString("base64")],
    ["an empty screenshot", ""],
  ])("refuses %s with the fixed phrase", async (_name, screenshot) => {
    // Given: a sandbox answering with undecodable bytes
    const { mock, toolset } = await computer();
    mock.raw.computerUse.screenshot.takeFullScreen.mockResolvedValue({ screenshot });

    // When: a screenshot is taken
    const result = await callMember(toolset, "screenshot", {});

    // Then: the model is told nothing the sandbox chose
    expect(resultText(result)).toBe(INVALID_SCREENSHOT_ERROR);
    await toolset.close();
  });

  it("refuses an over-cap screenshot before decoding the base64 into a Buffer", async () => {
    // Given: a payload one character past ceil(64 MiB * 4 / 3), the longest base64 the cap admits
    const { mock, toolset } = await computer();
    mock.raw.computerUse.screenshot.takeFullScreen.mockResolvedValue({ screenshot: "A".repeat(Math.ceil((SCREENSHOT_BOUNDS.maxBytes * 4) / 3) + 1) });
    const allocate = vi.spyOn(Buffer, "from");

    // When: a screenshot is taken
    const result = await callMember(toolset, "screenshot", {});

    // Then: the cap applied to the length, so the oversized payload never reached an allocation
    expect(resultText(result)).toBe(INVALID_SCREENSHOT_ERROR);
    expect(allocate.mock.calls.some((call) => typeof call[0] === "string" && call[0].length > 1_000)).toBe(false);
    await toolset.close();
  });

  it("tells the model the desktop changed size when the zoom region no longer fits the new frame", async () => {
    // Given: a 1280x800 screen, and a sandbox that answers the zoom's screenshot with 100x100
    const { mock, toolset } = await computer();
    mock.raw.computerUse.screenshot.takeFullScreen.mockResolvedValue({ screenshot: encodePng({ width: 100, height: 100, data: Buffer.alloc(100 * 100 * 4, 255) }).toString("base64") });

    // When: a region valid for 1280x800 is zoomed
    const result = await callMember(toolset, "zoom", { region: [10, 20, 210, 120] });

    // Then: the crop is refused rather than copied from outside the decoded image — but the frame
    // itself was perfectly valid, so the model is told what actually happened and what the screen
    // is now, not that the sandbox returned an invalid screenshot.
    expect(result.is_error).toBe(true);
    expect(resultText(result)).toBe(`The desktop changed size; ${"region must satisfy 0 <= x0 < x1 <= 100 and 0 <= y0 < y1 <= 100 (the screen in screenshot pixels)."}`);
    expect(resultText(result)).not.toContain(INVALID_SCREENSHOT_ERROR);
    expect([toolset.width, toolset.height]).toEqual([100, 100]);
    await toolset.close();
  });

  it("zooms a region that still fits after the desktop shrinks, recomputing the crop from the new scale", async () => {
    // Given: a first zoom on the 1280x800 display the driver started with, then a desktop that
    // shrinks to 640x400 before the second zoom's screenshot
    const { mock, toolset } = await computer();
    expect((await callMember(toolset, "zoom", { region: [0, 0, 200, 100] })).is_error).toBeFalsy();
    const shrunk = 4;
    mock.raw.computerUse.screenshot.takeFullScreen.mockResolvedValue({
      screenshot: encodePng({
        width: 640, height: 400,
        // Each pixel carries its own source coordinate, so the crop's corners prove which
        // rectangle of the SHRUNKEN frame was copied.
        data: Buffer.from(Uint8Array.from({ length: 640 * 400 * shrunk }, (_unused, index) =>
          index % shrunk === 0 ? Math.floor(index / shrunk) % 640 : index % shrunk === 1 ? Math.floor(index / shrunk / 640) : index % shrunk === 2 ? 0 : 255)),
      }).toString("base64"),
    });

    // When: the same region, still inside 640x400, is zoomed again
    const result = await callMember(toolset, "zoom", { region: [0, 0, 200, 100] });

    // Then: it succeeds against the fresh frame instead of failing on the stale screen size
    expect(result.is_error).toBeFalsy();
    const image = decodePng(Buffer.from(imageData(result), "base64"), SCREENSHOT_BOUNDS);
    expect([toolset.width, toolset.height]).toEqual([640, 400]);
    const pixelAt = (x: number, y: number): ReadonlyArray<number | undefined> => {
      const at = (y * image.width + x) * 4;
      return [image.data[at], image.data[at + 1]];
    };
    expect(pixelAt(0, 0)).toEqual([0, 0]);
    expect(pixelAt(image.width - 1, image.height - 1)).toEqual([199, 99]);
    await toolset.close();
  });
});

describe("DaytonaComputer native and XTest routing", () => {
  it.each([
    ["Return", "enter", []],
    ["ctrl+s", "s", ["ctrl"]],
    ["Page_Up", "pageup", []],
    ["!", "1", ["shift"]],
    ["ctrl+shift+Escape", "escape", ["ctrl", "shift"]],
    ["super+e", "e", ["cmd"]],
  ])("maps key %s to Daytona key %s", async (text, key, modifiers) => {
    const { mock, toolset } = await computer();
    await callMember(toolset, "key", { text });
    expect(mock.raw.computerUse.keyboard.press).toHaveBeenCalledWith(key, modifiers);
    await toolset.close();
  });

  it("runs key sequences in repeat order", async () => {
    const { mock, toolset } = await computer();
    await callMember(toolset, "key", { text: "ctrl+a BackSpace", repeat: 2 });
    expect(mock.raw.computerUse.keyboard.press.mock.calls).toEqual([["a", ["ctrl"]], ["backspace", []], ["a", ["ctrl"]], ["backspace", []]]);
    await toolset.close();
  });

  it("gates verified numpad keys then uses native press", async () => {
    const { mock, toolset } = await computer();
    mock.raw.computerUse.mouse.down.mockRejectedValueOnce(new DaytonaError("probe", 400));
    await callMember(toolset, "key", { text: "KP_Decimal" });
    expect(mock.raw.computerUse.mouse.down).toHaveBeenCalledWith(0);
    expect(mock.raw.computerUse.keyboard.press).toHaveBeenCalledWith("num_decimal", []);
    await toolset.close();
  });

  it.each(["KP_Enter", "KP_Add", "KP_Subtract", "KP_Multiply", "KP_Divide"])("routes %s through XTest", async (text) => {
    const { mock, toolset } = await computer();
    await callMember(toolset, "key", { text });
    expect(xtestActions(mock)).toEqual([["keydown", text], ["keyup", text]]);
    expect(mock.raw.computerUse.keyboard.press).not.toHaveBeenCalled();
    await toolset.close();
  });

  it("orders XTest modifiers around unsupported keys", async () => {
    const { mock, toolset } = await computer();
    await callMember(toolset, "key", { text: "ctrl+XF86AudioPlay" });
    expect(xtestActions(mock)).toEqual([["keydown", "Control_L"], ["keydown", "XF86AudioPlay"], ["keyup", "XF86AudioPlay"], ["keyup", "Control_L"]]);
    await toolset.close();
  });

  it("uses native click arguments for plain clicks", async () => {
    const { mock, toolset } = await computer();
    await callMember(toolset, "right_click", { coordinate: [1, 2] });
    await callMember(toolset, "double_click", {});
    expect(mock.raw.computerUse.mouse.click.mock.calls).toEqual([[1, 2, "right", false, 1, []], [5, 6, "left", true, 2, []]]);
    expect(mock.raw.computerUse.mouse.down).not.toHaveBeenCalled();
    await toolset.close();
  });

  it("uses native routing arguments for triple click, horizontal scroll and modifier drag", async () => {
    const { mock, toolset } = await computer();
    mock.raw.computerUse.mouse.down.mockRejectedValueOnce(new DaytonaError("probe", 400));
    await callMember(toolset, "triple_click", { coordinate: [3, 4] });
    await callMember(toolset, "scroll", { coordinate: [3, 4], scroll_direction: "left", scroll_amount: 2 });
    await callMember(toolset, "left_click_drag", { start_coordinate: [1, 2], coordinate: [3, 4], text: "shift" });
    expect(mock.raw.computerUse.mouse.click).toHaveBeenCalledWith(3, 4, "left", false, 3, []);
    expect(mock.raw.computerUse.mouse.scroll).toHaveBeenCalledWith(3, 4, "left", 2, []);
    expect(mock.raw.computerUse.mouse.drag).toHaveBeenCalledWith(1, 2, 3, 4, "left", ["shift"]);
    await toolset.close();
  });

  it("orders a non-modifier click chord through XTest", async () => {
    const { mock, toolset } = await computer();
    await callMember(toolset, "left_click", { coordinate: [3, 4], text: "ctrl+a" });
    expect(xtestActions(mock)).toEqual([["move", 3, 4], ["keydown", "Control_L"], ["keydown", "a"], ["down", 1], ["up", 1], ["keyup", "a"], ["keyup", "Control_L"]]);
    await toolset.close();
  });

  it("routes mouse down and up natively after one probe", async () => {
    const { mock, toolset } = await computer();
    mock.raw.computerUse.mouse.down.mockRejectedValueOnce(new DaytonaError("probe", 400));
    await callMember(toolset, "left_mouse_down", {});
    await callMember(toolset, "left_mouse_up", {});
    expect(mock.raw.computerUse.mouse.down.mock.calls).toEqual([[0], []]);
    expect(mock.raw.computerUse.mouse.up).toHaveBeenCalledOnce();
    await toolset.close();
  });
});

describe("DaytonaComputer capability probe", () => {
  it("releases an unexpectedly accepted probe before the native action", async () => {
    const { mock, toolset } = await computer();
    await callMember(toolset, "triple_click", { coordinate: [3, 4] });
    expect(mock.raw.computerUse.mouse.down).toHaveBeenCalledOnce();
    expect(mock.raw.computerUse.mouse.down).toHaveBeenCalledWith(0);
    expect(mock.raw.computerUse.mouse.up).toHaveBeenCalledOnce();
    expect(mock.raw.computerUse.mouse.click).toHaveBeenCalledOnce();
    await toolset.close();
  });

  it("surfaces a failed release but keeps the successful capability determination cached", async () => {
    const { mock, toolset } = await computer();
    mock.raw.computerUse.mouse.up.mockRejectedValueOnce(new DaytonaError("release", 500));
    const first = await callMember(toolset, "triple_click", { coordinate: [3, 4] });
    expect(resultText(first)).toBe("The sandbox desktop could not release the mouse button.");
    await callMember(toolset, "triple_click", { coordinate: [3, 4] });
    expect(mock.raw.computerUse.mouse.down).toHaveBeenCalledOnce();
    expect(mock.raw.computerUse.mouse.click).toHaveBeenCalledOnce();
    await toolset.close();
  });

  it("caches a 404 and blocks every migrated route with the byte-identical floor phrase", async () => {
    const { mock, toolset } = await computer();
    mock.raw.computerUse.mouse.down.mockRejectedValue(new DaytonaError("missing", 404));
    for (const [name, input] of [
      ["triple_click", { coordinate: [3, 4] }],
      ["left_click", { coordinate: [3, 4], text: "ctrl" }],
      ["left_mouse_down", {}],
      ["left_click_drag", { start_coordinate: [1, 2], coordinate: [3, 4], text: "shift" }],
      ["scroll", { scroll_direction: "left", scroll_amount: 2 }],
      ["hold_key", { text: "ctrl", duration: 0 }],
      ["type", { text: "a\tb" }],
      ["key", { text: "KP_Decimal" }],
    ] satisfies readonly (readonly [string, object])[]) {
      expect(resultText(await callMember(toolset, name, input))).toBe(NATIVE_INPUT_FLOOR_ERROR);
    }
    expect(mock.raw.computerUse.mouse.down).toHaveBeenCalledOnce();
    await toolset.close();
  });

  it("rethrows an unexpected probe status and does not cache it", async () => {
    const { mock, toolset } = await computer();
    const failure = new DaytonaError("probe failed", 500);
    mock.raw.computerUse.mouse.down.mockRejectedValueOnce(failure).mockRejectedValueOnce(new DaytonaError("supported", 400));
    const first = await callMember(toolset, "triple_click", { coordinate: [3, 4] });
    expect(first.is_error).toBe(true);
    expect(resultText(first)).toBe(`Error: ${failure.message}`);
    const second = await callMember(toolset, "triple_click", { coordinate: [3, 4] });
    expect(second.is_error).not.toBe(true);
    expect(mock.raw.computerUse.mouse.down).toHaveBeenCalledTimes(2);
    await toolset.close();
  });

  it("does not gate plain single or double clicks after unsupported is cached", async () => {
    const { mock, toolset } = await computer();
    mock.raw.computerUse.mouse.down.mockRejectedValue(new DaytonaError("missing", 404));
    await callMember(toolset, "triple_click", { coordinate: [1, 2] });
    await callMember(toolset, "left_click", { coordinate: [3, 4] });
    await callMember(toolset, "double_click", { coordinate: [5, 6] });
    expect(mock.raw.computerUse.mouse.click.mock.calls).toEqual([[3, 4, "left", false, 1, []], [5, 6, "left", true, 2, []]]);
    await toolset.close();
  });
});

describe("DaytonaComputer keyboard, bounds and errors", () => {
  it.each([
    ["wait", { duration: 31 }, "duration must be between 0 and 30 seconds."],
    ["wait", { duration: -1 }, "duration must be between 0 and 30 seconds."],
    ["hold_key", { text: "shift", duration: 31 }, "duration must be between 0 and 30 seconds."],
    ["key", { text: "a", repeat: 101 }, "repeat must be between 1 and 100."],
    ["scroll", { scroll_direction: "down", scroll_amount: 51 }, "scroll_amount must be between 1 and 50."],
  ])("bounds %s inputs with fixed messages", async (name, input, message) => {
    const { toolset } = await computer();
    expect(resultText(await callMember(toolset, name, input))).toBe(message);
    await toolset.close();
  });

  it("holds native keys in order and releases them in reverse order", async () => {
    vi.useFakeTimers();
    const { mock, toolset } = await computer();
    mock.raw.computerUse.mouse.down.mockRejectedValueOnce(new DaytonaError("probe", 400));
    const result = callMember(toolset, "hold_key", { text: "ctrl+shift", duration: 2 });
    await vi.advanceTimersByTimeAsync(2000);
    await result;
    expect(mock.raw.computerUse.keyboard.down.mock.calls).toEqual([["ctrl"], ["shift"]]);
    expect(mock.raw.computerUse.keyboard.up.mock.calls).toEqual([["shift"], ["ctrl"]]);
    await toolset.close();
  });

  it("releases already-held keys after a native hold failure", async () => {
    const { mock, toolset } = await computer();
    mock.raw.computerUse.mouse.down.mockRejectedValueOnce(new DaytonaError("probe", 400));
    mock.raw.computerUse.keyboard.down.mockResolvedValueOnce().mockRejectedValueOnce(new DaytonaError("down failed", 500));
    const result = await callMember(toolset, "hold_key", { text: "ctrl+a", duration: 1 });
    expect(resultText(result)).toBe("The sandbox desktop could not hold the key.");
    expect(mock.raw.computerUse.keyboard.up).toHaveBeenCalledWith("ctrl");
    await toolset.close();
  });

  it("releases every held key when one release throws a non-Daytona error", async () => {
    // A non-DaytonaError used to propagate out of the cleanup loop immediately, leaving the
    // rest of the chord held down on the desktop.
    const { mock, toolset } = await computer();
    mock.raw.computerUse.mouse.down.mockRejectedValueOnce(new DaytonaError("probe", 400));
    mock.raw.computerUse.keyboard.up.mockRejectedValueOnce(new TypeError("transport exploded"));
    const result = await callMember(toolset, "hold_key", { text: "ctrl+shift", duration: 0 });
    expect(result.is_error).toBe(true);
    expect(mock.raw.computerUse.keyboard.up.mock.calls).toEqual([["shift"], ["ctrl"]]);
    await toolset.close();
  });

  it("types tabs and newlines in one native call without inventing a timeout argument", async () => {
    const { mock, toolset } = await computer();
    mock.raw.computerUse.mouse.down.mockRejectedValueOnce(new DaytonaError("probe", 400));
    await callMember(toolset, "type", { text: "a\tb\n" });
    expect(mock.raw.computerUse.keyboard.type).toHaveBeenCalledWith("a\tb\n");
    await toolset.close();
  });

  it("refuses control characters before probing or typing", async () => {
    const { mock, toolset } = await computer();
    const result = await callMember(toolset, "type", { text: "\u001b[A" });
    expect(result.is_error).toBe(true);
    expect(mock.raw.computerUse.mouse.down).not.toHaveBeenCalled();
    expect(mock.raw.computerUse.keyboard.type).not.toHaveBeenCalled();
    await toolset.close();
  });

  it("converts Daytona failures to the fixed desktop phrase", async () => {
    const { mock, toolset } = await computer();
    mock.raw.computerUse.mouse.move.mockRejectedValue(new DaytonaError("boom https://secret.example/x", 500));
    expect(resultText(await callMember(toolset, "mouse_move", { coordinate: [1, 1] }))).toBe("The sandbox desktop could not move the pointer.");
    await toolset.close();
  });
});

describe("DaytonaComputer lease lifecycle", () => {
  it("leaves a borrowed sandbox running and closes idempotently", async () => {
    const { mock, toolset } = await computer();
    await toolset.close();
    await toolset.close();
    expect(mock.raw.delete).not.toHaveBeenCalled();
    expect(mock.raw.stop).not.toHaveBeenCalled();
    await expect(callMember(toolset, "screenshot", {})).rejects.toBeInstanceOf(ToolsetClosedError);
  });

  it("deletes an owned sandbox once and applies resolution defaults", async () => {
    const mock = mockSandbox(1024, 768);
    const create = vi.fn<(params?: object, options?: object) => Promise<typeof mock.sandbox>>(async () => mock.sandbox);
    const toolset = await DaytonaComputer.create({ daytona: { create }, confirm: approve, resolution: [1024, 768], settleDelay: 0 });
    expect(create.mock.calls[0]?.[0]).toMatchObject({ envVars: { VNC_RESOLUTION: "1024x768" }, labels: { "created-by": "daytona-claude-toolsets" } });
    await toolset.close();
    await toolset.close();
    expect(mock.raw.delete).toHaveBeenCalledOnce();
  });

  it("stops an owned sandbox when configured", async () => {
    const mock = mockSandbox();
    const toolset = await DaytonaComputer.create({ daytona: { create: vi.fn(async () => mock.sandbox) }, confirm: approve, onClose: "stop", settleDelay: 0 });
    await toolset.close();
    expect(mock.raw.stop).toHaveBeenCalledOnce();
    expect(mock.raw.delete).not.toHaveBeenCalled();
  });

  it("cleans up an owned sandbox after desktop startup fails", async () => {
    const mock = mockSandbox();
    mock.raw.computerUse.getStatus.mockResolvedValue({ status: "inactive" });
    mock.raw.computerUse.start.mockRejectedValue(new Error("desktop failed"));
    await expect(DaytonaComputer.create({ daytona: { create: vi.fn(async () => mock.sandbox) }, confirm: approve })).rejects.toThrow("desktop failed");
    expect(mock.raw.delete).toHaveBeenCalledOnce();
  });

  it("rejects sandbox and createParams together", async () => {
    const mock = mockSandbox();
    await expect(DaytonaComputer.create({ sandbox: mock.sandbox, createParams: {}, confirm: approve })).rejects.toThrow("pass either sandbox or createParams, not both");
  });
});
