import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_TTL_MS,
  adminSessionCookie,
  clearedAdminSessionCookie,
  createAdminSessionToken,
  isSameOriginWrite,
  isUsableAdminApiToken,
  isWeakAdminKey,
  shouldRenewAdminSession,
  verifyAdminSessionToken,
} from "../src/lib/adminSession";

const KEY_ONE = "session-key-one-4c8e2a6f0b9d3e7a1c5f8b2d6e0a4c9f";
const KEY_TWO = "session-key-two-9a1d5f3b7e2c6a0f4d8b1e5c9a3f7d2b";
const OWNER = "owner.test@example.test";
const STAFF = "staff.test@example.test";

test("a v2 session carries the Google address and is valid only while that address is allowed", () => {
  const now = Date.UTC(2027, 0, 10);
  const session = createAdminSessionToken(KEY_ONE, "Owner.Test@Example.test", now);
  assert.ok(session);
  const { token, expiresAt } = session;
  assert.ok(token.startsWith("v2."));
  assert.deepEqual(verifyAdminSessionToken(KEY_ONE, token, [OWNER, STAFF], now + 1000), { email: OWNER, expiresAt });
  assert.equal(verifyAdminSessionToken(KEY_ONE, token, [STAFF], now + 1000), null, "removing the address ends access at once");
  assert.equal(verifyAdminSessionToken(KEY_ONE, token, [], now + 1000), null, "an empty allow-list lets nobody in");
  assert.equal(verifyAdminSessionToken(KEY_TWO, token, [OWNER], now + 1000), null, "rotating ADMIN_SESSION_SECRET ends every session");
  assert.equal(verifyAdminSessionToken(KEY_ONE, token, [OWNER], expiresAt + 1), null, "expired");
  const [version, expiry, email, nonce, signature] = token.split(".");
  const extended = `${version}.${Number(expiry) + 86_400_000}.${email}.${nonce}.${signature}`;
  assert.equal(verifyAdminSessionToken(KEY_ONE, extended, [OWNER], now), null, "a tampered expiry fails the signature");
  const swapped = `${version}.${expiry}.${Buffer.from(STAFF).toString("base64url")}.${nonce}.${signature}`;
  assert.equal(verifyAdminSessionToken(KEY_ONE, swapped, [OWNER, STAFF], now), null, "a swapped address fails the signature");
  assert.equal(verifyAdminSessionToken(KEY_ONE, "", [OWNER], now), null);
  assert.equal(verifyAdminSessionToken(KEY_ONE, "v2.garbage", [OWNER], now), null);
  assert.equal(createAdminSessionToken(KEY_ONE, "", now), null, "no address, no session");
});

test("old v1 cookies (no address, signed with the retired admin secret) are refused", () => {
  const now = Date.UTC(2027, 0, 10);
  // A v1 token built exactly as the retired code did, even with the current key.
  const signingKey = createHmac("sha256", KEY_ONE).update("uudam-admin-session:v1").digest();
  const payload = `v1.${now + 3_600_000}.bm9uY2Utbm9uY2U`;
  const v1 = `${payload}.${createHmac("sha256", signingKey).update(payload).digest("base64url")}`;
  assert.equal(verifyAdminSessionToken(KEY_ONE, v1, [OWNER], now), null);
});

test("a short or guessable signing key issues and accepts no session (fail closed)", () => {
  const now = Date.UTC(2027, 0, 10);
  for (const weak of ["", "admin", "short-key-0123456789", "admin".repeat(8), "ab".repeat(20), "a".repeat(40)]) {
    assert.equal(isWeakAdminKey(weak), true, `weak: ${weak.slice(0, 8)}…`);
    assert.equal(createAdminSessionToken(weak, OWNER, now), null);
  }
  assert.equal(isWeakAdminKey(KEY_ONE), false);
  // A token signed while the key was strong stops working once the key is swapped for a weak one.
  const session = createAdminSessionToken(KEY_ONE, OWNER, now)!;
  assert.equal(verifyAdminSessionToken("admin", session.token, [OWNER], now), null);
});

