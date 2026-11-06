import assert from "node:assert/strict";
import test from "node:test";
import { CLOUD, NOW, P1, P2, P3, P4, VERSION, fixturePoster, fixtureTrip } from "./helpers/changeActionFixture";
import type { AIChangeProposal, AITripAction, TravelTrip } from "../src/lib/travelTypes";
import { planDatePrice } from "../src/lib/tripDatePrice";
import { planItineraryDay } from "../src/lib/tripItineraryDayEdit";
import { planPhotoEdit, MAX_TRIP_PHOTOS } from "../src/lib/tripPhotoEdit";
import { dateStateProblem, expandFareChangeAll, planAgeBands, planVisibility, sanitizeTripEditAction } from "../src/lib/tripActionPlan";
import { syncPosterPriceTable } from "../src/lib/poster/priceTableWrite";
import { mapPosterTripToFields } from "../src/lib/poster/tripMapper";
import { pricingDays } from "../src/lib/adminDatePricing";
import { normalizeExtra } from "../src/lib/tripExtraSchema";
import { describeChange } from "../src/lib/assistantActionText";
import { applyTestEnv } from "./helpers/env";

/**
 * The assistant's change verbs planned in code (no model, no database): what each one would
 * write, what it refuses and why, and the card text. Invented trip only.
 */
applyTestEnv({ CLOUDINARY_CLOUD_NAME: CLOUD });
// The validation layer reads the environment when it loads (through the database module).
const server = async () => ({ ...(await import("../src/lib/travelAIValidation")), ...(await import("../src/lib/travelDb")) });

type Row = Record<string, unknown>;
const groupsOf = (fields: { extra?: Row }) => (fields.extra?.price_groups as Row[]) || [];
const onDate = (groups: Row[], date: string) => groups.filter((group) => pricingDays(group, NOW).includes(date));
/** What a Poster-tab save would write back to the trip's price rows (poster/db.ts syncPosterTrip). */
const posterSaveGroups = (poster: Row) => (normalizeExtra({ price_groups: mapPosterTripToFields(poster as never).extra?.price_groups || [] }).extra.price_groups as Row[]);
const partner = () => fixtureTrip({}, { partner_sync: { source_url: "https://partner.example/tours/velmor" } });
const proposal = (actions: AITripAction[]): AIChangeProposal => ({ summary: "", needs_confirmation: true, important_reason: "", conflicts: [], conflict_items: [], actions });

test("a date's price is split out of its shared row; the other date and the poster table follow exactly", () => {
  const result = planDatePrice(fixtureTrip(), { date: "2099-02-17", adult: { delta: 100_000 } }, fixturePoster(), NOW);
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok) return;
  const groups = groupsOf(result.plan.fields);
  assert.equal(groups.length, 3, "the shared row became two");
  assert.equal(onDate(groups, "2099-02-17")[0].adult_price, 2_690_000);
  assert.equal(onDate(groups, "2099-02-10")[0].adult_price, 2_590_000, "the other date keeps its fare");
  assert.equal(onDate(groups, "2099-02-24")[0].adult_price, 2_790_000);
  assert.deepEqual(result.plan.lines.slice(0, 1), ["2/17: насанд хүрэгч 2,590,000₮ → 2,690,000₮"]);
  assert.deepEqual(result.plan.posterKeys, ["price_table"]);
  const saved = posterSaveGroups(result.plan.poster as Row);
  assert.equal(onDate(saved, "2099-02-17")[0].adult_price, 2_690_000, "a later poster save keeps the new fare");
  assert.equal(onDate(saved, "2099-02-10")[0].adult_price, 2_590_000);
  assert.equal(onDate(saved, "2099-02-24")[0].adult_price, 2_790_000);
  const rows = ((result.plan.poster as Row).price_table as { rows: Row[] }).rows;
  assert.deepEqual(rows.map((row) => row.dates), ["2099 оны 2 сарын 10", "2099 оны 2 сарын 17", "2099 оны 2 сарын 24"]);
  assert.deepEqual(rows[1].cells, ["2,690,000₮", "2,190,000₮", "500,000₮"], "only the adult cell changed");
});

