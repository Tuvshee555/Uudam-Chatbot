import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";
import {
  isGreetingLike,
  isKnownGreetingPhrase,
  isThanksOnly,
} from "../src/lib/greetingPhrases";
import { isLikelyContextDependentText } from "../src/lib/contextualText";
import type { TravelTrip } from "../src/lib/travelTypes";

// Regressions found by reading 81 real Messenger customers' conversations
// (2026-09-20). Every case below is a message a real customer sent, matched
// against fixtures shaped like the real catalog entries that misbehaved.

function trip(fields: Partial<TravelTrip>): TravelTrip {
  return {
    id: fields.route_name || "trip",
    category: "",
    operator_name: "Uudam Travel",
    route_name: "Trip",
    duration_text: "",
    adult_price: null,
    child_price: null,
    infant_price: null,
    currency: "MNT",
    departure_dates: [],
    seats_total: null,
    seats_left: null,
    has_food: null,
    status: "active",
    notes: "",
    hotel: "",
    source_description: "",
    photo_urls: [],
    extra: {},
    created_at: "",
    updated_at: "",
    ...fields,
  };
}

const ORDOS = trip({ route_name: "Ордос -намрын тахилга үзэх аялал", duration_text: "8 өдөр 7 шөнө", departure_dates: ["10 сарын 18"] });
const SHANGHAI_ZHANGJIAJIE = trip({
  route_name: "Шанхай + Тэнгэрийн хаалга шууд нислэгтэй аялал ( Жанжиажэ - Аватар )",
  duration_text: "8 өдөр 7 шөнө",
  departure_dates: ["11 сарын 19"],
});
const CHONGQING_ZHANGJIAJIE = trip({ route_name: "Чунчин- Жанжиажэ (Тэнгэрийн хаалга / Аватар) газар нислэг хосолсон аялал", duration_text: "10 өдөр 9 шөнө", departure_dates: ["10 сарын 8"] });
const ZHANGJIAJIE_COMBO = trip({ route_name: "ЖАНЖИАЖИЭ ГАЗАР НИСЛЭГ ХОСОЛСОН АЯЛАЛ ( Жанжиажэ - Аватар )", duration_text: "10 өдөр 9 шөнө", departure_dates: ["10 сарын 13"] });
const ZHANGJIAKOU = trip({ route_name: "Бээжин - Жинин – Жанжакоу - Эрээн – 4 хотын аялал", duration_text: "8 өдөр 7 шөнө", departure_dates: ["Ням гараг бүр"] });
const SHANGHAI_NOV = trip({ route_name: "УБ-Шанхай хотын 11-р сарын аяллын хөтөлбөр", duration_text: "6 өдөр 5 шөнө", departure_dates: ["11 сарын 12", "11 сарын 26"] });
const SHANGHAI_DISNEY_NOV3 = trip({ route_name: "ШАНХАЙ - -ДИСНЕЙЛЭНД -сурагчдын амралт -11/3", duration_text: "5 өдөр 4 шөнө", departure_dates: ["11 сарын 3"] });
const SHANGHAI_DISNEY_OCT29 = trip({ route_name: "ШАНХАЙ - ДИСНЭЙЛАНД -сурагчдын амралтын аялал - 10/29", duration_text: "6 өдөр 5 шөнө", departure_dates: ["10 сарын 29"] });
const NATURE_PARK = trip({ route_name: "И Сан По байгалийн цогцолборт газар", duration_text: "3 өдөр", departure_dates: ["9 сарын 26"] });

const CATALOG = [
  ORDOS,
  SHANGHAI_ZHANGJIAJIE,
  CHONGQING_ZHANGJIAJIE,
  ZHANGJIAJIE_COMBO,
  ZHANGJIAKOU,
  SHANGHAI_NOV,
  SHANGHAI_DISNEY_NOV3,
  SHANGHAI_DISNEY_OCT29,
  NATURE_PARK,
];

async function search() {
  applyTestEnv();
  return import("../src/lib/travelFastPathsSearch");
}

async function resolve(text: string) {
  const { resolveTripFromUserMessage } = await search();
  return resolveTripFromUserMessage(text, CATALOG, { allowLooseFallback: false });
}

// ── Wrong PDF: "Хөтөлбөр үзэх" matched the Ordos trip on the word "үзэх" ─────────

test("the 'Хөтөлбөр үзэх' / 'Зураг үзэх' buttons never pick a trip by the verb 'үзэх'", async () => {
  for (const text of ["Хөтөлбөр үзэх", "Зураг үзэх", "хөтөлбөр харъя"]) {
    const result = await resolve(text);
    assert.equal(result.status, "not_found", `"${text}" must not resolve to a trip on its own`);
  }
});

