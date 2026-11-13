import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { conversationGateHarness, type ModelOverride as BaseOverride } from "./helpers/conversationGateHarness";
import { day, textOf, trip } from "./helpers/understandingRoutingFixtures";
import { doesNotSuit, isDateRejection, rejectedDayOfMonth } from "../src/lib/dateRejection";

/**
 * Findings of the independent review of the 2026-11-13 changes (each verified by a skeptic before it was fixed):
 * a detector that took questions for rejections, a rejection that names its date, the focus trip's own next date
 * after a rejection, a second "other date?", the travel kind of a "no trip that day" reply, the order "1" means under
 * it. Every trip below is invented.
 */
type ModelOverride = BaseOverride & { trips?: string[]; transport?: string | null };
const days = Array.from({ length: 5 }, (_, i) => day(i + 1, `ӨДӨР ${i + 1}`, `Хөтөлбөр ${i + 1} (invented).`));
const land = (id: string, name: string, dates: string[], fare: number) =>
  trip(id, name, dates, [fare, fare - 300_000, null], { extra: { transport_type: "land", aliases: [], itinerary_days: days } });
const catalogue = () => [
  trip("fly", "Норвис - Мирален шууд нислэгтэй аялал (4 шөнө, 5 өдөр)", ["2098-03-30"], [3_090_000, 2_790_000, null],
    { extra: { transport_type: "direct_flight", aliases: [], itinerary_days: days } }),
  land("four", "Норвис - Талмор – Жанвел - Эрдэн – 4 ХОТЫН АЯЛАЛ", ["2098-02-08", "2098-02-22"], 1_490_000),
  land("trade", "ЭРДЭН – ЖАНВЕЛ – ТОРВЕН – НОРВИС (ХУДАЛДАА)", ["2098-02-19", "2098-03-05"], 1_290_000),
  land("lovin", "ЭРДЭН – ЛОВИН – УТАРИ – НОРВИС", ["2098-02-11", "2098-02-25"], 1_390_000),
];
const TRADE = "ЭРДЭН – ЖАНВЕЛ – ТОРВЕН – НОРВИС (ХУДАЛДАА)";
const FLY = "Норвис - Мирален шууд нислэгтэй аялал";
const OPEN_ON_19 = { place: "норвис", tripId: "trade", certainty: "one", date: "2098-02-19", topics: ["dates"] } as ModelOverride;

test("the rejection detector takes only real rejections: questions, conditionals, policy, times and durations are ordinary messages", () => {
  const rejections = ["өдөр нь таарахгүй байна аа", "тэр өдөр болохгүй", "тэр өдөр боломжгүй", "тэр өдөр би завгүй", "тэр үед боломжгүй байна",
    "өөр өдөр байгаа юу", "арай хожуу гарах нь байна уу", "арай эрт гарах нь байна уу", "udur ni taarahgui bn", "огноо тохирохгүй байна"];
  for (const text of rejections) assert.equal(isDateRejection(text), true, `"${text}" turns a date down`);
  const ordinary = ["дараагийн гаралт хэзээ вэ", "хэрэв өдөр нь болохгүй бол мөнгөө буцаах уу", "өдөр тохирохгүй бол төлбөр буцаана уу",
    "нислэг өглөө эрт гарах уу", "өглөө эрт гарах уу", "хугацаа нь тохирохгүй байна", "хэдэн өдөр вэ", "өдөр бүр гардаг уу", "хоол нь тохирох уу"];
  for (const text of ordinary) assert.equal(isDateRejection(text), false, `"${text}" is not a rejection`);
  // A rejection that names its date, or only its day.
  assert.equal(doesNotSuit("2/19 тохирохгүй байна"), true);
  assert.equal(doesNotSuit("хэрэв 2/19 тохирохгүй бол мөнгө буцаах уу"), false);
  assert.equal(rejectedDayOfMonth("19 нь таарахгүй байна даа"), 19);
  assert.equal(rejectedDayOfMonth("19 хүн явна"), null);
});

test("a rejection that names the date drops that date instead of confirming it as open", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(catalogue());
  try {
    for (const [index, text] of ["2 сарын 19 таарахгүй байна", "2/19 тохирохгүй байна", "19 нь таарахгүй байна даа"].entries()) {
      const sender = `rf-named-${index}`;
      await harness.turn(sender, "2,19 гарах норвис", OPEN_ON_19);
      const result = await harness.turn(sender, text, { unavailable: true });
      const said = textOf(result.sends);
      assert.ok(result.sends.length > 0, `"${text}": answered`);
      assert.doesNotMatch(said, /захиалга нээлттэй/u, `"${text}": the rejected date is not confirmed as open: ${said}`);
      assert.doesNotMatch(said, /^•[^\n]*: 2 сарын 19(?!\d)/mu, `"${text}": not offered again: ${said}`);
      assert.ok(said.includes("2 сарын 22") || said.includes("2 сарын 25"), `"${text}": other dates are offered: ${said}`);
    }
  } finally {
    await harness.close();
  }
});

test("after a rejection, the focus trip's own other date is still answered as that trip's date, never 'no departure'", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(catalogue());
  try {
    const sender = "rf-focus-date";
    await harness.turn(sender, "2,19 гарах норвис", OPEN_ON_19);
    await harness.turn(sender, "өдөр нь таарахгүй байна аа", { unavailable: true });
    const result = await harness.turn(sender, "3 сарын 5", { unavailable: true });
    const said = textOf(result.sends);
    assert.ok(result.sends.length > 0, "answered");
    // The focus trip holds 3/5: its own date is answered as open (a compact answer need not repeat the trip's name).
    assert.match(said, /3 сарын 5: захиалга нээлттэй/u, `the focus trip's own date is open: ${said}`);
    assert.doesNotMatch(said, /гарах аялал алга|хуваарь байхгүй/u, `not "no trip then": ${said}`);
  } finally {
    await harness.close();
  }
});