test("a child tier is targeted by its band; an exact amount and a free fare are kept as such", () => {
  const result = planDatePrice(fixtureTrip(), { date: "2099-02-24", child: { set: 1_990_000 }, infant: { set: 0 }, band: "2-11 нас" }, fixturePoster(), NOW);
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok) return;
  const row = onDate(groupsOf(result.plan.fields), "2099-02-24")[0];
  const tiers = row.passenger_prices as Row[];
  assert.equal(tiers[0].price, 1_990_000);
  assert.equal(tiers[1].price, 0);
  assert.equal(tiers[1].note, "Үнэгүй");
  assert.equal(row.child_price, 1_990_000, "the flat summary follows the tier");
  const saved = onDate(posterSaveGroups(result.plan.poster as Row), "2099-02-24")[0];
  assert.deepEqual((saved.passenger_prices as Row[]).map((tier) => tier.price), [1_990_000, 0]);
});

test("nothing is guessed: ambiguous rows and tiers, missing fares, non-tugrik rows and partner trips are refused", () => {
  const twoTiers = fixtureTrip({}, {
    price_groups: [{ dates: ["2099-02-24"], date_keys: ["2099-02-24"], adult_price: 2_790_000, passenger_prices: [
      { label: "Хүүхэд 2-5 нас", age_range: "2-5 нас", price: 1_500_000 }, { label: "Хүүхэд 6-11 нас", age_range: "6-11 нас", price: 1_900_000 },
    ] }],
  });
  const refused = (trip: TravelTrip, input: Row) => {
    const result = planDatePrice(trip, input, null, NOW);
    assert.equal(result.ok, false, JSON.stringify(input));
    return result.ok ? "" : result.reason;
  };
  assert.match(refused(twoTiers, { date: "2099-02-24", child: { delta: 50_000 } }), /2 ангилал байна .*2-5 нас.*6-11 нас/);
  assert.equal(planDatePrice(twoTiers, { date: "2099-02-24", child: { delta: 50_000 }, band: "6-11 нас" }, null, NOW).ok, true);
  const hotels = fixtureTrip({}, { price_groups: [
    { hotel: "Нуур зочид буудал", dates: ["2099-02-24"], adult_price: 2_790_000 }, { hotel: "Ой кемп", dates: ["2099-02-24"], adult_price: 2_490_000 },
  ] });
  assert.match(refused(hotels, { date: "2099-02-24", adult: { set: 2_900_000 } }), /2 үнийн мөр байна .*Нуур зочид буудал.*Ой кемп/);
  assert.equal(planDatePrice(hotels, { date: "2099-02-24", adult: { set: 2_900_000 }, hotel: "Ой кемп" }, null, NOW).ok, true);
  assert.match(refused(fixtureTrip(), { date: "2099-02-24", single: { delta: 100_000 } }), /бүртгэлгүй тул \+\/− хийх боломжгүй/);
  assert.match(refused(fixtureTrip(), { date: "2099-03-01", adult: { set: 1 } }), /үнийн мөр алга/);
  assert.match(refused(fixtureTrip(), { date: "2099-02-24", adult: { set: 2_790_000 } }), /аль хэдийн/);
  assert.match(refused(fixtureTrip(), { date: "2099-02-24", adult: { set: 1, delta: 2 } }), /дүн буруу/);
  assert.match(refused(fixtureTrip({}, { price_groups: [{ dates: ["2099-02-24"], adult_price: 3000, currency: "CNY" }] }), { date: "2099-02-24", adult: { set: 3100 } }), /зөвхөн төгрөгөөр/);
  assert.match(refused(fixtureTrip({}, { price_groups: [] }), { date: "2099-02-24", adult: { delta: 1000 } }), /бүх огноо нэг үнэтэй/);
  assert.match(refused(partner(), { date: "2099-02-24", adult: { delta: 100_000 } }), /хамтрагчийн сайтаас/);
});

test("a fare slip is flagged for the review (42,900 for 42,900,000)", () => {
  const result = planDatePrice(fixtureTrip(), { date: "2099-02-24", adult: { set: 27_900 } }, null, NOW);
  assert.equal(result.ok, true);
  if (result.ok) assert.ok(result.plan.warnings.some((warning) => /хэт бага/.test(warning)), result.plan.warnings.join(" | "));
});

