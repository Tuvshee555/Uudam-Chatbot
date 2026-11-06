import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ADMIN_SESSION_COOKIE as DEV_COOKIE_NAME,
  devAdminCookie,
  devAdminCookieFromEnv,
  devAdminSessionToken,
} from "../scripts/lib/devAdminCookie.mjs";
import { ADMIN_SESSION_COOKIE, verifyAdminSessionToken } from "../src/lib/adminSession";

const KEY = "local-dev-key-3e9a7c1f5b2d8e4a-0c6f9b3d7a1e5c8f";
const OTHER_KEY = "prod-like-key-8d2f6b0a4e9c1d7f-3b5e8a2c6f0d4b9e";
const ALLOWED = ["owner.test@example.test", "staff.test@example.test"];

test("the dev cookie is a session the server's own verify function accepts", () => {
  const cookie = devAdminCookie("http://localhost:3004", { key: KEY, email: "Staff.Test@example.test" });
  assert.equal(cookie.name, ADMIN_SESSION_COOKIE);
  assert.equal(DEV_COOKIE_NAME, ADMIN_SESSION_COOKIE);
  assert.equal(cookie.url, "http://localhost:3004");
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, "Strict");
  const session = verifyAdminSessionToken(KEY, cookie.value, ALLOWED);
  assert.equal(session?.email, "staff.test@example.test");
  assert.ok(session && session.expiresAt > Date.now());
});

test("a dev cookie opens nothing where the key or the allow-list differs", () => {
  const token = devAdminSessionToken({ key: KEY, email: ALLOWED[0] });
  assert.equal(verifyAdminSessionToken(OTHER_KEY, token, ALLOWED), null, "production's key is different");
  assert.equal(verifyAdminSessionToken(KEY, token, [ALLOWED[1]]), null, "an address off the list is refused");
});

test("the dev cookie refuses any host but localhost and 127.0.0.1", () => {
  assert.doesNotThrow(() => devAdminCookie("http://127.0.0.1:3004/admin", { key: KEY, email: ALLOWED[0] }));
  for (const url of ["https://uudam-chatbot.vercel.app", "http://192.168.1.20:3004", "http://localhost.example.test", "not a url"]) {
    assert.throws(() => devAdminCookie(url, { key: KEY, email: ALLOWED[0] }), /localhost|full URL/, url);
  }
});

test("the dev cookie needs a strong local key and an address", () => {
  assert.throws(() => devAdminSessionToken({ key: "short", email: ALLOWED[0] }), /ADMIN_SESSION_SECRET/);
  assert.throws(() => devAdminSessionToken({ key: undefined, email: ALLOWED[0] }), /ADMIN_SESSION_SECRET/);
  assert.throws(() => devAdminSessionToken({ key: KEY, email: "" }), /ADMIN_GOOGLE_EMAILS/);
});

test("from an env file it signs with that key for the first allowed address", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-admin-cookie-"));
  const saved = { key: process.env.ADMIN_SESSION_SECRET, emails: process.env.ADMIN_GOOGLE_EMAILS };
  delete process.env.ADMIN_SESSION_SECRET;
  delete process.env.ADMIN_GOOGLE_EMAILS;
  try {
    const envPath = join(dir, ".env.local");
    writeFileSync(envPath, `# local only\nADMIN_SESSION_SECRET="${KEY}"\nADMIN_GOOGLE_EMAILS=${ALLOWED.join(", ")}\n`);
    const cookie = devAdminCookieFromEnv("http://localhost:3004", { envPath });
    assert.equal(verifyAdminSessionToken(KEY, cookie.value, ALLOWED)?.email, ALLOWED[0]);
    const second = devAdminCookieFromEnv("http://localhost:3004", { envPath, email: ALLOWED[1] });
    assert.equal(verifyAdminSessionToken(KEY, second.value, ALLOWED)?.email, ALLOWED[1]);
    assert.throws(() => devAdminCookieFromEnv("http://localhost:3004", { envPath, email: "stranger@example.test" }), /not on the local/);

    const emptyPath = join(dir, "empty.env");
    writeFileSync(emptyPath, `ADMIN_SESSION_SECRET=${KEY}\n`);
    assert.throws(() => devAdminCookieFromEnv("http://localhost:3004", { envPath: emptyPath }), /ADMIN_GOOGLE_EMAILS is empty/);
  } finally {
    if (saved.key !== undefined) process.env.ADMIN_SESSION_SECRET = saved.key;
    if (saved.emails !== undefined) process.env.ADMIN_GOOGLE_EMAILS = saved.emails;
    rmSync(dir, { recursive: true, force: true });
  }
});
