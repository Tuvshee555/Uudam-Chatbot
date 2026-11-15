import assert from "node:assert/strict";
import test from "node:test";
import { CLOUD, NOW, P1, P2, P3, P4, VERSION, fixturePoster, fixtureTrip } from "./helpers/changeActionFixture";
import { applyTestEnv } from "./helpers/env";
import type { AITripAction, TravelTrip, TripMutationFields } from "../src/lib/travelTypes";
import { pricingDays } from "../src/lib/adminDatePricing";
import { mapPosterTripToFields } from "../src/lib/poster/tripMapper";
import { normalizeExtra, normalizeExtraPatch } from "../src/lib/tripExtraSchema";
import { tripToPoster } from "../src/lib/connectedTripMapping";
import { assertValidTripDataChange, type TripFactInput } from "../src/lib/tripDataValidation";

/**
 * Apply and rollback of every assistant change verb against an in-memory trip store that keeps
 * patchTrip's own rules: the version check, the field cleaning, extra merged one top-level key at
 * a time, the data checks, the poster write and the reverse poster sync (the real tripToPoster).
 * The website's departure rows are in memory too. Invented trip only; no database, no network.
 */
applyTestEnv({ CLOUDINARY_CLOUD_NAME: CLOUD });

type Row = Record<string, unknown>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
type Departure = { id: string; date: string; status: string; seatsLeft: number | null };

/** A non-active trip's projection closes every date with the trip's seat count (upsertWebsiteTrip). */
const CLOSED_AS: Record<string, string> = { archived: "PAUSED", draft: "PAUSED", paused: "PAUSED", sold_out: "SOLD_OUT", cancelled: "CANCELLED" };

