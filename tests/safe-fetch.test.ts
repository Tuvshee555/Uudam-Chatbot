import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  isBlockedAddress, safeFetchWith, SafeFetchError,
  type ResolvedAddress, type SafeFetchDeps, type TransportResponse,
} from "../src/lib/safeFetch";

/**
 * The assistant's outside fetcher (read a partner page, copy a photo) must never reach our own
 * network: every hop's host is resolved and checked, redirects are followed by hand, and size
 * and time are capped. No real network: DNS and the transport are fakes. Invented hosts only.
 */

type Hop = { status: number; headers?: Record<string, string>; body?: Array<Buffer | string>; hang?: boolean };

function fake(dns: Record<string, string[]>, hops: Record<string, Hop>) {
  const requested: string[] = [];
  const deps: SafeFetchDeps = {
    resolve: async (host) => {
      const answers = dns[host];
      if (!answers) throw new Error("ENOTFOUND");
      return answers.map((address): ResolvedAddress => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
    transport: async ({ url, signal }) => {
      requested.push(url.toString());
      const hop = hops[url.toString()];
      if (!hop) throw new Error("no such page");
      if (hop.hang) {
        return new Promise<TransportResponse>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      return {
        status: hop.status,
        headers: hop.headers || {},
        body: (async function* () { for (const chunk of hop.body || []) yield chunk; })(),
      };
    },
  };
  return { deps, requested };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof SafeFetchError, `expected a SafeFetchError, got ${String(error)}`);
    assert.match(error.message, /[а-яөү]/i, "the reason is a Mongolian sentence");
    return error.code;
  }
  assert.fail("expected the fetch to be refused");
}

test("private, loopback, link-local, CGNAT, multicast and hidden-IPv4 addresses are all blocked", () => {
  for (const address of [
    "127.0.0.1", "10.2.3.4", "172.16.0.1", "172.31.255.255", "192.168.1.10", "169.254.169.254", "100.64.0.1", "100.127.255.254",
    "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%eth0",
    "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "2002:0a00:0001::1", "[::1]", "not-an-ip",
  ]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  for (const address of ["8.8.8.8", "203.0.114.9", "151.101.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(isBlockedAddress(address), false, address);
  }
});

test("only https on the normal port is fetched", async () => {
  const { deps, requested } = fake({ "partner.example": ["203.0.114.9"] }, {});
  assert.equal(await refusal(safeFetchWith(deps, "http://partner.example/trip")), "not_https");
  assert.equal(await refusal(safeFetchWith(deps, "https://partner.example:8443/trip")), "blocked_port");
  assert.equal(await refusal(safeFetchWith(deps, "https://user:pw@partner.example/trip")), "invalid_url");
  assert.equal(await refusal(safeFetchWith(deps, "ftp://partner.example/trip")), "not_https");
  assert.equal(requested.length, 0, "nothing was requested");
});

test("a private address in the link, or a name that resolves to one, is refused before connecting", async () => {
  const { deps, requested } = fake({
    "internal.example": ["10.0.0.7"],
    "mixed.example": ["203.0.114.9", "192.168.0.4"],
    "v6local.example": ["fd00::5"],
  }, {});
  assert.equal(await refusal(safeFetchWith(deps, "https://169.254.169.254/latest/meta-data/")), "blocked_address");
  assert.equal(await refusal(safeFetchWith(deps, "https://[::1]/")), "blocked_address");
  assert.equal(await refusal(safeFetchWith(deps, "https://localhost/")), "blocked_address");
  assert.equal(await refusal(safeFetchWith(deps, "https://internal.example/")), "blocked_address");
  assert.equal(await refusal(safeFetchWith(deps, "https://mixed.example/")), "blocked_address", "one private answer is enough");
  assert.equal(await refusal(safeFetchWith(deps, "https://v6local.example/")), "blocked_address");
  assert.equal(await refusal(safeFetchWith(deps, "https://nowhere.example/")), "dns_failed");
  assert.equal(requested.length, 0);
});

test("redirects are followed by hand, at most 3, and every hop is checked again", async () => {
  const { deps, requested } = fake({ "partner.example": ["203.0.114.9"], "evil.example": ["127.0.0.1"] }, {
    "https://partner.example/a": { status: 302, headers: { location: "https://169.254.169.254/latest/" } },
    "https://partner.example/b": { status: 301, headers: { location: "https://evil.example/" } },
    "https://partner.example/c": { status: 307, headers: { location: "http://partner.example/plain" } },
    "https://partner.example/1": { status: 302, headers: { location: "/2" } },
    "https://partner.example/2": { status: 302, headers: { location: "/3" } },
    "https://partner.example/3": { status: 302, headers: { location: "/4" } },
    "https://partner.example/4": { status: 302, headers: { location: "/5" } },
    "https://partner.example/nolocation": { status: 302 },
  });
  assert.equal(await refusal(safeFetchWith(deps, "https://partner.example/a")), "blocked_address", "a redirect to a private IP");
  assert.equal(await refusal(safeFetchWith(deps, "https://partner.example/b")), "blocked_address", "a redirect to a name that resolves privately");
  assert.equal(await refusal(safeFetchWith(deps, "https://partner.example/c")), "not_https", "a redirect down to http");
  assert.equal(await refusal(safeFetchWith(deps, "https://partner.example/1")), "too_many_redirects");
  assert.equal(await refusal(safeFetchWith(deps, "https://partner.example/nolocation")), "redirect_without_location");
  assert.ok(!requested.some((url) => /169\.254|evil\.example|http:\/\//.test(url)), "no blocked hop was ever requested");
});

test("a page within the limits comes back with its final link, status, type and body", async () => {
  const { deps } = fake({ "partner.example": ["203.0.114.9"] }, {
    "https://partner.example/trip": { status: 302, headers: { location: "/trip/velmor" } },
    "https://partner.example/trip/velmor": { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: ["<h1>Вэлмор</h1>", Buffer.from("<p>5 өдөр</p>")] },
    "https://partner.example/gone": { status: 404, headers: { "content-type": "text/html" }, body: ["missing"] },
  });
  const page = await safeFetchWith(deps, "https://partner.example/trip");
  assert.equal(page.url, "https://partner.example/trip/velmor");
  assert.equal(page.status, 200);
  assert.match(page.contentType, /text\/html/);
  assert.equal(page.body.toString("utf8"), "<h1>Вэлмор</h1><p>5 өдөр</p>");
  const missing = await safeFetchWith(deps, "https://partner.example/gone");
  assert.equal(missing.status, 404, "a non-2xx answer is returned, not thrown");
});

test("an oversize body is refused, whether declared, streamed or hidden in gzip", async () => {
  const big = "x".repeat(3000);
  const { deps } = fake({ "partner.example": ["203.0.114.9"] }, {
    "https://partner.example/declared": { status: 200, headers: { "content-length": "999999" }, body: ["tiny"] },
    "https://partner.example/streamed": { status: 200, body: [big, big] },
    "https://partner.example/bomb": { status: 200, headers: { "content-encoding": "gzip" }, body: [gzipSync(Buffer.alloc(200_000))] },
    "https://partner.example/ok": { status: 200, headers: { "content-encoding": "gzip" }, body: [gzipSync(Buffer.from("small page"))] },
  });
  assert.equal(await refusal(safeFetchWith(deps, "https://partner.example/declared", { maxBytes: 5000 })), "too_large");
  assert.equal(await refusal(safeFetchWith(deps, "https://partner.example/streamed", { maxBytes: 5000 })), "too_large");
  assert.equal(await refusal(safeFetchWith(deps, "https://partner.example/bomb", { maxBytes: 5000 })), "too_large");
  assert.equal((await safeFetchWith(deps, "https://partner.example/ok", { maxBytes: 5000 })).body.toString(), "small page");
});

test("a page that does not answer in time is refused", async () => {
  const { deps } = fake({ "partner.example": ["203.0.114.9"] }, { "https://partner.example/slow": { status: 200, hang: true } });
  const started = Date.now();
  assert.equal(await refusal(safeFetchWith(deps, "https://partner.example/slow", { timeoutMs: 60 })), "timeout");
  assert.ok(Date.now() - started < 2000);
});

test("hostImage keeps our own photo, uploads an attachment, and never fetches a private or plain-http link", async (context) => {
  const { applyTestEnv } = await import("./helpers/env");
  applyTestEnv({ CLOUDINARY_CLOUD_NAME: "uudam-fixture", CLOUDINARY_API_KEY: "fixture-key", CLOUDINARY_API_SECRET: "fixture-secret", NEON_DATABASE_URL: undefined, DATABASE_URL: undefined });
  const { resetEnvCacheForTests } = await import("../src/lib/env");
  resetEnvCacheForTests();
  const uploads: string[] = [];
  context.mock.method(globalThis, "fetch", async (input: unknown) => {
    const url = String(input);
    if (!url.startsWith("https://api.cloudinary.com/v1_1/uudam-fixture/image/upload")) throw new Error(`unexpected fetch ${url}`);
    uploads.push(url);
    return new Response(JSON.stringify({ secure_url: "https://res.cloudinary.com/uudam-fixture/image/upload/v9/uudam-connected-trips/abc.jpg" }), { status: 200 });
  });
  const { hostImage } = await import("../src/lib/websiteTripSync");
  const own = "https://res.cloudinary.com/uudam-fixture/image/upload/v1/fixture/lake.jpg";
  assert.equal(await hostImage(own), own, "already ours: returned as it is, nothing uploaded");
  const attached = `data:image/png;base64,${Buffer.from("fixture-png-bytes").toString("base64")}`;
  assert.equal(await hostImage(attached), "https://res.cloudinary.com/uudam-fixture/image/upload/v9/uudam-connected-trips/abc.jpg");
  assert.equal(uploads.length, 1);
  await assert.rejects(hostImage("https://127.0.0.1/photo.jpg"), /дотоод сүлжээ/);
  await assert.rejects(hostImage("https://[::ffff:169.254.169.254]/latest"), /дотоод сүлжээ/);
  await assert.rejects(hostImage("http://partner.example/photo.jpg"), /https/);
  assert.equal(uploads.length, 1, "no refused link reached Cloudinary");
  const { isHostedPhotoUrl } = await import("../src/lib/tripPhotoEdit");
  assert.equal(isHostedPhotoUrl("https://res.cloudinary.com/another-account/image/upload/v1/x.jpg"), false, "another Cloudinary account is an outside link");
  assert.equal(isHostedPhotoUrl(own), true);
});

test("the connection can only open to the address that passed the check (DNS rebinding)", async () => {
  let answer = "203.0.114.9";
  let pinned: ResolvedAddress | null = null;
  let rebindRefused = false;
  const deps: SafeFetchDeps = {
    resolve: async () => [{ address: answer, family: 4 }],
    transport: async ({ url, lookup }) => {
      pinned = await lookup(url.hostname);
      // The name changes its answer between the check and the connect.
      answer = "10.0.0.9";
      rebindRefused = await lookup(url.hostname).then(() => false, (error) => error instanceof SafeFetchError && error.code === "blocked_address");
      return { status: 200, headers: {}, body: (async function* () { yield "ok"; })() };
    },
  };
  await safeFetchWith(deps, "https://partner.example/");
  assert.deepEqual(pinned, { address: "203.0.114.9", family: 4 });
  assert.equal(rebindRefused, true, "a private answer at connect time is refused");
});
