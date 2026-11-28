import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { conversationGateHarness, type ModelOverride as BaseOverride } from "./helpers/conversationGateHarness";
import { day, textOf, trip } from "./helpers/understandingRoutingFixtures";

/**
 * Review of every real Messenger chat of 2026-11-08 .. 11-18 (192 conversations). Each journey below
 * reproduces the shape of a conversation that went wrong on the code of that week. Every town, trip,
 * price and date is invented.
 */
type ModelOverride = BaseOverride & { trips?: string[]; transport?: string | null };
const days = Array.from({ length: 5 }, (_, i) => day(i + 1, `ӨДӨР ${i + 1}`, `Хөтөлбөр ${i + 1} (invented).`));
const kind = (transport: string) => ({ extra: { transport_type: transport, aliases: [], itinerary_days: days } });

// One destination sold as several trips; the second one's title carries a staff note with dates
// ("… - 2 сарын 15, 20, 25"), as three live titles do.
const destination = () => [
  trip("wed", "ВЕЛМОРА – МАРИН АЯЛАЛ-Лхагва", ["2098-02-11", "2098-02-18"], [2_990_000, 2_690_000, null], kind("direct_flight")),
  trip("noted", "Велмора-газар нислэг хосолсон - Торвен хотоос Марин нислэгтэй - 2 сарын 15, 20, 25", ["2098-02-15", "2098-02-20"], [3_290_000, 2_990_000, null], kind("land_flight")),
  trip("direct", "ВЕЛМОРА АРЛЫН АЯЛАЛ – УБ-ААС ШУУД НИСЛЭГТЭЙ", ["2098-03-09"], [3_980_000, 3_580_000, null], kind("direct_flight")),
  trip("other", "ЛУМИС ХОТЫН АЯЛАЛ", ["2098-02-21"], [1_590_000, 1_290_000, null], kind("land")),
];

// Live 2026-11-16..18: "Хайнаны аялал бна уу", a bare "Хайнань", "… үнэ хэд вэ 12.25 ноос" — the bot built the
// destination's list and its own fact checker refused it, so the customer got silence and staff a lead. The checker
// masks the digits of a title's note so they are not read as a price or a departure, but then the price guard no
// longer found that title, read its fare under the trip listed before it, and refused the whole list.
test("a destination list that includes a trip whose title carries a dated note is sent, not silenced", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(destination());
  try {
    for (const [label, model] of [
      ["model reads the destination", { place: "велмора", trips: ["T1", "T2", "T3"], certainty: "several", topics: ["dates"] }],
      ["model unavailable", { unavailable: true }],
    ] as Array<[string, ModelOverride]>) {
      const result = await harness.turn(`dest-${label}`, "Велморагийн аялал бна уу", model);
      const said = textOf(result.sends);
      assert.ok(result.sends.length > 0, `${label}: the list is sent, not held back as missing data`);
      assert.ok(said.includes("ВЕЛМОРА – МАРИН АЯЛАЛ-Лхагва") && said.includes("Велмора-газар нислэг хосолсон"), `${label}: both trips listed: ${said}`);
      assert.ok(said.includes("3,290,000₮"), `${label}: the noted trip's own fare: ${said}`);
      assert.ok(!said.includes("ЛУМИС"), `${label}: no trip of another destination: ${said}`);
    }
  } finally {
    await harness.close();
  }
});

test("the checker reads the fare under a noted title as that trip's fare, and still refuses an invented one", async () => {
  const { verifyTripReply } = await import("../src/lib/tripReplyVerification");
  const now = new Date("2098-02-01T04:00:00Z");
  const trips = destination();
  const reply = [
    "Аяллууд:", "",
    "1. ВЕЛМОРА – МАРИН АЯЛАЛ-Лхагва", "⏳ 9 өдөр 8 шөнө", "📅 2/11, 2/18", "",
    "2. Велмора-газар нислэг хосолсон - Торвен хотоос Марин нислэгтэй - 2 сарын 15, 20, 25", "⏳ 10 өдөр 9 шөнө", "💰 Том хүн 3,290,000₮", "📅 2/15, 2/20",
  ].join("\n");
  assert.equal(verifyTripReply({ reply, trips, now }), reply);
  assert.equal(verifyTripReply({ reply: reply.replace("3,290,000₮", "3,190,000₮"), trips, now }), "REFER", "a fare the trip does not have is still refused");
  assert.equal(verifyTripReply({ reply: reply.replace("3,290,000₮", "2,990,000₮"), trips, now }), "REFER", "and so is the trip above's fare under the noted trip");
});

