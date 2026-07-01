/**
 * Raw-file chunk reassembly for poster uploads.
 *
 * Vercel caps a serverless request body at ~4.5MB, but poster PDFs (which we
 * must send WHOLE to OpenAI vision to preserve multi-column day order) are
 * often bigger. So the client splits the raw file into <4MB base64 chunks and
 * POSTs them one at a time; we buffer them here keyed by uploadId, and on the
 * final chunk hand back the assembled Buffer.
 *
 * Uses Redis when configured (survives across serverless instances); falls back
 * to a process-local map otherwise (fine for dev / single warm instance).
 */
import { withRedis } from "@/lib/redisState";

const TTL_SECONDS = 600; // an upload must complete within 10 minutes
const mem = new Map<string, { parts: string[]; expires: number }>();

function memKey(uploadId: string, index: number) {
  return `${uploadId}:${index}`;
}

function sweepMem() {
  const now = Date.now();
  for (const [key, val] of mem) {
    if (val.expires < now) mem.delete(key);
  }
}

/** Store one base64 chunk. Returns true on success. */
export async function putChunk(
  uploadId: string,
  index: number,
  total: number,
  base64: string,
): Promise<boolean> {
  const redisOk = await withRedis("poster.chunk.put", async (client) => {
    await client.hset(`poster:upload:${uploadId}`, String(index), base64);
    await client.expire(`poster:upload:${uploadId}`, TTL_SECONDS);
    return true;
  });
  if (redisOk) return true;

  // In-memory fallback
  sweepMem();
  const rec = mem.get(memKey(uploadId, -1)) ?? { parts: [], expires: 0 };
  rec.parts[index] = base64;
  rec.expires = Date.now() + TTL_SECONDS * 1000;
  rec.parts.length = Math.max(rec.parts.length, total);
  mem.set(memKey(uploadId, -1), rec);
  return true;
}

/**
 * Assemble all chunks into one Buffer, or null if any are missing.
 * Clears the stored chunks afterward.
 */
export async function assembleChunks(
  uploadId: string,
  total: number,
): Promise<Buffer | null> {
  const fromRedis = await withRedis("poster.chunk.get", async (client) => {
    const all = await client.hgetall(`poster:upload:${uploadId}`);
    if (!all) return null;
    const parts: string[] = [];
    for (let i = 0; i < total; i++) {
      const p = all[String(i)];
      if (p == null) return null; // missing chunk
      parts[i] = p;
    }
    await client.del(`poster:upload:${uploadId}`);
    return parts;
  });

  let parts: string[] | null = fromRedis ?? null;

  if (!parts) {
    sweepMem();
    const rec = mem.get(memKey(uploadId, -1));
    if (!rec) return null;
    for (let i = 0; i < total; i++) {
      if (rec.parts[i] == null) return null;
    }
    parts = rec.parts.slice(0, total);
    mem.delete(memKey(uploadId, -1));
  }

  try {
    return Buffer.concat(parts.map((b64) => Buffer.from(b64, "base64")));
  } catch {
    return null;
  }
}
