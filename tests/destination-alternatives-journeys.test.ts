import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { conversationGateHarness, type ModelOverride as BaseOverride } from "./helpers/conversationGateHarness";
import { day, textOf, trip } from "./helpers/understandingRoutingFixtures";

/**
 * Production 2026-11-13 shape: one city is served by several trips — a direct-flight trip whose title
 * STARTS with the city, three ground trips that end in it, and a cruise. The customer asks for a date
 * (typed "M,D"), then asks for a ground trip, then says the date does not suit them.
 *
 * Before: the comma date was not read, an extra word beside the city made the flight trip the one
 * "verified" trip, and "ground trip?" was checked against that one trip only — so the reply said no
 * ground trip goes there while three did, one of them leaving on exactly the asked day.
 * Every town, trip, price and date below is invented.
 */
type ModelOverride = BaseOverride & { trips?: string[]; transport?: string | null; from?: string | null; to?: string | null };

const days = Array.from({ length: 5 }, (_, i) => day(i + 1, `ӨДӨР ${i + 1}`, `Хөтөлбөр ${i + 1} (invented).`));
const catalogue = () => [
  trip("fly", "Норвис - Мирален шууд нислэгтэй аялал (4 шөнө, 5 өдөр)", ["2098-03-30"], [3_090_000, 2_790_000, null],
    { duration_text: "5 өдөр 4 шөнө", extra: { transport_type: "direct_flight", aliases: [], itinerary_days: days } }),
  trip("four", "Норвис - Талмор – Жанвел - Эрдэн – 4 ХОТЫН АЯЛАЛ", ["2098-02-08", "2098-02-22"], [1_490_000, 1_190_000, null],
    { extra: { transport_type: "land", aliases: [], itinerary_days: days } }),
  trip("trade", "ЭРДЭН – ЖАНВЕЛ – ТОРВЕН – НОРВИС (ХУДАЛДАА)", ["2098-02-19", "2098-03-05"], [1_290_000, 990_000, null],
    { extra: { transport_type: "land", aliases: [], itinerary_days: days } }),
  trip("lovin", "ЭРДЭН – ЛОВИН – УТАРИ – НОРВИС", ["2098-02-11", "2098-02-25"], [1_390_000, 1_090_000, null],
    { extra: { transport_type: "land", aliases: [], itinerary_days: days } }),
  trip("cruise", "ЭРДЭН – НОРВИС – ТОРВЕН – ЧЭВОН УСАН ОНГОЦНЫ АЯЛАЛ", ["2098-02-13"], [4_990_000, 4_490_000, null],
    { extra: { transport_type: "cruise", aliases: [], itinerary_days: days } }),
  trip("isle", "МАРИНА АРЛЫН АЯЛАЛ", ["2098-02-14", "2098-02-28"], [3_100_000, 2_700_000, null],
    { extra: { transport_type: "direct_flight", aliases: [], itinerary_days: days } }),
];

const FLY = "Норвис - Мирален шууд нислэгтэй аялал";
const TRADE = "ЭРДЭН – ЖАНВЕЛ – ТОРВЕН – НОРВИС (ХУДАЛДАА)";
const LAND = [TRADE, "Норвис - Талмор – Жанвел - Эрдэн – 4 ХОТЫН АЯЛАЛ", "ЭРДЭН – ЛОВИН – УТАРИ – НОРВИС"];
const NO_LAND = /газрын аялал[^.\n]*(?:байхгүй|алга)/iu;

// How the understanding call may read the opening message; the reply must not depend on it.
const openingReadings: Array<[string, ModelOverride]> = [
  ["the model reads the date and the city's trips", { place: "норвис", trips: ["T1", "T2", "T3", "T4", "T5"], certainty: "several", date: "2098-02-19", topics: ["dates"] }],
  ["the model reads only the flight trip", { place: "норвис", tripId: "fly", certainty: "one", date: null, topics: ["dates"] }],
  ["the model gives no help", { topics: ["dates"] }],
  ["the model is unavailable", { unavailable: true }],
];

