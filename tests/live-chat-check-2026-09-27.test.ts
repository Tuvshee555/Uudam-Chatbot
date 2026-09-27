/**
 * Regressions from the 2026-09-27 check of every live chat since the compact
 * AI catalog shipped (26 customers, 69 turns replayed). Trip names, prices and
 * dates are invented — the real catalog is never copied into tests.
 */
import assert from "node:assert/strict";
import test, { before } from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { TravelTrip } from "../src/lib/travelOps";
import { joinContextAndTurn } from "../src/lib/customerTurn";
import {
  adultFareOnDate,
  buildStructuredTripReply,
  formatPassengerMoney,
  hasPriceIntent,
  resolveTripFromUserMessage,
  sanitizeTripForCustomers,
} from "../src/lib/travelFastPaths";
import {
  buildDepartureDateAvailabilityReply,
  isPlaceholderDepartureText,
} from "../src/lib/travelDates";
import { isLikelyContextDependentText } from "../src/lib/contextualText";
import { guardInventedBookingTerms, shouldSilenceNoDataReply } from "../src/lib/reply";

let routing: typeof import("../src/lib/fastPathRouting");
let clarification: typeof import("../src/lib/clarificationState");
let mapTripRow: typeof import("../src/lib/travelDb").mapTripRow;

before(async () => {
  applyTestEnv();
  routing = await import("../src/lib/fastPathRouting");
  clarification = await import("../src/lib/clarificationState");
  ({ mapTripRow } = await import("../src/lib/travelDb"));
});

const NOW = new Date("2026-09-27T04:00:00Z");

