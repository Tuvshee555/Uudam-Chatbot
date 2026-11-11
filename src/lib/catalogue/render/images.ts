/**
 * Guarded photo fetch for the catalogue: https only, public addresses only, bounded size and time.
 * Cropping and encoding live in art.ts. Chromium never fetches anything: pages carry data: URIs.
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { IncomingHttpHeaders } from "node:http";
import type { Readable } from "node:stream";
import { isAllowedPosterPdfImageUrl, isPublicIpAddress, normalizedUrlHost } from "../../poster/pdfImagePolicy";
import type { CatalogueImageFetcher } from "./renderTypes";

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 12_000;

function cloudinaryFriendly(value: string): string {
  try {
    const url = new URL(value);
    if (url.hostname === "res.cloudinary.com" && url.pathname.includes("/image/upload/")) {
      // Cap the download and force a decodable format; the original stays untouched in Cloudinary.
      url.pathname = url.pathname.replace("/image/upload/", "/image/upload/f_jpg,q_90,w_2200,c_limit/");
      return url.toString();
    }
  } catch {
    /* fall through */
  }
  return value;
}

/** Redirects followed by hand; every hop is vetted again before it is requested. */
export const MAX_REDIRECT_HOPS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type ResolvedAddress = { address: string; family: number };
export type PinnedTarget = {
  url: URL;
  /** The vetted address to connect to; the URL's own host is used only for SNI, certificate and Host. */
  address: string;
  family: 4 | 6;
  signal: AbortSignal;
  headers: Record<string, string>;
};
export type PinnedResponse = Readable & { statusCode?: number; headers: IncomingHttpHeaders };
export type PinnedRequest = (target: PinnedTarget) => Promise<PinnedResponse>;
export type ImageGuardDeps = {
  lookup: (hostname: string) => Promise<ResolvedAddress[]>;
  request: PinnedRequest;
};

/**
 * A `lookup` for http(s).request that always answers with one already vetted address. Node's
 * autoSelectFamily calls lookup with `all: true` and wants an array back; the classic form wants
 * (address, family). Both shapes are served, so the socket can never connect anywhere else.
 */
export function pinnedLookup(address: string, family: 4 | 6) {
  return (_hostname: string, options: unknown, callback?: unknown): void => {
    const cb = (typeof options === "function" ? options : callback) as (...args: unknown[]) => void;
    const opts = (typeof options === "object" && options ? options : {}) as { all?: boolean };
    if (opts.all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  };
}

/**
 * One GET with the connection pinned to `address`. DNS is not consulted again, so a name that
 * answers differently the second time (rebinding) cannot steer the socket. TLS still verifies the
 * certificate against the URL's host name. No keep-alive pool: each request owns its socket.
 */
export const requestPinned: PinnedRequest = ({ url, address, family, signal, headers }) =>
  new Promise((resolve, reject) => {
    const secure = url.protocol === "https:";
    const host = normalizedUrlHost(url.hostname);
    const req = (secure ? https : http).request(
      {
        host,
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers,
        agent: false,
        signal,
        lookup: pinnedLookup(address, family) as never,
        servername: secure && !net.isIP(host) ? host : undefined,
      },
      res => resolve(res as PinnedResponse),
    );
    req.on("error", reject);
    req.end();
  });

async function systemLookup(hostname: string): Promise<ResolvedAddress[]> {
  return dns.promises.lookup(hostname, { all: true, verbatim: true });
}

function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * The addresses a host may be reached at, or null when ANY of them is not public unicast (one
 * private answer among public ones is enough to refuse: the resolver could hand it out next).
 * IPv4 first, so a host without IPv6 egress still connects.
 */
async function vetHost(hostname: string, deps: ImageGuardDeps, signal: AbortSignal): Promise<Array<{ address: string; family: 4 | 6 }> | null> {
  const host = normalizedUrlHost(hostname);
  const literal = net.isIP(host);
  if (literal) return isPublicIpAddress(host) ? [{ address: host, family: literal as 4 | 6 }] : null;
  const found = await raceAbort(deps.lookup(host), signal);
  if (!found.length) return null;
  const vetted: Array<{ address: string; family: 4 | 6 }> = [];
  for (const entry of found) {
    const family = net.isIP(entry.address);
    if (!family || !isPublicIpAddress(entry.address)) return null;
    vetted.push({ address: entry.address, family: family as 4 | 6 });
  }
  return [...vetted.filter(a => a.family === 4), ...vetted.filter(a => a.family === 6)];
}

async function readCapped(body: Readable, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += piece.length;
    if (total > maxBytes) {
      body.destroy();
      return null;
    }
    chunks.push(piece);
  }
  return total === 0 ? null : Buffer.concat(chunks, total);
}

