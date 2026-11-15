import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

applyTestEnv();

test("the AI outage banner stops once a production model call succeeded after the outage", async () => {
  const { aiRecoveredAfter } = await import("../src/lib/adminAnalytics");
  assert.equal(aiRecoveredAfter("2098-01-01T09:00:00Z", "2098-01-01T09:30:00Z"), true, "credits topped up, bot answering again");
  assert.equal(aiRecoveredAfter("2098-01-01T09:00:00Z", "2098-01-01T08:00:00Z"), false, "nothing has worked since the outage");
  assert.equal(aiRecoveredAfter(new Date("2098-01-01T09:00:00Z"), new Date("2098-01-01T10:00:00Z")), true, "pg Date values");
  assert.equal(aiRecoveredAfter("2098-01-01T09:00:00Z", null), false);
  assert.equal(aiRecoveredAfter(null, "2098-01-01T09:00:00Z"), false);
});

test("a local admin without the private store token shows no critical storage issue; a deployment does", async () => {
  const { getOperationalIssues } = await import("../src/lib/aiHealth");
  const savedVercel = process.env.VERCEL;
  const savedToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    delete process.env.VERCEL;
    const local = await getOperationalIssues();
    assert.ok(!local.some((issue) => issue.key === "customer_image_storage"), "local: no false alarm");
    process.env.VERCEL = "1";
    const deployed = await getOperationalIssues();
    assert.ok(deployed.some((issue) => issue.key === "customer_image_storage" && issue.severity === "critical"), "deployed: a missing store is critical");
  } finally {
    if (savedVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = savedVercel;
    if (savedToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN; else process.env.BLOB_READ_WRITE_TOKEN = savedToken;
  }
});