async function harness(options: { trip?: TravelTrip; departures?: Departure[]; poster?: Row } = {}) {
  const { cleanFields } = await import("../src/lib/travelDb");
  const apply = await import("../src/lib/travelAIApply");
  let stored = clone(options.trip || fixtureTrip());
  let poster = { id: "poster-velmor", title: "ВЭЛМОР НУУРЫН АЯЛАЛ", source_file: null as string | null, data: clone(options.poster || fixturePoster()) as unknown };
  let tick = 0;
  const departures: Departure[] = clone(options.departures || [
    { id: "dep-10", date: "2099-02-10", status: "OPEN", seatsLeft: null },
    { id: "dep-17", date: "2099-02-17", status: "PAUSED", seatsLeft: null },
  ]);
  const calls = { patches: [] as Array<{ fields: TripMutationFields; expected?: string; poster: boolean }>, notified: [] as string[][] };
  // `pending`: the save's website projection is queued instead of run inline (a busy lock, the site down).
  const website = { pending: false };
  const hooks: { afterPatch?: () => void } = {};
  // The inline website projection after a save, as upsertWebsiteTrip writes the departure rows:
  // a non-active trip closes every date; re-activating it reopens every date not flagged few seats.
  const project = (before: TravelTrip, next: TravelTrip) => {
    if (website.pending) return;
    if (next.status !== "active") for (const row of departures) Object.assign(row, { status: CLOSED_AS[next.status] || "PAUSED", seatsLeft: next.seats_left ?? null });
    else if (before.status !== "active") for (const row of departures) if (row.status !== "ALMOST_FULL") row.status = "OPEN";
  };
  const read = (): TravelTrip => clone({ ...stored, extra: { ...stored.extra, website_slug: "velmor-lake",
    website_departure_availability: departures.map((row) => ({ date: row.date, status: row.status, seatsLeft: row.seatsLeft })) } });
  apply.setAIApplyDepsForTests({
    now: () => NOW,
    getTripById: async (id) => (id === stored.id ? read() : null),
    getPoster: async (id) => (id === poster.id ? clone(poster) : null),
    patchTrip: async (id, fields, syncPoster, posterWrite, expected) => {
      if (id !== stored.id) return null;
      calls.patches.push({ fields: clone(fields), expected, poster: Boolean(posterWrite) });
      if (expected && new Date(expected).getTime() !== new Date(stored.updated_at).getTime()) throw new Error("trip_edit_conflict");
      const before = clone(stored);
      const cleaned = cleanFields(fields, true);
      const { extra: extraPatch, ...columns } = cleaned;
      const next = { ...stored, ...columns, extra: { ...stored.extra, ...(extraPatch ? normalizeExtraPatch(extraPatch as Row) : {}) } } as TravelTrip;
      assertValidTripDataChange(next as unknown as TripFactInput, before as unknown as TripFactInput);
      tick += 1;
      next.updated_at = new Date(Date.parse(VERSION) + tick * 1000).toISOString();
      if (posterWrite) poster = { ...poster, data: clone(posterWrite.data) };
      if (syncPoster) poster = { ...poster, data: tripToPoster(next, poster.data, before) };
      stored = next;
      project(before, next);
      const saved = clone(stored);
      hooks.afterPatch?.();
      return saved;
    },
    readDepartureRows: async (id) => ({ slug: "velmor-lake", rows: id === stored.id ? departures.map((row) => ({ ...row })) : [] }),
    websiteSyncPending: async () => website.pending,
    changeDepartureState: async (tripId, date, state) => {
      const status = { open: "OPEN", low: "ALMOST_FULL", full: "SOLD_OUT", paused: "PAUSED" }[state];
      const rows = departures.filter((row) => tripId === stored.id && row.date === date && !["CANCELLED", "DEPARTED"].includes(row.status));
      const changed = rows.map((row) => {
        const was = { status: row.status, seatsLeft: row.seatsLeft };
        row.status = status;
        if ((status === "OPEN" || status === "ALMOST_FULL") && row.seatsLeft === 0) row.seatsLeft = null;
        return { id: row.id, status: was.status, seatsLeft: was.seatsLeft, after_status: row.status, after_seats_left: row.seatsLeft };
      });
      return { slug: changed.length ? "velmor-lake" : null, rows: changed };
    },
    restoreDepartureRows: async (rows) => {
      const live = (id: string) => departures.find((row) => row.id === id);
      if (rows.every((row) => live(row.id)?.status === row.status && live(row.id)?.seatsLeft === row.seatsLeft)) return { restored: 0, changedSince: [] };
      const changedSince = rows.filter((row) => live(row.id)?.status !== row.after_status || live(row.id)?.seatsLeft !== row.after_seats_left).map((row) => row.id);
      if (changedSince.length) return { restored: 0, changedSince };
      for (const row of rows) Object.assign(live(row.id) as Departure, { status: row.status, seatsLeft: row.seatsLeft });
      return { restored: rows.length, changedSince: [] };
    },
    notifyWebsite: async (slugs) => { calls.notified.push(slugs); },
  });
  const run = async (action: AITripAction) => {
    const result = await apply.applyAIAction(action);
    // Rollback reads the snapshot back from rollback_json.
    const snapshots = result.snapshot ? apply.readStoredSnapshotsForTests(JSON.parse(JSON.stringify([result.snapshot]))) : [];
    return { ...result, rollback: () => apply.rollbackSnapshots(snapshots) };
  };
  /** A whole proposal in one save, then its rollback from the stored snapshots. */
  const runAll = async (actions: AITripAction[]) => {
    const saved = await apply.runActionsForTests(actions);
    const snapshots = apply.readStoredSnapshotsForTests(JSON.parse(JSON.stringify(saved.snapshots)));
    return { ...saved, rollback: () => apply.rollbackSnapshots(snapshots) };
  };
  return {
    run, runAll, calls, departures, website, hooks,
    trip: () => clone(stored),
    poster: () => clone(poster.data) as Row,
    staffEdit: (fields: Partial<TravelTrip>) => { stored = { ...stored, ...fields, updated_at: new Date(Date.parse(VERSION) + 999_000).toISOString() }; },
    done: () => apply.setAIApplyDepsForTests(null),
  };
}

const at = (groups: unknown, date: string) => (groups as Row[]).filter((group) => pricingDays(group, NOW).includes(date));
const posterSave = (poster: Row) => normalizeExtra({ price_groups: mapPosterTripToFields(poster as never).extra?.price_groups || [] }).extra.price_groups as Row[];
const base = { trip_id: "trip-velmor", expected_updated_at: VERSION };

