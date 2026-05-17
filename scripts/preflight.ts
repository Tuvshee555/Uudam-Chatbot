async function run() {
  const envModule = await import("../src/lib/env");
  const observabilityModule = await import("../src/lib/observability");
  const redisModule = await import("../src/lib/redisState");

  const env = envModule.getEnv();
  const redisHealthBefore = redisModule.getRedisHealth();
  const getObservabilityDiagnostics = observabilityModule.getObservabilityDiagnostics;

  const redisProbe: { attempted: boolean; ok: boolean; detail: string } = {
    attempted: false,
    ok: true,
    detail: "not_enabled",
  };

  if (env.redisStateEnabled) {
    redisProbe.attempted = true;
    const result = await redisModule.withRedis("preflight.redis_ping", async (redis) => {
      const pong = await redis.ping();
      return pong;
    });

    if (result === null) {
      redisProbe.ok = false;
      redisProbe.detail = "redis_unavailable";
    } else {
      redisProbe.ok = true;
      redisProbe.detail = String(result);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    env: {
      nodeEnv: process.env.NODE_ENV || null,
      vercel: Boolean(process.env.VERCEL),
      redisStateEnabled: env.redisStateEnabled,
      redisRateLimitEnabled: env.redisRateLimitEnabled,
      redisReplayEnabled: env.redisReplayEnabled,
      redisConversationEnabled: env.redisConversationEnabled,
      redisPauseEnabled: env.redisPauseEnabled,
      observabilityLogSinkEnabled: Boolean(env.observabilityLogSinkUrl),
      observabilityErrorSinkEnabled: Boolean(env.observabilityErrorSinkUrl),
    },
    redis: {
      before: redisHealthBefore,
      probe: redisProbe,
      after: redisModule.getRedisHealth(),
    },
    observability: getObservabilityDiagnostics(),
  };

  observabilityModule.logInfo("preflight.completed", report);
  if (!redisProbe.ok) {
    throw new Error("Preflight failed: Redis is enabled but unavailable");
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      event: "preflight.failed",
      message,
    }),
  );
  process.exit(1);
});
