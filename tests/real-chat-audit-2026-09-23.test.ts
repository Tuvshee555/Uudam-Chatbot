/**
 * Regressions from the 2026-09-23 audit: every real Messenger thread (208
 * threads, 652 customer turns) replayed through the live webhook against a
 * clone of the catalog. Each test pins one failure class to the customer
 * wording that exposed it. Trip names, prices and dates are invented — the
 * real catalog is never copied into tests.
 */
import assert from "node:assert/strict";
import test, { before } from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { TravelTrip } from "../src/lib/travelOps";
import { customerTurn, intentTextOf, joinContextAndTurn, stripTripNamesForIntent } from "../src/lib/customerTurn";
import {
  buildGroupSizeReply,
  buildProgramOrStructuredReply,
  buildSoldOutPrecedenceReply,
  buildStructuredTripReply,
  hasDurationIntent,
  hasProgramIntent,
  isGenericTripRequest,
  resolveDateQuestionScope,
  resolveTripFromUserMessage,
  sanitizeTripForCustomers,
} from "../src/lib/travelFastPaths";
import {
  buildDepartureDateAvailabilityReply,
  filterFutureDepartureDates,
  hasDepartureDateAvailabilityIntent,
  sortDepartureDatesForDisplay,
} from "../src/lib/travelDates";
import { buildContextualUserText } from "../src/lib/contextualText";
import { hasBankAccountRequest } from "../src/lib/reply";
import { quickReplyTitle } from "../src/lib/quickReplyTitle";
import { birthYearBand } from "../src/lib/birthYearAgeBands";

// These read the environment when they load — import after applyTestEnv().
let routing: typeof import("../src/lib/fastPathRouting");
let clarification: typeof import("../src/lib/clarificationState");
let buildCatalogListingReply: typeof import("../src/lib/catalogListing").buildCatalogListingReply;
let parseRetryAfterMs: typeof import("../src/lib/resilience").parseRetryAfterMs;

before(async () => {
  applyTestEnv();
  routing = await import("../src/lib/fastPathRouting");
  clarification = await import("../src/lib/clarificationState");
  ({ buildCatalogListingReply } = await import("../src/lib/catalogListing"));
  ({ parseRetryAfterMs } = await import("../src/lib/resilience"));
});