test("a date typed M,D beside a city shared by several trips finds the trip leaving that day", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(catalogue());
  try {
    for (const [label, model] of openingReadings) {
      const result = await harness.turn(`da-open-${label}`, "2,19 гарах норвис", model);
      const said = textOf(result.sends);
      if (!result.sends.length) { assert.ok(result.leads.length > 0, `${label}: silence without a staff lead`); continue; }
      assert.ok(said.includes(TRADE), `${label}: the trip leaving on the asked day is offered: ${said}`);
      assert.ok(!(said.includes(FLY) && !said.includes(TRADE)), `${label}: never only the flight trip: ${said}`);
    }
  } finally {
    await harness.close();
  }
});

test("unseen wordings of a dated city ask keep the date", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(catalogue());
  try {
    const wordings = ["2.19 норвис", "норвис 2,19-нд гарах уу", "norvis 2,19 garah", "2 сарын 19 норвис аялал", "Норвис руу 2/19-нд явмаар байна"];
    for (const [index, text] of wordings.entries()) {
      const result = await harness.turn(`da-wording-${index}`, text, { topics: ["dates"] });
      const said = textOf(result.sends);
      if (!result.sends.length) { assert.ok(result.leads.length > 0, `"${text}": silence without a staff lead`); continue; }
      assert.ok(said.includes(TRADE), `"${text}": the trip leaving 2/19 is offered: ${said}`);
    }
  } finally {
    await harness.close();
  }
});

test("a city word plus any word no trip name holds still asks which of the city's trips", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(catalogue());
  try {
    for (const [index, text] of ["норвис гарах", "норвис явмаар", "Норвис 19", "норвис аяллууд"].entries()) {
      const result = await harness.turn(`da-extra-${index}`, text, { unavailable: true });
      const said = textOf(result.sends);
      if (!result.sends.length) { assert.ok(result.leads.length > 0, `"${text}": silence without a staff lead`); continue; }
      const named = [FLY, ...LAND].filter((name) => said.includes(name));
      assert.ok(named.length >= 2, `"${text}": several of the city's trips, not one guessed trip: ${said}`);
    }
  } finally {
    await harness.close();
  }
});

test("'is there a ground trip?' after the flight trip searches the city, not the one trip on screen", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(catalogue());
  try {
    const readings: Array<[string, ModelOverride]> = [
      ["the model keeps the flight trip in focus", { tripId: "fly", certainty: "one", transport: "land", topics: ["transport"] }],
      ["the model gives no help", { transport: "land", topics: ["transport"] }],
      ["the model is unavailable", { unavailable: true }],
    ];
    for (const [label, model] of readings) {
      const sender = `da-ground-${label}`;
      await harness.turn(sender, "норвис мирален", { place: "норвис мирален", tripId: "fly", certainty: "one", topics: ["dates"] });
      const result = await harness.turn(sender, "газрын аялал нь байгаа юу", model);
      const said = textOf(result.sends);
      if (process.env.SHOW_REPLIES) console.log(`[${label}] ${said}`);
      assert.doesNotMatch(said, NO_LAND, `${label}: never "no ground trip" while the city has three: ${said}`);
      if (!result.sends.length) { assert.ok(result.leads.length > 0, `${label}: silence without a staff lead`); continue; }
      assert.ok(LAND.some((name) => said.includes(name)), `${label}: the city's ground trips are offered: ${said}`);
      assert.ok(!said.includes("УСАН ОНГОЦНЫ"), `${label}: a cruise is not a ground trip: ${said}`);
    }
  } finally {
    await harness.close();
  }
});

test("a date with no departure offers the nearest departures of the same kind, nearest first", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(catalogue());
  try {
    const reading: ModelOverride = { place: "норвис", trips: ["T2", "T3", "T4"], certainty: "several", date: "2098-02-20", transport: "land", topics: ["dates", "availability"] };
    const result = await harness.turn("da-near", "2 сарын 20-нд норвис руу газраар явах аялал байна уу", reading);
    const said = textOf(result.sends);
    if (process.env.SHOW_REPLIES) console.log(`[near] ${said}`);
    assert.ok(result.sends.length > 0, "a near miss is answered from the schedule, not silence");
    assert.ok(said.includes("2 сарын 19") && said.includes("2 сарын 22"), `the departures a day or two away are offered: ${said}`);
    assert.ok(said.indexOf("2 сарын 19") < said.indexOf("2 сарын 25") || !said.includes("2 сарын 25"), `nearest first: ${said}`);
    assert.ok(!said.includes(FLY) && !said.includes("УСАН ОНГОЦНЫ"), `the customer asked for a ground trip: ${said}`);
  } finally {
    await harness.close();
  }
});

