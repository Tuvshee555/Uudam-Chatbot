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

test("a price group whose dates are all gone is dropped, so the base prices win", async () => {
  const { sanitizeTripForCustomers } = await search();
  // The top-asked trip: departs only 11/19, but a price group still said 9/19 and 10/10.
  const stale = trip({
    route_name: "Шанхай + Тэнгэрийн хаалга",
    departure_dates: ["11 сарын 19"],
    adult_price: 3660000,
    extra: {
      price_groups: [
        {
          label: "9 сарын 19, 10 сарын 10",
          dates: ["9 сарын 19", "10 сарын 10"],
          display_dates: ["9 сарын 19", "10 сарын 10"],
          date_keys: ["9 сарын 19", "9/19", "10 сарын 10", "10/10"],
          adult_price: 3560000, // an OLD price for departures that no longer exist
        },
        { label: "11 сарын 19", dates: ["11 сарын 19"], adult_price: 3660000 },
      ],
    },
  });
  const fixed = sanitizeTripForCustomers(stale);
  const groups = (fixed.extra as { price_groups: Array<Record<string, unknown>> }).price_groups;
  assert.equal(groups.length, 1, "the stale group (old price, old dates) is removed entirely");
  assert.deepEqual(groups[0].dates, ["11 сарын 19"]);
  assert.equal(fixed.adult_price, 3660000, "the trip's own base price is untouched");
  // The admin's own data is never mutated.
  assert.equal((stale.extra as { price_groups: unknown[] }).price_groups.length, 2);
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

// ── Button answer arriving after the bot forgot what it offered ──────────────

test("a 'which of these trips?' question is still remembered when the customer answers 35 minutes later", async () => {
  applyTestEnv();
  const { setClarificationState, getClarificationState, clearClarificationState } = await import(
    "../src/lib/clarificationState"
  );
  const senderId = "clarify-ttl-35min";
  const realNow = Date.now;
  try {
    await setClarificationState(senderId, ["trip-a", "trip-b"]);
    Date.now = () => realNow() + 35 * 60 * 1000;
    const state = await getClarificationState(senderId);
    assert.ok(state, "a real customer tapped their choice 35 minutes after the question and the bot had forgotten it");
    assert.deepEqual(state?.candidateTripIds, ["trip-a", "trip-b"]);
    // ...but it does not live forever.
    Date.now = () => realNow() + 7 * 60 * 60 * 1000;
    assert.equal(await getClarificationState(senderId), null);
  } finally {
    Date.now = realNow;
    await clearClarificationState(senderId);
  }
});


// ── Client report: "2 trips' info looks incomplete" (Shanghai) ────────────────

const HANGZHOU = trip({
  route_name: "Улаанбаатар – Шанхай – Хүжөү – Пүюань – Ханжоу аялал",
  duration_text: "8 өдөр 7 шөнө",
  adult_price: 3390000,
  child_price: 2690000,
  infant_price: 390000, // base infant price, shown in the admin as "Үндсэн Нярай"
  departure_dates: ["10 сарын 8", "10 сарын 15"],
  // Price groups carry NO infant figure and stale dates, exactly like the live trip.
  extra: { price_groups: [{ dates: ["9 сарын 10", "9 сарын 17", "10 сарын 15"], adult_price: 3390000, child_price: 2690000, infant_price: null }] },
});
const DISNEY_OCT29 = trip({
  route_name: "ШАНХАЙ - ДИСНЭЙЛАНД -сурагчдын амралтын аялал - 10/29",
  duration_text: "6 өдөр 5 шөнө",
  adult_price: 3590000,
  child_price: 3150000,
  infant_price: 490000,
  departure_dates: ["10 сарын 29"],
  extra: { price_groups: [{ dates: ["9 сарын 29"], adult_price: 3490000, child_price: 3290000, infant_price: null }] },
});
const SHANGHAI_TRIPS = [SHANGHAI_NOV, HANGZHOU, SHANGHAI_DISNEY_NOV3, DISNEY_OCT29, SHANGHAI_ZHANGJIAJIE, trip({ route_name: "УБ-Шанхай хотын 12-р сарын аяллын хөтөлбөр", duration_text: "5 өдөр 4 шөнө", adult_price: 2890000, departure_dates: ["12 сарын 22"] })];

test("a trip's base infant price is listed even when its price groups have none", async () => {
  const { buildAmbiguousTripReply } = await import("../src/lib/travelFastPaths");
  applyTestEnv();
  const reply = buildAmbiguousTripReply([HANGZHOU, DISNEY_OCT29]);
  assert.match(reply, /Ханжоу аялал — 8 өдөр 7 шөнө · том хүн 3,390,000₮ · хүүхэд 2,690,000₮ · нярай 390,000₮/);
  assert.match(reply, /10\/29 — 6 өдөр 5 шөнө · том хүн 3,590,000₮ · хүүхэд 3,150,000₮ · нярай 490,000₮/);
});

test("asking about Shanghai lists EVERY Shanghai trip, not just the top 3", async () => {
  const { resolveTripFromUserMessage } = await search();
  // The client's own message, and plain phrasings of the same question.
  for (const text of ["hi Shanhai aylaliin medeelel aviya", "Shanghai", "Шанхай аялал", "shanhai aylal medeelel"]) {
    const result = resolveTripFromUserMessage(text, SHANGHAI_TRIPS, { allowLooseFallback: false });
    assert.equal(result.status, "ambiguous", text);
    assert.equal(
      result.status === "ambiguous" ? result.candidates.length : 0,
      SHANGHAI_TRIPS.length,
      `"${text}" must offer all ${SHANGHAI_TRIPS.length} Shanghai trips`,
    );
  }
});

test("the numbered choice still works once more than three trips are offered", async () => {
  applyTestEnv();
  const { routeFastPathText } = await import("../src/lib/fastPathRouting");
  const senderId = "shanghai-numbered-choice";
  const first = await routeFastPathText({ senderId, text: "Shanghai", contextualUserText: "Shanghai", trips: SHANGHAI_TRIPS });
  assert.ok(first.matchText.includes("Shanghai"));
  const picked = await routeFastPathText({ senderId, text: "4. Улаанбаатар – Шанхай…", contextualUserText: "4. Улаанбаатар – Шанхай…", trips: SHANGHAI_TRIPS });
  // Button 4 in the offered list is the Hangzhou trip (the buttons are numbered
  // in the order the reply lists the trips).
  assert.ok(
    picked.matchText.includes(HANGZHOU.route_name),
    `option 4 must resolve to the Hangzhou trip, got: ${picked.matchText.slice(0, 80)}`,
  );
});

// ── "10 сарын 20-27 хооронд явах шууд нислэгтэй ямар аялал байгаа вэ" ───────────

const DIRECT_OCT20 = trip({
  route_name: "Египет шууд нислэгтэй аялал",
  category: "Шууд нислэгтэй аялал",
  duration_text: "7 өдөр 6 шөнө",
  adult_price: 4990000,
  departure_dates: ["10 сарын 22"],
});
const LAND_OCT20 = trip({
  route_name: "ШАР ТЭНГИС БУЮУ БЭЙДАЙХЭ-БЭЭЖИНГИЙН ГАЗРЫН АЯЛАЛ",
  category: "Газрын аялал",
  duration_text: "9 өдөр 8 шөнө",
  adult_price: 1390000,
  departure_dates: ["10 сарын 20"],
});
const COMBO_OCT20 = trip({
  route_name: "ТЭНГЭРИЙН ХААЛГАНЫ ГАЗАР НИСЛЭГ ХОСОЛСОН АЯЛАЛ ( Жанжиажэ - Аватар )",
  category: "Газар нислэг хосолсон аялал",
  duration_text: "10 өдөр 9 шөнө",
  adult_price: 2650000,
  departure_dates: ["10 сарын 20", "10 сарын 27"],
});
const DATE_CATALOG = [DIRECT_OCT20, LAND_OCT20, COMBO_OCT20];
const NOW = new Date("2026-09-19T05:00:00Z");

test("a direct-flight date question lists only direct-flight trips", async () => {
  const { filterTripsByTransportIntent } = await search();
  const { buildDepartureDateAvailabilityReply } = await import("../src/lib/travelDates");
  const text = "10 сарын 20-27 хооронд явах шууд нислэгтэй ямар аялал байгаа вэ";
  const narrowed = filterTripsByTransportIntent(text, DATE_CATALOG);
  assert.deepEqual(narrowed.map((t) => t.route_name), [DIRECT_OCT20.route_name]);
  const reply = buildDepartureDateAvailabilityReply({ userText: text, trips: narrowed, now: NOW });
  assert.ok(reply);
  assert.match(reply!, /Египет шууд нислэгтэй/);
  assert.doesNotMatch(reply!, /ГАЗРЫН АЯЛАЛ|ГАЗАР НИСЛЭГ ХОСОЛСОН/, "land tours and combos must not be offered as direct flights");
});

test("land-only and combo questions are narrowed the same way", async () => {
  const { filterTripsByTransportIntent } = await search();
  assert.deepEqual(
    filterTripsByTransportIntent("10 сарын 20-нд газрын аялал байна уу", DATE_CATALOG).map((t) => t.route_name),
    [LAND_OCT20.route_name],
  );
  assert.deepEqual(
    filterTripsByTransportIntent("газар нислэг хосолсон аялал 10 сарын 20", DATE_CATALOG).map((t) => t.route_name),
    [COMBO_OCT20.route_name],
  );
  // No transport preference: nothing is dropped.
  assert.equal(filterTripsByTransportIntent("10 сарын 20-нд ямар аялал байна", DATE_CATALOG).length, 3);
});

test("a day range covers every day in it, not just the first", async () => {
  const { buildDepartureDateAvailabilityReply } = await import("../src/lib/travelDates");
  const reply = buildDepartureDateAvailabilityReply({
    userText: "10 сарын 20-27 хооронд ямар аялал байгаа вэ",
    trips: DATE_CATALOG,
    now: NOW,
  });
  assert.ok(reply);
  // Trips departing on the 20th, the 22nd and the 27th all appear.
  assert.match(reply!, /ШАР ТЭНГИС/);
  assert.match(reply!, /Египет/);
  assert.match(reply!, /ТЭНГЭРИЙН ХААЛГАНЫ/);
  assert.match(reply!, /20–27-ны хооронд/);
});