// Live 2026-11-17: "12/30 ямар үнэтэй бна" (what does 12/30 cost — no "?") was read as "too expensive" and answered
// "Төсөв хэд вэ?". `\b` never fires beside a Cyrillic letter, so "ямар" did not count as a question word.
test("'<date> ямар үнэтэй бна' is a price question, not a price complaint", async (context: TestContext) => {
  const { hasPriceObjectionIntent } = await import("../src/lib/travelFastPaths");
  for (const text of ["2/18 ямар үнэтэй бна", "хэдэн үнэтэй бэ", "ymar unetei bna"]) assert.equal(hasPriceObjectionIntent(text), false, text);
  for (const text of ["арай үнэтэй юм", "их үнэтэй байна"]) assert.equal(hasPriceObjectionIntent(text), true, text);
  const harness = await conversationGateHarness(context);
  harness.catalog(destination());
  try {
    await harness.turn("price-q", "ВЕЛМОРА – МАРИН АЯЛАЛ-Лхагва", { unavailable: true });
    const asked = await harness.turn("price-q", "2/18 ямар үнэтэй бна", { unavailable: true });
    const said = textOf(asked.sends);
    assert.doesNotMatch(said, /Төсөв хэд вэ/u, `a fare question is not met with a budget question: ${said}`);
    assert.ok(!asked.sends.length || said.includes("2,990,000₮"), `answered with the fare, or left to staff: ${said}`);
  } finally {
    await harness.close();
  }
});

// Live 2026-11-14: "10 хүн 1 сард хайнань аялал бнауу" (ten people, in January) — any word between two numbers was read
// as "сарын", so the bot answered "10/1 — Захиалга авах боломжгүй".
test("'10 хүн 1 сард' is ten people in January, not the first of October", async (context: TestContext) => {
  const { extractStructuredDates } = await import("../src/lib/travelFastPathsPricing");
  assert.deepEqual(extractStructuredDates("10 хүн 1 сард велмора аялал бнауу"), []);
  assert.deepEqual(extractStructuredDates("2 сарын 18-нд"), [{ month: 2, day: 18 }]);
  assert.deepEqual(extractStructuredDates("3-р сарын 9"), [{ month: 3, day: 9 }]);
  const harness = await conversationGateHarness(context);
  // The trip has a closed October 1st departure, as the live one had a closed row the misread date fell on.
  harness.catalog([trip("oct", "ВЕЛМОРА – МАРИН АЯЛАЛ-Лхагва", ["2098-10-01", "2099-01-13", "2099-01-20"], [2_990_000, 2_690_000, null],
    { extra: { ...kind("direct_flight").extra, website_departure_availability: [{ date: "2098-10-01", status: "SOLD_OUT", seatsLeft: 0 }] } })]);
  try {
    const result = await harness.turn("ten-jan", "10 хүн 1 сард велмора аялал бнауу", { unavailable: true });
    const said = textOf(result.sends);
    assert.doesNotMatch(said, /10\/1|10 сарын 1\b|Захиалга авах боломжгүй|Суудал дүүрсэн/u, `no October date: ${said}`);
  } finally {
    await harness.close();
  }
});

// Live 2026-11-17: "1-р сарын 5- наас хойш …" and "Hi hainan aylal 1/10 naas" were read as that single day ("no trip on
// 1/5"); "12-20ноос" and "12.1с" too.
test("'from <date> on' in every way it is typed is a start date, not that one day", async () => {
  const { requestedDepartureScope } = await import("../src/lib/travelDates");
  const now = new Date("2098-02-01T04:00:00Z");
  for (const [text, start] of [["1-р сарын 5- наас хойш аялал бн уу", "2099-01-05"], ["velmora aylal 3/10 naas", "2098-03-10"],
    ["12-20ноос велмора аялал сонирхоё", "2098-12-20"], ["12.1с", "2098-12-01"], ["3 сарын 1-ээс хойш", "2098-03-01"]] as const) {
    const scope = requestedDepartureScope(text, now);
    assert.equal(scope?.kind, "range", `${text}: ${JSON.stringify(scope)}`);
    assert.equal(scope?.kind === "range" ? scope.startYmd : null, start, text);
  }
  // An end or "before" keeps its meaning.
  assert.deepEqual(requestedDepartureScope("2/28-аас 3/15 хүртэл", now), { kind: "range", startYmd: "2098-02-28", endYmd: "2098-03-15" });
  assert.notEqual(requestedDepartureScope("3/15-аас өмнө", now)?.kind, "range");
});