test("a bare 'Хөтөлбөр' is not a price question (it contains 'төлбөр' as a substring)", async () => {
  const { isStructuredTripQuestion } = await search();
  assert.equal(isStructuredTripQuestion("Хөтөлбөр"), false);
  assert.equal(isStructuredTripQuestion("Хөтөлбөр үзэх"), false);
  // Real price questions are still structured.
  assert.equal(isStructuredTripQuestion("Үнэ"), true);
  assert.equal(isStructuredTripQuestion("Тэнгэрийн хаалга төлбөр хэд вэ"), true);
});

// ── Generic price / info requests: ask which trip, never hand off to staff ────────

test("typed forms of 'price' and 'information' are understood", async () => {
  const { isStructuredTripQuestion } = await search();
  for (const text of ["Vne", "Үний", "Үнэ", "vne"]) {
    assert.equal(isStructuredTripQuestion(text), true, text);
  }
});

test("requests that name no destination are recognised as generic", async () => {
  const { isGenericTripRequest } = await search();
  for (const text of [
    "Үнэ",
    "Vne",
    "Үний",
    "Аялалын үнэ сонирхож байна",
    "Хэд хоногийн аялал хэдэн төг вээ",
    "Aylaluud",
    "Medeelel avay",
    "Хөтөлбөр",
  ]) {
    assert.equal(isGenericTripRequest(text), true, `should be generic: ${text}`);
  }
});

test("a named destination, a date or a number is NOT a generic request", async () => {
  const { isGenericTripRequest } = await search();
  for (const text of [
    "Жэжү аялал гарч байгаа юу?", // a place we may not offer: staff should see this
    "Тэнгэрийн хаалга үнэ хэд вэ?",
    "10 сарын үнэ",
    "5",
    "Шанхай",
    "",
  ]) {
    assert.equal(isGenericTripRequest(text), false, `must not be generic: "${text}"`);
  }
});

// ── Greetings and thanks ─────────────────────────────────────────────────────

test("typed greeting variants are greetings, not questions", () => {
  for (const text of ["сайн сайн байна уу?", "Sn bnuu", "Сайн бну", "sain bnuu", "Өдрийн мэндээ", "оройн мэндээ"]) {
    assert.equal(isKnownGreetingPhrase(text), true, text);
    assert.equal(isGreetingLike(text), true, text);
  }
});

test("a greeting with a real question attached is not swallowed", () => {
  for (const text of ["сайн байна уу Шанхай үнэ хэд вэ", "hi shanghai price", "Үнэ", "Сайн байна уу 10 сарын аялал"]) {
    assert.equal(isKnownGreetingPhrase(text), false, text);
  }
});

test("a bare thank-you is recognised and never treated as a follow-up", () => {
  for (const text of ["Баярлалаа", "за баярлалаа", "Thanks", "bayrlalaa", "Баярлалаа 🙏"]) {
    assert.equal(isThanksOnly(text), true, text);
    assert.equal(isLikelyContextDependentText(text), false, `"${text}" must not borrow earlier trips`);
  }
});

test("thanks plus a real message, or a lone 'за', is not a bare thank-you", () => {
  for (const text of ["Баярлалаа. Дажгүй явж байнаа", "баярлалаа үнэ хэд вэ", "за", "баярлалаа Шанхай"]) {
    assert.equal(isThanksOnly(text), false, text);
  }
});

// ── Zhangjiajie spellings and unrelated-word collisions ──────────────────────

test("misspelled Zhangjiajie finds the Zhangjiajie trips, not Shanghai-Disney or Zhangjiakou", async () => {
  const combo = await resolve("Шанхай Жанжио аялал");
  assert.equal(combo.status, "verified");
  assert.ok(combo.status === "verified" && combo.trip.route_name.includes("Жанжиажэ"));

  const combo2 = await resolve("Жанжиэжэ шанхайтай бна уу?");
  assert.equal(combo2.status, "verified");
  assert.ok(combo2.status === "verified" && combo2.trip.id === SHANGHAI_ZHANGJIAJIE.id);

  for (const text of ["Жанжиотой аялал", "Жанжиатай аялал хөтөлбөр"]) {
    const result = await resolve(text);
    assert.notEqual(result.status, "not_found", text);
    const names =
      result.status === "verified"
        ? [result.trip.route_name]
        : result.status === "ambiguous"
          ? result.candidates.map((candidate) => candidate.route_name)
          : [];
    assert.ok(names.length > 0 && names.every((name) => /жанжиа/i.test(name)), `${text} -> ${names.join(" | ")}`);
    assert.ok(!names.some((name) => name.includes("Жанжакоу")), "Zhangjiakou must stay separate");
    assert.ok(!names.some((name) => /дисней|дисней/i.test(name)), "must not fall back to Disney");
  }
});

test("everyday words no longer collide with trip-name words", async () => {
  // "байгаа" (is there) ~ "байгалийн" (natural); "харин" (however) ~ "сарын" (month's).
  assert.equal((await resolve("Жэжү аялал гарч байгаа юу?")).status, "not_found");
  assert.equal((await resolve("Yamr2 hotiin aylal baigaawe")).status, "not_found");
  assert.equal((await resolve("Би харин завгү чатаа харах завгүыл бгад бн")).status, "not_found");
  assert.equal((await resolve("Бид 10 сарын 3-нд хилээр гарахаар")).status, "not_found");
});

