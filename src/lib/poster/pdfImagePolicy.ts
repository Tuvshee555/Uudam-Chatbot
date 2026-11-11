import net from "node:net";

/**
 * Public-HTTPS-only policy for images the server (Chromium for posters, Node for the catalogue)
 * is asked to fetch. Two layers:
 *
 *  - `isAllowedPosterPdfImageUrl`  string policy on the URL itself (no network);
 *  - `isPublicIpAddress`           the same rule for a resolved address, used by callers that do
 *                                  their own DNS resolution and pin the vetted address.
 *
 * WHATWG URL already folds decimal / hex / octal IPv4 spellings ("2130706433", "0x7f.1") into
 * dotted form and keeps IPv6 hosts in brackets, so the checks below run on the normalised host.
 */

type Ipv4 = [number, number, number, number];

function parseIpv4(text: string): Ipv4 | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    out.push(value);
  }
  return out as Ipv4;
}

/** False for every address that is not ordinary, publicly routable unicast. */
function isPublicIpv4([a, b, c]: Ipv4): boolean {
  if (a === 0) return false; // 0.0.0.0/8 "this network"
  if (a === 10) return false; // private
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64.0.0/10 carrier-grade NAT
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local (cloud metadata lives here)
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // 192.0.0.0/24 protocol, 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false; // deprecated 6to4 relay anycast
  if (a === 192 && b === 168) return false; // private
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast 224/4, reserved 240/4, broadcast
  return true;
}

/** Eight 16-bit groups, or null when `text` is not a valid IPv6 literal. */
function parseIpv6(text: string): number[] | null {
  let value = text.split("%")[0]!;
  if (!value.includes(":")) return null;
  const dotted = value.lastIndexOf(".");
  if (dotted !== -1) {
    const colon = value.lastIndexOf(":");
    const v4 = parseIpv4(value.slice(colon + 1));
    if (!v4) return null;
    value = `${value.slice(0, colon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const toGroups = (side: string): number[] | null => {
    if (side === "") return [];
    const groups: number[] = [];
    for (const piece of side.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      groups.push(parseInt(piece, 16));
    }
    return groups;
  };
  const head = toGroups(halves[0]!);
  const tail = halves.length === 2 ? toGroups(halves[1]!) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function isPublicIpv6(g: number[]): boolean {
  const embedded = (hi: number, lo: number): Ipv4 => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  // ::ffff:a.b.c.d (IPv4-mapped) is judged as the IPv4 address it wraps.
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return isPublicIpv4(embedded(g[6]!, g[7]!));
  }
  // Only global unicast 2000::/3 can be public; this drops ::, ::1, ::/96, fc00::/7, fe80::/10,
  // fec0::/10, ff00::/8 (multicast), 64:ff9b::/96 (NAT64) and everything else outside it.
  if ((g[0]! & 0xe000) !== 0x2000) return false;
  if (g[0] === 0x2002) return isPublicIpv4(embedded(g[1]!, g[2]!)); // 6to4 wraps an IPv4 address
  if (g[0] === 0x2001) {
    if (g[1] === 0x0000) return false; // Teredo 2001::/32
    if (g[1] === 0x0db8) return false; // documentation 2001:db8::/32
    if (g[1] === 0x0002 && g[2] === 0) return false; // benchmarking 2001:2::/48
    if (g[1]! >= 0x0010 && g[1]! <= 0x001f) return false; // ORCHID 2001:10::/28
  }
  if (g[0] === 0x3fff && (g[1]! & 0xf000) === 0) return false; // documentation 3fff::/20
  return true;
}

/** True only for an IPv4 or IPv6 literal that is ordinary, publicly routable unicast. */
export function isPublicIpAddress(address: string): boolean {
  const text = address.trim().replace(/^\[|\]$/g, "");
  const family = net.isIP(text.split("%")[0]!);
  if (family === 4) {
    const v4 = parseIpv4(text);
    return v4 ? isPublicIpv4(v4) : false;
  }
  if (family === 6) {
    const groups = parseIpv6(text);
    return groups ? isPublicIpv6(groups) : false;
  }
  return false;
}

/** Suffixes that name machines on a local or private network, whatever DNS says. */
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".lan", ".home.arpa", ".intranet", ".corp", ".private"];

/** The host part of a URL, lower-cased, without IPv6 brackets or trailing root dots. */
export function normalizedUrlHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
}

/**
 * Poster images are staff-managed data, but the renderer runs in the server process. Keep it to
 * public HTTPS assets so a malformed image URL cannot make Chromium (or a Node fetch) request a
 * local or private service. This is the string-level check; callers that fetch from Node also
 * resolve DNS and vet every address (see catalogue/render/images.ts), because a public-looking
 * name can still point at a private address.
 */
export function isAllowedPosterPdfImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    if (url.port !== "" && url.port !== "443") return false;
    const host = normalizedUrlHost(url.hostname);
    if (!host) return false;
    if (net.isIP(host)) return isPublicIpAddress(host);
    if (host.includes(":")) return false; // a bracketed host that is not a valid IPv6 literal
    if (host === "localhost") return false;
    if (PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
    // A public host always has a dot; a bare label ("intranet", "metadata") resolves through
    // the machine's search domains to something private.
    if (!host.includes(".")) return false;
    return true;
  } catch {
    return false;
  }
}
