import { createHash } from "node:crypto";
import sharp from "sharp";

/**
 * Drops photo URLs that show the SAME image as one already kept.
 *
 * Two levels, because staff re-export posters in several ways:
 *  1. byte hash  — an identical re-upload (observed on Далянь: 4 attachments,
 *     ~15MB, two MD5-identical pairs).
 *  2. perceptual hash — the same poster re-encoded or re-saved, so the bytes
 *     differ but the picture does not (observed on Хайлаар Чичихар: pages sent
 *     as PNG and again as JPG; and on Шанхай+Ханжоу: the same 2160x5160 page as
 *     a 5.8MB PNG and a 721KB JPEG).
 * A plain `new Set()` on the URL can catch neither: every re-upload gets a fresh
 * Cloudinary public id.
 *
 * Among duplicates the SMALLEST file wins — identical picture, fewer bytes over
 * Messenger. Fails OPEN: anything we cannot fetch or decode is kept, because
 * dropping a real photo is worse than leaving a duplicate.
 */
export async function dedupePhotoUrlsByContent(
  urls: string[],
  options: { timeoutMs?: number } = {},
): Promise<string[]> {
  const timeoutMs = options.timeoutMs ?? 8000;

  type Entry = {
    url: string;
    index: number;
    bytes: number;
    byteHash: string | null;
    fingerprint: string | null;
    ratio: number | null;
  };

  const entries: Entry[] = [];
  const seenUrls = new Set<string>();
  let index = 0;

  for (const url of urls) {
    if (typeof url !== "string" || !url) continue;
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);
    entries.push({ url, index: index++, ...(await describeRemoteImage(url, timeoutMs)) });
  }

  const kept: Entry[] = [];
  for (const entry of entries) {
    // Undecodable — keep it, we cannot prove it is a duplicate.
    if (!entry.byteHash) {
      kept.push(entry);
      continue;
    }
    const twinAt = kept.findIndex((k) => isSameImage(k, entry));
    if (twinAt === -1) {
      kept.push(entry);
      continue;
    }
    // Same picture: keep whichever costs the customer less to download.
    if (entry.bytes > 0 && entry.bytes < kept[twinAt].bytes) kept[twinAt] = entry;
  }

  return kept.sort((a, b) => a.index - b.index).map((e) => e.url);
}

function isSameImage(a: { byteHash: string | null; fingerprint: string | null; ratio: number | null },
                     b: { byteHash: string | null; fingerprint: string | null; ratio: number | null }): boolean {
  if (a.byteHash && b.byteHash && a.byteHash === b.byteHash) return true;
  if (!a.fingerprint || !b.fingerprint) return false;
  // Same shape AND same low-frequency content. Both are required: posters for
  // different tours share a template, so the aspect ratio alone means nothing.
  if (a.ratio === null || b.ratio === null) return false;
  if (Math.abs(a.ratio - b.ratio) > 0.01) return false;
  return hammingDistance(a.fingerprint, b.fingerprint) <= 4;
}

async function describeRemoteImage(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return { bytes: 0, byteHash: null, fingerprint: null, ratio: null };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return { bytes: 0, byteHash: null, fingerprint: null, ratio: null };
    const byteHash = createHash("md5").update(buf).digest("hex");
    let fingerprint: string | null = null;
    let ratio: number | null = null;
    try {
      const image = sharp(buf);
      const meta = await image.metadata();
      if (meta.width && meta.height) ratio = meta.width / meta.height;
      // 8x8 average hash: survives re-encoding and rescaling, differs for
      // genuinely different pages.
      const raw = await image.greyscale().resize(8, 8, { fit: "fill" }).raw().toBuffer();
      const mean = raw.reduce((sum, v) => sum + v, 0) / raw.length;
      fingerprint = Array.from(raw).map((v) => (v >= mean ? "1" : "0")).join("");
    } catch {
      fingerprint = null;
    }
    return { bytes: buf.length, byteHash, fingerprint, ratio };
  } catch {
    return { bytes: 0, byteHash: null, fingerprint: null, ratio: null };
  } finally {
    clearTimeout(timer);
  }
}

function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.MAX_SAFE_INTEGER;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}
