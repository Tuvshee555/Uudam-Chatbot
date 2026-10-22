import assert from "node:assert/strict";
import test from "node:test";
import { groundedTripIds, ungroundedTripInReply } from "../src/lib/tripGrounding";
import type { TravelTrip } from "../src/lib/travelTypes";

function trip(id: string, route_name: string): TravelTrip {
  return { id, route_name, category: "", operator_name: "Invented", duration_text: "5 өдөр", adult_price: 731_000,
    child_price: null, infant_price: null, currency: "MNT", departure_dates: ["2098-03-17"], seats_total: null,
    seats_left: null, has_food: null, status: "active", notes: "", hotel: "", source_description: "", photo_urls: [],
    extra: {}, created_at: "", updated_at: "" };
}
const a = trip("velmor", "Вэлмор аялал"), b = trip("nerith", "Нерит аялал");
const base = { customerText: "Вэлмор аялал үнэ?", history: [{ role: "user" as const, text: "Нерит аялал үнэ?" }],
  selectionTripId: b.id, routedTripIds: [b.id], trips: [a, b] };

test("current customer identity replaces stale selection, pending and history", () => {
  assert.deepEqual([...groundedTripIds({ ...base, pendingTripIds: [b.id] })], [a.id]);
  for (const reply of [b.route_name, `• ${b.route_name}`, `• ${a.route_name}\n• ${b.route_name}`]) {
    assert.equal(ungroundedTripInReply(reply, base)?.id, b.id);
  }
});

test("router IDs and bullet formatting cannot authorize an arbitrary answer", () => {
  const context = { ...base, customerText: "үнэ?", history: [], selectionTripId: null };
  assert.equal(groundedTripIds(context).size, 0);
  assert.equal(ungroundedTripInReply(`• ${b.route_name}`, context)?.id, b.id);
  assert.equal(ungroundedTripInReply(`${a.route_name}\n${b.route_name}`, context)?.id, a.id);
});

test("only explicit catalog result provenance permits unsolicited alternatives", () => {
  assert.equal(ungroundedTripInReply(`• ${b.route_name}`, { ...base, catalogTripIds: [b.id] }), null);
  assert.equal(ungroundedTripInReply(`• ${b.route_name}`, { ...base, customerText: "аяллын жагсаалт", history: [],
    selectionTripId: null, catalogTripIds: [b.id] }), null);
});
