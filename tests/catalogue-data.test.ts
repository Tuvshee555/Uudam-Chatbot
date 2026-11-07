/**
 * Corporate catalogue, data stage: live trips -> CatalogueSnapshot.
 * Invented trips only (AGENTS.md): "Тест-Далай", "Жишиг-Хөдөө", ... Dates and fares are plain numbers.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { TravelTrip } from "../src/lib/travelTypes";
import {
  buildCatalogueSnapshot,
  deriveStartingPrice,
  findOverviewPriceConflicts,
  isTripEligible,
  liveDrift,
  pickPhoto,
  planEdition,
  resolveCodeMap,
} from "../src/lib/catalogue/tripData";
import { buildContact, parsePhones } from "../src/lib/catalogue/contact";
import { customerText, extractMntAmounts, isProvisionalCode } from "../src/lib/catalogue/diagnostics";
import { buildGroups, budgetCutoff, classifyTrips } from "../src/lib/catalogue/groups";
import { deriveHighlights } from "../src/lib/catalogue/highlights";
import { deriveKicker, titleAnchoredPlaces } from "../src/lib/catalogue/kicker";
import { STANDARD_DAYS } from "../src/lib/tripTransitDays";
import { deriveDateInfo, isWeeklyScheduleText } from "../src/lib/catalogue/pricing";
import {
  CATALOGUE_QUICK_MAX_TRIPS,
  CATALOGUE_QUICK_MIN_TRIPS,
  type CatalogueEditionConfig,
  type SnapshotInput,
} from "../src/lib/catalogue/types";

applyTestEnv();

const NOW = "2026-11-06T04:00:00.000Z"; // 12:00 in Ulaanbaatar
const TODAY = "2026-11-06";

type TripOverrides = Partial<Omit<TravelTrip, "extra">> & { extra?: Record<string, unknown> };

function trip(id: string, over: TripOverrides = {}): TravelTrip {
  const { extra, ...rest } = over;
  return {
    id, category: "газрын аялал", operator_name: "", route_name: `Тест-${id}`, duration_text: "5 өдөр 4 шөнө",
    adult_price: null, child_price: null, infant_price: null, currency: "MNT", departure_dates: [],
    seats_total: null, seats_left: null, has_food: null, status: "active", notes: "", hotel: "",
    source_description: "", photo_urls: [], created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    extra: { ...(extra ?? {}) },
    ...rest,
  };
}

/** One dated price row. */
function priceRow(date: string, adult: number | null, more: Record<string, unknown> = {}) {
  return {
    label: date, dates: [date], display_dates: [date], date_keys: [date], adult_price: adult, adult_price_range: null,
    child_price: null, infant_price: null, child_age: "", infant_age: "", passenger_prices: [], note: "", ...more,
  };
}

/** A trip with one dated fare per (date, adult) pair. */
function datedTrip(id: string, fares: Array<[string, number | null]>, over: TripOverrides = {}): TravelTrip {
  const { extra, ...rest } = over;
  return trip(id, {
    departure_dates: fares.map(([date]) => date),
    ...rest,
    extra: { price_groups: fares.map(([date, adult]) => priceRow(date, adult)), ...(extra ?? {}) },
  });
}

const emptyConfig = (over: Partial<CatalogueEditionConfig> = {}): CatalogueEditionConfig =>
  ({ tripIds: [], groupOverrides: {}, featuredTripIds: [], excludedTripIds: [], ...over });

function inputOf(trips: TravelTrip[], over: Partial<SnapshotInput> = {}): SnapshotInput {
  const codeMap = Object.fromEntries(trips.map((t, i) => [t.id, `A${String(i + 1).padStart(2, "0")}`]));
  return {
    edition: "complete", nowIso: NOW, trips, posterByTripId: {}, config: emptyConfig(), codeMap,
    contactPhones: ["7713 6633", "9117 2769"], siteBaseUrl: "https://example.test", ...over,
  };
}

/* ---------------------------------------------------------------- starting price */

test("starting price is the minimum ADULT fare among future departures, with the date it belongs to", () => {
  const t = datedTrip("min1", [["2027-01-09", 3_980_000], ["2027-02-06", 3_450_000], ["2027-03-06", 3_700_000]]);
  const { price, warnings } = deriveStartingPrice(t, TODAY);
  assert.deepEqual(price, { kind: "from", amountMnt: 3_450_000, date: "2027-02-06", display: "3,450,000₮-с" });
  assert.deepEqual(warnings, []);
});

test("a cheaper PAST departure never sets the starting price", () => {
  const t = datedTrip("min2", [["2026-10-01", 900_000], ["2026-11-06", 950_000], ["2026-12-04", 2_100_000]]);
  const { price } = deriveStartingPrice(t, TODAY);
  assert.equal(price.kind, "from");
  assert.equal(price.kind === "from" && price.amountMnt, 2_100_000);
  assert.equal(price.kind === "from" && price.date, "2026-12-04");
});

test("child, infant and single-room fares are never the starting price", () => {
  const t = datedTrip("min3", [["2027-01-09", 3_000_000]]);
  (t.extra.price_groups as Array<Record<string, unknown>>)[0] = priceRow("2027-01-09", 3_000_000, {
    child_price: 1_200_000, infant_price: 300_000, single_price: 450_000,
    passenger_prices: [{ label: "Хүүхэд", age_range: "2-11 нас", price: 1_200_000, currency: "MNT" }],
  });
  const { price } = deriveStartingPrice(t, TODAY);
  assert.equal(price.kind === "from" && price.amountMnt, 3_000_000);
});

test("a date sold per hotel takes the cheapest hotel; nothing is summed", () => {
  const t = trip("hotel1", {
    departure_dates: ["2027-01-09"],
    extra: { price_groups: [
      priceRow("2027-01-09", 4_200_000, { hotel: "Тест Резорт А" }),
      priceRow("2027-01-09", 3_600_000, { hotel: "Тест Резорт Б" }),
    ] },
  });
  const { price } = deriveStartingPrice(t, TODAY);
  assert.equal(price.kind === "from" && price.amountMnt, 3_600_000);
});

test("a sold-out date is not offered: its cheaper fare is ignored", () => {
  const t = datedTrip("soldout1", [["2027-01-09", 1_000_000], ["2027-02-06", 1_800_000]], {
    extra: { website_departure_availability: [
      { date: "2027-01-09", status: "SOLD_OUT", seatsLeft: 0 },
      { date: "2027-02-06", status: "OPEN", seatsLeft: 12 },
    ] },
  });
  const { price } = deriveStartingPrice(t, TODAY);
  assert.equal(price.kind === "from" && price.amountMnt, 1_800_000);
  assert.deepEqual(deriveDateInfo(t, TODAY).departures, ["2027-02-06"]);
});

test("missing dated fare gives 'Үнэ лавлах' and a price_missing warning, never a guess", () => {
  const t = datedTrip("nofare1", [["2027-01-09", null]], { adult_price: null });
  const { price, warnings } = deriveStartingPrice(t, TODAY);
  assert.deepEqual(price, { kind: "inquire", display: "Үнэ лавлах" });
  assert.ok(warnings.some((w) => w.code === "price_missing" && w.tripId === "nofare1"));
});