test("the read-only API token must be strong and never the session key itself", () => {
  assert.equal(isUsableAdminApiToken(null, KEY_ONE), false);
  assert.equal(isUsableAdminApiToken("short-token", KEY_ONE), false);
  assert.equal(isUsableAdminApiToken(KEY_ONE, KEY_ONE), false, "the same value would let a script mint sessions");
  assert.equal(isUsableAdminApiToken(KEY_TWO, KEY_ONE), true);
});

test("sessions renew after a day of use and the cookie is HttpOnly and SameSite=Strict", () => {
  const now = Date.UTC(2027, 0, 10);
  assert.equal(shouldRenewAdminSession(now + ADMIN_SESSION_TTL_MS, now), false);
  assert.equal(shouldRenewAdminSession(now + ADMIN_SESSION_TTL_MS - 25 * 3_600_000, now), true);
  const cookie = adminSessionCookie("v2.a.b.c.d", now + ADMIN_SESSION_TTL_MS, now);
  assert.match(cookie, new RegExp(`^${ADMIN_SESSION_COOKIE}=`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=604800/);
  assert.match(clearedAdminSessionCookie(), /Max-Age=0/);
});

test("cookie-authenticated writes must come from the admin's own origin", () => {
  const headers = (extra: Record<string, string>) => ({ host: "uudam-admin.example", ...extra });
  assert.equal(isSameOriginWrite({ method: "GET", headers: headers({ origin: "https://elsewhere.example" }) }), true, "reads are not writes");
  assert.equal(isSameOriginWrite({ method: "POST", headers: headers({ origin: "https://uudam-admin.example" }) }), true);
  assert.equal(isSameOriginWrite({ method: "PATCH", headers: headers({ origin: "https://elsewhere.example" }) }), false);
  assert.equal(isSameOriginWrite({ method: "DELETE", headers: headers({ origin: "null" }) }), false);
  assert.equal(isSameOriginWrite({ method: "POST", headers: headers({}) }), true, "non-browser clients send no Origin");
});

type FakeResponse = {
  statusCode: number; body: Record<string, unknown>; headers: Record<string, unknown>;
  setHeader(name: string, value: unknown): void; status(code: number): FakeResponse;
  json(value: Record<string, unknown>): FakeResponse; end(): FakeResponse;
  redirect(code: number, url: string): FakeResponse; location?: string;
};
function fakeResponse(): FakeResponse {
  return {
    statusCode: 200, body: {}, headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end() { return this; },
    redirect(code, url) { this.statusCode = code; this.location = url; return this; },
  };
}

function idToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256" })}.${encode(claims)}.signature`;
}

async function loadAdminModules(overrides: Record<string, string | undefined> = {}) {
  const { applyTestEnv } = await import("./helpers/env");
  applyTestEnv({ ADMIN_AUTH_RATE_LIMIT: "2", ...overrides });
  const envModule = await import("../src/lib/env");
  envModule.resetEnvCacheForTests();
  const { resetRateLimitForTests } = await import("../src/lib/rateLimit");
  resetRateLimitForTests();
  const { default: session } = await import("../src/pages/api/admin/session");
  const { default: callback } = await import("../src/pages/api/admin/google/callback");
  const { default: start } = await import("../src/pages/api/admin/google/start");
  const access = await import("../src/lib/adminAccess");
  return { session, callback, start, ...access };
}

const HOST = { host: "uudam-admin.example", origin: "https://uudam-admin.example" };
const request = (method: string, extra: Record<string, unknown> = {}) => ({
  method, url: "/api/admin/session", query: {}, cookies: {},
  headers: HOST, socket: { remoteAddress: "203.0.113.9" }, ...extra,
}) as never;