test("set_date_state pauses one date, records the raw earlier state and puts it back, refreshing the website both times", async () => {
  const h = await harness();
  try {
    const paused = await h.run({ action: "set_date_state", ...base, date: "2099-02-10", state: "paused" });
    assert.equal(paused.ok, true, paused.message);
    assert.equal(h.departures[0].status, "PAUSED");
    assert.match(paused.message, /Нээлттэй → Түр хаасан/);
    assert.deepEqual(h.calls.notified, [["velmor-lake"]]);
    assert.equal(h.calls.patches.length, 0, "the trip row itself is not rewritten");
    const back = await paused.rollback();
    assert.deepEqual(back, { failed: false, results: ["Restored trip-velmor 2099-02-10 → Нээлттэй"] });
    assert.equal(h.departures[0].status, "OPEN");
    assert.equal(h.calls.notified.length, 2);
    const again = await paused.rollback();
    assert.equal(again.failed, false, "a second rollback finds it already back");
  } finally { h.done(); }
});

test("reopening a staff-paused date rolls back to PAUSED, not open", async () => {
  const h = await harness();
  try {
    const opened = await h.run({ action: "set_date_state", ...base, date: "2099-02-17", state: "open" });
    assert.equal(opened.ok, true, opened.message);
    assert.equal(h.departures[1].status, "OPEN");
    assert.equal((await opened.rollback()).failed, false);
    assert.equal(h.departures[1].status, "PAUSED");
  } finally { h.done(); }
});

test("a date state is refused on a moved version, a partner trip, an unpublished date; a later staff change is never rolled over", async () => {
  const h = await harness();
  try {
    const stale = await h.run({ action: "set_date_state", ...base, expected_updated_at: "2098-11-01T00:00:00.000Z", date: "2099-02-10", state: "full" });
    assert.equal(stale.ok, false);
    assert.match(stale.message, /өөрчлөгдсөн байна/);
    const unpublished = await h.run({ action: "set_date_state", ...base, date: "2099-02-24", state: "full" });
    assert.equal(unpublished.ok, false);
    assert.match(unpublished.message, /нийтлэгдээгүй/);
    assert.equal(h.departures[0].status, "OPEN", "nothing was written");

    const full = await h.run({ action: "set_date_state", ...base, date: "2099-02-10", state: "full" });
    assert.equal(full.ok, true);
    h.departures[0].status = "ALMOST_FULL"; // staff, on the website, after the AI change
    const back = await full.rollback();
    assert.equal(back.failed, true);
    assert.match(back.results[0], /өөр хүн .*өөрчилсөн/);
    assert.equal(h.departures[0].status, "ALMOST_FULL", "the staff change stays");
  } finally { h.done(); }
  const p = await harness({ trip: fixtureTrip({}, { partner_sync: { source_url: "https://partner.example/tours/velmor" } }) });
  try {
    const refused = await p.run({ action: "set_date_state", ...base, date: "2099-02-10", state: "full" });
    assert.equal(refused.ok, false);
    assert.match(refused.message, /хамтрагчийн сайтаас/);
  } finally { p.done(); }
});

test("an old date-state snapshot with no recorded state is reported as not rolled back (B10)", async () => {
  const h = await harness();
  try {
    const apply = await import("../src/lib/travelAIApply");
    const legacy = apply.readStoredSnapshotsForTests([{ action: { action: "set_date_state", trip_id: "trip-velmor", date: "2099-02-10", state: "full" }, trip_id: "trip-velmor", before: null, after: null, date_state_before: null }]);
    const back = await apply.rollbackSnapshots(legacy);
    assert.equal(back.failed, true, "the request is not marked reverted");
    assert.match(back.results[0], /бүртгэгдээгүй/);
  } finally { h.done(); }
});

test("set_date_price changes one date, the poster table follows in the same write, and a later poster save keeps it", async () => {
  const h = await harness();
  try {
    const raised = await h.run({ action: "set_date_price", ...base, date: "2099-02-17", adult: { delta: 100_000 } });
    assert.equal(raised.ok, true, raised.message);
    assert.equal(h.calls.patches[0].poster, true, "the poster was written with the trip");
    assert.equal(h.calls.patches[0].expected, VERSION);
    const groups = h.trip().extra.price_groups;
    assert.equal(at(groups, "2099-02-17")[0].adult_price, 2_690_000);
    assert.equal(at(groups, "2099-02-10")[0].adult_price, 2_590_000);
    const saved = posterSave(h.poster());
    assert.equal(at(saved, "2099-02-17")[0].adult_price, 2_690_000, "a Poster-tab save would write back the new fare");
    assert.equal(at(saved, "2099-02-10")[0].adult_price, 2_590_000);

    const back = await raised.rollback();
    assert.equal(back.failed, false, back.results.join(" | "));
    assert.equal(h.calls.patches[1].poster, true, "the poster table is put back too");
    assert.deepEqual(h.trip().extra.price_groups, normalizeExtra({ price_groups: fixtureTrip().extra.price_groups }).extra.price_groups);
    assert.deepEqual((h.poster().price_table as Row).rows, (fixturePoster().price_table as Row).rows);
    assert.deepEqual(Object.keys(h.calls.patches[1].fields.extra || {}).sort(), ["child_rules", "price_groups"], "only what the action wrote is put back");
  } finally { h.done(); }
});

