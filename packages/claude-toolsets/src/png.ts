import pngjs from "pngjs";

const { PNG } = pngjs;
const CHANNEL_COUNT = 4;

/** `\x89PNG\r\n\x1a\n`, the 8 bytes every PNG stream starts with. */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Signature (8) + IHDR length (4) + IHDR type (4) + all 13 IHDR bytes, the last being interlace. */
const HEADER_LENGTH = 29;
/** IHDR always carries exactly 13 bytes: width, height, depth, colour, compression, filter, interlace. */
const IHDR_DATA_LENGTH = 13;
/** Offsets of the three IHDR method bytes, which PNG defines only value 0 for (interlace also 1). */
const COMPRESSION_METHOD = 26;
const FILTER_METHOD = 27;
const INTERLACE_METHOD = 28;

export type PngImage = {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
};

/** What one decode may cost: input bytes, each dimension, and the pixel count behind them. */
export type PngBounds = {
  readonly maxBytes: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly maxPixels: number;
};

/**
 * What a screenshot that came out of a sandbox may cost the host process to decode.
 *
 * These cannot be an equality check against the screen the driver last saw: a desktop may
 * legitimately be resized mid-session, and `DaytonaComputer.screenshotPng` handles exactly that
 * by calling `setScreen` with whatever the new frame reports. So they are a fixed ceiling —
 * generous enough that no real desktop reaches one, tight enough that a compromised sandbox
 * cannot turn a single screenshot into an out-of-memory kill of the process holding the API keys.
 *
 * - `maxBytes` 64 MiB — the compressed PNG the host will hold and hand to the inflater. A 4K
 *   desktop screenshot is a few MB, so this is a decimal order of magnitude of headroom. It caps
 *   the input, not what the input inflates to; that is bounded instead by {@link pngDimensions}
 *   refusing interlace, which leaves pngjs on the path where it caps inflation at the image's own
 *   expected size — and the dimensions below cap that.
 * - `maxWidth`/`maxHeight` 8192 — past any display a sandbox runs (the driver's own default is
 *   1280x800 and its `maxScreenshotSize` default 1920x1200), and bounding each side separately
 *   also refuses a degenerate 1x4294967295 header.
 * - `maxPixels` 40M — about 8192x4883, and ~160 MB once pngjs expands it to RGBA: the largest
 *   single allocation one frame is allowed to cause. Without it an attacker spends 25 header
 *   bytes on a 100000x100000 IHDR and the host spends 40 GB.
 */
export const SCREENSHOT_BOUNDS: PngBounds = {
  maxBytes: 64 * 1024 * 1024,
  maxWidth: 8192,
  maxHeight: 8192,
  maxPixels: 40_000_000,
};

function assertDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new RangeError("PNG dimensions must be positive integers");
  }
}

function assertPixelData(image: PngImage): void {
  const expectedLength = image.width * image.height * CHANNEL_COUNT;
  if (image.data.length !== expectedLength) {
    throw new RangeError("PNG pixel data length does not match its dimensions");
  }
}

/**
 * The IHDR width and height, read from 29 bytes of header and inflating nothing.
 *
 * This exists so a header can be refused BEFORE {@link decodePng} reaches `PNG.sync.read`, which
 * sizes its RGBA buffer from those same fields before it has verified a single pixel — so an
 * oversized header alone, with no pixel data behind it, is enough to exhaust the host.
 *
 * The three IHDR method bytes are checked here for the same reason, and the interlace one is not
 * cosmetic. pngjs bounds its own inflation only on the straight-laced path: `parser-sync` passes
 * `maxLength: rowSize * height` to its inflater for a plain image, but hands an interlaced one to
 * a bare `zlib.inflateSync`, whose default output ceiling is `buffer.kMaxLength`. The dimension
 * bounds below therefore do not contain an interlaced frame at all — measured on pngjs 7.0.0 and
 * Node 22, an 8.3 MB IDAT of deflated zeros behind an in-bounds 1000x1000 interlaced IHDR peaks at
 * 16.6 GiB of RSS before pngjs rejects the (now fully materialised) data, while the byte-identical
 * header with interlace 0 peaks at 56 MiB. `--max-old-space-size` does not help: the inflated
 * bytes are external buffer memory, not V8 heap. Sandbox screenshots are never interlaced, so the
 * cheap fix is to refuse the method outright and leave every decode that proceeds on the path
 * pngjs already bounds to the image's own expected size. pngjs exposes no option to set that
 * ceiling from the outside, so refusing here is the whole of the defence.
 */