// The rejected date (2/19) and the ground trips' other departures around it: 2/22 and 2/25 are within a week.
const OBJECTIONS = ["өдөр нь таарахн гүй байна аа", "тэр өдөр болохгүй", "өөр өдөр байгаа юу", "udur ni taarahgui bn", "огноо тохирохгүй байна"];

test("'the date does not suit me' drops that date and offers the nearest other departures of the same kind", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(catalogue());
  try {
    for (const [index, objection] of OBJECTIONS.entries()) {
      for (const model of [{ tripId: "trade", certainty: "one", topics: ["dates"] }, { unavailable: true }] as ModelOverride[]) {
        const sender = `da-reject-${index}-${model.unavailable ? "down" : "up"}`;
        const first = await harness.turn(sender, "2,19 гарах норвис", { place: "норвис", tripId: "trade", certainty: "one", date: "2098-02-19", topics: ["dates"] });
        assert.ok(textOf(first.sends).includes(TRADE), `the 2/19 trip is offered first: ${textOf(first.sends)}`);
        const result = await harness.turn(sender, objection, model);
        const said = textOf(result.sends);
        if (process.env.SHOW_REPLIES) console.log(`[${objection}] ${said}`);
        assert.ok(result.sends.length > 0, `"${objection}": answered from the schedule, not silence`);
        assert.doesNotMatch(said, /^•[^\n]*: 2 сарын 19(?!\d)/mu, `"${objection}": the rejected date is not offered again: ${said}`);
        assert.ok(said.includes("2 сарын 22") && said.includes("2 сарын 25"), `"${objection}": the nearest other ground departures: ${said}`);
        assert.ok(said.indexOf("2 сарын 22") < said.indexOf("2 сарын 25"), `"${objection}": nearest first: ${said}`);
        assert.ok(!said.includes(FLY) && !said.includes("УСАН ОНГОЦНЫ"), `"${objection}": the same kind of trip (ground): ${said}`);
        assert.doesNotMatch(said, /систем түр саатаж/u, `"${objection}": no model is needed, so never "the system is down": ${said}`);
        assert.match(said, /\?\s*$/u, `"${objection}": ends with a question the customer can answer: ${said}`);
        assert.ok(result.leads.length > 0, `"${objection}": staff hear that the date did not suit`);
      }
    }
  } finally {
    await harness.close();
  }
});

test("'a bit earlier' keeps only earlier departures; ordinary questions about days are not a rejection", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(catalogue());
  try {
    const sender = "da-earlier";
    await harness.turn(sender, "2,19 гарах норвис", { place: "норвис", tripId: "trade", certainty: "one", date: "2098-02-19", topics: ["dates"] });
    const earlier = await harness.turn(sender, "арай эрт гарах нь байна уу", { unavailable: true });
    const said = textOf(earlier.sends);
    assert.ok(said.includes("2 сарын 11"), `an earlier ground departure is offered: ${said}`);
    assert.ok(!/2 сарын 2[0-9]|3 сарын/u.test(said), `nothing later than the rejected date: ${said}`);
    // Not rejections: a length question and a date question are answered as before.
    const { isDateRejection } = await import("../src/lib/dateRejection");
    for (const text of ["хэдэн өдөр вэ", "өдрийн хөтөлбөр", "2 сарын 22 болох уу", "өдөр бүр гардаг уу", "хоол нь тохирох уу"]) {
      assert.equal(isDateRejection(text), false, `"${text}" is not a date rejection`);
    }
  } finally {
    await harness.close();
  }
});