test("a rollback never rolls over an edit made after the AI change", async () => {
  const h = await harness();
  try {
    const hidden = await h.run({ action: "set_visibility", ...base, visible: false });
    assert.equal(hidden.ok, true);
    assert.equal(h.trip().extra.customer_visible, false);
    h.staffEdit({ notes: "Ажилтны шинэ тэмдэглэл" });
    const back = await hidden.rollback();
    assert.equal(back.failed, true);
    assert.match(back.results[0], /дахин засагдсан тул буцаасангүй/);
    assert.equal(h.trip().notes, "Ажилтны шинэ тэмдэглэл");
    assert.equal(h.trip().extra.customer_visible, false);
  } finally { h.done(); }
});

test("set_visibility and delete (archive) roll back exactly the keys they wrote", async () => {
  const h = await harness();
  try {
    const hidden = await h.run({ action: "set_visibility", ...base, visible: false });
    assert.equal((await hidden.rollback()).failed, false);
    assert.deepEqual(h.calls.patches[1].fields, { extra: { customer_visible: true } });
    assert.equal(h.trip().extra.customer_visible, true);

    const version = h.trip().updated_at;
    const stale = await h.run({ action: "delete", ...base });
    assert.equal(stale.ok, false, "the proposal's version is checked before archiving");
    const archived = await h.run({ action: "delete", ...base, expected_updated_at: version });
    assert.equal(archived.ok, true, archived.message);
    assert.equal(h.trip().status, "archived");
    assert.equal((await archived.rollback()).failed, false);
    assert.equal(h.trip().status, "active");
    assert.equal(h.trip().extra.customer_visible, true);
  } finally { h.done(); }
});

test("patch_itinerary_day changes one day, the poster day follows and the poster's photo-only slot is kept", async () => {
  const h = await harness();
  try {
    const edited = await h.run({ action: "patch_itinerary_day", ...base, day: 2, title: "Вэлмор ойн шинэ зам", meals: { lunch: false } });
    assert.equal(edited.ok, true, edited.message);
    const days = h.trip().extra.itinerary_days as Row[];
    assert.equal(days[1].title, "Вэлмор ойн шинэ зам");
    assert.equal(days[0].title, "Улаанбаатар — Вэлмор нуур");
    const posterDays = h.poster().days as Row[];
    assert.equal(posterDays[1].route, "Вэлмор ойн шинэ зам");
    assert.deepEqual(posterDays[1].meals, { breakfast: true, lunch: false, dinner: true });
    assert.equal(posterDays.find((day) => !day.route)?.photo, P3, "the photo-only slot survives a program edit");
    assert.equal((await edited.rollback()).failed, false);
    assert.equal((h.trip().extra.itinerary_days as Row[])[1].title, "Вэлмор ойн аялал");
    assert.equal((h.poster().days as Row[])[1].route, "Вэлмор ойн аялал");
  } finally { h.done(); }
});

test("set_age_bands updates the bands, the default-form tiers and the poster column, and rolls all three back", async () => {
  const h = await harness();
  try {
    const banded = await h.run({ action: "set_age_bands", ...base, child: "5-11 нас" });
    assert.equal(banded.ok, true, banded.message);
    assert.equal((h.trip().extra.age_rules as Row).child, "5-11 нас");
    assert.equal(((h.trip().extra.price_groups as Row[])[0].passenger_prices as Row[])[0].label, "Хүүхэд 5-11 нас");
    assert.equal(mapPosterTripToFields(h.poster() as never).extra?.age_rules?.child, "5-11 нас", "a later poster save keeps the band");
    assert.equal((await banded.rollback()).failed, false);
    assert.equal((h.trip().extra.age_rules as Row).child, "2-11 нас");
    assert.deepEqual((h.poster().price_table as Row).columns, ["Том хүн", "Хүүхэд 2-11 нас", "Нярай 0-23 сар"]);
  } finally { h.done(); }
});