export function pngDimensions(data: Buffer): { readonly width: number; readonly height: number } {
  if (data.length < HEADER_LENGTH) throw new RangeError("PNG is too short to hold an IHDR header");
  if (!data.subarray(0, SIGNATURE.length).equals(SIGNATURE)) throw new RangeError("PNG signature is missing");
  if (data.readUInt32BE(8) !== IHDR_DATA_LENGTH) throw new RangeError("PNG IHDR chunk has the wrong length");
  if (data.toString("latin1", 12, 16) !== "IHDR") throw new RangeError("PNG does not open with an IHDR chunk");
  if (data.readUInt8(COMPRESSION_METHOD) !== 0) throw new RangeError("PNG declares an unknown compression method");
  if (data.readUInt8(FILTER_METHOD) !== 0) throw new RangeError("PNG declares an unknown filter method");
  if (data.readUInt8(INTERLACE_METHOD) !== 0) throw new RangeError("PNG is interlaced, whose inflation pngjs does not bound");
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

export function decodePng(data: Buffer, bounds: PngBounds): PngImage {
  if (data.length > bounds.maxBytes) throw new RangeError(`PNG of ${data.length} bytes exceeds the ${bounds.maxBytes} byte budget`);
  const { width, height } = pngDimensions(data);
  if (width < 1 || height < 1 || width > bounds.maxWidth || height > bounds.maxHeight) {
    throw new RangeError(`PNG ${width}x${height} is outside the accepted ${bounds.maxWidth}x${bounds.maxHeight}`);
  }
  if (width * height > bounds.maxPixels) throw new RangeError(`PNG ${width}x${height} exceeds the ${bounds.maxPixels} pixel budget`);

  const image = PNG.sync.read(data);
  return {
    width: image.width,
    height: image.height,
    data: image.data,
  };
}

export function encodePng(image: PngImage): Buffer {
  assertDimensions(image.width, image.height);
  assertPixelData(image);

  const output = new PNG({ width: image.width, height: image.height });
  output.data.set(image.data);
  return PNG.sync.write(output);
}

export function resizePng(image: PngImage, width: number, height: number): PngImage {
  assertDimensions(image.width, image.height);
  assertPixelData(image);
  assertDimensions(width, height);

  if (width === image.width && height === image.height) {
    return { width, height, data: Buffer.from(image.data) };
  }

  const data = Buffer.alloc(width * height * CHANNEL_COUNT);
  if (width < image.width || height < image.height) {
    for (let outputY = 0; outputY < height; outputY += 1) {
      const sourceTop = (outputY * image.height) / height;
      const sourceBottom = ((outputY + 1) * image.height) / height;
      const firstSourceY = Math.floor(sourceTop);
      const lastSourceY = Math.ceil(sourceBottom);

      for (let outputX = 0; outputX < width; outputX += 1) {
        const sourceLeft = (outputX * image.width) / width;
        const sourceRight = ((outputX + 1) * image.width) / width;
        const firstSourceX = Math.floor(sourceLeft);
        const lastSourceX = Math.ceil(sourceRight);
        const sums = [0, 0, 0, 0];
        let totalWeight = 0;

        for (let sourceY = firstSourceY; sourceY < lastSourceY; sourceY += 1) {
          const yWeight = Math.min(sourceBottom, sourceY + 1) - Math.max(sourceTop, sourceY);
          for (let sourceX = firstSourceX; sourceX < lastSourceX; sourceX += 1) {
            const weight = yWeight * (Math.min(sourceRight, sourceX + 1) - Math.max(sourceLeft, sourceX));
            const sourceIndex = (sourceY * image.width + sourceX) * CHANNEL_COUNT;
            for (let channel = 0; channel < CHANNEL_COUNT; channel += 1) {
              sums[channel] = (sums[channel] ?? 0) + image.data.readUInt8(sourceIndex + channel) * weight;
            }
            totalWeight += weight;
          }
        }

        const outputIndex = (outputY * width + outputX) * CHANNEL_COUNT;
        for (let channel = 0; channel < CHANNEL_COUNT; channel += 1) {
          data.writeUInt8(Math.round((sums[channel] ?? 0) / totalWeight), outputIndex + channel);
        }
      }
    }
  } else {
    for (let outputY = 0; outputY < height; outputY += 1) {
      const sourceY = Math.max(0, Math.min(image.height - 1, ((outputY + 0.5) * image.height) / height - 0.5));
      const topY = Math.max(0, Math.floor(sourceY));
      const bottomY = Math.min(image.height - 1, topY + 1);
      const yWeight = sourceY - topY;

      for (let outputX = 0; outputX < width; outputX += 1) {
        const sourceX = Math.max(0, Math.min(image.width - 1, ((outputX + 0.5) * image.width) / width - 0.5));
        const leftX = Math.max(0, Math.floor(sourceX));
        const rightX = Math.min(image.width - 1, leftX + 1);
        const xWeight = sourceX - leftX;
        const topLeftIndex = (topY * image.width + leftX) * CHANNEL_COUNT;
        const topRightIndex = (topY * image.width + rightX) * CHANNEL_COUNT;
        const bottomLeftIndex = (bottomY * image.width + leftX) * CHANNEL_COUNT;
        const bottomRightIndex = (bottomY * image.width + rightX) * CHANNEL_COUNT;
        const outputIndex = (outputY * width + outputX) * CHANNEL_COUNT;

        for (let channel = 0; channel < CHANNEL_COUNT; channel += 1) {
          const top = image.data.readUInt8(topLeftIndex + channel) +
            (image.data.readUInt8(topRightIndex + channel) - image.data.readUInt8(topLeftIndex + channel)) * xWeight;
          const bottom = image.data.readUInt8(bottomLeftIndex + channel) +
            (image.data.readUInt8(bottomRightIndex + channel) - image.data.readUInt8(bottomLeftIndex + channel)) * xWeight;
          data.writeUInt8(Math.round(top + (bottom - top) * yWeight), outputIndex + channel);
        }
      }
    }
  }

  return { width, height, data };
}