// Live 2026-11-17: "Hi hainan aylal 1/10 naas". A full trip of the destination carried "Hainan" as an alias (+80) and
// "1/10" sat inside its "2026-11-10" (+180 date bonus); its future rows were all SOLD_OUT next to copied-year CANCELLED
// rows, which read as "paused". The customer was told "энэ аялал одоогоор идэвхгүй байна" about a trip they never named.
test("a destination word that is a full trip's alias does not name that trip, and full is never called inactive", async (context: TestContext) => {
  const full = trip("full", "велмора-торвен нислэгтэй - Мягмар гариг", ["2098-01-10", "2098-11-10", "2098-02-10", "2098-02-17"], [3_490_000, 3_190_000, null],
    { extra: { ...kind("direct_flight").extra, aliases: ["Velmora", "Марин"], website_departure_availability: [
      { date: "2098-02-10", status: "SOLD_OUT", seatsLeft: null }, { date: "2098-02-17", status: "SOLD_OUT", seatsLeft: null },
      { date: "2099-09-15", status: "CANCELLED", seatsLeft: null }, { date: "2100-09-15", status: "CANCELLED", seatsLeft: null }] } });
  const { withBookableDepartureDates } = await import("../src/lib/departureAvailability");
  assert.equal(withBookableDepartureDates(full, new Date("2098-02-01T04:00:00Z")).status, "sold_out", "every held departure is full");
  const harness = await conversationGateHarness(context);
  harness.catalog([...destination(), full]);
  try {
    const result = await harness.turn("alias", "Hi velmora aylal 2/12 naas", { unavailable: true });
    const said = textOf(result.sends);
    assert.doesNotMatch(said, /идэвхгүй/u, `a full trip is never called inactive: ${said}`);
    assert.ok(!said.startsWith("✈️ велмора-торвен"), `the open trips lead, not the full one nobody named: ${said}`);
    assert.ok(!result.sends.length || /ВЕЛМОРА|Велмора-газар/u.test(said), `the destination's open trips: ${said}`);
  } finally {
    await harness.close();
  }
});

test("the matcher: a shared destination alias and a date inside another date give no lead", async () => {
  const { findTripMatches } = await import("../src/lib/travelFastPathsSearch");
  const open = trip("open", "ВЕЛМОРА – МАРИН АЯЛАЛ-Лхагва", ["2098-03-11"], [2_990_000, 2_690_000, null], kind("direct_flight"));
  const aliased = trip("aliased", "велмора-торвен нислэгтэй - Мягмар гариг", ["2098-03-10"], [3_490_000, 3_190_000, null],
    { extra: { ...kind("direct_flight").extra, aliases: ["Velmora"] } });
  const score = (text: string, trips: ReturnType<typeof trip>[], id: string) => findTripMatches(text, trips).find((m) => m.trip.id === id)?.score ?? -Infinity;
  // "Velmora" is a word of the other trip's name too: it no longer outranks that trip by the alias weight.
  assert.ok(score("velmora aylal", [open, aliased], "aliased") < score("velmora aylal", [open, aliased], "open") + 40,
    `aliased ${score("velmora aylal", [open, aliased], "aliased")} vs open ${score("velmora aylal", [open, aliased], "open")}`);
  // An alias only this trip's destination has still names it.
  const unique = trip("uniq", "ТОРВЕН ХОТЫН АЯЛАЛ", ["2098-03-12"], [1_990_000, 1_690_000, null], { extra: { ...kind("land").extra, aliases: ["Kaldor"] } });
  assert.equal(findTripMatches("kaldor aylal", [open, aliased, unique])[0]?.trip.id, "uniq");
  // "1/10" is not inside "2098-11-10".
  const dated = trip("dated", "ВЕЛМОРА – МАРИН АЯЛАЛ-Лхагва", ["2098-11-10"], [2_990_000, 2_690_000, null], kind("direct_flight"));
  const undated = { ...dated, id: "undated", departure_dates: ["2098-12-15"] } as ReturnType<typeof trip>;
  assert.equal(score("velmora 1/10", [dated], "dated"), score("velmora 1/10", [undated], "undated"));
});

// Live 2026-11-12/16: "suudal bga yu" on a date marked open with no seat count got "1 сарын 9: захиалга нээлттэй." and
// staff found that date full the next day.
test("asked about seats on an open date with no count, the bot leaves the count to the consultant", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog([trip("open", "ВЕЛМОРА АРЛЫН АЯЛАЛ", ["2098-03-09"], [3_980_000, 3_580_000, null],
    { seats_left: null, extra: { ...kind("direct_flight").extra, website_departure_availability: [{ date: "2098-03-09", status: "OPEN", seatsLeft: null }] } })]);
  try {
    const result = await harness.turn("seats", "Велмора арлын аялал 3/9 suudal bga yu", { unavailable: true });
    const said = textOf(result.sends);
    if (/захиалга нээлттэй/u.test(said)) assert.match(said, /Үлдсэн суудлын тоог аяллын зөвлөх баталгаажуулна/u, said);
  } finally {
    await harness.close();
  }
});