test("a customer a consultant wrote to recently is sold no other dates on a date rejection", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(catalogue());
  try {
    const sender = "da-reject-existing";
    await harness.turn(sender, "2,19 гарах норвис", { place: "норвис", tripId: "trade", certainty: "one", date: "2098-02-19", topics: ["dates"] });
    harness.history.push({ id: (harness.history.at(-1)?.id || 0) + 1, sender_id: sender, role: "staff", text: "Сайн байна уу, тодруулъя.",
      attachments: [], created_at: new Date(Date.now() - 2 * 86_400_000).toISOString() });
    const result = await harness.turn(sender, "өдөр нь таарахгүй байна", { tripId: "trade", certainty: "one", topics: ["dates"] });
    assert.deepEqual(result.sends, [], `an existing customer is not sold other dates: ${textOf(result.sends)}`);
    assert.ok(result.leads.some((lead) => /Зөвлөхтэй өмнө нь харилцсан/.test(lead.context)), "staff get a lead that says why");
  } finally {
    await harness.close();
  }
});

test("a cancelled or full departure near the asked date is never offered as an alternative", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  const cancelled = catalogue().map((t) => t.id === "trade"
    ? { ...t, extra: { ...(t.extra as object), website_departure_availability: [
      { date: "2098-02-19", status: "CANCELLED", seatsLeft: null }, { date: "2098-03-05", status: "OPEN", seatsLeft: 8 }] } }
    : t);
  harness.catalog(cancelled as never);
  try {
    const reading: ModelOverride = { place: "норвис", trips: ["T2", "T3", "T4"], certainty: "several", date: "2098-02-20", transport: "land", topics: ["dates", "availability"] };
    const result = await harness.turn("da-cancelled", "2 сарын 20-нд норвис руу газраар явах аялал байна уу", reading);
    const said = textOf(result.sends);
    assert.ok(result.sends.length > 0, "answered from the schedule");
    assert.ok(!said.includes("2 сарын 19"), `the cancelled 2/19 departure is not offered: ${said}`);
    assert.ok(said.includes("2 сарын 22"), `the open departures are: ${said}`);
  } finally {
    await harness.close();
  }
});

/**
 * Found by replaying 2,121 real messages old against new: a long family message beside a shared city named ONE
 * trip because short filler words ("гэр", "бүл") sit inside a longer word of that trip's name and counted as
 * place words that only it held. Invented trips; one name carries "ГЭРЭЛТ" (a word containing "гэр").
 */
test("filler words that sit inside a longer name word never pick one trip of a shared city", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog([
    trip("lit", "ЛУМИС ГЭРЭЛТ ХОТЫН АЯЛАЛ", ["2098-02-12", "2098-02-26"], [1_800_000, 1_400_000, null], { extra: { transport_type: "land", aliases: [], itinerary_days: days } }),
    trip("mtn", "ЛУМИС УУЛЫН АЯЛАЛ", ["2098-02-13", "2098-02-27"], [1_700_000, 1_300_000, null], { extra: { transport_type: "land", aliases: [], itinerary_days: days } }),
    trip("sea", "ВЕЛМОР АРЛЫН АЯЛАЛ", ["2098-02-14"], [2_100_000, 1_700_000, null], { extra: { transport_type: "direct_flight", aliases: [], itinerary_days: days } }),
  ]);
  try {
    const wordings = ["лумис гэр бүл 3 том хүн аялалын дэлгэрэнгүй мэдээлэл өгөөч", "лумис гэр бүлээрээ явна", "Лумис гэр бүл 2 хүүхэдтэй"];
    for (const [index, text] of wordings.entries()) {
      const result = await harness.turn(`da-filler-${index}`, text, { unavailable: true });
      const said = textOf(result.sends);
      if (!result.sends.length) { assert.ok(result.leads.length > 0, `"${text}": silence without a staff lead`); continue; }
      assert.ok(said.includes("ЛУМИС ГЭРЭЛТ") && said.includes("ЛУМИС УУЛЫН"), `"${text}": both of the city's trips, not one guessed trip: ${said}`);
    }
  } finally {
    await harness.close();
  }
});