test("replace_photo swaps a day photo in the gallery, the program day and the poster, and the swap rolls back", async () => {
  const h = await harness();
  try {
    const swapped = await h.run({ action: "replace_photo", ...base, day: 2, new_url: P4 });
    assert.equal(swapped.ok, true, swapped.message);
    assert.deepEqual(h.trip().photo_urls, [P1, P4, P3]);
    assert.equal((h.trip().extra.itinerary_days as Row[])[1].photo, P4);
    const posterDays = h.poster().days as Row[];
    assert.equal(posterDays[1].photo, P4);
    assert.ok(!JSON.stringify(h.poster()).includes(P2), "the old photo is nowhere on the poster");
    assert.equal(h.poster().hero_image, P1);
    assert.equal((await swapped.rollback()).failed, false);
    assert.deepEqual(h.trip().photo_urls, [P1, P2, P3]);
    assert.equal((h.trip().extra.itinerary_days as Row[])[1].photo, P2);
    assert.equal((h.poster().days as Row[])[1].photo, P2);
    const outside = await h.run({ action: "replace_photo", ...base, expected_updated_at: h.trip().updated_at, position: 1, new_url: "https://partner.example/photo.jpg" });
    assert.equal(outside.ok, false, "a raw outside link never reaches the trip");
  } finally { h.done(); }
});

test("a trip-wide fare patch (one trip of a fare_change_all) brings the poster table along and rolls back", async () => {
  const h = await harness();
  try {
    const { expandFareChangeAll } = await import("../src/lib/tripActionPlan");
    const [patch] = expandFareChangeAll([h.trip()], { everyone: 100_000 }, { all_active: true }).actions;
    const raised = await h.run(patch);
    assert.equal(raised.ok, true, raised.message);
    assert.equal(h.calls.patches[0].poster, true);
    const saved = posterSave(h.poster());
    assert.deepEqual(saved.map((group) => group.adult_price), [2_690_000, 2_890_000]);
    assert.deepEqual((saved[1].passenger_prices as Row[]).map((tier) => tier.price), [2_290_000, 600_000]);
    assert.equal((await raised.rollback()).failed, false);
    assert.equal(h.trip().adult_price, 2_590_000);
    assert.deepEqual(posterSave(h.poster()).map((group) => group.adult_price), [2_590_000, 2_790_000]);
  } finally { h.done(); }
});

test("an upsert onto an existing trip and a plain patch are both behind the trip's version", async () => {
  const h = await harness();
  try {
    const stale = await h.run({ action: "upsert", trip_id: "trip-velmor", expected_updated_at: "2098-11-01T00:00:00.000Z", fields: { notes: "x" } });
    assert.equal(stale.ok, false);
    const noVersion = await h.run({ action: "patch", trip_id: "trip-velmor", fields: { notes: "Шинэ тэмдэглэл" } });
    assert.equal(noVersion.ok, true);
    assert.equal(h.calls.patches.at(-1)?.expected, VERSION, "without a proposal version, the version read just before is used");
    assert.equal((await noVersion.rollback()).failed, false);
    assert.equal(h.trip().notes, "");
  } finally { h.done(); }
});

// ─── several actions in one save; trip-level status changes; a day changed after the proposal ───

test("several edits of one trip in one save: each later one is checked against the version the earlier one left, and all roll back", async () => {
  const h = await harness();
  try {
    const saved = await h.runAll([
      { action: "set_date_price", ...base, date: "2099-02-24", adult: { delta: 100_000 } },
      { action: "replace_photo", ...base, day: 2, new_url: P4 },
      { action: "set_date_state", ...base, date: "2099-02-10", state: "full" },
    ]);
    assert.equal(saved.failed, false, saved.results.join(" | "));
    assert.equal(h.calls.patches[0].expected, VERSION);
    assert.notEqual(h.calls.patches[1].expected, VERSION, "the second write is behind the version the first one left");
    assert.equal(at(h.trip().extra.price_groups, "2099-02-24")[0].adult_price, 2_890_000);
    assert.deepEqual(h.trip().photo_urls, [P1, P4, P3]);
    assert.equal(h.departures[0].status, "SOLD_OUT");

    const back = await saved.rollback();
    assert.equal(back.failed, false, back.results.join(" | "));
    assert.equal(h.departures[0].status, "OPEN");
    assert.deepEqual(h.trip().photo_urls, [P1, P2, P3]);
    assert.equal(at(h.trip().extra.price_groups, "2099-02-24")[0].adult_price, 2_790_000);
    assert.deepEqual((h.poster().price_table as Row).rows, (fixturePoster().price_table as Row).rows);
    assert.equal((h.poster().days as Row[])[1].photo, P2);
  } finally { h.done(); }
});