test("slash and dash dates are understood when matching a trip", async () => {
  const result = await resolve("шанхай аялал 10/28 11/3");
  assert.equal(result.status, "verified");
  assert.ok(result.status === "verified" && result.trip.id === SHANGHAI_DISNEY_NOV3.id);
});

// ── Wrong facts from data-entry slips ────────────────────────────────────────

test("an infant band entered as '0-23 нас' (years) is shown as months", async () => {
  const { sanitizeTripForCustomers } = await search();
  const slipped = trip({
    route_name: "Шанхай + Тэнгэрийн хаалга",
    departure_dates: ["11 сарын 19"],
    extra: {
      price_groups: [
        {
          dates: ["11 сарын 19"],
          infant_age: "0-23 нас",
          passenger_prices: [
            { label: "Хүүхэд", price: 3330000, age_range: "" },
            { label: "0-23 САРТАЙ НЯРАЙ ХҮҮХЭД", price: 790000, age_range: "0-23 нас" },
          ],
        },
      ],
      age_rules: { infant: "0-23 нас" },
    },
  });
  const fixed = sanitizeTripForCustomers(slipped);
  const group = (fixed.extra as { price_groups: Array<Record<string, unknown>> }).price_groups[0];
  assert.equal(group.infant_age, "0-23 сар");
  const prices = group.passenger_prices as Array<Record<string, unknown>>;
  assert.equal(prices[1].age_range, "0-23 сар");
  assert.equal(prices[0].age_range, "", "the child entry is untouched");
  assert.equal((fixed.extra as { age_rules: { infant: string } }).age_rules.infant, "0-23 сар");
  // The admin's own data object is never mutated.
  assert.equal((slipped.extra as { price_groups: Array<Record<string, unknown>> }).price_groups[0].infant_age, "0-23 нас");
});

test("a genuine infant band in years is left alone", async () => {
  const { sanitizeTripForCustomers } = await search();
  const fine = trip({
    extra: { price_groups: [{ dates: [], infant_age: "0-2 нас" }], age_rules: { infant: "0-2 нас" } },
  });
  assert.equal(sanitizeTripForCustomers(fine), fine, "nothing to fix returns the same object");
});

test("price-group dates that are not real departures are dropped, real ones kept", async () => {
  const { sanitizeTripForCustomers } = await search();
  // The top-asked trip: departs only 11/19, but its price group still said 9/19 and 10/10.
  const stale = trip({
    route_name: "Шанхай + Тэнгэрийн хаалга",
    departure_dates: ["11 сарын 19"],
    extra: {
      price_groups: [
        {
          label: "9 сарын 19, 10 сарын 10",
          dates: ["9 сарын 19", "10 сарын 10"],
          display_dates: ["9 сарын 19", "10 сарын 10"],
          date_keys: ["9 сарын 19", "9/19", "10 сарын 10", "10/10"],
          adult_price: 3660000,
        },
        { label: "11 сарын 19", dates: ["11 сарын 19"], adult_price: 3660000 },
      ],
    },
  });
  const fixed = sanitizeTripForCustomers(stale);
  const [staleGroup, currentGroup] = (fixed.extra as { price_groups: Array<Record<string, unknown>> }).price_groups;
  assert.deepEqual(staleGroup.dates, []);
  assert.equal(staleGroup.label, "");
  assert.deepEqual(staleGroup.date_keys, []);
  assert.equal(staleGroup.adult_price, 3660000, "the price itself is kept");
  assert.deepEqual(currentGroup.dates, ["11 сарын 19"]);
});

test("a partly stale price group keeps only its real departure dates", async () => {
  const { sanitizeTripForCustomers } = await search();
  const mixed = trip({
    departure_dates: ["10 сарын 8", "10 сарын 15"],
    extra: { price_groups: [{ label: "9 сарын 10, 9 сарын 17, 10 сарын 15", dates: ["9 сарын 10", "9 сарын 17", "10 сарын 15"] }] },
  });
  const fixed = sanitizeTripForCustomers(mixed);
  const group = (fixed.extra as { price_groups: Array<Record<string, unknown>> }).price_groups[0];
  assert.deepEqual(group.dates, ["10 сарын 15"]);
  assert.equal(group.label, "10 сарын 15");
});

test("trips with weekly or no explicit departure dates are not reconciled", async () => {
  const { sanitizeTripForCustomers } = await search();
  const weekly = trip({
    departure_dates: ["Ням гараг бүр"],
    extra: { price_groups: [{ label: "Үнэ", dates: ["7 сарын 6", "7 сарын 13"] }] },
  });
  assert.equal(sanitizeTripForCustomers(weekly), weekly);
});