test("a zero or placeholder adult fare is missing data (price_zero), never free and never the 'from' price", () => {
  const zero = datedTrip("zero1", [["2027-01-09", 0]]);
  const a = deriveStartingPrice(zero, TODAY);
  assert.equal(a.price.kind, "inquire");
  assert.ok(a.warnings.some((w) => w.code === "price_zero"));
  assert.ok(a.warnings.some((w) => w.code === "price_missing"));

  const placeholder = datedTrip("zero2", [["2027-01-09", 1]]);
  assert.equal(deriveStartingPrice(placeholder, TODAY).price.kind, "inquire");

  const mixed = datedTrip("zero3", [["2027-01-09", 0], ["2027-02-06", 2_400_000]]);
  const b = deriveStartingPrice(mixed, TODAY);
  assert.equal(b.price.kind === "from" && b.price.amountMnt, 2_400_000);
  assert.equal(b.price.kind === "from" && b.price.date, "2027-02-06");
  assert.ok(b.warnings.some((w) => w.code === "price_zero"));
  assert.ok(b.warnings.some((w) => w.code === "price_missing"), "the date without a fare is reported");
});

test("contradictory fares on one date give 'Үнэ лавлах', not the cheaper one", () => {
  const t = trip("conflict1", {
    departure_dates: ["2027-01-09"],
    extra: { price_groups: [priceRow("2027-01-09", 2_000_000), priceRow("2027-01-09", 2_300_000)] },
  });
  const { price, warnings } = deriveStartingPrice(t, TODAY);
  assert.equal(price.kind, "inquire");
  assert.ok(warnings.some((w) => w.code === "price_missing"));
});

test("a trip with no future departure has no price and says why", () => {
  const t = datedTrip("past1", [["2026-09-01", 1_500_000]]);
  const { price, warnings } = deriveStartingPrice(t, TODAY);
  assert.equal(price.kind, "inquire");
  assert.ok(warnings.some((w) => w.code === "no_future_departure"));
});

test("a weekly-schedule trip is priced from its own fare and shows its schedule text, not an invented date", () => {
  const t = trip("weekly1", { departure_dates: ["Пүрэв гараг бүр"], adult_price: 1_500_000 });
  assert.equal(isTripEligible(t, TODAY).eligible, true);
  const { price } = deriveStartingPrice(t, TODAY);
  assert.equal(price.kind === "from" && price.amountMnt, 1_500_000);
  assert.equal(price.kind === "from" && price.date, null);
  const dates = deriveDateInfo(t, TODAY);
  assert.equal(dates.nextDeparture, null);
  assert.equal(dates.label, "Пүрэв гараг бүр");
});

test("date label never invents a schedule", () => {
  const none = deriveDateInfo(datedTrip("lbl0", [["2026-01-01", 1_000_000]]), TODAY);
  assert.equal(none.label, "Явах огноог лавлана");
  assert.equal(none.nextDeparture, null);
  const one = deriveDateInfo(datedTrip("lbl1", [["2027-01-09", 1_000_000]]), TODAY);
  assert.equal(one.label, "Хөдлөх огноо: 2027.01.09");
  const many = deriveDateInfo(datedTrip("lbl2", Array.from({ length: 16 }, (_, i) => [`2027-${String(Math.floor(i / 2) + 1).padStart(2, "0")}-${i % 2 ? "20" : "06"}`, 1_000_000] as [string, number])), TODAY);
  assert.equal(many.departures.length, 12, "at most 12 departures are kept");
  assert.match(many.label, /болон өөр 13 огноо$/);
});

/* ---------------------------------------------------------------- eligibility */

test("eligibility: active, visible, with a bookable future departure", () => {
  const ok = datedTrip("el0", [["2027-01-09", 1_000_000]]);
  assert.deepEqual(isTripEligible(ok, TODAY), { eligible: true, reason: null });
  for (const status of ["archived", "draft", "paused", "sold_out", "cancelled"] as const) {
    const verdict = isTripEligible(datedTrip(`el-${status}`, [["2027-01-09", 1_000_000]], { status }), TODAY);
    assert.equal(verdict.eligible, false, status);
    assert.ok(verdict.reason, status);
  }
  assert.equal(isTripEligible(datedTrip("el-hidden", [["2027-01-09", 1_000_000]], { extra: { customer_visible: false } }), TODAY).eligible, false);
  assert.equal(isTripEligible(datedTrip("el-web", [["2027-01-09", 1_000_000]], { extra: { website_published: false } }), TODAY).eligible, false);
  assert.equal(isTripEligible(trip("el-noname", { route_name: "  ", departure_dates: ["2027-01-09"] }), TODAY).eligible, false);
});

test("eligibility: expired, departed and fully sold-out departures exclude the trip", () => {
  const expired = isTripEligible(datedTrip("ex1", [["2026-10-01", 1_000_000], ["2026-11-06", 1_000_000]]), TODAY);
  assert.equal(expired.eligible, false, "a departure today is not bookable");
  assert.match(expired.reason ?? "", /ирээдүйн огноо алга/);

  const soldOut = datedTrip("ex2", [["2027-01-09", 1_000_000]], {
    extra: { website_departure_availability: [{ date: "2027-01-09", status: "SOLD_OUT", seatsLeft: 0 }] },
  });
  assert.equal(isTripEligible(soldOut, TODAY).eligible, false);

  const noDates = isTripEligible(trip("ex3", { adult_price: 1_000_000 }), TODAY);
  assert.equal(noDates.eligible, false);
  assert.match(noDates.reason ?? "", /Явах огноо/);
});

/* ---------------------------------------------------------------- overview vs dated fare */

test("REGRESSION: overview prose says 3,880,000₮ but the dated 2027 fare is 3,980,000₮ -> price_conflict, dated fare printed", () => {
  const t = datedTrip("overview-shape", [["2027-01-09", 3_980_000]], {
    adult_price: 3_880_000, // the stale summary figure is on the trip too
    notes: "2027-01-09-нд шууд ниснэ. Том хүний үнэ 3,880,000₮. Хүүхдийн үнэ 580,000₮–3,580,000₮; нас, нөхцөлөөр ажилтан тодруулна.",
    extra: { website_details: { description: "Шууд нислэг. Том хүний үнэ 3,880,000₮." } },
  });
  const { price } = deriveStartingPrice(t, TODAY);
  assert.deepEqual(price, { kind: "from", amountMnt: 3_980_000, date: "2027-01-09", display: "3,980,000₮-с" });

  const conflicts = findOverviewPriceConflicts(t, TODAY);
  assert.ok(conflicts.length >= 2, "notes and the website description both quote the stale figure");
  for (const c of conflicts) {
    assert.equal(c.code, "price_conflict");
    assert.equal(c.severity, "warning");
    assert.equal(c.tripId, "overview-shape");
    assert.equal(c.detail?.overviewMnt, 3_880_000, "the child range 580,000-3,580,000 is not an adult claim");
    assert.equal(c.detail?.datedMnt, 3_980_000);
    assert.equal(c.detail?.staleCheaper, true);
  }
  assert.deepEqual(conflicts.map((c) => c.detail?.field).sort(), ["notes", "website_description"]);

  // The conflict reaches the card and the collection, and the card still prints the dated fare.
  const snap = buildCatalogueSnapshot(inputOf([t]));
  assert.equal(snap.trips[0].price.display, "3,980,000₮-с");
  assert.ok(snap.warnings.some((w) => w.code === "price_conflict"));
  const { warnings: _staffOnly, ...printed } = snap.trips[0];
  assert.ok(!JSON.stringify(printed).includes("3,880,000"), "the stale overview figure is never printed");
});