function trip(fields: Partial<TravelTrip>): TravelTrip {
  return {
    id: "t1",
    category: "Аялал",
    operator_name: "Test",
    route_name: "Альфа аялал",
    duration_text: "8 өдөр 7 шөнө",
    adult_price: 1111111,
    child_price: 999999,
    infant_price: null,
    currency: "MNT",
    departure_dates: ["12 сарын 8", "12 сарын 15"],
    seats_total: null,
    seats_left: null,
    has_food: true,
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

const TWO_FARES = trip({
  id: "two-fares",
  route_name: "Вэлмор – Кардан – Лумиа аялал",
  extra: {
    price_groups: [
      { dates: ["12 сарын 15"], adult_price: 1111111, child_price: 999999 },
      { dates: ["12 сарын 8"], adult_price: 2222222, child_price: 999999 },
    ],
  },
});

test("a date answer quotes that departure's fare, not the trip's base fare", () => {
  const fareOn = (t: TravelTrip, ymd: string) => adultFareOnDate(t, ymd, NOW);
  const day = buildDepartureDateAvailabilityReply({
    userText: "12 сарын 8-нд аялал байна уу",
    trips: [TWO_FARES],
    now: NOW,
    adultFareOn: fareOn,
  }) || "";
  assert.match(day, /2,222,222₮/);
  assert.doesNotMatch(day, /1,111,111₮/);

  const month = buildDepartureDateAvailabilityReply({
    userText: "12 сард аялал байна уу",
    trips: [TWO_FARES],
    now: NOW,
    adultFareOn: fareOn,
  }) || "";
  assert.match(month, /1,111,111₮ – 2,222,222₮/);
});

test("a month with no departures is answered, not silenced as no-data", () => {
  const reply = buildDepartureDateAvailabilityReply({
    userText: "4 сард ямар аялал гардаг вэ",
    trips: [TWO_FARES],
    now: NOW,
  }) || "";
  assert.match(reply, /4 сард гарах аяллын хуваарь одоогоор гараагүй/);
  assert.match(reply, /Вэлмор/);
  assert.equal(shouldSilenceNoDataReply(reply), false);
});

test("asking the month question again is a fresh catalog question, not a follow-up", () => {
  assert.equal(isLikelyContextDependentText("10р сарын аялал байна уу"), false);
  assert.equal(isLikelyContextDependentText("10 sariin aylal bgaa yu"), false);
  // Pointing at the trip on screen still borrows it.
  assert.equal(isLikelyContextDependentText("10 сарын аялал нь хэзээ"), true);
});

test("a price follow-up typed in Latin letters is read as one", () => {
  assert.equal(isLikelyContextDependentText("Une hed ve"), true);
  assert.equal(hasPriceIntent("Une hed ve"), true);
  assert.equal(hasPriceIntent("huuhed hed ve"), true);
  assert.equal(hasPriceIntent("unen uu"), false);
});

test("a stale 'which trip?' list does not override a single-trip answer", async () => {
  const other = trip({ id: "other", route_name: "Вэлмор хотын 12-р сарын аялал" });
  const sender = "stale-clarify";
  await clarification.setClarificationState(sender, [TWO_FARES.id, other.id]);
  const singleAnswer = `Тийм ээ, 12 сарын 8-нд гарах аялал байна 😊\n\n• ${TWO_FARES.route_name} (том хүн 2,222,222₮)`;
  const routed = await routing.routeFastPathText({
    senderId: sender,
    text: "Une hed ve",
    contextualUserText: joinContextAndTurn(singleAnswer, "Une hed ve"),
    trips: [TWO_FARES, other],
    history: [
      { role: "user", text: "12 sariin 8nd Velmor aylal bgaa yu?" },
      { role: "assistant", text: singleAnswer },
    ],
  });
  assert.equal(routed.scopedClarify, null);
  assert.match(routed.matchText, /Вэлмор – Кардан – Лумиа/);
});

test("a list that did ask 'which trip?' still scopes the next generic request", async () => {
  const other = trip({ id: "other", route_name: "Вэлмор хотын 12-р сарын аялал" });
  const sender = "live-clarify";
  await clarification.setClarificationState(sender, [TWO_FARES.id, other.id]);
  const list = `Энэ чиглэлээр хэд хэдэн сонголт байна 😊\n• ${TWO_FARES.route_name}\n• ${other.route_name}\n\nАль аяллыг нь сонирхож байна вэ?`;
  const routed = await routing.routeFastPathText({
    senderId: sender,
    text: "мэдээлэл явуулаад өгөөрэй",
    contextualUserText: "мэдээлэл явуулаад өгөөрэй",
    trips: [TWO_FARES, other],
    history: [{ role: "assistant", text: list }],
  });
  assert.deepEqual(routed.scopedClarify?.map((t) => t.id), [TWO_FARES.id, other.id]);
});

test("a bare 'aylal' names no trip, even when an alias ends in 'аялал'", () => {
  const aliased = trip({ id: "aliased", route_name: "Зэтгор Лумиа аялал", extra: { aliases: ["Лумиа аялал", "Zetgor tour"] } });
  assert.equal(resolveTripFromUserMessage("aylal", [aliased]).status, "not_found");
  assert.equal(resolveTripFromUserMessage("аялал", [aliased]).status, "not_found");
  assert.equal(resolveTripFromUserMessage("Лумиа аялал", [aliased]).status, "verified");
});

test("an unfilled editor date row is not a departure date", () => {
  assert.equal(isPlaceholderDepartureText("Шинэ огноо"), true);
  assert.equal(isPlaceholderDepartureText("[огноо 1]"), true);
  assert.equal(isPlaceholderDepartureText("12 сарын 8"), false);
  assert.equal(isPlaceholderDepartureText("Лхагва гараг бүр"), false);
  const mapped = mapTripRow({ id: "x", route_name: "Альфа", departure_dates: ["Лхагва гараг бүр", "Шинэ огноо", "12 сарын 8"] });
  assert.deepEqual(mapped.departure_dates, ["Лхагва гараг бүр", "12 сарын 8"]);
});

test("a placeholder tugrik fare like 1₮ is never shown", () => {
  assert.equal(formatPassengerMoney(1, "MNT"), null);
  assert.equal(formatPassengerMoney(999, "MNT"), null);
  assert.notEqual(formatPassengerMoney(390000, "MNT"), null);
  assert.notEqual(formatPassengerMoney(5, "USD"), null);
});

test("a trip card keeps the infant fare when its date groups carry none", () => {
  const withInfant = trip({
    id: "infant",
    route_name: "Лумиа газар нислэг хосолсон аялал",
    infant_price: 555555,
    extra: {
      price_groups: [{ dates: ["12 сарын 8", "12 сарын 15"], adult_price: 1111111, child_price: 999999 }],
    },
  });
  const reply = buildStructuredTripReply(
    joinContextAndTurn(withInfant.route_name, "үнэ хэд вэ"),
    [sanitizeTripForCustomers(withInfant)],
  ) || "";
  assert.match(reply, /Нярай[^\n]*555,555₮/);
});

test("booking terms the catalog never states turn the AI reply into REFER", () => {
  const promptWithout = [
    "Business name: Test",
    "Context:",
    "- Альфа аялал | duration: 8 өдөр | price: 1,111,111₮",
    "",
    "Conversation so far:",
    "User: паспорт хэрэгтэй юу",
    "User: Захиалга өгвөл юу багтсан бэ",
    "Assistant:",
  ].join("\n");
  const invented = "Төлбөрийн нөхцөл: аяллын өмнө бүрэн төлнө. Бүрдүүлэх бичиг баримт: паспорт.";
  assert.equal(guardInventedBookingTerms(invented, promptWithout), "REFER");

  const promptWith = promptWithout.replace(
    "price: 1,111,111₮",
    "price: 1,111,111₮ | Захиалгын нөхцөл: Урьдчилгаа: 30% | Бүрдүүлэх бичиг баримт: паспорт",
  );
  const grounded = "Урьдчилгаа 30%, бүрдүүлэх бичиг баримт нь паспорт.";
  assert.equal(guardInventedBookingTerms(grounded, promptWith), grounded);
  // A reply with no booking terms passes untouched.
  assert.equal(guardInventedBookingTerms("Альфа аялал 8 өдөр.", promptWithout), "Альфа аялал 8 өдөр.");
});

test("a thank-you is never read as a trip name, even one a letter away", async () => {
  const { isThanksOnly } = await import("../src/lib/greetingPhrases");
  assert.equal(isThanksOnly("za bayrla huleej baiy"), true);
  assert.equal(isThanksOnly("за баярлалаа, хүлээж байя"), true);
  const show = trip({ id: "show", route_name: "Лумиа онцгой аялал × BAYRLO SHOW", status: "sold_out" as TravelTrip["status"] });
  const open = trip({ id: "open", route_name: "Лумиа аялал" });
  assert.equal(resolveTripFromUserMessage("za bayrla huleej baiy", [show, open]).status, "not_found");
});

test("a date under a list narrows only to trips of the asked kind", async () => {
  const combo = trip({ id: "combo", route_name: "Зэтгор газар нислэг хосолсон аялал", departure_dates: ["12 сарын 20"] });
  const direct = trip({ id: "direct", route_name: "Кардан шууд нислэгтэй аялал", departure_dates: ["12 сарын 22"] });
  const sender = "kind-narrow";
  await clarification.setClarificationState(sender, [combo.id, direct.id]);
  const list = `Одоо захиалга авч байгаа аяллууд 😊\n• ${combo.route_name}\n• ${direct.route_name}\n\nАль аяллыг нь сонирхож байна вэ?`;
  const text = "12 сарын 20-27 хооронд явах шууд нислэгтэй ямар аялал байгаа вэ";
  const routed = await routing.routeFastPathText({
    senderId: sender,
    text,
    contextualUserText: text,
    trips: [combo, direct],
    history: [{ role: "assistant", text: list }],
  });
  assert.doesNotMatch(routed.matchText, /Зэтгор/);
  assert.equal(routed.scopedClarify, null);
});
