/**
 * Fetching a link someone typed or pasted (a partner's trip page, an outside photo) without
 * letting it reach our own network. Every server fetch before this one went to a fixed host;
 * the assistant's "read this page" and "use this photo" take any link, so a link to
 * 169.254.169.254, a router, or a public name that resolves to 10.x would otherwise be fetched
 * from inside the deployment (SSRF).
 *
 * Rules, on EVERY hop:
 * - https only, port 443, no user:password in the link;
 * - the host name is resolved here and every address it resolves to must be public
 *   (no loopback, private, link-local, CGNAT, multicast, reserved, IPv6 ULA / link-local,
 *   and no IPv4 hidden inside IPv6: ::ffff:a.b.c.d, NAT64, 6to4);
 * - the connection uses the address that was checked (the lookup hook runs the same check),
 *   so a DNS answer that changes between the check and the connect (rebinding) is refused;
 * - redirects are followed by hand, at most 3, each one checked again;
 * - 10 s for the whole fetch and 2 MB of body by default (decompressed size counts).
 *
 * Errors are a SafeFetchError whose message is a plain Mongolian sentence safe to show the
 * admin (it never repeats the link or an address).
 */
import { lookup as dnsLookup } from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";
import zlib from "node:zlib";

export type SafeFetchOptions = { timeoutMs?: number; maxBytes?: number; accept?: string };
export type SafeFetchResult = { url: string; status: number; contentType: string; body: Buffer };

export type SafeFetchErrorCode =
  | "invalid_url"
  | "not_https"
  | "blocked_port"
  | "blocked_address"
  | "dns_failed"
  | "too_many_redirects"
  | "redirect_without_location"
  | "too_large"
  | "timeout"
  | "network";

const REASONS: Record<SafeFetchErrorCode, string> = {
  invalid_url: "Холбоос буруу байна.",
  not_https: "Зөвхөн https:// холбоосыг нээнэ.",
  blocked_port: "Энэ холбоосын портыг нээхгүй (зөвхөн https-ийн энгийн порт).",
  blocked_address: "Энэ холбоос дотоод сүлжээ рүү заасан тул нээхгүй.",
  dns_failed: "Холбоосын хаягийг олсонгүй.",
  too_many_redirects: "Холбоос хэт олон удаа өөр хаяг руу шилжүүлсэн тул нээсэнгүй.",
  redirect_without_location: "Холбоос өөр хаяг руу шилжүүлсэн ч хаягаа хэлээгүй.",
  too_large: "Хуудас эсвэл файл хэт том байна.",
  timeout: "Холбоос хугацаандаа хариу өгсөнгүй.",
  network: "Холбоосыг нээж чадсангүй.",
};

export class SafeFetchError extends Error {
  readonly code: SafeFetchErrorCode;
  /** The same Mongolian sentence as `message`. */
  readonly reason: string;
  constructor(code: SafeFetchErrorCode) {
    super(REASONS[code]);
    this.name = "SafeFetchError";
    this.code = code;
    this.reason = REASONS[code];
  }
}

export const SAFE_FETCH_DEFAULT_TIMEOUT_MS = 10_000;
export const SAFE_FETCH_DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const SAFE_FETCH_MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// ─── address rules ──────────────────────────────────────────────────────────

function ipv4Bytes(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255) ? bytes : null;
}

function blockedIpv4(bytes: number[]): boolean {
  const [a, b, c] = bytes;
  return a === 0 // "this network"
    || a === 10
    || (a === 100 && b >= 64 && b <= 127) // CGNAT
    || a === 127
    || (a === 169 && b === 254) // link-local, cloud metadata
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0) // IETF protocol assignments
    || (a === 192 && b === 0 && c === 2) // TEST-NET-1
    || (a === 192 && b === 88 && c === 99) // 6to4 relay
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19)) // benchmarking
    || (a === 198 && b === 51 && c === 100) // TEST-NET-2
    || (a === 203 && b === 0 && c === 113) // TEST-NET-3
    || a >= 224; // multicast, reserved, broadcast
}

