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
import { buildGroups, budgetCutoff, classifyTrips, themeEvidence } from "../src/lib/catalogue/groups";
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

import { assessHero, assessStaffChoice, photoKey, rankPhotoCandidates, scorePhoto, selectHero } from "../src/lib/catalogue/photos";
import { pickCoverTrip, recommendShortlist, tripDays } from "../src/lib/catalogue/curation";
import { destinationKey, destinationKeys, editorialParts, editorialTitle, foldPlaceName } from "../src/lib/catalogue/editorial";
import type { CataloguePhotoCandidate, CatalogueTripCard } from "../src/lib/catalogue/types";

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

test("quick edition below the minimum warns; no trips at all is blocking; an empty list recommends instead of printing nothing", () => {
  const trips = manyTrips(5);
  const few = buildCatalogueSnapshot(inputOf(trips, { edition: "quick", config: emptyConfig({ tripIds: trips.map((t) => t.id) }) }));
  assert.equal(few.trips.length, 5);
  assert.ok(few.warnings.some((w) => w.severity === "warning" && w.detail?.count === 5), `needs at least ${CATALOGUE_QUICK_MIN_TRIPS}`);
  const none = buildCatalogueSnapshot(inputOf([], { edition: "quick", config: emptyConfig() }));
  assert.equal(none.trips.length, 0);
  assert.ok(none.warnings.some((w) => w.severity === "blocking"));
  // No staff list: the recommended shortlist is printed (a fresh install is never an empty book).
  const recommended = buildCatalogueSnapshot(inputOf(manyTrips(14), { edition: "quick", config: emptyConfig() }));
  assert.ok(recommended.trips.length >= CATALOGUE_QUICK_MIN_TRIPS && recommended.trips.length <= CATALOGUE_QUICK_MAX_TRIPS);
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

test("photo: every stored photo is a candidate, none is favoured by its source, a small known size loses, none gives a warning", () => {
  const t = trip("ph1", { photo_urls: ["https://img.example.test/trip-1600x1067.jpg"] });
  // The poster hero is no longer first by default: it competes on its shape and size like any other photo.
  assert.equal(pickPhoto(t, { hero_image: "https://img.example.test/hero-1600x1067.jpg" }).photo?.source, "trip_photo", "equal photos: the trip's own photo comes first");
  assert.equal(pickPhoto(trip("ph1b"), { hero_image: "https://img.example.test/hero-1600x1067.jpg" }).photo?.source, "poster_hero");
  assert.equal(pickPhoto(t, {}).photo?.source, "trip_photo");
  assert.equal(pickPhoto(trip("ph2"), { days: [{ photo: "https://img.example.test/day.jpg" }] }).photo?.source, "poster_day");

  const small = pickPhoto(t, { hero_image: "https://img.example.test/320px-hero.jpg" });
  assert.equal(small.photo?.url, "https://img.example.test/trip-1600x1067.jpg", "a 320px hero loses to a 1600px photo");

  const onlySmall = pickPhoto(trip("ph3"), { hero_image: "https://img.example.test/320px-hero.jpg" });
  assert.equal(onlySmall.photo?.width, 320);
  assert.ok(onlySmall.warnings.some((w) => w.code === "photo_low_resolution"));
  assert.equal(onlySmall.quality, "weak");

  const none = pickPhoto(trip("ph4", { photo_urls: ["data:image/png;base64,AAAA", "http://insecure.example.test/a.jpg", "https://img.example.test/x.svg"] }), { hero_image: "data:image/png;base64,AAAA" });
  assert.equal(none.photo, null);
  assert.equal(none.quality, "missing");
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
  // Was "other" before health themes existed: the point stays the same (the city pattern does not swallow
  // unrelated words between 'хотын' and 'аял'), and a health-check trip is now named for what it is.
  assert.equal(decisions.get("gs-medical")?.groupKey, "wellness", "the city pattern does not swallow unrelated words between 'хотын' and 'аял'");
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

/* ================================================================ V2: photos, curation, categories, titles, highlights */


const IMG = "https://img.example.test";

test("photo ranking: size, shape and text-overlay risk decide; the sharp landscape beats the tiny, the panorama and the overlay", () => {
  const t = trip("pr1", { photo_urls: [
    `${IMG}/tiny.jpg`, `${IMG}/wide.jpg`, `${IMG}/big.jpg`, `${IMG}/poster-price.jpg`, "https://res.cloudinary.com/demo/image/upload/l_text:Arial_40:Price/v1/uudam/overlay.jpg",
  ] });
  const sizes = {
    [`${IMG}/tiny.jpg`]: { width: 480, height: 320 },
    [`${IMG}/wide.jpg`]: { width: 2400, height: 800 },
    [`${IMG}/big.jpg`]: { width: 2000, height: 1333, sharpness: 900, colorful: 50 },
    [`${IMG}/poster-price.jpg`]: { width: 2000, height: 1333 },
    "https://res.cloudinary.com/demo/image/upload/l_text:Arial_40:Price/v1/uudam/overlay.jpg": { width: 2000, height: 1333 },
  };
  const ranked = rankPhotoCandidates(t, {}, { sizes });
  assert.equal(ranked[0].url, `${IMG}/big.jpg`);
  const order = ranked.map((c) => c.url);
  assert.ok(order.indexOf(`${IMG}/wide.jpg`) > 0 && order.indexOf(`${IMG}/tiny.jpg`) === order.length - 1, "a 3:1 panorama loses to the landscape; the tiny photo is last");
  const overlay = ranked.find((c) => c.url.includes("l_text"))!;
  assert.ok(overlay.score < ranked[0].score - 25 && overlay.issues.some((i) => /текст/.test(i)), "text drawn over the picture is a heavy penalty and says why");
  assert.ok(ranked.find((c) => c.url.endsWith("poster-price.jpg"))!.issues.some((i) => /постер|текст/.test(i)));
  assert.ok(ranked.find((c) => c.url.endsWith("tiny.jpg"))!.issues.some((i) => /нягтрал|жижиг/.test(i)));
  assert.ok(ranked.every((c) => c.score >= 0 && c.score <= 100));
});

test("photo ranking: pure and deterministic, near-duplicates collapse, credits stay attached, nothing unsafe is a candidate", () => {
  const same = "https://res.cloudinary.com/demo/image/upload/c_fill,w_800,h_600/v7/uudam/trip/shot.jpg";
  const bigger = "https://res.cloudinary.com/demo/image/upload/v7/uudam/trip/shot.jpg";
  const t = trip("pr2", {
    photo_urls: [same, bigger, "http://insecure.example.test/a.jpg", `${IMG}/clip.mp4`, `${IMG}/other.jpg`],
    extra: { photo_credits: { [`${IMG}/other.jpg`]: { author: "Жишиг зураглаач", license: "CC BY 4.0" } } },
  });
  const a = rankPhotoCandidates(t, { hero_image: `${IMG}/other.jpg` });
  const b = rankPhotoCandidates(t, { hero_image: `${IMG}/other.jpg` });
  assert.deepEqual(a, b);
  assert.equal(a.length, 2, "two crops of one stored file are one candidate; http and video are not candidates");
  assert.equal(photoKey(same), photoKey(bigger));
  assert.equal(a.find((c) => c.url === `${IMG}/other.jpg`)?.credit, "Жишиг зураглаач, CC BY 4.0");
});

test("assessHero: only a large, sharp, vivid file is excellent on its own; unknown size is never better than good; nothing is missing", () => {
  const cand = (over: Partial<CataloguePhotoCandidate>): CataloguePhotoCandidate => ({ url: `${IMG}/x.jpg`, width: 2200, height: 1467, source: "trip_photo", score: 85, issues: [], credit: null, ...over });
  assert.equal(assessHero(null), "missing");
  assert.equal(assessHero(cand({})), "excellent");
  assert.equal(assessHero(cand({ width: 1400, height: 933 })), "good", "below the excellent edge");
  assert.equal(assessHero(cand({ width: null, height: null })), "good", "an unmeasured photo cannot be excellent");
  assert.equal(assessHero(cand({ width: 640, height: 427, score: 40 })), "weak");
  assert.equal(assessHero(cand({ score: 45 })), "weak", "a big file with a poor score is weak");
  // A photo an editor approved is held back only by the file itself, and never above the editor's own rating.
  assert.equal(assessStaffChoice({ width: 1600, height: 1067 }), "excellent");
  assert.equal(assessStaffChoice({ width: 1600, height: 1067 }, "good"), "good");
  assert.equal(assessStaffChoice({ width: 700, height: 466 }, "excellent"), "weak");
});

test("a staff hero choice always wins, carries its focal point and zoom, and is capped by its rating; another trip may not take the same photo", () => {
  const a = datedTrip("hc1", [["2027-01-09", 3_000_000]], { photo_urls: [`${IMG}/a-1.jpg`, `${IMG}/shared.jpg`] });
  const b = datedTrip("hc2", [["2027-01-09", 3_000_000]], { photo_urls: [`${IMG}/shared.jpg`, `${IMG}/b-1.jpg`] });
  const sizes = Object.fromEntries(["a-1", "shared", "b-1"].map((n) => [`${IMG}/${n}.jpg`, { width: 2000, height: 1333, colorful: n === "shared" ? 70 : 30 }]));

  const chosen = pickPhoto(a, {}, { choice: { url: `${IMG}/a-1.jpg`, focal: { x: 0.2, y: 0.7 }, zoom: 1.5, quality: "good" }, sizes });
  assert.equal(chosen.photo?.url, `${IMG}/a-1.jpg`);
  assert.deepEqual(chosen.photo?.focal, { x: 0.2, y: 0.7 });
  assert.equal(chosen.photo?.zoom, 1.5);
  assert.equal(chosen.quality, "good", "the editor rated it good: the card never claims more");
  assert.equal(chosen.staffChosen, true);
  assert.equal(selectHero([], { url: `${IMG}/elsewhere.jpg` }).hero?.url, `${IMG}/elsewhere.jpg`, "a chosen photo outside the stored ones is still honoured");

  const snap = buildCatalogueSnapshot(inputOf([a, b], { photoSizes: sizes }));
  const heroes = snap.trips.map((c) => c.photo?.url);
  assert.equal(new Set(heroes).size, 2, "one photo never opens two pages");
  const staff = buildCatalogueSnapshot(inputOf([a, b], { photoSizes: sizes, heroByTripId: { hc1: { url: `${IMG}/shared.jpg` }, hc2: { url: `${IMG}/shared.jpg` } } }));
  assert.deepEqual(staff.trips.map((c) => c.photo?.url), [`${IMG}/shared.jpg`, `${IMG}/shared.jpg`], "staff may reuse a photo on purpose");
  assert.equal(scorePhoto({ url: `${IMG}/q.jpg`, source: "poster_hero" }, null).score, scorePhoto({ url: `${IMG}/q.jpg`, source: "trip_photo" }, null).score, "the poster hero is not favoured or punished by its source alone");
});

/* ------------------------------------------------------------------ shortlist */

function card(id: string, over: Partial<CatalogueTripCard> = {}): CatalogueTripCard {
  return {
    tripId: id, code: id.toUpperCase(), title: `Тест-${id}`, editorialTitle: `Тест ${id}`, destinationKey: `k${id}`, destinationKeys: [`k${id}`],
    heroQuality: "good", gallery: [], kicker: "", groupKey: "beach", durationText: "8 өдөр 7 шөнө", transportLabel: "Шууд нислэг", highlights: [],
    price: { kind: "from", amountMnt: 3_000_000, date: "2027-01-09", display: "3,000,000₮-с" },
    dates: { nextDeparture: "2027-01-09", departures: ["2027-01-09"], label: "2027.01.09-ний хөдлөлт" }, detailUrl: null,
    photo: { url: `${IMG}/${id}.jpg`, width: 1920, height: 1280, credit: null, source: "trip_photo" }, warnings: [], ...over,
  };
}

function manyCards(): CatalogueTripCard[] {
  const price = (n: number): CatalogueTripCard["price"] => ({ kind: "from", amountMnt: n, date: "2027-01-09", display: `${n.toLocaleString("en-US")}₮-с` });
  return [
    card("b1", { groupKey: "beach", price: price(5_000_000), heroQuality: "excellent", durationText: "9 өдөр 8 шөнө" }),
    card("b2", { groupKey: "beach", price: price(3_900_000), heroQuality: "excellent", durationText: "8 өдөр 7 шөнө" }),
    card("b3", { groupKey: "beach", price: price(3_100_000), heroQuality: "good", durationText: "10 өдөр 9 шөнө", transportLabel: "Газар + нислэг" }),
    card("b4", { groupKey: "beach", price: price(4_400_000), heroQuality: "good", durationText: "7 өдөр 6 шөнө" }),
    card("b5", { groupKey: "beach", price: price(4_500_000), heroQuality: "good", durationText: "6 өдөр 5 шөнө" }),
    card("c1", { groupKey: "city", price: price(2_900_000), heroQuality: "excellent", durationText: "5 өдөр 4 шөнө" }),
    card("c2", { groupKey: "city", price: price(2_100_000), heroQuality: "good", durationText: "9 өдөр 8 шөнө", transportLabel: "Газар + нислэг" }),
    card("c3", { groupKey: "city", price: price(4_000_000), heroQuality: "good", durationText: "6 өдөр 5 шөнө" }),
    card("c4", { groupKey: "city", price: price(1_500_000), heroQuality: "good", durationText: "8 өдөр 7 шөнө", transportLabel: "Газрын аялал" }),
    card("n1", { groupKey: "nature", price: price(2_700_000), heroQuality: "excellent", durationText: "10 өдөр 9 шөнө", transportLabel: "Газар + нислэг" }),
    card("n2", { groupKey: "nature", price: price(3_600_000), heroQuality: "good", durationText: "6 өдөр 5 шөнө" }),
    card("w1", { groupKey: "wellness", price: price(1_300_000), heroQuality: "excellent", durationText: "7 өдөр 6 шөнө", transportLabel: "Газрын аялал" }),
    card("x1", { groupKey: "city", price: { kind: "inquire", display: "Үнэ лавлах" }, heroQuality: "excellent" }),
    card("x2", { groupKey: "beach", heroQuality: "weak", price: price(3_300_000) }),
  ];
}

test("shortlist: diverse, balanced, deterministic; health checks and price-less trips do not take the slots", () => {
  const cards = manyCards();
  const a = recommendShortlist(cards);
  assert.equal(a.tripIds.length, 10);
  assert.ok(a.tripIds.length >= CATALOGUE_QUICK_MIN_TRIPS && a.tripIds.length <= CATALOGUE_QUICK_MAX_TRIPS);
  const byId = new Map(cards.map((c) => [c.tripId, c]));
  const groups = new Set(a.tripIds.map((id) => byId.get(id)!.groupKey));
  assert.ok(groups.has("beach") && groups.has("city") && groups.has("nature"), "a balanced mix of themes");
  assert.ok(!a.tripIds.includes("w1"), "a health-check trip is not a team-holiday pitch");
  assert.ok(!a.tripIds.includes("x1"), "a trip without a price loses to trips that have one");
  assert.ok(a.tripIds.filter((id) => byId.get(id)!.groupKey === "beach").length <= 5);
  const prices = a.tripIds.map((id) => (byId.get(id)!.price as { amountMnt: number }).amountMnt ?? 0);
  assert.ok(Math.max(...prices) - Math.min(...prices) >= 2_500_000, "a spread of price tiers");
  assert.ok(new Set(a.tripIds.map((id) => byId.get(id)!.durationText)).size >= 5, "durations vary");
  for (const id of a.tripIds) assert.match(a.reasons[id], /[А-Яа-яӨөҮү]/, "every pick has a Mongolian reason");

  // Same cards in any order: the same answer.
  assert.deepEqual(recommendShortlist([...cards].reverse()), a);
  assert.deepEqual(recommendShortlist(cards), a);
  assert.equal(recommendShortlist(cards, { size: 3 }).tripIds.length, CATALOGUE_QUICK_MIN_TRIPS, "the size is held inside the quick limits");
});

test("shortlist: one destination, one slot unless materially different; a shared photo never opens two pages", () => {
  const base = manyCards();
  const dup = [
    ...base,
    card("d1", { destinationKey: "kb1", destinationKeys: ["kb1", "extra"], groupKey: "beach", durationText: "9 өдөр 8 шөнө", heroQuality: "excellent", price: { kind: "from", amountMnt: 5_000_000, date: "2027-01-09", display: "5,000,000₮-с" } }),
    card("d2", { destinationKey: "zz", destinationKeys: ["zz", "kb2"], groupKey: "beach", durationText: "8 өдөр 7 шөнө", heroQuality: "excellent", price: { kind: "from", amountMnt: 3_900_000, date: "2027-01-09", display: "3,900,000₮-с" } }),
  ];
  const list = recommendShortlist(dup);
  const byId = new Map(dup.map((c) => [c.tripId, c]));
  const keysOf = (id: string) => byId.get(id)!.destinationKeys!;
  for (const x of list.tripIds) for (const y of list.tripIds) {
    if (x >= y) continue;
    const shared = keysOf(x).some((k) => keysOf(y).includes(k));
    if (shared) {
      const cx = byId.get(x)!, cy = byId.get(y)!;
      assert.notEqual(tripDays(cx), tripDays(cy), `${x}/${y} share a destination, so they must differ in length`);
    }
  }
  assert.ok(!(list.tripIds.includes("b1") && list.tripIds.includes("d1")), "an equal second trip to the same place is not listed");
  assert.ok(!(list.tripIds.includes("b2") && list.tripIds.includes("d2")), "sharing ANY destination key counts as the same place");

  const samePhoto = base.map((c) => (c.tripId === "b2" ? { ...c, photo: { ...c.photo!, url: base.find((x) => x.tripId === "b1")!.photo!.url } } : c));
  const withShared = recommendShortlist(samePhoto);
  assert.ok(!(withShared.tripIds.includes("b1") && withShared.tripIds.includes("b2")), "the second use of one photo is a poor pick");
});

test("cover: best hero and most inviting subject, never the newest or the cheapest trip", () => {
  const cards = manyCards();
  const cover = pickCoverTrip(cards)!;
  const picked = cards.find((c) => c.tripId === cover)!;
  assert.equal(picked.heroQuality, "excellent");
  assert.notEqual(picked.groupKey, "wellness");
  assert.notEqual(cover, "w1", "the cheapest excellent trip is a health check, not the cover");
  assert.equal(pickCoverTrip(cards.map((c) => ({ ...c, photo: null, heroQuality: "missing" as const }))), null, "no usable photo, no cover");
  assert.equal(recommendShortlist(cards).tripIds[0], cover, "the shortlist opens with the cover");
  assert.equal(recommendShortlist(cards).cover, cover);
  // Nothing about recency can move it: the same cards with other ids give the same winner's data.
  assert.deepEqual(pickCoverTrip([...cards].reverse()), cover);
});

test("a quick edition with no staff list prints the recommended shortlist; staff curation still wins", () => {
  const themes = ["далайн эрэг", "шопинг худалдаа", "нуур уулын адал явдал"];
  const places = ["Алдар", "Бөмбөг", "Цагаан", "Дугуй", "Элсэн", "Фараон", "Гэрэл", "Хөндлөн", "Ирмэг", "Жаргал", "Кино", "Лангуу", "Мандал", "Нарийн"];
  const trips = Array.from({ length: 14 }, (_, i) => datedTrip(`rq${String(i + 1).padStart(2, "0")}`, [["2027-01-09", 1_500_000 + i * 250_000]], {
    route_name: `${places[i]} ${themes[i % 3]}`, duration_text: `${5 + (i % 6)} өдөр ${4 + (i % 6)} шөнө`,
    photo_urls: [`${IMG}/rq${i + 1}-2000x1333.jpg`],
  }));
  const auto = buildCatalogueSnapshot(inputOf(trips, { edition: "quick", config: emptyConfig() }));
  assert.equal(auto.trips.length, 10);
  assert.ok(auto.trips.some((c) => c.groupKey === "beach") && auto.trips.some((c) => c.groupKey === "city") && auto.trips.some((c) => c.groupKey === "nature"));
  assert.equal(auto.coverTripId, pickCoverTrip(auto.trips));
  const again = buildCatalogueSnapshot(inputOf(trips, { edition: "quick", config: emptyConfig() }));
  assert.equal(again.contentHash, auto.contentHash, "deterministic");
  const curated = buildCatalogueSnapshot(inputOf(trips, { edition: "quick", config: emptyConfig({ tripIds: ["rq03", "rq01"] }) }));
  assert.deepEqual(curated.trips.map((c) => c.tripId), ["rq03", "rq01"], "the admin's list overrides the recommendation");
  const featured = buildCatalogueSnapshot(inputOf(trips, { edition: "quick", config: emptyConfig({ tripIds: ["rq03", "rq01"], featuredTripIds: ["rq01"] }) }));
  assert.equal(featured.coverTripId, "rq01", "a featured trip with a hero is the cover");
});

/* ------------------------------------------------------------------ categories */

function programTrip(id: string, title: string, days: Array<[string, string]>, over: TripOverrides = {}): TravelTrip {
  return datedTrip(id, [["2027-01-09", 4_000_000]], {
    route_name: title,
    ...over,
    extra: { itinerary_days: days.map(([dayTitle, description], i) => ({ day: i + 1, title: dayTitle, description })), ...(over.extra ?? {}) },
  });
}

test("categories: a beach holiday whose name is only a city is a beach holiday; the program is the evidence", () => {
  const beachHoliday = programTrip("cat-beach", "ТЕСТ-ХОТ АЯЛАЛ", [
    ["Нисэх", "Нисэх буудлаас буудалдаа очно."],
    ["Усан парк", "Water World усан парк, оройн шоу."],
    ["Хотын аялал", "Хотын гол талбай, музей үзнэ."],
    ["Чөлөөт өдөр", "Далайн эрэг, кофе шоп, хоолны газруудаар чөлөөтэй зугаална."],
    ["Чөлөөт өдөр", "Буудалдаа амарч, далайн эрэгт гарна."],
    ["Чөлөөт өдөр", "Далайн эрэг ба дэлгүүр хэсэх боломжтой."],
    ["Буцах", "Нисэх буудал руу."],
  ]);
  const cityTrip = programTrip("cat-city", "ТЕСТ-ХОТ АЯЛАЛ 2", [
    ["Хотын аялал", "Музей, цамхаг үзнэ."], ["Худалдаа", "Дэлгүүр, худалдааны төв."], ["Шопинг", "Шопинг хийнэ, далайн эрэг орчим алхана."], ["Театр", "Театрын тоглолт үзнэ."],
  ]);
  const d = classifyTrips([beachHoliday, cityTrip].map((t) => ({ trip: t, priceMnt: 4_000_000 })));
  assert.equal(d.get("cat-beach")?.groupKey, "beach");
  assert.deepEqual(d.get("cat-beach")?.warnings, [], "three or more beach days are firm evidence: no staff glance needed");
  assert.equal(d.get("cat-city")?.groupKey, "city", "a program that is museums, shopping and theatre stays a city trip");
  const evidence = themeEvidence(beachHoliday);
  assert.ok(evidence.programDays.beach >= 3 && evidence.programDays.beach > evidence.programDays.nature);
});

test("categories: beach days win a close contest; thin program evidence is a soft guess the price tier outranks; no winner is category_unknown", () => {
  // Beach and city level (three days each): the beach days make the programme a holiday.
  const close = programTrip("cat-close", "ТЕСТ-ЗУН АЯЛАЛ", [
    ["Нисэх", ""], ["Далайн эрэг", ""], ["Шүрэн арал", ""], ["Далайн эрэг", ""], ["Хотын аялал", ""], ["Шопинг", ""], ["Музей", ""],
  ]);
  // One beach word in the whole programme: only a hint.
  const thin = programTrip("cat-thin", "ТЕСТ-УХАА АЯЛАЛ", [["Нисэх", ""], ["Далайн аквариум", ""], ["Чөлөөт өдөр", ""]]);
  const nothing = programTrip("cat-none", "ТЕСТ-ХООСОН АЯЛАЛ", [["Нисэх", ""], ["Чөлөөт өдөр", ""]]);
  const items = [close, thin, nothing].map((t, i) => ({ trip: t, priceMnt: [4_000_000, 900_000, 4_000_000][i]! }));
  const priced = classifyTrips([...items, { trip: trip("cat-ref1"), priceMnt: 4_000_000 }, { trip: trip("cat-ref2"), priceMnt: 4_200_000 }]);
  assert.equal(priced.get("cat-close")?.groupKey, "beach");
  assert.equal(priced.get("cat-thin")?.groupKey, "budget", "a cheap trip whose only evidence is one aquarium day is a budget trip, not a beach trip");
  assert.equal(priced.get("cat-none")?.groupKey, "other");
  assert.ok(priced.get("cat-none")?.warnings.some((w) => w.code === "category_unknown" && w.severity === "warning"));
  const unpriced = classifyTrips([{ trip: thin, priceMnt: null }]);
  assert.equal(unpriced.get("cat-thin")?.groupKey, "beach", "without a price tier the program hint groups it");
  assert.ok(unpriced.get("cat-thin")?.warnings.some((w) => w.code === "category_unknown" && w.severity === "info" && /автомат таамаглал/.test(w.message)));
});

test("categories: theme words are whole words (a 'хэрэг' is not a coast) and a health programme has its own group", () => {
  const noise = programTrip("cat-noise", "ТЕСТ-ЭНГИЙН АЯЛАЛ", [["Өдөр", "Хэрэгтэй бүх зүйлийг хэрэглэж, хэрэг явдлыг шийднэ."], ["Өдөр", "Хэрэглээний бараа."]]);
  const health = programTrip("cat-health", "ТЕСТ-ЭРҮҮЛ МЭНДИЙН ШИНЖИЛГЭЭТЭЙ АЯЛАЛ", [["Үзлэг", "Эмчийн шинжилгээ."], ["Рашаан", "Халуун рашаанд орно."]]);
  const lama = programTrip("cat-lama", "ТЕСТ-ХИЙД", [["Хийд", "Далай лам хэмээх сүм хийдийг үзнэ."], ["Хийд", "Хийдийн оршин суугч."]]);
  const d = classifyTrips([noise, health, lama].map((t) => ({ trip: t, priceMnt: 4_000_000 })));
  assert.equal(d.get("cat-noise")?.groupKey, "other");
  assert.equal(d.get("cat-health")?.groupKey, "wellness");
  assert.equal(d.get("cat-lama")?.groupKey, "other", "'Далай лам' is a person's title, not the sea");
  assert.ok(buildGroups([{ code: "A01", groupKey: "wellness" }])[0].label.length > 0);
});

/* ------------------------------------------------------------------ editorial titles */

const BORDER = STANDARD_DAYS.departure.title.split(/\s*[–—-]\s*/u)[1] ?? "";

test("editorial title: filler goes only when a clear destination phrase remains; the canonical title is untouched", () => {
  const cases: Array<[string, string]> = [
    ["ТЕСТ-ДАЛАЙ шууд нислэгтэй аялал", "Тест-Далай"],
    ["Тестград хотын 8 шөнө 9 өдрийн аялал", "Тестград хот"],
    ["Жишиг арлын аялал", "Жишиг арал"],
    ["УБ-Шишиг хотын 11-р сарын аяллын хөтөлбөр", "Шишиг хот"],
    [`${BORDER} - Тест-Хад - Жишиг-Хөдөө нислэгтэй газар нислэг хосолсон аялал`, "Тест-Хад – Жишиг-Хөдөө"],
    ["Жишиг нууртай - Мягмар гариг", "Жишиг нууртай"],
    ["ТЕСТ ТОКИО, ФҮЖИ УУЛ АЯЛАЛ (4 шөнө, 5 өдөр)", "Тест Токио, Фүжи Уул"],
    ["Жишиг — Хөдөө (Нэг - Хоёр)", "Жишиг – Хөдөө (Нэг – Хоёр)"],
  ];
  for (const [canonical, expected] of cases) assert.equal(editorialTitle(canonical), expected, canonical);
  // A cut that would leave a dangling case ending or a "-тай" adjective is never made.
  assert.equal(editorialTitle("ТЕСТ-УХАА ШИНЖИЛГЭЭТЭЙ АЯЛАЛ"), "Тест-Ухаа Шинжилгээтэй Аялал");
  assert.equal(editorialTitle("Жишиг хотын эрүүл мэндийн аялал"), "Жишиг хотын эрүүл мэндийн аялал", "'... мэндийн' would dangle");
  assert.equal(editorialTitle("Аялал", { destinations: ["Тестлэнд"] }), "Аялал", "a title that is only filler stays as written");
  assert.equal(editorialTitle("", { destinations: ["Тестлэнд"] }), "Тестлэнд");
});

test("editorial title: counters, months and weekdays are qualifiers; a staff override wins; two equal titles are told apart on the cards", () => {
  assert.deepEqual(editorialParts("ТЕСТ-ХИЛ САНЬЯ НИСЛЭГТЭЙ - 2"), { title: "Тест-Хил Санья", qualifier: "2" });
  assert.equal(editorialParts("Тестград хотын 1,2,3-р сарын аяллын хөтөлбөр").qualifier, "1,2,3-р сар");
  assert.equal(editorialTitle("Тест аялал", {}, "  Миний   нэр  "), "Миний нэр", "a staff title is used as written, trimmed");
  assert.equal([...editorialTitle("Тест аялал", {}, "x".repeat(200))].length, 80);

  const a = datedTrip("et1", [["2027-01-09", 3_000_000]], { route_name: "Тестград хотын 11-р сарын аяллын хөтөлбөр" });
  const b = datedTrip("et2", [["2027-01-09", 3_000_000]], { route_name: "Тестград хотын 12-р сарын аяллын хөтөлбөр" });
  const c = datedTrip("et3", [["2027-01-09", 3_000_000]], { route_name: "Тестград хотын аялал" });
  const snap = buildCatalogueSnapshot(inputOf([a, b, c]));
  const titles = snap.trips.map((t) => t.editorialTitle);
  assert.equal(new Set(titles.map((t) => t.toLowerCase())).size, 3, "no two cards print the same display title");
  assert.match(titles[0], /11-р сар/);
  assert.match(titles[1], /12-р сар/);
  assert.deepEqual(snap.trips.map((t) => t.title), [a.route_name, b.route_name, c.route_name], "the canonical title is never changed");
  const overridden = buildCatalogueSnapshot(inputOf([a, b], { titleOverrides: { et1: "Тест хотын намрын аялал" } }));
  assert.equal(overridden.trips[0].editorialTitle, "Тест хотын намрын аялал");
  assert.equal(overridden.trips[0].title, a.route_name);
});

test("destination identity: spelling drift folds into one key, departure and border legs are not the destination", () => {
  assert.equal(foldPlaceName("Чунчин"), foldPlaceName("Чүнчин"));
  assert.equal(foldPlaceName("Саньяа"), foldPlaceName("Саняа"), "the soft sign is not part of the identity");
  const k1 = destinationKey("Чунчин хотын аялал", ["Чунчин", "Эрээн"]);
  const k2 = destinationKey("ЧҮНЧИН ХОТЫН АЯЛАЛ – ЭРЭЭНЭЭС НИСЛЭГТЭЙ", ["Эрээн", "Чүнчин"]);
  assert.ok(k1 && k1 === k2, "two spellings of one city share a key");
  assert.notEqual(destinationKey("Тест-Далай аялал", ["Тест-Далай"]), k1);
  const keys = destinationKeys("ХАЙНАН – ХӨХ ХОТООС САНЬЯА НИСЛЭГТЭЙ", ["Эрээн", "Хөх хот", "Санья"]);
  assert.ok(keys.length >= 2 && !keys.includes(foldPlaceName("Хөх хот").slice(0, 4)), "the starting point named with an origin ending is not a destination");
  assert.equal(destinationKey("", []), "");
});

/* ------------------------------------------------------------------ highlights: short and clean */

test("highlights: long list lines are cut at their first clause, summaries are used whole or not at all, nothing is cut mid-word", () => {
  const t = trip("hl-short", { extra: {
    website_summary: "Энэ аялал нь тансаг буудалд амарч, далайн эрэгт нар шарж, орон нутгийн хоолыг амсах гайхалтай боломж олгоно.",
    website_details: { highlights: [
      "Хөх нуурын гэрэлт завь, чөлөөт цаг",
      "Ойн үзэсгэлэнт гүүрээр зорчин ширэнгэн ойг үзэх",
      "Жишиг цамхаг",
      "Жишиг цамхагийн оройн шоу",
      "Алдарт жишиг ордон",
    ] },
  } });
  const { highlights } = deriveHighlights(t);
  assert.deepEqual(highlights, ["Хөх нуурын гэрэлт завь", "Жишиг цамхаг", "Алдарт жишиг ордон"], "the second tower line repeats the first and is dropped");
  assert.ok(highlights.every((h) => h.length <= 32 && h.split(" ").length <= 4), "short: at most 4 words / 32 characters");
  const none = deriveHighlights(trip("hl-none", { extra: { website_details: { highlights: ["Ойн үзэсгэлэнт гүүрээр зорчин ширэнгэн ойг үзэх"] } } }));
  assert.deepEqual(none.highlights, [], "a line that cannot be shortened cleanly is dropped, never truncated");
  assert.ok(none.warnings.some((w) => w.code === "highlights_missing"));
  const dup = deriveHighlights(trip("hl-dup", { extra: { website_details: { highlights: ["Жишиг цамхаг", "жишиг цамхаг!", "Жишиг цамхаг, оройн шоу", "Нарны шоу"] } } }));
  assert.equal(new Set(dup.highlights.map((h) => h.toLowerCase())).size, dup.highlights.length, "deduped");
  assert.ok(dup.highlights.length <= 3);
});

/* ------------------------------------------------------------------ drift ignores display-only edits */

test("liveDrift ignores a photo or display-title change but still catches the title of record, fare, dates and status", () => {
  const t = datedTrip("dr1", [["2027-01-09", 3_000_000]], { route_name: "Тестград аялал", photo_urls: [`${IMG}/dr-1-2000x1333.jpg`, `${IMG}/dr-2-2000x1333.jpg`] });
  const published = buildCatalogueSnapshot(inputOf([t]));
  const display = buildCatalogueSnapshot(inputOf([t], {
    heroByTripId: { dr1: { url: `${IMG}/dr-2-2000x1333.jpg`, focal: { x: 0.1, y: 0.9 }, zoom: 2 } }, titleOverrides: { dr1: "Шинэ гарчиг" },
  }));
  assert.notEqual(display.contentHash, published.contentHash, "the printed file does change");
  assert.notEqual(display.trips[0].editorialTitle, published.trips[0].editorialTitle);
  assert.notEqual(display.trips[0].photo?.url, published.trips[0].photo?.url);
  assert.deepEqual(liveDrift(published, display), { drifted: false, reasons: [] }, "display-only edits do not make the published file stale");
  const renamed = buildCatalogueSnapshot(inputOf([{ ...t, route_name: "Тестград шинэ нэртэй аялал" }]));
  assert.equal(liveDrift(published, renamed).drifted, true, "the title of record is still compared");
  const repriced = buildCatalogueSnapshot(inputOf([datedTrip("dr1", [["2027-01-09", 3_500_000]], { route_name: "Тестград аялал", photo_urls: t.photo_urls })]));
  assert.equal(liveDrift(published, repriced).drifted, true);
});

/* ================================================================ V3: consistency, codes, weak heroes, cover, picks */

import { checkTripConsistency, parseDuration } from "../src/lib/catalogue/consistency";
import { codeAllocationOrder, resolveCoverPhoto } from "../src/lib/catalogue/tripData";

const fareOnce: Array<[string, number]> = [["2027-01-09", 3_000_000]];
const withProgram = (id: string, days: Array<{ title: string; description: string }>, over: TripOverrides = {}) =>
  datedTrip(id, fareOnce, { ...over, extra: { transport_type: "direct_flight", duration_days: 8, duration_nights: 7, itinerary_days: days.map((d, i) => ({ day: i + 1, ...d })), ...(over.extra ?? {}) } });

test("V3 consistency: a title that says 'дамжин нислэг' against a structured direct flight is a transport_conflict and the label is printed as nothing", () => {
  const t = withProgram("cx1", [
    { title: "УБ – ЖИШИГ", description: "Нисэх буудалд цуглана." },
    { title: "ЖИШИГ – ТЕСТ", description: "Нислэгээр Тест хот руу." },
    { title: "ТЕСТ – ЖИШИГ – УБ", description: "Жишиг хотод газардаж дамжин нислэгт бэлтгэнэ." },
  ], { route_name: "ТЕСТ ХОТ – ДАМЖИН НИСЛЭГТЭЙ ЖИЛИЙН АЯЛАЛ" });
  const result = checkTripConsistency(t);
  assert.equal(result.transportConflict, true);
  const w = result.warnings.find((x) => x.code === "transport_conflict")!;
  assert.equal(w.severity, "warning");
  assert.deepEqual(w.detail, { structured: "Шууд нислэг", wording: "Дамжин нислэг" });
  assert.match(result.transport[0].evidence, /ДАМЖИН НИСЛЭГТЭЙ/);

  const snap = buildCatalogueSnapshot(inputOf([t]));
  assert.equal(snap.trips[0].transportLabel, "", "a possibly wrong label is never printed");
  assert.ok(snap.warnings.some((x) => x.code === "transport_conflict" && x.tripId === "cx1"));
  assert.ok(!snap.warnings.some((x) => x.code === "other" && /Тээврийн төрөл тодорхойгүй/.test(x.message) && x.tripId === "cx1"), "the conflict is the reason, not 'unknown'");
});

test("V3 consistency: agreeing wording, a local bus in a flight program, and a land+flight combo title are not conflicts", () => {
  const fine = withProgram("cx2", [{ title: "ДАЛАЙ", description: "Аяллын автобусаар далайн эрэг рүү. Оройн хоолны дараа буцна." }], { route_name: "ТЕСТ ДАЛАЙ ШУУД НИСЛЭГТЭЙ АЯЛАЛ" });
  assert.equal(checkTripConsistency(fine).transportConflict, false);
  const combo = datedTrip("cx3", fareOnce, { route_name: "ТЕСТ ГАЗАР НИСЛЭГ ХОСОЛСОН, ШУУД НИСЛЭГТЭЙ БУЦАЛТ", extra: { transport_type: "land_flight" } });
  assert.equal(checkTripConsistency(combo).transportConflict, false, "a title that openly mixes land and air makes no direct-flight claim");
  assert.equal(buildCatalogueSnapshot(inputOf([fine])).trips[0].transportLabel, "Шууд нислэг");
});

test("V3 consistency: land structured but sold as a direct flight, and flight structured but sold as a land trip, both conflict", () => {
  const land = datedTrip("cx4", fareOnce, { route_name: "ТЕСТ-ХӨДӨӨ ШУУД НИСЛЭГТЭЙ АЯЛАЛ", extra: { transport_type: "land" } });
  assert.equal(checkTripConsistency(land).transport[0]?.likely, "Шууд нислэг");
  const air = datedTrip("cx5", fareOnce, { route_name: "ТЕСТ-ХӨДӨӨ ГАЗРЫН АЯЛАЛ", extra: { transport_type: "direct_flight" } });
  assert.equal(checkTripConsistency(air).transport[0]?.likely, "Газрын аялал");
  const train = datedTrip("cx6", fareOnce, { route_name: "ТЕСТ-ХӨДӨӨ ГАЛТ ТЭРЭГТЭЙ АЯЛАЛ", extra: { transport_type: "direct_flight" } });
  assert.equal(checkTripConsistency(train).transportConflict, true);
});

test("V3 consistency: a guessed transport (no structured field) that the wording contradicts is blanked too", () => {
  const t = datedTrip("cx7", fareOnce, { route_name: "ТЕСТ ДАМЖИН НИСЛЭГТЭЙ АЯЛАЛ" });
  assert.equal(checkTripConsistency(t, { guessedTransport: "direct_flight" }).transportConflict, true);
  assert.equal(checkTripConsistency(t, { guessedTransport: null }).transportConflict, false, "nothing printed, nothing contradicted");
});

test("V3 consistency: duration wording against duration_days / duration_nights / duration_text / the program length", () => {
  assert.deepEqual(parseDuration("4 шөнө, 5 өдөр"), { days: 5, nights: 4 });
  assert.deepEqual(parseDuration("9 өдөр 8 шөнө"), { days: 9, nights: 8 });
  assert.deepEqual(parseDuration("5 шөнө / 6 өдөр"), { days: 6, nights: 5 });
  assert.deepEqual(parseDuration("8 өдөр"), { days: 8, nights: null });
  const ok = datedTrip("cd1", fareOnce, { route_name: "ТЕСТ АЯЛАЛ (4 шөнө, 5 өдөр)", duration_text: "5 өдөр 4 шөнө", extra: { duration_days: 5, duration_nights: 4 } });
  assert.equal(checkTripConsistency(ok).durationConflict, false);
  const titleBad = datedTrip("cd2", fareOnce, { route_name: "ТЕСТ АЯЛАЛ (4 шөнө, 5 өдөр)", duration_text: "6 өдөр 5 шөнө", extra: { duration_days: 6, duration_nights: 5 } });
  const r = checkTripConsistency(titleBad);
  assert.equal(r.durationConflict, true);
  assert.equal(r.warnings[0].code, "duration_conflict");
  assert.equal(r.warnings[0].severity, "warning");
  assert.deepEqual(r.warnings[0].detail, { structured: "6 өдөр 5 шөнө", wording: "5 өдөр 4 шөнө" });
  const fieldsDisagree = datedTrip("cd3", fareOnce, { duration_text: "8 өдөр 7 шөнө", extra: { duration_days: 9, duration_nights: 8 } });
  assert.equal(checkTripConsistency(fieldsDisagree).durationConflict, true);
  const programShort = withProgram("cd4", [{ title: "1", description: "a" }, { title: "2", description: "b" }, { title: "3", description: "c" }], { duration_text: "8 өдөр 7 шөнө" });
  assert.equal(checkTripConsistency(programShort).durationConflict, true, "a 3-day program for an 8-day trip");
  // Duration conflicts warn but never blank the printed duration (it is the stored text).
  const snap = buildCatalogueSnapshot(inputOf([titleBad]));
  assert.equal(snap.trips[0].durationText, "6 өдөр 5 шөнө");
  assert.ok(snap.trips[0].warnings.some((w) => w.code === "duration_conflict"));
});

/* ---- trip codes: one code per trip id in every edition, first-use order, never reused */

function memoryCodeStore() {
  const rows: Array<{ id: string; code: string }> = [];
  let calls = 0;
  return {
    rows,
    get calls() { return calls; },
    async getTripCodeMap() { return Object.fromEntries(rows.map((r) => [r.id, r.code])); },
    async assignTripCodes(ids: string[]) {
      calls += 1;
      for (const id of ids) if (!rows.some((r) => r.id === id)) rows.push({ id, code: `A${String(rows.length + 1).padStart(2, "0")}` });
      return Object.fromEntries(ids.map((id) => [id, rows.find((r) => r.id === id)!.code]));
    },
  };
}

/** Ten eligible trips of three themes; created_at descending with the id so "oldest first" is distinguishable. */
function liveTen(): TravelTrip[] {
  const themes = ["Далайн амралт", "Хот соёл", "Байгаль нуур"];
  return Array.from({ length: 10 }, (_, i) => datedTrip(`lt${i}`, [["2027-01-09", 2_000_000 + i * 300_000]], {
    route_name: `Тест-${["Аа", "Бб", "Вв", "Гг", "Дд", "Ее", "Жж", "Зз", "Ии", "Кк"][i]}ланд ${themes[i % 3]} аялал`,
    created_at: `2026-0${(i % 9) + 1}-01T00:00:00.000Z`,
    extra: { transport_type: "direct_flight", website_details: { country: themes[i % 3] } },
  }));
}

test("V3 codes: the allocation order is the Quick book in print order, then the other trips by group and age, and never depends on the order trips arrive in", () => {
  const trips = liveTen();
  const quick = emptyConfig({ tripIds: ["lt7", "lt2", "lt5"] });
  const a = codeAllocationOrder({ trips, quick }, TODAY);
  assert.deepEqual(a.slice(0, 3), ["lt7", "lt2", "lt5"], "the staff Quick list first, in its order (the cover is not forced to A01)");
  assert.equal(new Set(a).size, 10);
  assert.equal(a.length, 10, "every eligible trip is numbered");
  assert.deepEqual(codeAllocationOrder({ trips: [...trips].reverse(), quick }, TODAY), a, "arrival order is irrelevant");
  const closed = datedTrip("lt-closed", [["2026-10-01", 1_000_000]]);
  assert.ok(!codeAllocationOrder({ trips: [...trips, closed], quick }, TODAY).includes("lt-closed"), "an ineligible trip takes no number");
  const excluded = codeAllocationOrder({ trips, quick: emptyConfig({ tripIds: ["lt7"], excludedTripIds: ["lt3"] }) }, TODAY);
  assert.ok(excluded.includes("lt3"), "a trip hidden from a book still has a code (the code belongs to the trip)");
});

test("V3 codes: with no staff list the recommended shortlist is numbered first; quick and complete read the same code for every shared trip, whatever the call order", async () => {
  const trips = liveTen();
  const config = emptyConfig();
  const order = () => codeAllocationOrder({ trips, quick: config }, TODAY);
  const shortlistIds = planEdition({ edition: "quick", trips, config }, TODAY).trips.map((t) => t.id);
  assert.ok(shortlistIds.length >= CATALOGUE_QUICK_MIN_TRIPS);

  for (const firstEdition of ["complete", "quick", "preview"] as const) {
    const store = memoryCodeStore();
    const planned = (edition: "quick" | "complete" | "preview") => planEdition({ edition, trips, config }, TODAY).trips;
    const first = await resolveCodeMap(planned(firstEdition), store, { allocate: true, order });
    const quickMap = await resolveCodeMap(planned("quick"), store, { allocate: true, order });
    const completeMap = await resolveCodeMap(planned("complete"), store, { allocate: true, order });
    for (const id of shortlistIds) assert.equal(quickMap[id], completeMap[id], `${id} reads one code in both editions (first used: ${firstEdition})`);
    assert.deepEqual(shortlistIds.map((id) => completeMap[id]), shortlistIds.map((_, i) => `A${String(i + 1).padStart(2, "0")}`), "the Quick book owns A01.. in its own order");
    if (Object.keys(first).length) assert.equal(first[shortlistIds[0]], "A01", "whichever edition is used first, the Quick book still owns A01");
    assert.equal(new Set(Object.values(completeMap)).size, 10);

    const quickSnap = buildCatalogueSnapshot(inputOf(trips, { edition: "quick", codeMap: quickMap, config }));
    const completeSnap = buildCatalogueSnapshot(inputOf(trips, { edition: "complete", codeMap: completeMap, config }));
    const completeById = new Map(completeSnap.trips.map((c) => [c.tripId, c]));
    for (const card of quickSnap.trips) {
      const other = completeById.get(card.tripId)!;
      assert.equal(card.code, other.code);
      assert.equal(card.editorialTitle, other.editorialTitle, "a trip reads the same title in both books");
      assert.equal(card.transportLabel, other.transportLabel);
      assert.equal(card.price.display, other.price.display);
    }
    const writes = store.calls;
    await resolveCodeMap(planned("complete"), store, { allocate: true, order });
    assert.equal(store.calls, writes, "when every planned trip already has a code nothing is written");
  }
});

test("V3 codes: a trip the order function missed is still numbered, oldest first, after the canonical ones; a read-only load never allocates", async () => {
  const trips = liveTen();
  const store = memoryCodeStore();
  const map = await resolveCodeMap(trips.slice(0, 3), store, { allocate: true, order: () => ["lt9"] });
  assert.equal(map.lt9, "A01");
  assert.deepEqual([map.lt0, map.lt1, map.lt2].every(Boolean), true);
  const before = store.calls;
  await resolveCodeMap(trips, store, { allocate: false, provisional: true });
  assert.equal(store.calls, before);
});

/* ---- weak or missing heroes and the Quick book */

test("V3 quick: weak and missing heroes are never recommended while enough strong ones remain; a thin pool still fills the book", () => {
  const strong = manyCards().filter((c) => c.heroQuality !== "weak");
  const weakOne = card("wk1", { heroQuality: "weak", groupKey: "city", destinationKey: "kwk", destinationKeys: ["kwk"] });
  const missingOne = card("ms1", { heroQuality: "missing", photo: null, groupKey: "nature", destinationKey: "kms", destinationKeys: ["kms"] });
  const a = recommendShortlist([...strong, weakOne, missingOne]);
  assert.ok(!a.tripIds.includes("wk1") && !a.tripIds.includes("ms1"));
  const thin = [...strong.filter((c) => c.groupKey === "beach").slice(0, 3), weakOne, missingOne, card("wk2", { heroQuality: "weak" }), card("wk3", { heroQuality: "weak" }), card("wk4", { heroQuality: "weak" }), card("wk5", { heroQuality: "weak" })];
  assert.ok(recommendShortlist(thin).tripIds.length >= CATALOGUE_QUICK_MIN_TRIPS, "fewer than MIN strong trips: the weak ones fill the book rather than leave it thin");
});

test("V3 quick: a staff-configured Quick list that keeps a weak or missing hero is blocking (listing the codes); a clean list is not", () => {
  const ids = Array.from({ length: 8 }, (_, i) => `q${i}`);
  const trips = ids.map((id, i) => datedTrip(id, fareOnce, { route_name: `Тест-${id}`, photo_urls: i === 0 ? [] : [`${IMG}/${id}-2400x1600.jpg`] }));
  const sizes = Object.fromEntries(ids.slice(1).map((id) => [`${IMG}/${id}-2400x1600.jpg`, { width: 2400, height: 1600, colorful: 80, sharpness: 500 }]));
  const bad = buildCatalogueSnapshot(inputOf(trips, { edition: "quick", config: emptyConfig({ tripIds: ids }), photoSizes: sizes }));
  const block = bad.warnings.find((w) => w.code === "photo_missing" && w.severity === "blocking" && !w.tripId);
  assert.ok(block, "blocking until the photo is replaced");
  assert.equal(block!.detail?.codes, "A01");
  const fixed = buildCatalogueSnapshot(inputOf(trips, {
    edition: "quick", config: emptyConfig({ tripIds: ids }), photoSizes: sizes,
    heroByTripId: { q0: { url: `${IMG}/q0-chosen-2400x1600.jpg`, quality: "good" } },
  }));
  assert.ok(!fixed.warnings.some((w) => w.code === "photo_missing" && w.severity === "blocking" && !w.tripId));
  const complete = buildCatalogueSnapshot(inputOf(trips, { edition: "complete", photoSizes: sizes }));
  assert.ok(!complete.warnings.some((w) => w.code === "photo_missing" && w.severity === "blocking" && !w.tripId), "only the Quick book is held back");
});

/* ---- the cover photograph */

const big = (n: string) => `${IMG}/${n}-2400x1800.jpg`;
const vivid = { width: 2400, height: 1800, colorful: 80, sharpness: 500 };

test("V3 cover: the staff choice wins; otherwise the strongest excellent, tall photo no trip page uses; never a hero; none when nothing qualifies", () => {
  const a = datedTrip("cv1", fareOnce, { route_name: "Тест-Нэгт", photo_urls: [big("a1"), big("a2")] });
  const b = datedTrip("cv2", fareOnce, { route_name: "Тест-Хоёрт", photo_urls: [big("b1"), `${IMG}/b2-1200x800.jpg`] });
  const photoSizes = { [big("a1")]: vivid, [big("a2")]: { ...vivid, colorful: 60 }, [big("b1")]: vivid, [`${IMG}/b2-1200x800.jpg`]: { width: 1200, height: 800 } };
  const base = inputOf([a, b], { photoSizes });
  const auto = buildCatalogueSnapshot(base);
  const heroes = new Set(auto.trips.map((c) => c.photo?.url));
  assert.ok(auto.coverPhoto, "an unused excellent photograph exists");
  assert.ok(!heroes.has(auto.coverPhoto!.url), "no trip page uses the cover photograph");
  assert.ok((auto.coverPhoto!.height ?? 0) >= 1200);
  assert.ok(auto.coverTripId === "cv1" || auto.coverTripId === "cv2");
  assert.deepEqual(buildCatalogueSnapshot(base).coverPhoto, auto.coverPhoto, "deterministic");

  const staff = buildCatalogueSnapshot({ ...base, coverPhoto: { url: big("b1"), focal: { x: 0.3, y: 0.6 }, zoom: 1.4 } });
  assert.equal(staff.coverPhoto?.url, big("b1"));
  assert.deepEqual(staff.coverPhoto?.focal, { x: 0.3, y: 0.6 });
  assert.equal(staff.coverPhoto?.zoom, 1.4);
  assert.notEqual(staff.contentHash, auto.contentHash, "the cover is part of what is printed");

  const clash = buildCatalogueSnapshot({ ...base, coverPhoto: { url: auto.trips[0].photo!.url } });
  assert.ok(clash.warnings.some((w) => w.code === "other" && w.severity === "warning" && /нүүр хуудасны зураг/i.test(w.message)), "a cover that repeats a page's hero is flagged");

  const lone = datedTrip("cv3", fareOnce, { route_name: "Тест-Гуравт", photo_urls: [big("c1")] });
  const none = buildCatalogueSnapshot(inputOf([lone], { photoSizes: { [big("c1")]: vivid } }));
  assert.equal(none.coverPhoto, null, "its only photo is its own hero");
  assert.equal(resolveCoverPhoto({ cards: [], trips: [], posterByTripId: {} }).photo, null);
});

/* ---- apply-picks planner */

test("V3 picks: only a trip's own candidates, focal 0..1, zoom 1..3; staff choices are kept unless --overwrite; a second run changes nothing", async () => {
  const { planPicks, validatePick } = await import("../scripts/catalogue-apply-picks");
  const own = new Set([photoKey(big("p1")), photoKey(big("p2"))]);
  assert.equal(validatePick({ url: big("p1"), focal: { x: 0.5, y: 0.4 }, zoom: 1.2, quality: "good" }, own, "t").choice?.url, big("p1"));
  assert.deepEqual(validatePick({ url: big("p1"), focal: [0.2, 0.8] }, own, "t").choice?.focal, { x: 0.2, y: 0.8 }, "the editor's [x, y] form");
  for (const bad of [{ url: `${IMG}/other.jpg` }, { url: big("p1"), focal: { x: 1.2, y: 0.5 } }, { url: big("p1"), zoom: 3.5 }, { url: big("p1"), zoom: 0.5 }, { url: big("p1"), quality: "great" }]) {
    const r = validatePick(bad as never, own, "t");
    assert.equal(r.choice, null);
    assert.ok(r.issues.length === 1, JSON.stringify(bad));
  }
  assert.deepEqual(validatePick({ note: "needs a replacement" }, own, "t"), { choice: null, issues: [] }, "no url is skipped, not refused");

  const input = {
    config: { heroByTripId: { t2: { url: big("p2") } }, coverPhoto: null },
    picks: { t1: { url: big("p1"), focal: { x: 0.5, y: 0.5 } }, t2: { url: big("p1") } },
    cover: { tripId: "t1", url: big("p2"), focal: { x: 0.5, y: 0.5 }, zoom: 1 },
    candidatesByTrip: { t1: own, t2: own },
    titleByTrip: { t1: "Нэг", t2: "Хоёр" },
    overwrite: false,
  };
  const plan = planPicks(input);
  assert.deepEqual(plan.issues, []);
  assert.equal(plan.heroByTripId.t1.url, big("p1"));
  assert.equal(plan.heroByTripId.t2.url, big("p2"), "a hero staff already chose is kept");
  assert.deepEqual(plan.diffs.map((d) => d.action), ["add", "keep-staff"]);
  assert.equal(plan.coverPhoto?.url, big("p2"));
  assert.equal(plan.changed, true);
  assert.equal(planPicks({ ...input, overwrite: true }).heroByTripId.t2.url, big("p1"));

  const again = planPicks({ ...input, config: { heroByTripId: plan.heroByTripId, coverPhoto: plan.coverPhoto } });
  assert.equal(again.changed, false, "idempotent: nothing left to write");
  assert.deepEqual(again.diffs.map((d) => d.action), ["same", "keep-staff"]);

  const refused = planPicks({ ...input, picks: { t1: { url: `${IMG}/elsewhere.jpg` }, ghost: { url: big("p1") } } });
  assert.equal(refused.issues.length, 2, "an unknown url and an unknown trip are both refused");
});

/* ---------------------------------------------------------------- V4: full schedule, per-date fares, rolling window */

test("schedule: EVERY future departure (uncapped, ascending) with its own adult fare; window cut at 90 days incl. the boundary day", () => {
  // TODAY 2026-11-06 -> window is 2026-11-07 .. 2027-02-04 (90 days, boundary inclusive).
  const days = ["2026-11-07", "2026-11-20", "2026-12-04", "2026-12-18", "2027-01-01", "2027-01-08", "2027-01-15", "2027-01-22",
    "2027-01-29", "2027-02-04", "2027-02-05", "2027-02-12", "2027-02-19", "2027-02-26", "2027-03-05"];
  const t = datedTrip("sch1", days.map((d, i) => [d, 2_000_000 + i * 10_000] as [string, number]));
  const info = deriveDateInfo(t, TODAY);
  assert.equal(info.schedule?.length, 15, "uncapped: more than the 12 shown in `departures`");
  assert.equal(info.departures.length, 12);
  assert.deepEqual(info.schedule?.map((e) => e.date), days, "ascending, nothing invented");
  assert.deepEqual(info.schedule?.[3], { date: "2026-12-18", adultMnt: 2_030_000 }, "each date carries its own fare");
  assert.equal(info.windowDays, 90);
  assert.equal(info.window?.at(-1)?.date, "2027-02-04", "the boundary day (today + 90) is inside the window");
  assert.ok(!info.window?.some((e) => e.date === "2027-02-05"), "day 91 is outside");
  assert.equal(info.window?.length, 10);
  assert.equal(info.priceVaries, true);
});

test("schedule: past, today, sold-out and closed dates never appear; a date without a recorded adult fare has null", () => {
  const t = datedTrip("sch2", [["2026-10-01", 1_000_000], ["2026-11-06", 1_000_000], ["2026-12-04", 1_500_000], ["2027-01-09", 1_700_000], ["2027-02-06", 1_900_000], ["2027-03-06", null]], {
    extra: { website_departure_availability: [
      { date: "2027-01-09", status: "SOLD_OUT", seatsLeft: 0 },
      { date: "2027-02-06", status: "CLOSED", seatsLeft: 4 },
    ] },
  });
  const info = deriveDateInfo(t, TODAY);
  assert.deepEqual(info.schedule?.map((e) => e.date), ["2026-12-04", "2027-03-06"].filter((d) => info.schedule?.some((e) => e.date === d)));
  assert.ok(!info.schedule?.some((e) => ["2026-10-01", "2026-11-06", "2027-01-09", "2027-02-06"].includes(e.date)));
  assert.equal(info.schedule?.find((e) => e.date === "2026-12-04")?.adultMnt, 1_500_000);
  const missing = info.schedule?.find((e) => e.date === "2027-03-06");
  if (missing) assert.equal(missing.adultMnt, null, "no recorded fare -> null, never 0 or a copy of another date");
  assert.deepEqual(info.nextDeparture, "2026-12-04");
});

test("schedule: the first departure beyond 90 days leaves the window empty but nextDeparture and schedule set", () => {
  const t = datedTrip("sch3", [["2027-04-10", 2_500_000], ["2027-05-08", 2_600_000]]);
  const info = deriveDateInfo(t, TODAY);
  assert.deepEqual(info.window, []);
  assert.equal(info.nextDeparture, "2027-04-10");
  assert.deepEqual(info.schedule, [{ date: "2027-04-10", adultMnt: 2_500_000 }, { date: "2027-05-08", adultMnt: 2_600_000 }]);
  assert.equal(info.label, "Хөдлөх огноо: 2027.04.10, 2027.05.08");
});

test("schedule: priceVaries is false when every listed fare is equal, and a hotel date takes its cheapest fare", () => {
  const flat = deriveDateInfo(datedTrip("sch4", [["2026-12-04", 1_500_000], ["2026-12-11", 1_500_000], ["2026-12-18", 1_500_000]]), TODAY);
  assert.equal(flat.priceVaries, false);
  const hotels = trip("sch5", {
    departure_dates: ["2026-12-04", "2026-12-11"],
    extra: { price_groups: [
      priceRow("2026-12-04", 3_000_000, { hotel: "Тест Резорт А" }), priceRow("2026-12-04", 2_400_000, { hotel: "Тест Резорт Б" }),
      priceRow("2026-12-11", 2_400_000, { hotel: "Тест Резорт Б" }),
    ] },
  });
  const info = deriveDateInfo(hotels, TODAY);
  assert.equal(info.schedule?.[0].adultMnt, 2_400_000);
  assert.equal(info.priceVaries, false);
});

test("schedule: a weekly-rule trip keeps its safe label and has an empty schedule", () => {
  const weekly = trip("sch6", { departure_dates: ["Пүрэв гараг бүр"], adult_price: 1_200_000, extra: { price_groups: [priceRow("", 1_200_000, { dates: [], display_dates: [], date_keys: [] })] } });
  const info = deriveDateInfo(weekly, TODAY);
  assert.equal(info.label, "Пүрэв гараг бүр");
  assert.deepEqual(info.schedule, []);
  assert.deepEqual(info.window, []);
  assert.equal(info.priceVaries, false);
});

test("schedule: the snapshot carries it per card, deterministically, and the content hash covers it", () => {
  const fares: Array<[string, number]> = [["2026-12-04", 1_500_000], ["2026-12-11", 1_600_000]];
  const a = buildCatalogueSnapshot(inputOf([datedTrip("sch7", fares)]));
  const b = buildCatalogueSnapshot(inputOf([datedTrip("sch7", fares)]));
  assert.deepEqual(a.trips[0].dates.schedule, [{ date: "2026-12-04", adultMnt: 1_500_000 }, { date: "2026-12-11", adultMnt: 1_600_000 }]);
  assert.equal(a.contentHash, b.contentHash, "same data -> same hash");
  const priced = buildCatalogueSnapshot(inputOf([datedTrip("sch7", [["2026-12-04", 1_500_000], ["2026-12-11", 1_650_000]])]));
  assert.notEqual(priced.contentHash, a.contentHash, "a non-minimum date's fare changes the printed schedule, hence the hash");
});

test("liveDrift: a changed schedule or any date's adult fare is drift; the window moving with time is not", () => {
  const fares: Array<[string, number]> = [["2026-12-04", 1_500_000], ["2026-12-11", 1_600_000], ["2027-02-06", 1_700_000], ["2027-04-09", 1_800_000]];
  const published = buildCatalogueSnapshot(inputOf([datedTrip("dr1", fares)]));
  // Three days later the 90-day window starts and ends later, but the schedule is the same: not drift.
  const later = buildCatalogueSnapshot(inputOf([datedTrip("dr1", fares)], { nowIso: "2026-11-09T04:00:00.000Z" }));
  assert.notDeepEqual(later.trips[0].dates.window, published.trips[0].dates.window, "the window itself did move");
  assert.deepEqual(liveDrift(published, later), { drifted: false, reasons: [] });
  // A far-future (outside the window) date's fare changed: drift, although the price-from and the window are untouched.
  const farFare = buildCatalogueSnapshot(inputOf([datedTrip("dr1", [fares[0], fares[1], fares[2], ["2027-04-09", 1_900_000]])]));
  assert.equal(liveDrift(published, farFare).drifted, true);
  assert.match(liveDrift(published, farFare).reasons.join(" "), /үнэ өөрчлөгдсөн/);
  // A date sold out / removed: drift.
  const removed = buildCatalogueSnapshot(inputOf([datedTrip("dr1", [fares[0], fares[2], fares[3]])]));
  assert.equal(liveDrift(published, removed).drifted, true);
  // A date added: drift.
  const added = buildCatalogueSnapshot(inputOf([datedTrip("dr1", [...fares, ["2027-05-14", 1_900_000]])]));
  assert.equal(liveDrift(published, added).drifted, true);
  assert.match(liveDrift(published, added).reasons.join(" "), /шинэ огноо/);
});
