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
  ADMIN_SECRET: "test-admin-secret",
  ADMIN_OPEN_ACCESS: "false",
  ALLOW_ADMIN_SECRET_QUERY: "false",
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