test("the Google callback is the only way in: its session opens the admin API", async () => {
  const { session, callback, hasAdminAccess, readAdminSession } = await loadAdminModules();
  const { TEST_ADMIN_EMAILS } = await import("./helpers/env");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    id_token: idToken({
      iss: "https://accounts.google.com", aud: "123-test.apps.googleusercontent.com",
      exp: Math.floor(Date.now() / 1000) + 600, email: TEST_ADMIN_EMAILS[1], email_verified: true,
    }),
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  let token = "";
  try {
    const res = fakeResponse();
    await callback({
      method: "GET", query: { code: "test-code", state: "st4te-st4te" },
      cookies: { uudam_admin_oauth: "st4te-st4te" }, headers: HOST, socket: { remoteAddress: "203.0.113.9" },
    } as never, res as never);
    assert.equal(res.statusCode, 303);
    assert.equal(res.location, "/admin");
    const cookies = res.headers["Set-Cookie"] as string[];
    const sessionCookie = cookies.find((value) => value.startsWith(`${ADMIN_SESSION_COOKIE}=`)) || "";
    token = decodeURIComponent(sessionCookie.split(";")[0].split("=").slice(1).join("="));
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(token.startsWith("v2."));

  const withCookie = (method: string, origin: string) => ({
    method, query: {}, cookies: { [ADMIN_SESSION_COOKIE]: token },
    headers: { host: "uudam-admin.example", origin },
  }) as never;
  assert.equal(readAdminSession(withCookie("GET", "https://uudam-admin.example"))?.email, TEST_ADMIN_EMAILS[1]);
  assert.equal(hasAdminAccess(withCookie("GET", "https://uudam-admin.example")), true);
  assert.equal(hasAdminAccess(withCookie("PATCH", "https://uudam-admin.example")), true);
  assert.equal(hasAdminAccess(withCookie("PATCH", "https://elsewhere.example")), false, "cross-site write refused");
  assert.equal(hasAdminAccess({ method: "GET", query: {}, cookies: {}, headers: {} } as never), false);

  const status = fakeResponse();
  await session(withCookie("GET", "https://uudam-admin.example"), status as never);
  assert.equal(status.body.authorized, true);
  assert.equal(status.body.google_sign_in, true);
  assert.equal("open_access" in status.body, false);

  const signOut = fakeResponse();
  await session(withCookie("DELETE", "https://uudam-admin.example"), signOut as never);
  assert.match(String(signOut.headers["Set-Cookie"]), /Max-Age=0/);
});

test("the password sign-in, the x-admin-secret header and ?secret= are gone", async () => {
  const { session, hasAdminAccess } = await loadAdminModules({ ADMIN_SECRET: "retired-admin-secret-value-0123456789" });
  const post = fakeResponse();
  await session(request("POST", { body: { secret: "retired-admin-secret-value-0123456789" } }), post as never);
  assert.equal(post.statusCode, 405, "POST /api/admin/session no longer exists");
  assert.equal(post.headers.Allow, "GET, DELETE");
  assert.equal(post.headers["Set-Cookie"], undefined);

  for (const secret of ["retired-admin-secret-value-0123456789", "test-admin-secret"]) {
    assert.equal(hasAdminAccess({ method: "GET", query: {}, cookies: {}, headers: { "x-admin-secret": secret } } as never), false);
    assert.equal(hasAdminAccess({ method: "GET", query: { secret }, cookies: {}, headers: {} } as never), false);
  }
});

test("the read-only API token opens GET and HEAD, never a write", async () => {
  const { hasAdminAccess, requireAdminAccess } = await loadAdminModules();
  const { adminBearerHeaders } = await import("./helpers/adminAuth");
  const bearer = (method: string, headers = adminBearerHeaders()) => ({ method, query: {}, cookies: {}, headers, socket: { remoteAddress: "203.0.113.10" } }) as never;
  assert.equal(hasAdminAccess(bearer("GET")), true);
  assert.equal(hasAdminAccess(bearer("HEAD")), true);
  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) assert.equal(hasAdminAccess(bearer(method)), false, method);
  assert.equal(hasAdminAccess(bearer("GET", adminBearerHeaders("wrong-token-0123456789abcdef-0123456789"))), false);
  assert.equal(hasAdminAccess(bearer("GET", { authorization: "Basic abc" })), false);
  assert.equal(hasAdminAccess(bearer("GET"), { allowApiToken: false }), false, "a route that writes outside refuses it");

  const denied = fakeResponse();
  assert.equal(await requireAdminAccess(bearer("POST"), denied as never, "test.write"), false);
  assert.equal(denied.statusCode, 401);

  assert.equal(await requireAdminAccess(bearer("GET"), fakeResponse() as never, "api.admin.trips"), true, "a plain read opens");
  for (const [index, route] of ["api.admin.website-sync", "api.subscribe_feed"].entries()) {
    const sideEffect = fakeResponse();
    // Its own address, so the failed-auth throttle of the checks above does not answer 429.
    const request = { method: "GET", query: {}, cookies: {}, headers: adminBearerHeaders(), socket: { remoteAddress: `198.51.100.${20 + index}` } } as never;
    assert.equal(await requireAdminAccess(request, sideEffect as never, route), false, `${route}: its GET writes elsewhere`);
    assert.equal(sideEffect.statusCode, 401);
  }
});