test("prose that agrees with a dated fare, or quotes only child / deposit / foreign amounts, is not a conflict", () => {
  const agree = datedTrip("prose1", [["2027-01-09", 3_980_000], ["2027-02-06", 3_450_000]], { notes: "Эхлэх үнэ 3,450,000₮, 1-р сард 3,980,000₮." });
  assert.deepEqual(findOverviewPriceConflicts(agree, TODAY), []);
  const other = datedTrip("prose2", [["2027-01-09", 3_980_000]], {
    notes: "Хүүхдийн үнэ 2,000,000₮. Урьдчилгаа 500,000₮. Нэмэлт аялал 150$ эсвэл 1,200 юань. Хөнгөлөлт 200,000₮.",
  });
  assert.deepEqual(findOverviewPriceConflicts(other, TODAY), []);
});

test("no dated fare means nothing to compare: no conflict is invented", () => {
  const t = datedTrip("prose3", [["2027-01-09", null]], { notes: "Үнэ 3,880,000₮" });
  assert.deepEqual(findOverviewPriceConflicts(t, TODAY), []);
});

test("prose price reader: units, separators, foreign currency", () => {
  const amounts = (s: string) => extractMntAmounts(s).filter((a) => !a.nonAdult).map((a) => a.amountMnt);
  assert.deepEqual(amounts("Үнэ 3,880,000₮"), [3_880_000]);
  assert.deepEqual(amounts("3 880 000 төгрөг"), [3_880_000]);
  assert.deepEqual(amounts("3.88 сая ₮-өөс"), [3_880_000]);
  assert.deepEqual(amounts("990 мянган төгрөг"), [990_000]);
  assert.deepEqual(amounts("Нэг хүний үнэ 3 880 000"), [3_880_000]);
  assert.deepEqual(amounts("Виз 150 USD, 1,500 юань, $200"), []);
  assert.deepEqual(amounts("Утас 7713 6633, 2027.01.09"), []);
  assert.equal(extractMntAmounts("Хүүхдийн үнэ 2,000,000₮")[0].nonAdult, true);
});

/* ---------------------------------------------------------------- highlights */

test("highlights: at most three, real, short; staff and bot copy never reaches a card", () => {
  const t = datedTrip("hl1", [["2027-01-09", 2_000_000]], {
    extra: {
      website_details: { highlights: [
        "Далайн эрэг дээрх амралт",
        "Бот хэрэглэгчээс асуувал заавал хэлнэ", // bot instruction
        "Эх сурвалж: админ шалгана", // staff note
        "Хямдрал 20% зөвхөн энэ сард", // promotion
        "Үнэ 1,500,000₮-өөс эхэлнэ", // price
        "Мэргэжлийн хөтөчтэй", // fine as a curated line
        "Усан паркийн орох эрх",
        "Дөрөв дэх мөр",
      ] },
    },
  });
  const { highlights, warnings } = deriveHighlights(t);
  assert.deepEqual(highlights, ["Далайн эрэг дээрх амралт", "Мэргэжлийн хөтөчтэй", "Усан паркийн орох эрх"]);
  assert.ok(warnings.some((w) => w.code === "internal_copy_dropped"));
  assert.ok(highlights.every((line) => line.length <= 60));
});

test("highlights: program titles that name a sight count; transfers, route legs, meals and free days do not", () => {
  const t = datedTrip("hl2", [["2027-01-09", 2_000_000]], {
    extra: {
      itinerary_days: [
        { day: 1, title: "УЛААНБААТАР – ЗАМЫН ҮҮД" }, // standard transfer day
        { day: 2, title: "ТЕСТ ХӨДӨӨ – ЖИШИГ ХОТ" }, // route leg
        { day: 3, title: "Чөлөөт өдөр" },
        { day: 4, title: "ЖИШИГ УСАН ПАРК" },
        { day: 5, title: "Хотын аялал" }, // generic
        { day: 6, title: "ТЕСТ НУУРЫН АЯЛАЛ" },
        { day: 7, title: "Нислэгээр буцах" },
      ],
      included_items: ["Өглөөний цай", "Нислэгийн тийз", "Тест музейд орох тасалбар"],
    },
  });
  const { highlights } = deriveHighlights(t);
  assert.deepEqual(highlights, ["Жишиг Усан Парк", "Тест Нуурын Аялал", "Тест музейд орох тасалбар"]);
});

test("highlights: a '<place> – <sight>, <sight>' day title gives its sights one by one; a bare route gives nothing", () => {
  const t = datedTrip("hl4", [["2027-01-09", 2_000_000]], {
    extra: {
      itinerary_days: [
        { day: 1, title: "Тест-Хот – Жишиг Усан Парк" },
        { day: 2, title: "Жишиг-Хот – Тест Нуур, Хөдөөгийн цэцэрлэгт хүрээлэн" },
        { day: 3, title: "Тест-Хот – Жишиг-Арал" }, // a place, not a sight
        { day: 4, title: "Жишиг-Хөдөө – Тест-Хот – Жишиг-Хот" },
      ],
    },
  });
  assert.deepEqual(deriveHighlights(t).highlights, ["Жишиг Усан Парк", "Тест Нуур", "Хөдөөгийн цэцэрлэгт хүрээлэн"]);
});

test("highlights: nothing real means none and a warning, never filler", () => {
  const t = datedTrip("hl3", [["2027-01-09", 2_000_000]], { extra: { included_items: ["Нислэгийн тийз", "Зочид буудал"] } });
  const { highlights, warnings } = deriveHighlights(t);
  assert.deepEqual(highlights, []);
  assert.ok(warnings.some((w) => w.code === "highlights_missing"));
});

test("customer-copy filter keeps what the printed brochure keeps and drops what it drops", () => {
  assert.equal(customerText("Шууд нислэгтэй, 5 одтой буудал"), "Шууд нислэгтэй, 5 одтой буудал");
  assert.equal(customerText("Chatbot хэрэглэгчид заавал хэлнэ"), "");
  assert.equal(customerText("Эх сурвалж шалгах шаардлагатай"), "");
});

/* ---------------------------------------------------------------- groups */