test("a rejection after a list of several dates offers only dates not already shown, never '0 days'", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  // The ground trips plus one more ground trip with dates the list below does not show.
  harness.catalog([...catalogue(), trip("extra", "МАРТЕН ХОТЫН АЯЛАЛ", ["2098-02-16", "2098-03-09"], [1_800_000, 1_400_000, null],
    { extra: { transport_type: "land", aliases: [], itinerary_days: days } })]);
  try {
    const sender = "da-reject-list";
    await harness.turn(sender, "2,19 гарах норвис", { unavailable: true });
    const list = await harness.turn(sender, "газрын аялал нь байгаа юу", { unavailable: true });
    const shownBefore = textOf(list.sends);
    const result = await harness.turn(sender, "өдөр нь таарахгүй байна аа", { unavailable: true });
    const said = textOf(result.sends);
    assert.ok(result.sends.length > 0, "answered, not silent");
    assert.doesNotMatch(said, /\(0 хоног|\b0 хоногийн/u, `no date is called zero days away: ${said}`);
    // Every date line of the reply is a departure that the list on screen did not show.
    const datesIn = (text: string) => new Set([...text.matchAll(/(\d{1,2}) сарын (\d{1,2})(?!\d)|(\d{1,2})\/(\d{1,2})(?!\d)/gu)].map((m) => `${m[1] ?? m[3]}/${m[2] ?? m[4]}`));
    const before = datesIn(shownBefore);
    const offered = datesIn(said.split("\n").filter((line) => line.startsWith("•")).join("\n"));
    for (const date of offered) assert.ok(!before.has(date), `${date} was already on screen and is not an "other date": ${said}`);
    assert.ok(offered.size > 0, `real dates are offered: ${said}`);
  } finally {
    await harness.close();
  }
});

test("a rejection when every other departure is already on screen is staff's: silence plus a lead, never the model or a repeat", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(catalogue());
  try {
    for (const model of [{ unavailable: true }, { tripId: "trade", certainty: "one", topics: ["dates"] }] as ModelOverride[]) {
      const sender = `da-reject-none-${model.unavailable ? "down" : "up"}`;
      await harness.turn(sender, "2,19 гарах норвис", { unavailable: true });
      await harness.turn(sender, "газрын аялал нь байгаа юу", { unavailable: true });
      const result = await harness.turn(sender, "өдөр нь таарахгүй байна аа", model);
      assert.deepEqual(result.sends, [], `nothing real to offer: no reply: ${textOf(result.sends)}`);
      assert.ok(result.leads.some((lead) => /санал болгох өөр гарах өдөр байхгүй/.test(lead.context)), `staff get a lead that says why: ${result.leads.map((l) => l.context).join("|")}`);
    }
  } finally {
    await harness.close();
  }
});

/**
 * Independent review: "<city> аялалд явна" ("I want to go on the <city> trip") named ONE trip, because the inflected
 * generic word "аялалд" was kept as a route word and only the one name holding "аялал" covered it. Invented trips,
 * exactly one of which holds the word.
 */
test("an inflected generic word beside a shared city still asks which of the city's trips", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog([
    trip("a", "ЛУМИС ХОТЫН АЯЛАЛ", ["2098-02-12"], [1_800_000, 1_400_000, null], { extra: { transport_type: "land", aliases: [], itinerary_days: days } }),
    trip("b", "ЛУМИС – ВЕЛМОР ХОТ", ["2098-02-13"], [1_700_000, 1_300_000, null], { extra: { transport_type: "land", aliases: [], itinerary_days: days } }),
    trip("c", "ЛУМИС – ТАЛМОР УУЛ", ["2098-02-14"], [1_900_000, 1_500_000, null], { extra: { transport_type: "land", aliases: [], itinerary_days: days } }),
  ]);
  try {
    const wordings = ["лумис аялалд явна", "лумис аялалаар явах", "лумис аялалыг сонирхож байна", "лумис аялалд явмаар байна", "лумис аялалын тухай"];
    for (const [index, text] of wordings.entries()) {
      const result = await harness.turn(`da-inflect-${index}`, text, { unavailable: true });
      const said = textOf(result.sends);
      if (!result.sends.length) { assert.ok(result.leads.length > 0, `"${text}": silence without a staff lead`); continue; }
      const named = ["ЛУМИС ХОТЫН АЯЛАЛ", "ЛУМИС – ВЕЛМОР ХОТ", "ЛУМИС – ТАЛМОР УУЛ"].filter((name) => said.includes(name));
      assert.ok(named.length >= 2, `"${text}": several of the city's trips, not one guessed trip: ${said}`);
    }
  } finally {
    await harness.close();
  }
});
