import assert from "node:assert/strict";
import test, { before } from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { CategoryRow } from "../src/lib/tripCategorization";
import type { TravelTrip } from "../src/lib/travelTypes";

applyTestEnv();

// Static imports are hoisted above applyTestEnv(), and env.ts validates on
// load — pull the module in only after the env is set, same pattern as
// tests/age-rules-and-infant-tier.test.ts.
let departureMonths: typeof import("../src/lib/tripCategorization").departureMonths;
let isWinterOnly: typeof import("../src/lib/tripCategorization").isWinterOnly;
let ruleBasedGuess: typeof import("../src/lib/tripCategorization").ruleBasedGuess;
before(async () => {
  ({ departureMonths, isWinterOnly, ruleBasedGuess } = await import("../src/lib/tripCategorization"));
});

// The real category names Uudam has created on the live website, so the
// rule-based checks are proven against what actually exists, not a fixture
// that happens to be convenient.
const CATEGORIES: CategoryRow[] = [
  { id: "regular", categoryName: "Тогтмол аялал" },
  { id: "combined", categoryName: "газар + нислэг хосолсон" },
  { id: "land", categoryName: "газрын аялал" },
  { id: "cruise", categoryName: "круз аялал" },
  { id: "flight", categoryName: "шууд нислэгтэй аялал" },
  { id: "winter", categoryName: "Өвлийн аялал" },
];

function trip(fields: Partial<TravelTrip>): TravelTrip {
  return {
    id: "trip-1",
    category: "",
    operator_name: "UUDAM TRAVEL AGENCY",
    route_name: "Test trip",
    duration_text: "5 өдөр",
    adult_price: 1000000,
    child_price: 900000,
    infant_price: 0,
    currency: "MNT",
    departure_dates: [],
    seats_total: null,
    seats_left: null,
    has_food: null,
    status: "active",
    customer_visible: true,
    notes: "",
    hotel: "",
    source_description: "",
    photo_urls: [],
    extra: {},
    updated_at: "",
    aliases: [],
    price_groups: [],
    discounts: [],
    child_rules: [],
    extra_fees: [],
    departure_rule: "",
    included_items: [],
    excluded_items: [],
    room_prices: [],
    important_notes: [],
    source_provenance: [],
    answer_hints: [],
    needs_human_review: false,
    review_reasons: [],
    ...fields,
  } as TravelTrip;
}

test("departureMonths reads every distinct month out of Mongolian date text", () => {
  assert.deepEqual(
    departureMonths(["7 сарын 6", "7 сарын 13", "8 сарын 3"]).sort(),
    [7, 8],
  );
  assert.deepEqual(departureMonths(["Бямба гараг бүр"]), []);
  assert.deepEqual(departureMonths([]), []);
});

test("isWinterOnly is true only when EVERY departure month is Dec/Jan/Feb", () => {
  assert.equal(isWinterOnly(["12 сарын 20", "1 сарын 5"]), true);
  assert.equal(isWinterOnly(["2 сарын 1"]), true);
  // A single non-winter month disqualifies the whole trip.
  assert.equal(isWinterOnly(["12 сарын 20", "7 сарын 6"]), false);
  assert.equal(isWinterOnly(["7 сарын 6"]), false);
  // No parseable dates at all — never guess winter.
  assert.equal(isWinterOnly(["Бямба гараг бүр"]), false);
  assert.equal(isWinterOnly([]), false);
});

test("a trip departing only in winter months goes to the winter category", () => {
  const t = trip({ departure_dates: ["12 сарын 15", "1 сарын 10"] });
  const result = ruleBasedGuess(t, CATEGORIES);
  assert.equal(result?.id, "winter");
});

test("a trip with summer dates is never forced into winter", () => {
  const t = trip({ route_name: "Токио аялал", departure_dates: ["7 сарын 6"] });
  const result = ruleBasedGuess(t, CATEGORIES);
  assert.notEqual(result?.id, "winter");
});

test("a cruise ship trip is recognised from its own title text", () => {
  const t = trip({ route_name: "Дрийм усан онгоцны 10шөнө 11өдөр" });
  const result = ruleBasedGuess(t, CATEGORIES);
  assert.equal(result?.id, "cruise");
});

test("winter takes priority over a cruise name when both signals are present", () => {
  // A winter-dated cruise still reads as a cruise per the code's own order —
  // document the actual precedence so a future change to it is deliberate.
  const t = trip({ route_name: "Круз аялал", departure_dates: ["1 сарын 5"] });
  const result = ruleBasedGuess(t, CATEGORIES);
  assert.equal(result?.id, "winter");
});

test("an ordinary land trip with no special signal is left for the model, not forced", () => {
  const t = trip({ route_name: "ЖИНИН – ХӨХ ХОТ - ОРДОС", departure_dates: ["7 сарын 6"] });
  const result = ruleBasedGuess(t, CATEGORIES);
  assert.equal(result, null);
});

test("when no categories exist at all, the rule-based guess never crashes", () => {
  const t = trip({ route_name: "Дрийм усан онгоцны аялал" });
  assert.equal(ruleBasedGuess(t, []), null);
});
