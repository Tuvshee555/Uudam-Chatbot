import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";
import { adminCookieHeaders } from "./helpers/adminAuth";
import { normalizeExtra, normalizeExtraPatch } from "../src/lib/tripExtraSchema";
import { parseTripsJson, planJsonEditorSave, stableStringify } from "../src/lib/jsonEditorPlan";

// Invented catalogue rows only.
const baselineTrip = {
  id: "trip-velmor", route_name: "Вэлмор нуурын аялал", adult_price: 1_200_000, child_price: 900_000,
  infant_price: null, departure_dates: ["2027-06-12", "2027-07-03"], status: "active",
  aliases: ["Вэлмор"], price_groups: [{ dates: ["2027-06-12"], adult_price: 1_200_000 }],
};

test("a trip's extra never stores the admin list's display-only values", () => {
  // The trips list adds website_sync and poster_photo_count to every trip it returns;
  // echoing a trip back (the old hide/show toggle) used to write them into the row.
  const patch = normalizeExtraPatch({ customer_visible: false, website_sync: { synced: true }, poster_photo_count: 4 });
  assert.deepEqual(patch, { customer_visible: false });
  const full = normalizeExtra({ aliases: ["Вэлмор"], website_sync: { synced: true }, poster_photo_count: 4, custom_note: "kept" }).extra;
  assert.equal("website_sync" in full, false);
  assert.equal("poster_photo_count" in full, false);
  assert.equal(full.custom_note, "kept", "genuine unknown keys still pass through");
});

test("the admin list's slim trip rows keep every fact the list shows and flag completeness the same", async () => {
  const { tripListProjection, isTripListProjection } = await import("../src/lib/tripListProjection");
  const { findTripGaps, tripCompletenessInput } = await import("../src/lib/tripCompleteness");
  const full = {
    id: "trip-velmor", category: "Аялал", operator_name: "", route_name: "Вэлмор нуурын аялал", duration_text: "5 өдөр",
    adult_price: 1_200_000, child_price: null, infant_price: null, currency: "MNT", departure_dates: ["2027-06-12"],
    seats_total: null, seats_left: null, has_food: true, status: "active", notes: "", hotel: "", source_description: "",
    photo_urls: [], created_at: "", updated_at: "2027-01-01T00:00:00.000Z",
    extra: {
      poster_trip_id: "poster-velmor", price_groups: [{ dates: ["2027-06-12"], adult_price: 1_200_000 }],
      itinerary_days: [{ day: 1, title: "Өдөр 1", text: "x".repeat(4000) }, { day: 2, title: "Өдөр 2", text: "y".repeat(4000) }],
      website_details: { description: "z".repeat(20000) }, shared_conflicts: [{ field: "x" }], photo_credits: [{ url: "https://example.com/a.jpg" }],
      customer_visible: true, departure_dates_resolved: [{ text: "2027-06-12", ymd: "2027-06-12" }],
    },
  } as never;
  const slim = tripListProjection(full);
  const extra = slim.extra as Record<string, unknown>;
  assert.equal("website_details" in extra, false);
  assert.equal("shared_conflicts" in extra, false);
  assert.equal("photo_credits" in extra, false);
  assert.deepEqual(extra.itinerary_days, [{}, {}], "the day count stays, the text goes");
  assert.equal(extra.poster_trip_id, "poster-velmor");
  assert.ok(Array.isArray(extra.price_groups) && extra.departure_dates_resolved);
  assert.equal(isTripListProjection(slim), true);
  assert.equal(isTripListProjection(full), false);
  assert.deepEqual(findTripGaps(tripCompletenessInput(slim)), findTripGaps(tripCompletenessInput(full)));
  assert.ok(JSON.stringify(slim).length < JSON.stringify(full).length / 5);
  assert.deepEqual(normalizeExtraPatch({ list_projection: true, aliases: ["x"] }), { aliases: ["x"] },
    "a slim row's marker can never be saved");
});

