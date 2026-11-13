import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { conversationGateHarness, type ModelOverride as BaseOverride } from "./helpers/conversationGateHarness";
import { day, textOf, trip } from "./helpers/understandingRoutingFixtures";

/**
 * Live since 2026-11-11: a customer who typed an ACTIVE trip's name (or picked it from a list, or answered
 * with a date under it) was told that a DIFFERENT, ended trip "is inactive". The notice for ended trips
 * (buildArchivedTripNotice) says it runs only once the active catalogue has failed to match, but the webhook
 * called it first, and it matched an ended trip on one shared word ("арлын аялал"). On the live catalogue 18
 * of 44 active trip names typed in full got it. Every trip below is invented.
 */
type ModelOverride = BaseOverride & { trips?: string[] };
const days = Array.from({ length: 5 }, (_, i) => day(i + 1, `ӨДӨР ${i + 1}`, `Хөтөлбөр ${i + 1} (invented).`));
const catalogue = () => [
  trip("lom", "ЛОМБОР АРЛЫН АЯЛАЛ", ["2098-02-14", "2098-02-28"], [2_100_000, 1_700_000, null],
    { extra: { transport_type: "direct_flight", aliases: [], itinerary_days: days } }),
  trip("mar", "МАРТЕН ХОТЫН АЯЛАЛ", ["2098-02-12", "2098-02-26"], [1_800_000, 1_400_000, null],
    { extra: { transport_type: "land", aliases: [], itinerary_days: days } }),
  trip("zet", "ЗЕТАР АРЛЫН АЯЛАЛ 2097", ["2097-12-01"], [2_000_000, 1_600_000, null],
    { status: "archived", extra: { transport_type: "direct_flight", aliases: [], archived_reason: "all_departure_dates_passed" } }),
  trip("old", "МАРТЕН ХОТЫН НАМРЫН АЯЛАЛ 2097", ["2097-10-01"], [1_500_000, 1_100_000, null],
    { status: "archived", extra: { transport_type: "land", aliases: [], archived_reason: "all_departure_dates_passed" } }),
  // An ended trip whose own text says "by land" (газраар): a transport word is never a place the customer names.
  trip("gz", "ЗЕНТОР ГАЗРААР АЯЛАЛ 2097", ["2097-08-01"], [1_300_000, 1_000_000, null],
    { status: "archived", extra: { transport_type: "land", aliases: [], archived_reason: "all_departure_dates_passed" } }),
  // Shares no word with any open trip: the one case where the ended-trip notice is right.
  trip("kv", "КВАНТОР НУУРЫН ЦАМХАГ", ["2097-09-01"], [1_200_000, 900_000, null],
    { status: "archived", extra: { transport_type: "land", aliases: [], archived_reason: "all_departure_dates_passed" } }),
];
const ENDED = /идэвхгүй/u;

const readings: Array<[string, ModelOverride]> = [
  ["the model reads the active trip", { tripId: "lom", certainty: "one", topics: ["price"] }],
  ["the model gives no help", { topics: ["price"] }],
  ["the model is unavailable", { unavailable: true }],
];

test("an active trip's name is never answered with another, ended trip's notice", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(catalogue());
  try {
    const wordings = ["ЛОМБОР АРЛЫН АЯЛАЛ", "ломбор арлын аялал хэд вэ", "Ломбор арлын аяллын үнэ", "lombor arlyn aylal une hed ve", "ломбор арлын аялал хэзээ гарах вэ"];
    for (const [label, model] of readings) {
      for (const [index, text] of wordings.entries()) {
        const result = await harness.turn(`an-${label}-${index}`, text, model);
        const said = textOf(result.sends);
        assert.doesNotMatch(said, ENDED, `${label}: "${text}" is about an open trip, never "inactive": ${said}`);
        assert.ok(!said.includes("ЗЕТАР"), `${label}: "${text}" never names the ended trip: ${said}`);
      }
    }
  } finally {
    await harness.close();
  }
});