/** 16 bytes of an IPv6 address ("::ffff:127.0.0.1" and zone ids included), or null. */
function ipv6Bytes(input: string): number[] | null {
  let address = input.split("%")[0].toLowerCase();
  let tail: number[] = [];
  const dotted = address.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const v4 = ipv4Bytes(dotted[2]);
    if (!v4) return null;
    tail = v4;
    address = `${dotted[1]}0:0`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const groups = (text: string) => (text ? text.split(":") : []);
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  const bytes: number[] = [];
  for (const group of all) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const value = parseInt(group, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes.length === 16 ? bytes : null;
}

function blockedIpv6(bytes: number[]): boolean {
  const zeros = (from: number, to: number) => bytes.slice(from, to).every((byte) => byte === 0);
  if (zeros(0, 16)) return true; // ::
  if (zeros(0, 15) && bytes[15] === 1) return true; // ::1
  // IPv4 hidden in IPv6: mapped (::ffff:a.b.c.d), compatible (::a.b.c.d), NAT64 (64:ff9b::a.b.c.d).
  if (zeros(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return blockedIpv4(bytes.slice(12));
  if (zeros(0, 12)) return blockedIpv4(bytes.slice(12));
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zeros(4, 12)) return blockedIpv4(bytes.slice(12));
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return blockedIpv4(bytes.slice(2, 6)); // 6to4
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return true; // Teredo
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true; // documentation
  if (bytes[0] === 0x01 && bytes[1] === 0x00 && zeros(2, 8)) return true; // discard-only
  if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) return true; // fec0::/10 old site-local
  if (bytes[0] === 0xff) return true; // multicast
  return false;
}

/** True for any address a fetch from this server must never reach (and for anything that is not an IP). */
export function isBlockedAddress(address: string): boolean {
  const value = String(address || "").trim().replace(/^\[|\]$/g, "");
  const family = isIP(value.split("%")[0]);
  if (family === 4) {
    const bytes = ipv4Bytes(value);
    return !bytes || blockedIpv4(bytes);
  }
  if (family === 6) {
    const bytes = ipv6Bytes(value);
    return !bytes || blockedIpv6(bytes);
  }
  return true;
}

// ─── transport seams (tests replace these) ──────────────────────────────────

export type ResolvedAddress = { address: string; family: number };
export type SafeFetchResolver = (hostname: string) => Promise<ResolvedAddress[]>;
/** Resolves a host name to the one address the connection must use, after checking it. */
export type PinnedLookup = (hostname: string) => Promise<ResolvedAddress>;
export type TransportResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Buffer | Uint8Array | string>;
  destroy?: () => void;
};
export type SafeFetchTransport = (request: {
  url: URL;
  headers: Record<string, string>;
  lookup: PinnedLookup;
  signal: AbortSignal;
}) => Promise<TransportResponse>;
export type SafeFetchDeps = { resolve: SafeFetchResolver; transport: SafeFetchTransport };

const systemResolver: SafeFetchResolver = async (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/**
 * node:https with the checked address pinned through `lookup`, no connection reuse (a pooled
 * socket would skip the lookup), and the host name kept for TLS (SNI and certificate check).
 */
const httpsTransport: SafeFetchTransport = ({ url, headers, lookup, signal }) => new Promise((resolve, reject) => {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const request = https.request({
    protocol: "https:",
    hostname: host,
    port: url.port ? Number(url.port) : 443,
    path: `${url.pathname}${url.search}`,
    method: "GET",
    headers,
    agent: false,
    signal,
    ...(isIP(host) ? {} : { servername: host }),
    lookup: ((hostname: string, options: { all?: boolean }, callback: (error: Error | null, address?: unknown, family?: number) => void) => {
      lookup(hostname).then(
        (pinned) => (options?.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family)),
        (error: Error) => callback(error),
      );
    }) as unknown as import("node:net").LookupFunction,
  }, (response) => resolve({
    status: response.statusCode || 0,
    headers: response.headers,
    body: response,
    destroy: () => response.destroy(),
  }));
  request.on("error", reject);
  request.end();
});

const DEFAULT_DEPS: SafeFetchDeps = { resolve: systemResolver, transport: httpsTransport };

// ─── the fetch ──────────────────────────────────────────────────────────────

function checkedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(String(raw || "").trim());
  } catch {
    throw new SafeFetchError("invalid_url");
  }
  if (url.protocol !== "https:") throw new SafeFetchError("not_https");
  if (url.username || url.password || !url.hostname) throw new SafeFetchError("invalid_url");
  if (url.port && url.port !== "443") throw new SafeFetchError("blocked_port");
  return url;
}