test("a poster table the trip cannot be matched to is reported, never half-written", () => {
  const poster = fixturePoster();
  ((poster.price_table as { rows: Row[] }).rows[0]).dates = "2099 оны 2 сарын 10, 17, 19";
  const result = planDatePrice(fixtureTrip(), { date: "2099-02-17", adult: { delta: 100_000 } }, poster, NOW);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.poster, undefined, "the poster is left as it was");
  assert.ok(result.plan.warnings.some((warning) => /Постерын үнийн хүснэгтийг шинэчилж чадсангүй/.test(warning)));
  const sync = syncPosterPriceTable(fixturePoster(), groupsOf(fixtureTrip()) , fixtureTrip().extra, NOW);
  assert.equal(sync.changed, false, "a poster that already agrees is not rewritten");
});

test("visibility, age bands and one program day change only what they name", () => {
  assert.deepEqual(planVisibility(fixtureTrip(), false), { ok: true, plan: { fields: { extra: { customer_visible: false } }, posterKeys: [], warnings: [], lines: ["Сайт, ботоос нууна (бичлэг, үнэ, зураг хадгалагдана)"] } });
  assert.equal(planVisibility(fixtureTrip(), true).ok, false, "already visible");

  const bands = planAgeBands(fixtureTrip(), { child: "5-11 нас" }, fixturePoster());
  assert.equal(bands.ok, true);
  if (bands.ok) {
    const extra = bands.plan.fields.extra as Row;
    assert.deepEqual(extra.age_rules, { infant: "0-23 сар", child: "5-11 нас", adult: "12+ нас" });
    const tiers = ((extra.price_groups as Row[])[0].passenger_prices as Row[]);
    assert.deepEqual([tiers[0].label, tiers[0].age_range], ["Хүүхэд 5-11 нас", "5-11 нас"], "the default-form tier follows");
    assert.deepEqual(tiers[1], { label: "Нярай 0-23 сар", age_range: "0-23 сар", price: 500_000, currency: "MNT" }, "the infant tier is untouched");
    assert.deepEqual(((bands.plan.poster as Row).price_table as Row).columns, ["Том хүн", "Хүүхэд 5-11 нас", "Нярай 0-23 сар"]);
    assert.equal(mapPosterTripToFields(bands.plan.poster as never).extra?.age_rules?.child, "5-11 нас", "a later poster save reads the new band");
  }
  const custom = fixtureTrip({}, { price_groups: [{ dates: ["2099-02-24"], adult_price: 1, passenger_prices: [{ label: "Бага насны хүүхэд", age_range: "2-11 нас", price: 9 }] }] });
  const kept = planAgeBands(custom, { child: "5-11 нас" }, null);
  assert.equal(kept.ok && "price_groups" in (kept.plan.fields.extra as Row), false, "a tier the admin named is left alone");
  assert.equal(planAgeBands(fixtureTrip(), { child: "хүүхэд" }, null).ok, false, "a band without an age is refused");

  const day = planItineraryDay(fixtureTrip(), { day: 2, title: "Вэлмор ойн шинэ зам", meals: { lunch: false }, meal_note: "Өдрийн хоол өөрийн зардлаар" });
  assert.equal(day.ok, true);
  if (day.ok) {
    const days = (day.plan.fields.extra as Row).itinerary_days as Row[];
    assert.deepEqual(days[0], fixtureTrip().extra.itinerary_days && (fixtureTrip().extra.itinerary_days as Row[])[0], "day 1 untouched");
    assert.equal(days[1].title, "Вэлмор ойн шинэ зам");
    assert.deepEqual(days[1].meals, { breakfast: true, lunch: false, dinner: true }, "unnamed meals keep their state");
    assert.equal(days[1].photo, P2, "the day keeps its photo");
    assert.ok(day.plan.lines.some((line) => line === "2-р өдөр: өдрийн хоол багтсан → өөрийн зардлаар"));
  }
  assert.equal(planItineraryDay(fixtureTrip(), { day: 9, title: "x" }).ok, false);
});