test("a weak or reused API token is refused", async () => {
  const { hasAdminAccess, adminApiTokenUsable } = await loadAdminModules({ ADMIN_API_TOKEN: "short-token" });
  const { adminBearerHeaders } = await import("./helpers/adminAuth");
  assert.equal(adminApiTokenUsable(), false);
  assert.equal(hasAdminAccess({ method: "GET", query: {}, cookies: {}, headers: adminBearerHeaders("short-token") } as never), false);

  const { TEST_ADMIN_SESSION_SECRET } = await import("./helpers/env");
  const reused = await loadAdminModules({ ADMIN_API_TOKEN: TEST_ADMIN_SESSION_SECRET });
  assert.equal(reused.hasAdminAccess({ method: "GET", query: {}, cookies: {}, headers: adminBearerHeaders(TEST_ADMIN_SESSION_SECRET) } as never), false);
});

// A MISSING key behaves exactly like a weak one: admin sign-in off, nothing throws.
test("a missing session key turns sign-in off (fail closed) instead of throwing", async () => {
  const { session, start, callback, hasAdminAccess } = await loadAdminModules({ ADMIN_SESSION_SECRET: undefined });
  const status = fakeResponse();
  await session(request("GET"), status as never);
  assert.equal(status.statusCode, 200);
  assert.equal(status.body.google_sign_in, false);
  assert.equal(status.body.authorized, false);
  const go = fakeResponse();
  start({ method: "GET", query: {}, cookies: {}, headers: HOST } as never, go as never);
  assert.equal(go.location, "/admin?login_error=google_not_configured");
  const back = fakeResponse();
  await callback({ method: "GET", query: {}, cookies: {}, headers: HOST, socket: { remoteAddress: "203.0.113.9" } } as never, back as never);
  assert.equal(back.location, "/admin?login_error=google_not_configured");
  const { adminSessionToken } = await import("./helpers/adminAuth");
  const forged = adminSessionToken("owner.test@example.test", KEY_ONE);
  assert.equal(hasAdminAccess({ method: "GET", query: {}, cookies: { [ADMIN_SESSION_COOKIE]: forged }, headers: {} } as never), false);
});

test("a weak session key turns sign-in off (fail closed) and the login card is told so", async () => {
  const { session, start, callback, hasAdminAccess } = await loadAdminModules({ ADMIN_SESSION_SECRET: "admin" });
  const { adminSessionToken } = await import("./helpers/adminAuth");
  const status = fakeResponse();
  await session(request("GET"), status as never);
  assert.equal(status.body.google_sign_in, false);
  assert.equal(status.body.authorized, false);

  const go = fakeResponse();
  start({ method: "GET", query: {}, cookies: {}, headers: HOST } as never, go as never);
  assert.equal(go.location, "/admin?login_error=google_not_configured");

  const back = fakeResponse();
  await callback({ method: "GET", query: {}, cookies: {}, headers: HOST, socket: { remoteAddress: "203.0.113.9" } } as never, back as never);
  assert.equal(back.location, "/admin?login_error=google_not_configured");

  // Even a cookie that was signed with the weak key is refused.
  const { createAdminSessionToken: create } = await import("../src/lib/adminSession");
  assert.equal(create("admin", "owner.test@example.test"), null);
  assert.throws(() => adminSessionToken("owner.test@example.test", "admin"));
  assert.equal(hasAdminAccess({ method: "GET", query: {}, cookies: {}, headers: {} } as never), false);
});

test("without Google setup the session check says nobody can sign in", async () => {
  const { session } = await loadAdminModules({ GOOGLE_CLIENT_ID: undefined });
  const status = fakeResponse();
  await session(request("GET"), status as never);
  assert.equal(status.body.google_sign_in, false);
});
