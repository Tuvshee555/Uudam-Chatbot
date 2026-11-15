import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const BASE_ENV = {
  ...process.env,
  OPENAI_API_KEY: "test-openai-key",
  VERIFY_TOKEN: "test-verify-token",
  TOKEN_PAGE: "test-page-token",
  FACEBOOK_PAGE_ID: "1234567890",
  META_APP_SECRET: "test-meta-secret",
  // A complete Google-only admin: a strong session key and Google sign-in for two accounts.
  ADMIN_SESSION_SECRET: "test-session-key-7f3a9c1e5b2d8f40-6a1c9e7b3d5f2a8c",
  ADMIN_API_TOKEN: "",
  GOOGLE_CLIENT_ID: "123-test.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-google-client-secret",
  ADMIN_GOOGLE_EMAILS: "owner.test@example.test,staff.test@example.test",
  ADMIN_SECRET: "",
  TRUST_PROXY_HEADERS: "true",
  DATABASE_URL: "postgres://user:pass@example.com/db",
  NEON_DATABASE_URL: "",
  REDIS_STATE_ENABLED: "false",
  REDIS_RATE_LIMIT_ENABLED: "false",
  REDIS_REPLAY_ENABLED: "false",
  REDIS_CONVERSATION_ENABLED: "false",
  REDIS_PAUSE_ENABLED: "false",
  REDIS_URL: "",
  OBSERVABILITY_LOG_SINK_URL: "",
  OBSERVABILITY_ERROR_SINK_URL: "",
  OBSERVABILITY_SINK_TIMEOUT_MS: "2000",
  OBSERVABILITY_SINK_BATCH_SIZE: "20",
  VERCEL_ENV: "production",
  VERCEL: "1",
  // Readiness warns when the reminder cron secret is missing — a fully
  // configured deployment has it set.
  CRON_SECRET: "test-cron-secret",
};

// This deployment shape is deliberately memory-only (no REDIS_URL), so the
// readiness report carries the single "redis_state" warning and scores 9. What
// matters here is that preflight still EXITS 0 — a warning must never block a
// build, in strict mode or out of it.
test("preflight treats optional production ops sinks as ready by default", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/preflight.ts"],
    {
      cwd: process.cwd(),
      env: { ...BASE_ENV, STRICT_PREFLIGHT: "" },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /"score":9/);
  assert.match(result.stdout, /"key":"redis_state","message"/);
});

test("preflight strict mode does not require optional production ops sinks", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/preflight.ts"],
    {
      cwd: process.cwd(),
      env: { ...BASE_ENV, STRICT_PREFLIGHT: "true" },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /"score":9/);
  assert.match(result.stdout, /"key":"redis_state","message"/);
});

// Admin sign-in is Google only: a weak signing key or missing Google setup means nobody can
// (safely) get in, so strict preflight stops the deploy and names the reason.
test("preflight strict mode fails on a weak session key or missing Google sign-in", () => {
  const run = (overrides: Record<string, string>) => spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/preflight.ts"],
    { cwd: process.cwd(), env: { ...BASE_ENV, STRICT_PREFLIGHT: "true", ...overrides }, encoding: "utf8" },
  );
  const weak = run({ ADMIN_SESSION_SECRET: "admin" });
  assert.equal(weak.status, 1);
  assert.match(weak.stderr, /admin_session_secret_weak/);
  const noGoogle = run({ GOOGLE_CLIENT_SECRET: "" });
  assert.equal(noGoogle.status, 1);
  assert.match(noGoogle.stderr, /admin_google_sign_in_off/);
  const weakToken = run({ ADMIN_API_TOKEN: "short-token" });
  assert.equal(weakToken.status, 1);
  assert.match(weakToken.stderr, /admin_api_token_weak/);
});

// At runtime a missing session key only turns the admin off (the bot keeps answering), so the
// PRODUCTION build is what stops — strict mode or not — and the live deployment keeps serving.
// Vercel's shape before the key is added: the retired ADMIN_SECRET still set, no session key.
test("a production build without a strong ADMIN_SESSION_SECRET fails even outside strict mode", () => {
  const run = (overrides: Record<string, string>) => spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/preflight.ts"],
    { cwd: process.cwd(), env: { ...BASE_ENV, STRICT_PREFLIGHT: "", ADMIN_SECRET: "old-value-still-in-vercel", ...overrides }, encoding: "utf8" },
  );
  const missing = run({ ADMIN_SESSION_SECRET: "" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /admin_session_secret_weak/);
  assert.match(missing.stderr, /not set/);
  assert.doesNotMatch(missing.stdout + missing.stderr, /preflight\.env_incomplete/, "env still loads without the key");
  const weak = run({ ADMIN_SESSION_SECRET: "admin" });
  assert.equal(weak.status, 1);
  assert.match(weak.stderr, /too weak/);
  // A preview build only warns: it carries the critical readiness issue but still exits 0.
  const preview = run({ ADMIN_SESSION_SECRET: "", VERCEL_ENV: "preview" });
  assert.equal(preview.status, 0);
  assert.match(preview.stdout, /admin_session_secret_weak/);
});