test("groups come from the trip's own metadata; the cheapest tier is computed; unknown is 'Бусад' with a warning", () => {
  const beach = datedTrip("g-beach", [["2027-01-09", 4_000_000]], { route_name: "Тест далайн эрэг" });
  const city = datedTrip("g-city", [["2027-01-09", 3_800_000]], { route_name: "Жишиг шопинг аялал" });
  const nature = datedTrip("g-nature", [["2027-01-09", 3_900_000]], { route_name: "Тест нуур, уулын адал явдал" });
  const cheap = datedTrip("g-cheap", [["2027-01-09", 900_000]], { route_name: "Хөнгөн-1" });
  const plain = datedTrip("g-plain", [["2027-01-09", 4_100_000]], { route_name: "Хөнгөн-2" });
  const items = [beach, city, nature, cheap, plain].map((t) => ({ trip: t, priceMnt: (deriveStartingPrice(t, TODAY).price as { amountMnt: number }).amountMnt }));
  const decisions = classifyTrips(items);
  assert.equal(decisions.get("g-beach")?.groupKey, "beach");
  assert.equal(decisions.get("g-city")?.groupKey, "city");
  assert.equal(decisions.get("g-nature")?.groupKey, "nature");
  assert.equal(decisions.get("g-cheap")?.groupKey, "budget");
  assert.equal(decisions.get("g-plain")?.groupKey, "other");
  assert.ok(decisions.get("g-plain")?.warnings.some((w) => w.code === "category_unknown"));
  assert.deepEqual(decisions.get("g-beach")?.warnings, []);
});

test("a destination word alone never assigns a group: only theme words do", () => {
  const t = datedTrip("g-name", [["2027-01-09", 4_000_000]], { route_name: "Тест-Далай-Эрдэнэ" });
  // 'далай' is a theme stem (sea); a made-up place without one stays unknown
  const unknown = datedTrip("g-unk", [["2027-01-09", 4_000_000]], { route_name: "Жишиг-Хөдөө" });
  const d = classifyTrips([{ trip: t, priceMnt: 4_000_000 }, { trip: unknown, priceMnt: 4_000_000 }]);
  assert.equal(d.get("g-unk")?.groupKey, "other");
});

test("admin override beats every derived group; an unknown override key is ignored with a note", () => {
  const t = datedTrip("g-ovr", [["2027-01-09", 4_000_000]], { route_name: "Тест далайн эрэг" });
  const u = datedTrip("g-ovr2", [["2027-01-09", 4_000_000]], { route_name: "Жишиг-Хөдөө" });
  const d = classifyTrips([{ trip: t, priceMnt: 4_000_000 }, { trip: u, priceMnt: 4_000_000 }], { "g-ovr": "city", "g-ovr2": "no-such-group" });
  assert.equal(d.get("g-ovr")?.groupKey, "city");
  assert.equal(d.get("g-ovr2")?.groupKey, "other");
  assert.ok(d.get("g-ovr2")?.warnings.some((w) => w.severity === "info"));
});

test("budget cutoff is 60% of the median and needs two priced trips", () => {
  assert.equal(budgetCutoff([1_000_000]), null);
  assert.equal(budgetCutoff([1_000_000, 3_000_000]), 1_200_000);
  assert.equal(budgetCutoff([0, 1_000_000, 3_000_000, 5_000_000]), 1_800_000);
});

test("buildGroups lists non-empty groups in display order with codes in card order", () => {
  const groups = buildGroups([
    { code: "A01", groupKey: "other" }, { code: "A02", groupKey: "beach" }, { code: "A03", groupKey: "city" }, { code: "A04", groupKey: "beach" },
  ]);
  assert.deepEqual(groups.map((g) => [g.key, g.codes]), [["beach", ["A02", "A04"]], ["city", ["A03"]], ["other", ["A01"]]]);
  assert.ok(groups.every((g) => g.label));
});

/* ---------------------------------------------------------------- selection: quick vs complete */

function manyTrips(count: number): TravelTrip[] {
  return Array.from({ length: count }, (_, i) => datedTrip(`m${String(i + 1).padStart(2, "0")}`, [["2027-01-09", 1_000_000 + i * 100_000]], { route_name: `Жишиг-${i + 1}` }));
}

test("quick edition follows the admin's list in the admin's order, capped at the maximum", () => {
  const trips = manyTrips(16);
  const order = [...trips].reverse().map((t) => t.id); // 16 ids, reversed
  const snap = buildCatalogueSnapshot(inputOf(trips, { edition: "quick", config: emptyConfig({ tripIds: order }) }));
  assert.equal(snap.trips.length, CATALOGUE_QUICK_MAX_TRIPS);
  assert.deepEqual(snap.trips.map((c) => c.tripId), order.slice(0, CATALOGUE_QUICK_MAX_TRIPS));
  assert.equal(snap.warnings.some((w) => w.severity === "info" && /хасагдлаа/.test(w.message)), true);
});

test("quick edition below the minimum warns; empty is blocking", () => {
  const trips = manyTrips(5);
  const few = buildCatalogueSnapshot(inputOf(trips, { edition: "quick", config: emptyConfig({ tripIds: trips.map((t) => t.id) }) }));
  assert.equal(few.trips.length, 5);
  assert.ok(few.warnings.some((w) => w.severity === "warning" && w.detail?.count === 5), `needs at least ${CATALOGUE_QUICK_MIN_TRIPS}`);
  const none = buildCatalogueSnapshot(inputOf(trips, { edition: "quick", config: emptyConfig() }));
  assert.equal(none.trips.length, 0);
  assert.ok(none.warnings.some((w) => w.severity === "blocking"));
});

test("quick edition reports and skips a curated trip that is no longer sellable", () => {
  const good = datedTrip("q-good", [["2027-01-09", 1_000_000]]);
  const gone = datedTrip("q-gone", [["2026-09-01", 1_000_000]]);
  const snap = buildCatalogueSnapshot(inputOf([good, gone], { edition: "quick", config: emptyConfig({ tripIds: ["q-gone", "q-good", "q-missing"] }) }));
  assert.deepEqual(snap.trips.map((c) => c.tripId), ["q-good"]);
  assert.equal(snap.warnings.filter((w) => w.tripId === "q-gone" && w.code === "no_future_departure").length, 1);
  assert.equal(snap.warnings.filter((w) => w.tripId === "q-missing").length, 1);
});

test("complete edition prints every eligible trip, none of the closed ones, honours staff exclusions and order", () => {
  const open = manyTrips(14);
  const closed = [
    datedTrip("c-draft", [["2027-01-09", 1_000_000]], { status: "draft" }),
    datedTrip("c-past", [["2026-01-09", 1_000_000]]),
    datedTrip("c-hidden", [["2027-01-09", 1_000_000]], { extra: { customer_visible: false } }),
  ];
  const trips = [...closed, ...open];
  const input = inputOf(trips, { config: emptyConfig({ tripIds: ["m05", "m02"], excludedTripIds: ["m09"], featuredTripIds: ["m14"] }) });
  const snap = buildCatalogueSnapshot(input);
  const ids = snap.trips.map((c) => c.tripId);
  assert.equal(ids.length, 13, "14 open minus the staff-excluded one; the closed ones never appear");
  assert.ok(!ids.some((id) => id.startsWith("c-")));
  assert.ok(!ids.includes("m09"));
  assert.equal(ids[0], "m14", "featured first");
  assert.deepEqual(ids.slice(1, 3), ["m05", "m02"], "the admin's order, then by trip code");
});

