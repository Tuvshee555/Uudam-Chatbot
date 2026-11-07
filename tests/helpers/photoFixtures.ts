import { createHash } from "node:crypto";
import sharp from "sharp";

/**
 * A small JPEG whose picture depends on `seed` (a photo's URL): a different seed gives a
 * different 8x8 pattern of light and dark blocks, so the photo finder's content check
 * (an identical or near-identical picture is kept once) sees real, different pictures.
 * A flat colour would make every fixture photo "the same picture".
 */
export async function pictureFor(seed: string) {
  const bits = createHash("sha256").update(seed).digest();
  const size = 64;
  const raw = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const cell = Math.floor(y / 8) * 8 + Math.floor(x / 8);
      const light = (bits[cell >> 3] >> (cell & 7)) & 1;
      raw.fill(light ? 215 : 40, (y * size + x) * 3, (y * size + x) * 3 + 3);
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } }).jpeg().toBuffer();
}
