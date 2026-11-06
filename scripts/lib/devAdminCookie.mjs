// Dev-only admin sign-in for local browser walks (Playwright). The admin is Google-only, and
// Google blocks automated browsers, so a local walk signs itself in with a session cookie it
// mints from THIS PC's .env.local:
//   - the key is the LOCAL ADMIN_SESSION_SECRET (never the production one: production's is
//     Sensitive in Vercel and differs, so a cookie made here opens nothing there);
//   - the address is one of the LOCAL ADMIN_GOOGLE_EMAILS (the server re-checks it);
//   - any target but localhost / 127.0.0.1 is refused.
// Nothing is added to the server: the local `next dev` simply accepts a cookie signed with
// its own key. The token format mirrors src/lib/adminSession.ts (v2); tests/dev-admin-cookie
// proves the server's verify function accepts it, so the two never drift.
//
//   import { devAdminCookieFromEnv } from "<repo>/scripts/lib/devAdminCookie.mjs";
//   await context.addCookies([devAdminCookieFromEnv("http://localhost:3004", { envPath })]);
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ADMIN_SESSION_COOKIE = "uudam_admin";
const SESSION_KEY_LABEL = "uudam-admin-session:v2";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
const MIN_KEY_LENGTH = 32;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
/** The longest a session may last (the server refuses anything further out). */
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Throws unless the URL points at this PC. */
export function assertLocalTarget(baseUrl) {
  let hostname = "";
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    throw new Error("dev sign-in needs a full URL such as http://localhost:3004");
  }
  if (!LOCAL_HOSTS.has(hostname)) {
    throw new Error("dev sign-in is for localhost / 127.0.0.1 only; production is Google-only");
  }
}

function stripQuotes(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** KEY=value pairs of an env file ({} when it is missing). */
export function readEnvFile(path) {
  const out = {};
  if (!path || !existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = stripQuotes(trimmed.slice(eq + 1));
  }
  return out;
}

function allowedEmails(raw) {
  return String(raw || "")
    .split(/[,\s]+/)
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.includes("@"));
}

/** A v2 session token (same format and key derivation as src/lib/adminSession.ts). */
export function devAdminSessionToken({ key, email, now = Date.now(), ttlMs = DEFAULT_TTL_MS }) {
  const secret = String(key || "").trim();
  if (secret.length < MIN_KEY_LENGTH) {
    throw new Error("set a LOCAL ADMIN_SESSION_SECRET in .env.local (32+ random characters, never the production value)");
  }
  const address = String(email || "").trim().toLowerCase();
  if (!address.includes("@")) throw new Error("dev sign-in needs an address from the local ADMIN_GOOGLE_EMAILS");
  const lifetime = Math.min(Math.max(60_000, Number(ttlMs) || DEFAULT_TTL_MS), MAX_TTL_MS);
  const signingKey = createHmac("sha256", secret).update(SESSION_KEY_LABEL).digest();
  const payload = `v2.${now + lifetime}.${Buffer.from(address, "utf8").toString("base64url")}.${randomBytes(12).toString("base64url")}`;
  return `${payload}.${createHmac("sha256", signingKey).update(payload).digest("base64url")}`;
}

/** A Playwright cookie for a local admin session. Throws for any non-local target. */
export function devAdminCookie(baseUrl, { key, email, now, ttlMs } = {}) {
  assertLocalTarget(baseUrl);
  const origin = new URL(baseUrl).origin;
  return {
    name: ADMIN_SESSION_COOKIE,
    value: devAdminSessionToken({ key, email, now, ttlMs }),
    url: origin,
    httpOnly: true,
    sameSite: "Strict",
  };
}

/**
 * The cookie from the local .env.local: its ADMIN_SESSION_SECRET and the first (or the named)
 * ADMIN_GOOGLE_EMAILS address. Values are never printed.
 */
export function devAdminCookieFromEnv(baseUrl, { envPath = resolve(REPO_ROOT, ".env.local"), email, ttlMs } = {}) {
  assertLocalTarget(baseUrl);
  const fileEnv = readEnvFile(envPath);
  const key = process.env.ADMIN_SESSION_SECRET || fileEnv.ADMIN_SESSION_SECRET;
  const allowed = allowedEmails(process.env.ADMIN_GOOGLE_EMAILS || fileEnv.ADMIN_GOOGLE_EMAILS);
  if (!allowed.length) throw new Error("the local ADMIN_GOOGLE_EMAILS is empty; the server would refuse any dev session");
  const wanted = email ? String(email).trim().toLowerCase() : allowed[0];
  if (!allowed.includes(wanted)) throw new Error("that address is not on the local ADMIN_GOOGLE_EMAILS");
  return devAdminCookie(baseUrl, { key, email: wanted, ttlMs });
}