function trip(fields: Partial<TravelTrip>): TravelTrip {
  return {
    id: "t1",
    category: "Шууд нислэгтэй аялал",
    operator_name: "Test",
    route_name: "Альфа аялал",
    duration_text: "8 өдөр 7 шөнө",
    adult_price: 1111111,
    child_price: 999999,
    infant_price: null,
    currency: "MNT",
    departure_dates: ["12 сарын 20"],
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

const DIRECT = trip({ id: "direct", route_name: "Альфа + Зэт хаалга шууд нислэгтэй аялал" });
const PROGRAM_NAMED = trip({ id: "program", route_name: "УБ-Вэлмор хотын 12-р сарын аяллын хөтөлбөр" });
const DATED_NAME = trip({ id: "dated", route_name: "ВЭЛМОР - КАРДАН -амралтын аялал -12/3", departure_dates: ["12 сарын 3"] });
const CATALOG = [DIRECT, PROGRAM_NAMED, DATED_NAME];

// ── Intent comes from the customer's words, never from a trip NAME ──────────

test("a tapped trip name carries no question of its own", () => {
  assert.equal(stripTripNamesForIntent(`1. ${PROGRAM_NAMED.route_name}`, CATALOG), "");
  assert.equal(stripTripNamesForIntent("2. УБ-Вэлмор хотын 1…", CATALOG), "");
  assert.equal(stripTripNamesForIntent(`${DIRECT.route_name} үнэ хэд вэ`, CATALOG), "үнэ хэд вэ");
});

test("tapping a '…шууд нислэгтэй аялал' trip returns its full card, not only 'Энэ аялал шууд нислэгтэй'", () => {
  const reply = buildStructuredTripReply(joinContextAndTurn(DIRECT.route_name, `1. ${DIRECT.route_name}`), CATALOG) || "";
  assert.match(reply, /Том хүн: 1,111,111₮/);
  assert.match(reply, /12 сарын 20|12\/20/);
  assert.doesNotMatch(reply, /Энэ аялал шууд нислэгтэй\./);
});

test("tapping a trip named '…аяллын хөтөлбөр' is choosing it, not asking for the PDF", () => {
  const result = buildProgramOrStructuredReply(joinContextAndTurn(PROGRAM_NAMED.route_name, `2. ${PROGRAM_NAMED.route_name}`), CATALOG);
  assert.equal(result?.brochure ?? null, null);
});

test("a date inside a trip name is not the customer's date", () => {
  const reply = buildStructuredTripReply(joinContextAndTurn(DATED_NAME.route_name, "үнэ хэд вэ"), CATALOG) || "";
  assert.doesNotMatch(reply, /12 сарын 3-д тохирох үнийн мэдээлэл олдсонгүй/);
  assert.match(reply, /1,111,111₮/);
});

test("the bot's own previous reply is context for the trip, never the question", () => {
  const routed = joinContextAndTurn("💰 Үнэ: • Том хүн: 1,111,111₮ 📅 Гарах өдрүүд: 12/20", "амжилт");
  assert.equal(customerTurn(routed), "амжилт");
  assert.equal(intentTextOf(routed, CATALOG), "амжилт");
});

// ── Numbered choices and clarification answers ─────────────────────────────

test("passenger counts and months are not option numbers", () => {
  assert.equal(routing.parseNumberedChoice("2 том хүн 2 хүүхэд"), null);
  assert.equal(routing.parseNumberedChoice("1 сард"), null);
  assert.deepEqual(routing.parseNumberedChoice("2."), { index: 1, namePrefix: "" });
  assert.deepEqual(routing.parseNumberedChoice("2-р"), { index: 1, namePrefix: "" });
  assert.deepEqual(routing.parseNumberedChoice("2. Альфа + Зэт хаал..."), { index: 1, namePrefix: "Альфа + Зэт хаал" });
});

test("the name in a tapped button outranks its number", async () => {
  const sender = "audit-name-over-index";
  await clarification.setClarificationState(sender, [PROGRAM_NAMED.id, DIRECT.id]);
  const routed = await routing.routeFastPathText({
    senderId: sender,
    text: "1. Альфа + Зэт хаал...",
    contextualUserText: "1. Альфа + Зэт хаал...",
    trips: CATALOG,
  });
  assert.equal(customerTurn(routed.matchText), "1. Альфа + Зэт хаал...");
  assert.ok(routed.matchText.startsWith(DIRECT.route_name));
});

test("our own 'Хөтөлбөр үзэх' button re-asks the pending question instead of picking a trip", async () => {
  const sender = "audit-own-button";
  await clarification.setClarificationState(sender, [PROGRAM_NAMED.id, DIRECT.id]);
  const routed = await routing.routeFastPathText({
    senderId: sender,
    text: "Хөтөлбөр үзэх",
    contextualUserText: "Хөтөлбөр үзэх",
    trips: CATALOG,
  });
  assert.deepEqual(routed.scopedClarify?.map((candidate) => candidate.id), [PROGRAM_NAMED.id, DIRECT.id]);
});

test("an attribute answer that fits one offered trip beats a catalog trip with that word in its name", async () => {
  const fromCity = trip({ id: "from-city", route_name: "Кардан газар нислэг хосолсон", source_description: "Лумиагаас нислэгтэй" });
  const otherOffered = trip({ id: "other", route_name: "Кардан - Зэт газар нислэг хосолсон аялал" });
  const cityNamed = trip({ id: "city-named", route_name: "Зэт - Лумиа - 4 хотын аялал" });
  const sender = "audit-attribute";
  await clarification.setClarificationState(sender, [fromCity.id, otherOffered.id]);
  const routed = await routing.routeFastPathText({
    senderId: sender,
    text: "лумиагаас",
    contextualUserText: "лумиагаас",
    trips: [fromCity, otherOffered, cityNamed],
  });
  assert.ok(routed.matchText.startsWith(fromCity.route_name));
});

test("a month none of the offered trips departs in says so instead of picking one", async () => {
  const sender = "audit-month";
  const a = trip({ id: "a", route_name: "Альфа паркийн аялал", departure_dates: ["12 сарын 20"] });
  const b = trip({ id: "b", route_name: "Альфа паркийн сурагчдын аялал", departure_dates: ["12 сарын 27"] });
  await clarification.setClarificationState(sender, [a.id, b.id]);
  const routed = await routing.routeFastPathText({ senderId: sender, text: "3 сард", contextualUserText: "3 сард", trips: [a, b] });
  assert.equal(routed.scopedClarify?.length, 2);
  assert.match(routed.scopedClarifyNote || "", /3 сард гарах аялал эдгээрээс алга/);
});

// ── Resolver ────────────────────────────────────────────────────────────────

test("nearly the full name in order wins over a sibling with the same words reordered", () => {
  const exact = trip({ id: "exact", route_name: "ЗЭТ ХААЛГАНЫ ГАЗАР НИСЛЭГ ХОСОЛСОН АЯЛАЛ ( Альфа - Лумиа )" });
  const sibling = trip({ id: "sibling", route_name: "Кардан- Альфа (Зэт хаалга / Лумиа) газар нислэг хосолсон аялал" });
  const resolution = resolveTripFromUserMessage("Зэт хаалга газар нислэг хослосон аялал???", [exact, sibling], {
    allowLooseFallback: false,
  });
  assert.equal(resolution.status, "verified");
  assert.equal(resolution.trip?.id, "exact");
});

test("two name words typed as one still find the trips", () => {
  const trips = [
    trip({ id: "g1", route_name: "Вэлморын хаалга шууд нислэгтэй аялал" }),
    trip({ id: "g2", route_name: "Вэлморын хаалга газар нислэг хосолсон аялал" }),
  ];
  const resolution = resolveTripFromUserMessage("hi Вэлморхаалга аялал үнэ", trips, { allowLooseFallback: false });
  assert.notEqual(resolution.status, "not_found");
});

test("a sold-out trip is not named by a date alone", () => {
  const soldOut = trip({ id: "sold", route_name: "Альфа - ПАРК-12/08", status: "sold_out", departure_dates: ["12 сарын 8"] });
  const open = trip({ id: "open", route_name: "Зэт - ПАРК сурагчдын аялал", departure_dates: ["12 сарын 8"] });
  assert.equal(buildSoldOutPrecedenceReply("12.8 nd yavaad 15 nii ugluu ireh", [soldOut, open]), null);
});

// ── Replies that used to be silent ──────────────────────────────────────────

test("catalog questions get a list instead of a silent handoff", () => {
  const ground = trip({ id: "ground", route_name: "Кардан газрын аялал", category: "Газрын аялал" });
  const listing = buildCatalogListingReply("шууд нислэгтэй аялал байна уу", [DIRECT, ground]);
  assert.ok(listing);
  assert.match(listing!.reply, /Шууд нислэгтэй аяллууд/);
  assert.ok(listing!.reply.includes(DIRECT.route_name));
  assert.ok(!listing!.reply.includes(ground.route_name));
  assert.ok(buildCatalogListingReply("бүх аяллын хуваарь үнийн мэдээлэл авья", [DIRECT, ground]));
  assert.equal(buildCatalogListingReply("амжилт", [DIRECT, ground]), null);
});

test("Latin-typed requests with passenger counts get 'which trip?' rather than silence", () => {
  assert.ok(isGenericTripRequest("hutulbur unii medeelel ywuulj uguuch 5tom hun 1huuhed"));
  assert.ok(isGenericTripRequest("Хэд хоногийн аялал хэдэн төг вээ"));
  assert.ok(!isGenericTripRequest("10 сар"));
  assert.ok(!isGenericTripRequest("Лумиа аялал"));
});

test("a bare month or date answer is an availability question", () => {
  const now = new Date("2026-09-21T10:00:00+08:00");
  assert.ok(hasDepartureDateAvailabilityIntent("10sar", now));
  assert.ok(hasDepartureDateAvailabilityIntent("9-19 nd", now));
  assert.ok(!hasDepartureDateAvailabilityIntent("10sar хэд вэ", now));
});

test("a bank-account request is recognised; a payment claim stays a payment claim", () => {
  assert.ok(hasBankAccountRequest("за дансаа"));
  assert.ok(hasBankAccountRequest("dansaa ywuulaach"));
  assert.ok(!hasBankAccountRequest("дансаар шилжүүлсэн"));
});

// ── Data shown to customers ─────────────────────────────────────────────────

test("birth-year tiers are shown as birth years, not the misread '14-20 нас'", () => {
  assert.equal(birthYearBand("ХҮҮХЭД -2014-2015 ОН"), "2014-2015 он");
  const saved = trip({
    id: "years",
    child_price: 999999,
    extra: {
      age_rules: { child: "14-20 нас", infant: "24-20 нас" },
      price_groups: [
        {
          label: "Үнэ",
          dates: [],
          child_age: "14-20 нас",
          adult_price: 1111111,
          child_price: 999999,
          passenger_prices: [
            { label: "ХҮҮХЭД -2014-2015 ОН", age_range: "14-20 нас", price: 999999 },
            { label: "ХҮҮХЭД 2016-2023 ОН", age_range: "16-20 нас", price: 888888 },
          ],
        },
      ],
    },
  });
  const reply = buildStructuredTripReply(joinContextAndTurn(saved.route_name, "үнэ хэд вэ"), [sanitizeTripForCustomers(saved)]) || "";
  assert.doesNotMatch(reply, /14-20 нас|16-20 нас/);
  assert.match(reply, /2014-2015 онд төрсөн\/: 999,999₮/);
  assert.match(reply, /2016-2023 онд төрсөн\/: 888,888₮/);
  assert.doesNotMatch(reply, /💰 Үнэ:\n\nҮнэ\n/);
});

test("a departure saved after it passed is not quoted as next year's", () => {
  const now = new Date("2026-09-21T10:00:00+08:00");
  const resolved = [
    { text: "9 сарын 15", ymd: "2027-09-15" },
    { text: "10 сарын 8", ymd: "2026-10-08" },
  ];
  assert.deepEqual(filterFutureDepartureDates(["9 сарын 15", "10 сарын 8"], now, resolved), ["10 сарын 8"]);
  // A genuine next-year series (no current-season date) is left alone.
  assert.deepEqual(filterFutureDepartureDates(["9 сарын 15"], now, [{ text: "9 сарын 15", ymd: "2027-09-15" }]), ["9 сарын 15"]);
});

test("departures are listed soonest first", () => {
  const now = new Date("2026-09-21T10:00:00+08:00");
  assert.deepEqual(
    sortDepartureDatesForDisplay(["11/14", "12/12", "10/9", "Ням гараг бүр"], now),
    ["Ням гараг бүр", "10/9", "11/14", "12/12"],
  );
});

// ── Delivery ────────────────────────────────────────────────────────────────

test("quick-reply titles fit Messenger; the payload keeps the whole label", () => {
  assert.equal(quickReplyTitle("Хөтөлбөр үзэх"), "Хөтөлбөр үзэх");
  const title = quickReplyTitle(`1. ${PROGRAM_NAMED.route_name}`);
  assert.ok(title.length <= 20 && title.endsWith("…"), title);
});

test("an OpenAI 429 says how long to wait", () => {
  assert.equal(parseRetryAfterMs(new Headers({ "retry-after-ms": "1500" })), 1500);
  assert.equal(parseRetryAfterMs(new Headers({ "x-ratelimit-reset-tokens": "6.5s" })), 6500);
  assert.equal(parseRetryAfterMs(new Headers({ "x-ratelimit-reset-tokens": "450ms" })), 450);
  assert.equal(parseRetryAfterMs(new Headers({})), null);
});

// ── Second pass (after the first round of fixes was replayed) ──────────────

test("a photo-send placeholder is never the 'previous reply' a follow-up refers to", () => {
  const card = `✈️ ${DIRECT.route_name}\n⏱ 8 өдөр 7 шөнө\nPDF хөтөлбөрийг хавсаргалаа.`;
  const contextual = buildContextualUserText(
    [
      { role: "assistant", text: card },
      { role: "assistant", text: "[1 зураг илгээсэн]" },
    ],
    "хамгийн сүүлийн аялал нь хэдэн сарын хэдэнд гарах вэ",
  );
  assert.ok(contextual.includes(DIRECT.route_name), contextual);
  assert.ok(!contextual.includes("зураг илгээсэн"), contextual);
});

const NOW_0921 = new Date("2026-09-21T10:00:00+08:00");
const OCT_TRIP = trip({ id: "oct", route_name: "Лумиа аялал", departure_dates: ["10 сарын 5", "10 сарын 25"] });
const NOV_TRIP = trip({ id: "nov", route_name: "Кардан аялал", departure_dates: ["11 сарын 1"] });

test("a window across months is read as a range ('9.30-10.20', '10/28 11/3')", () => {
  const cross = buildDepartureDateAvailabilityReply({
    userText: "9.30-10.20ний хооронд аялал байгаа юу",
    trips: [OCT_TRIP, NOV_TRIP],
    now: NOW_0921,
  }) || "";
  assert.match(cross, /9 сарын 30 – 10 сарын 20-ны хооронд/);
  assert.ok(cross.includes(OCT_TRIP.route_name) && !cross.includes(NOV_TRIP.route_name), cross);
  const pair = buildDepartureDateAvailabilityReply({ userText: "10/28 11/3 аялал бий юу", trips: [OCT_TRIP, NOV_TRIP], now: NOW_0921 }) || "";
  assert.ok(pair.includes(NOV_TRIP.route_name) && !pair.includes(OCT_TRIP.route_name), pair);
  const parts = buildDepartureDateAvailabilityReply({
    userText: "9 сарын сүүлээр 10 сарын эхээр аялал байна уу",
    trips: [OCT_TRIP, NOV_TRIP],
    now: NOW_0921,
  }) || "";
  assert.match(parts, /10 сарын 5/);
  assert.doesNotMatch(parts, /10 сарын 25/);
});

test("'not that month' always says when the trip DOES leave", () => {
  const reply = buildDepartureDateAvailabilityReply({ userText: "10sar", trips: [NOV_TRIP], focusTrip: NOV_TRIP, now: NOW_0921 }) || "";
  assert.match(reply, /10 сард гарахгүй/);
  assert.match(reply, /11 сарын 1/);
  const range = buildDepartureDateAvailabilityReply({
    userText: "9.30-10.20ний хооронд аялал байгаа юу",
    trips: [NOV_TRIP],
    focusTrip: NOV_TRIP,
    now: NOW_0921,
  }) || "";
  assert.match(range, /гарахгүй/);
  assert.match(range, /11 сарын 1/);
});

test("a date question naming a shared destination is answered for that destination only", () => {
  const velmorA = trip({ id: "va", route_name: "Вэлмор хотын аялал", departure_dates: ["10 сарын 5"] });
  const velmorB = trip({ id: "vb", route_name: "Вэлмор - Кардан аялал", departure_dates: ["10 сарын 12"] });
  const scope = resolveDateQuestionScope("вэлмор 10 сард", [velmorA, velmorB, OCT_TRIP]);
  assert.equal(scope.focusTrip, null);
  assert.deepEqual(scope.trips.map((t) => t.id).sort(), ["va", "vb"]);
  // The customer's date is not read as the date inside a trip NAME.
  const scoped = resolveDateQuestionScope("вэлмор кардан 10/28 12/3", [velmorA, velmorB, DATED_NAME]);
  assert.notEqual(scoped.focusTrip?.id, DATED_NAME.id);
});

test("named destinations narrow a category question instead of listing the whole category", () => {
  const combo = trip({ id: "combo", route_name: "Кардан газар нислэг хосолсон аялал", category: "Газар нислэг хосолсон аялал" });
  const velmor = trip({ id: "vel", route_name: "Вэлмор хотын аялал", category: "Газрын аялал" });
  const lumia = trip({ id: "lum", route_name: "Лумиа - Вэлмор аялал", category: "Газрын аялал" });
  const listing = buildCatalogListingReply("Вэлмор болон Лумиа хосолсон аялал байна уу", [combo, velmor, lumia]);
  assert.ok(listing);
  assert.ok(!listing!.reply.includes(combo.route_name), listing!.reply);
  assert.ok(listing!.reply.includes(velmor.route_name) && listing!.reply.includes(lumia.route_name));
});

test("'fewer days' lists the shortest trips first", () => {
  const long = trip({ id: "long", route_name: "Лумиа аялал", duration_text: "10 өдөр 9 шөнө" });
  const short = trip({ id: "short", route_name: "Кардан аялал", duration_text: "5 өдөр 4 шөнө" });
  const listing = buildCatalogListingReply("арай бага хоногтой байдаггүй юм уу", [long, short]);
  assert.ok(listing);
  assert.ok(listing!.reply.indexOf(short.route_name) < listing!.reply.indexOf(long.route_name), listing!.reply);
});

test("Latin program requests and 'хэдэн хоног' are recognised", () => {
  assert.ok(hasProgramIntent("hutulbur hary"));
  assert.ok(hasProgramIntent("Hutulbut hary"));
  assert.ok(hasProgramIntent("hotolbor bolon medeelel avii"));
  assert.ok(hasDurationIntent("Үнэ хэдэн хоног"));
  assert.ok(hasDurationIntent("hed honog ve"));
});

test("a destination typed again lists its trips instead of re-serving the card on screen", async () => {
  const velmorA = trip({ id: "va", route_name: "Вэлмор хотын аялал" });
  const velmorB = trip({ id: "vb", route_name: "Вэлмор - Кардан аялал" });
  const card = `✈️ ${velmorA.route_name}\n🗓 Хугацаа: 8 өдөр 7 шөнө`;
  const sender = "audit-destination-again";
  await clarification.clearClarificationState(sender);
  const again = await routing.routeFastPathText({
    senderId: sender,
    text: "Вэлмор",
    contextualUserText: joinContextAndTurn(card, "Вэлмор"),
    trips: [velmorA, velmorB],
  });
  assert.equal(resolveTripFromUserMessage(again.matchText, [velmorA, velmorB], { allowLooseFallback: false }).status, "ambiguous");
  // A follow-up that points back ("нь") still means the card on screen.
  await clarification.clearClarificationState(sender);
  const followUp = await routing.routeFastPathText({
    senderId: sender,
    text: "Вэлмор нь хэд вэ",
    contextualUserText: joinContextAndTurn(card, "Вэлмор нь хэд вэ"),
    trips: [velmorA, velmorB],
  });
  assert.ok(followUp.matchText.includes(velmorA.route_name), followUp.matchText);
});

test("a date question after a list is not limited to the trips that list showed", () => {
  const listed = `Тийм ээ, 11 сард гарах аяллууд байна 😊\n• ${OCT_TRIP.route_name}\n• ${DIRECT.route_name}`;
  const scope = resolveDateQuestionScope(joinContextAndTurn(listed, "11 сарын 12"), [OCT_TRIP, DIRECT, NOV_TRIP]);
  assert.equal(scope.focusTrip, null);
  assert.equal(scope.trips.length, 3);
});

test("group sizes and ages are not dates", () => {
  assert.ok(!hasDepartureDateAvailabilityIntent("11-13хүн байна", NOW_0921));
  assert.ok(!hasDepartureDateAvailabilityIntent("2-11 нас аялал", NOW_0921));
  assert.ok(hasDepartureDateAvailabilityIntent("9-19 nd", NOW_0921));
});

test("the model asking 'which city?' is not context that picks a trip", () => {
  const contextual = buildContextualUserText(
    [
      { role: "user", text: "Ямар ямар хотын аялал байгаа вэ" },
      { role: "assistant", text: "Та ямар хотын аялал сонирхож байна вэ? Бидэнд Вэлмор, Лумиа зэрэг олон аялал байна." },
    ],
    "hutulbur hary",
  );
  assert.ok(!contextual.includes("Вэлмор"), contextual);
});

test("a group size after a trip card is answered for that trip", () => {
  const reply = buildGroupSizeReply(joinContextAndTurn(DIRECT.route_name, "11-13хүн байна"), CATALOG) || "";
  assert.ok(reply.includes(DIRECT.route_name), reply);
  assert.match(reply, /1,111,111₮/);
  assert.match(reply, /11-13 хүний групп/);
  assert.equal(buildGroupSizeReply("11-13хүн байна", CATALOG), null);
  const contextual = buildContextualUserText([{ role: "assistant", text: `${DIRECT.route_name} аялал 12 сард гарна.` }], "11-13хүн байна");
  assert.ok(contextual.includes(DIRECT.route_name), contextual);
  assert.equal(buildGroupSizeReply(joinContextAndTurn(DIRECT.route_name, "2 том хүн 1 хүүхэд нийт хэд"), CATALOG), null);
});

test("'Хөтөлбөр үзэх' under a which-trip list does not pick the list's first trip", () => {
  const list = `Энэ чиглэлээр хэд хэдэн сонголт байна 😊\n• ${OCT_TRIP.route_name} — 6 өдөр\n• ${NOV_TRIP.route_name} — 5 өдөр\n\nАль аяллыг нь сонирхож байна вэ?`;
  const contextual = buildContextualUserText(
    [
      { role: "user", text: "Лумиа Кардан" },
      { role: "assistant", text: list },
    ],
    "Хөтөлбөр үзэх",
  );
  assert.ok(!contextual.startsWith(OCT_TRIP.route_name), contextual);
  // "эхнийх" (the first one) is still the first one.
  const first = buildContextualUserText([{ role: "assistant", text: list }], "эхнийх");
  assert.ok(first.startsWith(OCT_TRIP.route_name), first);
});

// ── Live chats of 2026-09-23/24 ─────────────────────────────────────────────

const VELMOR_SCHOOL = trip({ id: "velmor-school", route_name: "Вэлмор - Янмор шууд нислэг-сурагчдын амралтаар" });
const VELMOR_FOUR = trip({ id: "velmor-four", route_name: "Вэлмор - Сэлвин – Пэлмак - Ормак – 4 ХОТЫН АЯЛАЛ", category: "Аялал" });
const LUMIA_SCHOOL = trip({ id: "lumia-school", route_name: "ЛУМИА - БАРТЭНЛАНД -сурагчдын амралтын аялал" });
const LUMIA_PELDOR_TRIP = trip({ id: "lumia-peldor", route_name: "Лумиа + Зэтгорийн хаалга шууд нислэгтэй аялал ( Пэлдор - Эмбар )" });
const KARDAN_LAND = trip({ id: "kardan-land", route_name: "Сэрвэн тэнгис буюу Кардан-Вэлморгийн газрын аялал", category: "Аялал" });
const LIVE_CATALOG = [VELMOR_SCHOOL, VELMOR_FOUR, LUMIA_SCHOOL, LUMIA_PELDOR_TRIP, KARDAN_LAND];

test("an occasion ('school holiday') narrows the named city's trips — never another city's", () => {
  const r = resolveTripFromUserMessage("Сурагчдын амралтын үеэр вэлмор", LIVE_CATALOG, { allowLooseFallback: false });
  assert.equal(r.status, "verified");
  assert.equal(r.trip?.id, "velmor-school");
});

test("a place misspelled with the same consonants still finds its trip", () => {
  const r = resolveTripFromUserMessage("Сурагчдын амралтаар лумиа пэлдир аялал сонирхож бна", LIVE_CATALOG, { allowLooseFallback: false });
  assert.equal(r.status, "verified");
  assert.equal(r.trip?.id, "lumia-peldor");
});

test("two cities with no trip visiting both lists each city's trips", () => {
  const r = resolveTripFromUserMessage("Velmor bolon lumiain aylaliin hutulbur aviya", LIVE_CATALOG, { allowLooseFallback: false });
  assert.equal(r.status, "ambiguous");
  const ids = r.candidates.map((t) => t.id);
  assert.ok(ids.some((id) => id.startsWith("velmor")) && ids.some((id) => id.startsWith("lumia")), ids.join(","));
});

test("named cities beat a transport word the catalog never recorded", () => {
  const r = resolveTripFromUserMessage("Вэлмор-Сэлвин газрын аяллын хөтөлбөр үзэх", LIVE_CATALOG, { allowLooseFallback: false });
  assert.equal(r.trip?.id, "velmor-four");
});

test("a head count after a trip card gets the total, with a range for birth-year child fares", () => {
  const tiered = trip({
    id: "tiered",
    route_name: "Кардан аялал",
    adult_price: 1111111,
    child_price: 999999,
    extra: {
      price_groups: [{
        label: "Үнэ",
        dates: [],
        adult_price: 1111111,
        child_price: 999999,
        passenger_prices: [
          { label: "ХҮҮХЭД 2014-2015 ОН", age_range: "2014-2015 он", price: 999999 },
          { label: "ХҮҮХЭД 2016-2023 ОН", age_range: "2016-2023 он", price: 888888 },
        ],
      }],
    },
  });
  const reply = buildStructuredTripReply(joinContextAndTurn(tiered.route_name, "2том хүн 2 хүүхэд"), [tiered]) || "";
  assert.match(reply, /нийт: 3,999,998₮ – 4,222,220₮/);
  assert.match(reply, /Том хүн 2 x 1,111,111₮ = 2,222,222₮/);
});

test("a tapped trip button ignores a sold-out sibling with the same opening words", async () => {
  const open = trip({ id: "open", route_name: "ЛУМИА - -БАРТЭНЛЭНД -амралт -11/3" });
  const soldOut = trip({ id: "sold", route_name: "ЛУМИА - БАРТЭНЛЭНД-10/08", status: "sold_out" });
  const sender = "audit-prefix-active";
  await clarification.clearClarificationState(sender);
  const routed = await routing.routeFastPathText({
    senderId: sender,
    text: "1. ЛУМИА - -БАРТЭНЛ...",
    contextualUserText: "1. ЛУМИА - -БАРТЭНЛ...",
    trips: [open, soldOut],
  });
  assert.equal(routed.scopedClarify, null);
  assert.ok(routed.matchText.includes(open.route_name), routed.matchText);
});