test("a settings save sends only what this person changed since the form loaded", async () => {
  const { changedSettingsFields, settingsToForm } = await import("../src/lib/adminPageUtils");
  const loaded = {
    business_name: "Вэлмор Трэвэл", system_prompt: "Эелдэг хариул.", quick_info_reply: "Сайн байна уу",
    quick_info_keywords: ["үнэ"], comment_trigger_patterns: [], comment_public_reply: "", comment_dm_reply: "",
    special_offers: [], discount_policies: [], verified_credentials: [], faq: [{ question: "Виз?", answer: "Хэрэггүй" }],
    handoff_enabled: true, handoff_keywords: ["хүн"], handoff_reply: "Зөвлөх холбогдоно.", handoff_pause_minutes: 60,
    chat_buttons: [], extra: {}, updated_at: "2027-01-01T00:00:00.000Z",
  } as never;
  const form = settingsToForm(loaded);
  assert.deepEqual(changedSettingsFields(loaded, form), {}, "an untouched form changes nothing");
  // Someone else meanwhile changed the FAQ; this person only edits the handoff reply.
  const edited = { ...form, handoff_reply: "Манай зөвлөх удахгүй холбогдоно." };
  assert.deepEqual(changedSettingsFields(loaded, edited), { handoff_reply: "Манай зөвлөх удахгүй холбогдоно." },
    "the stale FAQ in this form is not sent back");
  assert.ok(Object.keys(changedSettingsFields(null, form)).length > 10, "without a baseline every field is sent");
});

test("hiding a trip patches only the visibility flag", () => {
  assert.deepEqual(Object.keys(normalizeExtraPatch({ customer_visible: true })), ["customer_visible"]);
});

test("the JSON editor sends only trips and fields that changed, with before and after", () => {
  const baseline = new Map([[baselineTrip.id, baselineTrip]]);
  const unchanged = { ...baselineTrip, aliases: [...baselineTrip.aliases] };
  // Same values, keys in another order (ChatGPT reorders freely): not a change.
  const reordered = Object.fromEntries(Object.entries(baselineTrip).reverse());
  assert.equal(planJsonEditorSave([unchanged], baseline).unchanged, 1);
  assert.equal(planJsonEditorSave([reordered], baseline).updates.length, 0);

  const edited = { ...baselineTrip, adult_price: 1_350_000, aliases: ["Вэлмор", "Velmor"] };
  const plan = planJsonEditorSave([edited], baseline);
  assert.equal(plan.updates.length, 1);
  assert.deepEqual(plan.updates[0].patch, { id: "trip-velmor", adult_price: 1_350_000, aliases: ["Вэлмор", "Velmor"] },
    "untouched fields are not sent, so they cannot overwrite newer values");
  const price = plan.updates[0].changes.find((change) => change.field === "adult_price");
  assert.ok(price?.before?.includes("1") && price.after?.includes("350"), "a price change shows before and after");
});

test("a dropped field is left alone; unknown ids, duplicates and unnamed new trips are refused", () => {
  const baseline = new Map([[baselineTrip.id, baselineTrip]]);
  const withoutDates: Record<string, unknown> = { ...baselineTrip };
  delete withoutDates.departure_dates;
  const plan = planJsonEditorSave([
    withoutDates,
    { id: "trip-from-an-old-file", route_name: "Хуучин файл" },
    { ...baselineTrip, adult_price: 1 },
    { route_name: "Шинэ туршилтын аялал" },
    { notes: "no id, no name" },
    { ...baselineTrip, magic_field: true },
  ], baseline);
  assert.equal(plan.updates.length, 0, "the first copy is unchanged, the later copies of the same id are refused");
  assert.equal(plan.unchanged, 1);
  assert.equal(plan.creates.length, 1);
  assert.deepEqual(plan.blocked.map((entry) => entry.name), ["Хуучин файл", "Вэлмор нуурын аялал", "(нэргүй)", "Вэлмор нуурын аялал"]);
  assert.deepEqual(plan.ignoredFields, ["magic_field"]);
});