test("a photo is swapped in every place it lives, and only our own hosted photos are used", async () => {
  const { validateAIChangeProposal, cleanFields } = await server();
  const swap = planPhotoEdit(fixtureTrip(), { day: 2, new_url: P4 }, fixturePoster());
  assert.equal(swap.ok, true, swap.ok ? "" : swap.reason);
  if (swap.ok) {
    assert.deepEqual(swap.plan.fields.photo_urls, [P1, P4, P3], "replaced in place, not merged");
    assert.equal(((swap.plan.fields.extra as Row).itinerary_days as Row[])[1].photo, P4);
    assert.deepEqual(Object.keys((swap.plan.fields.extra as Row).photo_credits as Row), [P1], "the old photo's credit leaves with it");
    const days = (swap.plan.poster as Row).days as Row[];
    assert.equal(days[1].photo, P4);
    assert.equal(days[3].photo, P3, "the photo-only slot stays");
    assert.deepEqual(swap.plan.thumbs, { before: P2, after: P4 });
  }
  const removed = planPhotoEdit(fixtureTrip(), { position: 3, remove: true }, fixturePoster());
  assert.equal(removed.ok, true);
  if (removed.ok) {
    assert.deepEqual(removed.plan.fields.photo_urls, [P1, P2]);
    assert.equal(((removed.plan.poster as Row).days as Row[])[3].photo, null);
  }
  const outside = planPhotoEdit(fixtureTrip(), { position: 1, new_url: "https://partner.example/photo.jpg" }, null);
  assert.equal(outside.ok, false, "a raw outside link is refused");
  assert.equal(planPhotoEdit(fixtureTrip(), { position: 1, day: 2, new_url: P4 }, null).ok, false, "two selectors are a guess");
  assert.equal(planPhotoEdit(fixtureTrip(), { position: 7, new_url: P4 }, null).ok, false);
  const many = Array.from({ length: 60 }, (_, index) => `https://res.cloudinary.com/${CLOUD}/image/upload/v1/fixture/many-${index}.jpg`);
  assert.equal(cleanFields({ photo_urls: many }).photo_urls?.length, MAX_TRIP_PHOTOS, "the write keeps 50 photos, as the editor allows");
});

test("a departure day's state is refused with a reason when it cannot be set (B8)", async () => {
  const { validateAIChangeProposal, cleanFields } = await server();
  const trip = fixtureTrip({}, { website_departure_availability: [{ date: "2099-02-10", status: "OPEN", seatsLeft: null }, { date: "2099-02-17", status: "CANCELLED", seatsLeft: null }] });
  assert.equal(dateStateProblem(trip, "2099-02-10", "paused", NOW), null);
  assert.match(String(dateStateProblem(trip, "2099-02-24", "full", NOW)), /вэбсайтад хараахан нийтлэгдээгүй/);
  assert.match(String(dateStateProblem(trip, "2099-03-30", "full", NOW)), /гаралт алга/);
  assert.match(String(dateStateProblem(trip, "2099-02-17", "open", NOW)), /цуцлагдсан/);
  assert.match(String(dateStateProblem(trip, "2098-12-30", "open", NOW)), /өнгөрсөн/);
  assert.match(String(dateStateProblem(trip, "2099-02-10", "closed", NOW)), /түр хаасан/);
  assert.match(String(dateStateProblem({ ...trip, extra: { ...trip.extra, partner_sync: { source_url: "https://partner.example/x" } } }, "2099-02-10", "full", NOW)), /хамтрагч/);

  const report = validateAIChangeProposal(proposal([
    { action: "set_date_state", trip_id: trip.id, date: "2099-02-24", state: "full", expected_updated_at: VERSION },
    { action: "set_date_state", trip_id: trip.id, date: "2099-02-10", state: "paused", expected_updated_at: VERSION, summary: "2/10: Түр хаасан" },
  ]), [trip], { now: NOW });
  assert.equal(report.blocking_conflicts.length, 1);
  assert.match(report.blocking_conflicts[0], /нийтлэгдээгүй/);
  assert.deepEqual(report.proposal.actions, [{ action: "set_date_state", trip_id: trip.id, date: "2099-02-10", state: "paused", expected_updated_at: VERSION, summary: "2/10: Түр хаасан", observed_status: "OPEN" }],
    "the paused action keeps its version and summary, and records the day as the proposal saw it");
});

