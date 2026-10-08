import { describe, expect, it } from "vitest";

import { decodePng, encodePng, resizePng, type PngImage } from "../src/png.js";

function image(width: number, height: number, pixels: readonly number[]): PngImage {
  return { width, height, data: Buffer.from(pixels) };
}

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
    const decoded = decodePng(encodePng(original));

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
