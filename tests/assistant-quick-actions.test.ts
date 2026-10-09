import assert from "node:assert/strict";
import test from "node:test";
import { buildQuickProposal } from "../src/lib/assistantQuickActions";
import type { TravelTrip } from "../src/lib/travelTypes";

function trip(fields: Partial<TravelTrip> = {}): TravelTrip {
  return {
    id: "t-1", category: "Аялал", operator_name: "", route_name: "Туршилтын аялал", duration_text: "5 өдөр 4 шөнө",
    adult_price: 1_000_000, child_price: 800_000, infant_price: null, currency: "MNT", departure_dates: [],
    seats_total: 20, seats_left: 12, has_food: true, status: "active", notes: "", hotel: "", source_description: "",
    photo_urls: [], extra: {}, created_at: "", updated_at: "", ...fields,
  };
}

test("cancelling builds an exact cancel of the chosen trip, and asks for confirmation", () => {
  const built = buildQuickProposal(trip(), { kind: "cancel", trip_id: "t-1" });
  assert.ok(built.ok);
  if (!built.ok) return;
  assert.deepEqual(built.proposal.actions, [{ action: "cancel", trip_id: "t-1" }]);
  assert.equal(built.proposal.needs_confirmation, true);
  assert.match(built.proposal.summary, /Туршилтын аялал/);
});

test("an already cancelled trip is not cancelled twice", () => {
  const built = buildQuickProposal(trip({ status: "cancelled" }), { kind: "cancel", trip_id: "t-1" });
  assert.equal(built.ok, false);
});

test("seats set exactly the number given, and reject anything that is not a whole number of seats", () => {
  const ok = buildQuickProposal(trip(), { kind: "seats", trip_id: "t-1", value: 5 });
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.deepEqual(ok.proposal.actions, [{ action: "patch", trip_id: "t-1", fields: { seats_left: 5 } }]);
    assert.match(ok.proposal.summary, /12 → 5/);
  }
  for (const value of [-1, 2.5, 1001, Number.NaN, "5" as unknown as number, undefined]) {
    assert.equal(buildQuickProposal(trip(), { kind: "seats", trip_id: "t-1", value }).ok, false, String(value));
  }
  const zero = buildQuickProposal(trip(), { kind: "seats", trip_id: "t-1", value: 0 });
  assert.ok(zero.ok && /дүүрсэн/.test(zero.proposal.important_reason));
});

test("meals are set from an explicit yes or no only", () => {
  const off = buildQuickProposal(trip(), { kind: "food", trip_id: "t-1", value: false });
  assert.ok(off.ok);
  if (off.ok) assert.deepEqual(off.proposal.actions, [{ action: "patch", trip_id: "t-1", fields: { has_food: false } }]);
  assert.equal(buildQuickProposal(trip(), { kind: "food", trip_id: "t-1" }).ok, false);
});

test("an unknown action is refused", () => {
  assert.equal(buildQuickProposal(trip(), { kind: "delete" as never, trip_id: "t-1" }).ok, false);
});