type FetchOutcome = { kind: "image"; bytes: Buffer } | { kind: "refused" } | { kind: "retry" };
const REFUSED: FetchOutcome = { kind: "refused" };
const RETRY: FetchOutcome = { kind: "retry" };

/** One pass over the redirect chain: https only, public addresses only, re-vetted at every hop. */
async function fetchChain(startUrl: string, deps: ImageGuardDeps, attempt: number, signal: AbortSignal): Promise<FetchOutcome> {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    if (!isAllowedPosterPdfImageUrl(current)) return REFUSED;
    const url = new URL(current);
    const addresses = await vetHost(url.hostname, deps, signal);
    if (!addresses) return REFUSED;
    // The second attempt prefers the next vetted address, so one dead address does not fail the photo.
    const target = addresses[attempt % addresses.length]!;
    const res = await deps.request({
      url,
      address: target.address,
      family: target.family,
      signal,
      headers: { "user-agent": "UudamTravelCatalogue/1.0 (+https://uudamtravel.mn)", accept: "image/*", "accept-encoding": "identity" },
    });
    const status = res.statusCode ?? 0;
    if (REDIRECT_STATUSES.has(status)) {
      res.destroy();
      const location = res.headers.location;
      if (!location || Array.isArray(location)) return REFUSED;
      try {
        current = new URL(location, url).toString();
      } catch {
        return REFUSED;
      }
      continue;
    }
    if (status < 200 || status >= 300) {
      res.destroy();
      return status >= 500 || status === 429 ? RETRY : REFUSED;
    }
    const type = String(res.headers["content-type"] || "").toLowerCase();
    const encoding = String(res.headers["content-encoding"] || "identity").toLowerCase().trim();
    const declared = Number(res.headers["content-length"] || 0);
    if ((type && !type.startsWith("image/") && !type.includes("octet-stream")) || encoding !== "identity" || declared > MAX_DOWNLOAD_BYTES) {
      res.destroy();
      return REFUSED;
    }
    const bytes = await readCapped(res, MAX_DOWNLOAD_BYTES);
    return bytes ? { kind: "image", bytes } : REFUSED;
  }
  return REFUSED; // more redirects than allowed
}

/**
 * Guarded https image fetch: public hosts only, bounded time and size, one retry.
 *
 *  - The URL must pass the string policy, then its host name is resolved here and EVERY address
 *    must be public unicast (loopback, private, link-local, CGNAT, multicast, mapped/NAT64/6to4
 *    wrappers of those are refused).
 *  - The socket is pinned to a vetted address (custom `lookup`), so DNS rebinding between the
 *    check and the connect cannot redirect the request. TLS and the Host header still use the name.
 *  - Redirects are followed by hand, at most MAX_REDIRECT_HOPS, and each Location goes through the
 *    same URL policy and DNS vetting BEFORE it is requested; a downgrade to http is refused.
 */
export function createGuardedImageFetcher(overrides: Partial<ImageGuardDeps> = {}): CatalogueImageFetcher {
  const deps: ImageGuardDeps = { lookup: systemLookup, request: requestPinned, ...overrides };
  return async rawUrl => {
    const url = cloudinaryFriendly(rawUrl);
    if (!isAllowedPosterPdfImageUrl(url)) return null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      try {
        const outcome = await fetchChain(url, deps, attempt, ctrl.signal);
        if (outcome.kind === "image") return outcome.bytes;
        if (outcome.kind === "refused") return null;
      } catch {
        /* network error, timeout or failed lookup: retry once */
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  };
}

export const defaultImageFetcher: CatalogueImageFetcher = createGuardedImageFetcher();
