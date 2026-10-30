import type { NextApiResponse } from "next";
import { Readable } from "node:stream";
import { readCustomerImage } from "./customerImageStorage";

/**
 * Streams a customer file to an admin behind a signed link: from the private Blob store, or
 * (until migrated) from our Cloudinary copy or Meta's CDN, fetched by the server. The
 * browser is never redirected to a public URL. Images and PDFs open inline; every other
 * type is a download, never rendered.
 */
const FETCHABLE_HOST = /(?:^|\.)(?:res\.cloudinary\.com|fbcdn\.net|fbsbx\.com)$/i;

export type ProxyOutcome = "served" | "not_found" | "unavailable";

function setHeaders(res: NextApiResponse, contentType: string) {
  const type = contentType.split(";")[0].trim().toLowerCase();
  const inline = type.startsWith("image/") || type === "application/pdf";
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Security-Policy", "default-src 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Type", inline ? type : "application/octet-stream");
  if (!inline) res.setHeader("Content-Disposition", "attachment");
}

async function pipe(res: NextApiResponse, stream: ReadableStream) {
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(stream as Parameters<typeof Readable.fromWeb>[0])
      .on("error", reject).pipe(res).on("finish", resolve).on("error", reject);
  });
}

export function isPrivateBlobUrl(url: string): boolean {
  try { return new URL(url).hostname.endsWith(".blob.vercel-storage.com"); } catch { return false; }
}

/** Never throws; the caller turns a non-served outcome into its status code. */
export async function serveAdminFile(
  res: NextApiResponse,
  input: { url: string; mimeType?: string },
  read: (url: string) => ReturnType<typeof readCustomerImage> = readCustomerImage,
): Promise<ProxyOutcome> {
  let url: URL;
  try { url = new URL(input.url); } catch { return "not_found"; }
  if (url.protocol !== "https:") return "not_found";
  try {
    if (url.hostname.endsWith(".blob.vercel-storage.com")) {
      const blob = await read(input.url);
      if (!blob || blob.statusCode !== 200) return "unavailable";
      setHeaders(res, blob.blob.contentType || input.mimeType || "");
      await pipe(res, blob.stream as ReadableStream);
      return "served";
    }
    if (!FETCHABLE_HOST.test(url.hostname)) return "not_found";
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (!response.ok || !response.body) return "unavailable";
    setHeaders(res, response.headers.get("content-type") || input.mimeType || "");
    await pipe(res, response.body);
    return "served";
  } catch {
    if (res.headersSent) res.destroy();
    return res.headersSent ? "served" : "unavailable";
  }
}
