/**
 * SSRF guard for the images the server downloads: the shared URL policy (also used by the poster
 * renderer), and the catalogue's Node fetcher (DNS vetting, address pinning, manual redirects).
 * No network: DNS and the socket are injected, except one loopback http server that proves the
 * connection really goes to the pinned address. Invented hosts only.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import test from "node:test";
import { isAllowedPosterPdfImageUrl, isPublicIpAddress, normalizedUrlHost } from "../src/lib/poster/pdfImagePolicy";
import {
  MAX_REDIRECT_HOPS,
  createGuardedImageFetcher,
  pinnedLookup,
  requestPinned,
  type ImageGuardDeps,
  type PinnedResponse,
  type PinnedTarget,
} from "../src/lib/catalogue/render/images";

// ---------------------------------------------------------------------------------------------
// URL policy
// ---------------------------------------------------------------------------------------------

test("policy: loopback, private, reserved and local-name spellings are all refused", () => {
  const refused = [
    // The spellings the first review proved were accepted.
    "https://[::1]/a.jpg",
    "https://[fd00::1]/a.jpg",
    "https://[fe80::1]/a.jpg",
    "https://[::ffff:127.0.0.1]/a.jpg",
    "https://0.0.0.0/a.jpg",
    "https://localhost./a.jpg",
    "https://100.64.0.1/a.jpg",
    // Same families, other spellings.
    "https://[::ffff:7f00:1]/a.jpg",
    "https://[::ffff:10.1.2.3]/a.jpg",
    "https://[::]/a.jpg",
    "https://[fc00::1]/a.jpg",
    "https://[fec0::1]/a.jpg",
    "https://[ff02::1]/a.jpg",
    "https://[2002:7f00:1::]/a.jpg", // 6to4 around 127.0.0.1
    "https://[64:ff9b::a00:1]/a.jpg", // NAT64 around 10.0.0.1
    "https://[2001:db8::1]/a.jpg", // documentation
    "https://0.1.2.3/a.jpg",
    "https://100.127.255.255/a.jpg",
    "https://169.254.169.254/latest/meta-data",
    "https://172.16.0.1/a.jpg",
    "https://192.168.1.1/a.jpg",
    "https://198.18.0.1/a.jpg",
    "https://224.0.0.1/a.jpg",
    "https://255.255.255.255/a.jpg",
    "https://2130706433/a.jpg", // decimal 127.0.0.1, folded by the URL parser
    "https://0x7f.1/a.jpg",
    "https://127.1/a.jpg",
    "https://localhost/a.jpg",
    "https://LOCALHOST../a.jpg",
    "https://app.localhost/a.jpg",
    "https://printer.local/a.jpg",
    "https://db.internal/a.jpg",
    "https://nas.lan/a.jpg",
    "https://metadata/a.jpg", // bare label: resolves through search domains
    "https://example.com:8443/a.jpg",
    "https://user:pw@images.example.com/a.jpg",
    "http://images.example.com/a.jpg",
    "ftp://images.example.com/a.jpg",
    "file:///etc/passwd",
    "not a url",
    "",
  ];
  for (const url of refused) assert.equal(isAllowedPosterPdfImageUrl(url), false, url);
});

test("policy: the hosts the catalogues and posters really use stay allowed", () => {
  for (const url of [
    "https://res.cloudinary.com/demo/image/upload/v1/sample.jpg",
    "https://images.unsplash.com/photo-1?auto=format&w=1600",
    "https://upload.wikimedia.org/wikipedia/commons/a/ab/Example.jpg",
    "https://abc123.public.blob.vercel-storage.com/trip/photo.jpg",
    "https://res.cloudinary.com./demo/image/upload/sample.jpg", // trailing root dot
    "https://res.cloudinary.com:443/demo/image/upload/sample.jpg",
    "https://8.8.8.8/a.jpg",
    "https://[2606:4700:4700::1111]/a.jpg",
    "https://[2a04:4e42:90::720]/a.jpg",
  ]) {
    assert.equal(isAllowedPosterPdfImageUrl(url), true, url);
  }
});

test("policy: isPublicIpAddress judges resolved addresses, IPv4-mapped ones as the IPv4 they wrap", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "199.232.114.208", "23.15.140.46", "2600:1417:8400:17ab::523", "2a04:4e42:90::720", "[2606:4700:4700::1111]", "::ffff:8.8.8.8"]) {
    assert.equal(isPublicIpAddress(address), true, address);
  }
  for (const address of [
    "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.31.255.255", "192.168.0.1", "192.0.2.1", "198.51.100.1", "203.0.113.1",
    "224.0.0.1", "240.0.0.1", "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1%eth0", "ff02::1", "::ffff:127.0.0.1", "::ffff:100.64.0.1", "::ffff:7f00:1",
    "64:ff9b::7f00:1", "2001:db8::1", "2001::1",
    "", "example.com", "999.1.1.1", "1.2.3", "010.0.0.1", "[::1",
  ]) {
    assert.equal(isPublicIpAddress(address), false, JSON.stringify(address));
  }
});

test("policy: normalizedUrlHost drops IPv6 brackets, trailing dots and case", () => {
  assert.equal(normalizedUrlHost("[::1]"), "::1");
  assert.equal(normalizedUrlHost("LocalHost.."), "localhost");
  assert.equal(normalizedUrlHost(new URL("https://Res.Cloudinary.com./x").hostname), "res.cloudinary.com");
});

// ---------------------------------------------------------------------------------------------
// Guarded fetcher: injected DNS and socket
// ---------------------------------------------------------------------------------------------

type Step =
  | Error
  | { status: number; headers?: Record<string, string>; body?: Buffer | string | Buffer[] };

function respond(step: Exclude<Step, Error>): PinnedResponse {
  const chunks = Array.isArray(step.body) ? step.body : [Buffer.from(step.body ?? "")];
  const stream = Readable.from(chunks, { objectMode: false });
  return Object.assign(stream, { statusCode: step.status, headers: step.headers ?? {} }) as PinnedResponse;
}

const IMAGE: Step = { status: 200, headers: { "content-type": "image/jpeg" }, body: Buffer.from("jpeg-bytes") };
const redirect = (location: string, status = 302): Step => ({ status, headers: { location } });

function harness(dns: Record<string, string[] | ((call: number) => string[])>, script: (target: PinnedTarget, n: number) => Step) {
  const lookups: string[] = [];
  const requests: PinnedTarget[] = [];
  const responses: PinnedResponse[] = [];
  const deps: ImageGuardDeps = {
    lookup: async (host) => {
      const calls = lookups.filter((h) => h === host).length;
      lookups.push(host);
      const entry = dns[host];
      if (!entry) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
      const addresses = typeof entry === "function" ? entry(calls) : entry;
      return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
    request: async (target) => {
      requests.push(target);
      const step = script(target, requests.length - 1);
      if (step instanceof Error) throw step;
      const res = respond(step);
      responses.push(res);
      return res;
    },
  };
  return { fetch: createGuardedImageFetcher(deps), lookups, requests, responses };
}

const PUBLIC_V4 = "93.184.216.34";
const PUBLIC_V4_B = "198.41.0.4";
const PUBLIC_V6 = "2606:2800:220:1:248:1893:25c8:1946";

test("fetch: a public host is requested at its vetted address, keeping the name for TLS", async () => {
  const h = harness({ "img.example.com": [PUBLIC_V6, PUBLIC_V4] }, () => IMAGE);
  const bytes = await h.fetch("https://img.example.com/a.jpg");
  assert.equal(bytes?.toString(), "jpeg-bytes");
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0]!.address, PUBLIC_V4, "IPv4 first so a host without IPv6 egress still connects");
  assert.equal(h.requests[0]!.family, 4);
  assert.equal(h.requests[0]!.url.hostname, "img.example.com");
  assert.equal(h.requests[0]!.headers["accept-encoding"], "identity");
});

test("fetch: a name that resolves to a private address is never requested", async () => {
  for (const address of [
    "127.0.0.1", "10.0.0.5", "172.20.1.1", "192.168.0.9", "169.254.169.254", "100.64.0.9", "0.0.0.0", "198.18.0.1",
    "::1", "::", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "ff02::1",
  ]) {
    const h = harness({ "split-horizon.example.com": [address] }, () => IMAGE);
    assert.equal(await h.fetch("https://split-horizon.example.com/a.jpg"), null, address);
    assert.equal(h.requests.length, 0, `${address}: nothing was sent`);
  }
});

test("fetch: one private answer among public ones refuses the host", async () => {
  const h = harness({ "mixed.example.com": [PUBLIC_V4, "10.0.0.7", PUBLIC_V6] }, () => IMAGE);
  assert.equal(await h.fetch("https://mixed.example.com/a.jpg"), null);
  assert.equal(h.requests.length, 0);
});

test("fetch: literal private addresses and local names are refused before any lookup or request", async () => {
  const h = harness({}, () => IMAGE);
  for (const url of ["https://[::1]/a.jpg", "https://0.0.0.0/a.jpg", "https://localhost./a.jpg", "https://100.64.0.1/a.jpg", "https://[::ffff:127.0.0.1]/a.jpg", "https://host.internal/a.jpg"]) {
    assert.equal(await h.fetch(url), null, url);
  }
  assert.deepEqual([h.lookups, h.requests.length], [[], 0]);
});

test("fetch: a failed lookup is retried once, then the photo is simply missing", async () => {
  const h = harness({}, () => IMAGE);
  assert.equal(await h.fetch("https://unknown.example.com/a.jpg"), null);
  assert.deepEqual(h.lookups, ["unknown.example.com", "unknown.example.com"]);
  assert.equal(h.requests.length, 0);
});

test("fetch: DNS rebinding cannot steer the socket, the address checked is the address used", async () => {
  // Public on the first answer, private on every later one: a check-then-connect design would
  // look up twice (once to vet, once inside connect) and be sent to 127.0.0.1.
  const h = harness({ "rebind.example.com": (call) => (call === 0 ? [PUBLIC_V4] : ["127.0.0.1"]) }, () => IMAGE);
  assert.ok(await h.fetch("https://rebind.example.com/a.jpg"));
  assert.equal(h.lookups.length, 1, "resolved exactly once per hop");
  assert.equal(h.requests[0]!.address, PUBLIC_V4);
});

test("fetch: pinnedLookup answers every lookup shape with the one vetted address", async () => {
  const lookup = pinnedLookup(PUBLIC_V4, 4);
  const all = await new Promise<unknown>((resolve) => lookup("whatever.example.com", { all: true }, (e: unknown, a: unknown) => resolve(a)));
  assert.deepEqual(all, [{ address: PUBLIC_V4, family: 4 }]);
  const classic = await new Promise<unknown[]>((resolve) => lookup("whatever.example.com", {}, (_e: unknown, ...rest: unknown[]) => resolve(rest)));
  assert.deepEqual(classic, [PUBLIC_V4, 4]);
  const bare = await new Promise<unknown[]>((resolve) => (lookup as unknown as (host: string, cb: (e: unknown, ...rest: unknown[]) => void) => void)("whatever.example.com", (_e: unknown, ...rest: unknown[]) => resolve(rest)));
  assert.deepEqual(bare, [PUBLIC_V4, 4]);
  const v6 = pinnedLookup(PUBLIC_V6, 6);
  assert.deepEqual(await new Promise<unknown>((resolve) => v6("x.example.com", { all: true }, (_e: unknown, a: unknown) => resolve(a))), [{ address: PUBLIC_V6, family: 6 }]);
});

test("redirects: a hop to http, to a private address or to a private-resolving name is never requested", async () => {
  const targets = [
    "http://127.0.0.1:8080/internal",
    "http://img.example.com/a.jpg", // downgrade on the very same host
    "https://10.0.0.1/a.jpg",
    "https://[::1]/a.jpg",
    "https://localhost/a.jpg",
    "https://inner.example.com/a.jpg", // resolves to 10.x
    "https://user:pw@img.example.com/a.jpg",
    "https://img.example.com:8443/a.jpg",
    "file:///etc/passwd",
  ];
  for (const location of targets) {
    const h = harness({ "img.example.com": [PUBLIC_V4], "inner.example.com": ["10.9.9.9"] }, () => redirect(location));
    assert.equal(await h.fetch("https://img.example.com/start.jpg"), null, location);
    assert.equal(h.requests.length, 1, `${location}: only the first, vetted URL was ever requested`);
    assert.ok(h.responses[0]!.destroyed, "the redirect body is dropped");
  }
});

test("redirects: a vetted chain is followed by hand, each hop re-vetted, relative Locations resolved", async () => {
  const h = harness(
    { "a.example.com": [PUBLIC_V4], "b.example.com": [PUBLIC_V4_B], "c.example.com": [PUBLIC_V6] },
    (target, n) => {
      if (n === 0) return redirect("https://b.example.com/two.jpg", 301);
      if (n === 1) return redirect("/three.jpg?x=1", 307);
      if (n === 2) return redirect("https://c.example.com/four.jpg", 308);
      return IMAGE;
    },
  );
  assert.ok(await h.fetch("https://a.example.com/one.jpg"));
  assert.deepEqual(h.requests.map((r) => r.url.toString()), [
    "https://a.example.com/one.jpg", "https://b.example.com/two.jpg", "https://b.example.com/three.jpg?x=1", "https://c.example.com/four.jpg",
  ]);
  assert.deepEqual(h.requests.map((r) => r.address), [PUBLIC_V4, PUBLIC_V4_B, PUBLIC_V4_B, PUBLIC_V6]);
  assert.deepEqual(h.lookups, ["a.example.com", "b.example.com", "b.example.com", "c.example.com"]);
  assert.equal(MAX_REDIRECT_HOPS, 3);
});

test("redirects: more than three hops, a loop, or a bad Location gives up without more requests", async () => {
  const chain = harness({ "a.example.com": [PUBLIC_V4] }, (_t, n) => redirect(`https://a.example.com/hop${n + 1}.jpg`));
  assert.equal(await chain.fetch("https://a.example.com/hop0.jpg"), null);
  assert.equal(chain.requests.length, MAX_REDIRECT_HOPS + 1, "start + 3 hops, the 4th redirect is not followed");

  const loop = harness({ "a.example.com": [PUBLIC_V4] }, () => redirect("https://a.example.com/loop.jpg"));
  assert.equal(await loop.fetch("https://a.example.com/loop.jpg"), null);
  assert.equal(loop.requests.length, MAX_REDIRECT_HOPS + 1);

  for (const step of [{ status: 302 }, { status: 302, headers: { location: "https://[bad" } }] as Step[]) {
    const h = harness({ "a.example.com": [PUBLIC_V4] }, () => step);
    assert.equal(await h.fetch("https://a.example.com/a.jpg"), null);
    assert.equal(h.requests.length, 1);
  }
});

test("redirects: a public host that redirects to a name that resolves privately costs one request, not two", async () => {
  // The old fetcher requested the redirect target first and judged res.url afterwards.
  const h = harness({ "open.example.com": [PUBLIC_V4], "intranet-alias.example.com": ["192.168.7.7"] }, () => redirect("https://intranet-alias.example.com/x.jpg"));
  assert.equal(await h.fetch("https://open.example.com/a.jpg"), null);
  assert.deepEqual(h.requests.map((r) => r.url.hostname), ["open.example.com"]);
});

test("responses: only plain images inside the size cap are accepted", async () => {
  const dns = { "img.example.com": [PUBLIC_V4] };
  const cases: Array<[string, Step]> = [
    ["html page", { status: 200, headers: { "content-type": "text/html" }, body: "<html></html>" }],
    ["compressed body", { status: 200, headers: { "content-type": "image/jpeg", "content-encoding": "gzip" }, body: "x" }],
    ["declared too large", { status: 200, headers: { "content-type": "image/jpeg", "content-length": String(21 * 1024 * 1024) }, body: "x" }],
    ["empty body", { status: 200, headers: { "content-type": "image/jpeg" }, body: "" }],
    ["not found", { status: 404 }],
    ["forbidden", { status: 403 }],
    ["streamed past the cap", { status: 200, headers: { "content-type": "image/jpeg" }, body: Array.from({ length: 21 }, () => Buffer.alloc(1024 * 1024, 1)) }],
  ];
  for (const [name, step] of cases) {
    const h = harness(dns, () => step);
    assert.equal(await h.fetch("https://img.example.com/a.jpg"), null, name);
    assert.equal(h.requests.length, 1, `${name}: not retried`);
  }
  const noType = harness(dns, () => ({ status: 200, body: "raw" }));
  assert.equal((await noType.fetch("https://img.example.com/a.jpg"))?.toString(), "raw", "a missing content-type is tolerated");
  const octet = harness(dns, () => ({ status: 200, headers: { "content-type": "application/octet-stream" }, body: "raw" }));
  assert.ok(await octet.fetch("https://img.example.com/a.jpg"));
});

test("retry: a server error or network error is retried once, on the next vetted address", async () => {
  const flaky = harness({ "img.example.com": [PUBLIC_V4, PUBLIC_V4_B] }, (_t, n) => (n === 0 ? { status: 503 } : IMAGE));
  assert.ok(await flaky.fetch("https://img.example.com/a.jpg"));
  assert.deepEqual(flaky.requests.map((r) => r.address), [PUBLIC_V4, PUBLIC_V4_B]);

  const down = harness({ "img.example.com": [PUBLIC_V4] }, () => new Error("ECONNRESET"));
  assert.equal(await down.fetch("https://img.example.com/a.jpg"), null);
  assert.equal(down.requests.length, 2, "one retry, then give up");

  const limited = harness({ "img.example.com": [PUBLIC_V4] }, () => ({ status: 429 }));
  assert.equal(await limited.fetch("https://img.example.com/a.jpg"), null);
  assert.equal(limited.requests.length, 2);
});

test("fetch: Cloudinary originals are fetched as a capped JPEG from the same host", async () => {
  const h = harness({ "res.cloudinary.com": [PUBLIC_V4] }, () => IMAGE);
  assert.ok(await h.fetch("https://res.cloudinary.com/demo/image/upload/v1/sample.png"));
  assert.equal(h.requests[0]!.url.hostname, "res.cloudinary.com");
  assert.equal(h.requests[0]!.url.pathname, "/demo/image/upload/f_jpg,q_90,w_2200,c_limit/v1/sample.png");
});

// ---------------------------------------------------------------------------------------------
// Real socket: the connection goes to the pinned address, never to whatever DNS says
// ---------------------------------------------------------------------------------------------

test("socket: requestPinned connects to the pinned address and sends the URL's own Host, without any DNS lookup", async () => {
  const seen: Array<{ host?: string; url?: string; ua?: string }> = [];
  const server = http.createServer((req, res) => {
    seen.push({ host: req.headers.host, url: req.url, ua: String(req.headers["user-agent"]) });
    res.setHeader("content-type", "image/jpeg");
    res.end("pinned-ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    // ".invalid" can never resolve: reaching the server proves the pinned address was used.
    const res = await requestPinned({
      url: new URL(`http://no-such-host.invalid:${port}/p/a.jpg?x=1`),
      address: "127.0.0.1",
      family: 4,
      signal: new AbortController().signal,
      headers: { "user-agent": "pin-test" },
    });
    const chunks: Buffer[] = [];
    for await (const chunk of res) chunks.push(Buffer.from(chunk));
    assert.equal(res.statusCode, 200);
    assert.equal(Buffer.concat(chunks).toString(), "pinned-ok");
    assert.deepEqual(seen, [{ host: `no-such-host.invalid:${port}`, url: "/p/a.jpg?x=1", ua: "pin-test" }]);
  } finally {
    server.close();
  }
});

test("socket: an aborted request is rejected instead of hanging", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(() =>
    requestPinned({ url: new URL("http://no-such-host.invalid:9/a.jpg"), address: "127.0.0.1", family: 4, signal: ctrl.signal, headers: {} }),
  );
});