test("a city word shared with an ended trip lists the open trips, not the ended one", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(catalogue());
  try {
    for (const [index, text] of ["мартен хэд вэ", "мартен аялал", "мартен хотын аялал үнэ"].entries()) {
      const result = await harness.turn(`an-city-${index}`, text, { unavailable: true });
      const said = textOf(result.sends);
      assert.doesNotMatch(said, ENDED, `"${text}": the open trip answers, the ended one is not announced: ${said}`);
    }
  } finally {
    await harness.close();
  }
});

test("a date typed under an open trip stays about that trip", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(catalogue());
  try {
    for (const [label, model] of readings) {
      const sender = `an-date-${label}`;
      await harness.turn(sender, "ломбор арлын аялал", model);
      const result = await harness.turn(sender, "2 сарын 14", model);
      const said = textOf(result.sends);
      assert.doesNotMatch(said, ENDED, `${label}: a date under an open trip is not "inactive": ${said}`);
    }
  } finally {
    await harness.close();
  }
});

test("positive control: an ended trip named alone is still announced as ended", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(catalogue());
  try {
    for (const [index, text] of ["квантор нуурын цамхаг хэд вэ", "КВАНТОР НУУРЫН ЦАМХАГ аялал үнэ"].entries()) {
      const result = await harness.turn(`an-ended-${index}`, text, { unavailable: true });
      const said = textOf(result.sends);
      assert.match(said, ENDED, `"${text}": the ended trip is called inactive: ${said}`);
      assert.ok(said.includes("КВАНТОР"), `"${text}": and named: ${said}`);
    }
  } finally {
    await harness.close();
  }
});

test("'by land' beside a city is a travel mode, never an unknown place that silences the answer", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(catalogue());
  try {
    const readings2: Array<[string, ModelOverride]> = [
      ["the model reads the trip", { tripId: "mar", certainty: "one", topics: ["dates"] }],
      ["the model is unavailable", { unavailable: true }],
    ];
    const wordings = ["мартен газраар явмаар байна", "мартен газраар явах аялал байна уу", "мартен хотод газраар", "Мартен руу газраар явна"];
    for (const [label, model] of readings2) {
      for (const [index, text] of wordings.entries()) {
        const result = await harness.turn(`an-land-${label}-${index}`, text, model);
        const said = textOf(result.sends);
        assert.ok(result.sends.length > 0, `${label}: "${text}" is answered, not silenced (leads: ${result.leads.length})`);
        assert.ok(said.includes("МАРТЕН"), `${label}: "${text}" is about the open trip: ${said}`);
        assert.doesNotMatch(said, ENDED, `${label}: "${text}": nothing about an ended trip: ${said}`);
      }
    }
  } finally {
    await harness.close();
  }
});

// Independent review (I-3): the ended trip itself, typed in full, whose OPEN sibling shares the city.
test("an ended trip typed in full is announced as ended even when an open sibling shares its city", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(catalogue());
  try {
    // (A longer price question that also matches the open trip strongly is answered by the earlier answer-plan step
    // with the open trip's card; that is a known limit, not covered here.)
    for (const [index, text] of ["МАРТЕН ХОТЫН НАМРЫН АЯЛАЛ 2097", "мартен намрын аялал"].entries()) {
      const result = await harness.turn(`an-sibling-${index}`, text, { unavailable: true });
      const said = textOf(result.sends);
      assert.match(said, ENDED, `"${text}": the ended trip is called inactive: ${said}`);
      assert.ok(said.includes("НАМРЫН"), `"${text}": and it is the ended trip that is named: ${said}`);
    }
    // The open sibling typed in full still gets its own answer.
    const open = await harness.turn("an-sibling-open", "мартен хотын аялал хэд вэ", { unavailable: true });
    assert.doesNotMatch(textOf(open.sends), ENDED, `the open trip is not "inactive": ${textOf(open.sends)}`);
  } finally {
    await harness.close();
  }
});
