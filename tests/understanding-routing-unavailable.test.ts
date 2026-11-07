import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { conversationGateHarness, type ModelOverride as BaseOverride } from "./helpers/conversationGateHarness";
import { namedFullCatalog } from "./helpers/understandingRoutingCatalogs";
import { TRIP_LIST_MARKERS, textOf } from "./helpers/understandingRoutingFixtures";

type ModelOverride = BaseOverride & { trips?: string[] };

/**
 * A trip the customer NAMES is that trip, whether or not it can be booked (case 13). The named trip
 * has one date and it is full; an open sibling shares the landmark word. The reply says the named
 * trip is full and lists what is open: it never presents the sibling as the answer, and never lists
 * siblings as if the named trip did not exist. Every trip and place below is invented.
 */
const ASK = "вердан зорентын хаалга аялал үнэ болон хөтөлбөр авья";
const NAMED = "ВЕРДАН + ЗОРЕНТЫН ХААЛГА";
const readings: Array<[string, ModelOverride]> = [
  ["the model gives no help", { topics: ["price", "program"] }],
  ["the model reads the full trip", { certainty: "one", tripId: "named", topics: ["price", "program"] }],
  ["the model reads the open sibling", { certainty: "one", tripId: "combo", topics: ["price", "program"] }],
  ["the model reads both", { certainty: "several", trips: ["T1", "T2"], intent: "trip", topics: ["price", "program"] }],
  ["the model is unavailable", { unavailable: true }],
];

test("case 13: the named trip is full: the reply says so and lists what is open", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(namedFullCatalog("SOLD_OUT"));
  try {
    for (const [label, model] of readings) {
      const result = await harness.turn(`rt-c13-${label}`, ASK, model);
      const said = textOf(result.sends);
      assert.ok(said.includes(NAMED), `${label}: the named trip is named in the reply: ${said}`);
      assert.match(said, /дууссан|дүүрсэн/, `${label}: it says the named trip is full: ${said}`);
      assert.ok(said.includes("ЗОРЕНТЫН ХААЛГАНЫ ГАЗАР НИСЛЭГ ХОСОЛСОН"), `${label}: the open sibling is offered as an alternative: ${said}`);
      assert.ok(!said.includes("Аяллууд:"), `${label}: not a bare list of siblings: ${said}`);
      // The notice about the named trip comes first; the sibling's fare appears only as an alternative.
      assert.ok(said.search(/дууссан|дүүрсэн/) < said.indexOf("2,750,000"), `${label}: full first, alternatives after: ${said}`);
    }
  } finally {
    await harness.close();
  }
});

test("case 13 class: other wordings of the same ask, in Cyrillic, Latin and with typos", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(namedFullCatalog("SOLD_OUT"));
  try {
    const wordings = [
      "вердан зорентын хаалга хэд вэ", "вердан зорентын хаалга хэзээ гарах вэ", "verdan zorentiin haalga une hed ve",
      "вердан зоренты хаалга хөтөлбөр", "ВЕРДАН + ЗОРЕНТЫН ХААЛГА ШУУД НИСЛЭГТЭЙ АЯЛАЛ үнэ",
    ];
    for (const [index, text] of wordings.entries()) {
      const result = await harness.turn(`rt-c13-class-${index}`, text, { topics: ["price"] });
      const said = textOf(result.sends);
      // Either the named trip is announced as full, or the bot stays silent and hands over: never a sibling's card.
      if (result.sends.length) {
        assert.ok(said.includes(NAMED) && /дууссан|дүүрсэн/.test(said), `"${text}" must announce the named trip as full: ${said}`);
      } else {
        assert.ok(result.leads.length > 0, `"${text}": silence without a staff lead`);
      }
      assert.ok(said.search(/дууссан|дүүрсэн/) < (said.includes("2,750,000") ? said.indexOf("2,750,000") : Infinity), `"${text}": full first, then alternatives: ${said}`);
    }
  } finally {
    await harness.close();
  }
});

test("case 13 positives: an open named trip is answered, and a bare list is still a list", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(namedFullCatalog("OPEN"));
  try {
    // The same ask while the trip has seats: price and programme of THAT trip.
    const open = await harness.turn("rt-c13-open", ASK, { certainty: "one", tripId: "named", topics: ["price", "program"] });
    const said = textOf(open.sends);
    assert.ok(said.includes("3,760,000"), `the open trip's fare: ${said}`);
    assert.doesNotMatch(said, /дууссан|дүүрсэн/, `an open trip is not announced as full: ${said}`);
    // A destination ask that names no single trip still lists the trips (the list is not over-suppressed).
    const several: ModelOverride = { certainty: "several", trips: ["T1", "T3", "T4"], intent: "trip", topics: ["price"] };
    const listed = await harness.turn("rt-c13-list", "Вердан аялал байна уу", several);
    assert.ok(TRIP_LIST_MARKERS.some((marker) => textOf(listed.sends).includes(marker)), `a destination ask is answered with its trips: ${textOf(listed.sends)}`);
  } finally {
    await harness.close();
  }
});
