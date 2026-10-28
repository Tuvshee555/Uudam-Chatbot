import test from "node:test";
import assert from "node:assert/strict";
import { syncIsComplete, tripwire } from "../src/lib/partnerSync/run";
import { prices, row, tour } from "./fixtures/partner-tour";

test("valid source repricing and removals mirror automatically regardless of magnitude", () => {
  assert.equal(tripwire(tour(), tour([row(undefined, undefined, { prices: prices({ adult: 17000000 }) })])), null);
});
test("invalid and incomplete source structures cannot overwrite the live catalog", () => {
  assert.ok(tripwire(null, tour([])));
  assert.ok(tripwire(null, tour([row("2099-02-30")])));
  assert.ok(tripwire(null, tour([row(), row()])));
  assert.ok(tripwire(null, tour([row(undefined, undefined, { prices: prices({ infant: -1 }) })])));
});
test("unchanged source retries until the website delivery has completed", () => {
  const pending = { partner_sync: { content_hash: "sample-hash", status: "pending" } };
  const complete = { partner_sync: { content_hash: "sample-hash", status: "complete" } };
  assert.equal(syncIsComplete(pending, tour(), true), false);
  assert.equal(syncIsComplete(complete, tour(), false), false);
  assert.equal(syncIsComplete(complete, tour(), true), true);
  assert.equal(syncIsComplete(complete, { ...tour(), contentHash: "next" }, true), false);
});
