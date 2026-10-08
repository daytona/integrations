import pngjs from "pngjs";

const { PNG } = pngjs;
const CHANNEL_COUNT = 4;

export type PngImage = {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
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

export function decodePng(data: Buffer): PngImage {
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