test("an edit by someone else between two actions of one save is still refused", async () => {
  const h = await harness();
  try {
    h.hooks.afterPatch = () => { h.hooks.afterPatch = undefined; h.staffEdit({ notes: "Ажилтны засвар" }); };
    const saved = await h.runAll([
      { action: "set_visibility", ...base, visible: false },
      { action: "patch_itinerary_day", ...base, day: 2, title: "Шинэ гарчиг" },
    ]);
    assert.equal(saved.failed, true);
    assert.match(saved.results[1], /өөрчлөгдсөн байна/);
    assert.equal((h.trip().extra.itinerary_days as Row[])[1].title, "Вэлмор ойн аялал");
    assert.equal(h.trip().notes, "Ажилтны засвар");
    assert.equal(saved.snapshots.length, 1, "the saved half keeps its snapshot, so it can still be undone");
  } finally { h.done(); }
});

const closedDays = (): Array<{ id: string; date: string; status: string; seatsLeft: number | null }> => [
  { id: "dep-10", date: "2099-02-10", status: "SOLD_OUT", seatsLeft: 0 },
  { id: "dep-17", date: "2099-02-17", status: "PAUSED", seatsLeft: null },
  { id: "dep-24", date: "2099-02-24", status: "ALMOST_FULL", seatsLeft: null },
];
const dayStates = (rows: Array<{ status: string; seatsLeft: number | null }>) => rows.map((row) => [row.status, row.seatsLeft]);

test("undoing an archive puts every website date back as it was, not reopened", async () => {
  const h = await harness({ departures: closedDays() });
  try {
    const archived = await h.run({ action: "delete", ...base });
    assert.equal(archived.ok, true, archived.message);
    assert.deepEqual(dayStates(h.departures), [["PAUSED", null], ["PAUSED", null], ["PAUSED", null]]);
    const back = await archived.rollback();
    assert.equal(back.failed, false, back.results.join(" | "));
    assert.equal(h.trip().status, "active");
    assert.deepEqual(dayStates(h.departures), [["SOLD_OUT", 0], ["PAUSED", null], ["ALMOST_FULL", null]], "sold out, paused and few-seats dates stay closed");
    assert.ok(h.calls.notified.some((slugs) => slugs.includes("velmor-lake")), "the website page is refreshed");
  } finally { h.done(); }
});

test("undoing a cancel keeps a date someone changed while it was cancelled, and says so", async () => {
  const h = await harness({ departures: closedDays() });
  try {
    const cancelled = await h.run({ action: "cancel", ...base });
    assert.equal(cancelled.ok, true, cancelled.message);
    assert.deepEqual(h.departures.map((row) => row.status), ["CANCELLED", "CANCELLED", "CANCELLED"]);
    Object.assign(h.departures[1], { status: "SOLD_OUT", seatsLeft: 0 }); // staff, on the website, while cancelled
    const back = await cancelled.rollback();
    assert.equal(back.failed, false, back.results.join(" | "));
    assert.deepEqual(dayStates(h.departures), [["SOLD_OUT", 0], ["SOLD_OUT", 0], ["ALMOST_FULL", null]]);
    assert.match(back.results[0], /2\/17-ны төлвийг энэ хооронд өөрчилсөн/);
  } finally { h.done(); }
});