test("validation plans every new verb, keeps only its keys and refuses partner price edits", async () => {
  const { validateAIChangeProposal, cleanFields } = await server();
  const report = validateAIChangeProposal(proposal([
    { action: "set_date_price", trip_id: "trip-velmor", date: "2099-02-17", adult: { delta: 100_000 }, expected_updated_at: VERSION, fields: { notes: "model noise" } } as AITripAction,
    { action: "replace_photo", trip_id: "trip-velmor", day: 2, new_url: P4, expected_updated_at: VERSION },
    { action: "set_visibility", trip_id: "trip-velmor", visible: false, expected_updated_at: VERSION },
  ]), [fixtureTrip()], { now: NOW });
  assert.deepEqual(report.blocking_conflicts, []);
  assert.deepEqual(report.proposal.actions[0], { action: "set_date_price", trip_id: "trip-velmor", expected_updated_at: VERSION, date: "2099-02-17", adult: { delta: 100_000 } });
  const refused = validateAIChangeProposal(proposal([
    { action: "set_date_price", trip_id: "trip-velmor", date: "2099-02-17", adult: { delta: 100_000 } },
    { action: "patch", trip_id: "trip-velmor", fields: { adult_price: 2_000_000 } },
    { action: "replace_photo", trip_id: "trip-velmor", position: 1, new_url: "https://partner.example/a.jpg" },
  ]), [partner()], { now: NOW });
  // The two partner refusals are the same sentence, said once.
  assert.equal(refused.blocking_conflicts.length, 2);
  assert.match(refused.blocking_conflicts[0], /хамтрагчийн сайтаас/);
  assert.match(refused.blocking_conflicts[1], /Cloudinary/);
  assert.equal(refused.proposal.actions.length, 0, "nothing refused reaches apply");
  assert.equal(sanitizeTripEditAction({ action: "set_visibility", trip_id: " trip-velmor ", visible: true, fields: { route_name: "x" } } as AITripAction).fields, undefined);
});

test("a fare rule over many trips becomes one patch per trip, partner and non-tugrik trips listed as skipped", async () => {
  const { validateAIChangeProposal, cleanFields } = await server();
  const usd = fixtureTrip({ id: "trip-usd", route_name: "ДОЛЛАРЫН АЯЛАЛ", currency: "USD" });
  const other = { ...partner(), id: "trip-partner", route_name: "ХАМТРАГЧИЙН АЯЛАЛ" };
  const expansion = expandFareChangeAll([fixtureTrip(), other, usd], { everyone: 100_000 }, { all_active: true });
  assert.equal(expansion.actions.length, 1);
  const patch = expansion.actions[0];
  assert.equal(patch.action, "patch");
  assert.equal(patch.expected_updated_at, VERSION);
  assert.equal(patch.fields?.adult_price, 2_690_000);
  assert.deepEqual(onDate(groupsOf(patch.fields as { extra?: Row }), "2099-02-24").map((group) => group.adult_price), [2_890_000]);
  assert.deepEqual(expansion.skipped.map((skip) => skip.trip_id), ["trip-partner", "trip-usd"]);
  const report = validateAIChangeProposal(proposal([{ action: "fare_change_all", change: { everyone: 100_000 }, filter: { all_active: true } }]), [fixtureTrip(), other, usd], { now: NOW });
  assert.equal(report.proposal.actions.length, 1);
  assert.equal(report.proposal.actions[0].action, "patch");
  assert.ok((report.proposal.conflict_items || []).some((item) => item.type === "fare_change_skipped" && /ХАМТРАГЧИЙН/.test(item.text)));
});

