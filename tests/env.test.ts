import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

async function loadEnvModule() {
  const envModule = await import("../src/lib/env");
  envModule.resetEnvCacheForTests();
  return envModule;
}

test("env validation accepts valid configuration", async () => {
  applyTestEnv();
  const envModule = await loadEnvModule();
  const env = envModule.getEnv();
  assert.equal(env.demoMaxTextChars, 1000);
  assert.equal(env.geminiMaxRetries, 1);
  assert.equal(env.webhookMaxBodyBytes, 1048576);
  assert.equal(env.adminOpenAccess, false);
  assert.equal(env.googleDriveSyncEnabled, false);
  assert.equal(env.googleDriveSyncIntervalMinutes, 30);
});

test("env validation rejects open admin access in production", async () => {
  applyTestEnv({
    ADMIN_OPEN_ACCESS: "true",
    NODE_ENV: "production",
  });
  const envModule = await loadEnvModule();
  assert.throws(
    () => envModule.getEnv(),
    /ADMIN_OPEN_ACCESS cannot be true in production/i,
  );
});

test("env validation rejects NaN values", async () => {
  applyTestEnv({ DEMO_GLOBAL_RATE_LIMIT: "NaN" });
  const envModule = await loadEnvModule();
  assert.throws(
    () => envModule.getEnv(),
    /DEMO_GLOBAL_RATE_LIMIT must be an integer/,
  );
});

test("env validation rejects negative/too-small values", async () => {
  applyTestEnv({ WEBHOOK_MAX_BODY_BYTES: "-1" });
  const envModule = await loadEnvModule();
  assert.throws(
    () => envModule.getEnv(),
    /WEBHOOK_MAX_BODY_BYTES must be >= 65536/,
  );
});

test("env validation rejects empty required secrets", async () => {
  applyTestEnv({ ADMIN_SECRET: "   " });
  const envModule = await loadEnvModule();
  assert.throws(
    () => envModule.getEnv(),
    /ADMIN_SECRET is required and must be a non-empty string/,
  );
});

test("env validation requires REDIS_URL when redis state flags are enabled", async () => {
  applyTestEnv({
    REDIS_STATE_ENABLED: "true",
    REDIS_RATE_LIMIT_ENABLED: "true",
    REDIS_URL: undefined,
  });
  const envModule = await loadEnvModule();
  assert.throws(
    () => envModule.getEnv(),
    /REDIS_URL is required when any REDIS_\*_ENABLED feature flag is true/,
  );
});

test("env validation requires full Google Drive sync credentials when enabled", async () => {
  applyTestEnv({
    GOOGLE_DRIVE_SYNC_ENABLED: "true",
    GOOGLE_DRIVE_FOLDER_ID: "folder-123",
    GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL: undefined,
    GOOGLE_DRIVE_PRIVATE_KEY: undefined,
  });
  const envModule = await loadEnvModule();
  assert.throws(
    () => envModule.getEnv(),
    /GOOGLE_DRIVE_SYNC_ENABLED requires GOOGLE_DRIVE_FOLDER_ID, GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL, and GOOGLE_DRIVE_PRIVATE_KEY/i,
  );
});
