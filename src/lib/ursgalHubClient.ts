// For a client project whose bot runs on its own deployment while the Facebook
// Page is connected at the Ursgal Digital hub (www.ursgaldigital.com). Copy this
// file into the client project as is: it needs nothing but node:crypto.
//
// The hub forwards each Meta webhook body untouched, signed with the route's
// own secret (never the Meta app secret):
//   x-ursgal-route:     the route id
//   x-ursgal-timestamp: unix seconds
//   x-ursgal-signature: sha256=<hex HMAC-SHA256 of `${timestamp}.${rawBody}`>
// The client asks the hub for its Page token with the same three headers.
// See docs/META_HUB_CLIENT.md.
import { createHmac, timingSafeEqual } from "node:crypto";

export const ROUTE_HEADER = "x-ursgal-route";
export const TIMESTAMP_HEADER = "x-ursgal-timestamp";
export const SIGNATURE_HEADER = "x-ursgal-signature";
/** A signed request older (or newer) than this is refused. */
export const MAX_AGE_SECONDS = 5 * 60;
export const TOKEN_CACHE_MS = 10 * 60 * 1000;

type Body = string | Uint8Array;
type HeaderSource = Headers | Record<string, string | string[] | undefined>;

const bytes = (body: Body) => (typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body));

function header(headers: HeaderSource, name: string): string {
  if (headers instanceof Headers) return headers.get(name) ?? "";
  const value = headers[name] ?? Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function sameText(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** "sha256=<hex HMAC-SHA256 of `${timestamp}.${rawBody}` with the route secret>". */
export function hubSignature(secret: string, timestamp: string | number, rawBody: Body): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.`).update(bytes(rawBody)).digest("hex");
}

/** The three headers for a request signed by (or for) one route. */
export function signHubRequest(routeId: string, secret: string, rawBody: Body, now = Date.now()): Record<string, string> {
  const timestamp = String(Math.floor(now / 1000));
  return { [ROUTE_HEADER]: routeId, [TIMESTAMP_HEADER]: timestamp, [SIGNATURE_HEADER]: hubSignature(secret, timestamp, rawBody) };
}

export type HubRequestProblem = "missing_headers" | "wrong_route" | "stale" | "bad_signature";

/** Why a signed request is not acceptable, or null when it is. */
export function hubRequestProblem(
  rawBody: Body,
  headers: HeaderSource,
  secret: string,
  { routeId, now = Date.now() }: { routeId?: string; now?: number } = {},
): HubRequestProblem | null {
  const route = header(headers, ROUTE_HEADER);
  const timestamp = header(headers, TIMESTAMP_HEADER);
  const signature = header(headers, SIGNATURE_HEADER);
  if (!secret || !route || !/^\d{1,12}$/.test(timestamp) || !signature.startsWith("sha256=")) return "missing_headers";
  if (routeId !== undefined && !sameText(route, routeId)) return "wrong_route";
  if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > MAX_AGE_SECONDS) return "stale";
  return sameText(signature, hubSignature(secret, timestamp, rawBody)) ? null : "bad_signature";
}

/**
 * True when a webhook delivery really comes from the hub for this route: the
 * signature matches the exact raw body, and it was signed in the last 5 minutes.
 * Pass the body exactly as received (read it as text or bytes before parsing).
 */
export function verifyHubDelivery(
  rawBody: Body,
  headers: HeaderSource,
  secret: string,
  options: { routeId?: string; now?: number } = {},
): boolean {
  return hubRequestProblem(rawBody, headers, secret, options) === null;
}

export class HubTokenError extends Error {
  constructor(readonly status: number) {
    super(`hub page-token request failed (${status})`);
    this.name = "HubTokenError";
  }
}

/** `appsecretProof` is the Graph API appsecret_proof for this token (null from an older hub). */
export type PageToken = { token: string; instagramId: string | null; appsecretProof: string | null };

const cache = new Map<string, { expires: number; value: Promise<PageToken> }>();

/** Forget cached tokens, e.g. after Meta rejects one (the next call asks the hub again). */
export function clearPageTokenCache() {
  cache.clear();
}

/**
 * The Page token (with its appsecret_proof and the linked Instagram id) for a Page assigned to this route.
 * Kept in memory for 10 minutes; the token itself is never logged or stored.
 */
export function fetchPageToken(
  hubUrl: string,
  routeId: string,
  secret: string,
  pageId: string,
  { fetch: send = fetch, now = Date.now() }: { fetch?: typeof fetch; now?: number } = {},
): Promise<PageToken> {
  const base = new URL(hubUrl);
  if (base.protocol !== "https:" && base.hostname !== "localhost" && base.hostname !== "127.0.0.1")
    return Promise.reject(new Error("URSGAL_HUB_URL must be https"));
  const key = `${base.origin}|${routeId}|${pageId}`;
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.value;

  const body = JSON.stringify({ pageId });
  const value = (async () => {
    const response = await send(new URL("/api/meta/page-token", base), {
      method: "POST",
      headers: { "content-type": "application/json", ...signHubRequest(routeId, secret, body, now) },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new HubTokenError(response.status);
    const data = (await response.json()) as { token?: unknown; instagramId?: unknown; appsecretProof?: unknown };
    if (typeof data.token !== "string" || !data.token) throw new HubTokenError(502);
    return {
      token: data.token,
      instagramId: typeof data.instagramId === "string" ? data.instagramId : null,
      appsecretProof: typeof data.appsecretProof === "string" && /^[0-9a-f]{64}$/.test(data.appsecretProof) ? data.appsecretProof : null,
    };
  })();
  cache.set(key, { expires: now + TOKEN_CACHE_MS, value });
  value.catch(() => cache.delete(key));
  return value;
}
