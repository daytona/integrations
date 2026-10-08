import pngjs from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SCREENSHOT_BOUNDS, decodePng, encodePng, pngDimensions, resizePng, type PngBounds, type PngImage } from "../src/png.js";

const { PNG } = pngjs;

function image(width: number, height: number, pixels: readonly number[]): PngImage {
  return { width, height, data: Buffer.from(pixels) };
}

/**
 * A PNG that is nothing but its header: the 8-byte signature and one IHDR chunk, with no IDAT
 * behind it. This is the attack shape the bounds exist for — 33 bytes on the wire can claim any
 * dimensions at all, and `PNG.sync.read` sizes its RGBA buffer from them before it has verified
 * a single pixel.
 */
const header = (width: number, height: number): Buffer => {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "latin1");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer.writeUInt8(8, 24); // bit depth
  buffer.writeUInt8(6, 25); // colour type: RGBA
  return buffer;
};

const opaque = (width: number, height: number): Buffer =>
  encodePng({ width, height, data: Buffer.alloc(width * height * 4, 255) });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PNG helpers", () => {
  it("round-trips RGBA pixels through pngjs", () => {
    // Given: a small RGBA image with distinct pixels
    const original = image(2, 2, [
      10, 20, 30, 255,
      40, 50, 60, 200,
      70, 80, 90, 128,
      100, 110, 120, 0,
    ]);

    // When: the image is encoded and decoded
    const decoded = decodePng(encodePng(original), SCREENSHOT_BOUNDS);

    // Then: dimensions and every interleaved RGBA byte are preserved
    expect(decoded.width).toBe(original.width);
    expect(decoded.height).toBe(original.height);
    expect(decoded.data.equals(original.data)).toBe(true);
  });

  it("produces the requested dimensions for downscale and upscale", () => {
    // Given: an image larger than the downscaled output and smaller than the upscaled output
    const original = image(4, 3, new Array(4 * 3 * 4).fill(128));

    // When: the image is resized in both directions
    const downscaled = resizePng(original, 2, 2);
    const upscaled = resizePng(original, 8, 6);

    // Then: each result has exactly the requested dimensions
    expect(downscaled.width).toBe(2);
    expect(downscaled.height).toBe(2);
    expect(upscaled.width).toBe(8);
    expect(upscaled.height).toBe(6);
  });

  it("box-averages a 2x2 checkerboard to uniform mid-grey", () => {
    // Given: a black-and-white checkerboard with opaque pixels
    const checkerboard = image(2, 2, [
      0, 0, 0, 255,
      255, 255, 255, 255,
      255, 255, 255, 255,
      0, 0, 0, 255,
    ]);

    // When: the checkerboard is downscaled to one pixel
    const downscaled = resizePng(checkerboard, 1, 1);

    // Then: the area average is uniform mid-grey, including all RGB channels
    expect([...downscaled.data]).toEqual([128, 128, 128, 255]);
  });
});

describe("pngDimensions", () => {
  it("reads an oversized IHDR without inflating anything", () => {
    // Given: 33 bytes claiming a 100000x100000 image, with no pixel data behind them
    const inflate = vi.spyOn(PNG.sync, "read");

    // When: the header is read
    const dimensions = pngDimensions(header(100_000, 100_000));

    // Then: the claimed dimensions come back and the inflater was never reached
    expect(dimensions).toEqual({ width: 100_000, height: 100_000 });
    expect(inflate).not.toHaveBeenCalled();
  });

  it("agrees with the dimensions pngjs decodes from a real image", () => {
    // Given: a genuinely encoded 7x5 PNG
    const encoded = opaque(7, 5);

    // When: the header alone is read
    const dimensions = pngDimensions(encoded);

    // Then: it reports what the full decode reports
    expect(dimensions).toEqual({ width: 7, height: 5 });
  });

  it.each([
    ["an empty buffer", Buffer.alloc(0)],
    ["a buffer shorter than the header", opaque(2, 2).subarray(0, 23)],
    ["a buffer with no PNG signature", Buffer.alloc(64, 0x42)],
    ["an IHDR chunk of the wrong length", (() => { const b = header(4, 4); b.writeUInt32BE(12, 8); return b; })()],
    ["a first chunk that is not IHDR", (() => { const b = header(4, 4); b.write("IDAT", 12, "latin1"); return b; })()],
  ])("refuses %s", (_name, buffer) => {
    // Given: malformed input       When: the header is read      Then: it throws rather than guessing
    expect(() => pngDimensions(buffer)).toThrow(RangeError);
  });
});

describe("decodePng bounds", () => {
  it.each([
    ["an oversized IHDR", header(100_000, 100_000)],
    ["a width past the per-side ceiling", header(8193, 16)],
    ["a height past the per-side ceiling", header(16, 8193)],
    ["a pixel count past the budget", header(8192, 8192)],
    ["a zero width", header(0, 800)],
    ["a zero height", header(1280, 0)],
  ])("refuses %s before reaching the inflater", (_name, buffer) => {
    // Given: a header-only PNG whose claimed dimensions violate the screenshot bounds
    const inflate = vi.spyOn(PNG.sync, "read");

    // When: it is decoded
    const decode = (): PngImage => decodePng(buffer, SCREENSHOT_BOUNDS);

    // Then: it is refused and pngjs never allocated from the attacker's dimensions
    expect(decode).toThrow(RangeError);
    expect(inflate).not.toHaveBeenCalled();
  });

  it("refuses input past the byte cap before reaching the inflater", () => {
    // Given: a valid 8x8 PNG and bounds whose byte cap is smaller than it
    const encoded = opaque(8, 8);
    const tight: PngBounds = { ...SCREENSHOT_BOUNDS, maxBytes: encoded.length - 1 };
    const inflate = vi.spyOn(PNG.sync, "read");

    // When: it is decoded under those bounds
    const decode = (): PngImage => decodePng(encoded, tight);

    // Then: the cap refuses it on length alone
    expect(decode).toThrow(RangeError);
    expect(inflate).not.toHaveBeenCalled();
  });

  it.each([
    ["a truncated image", opaque(8, 8).subarray(0, 40)],
    ["garbage of header length", Buffer.alloc(64, 0x42)],
  ])("refuses %s", (_name, buffer) => {
    // Given: input that is not a decodable PNG   When: decoded   Then: it throws rather than
    // returning a half-read image — the header guard catches one, pngjs's own parser the other.
    expect(() => decodePng(buffer, SCREENSHOT_BOUNDS)).toThrow();
  });

  it.each([[1280, 800], [1920, 1080]])("decodes a real %sx%s screenshot", (width, height) => {
    // Given: a genuine screenshot-sized PNG, before and after a display resize
    const encoded = opaque(width, height);

    // When: it is decoded under the screenshot bounds
    const decoded = decodePng(encoded, SCREENSHOT_BOUNDS);

    // Then: the bounds admit it unchanged
    expect([decoded.width, decoded.height]).toEqual([width, height]);
    expect(decoded.data.length).toBe(width * height * 4);
  });
});