test("a second 'another date?' never brings back a date already offered", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(catalogue());
  try {
    const sender = "rf-second";
    await harness.turn(sender, "2,19 гарах норвис", OPEN_ON_19);
    const first = await harness.turn(sender, "өөр өдөр байгаа юу", { unavailable: true });
    const second = await harness.turn(sender, "өөр өдөр байгаа юу", { unavailable: true });
    const rows = (text: string) => text.split("\n").filter((line) => line.startsWith("•")).join("\n");
    const offeredFirst = [...rows(textOf(first.sends)).matchAll(/(\d{1,2}) сарын (\d{1,2})(?!\d)/gu)].map((m) => `${m[1]}/${m[2]}`);
    assert.ok(offeredFirst.length > 0, `the first reply offers dates: ${textOf(first.sends)}`);
    assert.doesNotMatch(rows(textOf(second.sends)), /: 2 сарын 19(?!\d)/u, `the rejected date is not back: ${textOf(second.sends)}`);
    for (const date of offeredFirst) {
      const [month, dayOfMonth] = date.split("/");
      assert.ok(!new RegExp(`: ${month} сарын ${dayOfMonth}(?!\\d)`, "u").test(rows(textOf(second.sends))), `${date} was already offered: ${textOf(second.sends)}`);
    }
  } finally {
    await harness.close();
  }
});

test("a ground-trip ask on a day only a flight leaves is not answered with the flight", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  // The flight departs on the asked day (2/20); no ground trip does.
  harness.catalog([
    trip("fly", "Норвис - Мирален шууд нислэгтэй аялал (4 шөнө, 5 өдөр)", ["2098-02-20"], [3_090_000, 2_790_000, null],
      { extra: { transport_type: "direct_flight", aliases: [], itinerary_days: days } }),
    ...catalogue().filter((t) => t.id !== "fly"),
  ]);
  try {
    const reading: ModelOverride = { place: "норвис", trips: ["T1", "T2", "T3", "T4"], certainty: "several", date: "2098-02-20", transport: "land", topics: ["dates", "availability"] };
    const result = await harness.turn("rf-kind", "2 сарын 20-нд норвис руу газрын аялал байна уу", reading);
    const said = textOf(result.sends);
    assert.ok(!said.includes(FLY), `the ground-trip ask is not answered with the flight: ${said}`);
    assert.doesNotMatch(said, /таны асуусан хугацаанд/u, `no row claims to be on the asked day: ${said}`);
  } finally {
    await harness.close();
  }
});

test("'1' under the nearest-dates reply is the first trip SHOWN, not the first in the catalogue", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(catalogue());
  try {
    const sender = "rf-order";
    const reading: ModelOverride = { place: "норвис", trips: ["T2", "T3", "T4"], certainty: "several", date: "2098-02-20", transport: "land", topics: ["dates", "availability"] };
    const list = await harness.turn(sender, "2 сарын 20-нд норвис руу газраар явах аялал байна уу", reading);
    const rows = textOf(list.sends).split("\n").filter((line) => line.startsWith("•"));
    assert.ok(rows[0].includes(TRADE), `the nearest departure (2/19) is listed first: ${textOf(list.sends)}`);
    const pick = await harness.turn(sender, "1", { unavailable: true });
    const said = textOf(pick.sends);
    assert.ok(said.includes(TRADE), `"1" is the first trip shown: ${said}`);
    assert.ok(!said.includes("Талмор"), `not the first trip of the catalogue: ${said}`);
  } finally {
    await harness.close();
  }
});

// Independent review (C6): the journey for the cancelled-date guard passed without the guard, because the harness
// path already strips closed dates. This unit test hands the function a trip whose closed date is still in its list.
test("a cancelled or sold-out departure is never an alternative, even if it is still in the trip's own date list", async () => {
  const { departuresNearestTo, nearestDepartureAlternatives, askedWindowOf } = await import("../src/lib/dateAlternatives");
  const { requestedDepartureScope } = await import("../src/lib/travelDates");
  const now = new Date("2098-02-01T04:00:00Z");
  const closed = trip("closed", "ЛУМИС ХОТЫН АЯЛАЛ", ["2098-02-19", "2098-02-26", "2098-03-05"], [1_300_000, 1_000_000, null], {
    extra: { transport_type: "land", aliases: [], itinerary_days: days, website_departure_availability: [
      { date: "2098-02-19", status: "CANCELLED", seatsLeft: null }, { date: "2098-02-26", status: "SOLD_OUT", seatsLeft: 0 }, { date: "2098-03-05", status: "OPEN", seatsLeft: 6 }] } });
  const near = departuresNearestTo([closed], ["2098-02-20"], now, { max: 10, perTrip: 10 }).map((row) => row.date);
  assert.deepEqual(near, ["2098-03-05"], "only the open departure is offered");
  const window = askedWindowOf(requestedDepartureScope("2 сарын 20-нд", now), now)!;
  assert.deepEqual(nearestDepartureAlternatives([closed], window, now, { max: 10, perTrip: 10 }).map((row) => row.date), ["2098-03-05"]);
});