test("the card says each change in plain Mongolian, before → after", () => {
  const trip = fixtureTrip({}, { website_departure_availability: [{ date: "2099-02-17", status: "PAUSED", seatsLeft: null }] });
  const lines = (action: AITripAction) => describeChange(action, trip, NOW).lines;
  assert.deepEqual(lines({ action: "set_date_state", trip_id: trip.id, date: "2099-02-17", state: "open" }), ["2/17: Түр хаасан → Нээлттэй"]);
  assert.equal(lines({ action: "set_date_price", trip_id: trip.id, date: "2099-02-17", adult: { delta: 100_000 } })[0], "2/17: насанд хүрэгч 2,590,000₮ → 2,690,000₮");
  assert.deepEqual(lines({ action: "set_visibility", trip_id: trip.id, visible: false }), ["Сайт, ботоос нууна (бичлэг, үнэ, зураг хадгалагдана)"]);
  assert.deepEqual(lines({ action: "set_age_bands", trip_id: trip.id, child: "5-11 нас" }).slice(0, 1), ["Хүүхэд: 2-11 нас → 5-11 нас"]);
  assert.deepEqual(lines({ action: "patch_itinerary_day", trip_id: trip.id, day: 3, hotel: "Хотын буудал" }), ["3-р өдөр: буудал — → Хотын буудал"]);
  const photo = describeChange({ action: "replace_photo", trip_id: trip.id, day: 2, new_url: P4 }, trip, NOW);
  assert.equal(photo.lines[0], "2-р өдрийн зураг солигдоно");
  assert.deepEqual(photo.thumbs, { before: P2, after: P4 });
  assert.equal(describeChange({ action: "delete", trip_id: trip.id }, trip).title, "«ВЭЛМОР НУУРЫН АЯЛАЛ»");
  assert.match(lines({ action: "delete", trip_id: trip.id })[0], /^Архивлана/);
  assert.match(lines({ action: "cancel", trip_id: trip.id })[0], /цуцална/);
  assert.deepEqual(lines({ action: "patch", trip_id: trip.id, fields: { adult_price: 2_690_000, status: "paused" } }), ["том хүн 2,590,000₮ → 2,690,000₮", "Төлөв: Идэвхтэй → Түр зогссон"]);
  assert.match(describeChange({ action: "fare_change_all", change: { everyone: 100_000 }, filter: { all_active: true } }, null).lines[0], /Бүх идэвхтэй аялал: бүх үнэ \+100,000₮/);
  assert.match(describeChange({ action: "upsert", fields: { route_name: "ШИНЭ АЯЛАЛ", adult_price: 1_000_000 } }, null).title, /Шинэ аялал/);
  assert.match(lines({ action: "set_date_price", trip_id: trip.id, date: "2099-03-30", adult: { set: 1 } })[0], /үнийн мөр алга/, "a refusal is said, not hidden");
  void P1; void P3;
});

test("a poster row whose hotel or package matches no trip row on its dates is not counted as following", () => {
  const groups = (fixtureTrip().extra.price_groups as Row[]).map((group) => ({ ...group, hotel: "Вэлмор кемп" }));
  const sync = syncPosterPriceTable(fixturePoster(), groups, fixtureTrip().extra as Row, NOW);
  assert.equal(sync.problem, undefined);
  assert.deepEqual(sync.coveredDates, [], "the trip prices these dates, only under a hotel the poster rows do not name");
  assert.deepEqual(sync.mismatched, ["2099 оны 2 сарын 10, 17", "2099 оны 2 сарын 24"]);
  const result = planDatePrice(fixtureTrip({}, { price_groups: groups }), { date: "2099-02-17", adult: { delta: 100_000 } }, fixturePoster(), NOW);
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok) return;
  assert.ok(result.plan.warnings.some((warning) => /2\/17-ны үнэ орсонгүй \(постерын .*буудал\/багц үнийн мөртэй таарахгүй\)/.test(warning)), result.plan.warnings.join(" | "));
  // A poster row for dates the trip no longer prices is still simply left alone.
  const gone = syncPosterPriceTable(fixturePoster(), [groups[1]], fixtureTrip().extra as Row, NOW);
  assert.deepEqual(gone.mismatched, ["2099 оны 2 сарын 24"], "2/24 is priced under another hotel");
  assert.deepEqual(gone.coveredDates.sort(), ["2099-02-10", "2099-02-17"], "2/10 and 2/17 are no longer priced at all");
});

