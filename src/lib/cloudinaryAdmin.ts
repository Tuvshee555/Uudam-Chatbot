import { createHash } from "node:crypto";
import { getEnv } from "./env";

/**
 * Exact-asset Cloudinary operations for the historical customer-document migration: read one
 * asset's record, download it through the authenticated API (delivery of PDFs is blocked on
 * this account), and destroy that one asset. Nothing here lists, searches or deletes by
 * prefix or folder. Errors are safe codes, never a URL or credential.
 */
export type CloudinaryAsset = {
  cloudName: string;
  resourceType: "image" | "video" | "raw";
  type: string;
  version: string;
  publicId: string;
  /** Extension of the delivered file; empty for raw assets (it is part of their public id). */
  format: string;
};

/** Only an uploaded asset's own delivery URL (with its version) is accepted. */
export function parseCloudinaryUrl(url: string): CloudinaryAsset | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== "https:" || parsed.hostname !== "res.cloudinary.com" || parsed.search) return null;
  const match = parsed.pathname.match(/^\/([^/]+)\/(image|video|raw)\/(upload|private|authenticated)\/v(\d+)\/(.+)$/);
  if (!match) return null;
  const [, cloudName, resourceType, type, version, rest] = match;
  const file = decodeURIComponent(rest);
  if (resourceType === "raw") return { cloudName, resourceType, type, version, publicId: file, format: "" };
  const dot = file.lastIndexOf(".");
  if (dot <= 0 || file.lastIndexOf("/") > dot) return null;
  return { cloudName, resourceType: resourceType as "image" | "video", type, version, publicId: file.slice(0, dot), format: file.slice(dot + 1) };
}

type Credentials = { cloudName: string; apiKey: string; apiSecret: string };

function credentials(asset: CloudinaryAsset): Credentials {
  const env = getEnv();
  if (!env.cloudinaryCloudName || !env.cloudinaryApiKey || !env.cloudinaryApiSecret) throw new Error("cloudinary_not_configured");
  if (env.cloudinaryCloudName !== asset.cloudName) throw new Error("cloudinary_other_account");
  return { cloudName: env.cloudinaryCloudName, apiKey: env.cloudinaryApiKey, apiSecret: env.cloudinaryApiSecret };
}

export function cloudinaryConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.cloudinaryCloudName && env.cloudinaryApiKey && env.cloudinaryApiSecret);
}

/** Cloudinary's request signature: SHA-1 of the sorted parameters followed by the secret. */
export function cloudinarySignature(params: Record<string, string>, apiSecret: string): string {
  const signed = Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join("&");
  return createHash("sha1").update(signed + apiSecret).digest("hex");
}

const encodePublicId = (publicId: string) => publicId.split("/").map(encodeURIComponent).join("/");

export type CloudinaryResource = { exists: boolean; secureUrl: string; bytes: number | null };

/** The asset's own record from the Admin API; `exists: false` only on a definite 404. */
export async function cloudinaryResource(asset: CloudinaryAsset, fetcher: typeof fetch = fetch): Promise<CloudinaryResource> {
  const { cloudName, apiKey, apiSecret } = credentials(asset);
  const response = await fetcher(
    `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/resources/${asset.resourceType}/${asset.type}/${encodePublicId(asset.publicId)}`,
    { headers: { authorization: `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}` }, signal: AbortSignal.timeout(20_000) },
  );
  if (response.status === 404) return { exists: false, secureUrl: "", bytes: null };
  if (!response.ok) throw new Error(`cloudinary_lookup_${response.status}`);
  const body = await response.json() as { secure_url?: string; bytes?: number };
  return { exists: true, secureUrl: String(body.secure_url || ""), bytes: typeof body.bytes === "number" ? body.bytes : null };
}

/** The asset's bytes through the authenticated download API (works when delivery is blocked). */
export async function cloudinaryDownload(asset: CloudinaryAsset, fetcher: typeof fetch = fetch): Promise<Response> {
  const { cloudName, apiKey, apiSecret } = credentials(asset);
  const params: Record<string, string> = { public_id: asset.publicId, timestamp: String(Math.floor(Date.now() / 1000)), type: asset.type };
  if (asset.format) params.format = asset.format;
  const query = new URLSearchParams({ ...params, api_key: apiKey, signature: cloudinarySignature(params, apiSecret) });
  return fetcher(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/${asset.resourceType}/download?${query}`,
    { signal: AbortSignal.timeout(60_000) });
}

/** Destroys exactly this asset and asks the CDN to drop cached copies. */
export async function cloudinaryDestroy(asset: CloudinaryAsset, fetcher: typeof fetch = fetch): Promise<"ok" | "not found"> {
  const { cloudName, apiKey, apiSecret } = credentials(asset);
  const params: Record<string, string> = { invalidate: "true", public_id: asset.publicId, timestamp: String(Math.floor(Date.now() / 1000)), type: asset.type };
  const body = new URLSearchParams({ ...params, api_key: apiKey, signature: cloudinarySignature(params, apiSecret) });
  const response = await fetcher(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/${asset.resourceType}/destroy`,
    { method: "POST", body, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`cloudinary_destroy_${response.status}`);
  const result = (await response.json() as { result?: string }).result;
  if (result === "ok" || result === "not found") return result;
  throw new Error("cloudinary_destroy_unexpected");
}
