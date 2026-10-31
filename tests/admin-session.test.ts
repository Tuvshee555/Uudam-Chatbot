import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_TTL_MS,
  adminSessionCookie,
  clearedAdminSessionCookie,
  createAdminSessionToken,
  isSameOriginWrite,
  shouldRenewAdminSession,
  verifyAdminSessionToken,
} from "../src/lib/adminSession";

test("a session token is valid only for the secret that signed it, until it expires", () => {
  const now = Date.UTC(2027, 0, 10);
  const { token, expiresAt } = createAdminSessionToken("secret-one", now);
  assert.equal(verifyAdminSessionToken("secret-one", token, now + 1000), expiresAt);
  assert.equal(verifyAdminSessionToken("secret-two", token, now + 1000), null, "rotating ADMIN_SECRET ends every session");
  assert.equal(verifyAdminSessionToken("secret-one", token, expiresAt + 1), null, "expired");
  const [version, expiry, nonce, signature] = token.split(".");
  const extended = `${version}.${Number(expiry) + 86_400_000}.${nonce}.${signature}`;
  assert.equal(verifyAdminSessionToken("secret-one", extended, now), null, "a tampered expiry fails the signature");
  assert.equal(verifyAdminSessionToken("secret-one", "", now), null);
  assert.equal(verifyAdminSessionToken("secret-one", "v1.garbage", now), null);
});

test("sessions renew after a day of use and the cookie is HttpOnly and SameSite=Strict", () => {
  const now = Date.UTC(2027, 0, 10);
  assert.equal(shouldRenewAdminSession(now + ADMIN_SESSION_TTL_MS, now), false);
  assert.equal(shouldRenewAdminSession(now + ADMIN_SESSION_TTL_MS - 25 * 3_600_000, now), true);
  const cookie = adminSessionCookie("v1.a.b.c", now + ADMIN_SESSION_TTL_MS, now);
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
};
function fakeResponse(): FakeResponse {
  return {
    statusCode: 200, body: {}, headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end() { return this; },
  };
}

test("signing in sets a session the admin API accepts; a wrong secret is refused and throttled", async () => {
  const { applyTestEnv } = await import("./helpers/env");
  applyTestEnv({ ADMIN_AUTH_RATE_LIMIT: "2" });
  const envModule = await import("../src/lib/env");
  envModule.resetEnvCacheForTests();
  const { resetRateLimitForTests } = await import("../src/lib/rateLimit");
  resetRateLimitForTests();
  const { default: session } = await import("../src/pages/api/admin/session");
  const { hasAdminAccess } = await import("../src/lib/adminAccess");
  const request = (method: string, extra: Record<string, unknown> = {}) => ({
    method, url: "/api/admin/session", query: {}, cookies: {},
    headers: { host: "uudam-admin.example", origin: "https://uudam-admin.example" },
    socket: { remoteAddress: "203.0.113.9" }, ...extra,
  }) as never;

  const wrong = fakeResponse();
  await session(request("POST", { body: { secret: "not-it" } }), wrong as never);
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.headers["Set-Cookie"], undefined);

  const right = fakeResponse();
  await session(request("POST", { body: { secret: "test-admin-secret" } }), right as never);
  assert.equal(right.statusCode, 200);
  const cookie = String(right.headers["Set-Cookie"] || "");
  const token = decodeURIComponent(cookie.split(";")[0].split("=").slice(1).join("="));
  assert.ok(token.startsWith("v1."));

  const withCookie = (method: string, origin: string) => ({
    method, query: {}, cookies: { [ADMIN_SESSION_COOKIE]: token },
    headers: { host: "uudam-admin.example", origin },
  }) as never;
  assert.equal(hasAdminAccess(withCookie("GET", "https://uudam-admin.example")), true);
  assert.equal(hasAdminAccess(withCookie("PATCH", "https://uudam-admin.example")), true);
  assert.equal(hasAdminAccess(withCookie("PATCH", "https://elsewhere.example")), false, "cross-site write refused");
  assert.equal(hasAdminAccess({ method: "GET", query: {}, cookies: {}, headers: {} } as never), false);
  assert.equal(hasAdminAccess({ method: "GET", query: {}, cookies: {}, headers: { "x-admin-secret": "test-admin-secret" } } as never), true,
    "scripts keep using the header");

  const status = fakeResponse();
  await session(withCookie("GET", "https://uudam-admin.example"), status as never);
  assert.equal(status.body.authorized, true);

  const signOut = fakeResponse();
  await session(withCookie("DELETE", "https://uudam-admin.example"), signOut as never);
  assert.match(String(signOut.headers["Set-Cookie"]), /Max-Age=0/);

  // Two wrong secrets per minute in this test; the next is throttled.
  await session(request("POST", { body: { secret: "still-wrong" } }), fakeResponse() as never);
  const throttled = fakeResponse();
  await session(request("POST", { body: { secret: "wrong-again" } }), throttled as never);
  assert.equal(throttled.statusCode, 429);
});
