import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

test("an unconfigured database cannot count as a completed staff handoff", async () => {
  applyTestEnv();
  const { ensureDurableLead } = await import("../src/lib/durableLead");
  await assert.rejects(ensureDurableLead({ kind: "handoff", platform: "facebook", senderId: "no-database-customer",
    customerMessage: "Вэлмор аялал нэмэлт мэдээлэл" }), /lead_persistence_failed:handoff/);
});