async function pinnedAddress(resolve: SafeFetchResolver, rawHost: string): Promise<ResolvedAddress> {
  const host = rawHost.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  const family = isIP(host.split("%")[0]);
  if (family) {
    if (isBlockedAddress(host)) throw new SafeFetchError("blocked_address");
    return { address: host, family };
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new SafeFetchError("blocked_address");
  }
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new SafeFetchError("dns_failed");
  }
  if (!Array.isArray(addresses) || addresses.length === 0) throw new SafeFetchError("dns_failed");
  // One private answer is enough to refuse: a name that resolves to a public and a private
  // address is either misconfigured or an attempt to reach the private one.
  if (addresses.some((entry) => isBlockedAddress(entry.address))) throw new SafeFetchError("blocked_address");
  return addresses[0];
}

function header(headers: TransportResponse["headers"], name: string): string {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
}

async function readCapped(response: TransportResponse, maxBytes: number): Promise<Buffer> {
  const declared = Number(header(response.headers, "content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    response.destroy?.();
    throw new SafeFetchError("too_large");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      response.destroy?.();
      throw new SafeFetchError("too_large");
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks);
  const encoding = header(response.headers, "content-encoding").trim().toLowerCase();
  if (!encoding || encoding === "identity") return raw;
  try {
    const options = { maxOutputLength: maxBytes };
    if (encoding === "gzip" || encoding === "x-gzip") return zlib.gunzipSync(raw, options);
    if (encoding === "deflate") return zlib.inflateSync(raw, options);
    if (encoding === "br") return zlib.brotliDecompressSync(raw, options);
  } catch (error) {
    if (error instanceof RangeError || /maxOutputLength|buffer|too large/i.test(String((error as Error)?.message))) throw new SafeFetchError("too_large");
    throw new SafeFetchError("network");
  }
  throw new SafeFetchError("network");
}

/** The tested core: `safeFetch` with its DNS resolver and transport passed in. */
export async function safeFetchWith(deps: SafeFetchDeps, url: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const timeoutMs = Math.max(1, Math.min(Number(opts.timeoutMs) || SAFE_FETCH_DEFAULT_TIMEOUT_MS, 60_000));
  const maxBytes = Math.max(1, Number(opts.maxBytes) || SAFE_FETCH_DEFAULT_MAX_BYTES);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SafeFetchError("timeout"));
    }, timeoutMs);
  });
  const headers: Record<string, string> = {
    accept: opts.accept || "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
    "accept-encoding": "gzip, deflate, br",
    "user-agent": "Mozilla/5.0 (compatible; UudamTravelAssistant/1.0)",
  };
  const run = async (): Promise<SafeFetchResult> => {
    let current = checkedUrl(url);
    for (let hop = 0; ; hop++) {
      // Checked before connecting (a clear refusal), and again inside the connection's own
      // lookup, so the socket can only open to an address that passed this check.
      await pinnedAddress(deps.resolve, current.hostname);
      let response: TransportResponse;
      try {
        response = await deps.transport({ url: current, headers, lookup: (host) => pinnedAddress(deps.resolve, host), signal: controller.signal });
      } catch (error) {
        if (error instanceof SafeFetchError) throw error;
        throw controller.signal.aborted ? new SafeFetchError("timeout") : new SafeFetchError("network");
      }
      if (REDIRECT_STATUSES.has(response.status)) {
        response.destroy?.();
        if (hop >= SAFE_FETCH_MAX_REDIRECTS) throw new SafeFetchError("too_many_redirects");
        const location = header(response.headers, "location").trim();
        if (!location) throw new SafeFetchError("redirect_without_location");
        let next: string;
        try {
          next = new URL(location, current).toString();
        } catch {
          throw new SafeFetchError("invalid_url");
        }
        current = checkedUrl(next);
        continue;
      }
      let body: Buffer;
      try {
        body = await readCapped(response, maxBytes);
      } catch (error) {
        if (error instanceof SafeFetchError) throw error;
        throw controller.signal.aborted ? new SafeFetchError("timeout") : new SafeFetchError("network");
      }
      return { url: current.toString(), status: response.status, contentType: header(response.headers, "content-type"), body };
    }
  };
  try {
    return await Promise.race([run(), timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}

/**
 * GET an outside https link safely (see the file comment). A non-2xx answer is returned with
 * its status; refusals, timeouts and oversize bodies throw a SafeFetchError.
 */
export async function safeFetch(url: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  return safeFetchWith(DEFAULT_DEPS, url, opts);
}