test("pasted text is accepted as an array or a { trips } wrapper and rejected otherwise", () => {
  assert.deepEqual(parseTripsJson("[]"), { trips: [] });
  assert.deepEqual(parseTripsJson('{"trips":[{"id":"a"}]}'), { trips: [{ id: "a" }] });
  assert.ok("error" in parseTripsJson("{\"id\":1}"));
  assert.ok("error" in parseTripsJson("```json\n[]\n```"));
  assert.equal(stableStringify({ b: 1, a: [1, { d: 2, c: 3 }] }), stableStringify({ a: [1, { c: 3, d: 2 }], b: 1 }));
});

// Server modules read the environment once, when first imported: every test that loads
// one uses the same fixture database URL (never reached; queries are mocked or absent).
const FIXTURE_DB = { NEON_DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/admin-safety-fixture", BOOKING_DATABASE_URL: undefined };

test("bulk JSON fields: absent keys stay unchanged, null clears, bad values are refused", async () => {
  applyTestEnv(FIXTURE_DB);
  const { bulkTripFields } = await import("../src/pages/api/admin/trips-bulk");
  assert.deepEqual(bulkTripFields({ id: "x", aliases: ["Вэлмор"] }, false), { extra: { aliases: ["Вэлмор"] } },
    "a trip missing departure_dates no longer empties its schedule");
  assert.deepEqual(bulkTripFields({ id: "x", adult_price: "1 350 000", child_price: null }, false),
    { adult_price: 1_350_000, child_price: null });
  assert.throws(() => bulkTripFields({ id: "x", adult_price: "about a million" }, false), /adult_price/);
  assert.throws(() => bulkTripFields({ id: "x", status: "published" }, false), /status/);
  assert.throws(() => bulkTripFields({ id: "x", departure_dates: "2027-06-12" }, false), /departure_dates/);
  assert.throws(() => bulkTripFields({ id: "x", route_name: "  " }, false), /route_name/);
  const created = bulkTripFields({ route_name: "Шинэ туршилтын аялал" }, true);
  assert.equal(created.status, "draft", "a new trip from pasted JSON is not published unless it says so");
  assert.throws(() => bulkTripFields({ notes: "x" }, true), /route_name/);
});

test("trips API refuses an unscoped archive-all and archives only the ids it is given", async (context) => {
  applyTestEnv(FIXTURE_DB);
  const { Pool } = await import("pg");
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const query = async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    return { rows: [], rowCount: 0 };
  };
  context.mock.method(Pool.prototype, "query", query as unknown as typeof Pool.prototype.query);
  context.mock.method(Pool.prototype, "connect", (async () => ({ query, release() {} })) as unknown as typeof Pool.prototype.connect);
  const { default: handler } = await import("../src/pages/api/admin/trips");
  const { closeNeonPool } = await import("../src/lib/neonDb");
  async function call(query: Record<string, string>, body?: unknown) {
    const response = { statusCode: 200, body: {} as Record<string, unknown>, headers: {} as Record<string, unknown>,
      setHeader(name: string, value: unknown) { this.headers[name] = value; },
      status(code: number) { this.statusCode = code; return this; },
      json(value: Record<string, unknown>) { this.body = value; return this; }, end() { return this; } };
    await handler({ method: "DELETE", headers: adminCookieHeaders(), query, body } as never, response as never);
    return response;
  }
  try {
    const all = await call({ all: "true" });
    assert.equal(all.statusCode, 400);
    assert.equal(queries.some(({ sql }) => /travel_trip_entries/.test(sql)), false, "archive-all touches no trip");
    assert.equal((await call({}, { ids: [] })).statusCode, 400);
    assert.equal((await call({}, { ids: ["a", "a"] })).statusCode, 400);
    const missing = await call({}, { ids: ["trip-unknown-1", "trip-unknown-2"] });
    assert.equal(missing.statusCode, 207);
    assert.deepEqual(missing.body.failed, ["trip-unknown-1", "trip-unknown-2"]);
    const touched = queries.filter(({ sql }) => /FROM travel_trip_entries WHERE id=\$1/.test(sql)).map(({ params }) => params[0]);
    assert.deepEqual(touched, ["trip-unknown-1", "trip-unknown-2"], "only the named trips are read for archiving");
  } finally {
    await closeNeonPool();
  }
});
