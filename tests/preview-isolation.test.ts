import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

/**
 * Until 2026-10-30 Preview deployments carried the production page tokens, Blob token and
 * Redis. Those are now Production-only in Vercel, and the code refuses on its own: a Preview
 * deployment never messages customers and opens no database unless an isolated one is marked.
 */
test("a Preview deployment never sends to Meta unless explicitly allowed", async () => {
  applyTestEnv();
  const { isMetaOutboundDisabled } = await import("../src/lib/metaOutboundKillSwitch");
  const saved = { ...process.env };
  try {
    delete process.env.WEBHOOK_BOT_DISABLED;
    delete process.env.VERCEL_ENV;
    assert.equal(isMetaOutboundDisabled(), false, "production and local: on");
    process.env.VERCEL_ENV = "production";
    assert.equal(isMetaOutboundDisabled(), false);
    process.env.VERCEL_ENV = "preview";
    assert.equal(isMetaOutboundDisabled(), true, "preview: off");
    process.env.PREVIEW_META_OUTBOUND_ALLOWED = "1";
    assert.equal(isMetaOutboundDisabled(), false, "only with an explicit opt-in");
  } finally {
    process.env = saved;
  }
});

test("a Preview deployment opens no database unless an isolated one is marked", async (context) => {
  applyTestEnv({ NEON_DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/preview", VERCEL_ENV: "preview" });
  const { Pool } = await import("pg");
  let queried = 0;
  context.mock.method(Pool.prototype, "query", (async () => { queried += 1; return { rows: [], rowCount: 0 }; }) as never);
  const { queryNeon, isNeonConfigured } = await import("../src/lib/neonDb");
  assert.equal(isNeonConfigured(), true);
  assert.equal(await queryNeon("SELECT 1"), null, "refused in preview");
  assert.equal(queried, 0);
  process.env.PREVIEW_DATABASE_ISOLATED = "1";
  assert.deepEqual(await queryNeon("SELECT 1"), { rows: [], rowCount: 0 }, "an isolated preview database is allowed");
  delete process.env.PREVIEW_DATABASE_ISOLATED;
  const { closeNeonPool } = await import("../src/lib/neonDb");
  await closeNeonPool();
});
