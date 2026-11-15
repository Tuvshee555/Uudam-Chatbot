import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGoogleAuthUrl,
  checkGoogleIdToken,
  googleRedirectUri,
  googleStateCookie,
  parseAllowedEmails,
  statesMatch,
} from "../src/lib/adminGoogleAuth";

const CLIENT_ID = "123-test.apps.googleusercontent.com";
const NOW = Date.UTC(2027, 0, 10);

function idToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256" })}.${encode(claims)}.signature`;
}

const valid = {
  iss: "https://accounts.google.com",
  aud: CLIENT_ID,
  exp: NOW / 1000 + 3600,
  email: "Owner@Example.com",
  email_verified: true,
};

test("allowed emails are split on commas or spaces and lower-cased", () => {
  assert.deepEqual(parseAllowedEmails(" Owner@Example.com, staff@example.com\nnot-an-email "), [
    "owner@example.com",
    "staff@example.com",
  ]);
  assert.deepEqual(parseAllowedEmails(undefined), []);
});

test("only a listed, verified account from this client gets in", () => {
  const allowed = ["owner@example.com"];
  assert.deepEqual(checkGoogleIdToken(idToken(valid), CLIENT_ID, allowed, NOW), { ok: true, email: "owner@example.com" });
  assert.deepEqual(
    checkGoogleIdToken(idToken({ ...valid, email: "stranger@example.com" }), CLIENT_ID, allowed, NOW),
    { ok: false, error: "google_email_not_allowed" },
  );
  assert.deepEqual(
    checkGoogleIdToken(idToken({ ...valid, email_verified: false }), CLIENT_ID, allowed, NOW),
    { ok: false, error: "google_email_unverified" },
  );
  for (const bad of [
    { ...valid, aud: "another-app" },
    { ...valid, iss: "https://evil.example" },
    { ...valid, exp: NOW / 1000 - 1 },
    { ...valid, email: undefined },
  ]) {
    assert.deepEqual(checkGoogleIdToken(idToken(bad), CLIENT_ID, allowed, NOW), { ok: false, error: "google_token_invalid" });
  }
  assert.deepEqual(checkGoogleIdToken("garbage", CLIENT_ID, allowed, NOW), { ok: false, error: "google_token_invalid" });
});

test("the redirect URI follows the host the browser used", () => {
  assert.equal(
    googleRedirectUri({ headers: { host: "admin.example.com", "x-forwarded-proto": "https" } }),
    "https://admin.example.com/api/admin/google/callback",
  );
  assert.equal(googleRedirectUri({ headers: { host: "localhost:3004" } }), "http://localhost:3004/api/admin/google/callback");
});

test("the auth URL asks only for identity and carries the state", () => {
  const url = new URL(buildGoogleAuthUrl(CLIENT_ID, "https://admin.example.com/api/admin/google/callback", "st4te"));
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("scope"), "openid email");
  assert.equal(url.searchParams.get("state"), "st4te");
  assert.equal(url.searchParams.get("response_type"), "code");
});

test("state must match the cookie exactly and the cookie survives the return from Google", () => {
  assert.equal(statesMatch("abc", "abc"), true);
  assert.equal(statesMatch("abc", "abd"), false);
  assert.equal(statesMatch("", ""), false);
  assert.match(googleStateCookie("abc"), /HttpOnly; SameSite=Lax; Max-Age=600/);
});
