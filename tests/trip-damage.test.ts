/**
 * What breaks a saved trip (2026-11-14: a file reading renamed a live trip and emptied its dates and
 * price rows; it left the website unseen). Invented trips only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { markTripDamage, tripDamage, unacknowledgedDamage } from "../src/lib/tripDamage";
import { applyTestEnv } from "./helpers/env";
import type { AIChangeProposal, AITripAction, TravelTrip } from "../src/lib/travelTypes";

const NOW = new Date("2098-06-01T00:00:00Z");
const trip = (over: Partial<TravelTrip> & { extra?: Record<string, unknown> } = {}): TravelTrip => ({
  id: "t-norvel", route_name: "Норвел хотын 8 шөнө 9 өдрийн аялал", status: "active", category: "Аялал", operator_name: "Туршилт",
  duration_text: "9 өдөр 8 шөнө", adult_price: 2_000_000, child_price: null, infant_price: null, currency: "MNT",
  departure_dates: ["2098-06-10", "2098-06-17", "2098-05-01"], seats_total: null, seats_left: null, has_food: true, notes: "", hotel: "",
  source_description: "", photo_urls: [], created_at: "", updated_at: "2098-05-01T00:00:00Z",
  extra: { price_groups: [{ label: "A" }, { label: "B" }], itinerary_days: Array.from({ length: 9 }, (_, i) => ({ day: i + 1 })) },
  ...over,
} as unknown as TravelTrip);

const kinds = (fields: Record<string, unknown>, before = trip()) => tripDamage(before, fields, NOW).map((item) => item.kind);

test("the changes that break a saved trip are named", () => {
  assert.deepEqual(kinds({ route_name: "Норвел Улун 9 өдрийн аялал" }), ["rename"]);
  assert.deepEqual(kinds({ departure_dates: [] }), ["off_site"]);
  assert.deepEqual(kinds({ departure_dates: ["2098-05-01"] }), ["off_site"], "only past days left");
  assert.deepEqual(kinds({ status: "archived" }), ["off_site"]);
  assert.deepEqual(kinds({ extra: { customer_visible: false } }), ["off_site"]);
  assert.deepEqual(kinds({ extra: { price_groups: [] } }), ["prices_emptied"]);
  assert.deepEqual(kinds({ adult_price: null }), ["prices_emptied"]);
  assert.deepEqual(kinds({ extra: { itinerary_days: [] } }), ["program_cut"]);
  // The real 2026-11-14 save, all at once.
  assert.deepEqual(kinds({ route_name: "Норвел Улун", departure_dates: [], extra: { price_groups: [], itinerary_days: [] } }), ["rename", "off_site", "prices_emptied", "program_cut"]);
});

test("ordinary edits are not damage", () => {
  assert.deepEqual(kinds({ departure_dates: ["2098-06-17"] }), [], "one day removed, one left");
  assert.deepEqual(kinds({ adult_price: 2_100_000 }), []);
  assert.deepEqual(kinds({ route_name: "  норвел хотын 8 шөнө 9 өдрийн аялал " }), [], "case and spaces only");
  assert.deepEqual(kinds({ extra: { itinerary_days: Array.from({ length: 8 }, (_, i) => ({ day: i + 1 })) } }), []);
  assert.deepEqual(kinds({ has_food: false, notes: "x" }), []);
  // Written days ("Пүрэв гариг болгон") count as ahead; a trip with only past days has nothing to lose.
  assert.deepEqual(kinds({ departure_dates: [] }, trip({ departure_dates: ["Пүрэв гариг болгон"] })), ["off_site"]);
  assert.deepEqual(kinds({ departure_dates: [] }, trip({ departure_dates: ["2098-01-01"] })), []);
  assert.deepEqual(kinds({ status: "cancelled" }, trip({ status: "draft" })), [], "a draft is not on the site");
});

test("marks go on patches of saved trips only, and a tick covers exactly its kinds", () => {
  const actions: AITripAction[] = [
    { action: "patch", trip_id: "t-norvel", fields: { departure_dates: [], route_name: "X" } },
    { action: "cancel", trip_id: "t-norvel" },
    { action: "upsert", fields: { route_name: "Шинэ" } },
  ];
  markTripDamage(actions, [trip()], NOW);
  assert.deepEqual(actions[0].damage?.map((item) => item.kind), ["rename", "off_site"]);
  assert.equal(actions[1].damage, undefined, "a cancel says what it does on its own card");
  assert.equal(actions[2].damage, undefined);
  assert.equal(unacknowledgedDamage(actions, [trip()]).length, 1);
  actions[0].acknowledged_damage = ["off_site"];
  assert.match(unacknowledgedDamage(actions, [trip()])[0], /^«Норвел хотын 8 шөнө 9 өдрийн аялал»: Нэр солигдоно/);
  actions[0].acknowledged_damage = ["off_site", "rename"];
  assert.deepEqual(unacknowledgedDamage(actions, [trip()]), []);
});

test("validation marks the damage and keeps the admin's tick", async () => {
  applyTestEnv();
  const { validateAIChangeProposal } = await import("../src/lib/travelAIValidation");
  const proposal = { summary: "", needs_confirmation: true, important_reason: "", conflicts: [], conflict_items: [],
    actions: [{ action: "patch", trip_id: "t-norvel", fields: { departure_dates: [] }, acknowledged_damage: ["off_site", "bogus"] }] } as unknown as AIChangeProposal;
  const checked = validateAIChangeProposal(proposal, [trip()], { now: NOW }).proposal;
  assert.deepEqual(checked.actions[0].damage?.map((item) => item.kind), ["off_site"]);
  assert.deepEqual(checked.actions[0].acknowledged_damage, ["off_site"]);
});

test("the Trips tab lists trips that lost every date this week, not ones whose dates ran out", async () => {
  const { recentlyOffSite } = await import("../src/components/admin/RecentlyOffSiteBanner");
  const now = Date.parse("2098-06-10T00:00:00Z");
  const off = (id: string, reason: string, at: string, status = "archived") => trip({ id, status, extra: { archived_reason: reason, archived_at: at } } as never);
  const found = recentlyOffSite([
    off("a", "no_departure_dates", "2098-06-09T00:00:00Z"),
    off("b", "all_departure_dates_passed", "2098-06-09T00:00:00Z"),
    off("c", "no_departure_dates", "2098-05-20T00:00:00Z"),
    off("d", "no_departure_dates", "2098-06-08T00:00:00Z", "active"),
    off("e", "no_departure_dates", "2098-06-07T00:00:00Z"),
  ] as never, now);
  assert.deepEqual(found.map((entry) => entry.trip.id), ["a", "e"]);
});