// Owner, 2026-11-28: a seat count staff typed for a date is said to the customer, whatever its size, with «цөөн суудал»
// beside it when staff picked that state; a date with no count still leaves the count to the consultant.
test("asked about seats on a date with a typed count, the bot says the count and the picked state", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog([trip("open", "ВЕЛМОРА АРЛЫН АЯЛАЛ", ["2098-03-09", "2098-03-16"], [3_980_000, 3_580_000, null],
    { seats_left: null, extra: { ...kind("direct_flight").extra, website_departure_availability: [
      { date: "2098-03-09", status: "ALMOST_FULL", seatsLeft: 19 }, { date: "2098-03-16", status: "OPEN", seatsLeft: 27 }] } })]);
  try {
    const low = textOf((await harness.turn("seats-low", "Велмора арлын аялал 3/9 suudal bga yu", { unavailable: true })).sends);
    assert.match(low, /19 суудал үлдсэн/u, low);
    assert.match(low, /цөөн суудал/u, low);
    assert.doesNotMatch(low, /зөвлөх баталгаажуулна/u, low);
    const open = textOf((await harness.turn("seats-open", "Велмора арлын аялал 3/16 suudal bga yu", { unavailable: true })).sends);
    assert.match(open, /27 суудал үлдсэн/u, open);
    assert.doesNotMatch(open, /цөөн суудал/u, open);
  } finally {
    await harness.close();
  }
});

// Live 2026-11-15: the bot suggested "НА ТРАНГ" and the customer answered "Натранг үнэ хөтөлбөр авья", then "Натранг":
// two name words typed as one matched nothing and both messages got silence.
test("two words of a trip's name typed as one name that trip", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog([trip("la", "ЛА МИРРО хотын аялал", ["2098-03-11", "2098-03-18"], [4_590_000, 4_290_000, null], kind("direct_flight")), ...destination()]);
  try {
    const result = await harness.turn("glued", "Ламирро үнэ", { unavailable: true });
    const said = textOf(result.sends);
    assert.ok(result.sends.length > 0 && said.includes("ЛА МИРРО"), `the trip is answered: ${said}`);
  } finally {
    await harness.close();
  }
});

// Live 2026-11-12: "Аль гарах өдрөөр аялах вэ? • 11 сарын 18 • 12 сарын 2 • 12 сарын 16" answered "16нд" got the same
// question again; a day without a month was no date.
test("a day typed under the bot's own date question is that listed departure", async (context: TestContext) => {
  const { dayOfOfferedDate } = await import("../src/lib/selectionAnswer");
  const asked = [{ role: "assistant", text: "НОРВЕЛ\n\nАль гарах өдрөөр аялах вэ?\n• 2 сарын 18\n• 3 сарын 2\n• 3 сарын 16\n• Өөр 4 сонголт бий." }];
  assert.equal(dayOfOfferedDate(asked, "16нд"), "3 сарын 16");
  assert.equal(dayOfOfferedDate(asked, "16"), "3 сарын 16", "a bare number past the options is a day");
  assert.equal(dayOfOfferedDate(asked, "2"), null, "a number within the options stays a position");
  assert.equal(dayOfOfferedDate(asked, "25нд"), null, "a day no listed date has is left alone");
  const harness = await conversationGateHarness(context);
  harness.catalog([trip("many", "НОРВЕЛ АРЛЫН АЯЛАЛ", ["2098-02-18", "2098-03-02", "2098-03-16", "2098-03-30", "2098-04-13"], [5_090_000, 4_590_000, null],
    { extra: { ...kind("direct_flight").extra, price_groups: [
      { dates: ["2098-02-18"], adult_price: 5_090_000, child_price: 4_590_000 }, { dates: ["2098-03-02"], adult_price: 5_190_000, child_price: 4_690_000 },
      { dates: ["2098-03-16"], adult_price: 5_290_000, child_price: 4_790_000 }, { dates: ["2098-03-30", "2098-04-13"], adult_price: 5_390_000, child_price: 4_890_000 }] } })]);
  try {
    const first = await harness.turn("day", "Норвел арлын аялал хэд бэ", { unavailable: true });
    assert.match(textOf(first.sends), /Аль гарах өдрөөр аялах вэ\?/u, textOf(first.sends));
    const pick = await harness.turn("day", "16нд", { unavailable: true });
    const said = textOf(pick.sends);
    assert.doesNotMatch(said, /Аль гарах өдрөөр аялах вэ\?/u, `not the same question again: ${said}`);
    assert.match(said, /3 сарын 16|3\/16|5,290,000₮/u, `the 3/16 departure: ${said}`);
  } finally {
    await harness.close();
  }
});
