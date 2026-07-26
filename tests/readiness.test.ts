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