test("a trip without a code, or sharing a code, is never printed and is blocking", () => {
  const a = datedTrip("k1", [["2027-01-09", 1_000_000]]);
  const b = datedTrip("k2", [["2027-01-09", 1_000_000]]);
  const c = datedTrip("k3", [["2027-01-09", 1_000_000]]);
  const snap = buildCatalogueSnapshot(inputOf([a, b, c], { codeMap: { k1: "A01", k2: "A01" } }));
  assert.deepEqual(snap.trips.map((x) => x.tripId), ["k1"]);
  assert.equal(snap.warnings.filter((w) => w.code === "code_collision" && w.severity === "blocking").length, 2);
});

test("planEdition: preview is capped like quick and excludes closed trips", () => {
  const trips = [datedTrip("p1", [["2027-01-09", 1_000_000]]), datedTrip("p2", [["2026-01-09", 1_000_000]])];
  const plan = planEdition({ edition: "preview", trips, config: emptyConfig({ tripIds: ["p1", "p2"] }) }, TODAY);
  assert.deepEqual(plan.trips.map((t) => t.id), ["p1"]);
  assert.equal(plan.warnings.length, 1);
});

/* ---------------------------------------------------------------- snapshot: determinism, shape, contact */

test("the snapshot and its hash are deterministic; the hash follows what is printed, not when it was built", () => {
  const build = (nowIso: string, fare = 3_980_000) => buildCatalogueSnapshot(inputOf([
    datedTrip("d1", [["2027-01-09", fare]], { route_name: "Тест далайн эрэг" }),
    datedTrip("d2", [["2027-02-06", 1_500_000]], { route_name: "Жишиг-Хөдөө" }),
  ], { nowIso }));
  const one = build(NOW);
  const two = build(NOW);
  assert.deepEqual(one, two);
  assert.match(one.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(build("2026-11-06T09:30:00.000Z").contentHash, one.contentHash, "same day, same print -> same hash");
  assert.notEqual(build(NOW, 3_990_000).contentHash, one.contentHash, "a changed dated fare changes the hash");
  assert.notEqual(build("2026-11-07T04:00:00.000Z").contentHash, one.contentHash, "the issue date is printed");
  // input order of an unordered collection does not matter
  const reversed = buildCatalogueSnapshot(inputOf([
    datedTrip("d2", [["2027-02-06", 1_500_000]], { route_name: "Жишиг-Хөдөө" }),
    datedTrip("d1", [["2027-01-09", 3_980_000]], { route_name: "Тест далайн эрэг" }),
  ], { codeMap: { d1: "A01", d2: "A02" } }));
  assert.equal(reversed.contentHash, one.contentHash);
});

test("the snapshot carries the printed facts: code, title, duration, transport, link, dates, issue and season labels", () => {
  const t = datedTrip("s1", [["2027-01-09", 3_980_000]], {
    route_name: "Тест далайн эрэг", duration_text: "8 өдөр 7 шөнө",
    extra: { transport_type: "direct_flight", website_slug: "test-slug", website_published: true, destinations: ["Тест-Арал"],
      website_details: { country: "Тест-Улс", region: "Тест-Бүс" }, photo_credits: { "https://img.example.test/a.jpg": { author: "Зохиогч", license: "CC BY" } } },
    photo_urls: ["https://img.example.test/a.jpg"],
  });
  const snap = buildCatalogueSnapshot(inputOf([t]));
  const [card] = snap.trips;
  assert.equal(card.code, "A01");
  assert.equal(card.title, "Тест далайн эрэг");
  assert.equal(card.kicker, "Тест-Бүс / Тест-Улс");
  assert.equal(card.durationText, "8 өдөр 7 шөнө");
  assert.equal(card.transportLabel, "Шууд нислэг");
  assert.equal(card.detailUrl, "https://example.test/mn/trips/test-slug");
  assert.equal(card.dates.label, "Хөдлөх огноо: 2027.01.09");
  assert.equal(card.photo?.url, "https://img.example.test/a.jpg");
  assert.equal(card.photo?.credit, "Зохиогч, CC BY");
  assert.equal(snap.issueLabel, "2026.11.06");
  assert.equal(snap.seasonLabel, "2026 / 2027");
  assert.equal(snap.asOfDay, TODAY);
  assert.equal(snap.generatedAt, NOW);
  assert.equal(snap.groups.flatMap((g) => g.codes).join(), "A01");
  assert.equal(snap.warnings.some((w) => w.severity === "blocking"), false);
});

test("an unpublished website page gives no detail link, never a guessed one", () => {
  const t = datedTrip("s2", [["2027-01-09", 3_980_000]], { extra: { website_slug: "x-slug", website_published: false } });
  assert.equal(isTripEligible(t, TODAY).eligible, false);
  const t2 = datedTrip("s3", [["2027-01-09", 3_980_000]]);
  assert.equal(buildCatalogueSnapshot(inputOf([t2])).trips[0].detailUrl, null);
});

test("contact: configured phones only (max three, 4+4), the site, no address", () => {
  assert.deepEqual(parsePhones("+976 7713-6633, 91172769 / 9911 0000, 8800 1111"), ["7713 6633", "9117 2769", "9911 0000"]);
  assert.deepEqual(parsePhones("тодорхойгүй"), []);
  assert.deepEqual(buildContact("7713 6633", "https://www.example.test/mn"), { phones: ["7713 6633"], siteLabel: "example.test", siteUrl: "https://www.example.test" });
  assert.equal(buildContact([], "not a url").siteLabel, "uudamtravel.mn");
  const none = buildCatalogueSnapshot(inputOf([datedTrip("ct1", [["2027-01-09", 1_000_000]])], { contactPhones: [] }));
  assert.ok(none.warnings.some((w) => w.severity === "blocking" && /утас/.test(w.message)));
  assert.equal(JSON.stringify(buildContact("7713 6633", "https://example.test")).includes("address"), false);
});

/* ---------------------------------------------------------------- photos */

test("photo: poster hero first, then trip photos; a small known size loses to an unknown one; none gives a warning", () => {
  const t = trip("ph1", { photo_urls: ["https://img.example.test/trip.jpg"] });
  assert.equal(pickPhoto(t, { hero_image: "https://img.example.test/hero.jpg" }).photo?.source, "poster_hero");
  assert.equal(pickPhoto(t, {}).photo?.source, "trip_photo");
  assert.equal(pickPhoto(trip("ph2"), { days: [{ photo: "https://img.example.test/day.jpg" }] }).photo?.source, "poster_day");

  const small = pickPhoto(t, { hero_image: "https://img.example.test/320px-hero.jpg" });
  assert.equal(small.photo?.url, "https://img.example.test/trip.jpg", "a 320px hero loses to a photo of unknown size");

  const onlySmall = pickPhoto(trip("ph3"), { hero_image: "https://img.example.test/320px-hero.jpg" });
  assert.equal(onlySmall.photo?.width, 320);
  assert.ok(onlySmall.warnings.some((w) => w.code === "photo_low_resolution"));

  const none = pickPhoto(trip("ph4", { photo_urls: ["data:image/png;base64,AAAA", "http://insecure.example.test/a.jpg", "https://img.example.test/x.svg"] }), { hero_image: "data:image/png;base64,AAAA" });
  assert.equal(none.photo, null);
  assert.ok(none.warnings.some((w) => w.code === "photo_missing"));
});

/* ---------------------------------------------------------------- live drift */

test("liveDrift: a trip that closed, a changed dated fare or a removed departure make a published file stale; a new trip does not", () => {
  const base = [
    datedTrip("f1", [["2027-01-09", 3_980_000], ["2027-02-06", 4_100_000]]),
    datedTrip("f2", [["2027-01-09", 1_500_000]]),
    datedTrip("f3", [["2027-03-06", 2_000_000]]),
  ];
  const published = buildCatalogueSnapshot(inputOf(base));
  assert.deepEqual(liveDrift(published, buildCatalogueSnapshot(inputOf(base))), { drifted: false, reasons: [] });

  const closed = buildCatalogueSnapshot(inputOf([base[0], base[1], { ...base[2], status: "sold_out" as const }], { codeMap: { f1: "A01", f2: "A02", f3: "A03" } }));
  const a = liveDrift(published, closed);
  assert.equal(a.drifted, true);
  assert.match(a.reasons.join("\n"), /A03/);

  const repriced = [datedTrip("f1", [["2027-01-09", 4_300_000], ["2027-02-06", 4_100_000]]), base[1], base[2]];
  const b = liveDrift(published, buildCatalogueSnapshot(inputOf(repriced)));
  assert.equal(b.drifted, true);
  assert.match(b.reasons.join("\n"), /A01.*3,980,000₮-с → 4,100,000₮-с/);

  const lessDates = [datedTrip("f1", [["2027-01-09", 3_980_000]]), base[1], base[2]];
  const c = liveDrift(published, buildCatalogueSnapshot(inputOf(lessDates)));
  assert.equal(c.drifted, true);
  assert.match(c.reasons.join("\n"), /2027-02-06/);

  const extra = [...base, datedTrip("f4", [["2027-04-03", 900_000]])];
  const d = liveDrift(published, buildCatalogueSnapshot(inputOf(extra, { codeMap: { f1: "A01", f2: "A02", f3: "A03", f4: "A04" } })));
  assert.deepEqual(d, { drifted: false, reasons: [] }, "a new trip only makes the file older, nothing in it is false");
});

/* ------------------------------------------------------------------ kicker (line above the headline) */

const INVENTED_FIXED = ["Тест-Гарц", "Тест-Хил"];

test("kicker: staff-written region / country wins; a region alone is kept", () => {
  assert.equal(deriveKicker({ title: "Жишиг аялал", region: "Тест-Бүс", country: "Тест-Улс", destinations: ["Тест-Арал"] }), "Тест-Бүс / Тест-Улс");
  assert.equal(deriveKicker({ title: "Жишиг аялал", region: "Тест-Улс", country: "Тест-Улс" }), "Тест-Улс");
  assert.equal(deriveKicker({ title: "Жишиг аялал", country: "Тест-Улс" }), "Тест-Улс");
  assert.equal(deriveKicker({ title: "Жишиг аялал", region: "Тест-Бүс" }), "Тест-Бүс");
});

test("kicker: transit and border legs listed first in the route are never the headline place", () => {
  // the shape of the live defect: the route starts with border / hub legs, the title names the real places
  const title = "Жишиг-Хот — Тест-Арал нислэгтэй";
  const route = ["Тест-Хил", "Тест-Гарц", "Тест-Арал", "Жишиг-Хот", "Туршилт-Зам"];
  assert.equal(deriveKicker({ title, destinations: route, fixedPoints: INVENTED_FIXED }), "Тест-Арал · Жишиг-Хот");
  // even a fixed point the TITLE names is not promoted (a land route that starts at the border)
  assert.equal(deriveKicker({ title: "Тест-Хил — Жишиг-Хот — Тест-Арал", destinations: route, fixedPoints: INVENTED_FIXED }), "Тест-Арал · Жишиг-Хот");
});

test("kicker: a destination the title does not name is never promoted; no trustworthy place means no kicker", () => {
  assert.equal(deriveKicker({ title: "Жишиг аялал", destinations: ["Тест-Арал", "Туршилт-Зам"], fixedPoints: INVENTED_FIXED }), "");
  assert.equal(deriveKicker({ title: "Тест-Арал аялал", destinations: ["Тест-Арал", "Туршилт-Зам"], fixedPoints: INVENTED_FIXED }), "Тест-Арал");
  assert.equal(deriveKicker({ title: "", destinations: ["Тест-Арал"] }), "");
  assert.equal(deriveKicker({ title: "Тест-Арал", destinations: [] }), "");
  assert.equal(deriveKicker({ title: "Тест-Арал", destinations: ["Latin-Spelling Island"] }), "", "another script cannot be matched to the title");
});

test("kicker: a place the title marks as a starting point (-аас / -ээс / -оос / -өөс) is not a destination", () => {
  const route = ["Жишиг-Хот", "Тест-Арал"];
  assert.equal(titleAnchoredPlaces("Жишиг-Хотоос Тест-Арал руу", route, INVENTED_FIXED).join("|"), "Тест-Арал");
  assert.equal(titleAnchoredPlaces("Тест-Аралаас Жишиг-Хот руу", route, INVENTED_FIXED).join("|"), "Жишиг-Хот");
  assert.equal(titleAnchoredPlaces("ЖИШИГ ХОТООС ТЕСТ АРАЛ", route, INVENTED_FIXED).join("|"), "Тест-Арал", "case and spacing do not matter");
});

test("kicker: spelling drift in endings and spacing still matches; duplicates collapse; at most two places", () => {
  assert.equal(titleAnchoredPlaces("ТЕСТ АРАЛЫН ЖИШИГ ХОТЫН АЯЛАЛ", ["Тест-Арал", "Жишиг-Хот"], INVENTED_FIXED).join("|"), "Тест-Арал|Жишиг-Хот");
  assert.equal(titleAnchoredPlaces("Тест-Арал аялал", ["Тест Арал", "Тест-Арал", "Тест-арал"], INVENTED_FIXED).join("|"), "Тест Арал");
  const many = ["Алфа-Хот", "Бета-Хот", "Гамма-Хот", "Дельта-Хот"];
  assert.equal(titleAnchoredPlaces("Алфа-Хот Бета-Хот Гамма-Хот Дельта-Хот", many, INVENTED_FIXED).length, 2);
});

test("kicker: the agency's own departure city and border points are dropped by default, even when the title names them", () => {
  const [home, border] = STANDARD_DAYS.departure.title.split(/\s*[–—-]\s*/u);
  assert.ok(home && border);
  assert.equal(deriveKicker({ title: `${home} – ${border} – Тест-Арал нислэгтэй`, destinations: [home, border, "Тест-Арал"] }), "Тест-Арал");
  assert.equal(deriveKicker({ title: "УБ-Тест-Арал", destinations: ["УБ", "Тест-Арал"] }), "Тест-Арал");
});

test("kicker: the snapshot card carries the trustworthy kicker, not the first route entries", () => {
  const t = datedTrip("k1", [["2027-01-09", 3_980_000]], {
    route_name: "Тест-Арал — Жишиг-Хот нислэгтэй",
    extra: { transport_type: "land_flight", destinations: ["Туршилт-Хил", "Туршилт-Төв", "Жишиг-Хот", "Тест-Арал"] },
  });
  const [card] = buildCatalogueSnapshot(inputOf([t])).trips;
  assert.equal(card.kicker, "Жишиг-Хот · Тест-Арал", "route order is kept, legs the title does not name are not shown");
  const bare = datedTrip("k2", [["2027-01-09", 3_980_000]], { route_name: "Жишиг аялал", extra: { destinations: ["Туршилт-Хил", "Туршилт-Төв"] } });
  assert.equal(buildCatalogueSnapshot(inputOf([bare], { codeMap: { k2: "A01" } })).trips[0].kicker, "");
});

/* ------------------------------------------------------------------ adversarial-review regressions */

test("REGRESSION: free text that is neither a date nor a weekly pattern is NOT a schedule: ineligible, no price, no printed date", () => {
  for (const departure of ["2026 оны 9 сар", "Лавлана", "Өвөл", "Тун удахгүй"]) {
    const t = trip("vague", { departure_dates: [departure], adult_price: 2_000_000 });
    const eligibility = isTripEligible(t, TODAY);
    assert.equal(eligibility.eligible, false, departure);
    assert.match(eligibility.reason ?? "", /тодорхой биш/, departure);
    const { price, warnings } = deriveStartingPrice(t, TODAY);
    assert.equal(price.kind, "inquire", departure);
    assert.ok(warnings.some((w) => w.code === "dates_missing"), departure);
    assert.equal(deriveDateInfo(t, TODAY).label, "Явах огноог лавлана", `${departure}: raw text is never printed as the date line`);
  }
  const weekly = trip("wk", { departure_dates: ["Пүрэв гараг бүр"], adult_price: 1_500_000 });
  const vague = trip("vg", { departure_dates: ["2026 оны 9 сар"], adult_price: 1_500_000 });
  const snap = buildCatalogueSnapshot(inputOf([weekly, vague]));
  assert.deepEqual(snap.trips.map((card) => card.tripId), ["wk"], "the vague-text trip is not printed");
});

test("weekly schedules are recognised in the spellings the live data uses and stay eligible; vague text next to one is ignored", () => {
  for (const departure of ["Пүрэв гараг бүр", "Ням гараг бүр", "Пүрэв, Ням гариг", "Мягмар гаригт 10:00 цагт", "Өдөр бүр", "7 хоног бүр", "Баасан гариг болгон", "Пүрэв"]) {
    assert.equal(isWeeklyScheduleText(departure), true, departure);
  }
  for (const departure of ["2026 оны 9 сар", "Лавлана", "Өвөл", "Бүр", "Пүрэв гараг, 11 сар", "Хоног"]) {
    assert.equal(isWeeklyScheduleText(departure), false, departure);
  }
  const split = trip("wk2", { departure_dates: ["Пүрэв", "Ням гариг"], adult_price: 1_500_000 });
  assert.equal(isTripEligible(split, TODAY).eligible, true);
  assert.equal(deriveDateInfo(split, TODAY).label, "Пүрэв, Ням гариг");
  const mixed = trip("wk3", { departure_dates: ["Лавлана", "Пүрэв гараг бүр"], adult_price: 1_500_000 });
  assert.equal(isTripEligible(mixed, TODAY).eligible, true);
  assert.equal(deriveDateInfo(mixed, TODAY).label, "Пүрэв гараг бүр");
});

test("REGRESSION: liveDrift sees a changed weekly schedule line, duration and transport", () => {
  const weekly = (day: string, over: TripOverrides = {}) => trip("wd1", { departure_dates: [day], adult_price: 1_500_000, extra: { transport_type: "land" }, ...over });
  const published = buildCatalogueSnapshot(inputOf([weekly("Пүрэв гараг бүр")]));
  assert.deepEqual(liveDrift(published, buildCatalogueSnapshot(inputOf([weekly("Пүрэв гараг бүр")]))), { drifted: false, reasons: [] });

  const day = liveDrift(published, buildCatalogueSnapshot(inputOf([weekly("Мягмар гараг бүр")])));
  assert.equal(day.drifted, true);
  assert.match(day.reasons.join("\n"), /Пүрэв гараг бүр.*Мягмар гараг бүр/);

  const longer = liveDrift(published, buildCatalogueSnapshot(inputOf([weekly("Пүрэв гараг бүр", { duration_text: "6 өдөр 5 шөнө" })])));
  assert.equal(longer.drifted, true);
  assert.match(longer.reasons.join("\n"), /5 өдөр 4 шөнө.*6 өдөр 5 шөнө/);

  const flight = liveDrift(published, buildCatalogueSnapshot(inputOf([weekly("Пүрэв гараг бүр", { extra: { transport_type: "direct_flight" } })])));
  assert.equal(flight.drifted, true);
  assert.match(flight.reasons.join("\n"), /Газрын аялал.*Шууд нислэг/);
});

test("REGRESSION: child, instalment, saving and promo amounts are not adult prices; an adult price written with 'өрөө' still is", () => {
  const t = datedTrip("pc1", [["2027-01-09", 3_980_000]]);
  const warningsFor = (notes: string) => findOverviewPriceConflicts({ ...t, notes }, TODAY);
  assert.deepEqual(warningsFor("Том хүн 3,980,000₮. Хүүхэд (2-11 нас) - 3,200,000₮."), [], "a passenger label before a dash belongs to the amount");
  assert.deepEqual(warningsFor("Хуваан төлөх боломжтой: сар бүр 500,000₮"), []);
  assert.deepEqual(warningsFor("Эрт бүртгүүлбэл 200,000₮ хэмнэнэ"), []);
  assert.deepEqual(warningsFor("урамшуулал 150 мянган төгрөг"), []);
  const stale = warningsFor("2 хүний өрөөнд нэг хүнд 3,880,000₮");
  assert.equal(stale.length, 1, "the brochure-regression shape is no longer hidden behind the word өрөө");
  assert.equal(stale[0].detail?.overviewMnt, 3_880_000);

  assert.deepEqual(extractMntAmounts("Хүүхэд 2,000,000₮ - Том хүн 3,880,000₮").map((a) => a.nonAdult), [true, false], "a dash between two priced parts still splits them");
  assert.equal(extractMntAmounts("Хэмнэлттэй аялал 3,880,000₮")[0].nonAdult, false, "the budget group's own name is not a saving");
  assert.equal(extractMntAmounts("Ганцаараа өрөөнд 4,800,000₮")[0].nonAdult, true);
  assert.equal(extractMntAmounts("1 хүний өрөө 4,800,000₮")[0].nonAdult, true);
});

test("REGRESSION: 'бот' and 'дотоод' inside ordinary words no longer drop real sights; staff and bot copy is still dropped", () => {
  const t = trip("hl-bot", { extra: { website_details: { highlights: ["Ботаникийн цэцэрлэг", "Робот шоу", "Ботсвана сафари", "Хотын төвийн алхалт"] } } });
  const { highlights, warnings } = deriveHighlights(t);
  assert.deepEqual(highlights, ["Ботаникийн цэцэрлэг", "Робот шоу", "Ботсвана сафари"]);
  assert.equal(warnings.some((w) => w.code === "internal_copy_dropped"), false, "nothing was internal, so staff are not blamed");
  for (const real of ["Ботаникийн цэцэрлэгт хүрээлэн", "Дотоодын нислэг", "Ботсвана", "Администрацийн барилга"]) assert.equal(customerText(real), real, real);
  for (const internal of ["Ботод заавал хэлнэ", "Ботын хариулт", "Бот хариулахгүй", "Дотоод хэрэгцээнд зориулсан", "Дотоод мэдээлэл", "Админд мэдэгдэх", "Chatbot only"]) {
    assert.equal(customerText(internal), "", internal);
  }
});

test("REGRESSION: themes are scored, not first-match: stronger city evidence beats one incidental sea word", () => {
  const titleWins = datedTrip("gs-title", [["2027-01-09", 4_000_000]], { route_name: "Жишиг шопинг ба музей аялал", category: "далайн аялал" });
  const inland = datedTrip("gs-inland", [["2027-01-09", 4_000_000]], {
    route_name: "Жишиг хотын 8 шөнө 9 өдрийн аялал",
    extra: { website_summary: "амьтны хүрээлэн, далайн аквариум, халуун рашаан", itinerary_days: [{ title: "ДАЛАЙН АКВАРИУМ" }] },
  });
  const monthly = datedTrip("gs-monthly", [["2027-01-09", 4_000_000]], { route_name: "Жишиг-Хот хотын 1,2,3-р сарын аяллын хөтөлбөр" });
  const medical = datedTrip("gs-medical", [["2027-01-09", 4_000_000]], { route_name: "Жишиг хотын бүтэн биеийн шинжилгээтэй аялал" });
  const decisions = classifyTrips([titleWins, inland, monthly, medical].map((t) => ({ trip: t, priceMnt: 4_000_000 })));
  assert.equal(decisions.get("gs-monthly")?.groupKey, "city", "'<city> хотын <months> аяллын хөтөлбөр' is a city trip");
  assert.equal(decisions.get("gs-medical")?.groupKey, "other", "the city pattern does not swallow unrelated words between 'хотын' and 'аял'");
  assert.equal(decisions.get("gs-title")?.groupKey, "city");
  assert.deepEqual(decisions.get("gs-title")?.warnings, []);
  assert.equal(decisions.get("gs-inland")?.groupKey, "city", "'<city> хотын N шөнө M өдрийн аялал' is a city trip; the aquarium day does not make it a beach trip");
  assert.deepEqual(decisions.get("gs-inland")?.warnings, []);
});

test("REGRESSION: a prose-only theme is flagged for staff, a tie is unknown, and prose never breaks a metadata tie", () => {
  const proseOnly = datedTrip("gp-prose", [["2027-01-09", 4_000_000]], {
    route_name: "Жишиг-Төв",
    extra: { website_summary: "худалдааны төв, цамхаг, музей", itinerary_days: [{ title: "ДАЛАЙН АКВАРИУМ" }] },
  });
  const proseTie = datedTrip("gp-tie", [["2027-01-09", 4_000_000]], { route_name: "Жишиг-Хөдөө", extra: { website_summary: "далайн аквариум, музей" } });
  const metaTie = datedTrip("gm-tie", [["2027-01-09", 4_000_000]], { route_name: "Жишиг далай, музей", extra: { website_summary: "далайн эрэг арал" } });
  const d = classifyTrips([proseOnly, proseTie, metaTie].map((t) => ({ trip: t, priceMnt: 4_000_000 })));

  assert.equal(d.get("gp-prose")?.groupKey, "city", "three city words in the prose outweigh the one sea word");
  const guess = d.get("gp-prose")?.warnings ?? [];
  assert.equal(guess.length, 1);
  assert.equal(guess[0].code, "category_unknown");
  assert.equal(guess[0].severity, "info");
  assert.match(guess[0].message, /автомат таамаглал/);

  assert.equal(d.get("gp-tie")?.groupKey, "other");
  assert.ok(d.get("gp-tie")?.warnings.some((w) => w.code === "category_unknown" && w.severity === "warning"));
  assert.equal(d.get("gm-tie")?.groupKey, "other", "a tie in the title is ambiguity; the prose does not break it");
  const tie = d.get("gm-tie")?.warnings.find((w) => w.code === "category_unknown");
  assert.ok(tie && tie.severity === "warning");
  assert.match(tie.message, /Далайн амралт.*Хот, соёл, худалдаа/);
});

test("REGRESSION: resolveCodeMap in read-only mode never allocates; placeholders are in-memory only and clearly marked", async () => {
  const calls = { assign: 0 };
  const store = {
    async assignTripCodes(ids: string[]) { calls.assign += 1; return Object.fromEntries(ids.map((id, i) => [id, `A${String(i + 1).padStart(2, "0")}`])); },
    async getTripCodeMap() { return { x1: "A01" }; },
  };
  const fare: Array<[string, number]> = [["2027-01-09", 3_000_000]];
  const trips = [datedTrip("x1", fare), datedTrip("x2", fare, { created_at: "2026-03-01T00:00:00.000Z" }), datedTrip("x3", fare, { created_at: "2026-02-01T00:00:00.000Z" })];

  const review = await resolveCodeMap(trips, store, { allocate: false, provisional: true });
  assert.equal(calls.assign, 0, "a read-only load must not write a single code");
  assert.equal(review.x1, "A01");
  assert.ok(isProvisionalCode(review.x2) && isProvisionalCode(review.x3));
  assert.ok(review.x3 < review.x2, "placeholders follow the allocation order: oldest trip first");
  assert.equal(isProvisionalCode("A01"), false);

  assert.deepEqual(await resolveCodeMap(trips, store, { allocate: false }), { x1: "A01" }, "a freshness check reads the stored map as it is");
  assert.equal(calls.assign, 0);
  assert.deepEqual(await resolveCodeMap([], store, { allocate: true }), {});
  await resolveCodeMap(trips, store, { allocate: true });
  assert.equal(calls.assign, 1, "a deliberate generate still allocates");

  const snap = buildCatalogueSnapshot(inputOf(trips, { codeMap: review }));
  assert.equal(snap.trips.length, 3, "a trip with only a placeholder code is still reviewable");
});
