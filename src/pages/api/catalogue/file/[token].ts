import { createHash } from "node:crypto";
import type { NextApiRequest, NextApiResponse } from "next";
import { logError, recordCounter } from "@/lib/observability";
import { getClientKey, rateLimitAsync } from "@/lib/rateLimit";
import { PUBLIC_TOKEN_RE } from "@/lib/catalogue/schema";
import { getPublicFileByToken, getPublicFileMetaByToken } from "@/lib/catalogue/versions";

/**
 * Public, token-addressed catalogue PDF: GET/HEAD /api/catalogue/file/<token>.
 *
 *  - The token is unguessable (192 bits) and carries no PII. There is no index: an unknown token,
 *    a malformed token and a DRAFT all answer the same 404, so nothing can be enumerated.
 *  - Only published and superseded versions are reachable. A draft is admin-download only.
 *  - The bytes behind a token never change, so the response is cacheable (ETag = sha256 of the PDF)
 *    by the browser AND by the platform CDN (s-maxage), which absorbs repeat downloads.
 *  - The link is handed to any Messenger user, so the token is effectively public. Each request
 *    that reaches the database is rate limited per client IP, and the (up to 25 MB) bytes are kept
 *    in a small content-addressed memory cache so a PDF viewer's burst of Range requests reads the
 *    BYTEA from Neon once, not once per Range.
 *  - Meta's servers and phones can fetch it; the normal Messenger path uploads the bytes to Meta
 *    instead (attachment id), this URL is the fallback link and the "open in browser" target.
 */
export const config = {
  api: { responseLimit: false },
  maxDuration: 30,
};

const CACHE_CONTROL = "public, max-age=3600, s-maxage=3600, immutable";
const CHUNK_BYTES = 256 * 1024;

/** Per client IP, per minute. A real reader opens the file once or a handful of times. */
const RATE_LIMIT_PER_MINUTE = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

/** At most this many bytes of PDFs are held, for this long, per warm function instance. */
const BYTES_CACHE_MAX_TOTAL = 40 * 1024 * 1024;
const BYTES_CACHE_TTL_MS = 120_000;
const bytesCache = new Map<string, { bytes: Buffer; expires: number }>();

function cachedBytes(sha256: string, sizeBytes: number): Buffer | null {
  const hit = bytesCache.get(sha256);
  if (!hit) return null;
  if (hit.expires <= Date.now() || hit.bytes.length !== sizeBytes) {
    bytesCache.delete(sha256);
    return null;
  }
  return hit.bytes;
}

/** Keyed by the content hash, and only stored once the bytes really hash to it. */
function rememberBytes(sha256: string, bytes: Buffer): void {
  if (bytes.length > BYTES_CACHE_MAX_TOTAL) return;
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) return;
  const now = Date.now();
  let total = bytes.length;
  for (const [key, entry] of bytesCache) {
    if (entry.expires <= now || key === sha256) bytesCache.delete(key);
    else total += entry.bytes.length;
  }
  // Map keeps insertion order: drop the oldest until the new file fits.
  for (const key of bytesCache.keys()) {
    if (total <= BYTES_CACHE_MAX_TOTAL) break;
    total -= bytesCache.get(key)!.bytes.length;
    bytesCache.delete(key);
  }
  bytesCache.set(sha256, { bytes, expires: now + BYTES_CACHE_TTL_MS });
}

/** `inline; filename="ascii.pdf"; filename*=UTF-8''percent-encoded.pdf` (RFC 6266 / 5987). */
function contentDispositionInline(fileName: string): string {
  const clean = fileName.replace(/[\r\n"\\]+/g, "").trim() || "UUDAM_Catalogue.pdf";
  const ascii = clean.replace(/[^A-Za-z0-9._-]+/g, "_");
  const utf8 = encodeURIComponent(clean).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

function notFound(res: NextApiResponse, method: string | undefined): void {
  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  if (method === "HEAD") res.end();
  else res.end("Not found");
}

function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  const value = Array.isArray(header) ? header.join(",") : header;
  if (!value) return false;
  return value
    .split(",")
    .map((part) => part.trim().replace(/^W\//, ""))
    .some((part) => part === "*" || part === etag);
}

/** One `bytes=a-b` range. null = no/ignored range header; "invalid" = unsatisfiable. */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null; // multi-range or junk: serve the whole file
  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix <= 0) return "invalid";
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || start > end) return "invalid";
  return { start, end };
}

function writeBody(res: NextApiResponse, bytes: Buffer): void {
  if (bytes.length <= CHUNK_BYTES * 4) {
    res.end(bytes);
    return;
  }
  // Large PDFs go out as a stream of chunks instead of one buffered body.
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
    res.write(bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.length)));
  }
  res.end();
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const method = (req.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    res.statusCode = 405;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method not allowed");
    return;
  }

  const raw = req.query.token;
  const token = typeof raw === "string" ? raw : "";
  if (!PUBLIC_TOKEN_RE.test(token)) return notFound(res, method);

  try {
    // Before any database read: an unauthenticated route must not be a free egress meter.
    const limit = await rateLimitAsync(`catalogue_file:${getClientKey(req)}`, RATE_LIMIT_PER_MINUTE, RATE_LIMIT_WINDOW_MS);
    if (!limit.allowed) {
      recordCounter("catalogue.public_file_rate_limited_total", 1);
      res.statusCode = 429;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000))));
      res.end(method === "HEAD" ? undefined : "Too many requests");
      return;
    }

    const meta = await getPublicFileMetaByToken(token);
    if (!meta) return notFound(res, method);

    const etag = `"${meta.sha256}"`;
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", CACHE_CONTROL);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Disposition", contentDispositionInline(meta.fileName));

    if (etagMatches(req.headers["if-none-match"], etag)) {
      res.statusCode = 304;
      res.end();
      return;
    }

    res.setHeader("Content-Type", "application/pdf");
    if (method === "HEAD") {
      res.statusCode = 200;
      res.setHeader("Content-Length", String(meta.sizeBytes));
      res.end();
      return;
    }

    // The metadata read above proved the token is still published, so bytes remembered under its
    // content hash are safe to serve without another trip to the database.
    let bytes = cachedBytes(meta.sha256, meta.sizeBytes);
    if (!bytes) {
      const file = await getPublicFileByToken(token);
      if (!file) return notFound(res, method); // pruned between the two reads
      bytes = file.bytes;
      rememberBytes(meta.sha256, bytes);
    }
    const size = bytes.length;
    const range = parseRange(req.headers.range, size);
    if (range === "invalid") {
      res.statusCode = 416;
      res.setHeader("Content-Range", `bytes */${size}`);
      res.end();
      return;
    }
    if (range) {
      const body = bytes.subarray(range.start, range.end + 1);
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
      res.setHeader("Content-Length", String(body.length));
      writeBody(res, body);
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Length", String(size));
    writeBody(res, bytes);
  } catch (error) {
    logError("catalogue.public_file_failed", { message: error instanceof Error ? error.message : String(error) });
    if (res.headersSent) {
      res.end();
      return;
    }
    res.statusCode = 503;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Retry-After", "30");
    res.end("Temporarily unavailable");
  }
}
