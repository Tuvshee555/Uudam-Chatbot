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

test("production readiness flags missing Redis and observability as critical", async () => {
  const previousVercelEnv = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = "production";
  try {
    const report = await loadReadiness({
      VERCEL_ENV: "production",
      DATABASE_URL: "postgres://user:pass@example.com/db",
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
      report.issues.some((issue) => issue.key === "redis_url"),
      true,
    );
    assert.equal(
      report.issues.some((issue) => issue.key === "redis_flags"),
      true,
    );
    assert.equal(
      report.issues.some((issue) => issue.key === "observability_sink"),
      true,
    );
    assert.equal(report.score < 10, true);
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
      NEON_DATABASE_URL: undefined,
      REDIS_URL: "redis://example.com:6379",
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