test("a base-fare change rewrites a one-row poster table in place (columns, dates, other cells kept)", async () => {
  const { tripToPoster } = await import("../src/lib/connectedTripMapping");
  const before = fixtureTrip();
  const prior = { ...fixturePoster(), price_table: { columns: ["Огноо", "Том хүн", "Хүүхэд 2-11 нас", "Нярай 0-23 сар"], rows: [{ dates: "2099 оны 2 сарын 10, 17, 24", cells: ["2,590,000₮", "2,190,000₮", "500,000₮"] }] } };
  const after = { ...before, adult_price: 2_690_000, child_price: 2_290_000 };
  const table = tripToPoster(after, prior, before).price_table as Row;
  assert.deepEqual(table.columns, prior.price_table.columns);
  assert.deepEqual(table.rows, [{ dates: "2099 оны 2 сарын 10, 17, 24", cells: ["2,690,000₮", "2,290,000₮", "500,000₮"] }], "the infant cell is not touched");
  // No table yet: built from the base fares as before.
  const built = tripToPoster(after, { ...fixturePoster(), price_table: undefined }, before).price_table as Row;
  assert.deepEqual(built.columns, ["Том хүн", "Хүүхэд"]);
  // An empty adult fare cannot be written in place: the old rebuild ("Үнэ лавлах") stands.
  const unpriced = tripToPoster({ ...after, adult_price: null }, prior, before).price_table as Row;
  assert.deepEqual((unpriced.rows as Row[])[0].cells, ["Үнэ лавлах", "2,290,000₮"]);
});

test("a partner-synced trip refuses edits its 30-minute run would undo; photos, meal notes, name and visibility stay editable", async () => {
  const { partnerEditProblem, planTripEdit } = await import("../src/lib/tripActionPlan");
  const trip = partner();
  const refused = (action: AITripAction) => {
    const planned = planTripEdit(trip, action, null, NOW);
    return planned.ok ? "" : planned.reason;
  };
  assert.match(refused({ action: "set_age_bands", trip_id: trip.id, child: "5-11 нас" }), /насны ангилал, хөтөлбөрийн өдрийн/);
  assert.match(refused({ action: "patch_itinerary_day", trip_id: trip.id, day: 2, title: "Шинэ гарчиг" }), /хамтрагчийн сайтаас/);
  assert.match(refused({ action: "patch_itinerary_day", trip_id: trip.id, day: 2, meals: { lunch: false } }), /хамтрагчийн сайтаас/);
  assert.equal(refused({ action: "patch_itinerary_day", trip_id: trip.id, day: 2, meal_note: "Буфет" }), "", "the day's meal note is the staff's");
  assert.equal(refused({ action: "replace_photo", trip_id: trip.id, day: 2, new_url: P4 }), "", "a day photo is the staff's");
  assert.equal(refused({ action: "set_visibility", trip_id: trip.id, visible: false }), "");
  assert.match(String(partnerEditProblem(trip, { action: "patch", fields: { notes: "Шинэ тайлбар" } })), /хамтрагчийн сайтаас/);
  assert.match(String(partnerEditProblem(trip, { action: "patch", fields: { extra: { age_rules: { child: "5-11 нас" } } } })), /хамтрагчийн сайтаас/);
  const days = (trip.extra.itinerary_days as Row[]).map((day, index) => (index === 1 ? { ...day, title: "Өөр гарчиг" } : day));
  assert.match(String(partnerEditProblem(trip, { action: "patch", fields: { extra: { itinerary_days: days } } })), /хамтрагчийн сайтаас/);
  const photoOnly = (trip.extra.itinerary_days as Row[]).map((day, index) => (index === 1 ? { ...day, photo: P4, meal_note: "Буфет" } : day));
  assert.equal(partnerEditProblem(trip, { action: "patch", fields: { extra: { itinerary_days: photoOnly } } }), null);
  assert.equal(partnerEditProblem(trip, { action: "patch", fields: { route_name: "ВЭЛМОР 2099", extra: { customer_visible: false } } }), null);
  assert.equal(partnerEditProblem(trip, { action: "patch", fields: { notes: trip.notes } }), null, "a value the trip already holds is not an edit");
});
