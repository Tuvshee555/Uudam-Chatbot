import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

async function loadReadiness(overrides: Record<string, string | undefined>) {
  applyTestEnv(overrides);
  const envModule = await import("../src/lib/env");
  envModule.resetEnvCacheForTests();
  const readinessModule = await import("../src/lib/readiness");
  return readinessModule.getReadinessReport(envModule.getEnv());
}

test("production readiness warns about memory-only state but never requires Redis", async () => {
  const previousVercelEnv = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = "production";
  try {
    const report = await loadReadiness({
      VERCEL_ENV: "production",
      DATABASE_URL: "postgres://user:pass@example.com/db",
      CRON_SECRET: "test-cron-secret",
      NEON_DATABASE_URL: undefined,
      OBSERVABILITY_LOG_SINK_URL: undefined,
      OBSERVABILITY_ERROR_SINK_URL: "https://errors.example.com",
      REDIS_URL: undefined,
      REDIS_STATE_ENABLED: "false",
      REDIS_RATE_LIMIT_ENABLED: "false",
      REDIS_REPLAY_ENABLED: "false",
      REDIS_CONVERSATION_ENABLED: "false",
      REDIS_PAUSE_ENABLED: "false",
    });

    assert.equal(report.production, true);
    // Redis is still optional: nothing here is critical, so STRICT_PREFLIGHT
    // will not block a deliberately single-instance deployment.
    assert.equal(
      report.issues.some((issue) => issue.severity === "critical"),
      false,
    );
    // ...but running webhook dedup / pause / rate limits on per-instance memory
    // is a real degradation on Vercel, so it has to be visible.
    const redisIssue = report.issues.find((issue) => issue.key === "redis_state");
    assert.ok(redisIssue, "memory-only production state must be reported");
    assert.equal(redisIssue!.severity, "warning");
    assert.match(redisIssue!.message, /webhook replay protection/);
    assert.equal(report.issues.length, 1);
    assert.equal(report.score, 9);
  } finally {
    if (previousVercelEnv == null) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previousVercelEnv;
  }
});

test("production readiness does not require developer alert sink", async () => {
  const previousVercelEnv = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = "production";
  try {
    const report = await loadReadiness({
      VERCEL_ENV: "production",
      DATABASE_URL: "postgres://user:pass@example.com/db",
      CRON_SECRET: "test-cron-secret",
      NEON_DATABASE_URL: undefined,
      OBSERVABILITY_LOG_SINK_URL: undefined,
      OBSERVABILITY_ERROR_SINK_URL: undefined,
      REDIS_URL: undefined,
      REDIS_STATE_ENABLED: "false",
      REDIS_RATE_LIMIT_ENABLED: "false",
      REDIS_REPLAY_ENABLED: "false",
      REDIS_CONVERSATION_ENABLED: "false",
      REDIS_PAUSE_ENABLED: "false",
    });

    assert.equal(report.production, true);
    assert.equal(
      report.issues.some((issue) => issue.key === "observability_sink"),
      false,
    );
    assert.equal(
      report.issues.some((issue) => issue.severity === "critical"),
      false,
    );
    // The only outstanding issue is the memory-only state warning.
    assert.deepEqual(
      report.issues.map((issue) => issue.key),
      ["redis_state"],
    );
    assert.equal(report.score, 9);
  } finally {
    if (previousVercelEnv == null) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previousVercelEnv;
  }
});

test("production readiness reaches 10 when critical hardening is configured", async () => {
  const previousVercelEnv = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = "production";
  try {
    const report = await loadReadiness({
      VERCEL_ENV: "production",
      DATABASE_URL: "postgres://user:pass@example.com/db",
      CRON_SECRET: "test-cron-secret",
      NEON_DATABASE_URL: undefined,
      REDIS_URL: "rediss://default:token@redis.example.com:6379",
      REDIS_STATE_ENABLED: "true",
      REDIS_RATE_LIMIT_ENABLED: "true",
      REDIS_REPLAY_ENABLED: "true",
      REDIS_CONVERSATION_ENABLED: "true",
      REDIS_PAUSE_ENABLED: "true",
      OBSERVABILITY_LOG_SINK_URL: "https://logs.example.com",
      OBSERVABILITY_ERROR_SINK_URL: "https://errors.example.com",
    });

    assert.equal(report.production, true);
    assert.equal(report.score, 10);
    assert.equal(report.issues.length, 0);
  } finally {
    if (previousVercelEnv == null) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previousVercelEnv;
  }
});

async function productionReport(overrides: Record<string, string | undefined>) {
  const previousVercelEnv = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = "production";
  try {
    return await loadReadiness({
      VERCEL_ENV: "production",
      DATABASE_URL: "postgres://user:pass@example.com/db",
      CRON_SECRET: "test-cron-secret",
      REDIS_URL: "rediss://default:token@redis.example.com:6379",
      REDIS_STATE_ENABLED: "true",
      REDIS_RATE_LIMIT_ENABLED: "true",
      REDIS_REPLAY_ENABLED: "true",
      REDIS_CONVERSATION_ENABLED: "true",
      REDIS_PAUSE_ENABLED: "true",
      ...overrides,
    });
  } finally {
    if (previousVercelEnv == null) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previousVercelEnv;
  }
}

test("a weak session signing key is critical (admin sign-in is off until it is replaced)", async () => {
  for (const weak of ["admin", "short-session-key", "admin".repeat(8)]) {
    const report = await productionReport({ ADMIN_SESSION_SECRET: weak });
    const issue = report.issues.find((item) => item.key === "admin_session_secret_weak");
    assert.equal(issue?.severity, "critical", weak.slice(0, 6));
    assert.match(issue!.message, /ADMIN_SESSION_SECRET/);
  }
});

test("missing Google sign-in is critical in production; one allowed account is a warning", async () => {
  const off = await productionReport({ GOOGLE_CLIENT_ID: undefined });
  assert.equal(off.issues.find((item) => item.key === "admin_google_sign_in_off")?.severity, "critical");
  const single = await productionReport({ ADMIN_GOOGLE_EMAILS: "owner.test@example.test" });
  assert.deepEqual(single.issues.map((item) => [item.key, item.severity]), [["admin_google_single_account", "warning"]]);
  assert.equal(single.score, 9);
});

test("ADMIN_API_TOKEN is checked only when set: short or equal to the session key is critical", async () => {
  assert.equal((await productionReport({ ADMIN_API_TOKEN: undefined })).issues.length, 0);
  const short = await productionReport({ ADMIN_API_TOKEN: "short-token" });
  assert.equal(short.issues.find((item) => item.key === "admin_api_token_weak")?.severity, "critical");
  const { TEST_ADMIN_SESSION_SECRET } = await import("./helpers/env");
  const reused = await productionReport({ ADMIN_API_TOKEN: TEST_ADMIN_SESSION_SECRET });
  assert.equal(reused.issues.find((item) => item.key === "admin_api_token_weak")?.severity, "critical");
});

test("the retired admin_secret_* checks are gone", async () => {
  const report = await productionReport({ ADMIN_SECRET: "admin", ALLOW_ADMIN_SECRET_QUERY: "true", ADMIN_OPEN_ACCESS: "true" });
  assert.deepEqual(report.issues, []);
  assert.equal(report.score, 10);
});