test("an undo whose website projection is still queued writes no date and lists the dates to check", async () => {
  const h = await harness({ departures: closedDays() });
  try {
    const archived = await h.run({ action: "delete", ...base });
    assert.equal(archived.ok, true, archived.message);
    h.website.pending = true;
    const back = await archived.rollback();
    assert.equal(back.failed, true, "the request is not marked undone");
    assert.match(back.results[0], /сайт шинэчлэгдэж дуусаагүй/);
    assert.match(back.results[0], /2\/10 Дүүрсэн, 2\/17 Түр хаасан, 2\/24 Цөөн суудал/);
    assert.equal(h.trip().status, "active", "the trip itself is restored");
    assert.deepEqual(h.departures.map((row) => row.status), ["PAUSED", "PAUSED", "PAUSED"], "no date is written");
  } finally { h.done(); }
});

test("a date changed on the website after the proposal (a seat button) is not overwritten", async () => {
  const h = await harness();
  try {
    const stale = await h.run({ action: "set_date_state", ...base, date: "2099-02-17", state: "low", observed_status: "OPEN" });
    assert.equal(stale.ok, false);
    assert.match(stale.message, /2\/17-ны төлөв энэ саналыг гаргаснаас хойш өөрчлөгдсөн/);
    assert.equal(h.departures[1].status, "PAUSED", "nothing was written");
    const fresh = await h.run({ action: "set_date_state", ...base, date: "2099-02-17", state: "low", observed_status: "PAUSED" });
    assert.equal(fresh.ok, true, fresh.message);
    assert.equal(h.departures[1].status, "ALMOST_FULL");
  } finally { h.done(); }
});

const oneRowTrip = () => {
  const [first] = fixtureTrip().extra.price_groups as Row[];
  const dates = ["2099-02-10", "2099-02-17", "2099-02-24"];
  return fixtureTrip({}, { price_groups: [{ ...first, label: dates.join(", "), dates, display_dates: dates, date_keys: dates }] });
};
const oneRowPoster = () => ({ ...fixturePoster(), price_table: {
  columns: ["Том хүн", "Хүүхэд 2-11 нас", "Нярай 0-23 сар"],
  rows: [{ dates: "2099 оны 2 сарын 10, 17, 24", cells: ["2,590,000₮", "2,190,000₮", "500,000₮"] }],
} });

test("a trip-wide fare change keeps a one-row poster table's columns, and the undo brings the table back", async () => {
  const h = await harness({ trip: oneRowTrip(), poster: oneRowPoster() });
  try {
    const { expandFareChangeAll } = await import("../src/lib/tripActionPlan");
    const [patch] = expandFareChangeAll([h.trip()], { everyone: 100_000 }, { all_active: true }).actions;
    const raised = await h.run(patch);
    assert.equal(raised.ok, true, raised.message);
    const table = h.poster().price_table as Row;
    assert.deepEqual(table.columns, ["Том хүн", "Хүүхэд 2-11 нас", "Нярай 0-23 сар"], "the infant and age-banded columns are kept");
    assert.deepEqual((table.rows as Row[])[0], { dates: "2099 оны 2 сарын 10, 17, 24", cells: ["2,690,000₮", "2,290,000₮", "600,000₮"] });
    const [saved] = posterSave(h.poster());
    assert.deepEqual((saved.passenger_prices as Row[]).map((tier) => [tier.age_range, tier.price]), [["2-11 нас", 2_290_000], ["0-23 сар", 600_000]], "a poster save keeps the bands and the infant fare");
    const back = await raised.rollback();
    assert.equal(back.failed, false, back.results.join(" | "));
    assert.deepEqual(h.poster().price_table, oneRowPoster().price_table);
  } finally { h.done(); }
});

test("a trip-wide fare change the poster rows cannot follow (hotel on the trip rows only) says so", async () => {
  const groups = (fixtureTrip().extra.price_groups as Row[]).map((group) => ({ ...group, hotel: "Вэлмор кемп" }));
  const h = await harness({ trip: fixtureTrip({}, { price_groups: groups }) });
  try {
    const { expandFareChangeAll } = await import("../src/lib/tripActionPlan");
    const [patch] = expandFareChangeAll([h.trip()], { everyone: 100_000 }, { all_active: true }).actions;
    const raised = await h.run(patch);
    assert.equal(raised.ok, true, raised.message);
    assert.match(raised.message, /2\/10, 2\/17, 2\/24-ны шинэ үнийг дагасангүй/);
    assert.match(raised.message, /буудал\/багц үнийн мөртэй таарахгүй/);
  } finally { h.done(); }
});

