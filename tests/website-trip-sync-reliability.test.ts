import assert from "node:assert/strict";
import test from "node:test";
import { sameConflict, websiteTripPatch, websiteTripPatchReport, websiteTripToCanonicalFields, withBaseFreeFareRule } from "../src/lib/websiteTripBridge";
import { isDocumentedFreeFare } from "../src/lib/travelFastPathsSearch";
import type { TravelTrip } from "../src/lib/travelTypes";

const website = () => ({
  sourceTripId: "orvel-canonical", title: "Орвел хотын аялал", description: "Тайлбар", summary: "",
  durationDays: 5, durationNights: 4, currency: "MNT", price: 2_345_678, childPrice: 1_765_432, infantPrice: null as number | null,
  image: "https://example.com/orvel-cover.webp", extraImages: [], included: [], excluded: [], importantNotes: [], departureRule: "",
  hotel: "", foodIncluded: false, isPublished: true, itinerary: [],
  departures: [
    { id: "orvel-1", startDate: "2098-04-02T00:00:00.000Z", status: "OPEN", seatsLeft: 9, price: 2_345_678 },
    { id: "orvel-2", startDate: "2098-04-09T00:00:00.000Z", status: "OPEN", seatsLeft: 9, price: 2_345_678 },
  ],
  sourceMetadata: {} as Record<string, unknown>,
});
function canonical(input = website()) {
  return { id: input.sourceTripId, status: "active", ...websiteTripToCanonicalFields(input).fields };
}

test("B2: a title the chatbot renamed and staff renamed back is dropped against a stale baseline, and reported", () => {
  // The website queued an earlier edit (title "Орвел хотын аялал") that was never delivered.
  // The chatbot then renamed the trip "… 2" and the projection showed that name on the website.
  // Staff removed the "2" again; the delivery still compared against the stale baseline.
  const stale = website();
  const current = { ...canonical(stale), route_name: "Орвел хотын аялал 2" };
  const edit = { ...stale, title: "Орвел хотын аялал" };
  const report = websiteTripPatchReport(edit, stale, current, ["title"]);
  assert.equal(report.fields.route_name, undefined, "the stale baseline hides the edit");
  assert.deepEqual(report.ignored, [{ field: "title", reason: "not_applied" }], "the dropped field is reported, not read as success");
});

test("B2: with the value staff actually saw as the baseline, the rename back is applied", () => {
  const seen = { ...website(), title: "Орвел хотын аялал 2" };
  const current = { ...canonical(seen), route_name: "Орвел хотын аялал 2" };
  const report = websiteTripPatchReport({ ...seen, title: "Орвел хотын аялал" }, seen, current, ["title"]);
  assert.equal(report.fields.route_name, "Орвел хотын аялал");
  assert.deepEqual(report.applied, ["route_name"]);
  assert.deepEqual(report.ignored, []);
});

test("B3: a website infant fare of 0 reaches the chatbot as a documented free fare", () => {
  const old = website();
  const current = canonical(old);
  const patch = websiteTripPatch({ ...old, infantPrice: 0 }, old, current);
  assert.equal(patch.infant_price, 0);
  const rules = patch.extra?.child_rules as Array<Record<string, unknown>>;
  assert.deepEqual(rules, [{ label: "Нярай", age_range: "", price: 0, currency: "MNT", note: "Үнэгүй" }]);
  const trip = { ...current, ...patch, extra: { ...current.extra, ...patch.extra } } as unknown as TravelTrip;
  assert.equal(isDocumentedFreeFare(trip, "infant"), true);
  assert.equal(isDocumentedFreeFare(trip, "child"), false);
});

test("B3: zero stays distinct from unknown in both directions", () => {
  const free = canonical({ ...website(), infantPrice: 0 });
  assert.equal(free.infant_price, 0);
  // An adult 0 is the website's "Үнэ лавлах", never a free trip.
  assert.equal(canonical({ ...website(), price: 0 }).adult_price, null);
  // Clearing the infant fare removes the free rule instead of keeping "free".
  const withRule = { ...free, extra: { ...free.extra, child_rules: withBaseFreeFareRule([], "infant", true) } };
  const patch = websiteTripPatch({ ...website(), infantPrice: null }, { ...website(), infantPrice: 0 }, withRule);
  assert.equal(patch.infant_price, null);
  assert.deepEqual(patch.extra?.child_rules, []);
});

test("B3: a 1-999₮ fare is reported instead of silently dropped", () => {
  const old = website();
  const report = websiteTripPatchReport({ ...old, childPrice: 500 }, old, canonical(old), ["childPrice"]);
  assert.deepEqual(report.ignored, [{ field: "childPrice", reason: "fare_below_1000" }]);
});

test("departure availability is the website's: no conflict even after the chatbot changed it", () => {
  const old = website();
  const current = canonical(old);
  current.extra = { ...current.extra, website_departure_availability: [{ date: "2098-04-02", status: "ALMOST_FULL", seatsLeft: 2 }, { date: "2098-04-09", status: "OPEN", seatsLeft: 9 }] };
  const edit = { ...old, departures: [{ ...old.departures[0], status: "SOLD_OUT", seatsLeft: 0 }, old.departures[1]] };
  const report = websiteTripPatchReport(edit, old, current, ["departures"]);
  assert.deepEqual(report.conflicts, []);
  assert.deepEqual(report.fields.extra?.website_departure_availability, [{ date: "2098-04-02", status: "SOLD_OUT", seatsLeft: 0 }, { date: "2098-04-09", status: "OPEN", seatsLeft: 9 }]);
});

test("conflicts carry the time they were recorded and are not repeated on later saves", () => {
  const old = website();
  const current = { ...canonical(old), notes: "Chatbot-ын өөрчилсөн тайлбар" };
  const edit = { ...old, description: "Вебсайтын өөрчилсөн тайлбар" };
  const first = websiteTripPatchReport(edit, old, current, ["description"]);
  assert.equal(first.conflicts.length, 1);
  assert.match(String(first.conflicts[0].at), /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(first.ignored, []);
  const saved = { ...current, extra: { ...current.extra, shared_conflicts: first.fields.extra?.shared_conflicts } };
  const again = websiteTripPatchReport(edit, old, saved, ["description"]);
  assert.equal(again.conflicts.length, 0);
  assert.deepEqual(again.ignored, [{ field: "description", reason: "open_conflict" }]);
  assert.equal(sameConflict({ ...first.conflicts[0], at: "2000-01-01T00:00:00.000Z" }, first.conflicts[0]), true);
});

test("a description edit on a trip showing its poster subtitle applies instead of conflicting", () => {
  const subtitle = "Халуун рашаант амралт, усан парк";
  const shown = { ...website(), description: subtitle, sourceMetadata: { connectedSource: { id: "orvel-canonical", poster: { subtitle } } } };
  const current = { ...canonical(shown), notes: "" };
  const report = websiteTripPatchReport({ ...shown, description: "Шинэ тайлбар" }, shown, current, ["description"]);
  assert.equal(report.fields.notes, "Шинэ тайлбар");
  assert.deepEqual(report.conflicts, []);
  // Unchanged, it is not mistaken for an edit of the empty notes.
  assert.deepEqual(websiteTripPatchReport(shown, shown, current, []).fields, {});
});
