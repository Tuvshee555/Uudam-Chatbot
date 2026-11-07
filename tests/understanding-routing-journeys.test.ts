import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { conversationGateHarness, type ModelOverride as BaseOverride } from "./helpers/conversationGateHarness";
import { correctionsCatalog, landFamily } from "./helpers/understandingRoutingCatalogs";
import { TRIP_LIST_MARKERS, textOf } from "./helpers/understandingRoutingFixtures";

/**
 * IDENTITY AND CONTEXT. The customer keeps answering about the trip they are on; a name, alias or
 * attribute word does not hijack it; "not that one, the other" never answers with the one on screen.
 * Every trip, town and price below is invented. The shapes are the real conversations of 2026-11
 * (docs: understanding audit): a land trip hijacked by a sibling whose TITLE says "<town>-ээс нислэгтэй",
 * a thank-you that got a trip list, "barter?" that re-sent a list, and corrections.
 */
/** The harness passes extra keys (the numbered `trips` of the model's reading) straight through. */
type ModelOverride = BaseOverride & { trips?: string[] };
const list = (n: number): ModelOverride => ({ certainty: "several", trips: Array.from({ length: n }, (_, i) => `T${i + 1}`), intent: "trip", topics: ["price"] });
const one = (tripId: string, extra: ModelOverride = {}): ModelOverride => ({ certainty: "one", tripId, ...extra });

type Harness = Awaited<ReturnType<typeof conversationGateHarness>>;

/** The customer asked about a town, was offered a list and tapped the land trip: it is selected. */
async function selectLandTrip(harness: Harness, sender: string) {
  await harness.turn(sender, "Лумор, Саривана аялалыг сонирхож байна", list(3));
  const card = await harness.turn(sender, "1. ЭРДЭН – ЛУМОР – САРИВАН – ТОРНЕЛ", {});
  assert.equal(card.selection?.tripId, "sel", `setup: the land trip is selected (${textOf(card.sends)})`);
}

test("case 11: a follow-up with the selected trip's own town and a transport word keeps the selected trip", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(landFamily);
  try {
    const readings: Array<[string, ModelOverride]> = [
      ["the model gives no help", { topics: ["transport"] }],
      ["the model reads the selected trip", one("sel", { topics: ["transport"] })],
      ["the model reads the title-matching sibling", one("far", { topics: ["transport"] })],
      ["the model is unavailable", { unavailable: true }],
    ];
    for (const [label, model] of readings) {
      const sender = `rt-c11-${label}`;
      await selectLandTrip(harness, sender);
      const asked = await harness.turn(sender, "Эрдэнээс нисэх юм уу", model);
      assert.equal(asked.selection?.tripId, "sel", `${label}: the selection must not move to the sibling (${textOf(asked.sends)})`);
      const said = textOf(asked.sends);
      assert.ok(!said.includes("ВОЛДАР"), `${label}: the sibling must not be presented as the answer: ${said}`);
      for (const marker of TRIP_LIST_MARKERS) assert.ok(!said.includes(marker), `${label}: no menu: ${said}`);
    }
    // Cascade: what the customer says next is quoted on the trip they are on, not on the sibling.
    const sender = "rt-c11-cascade";
    await selectLandTrip(harness, sender);
    await harness.turn(sender, "Эрдэнээс нисэх юм уу", { topics: ["transport"] });
    const date = await harness.turn(sender, "2/25-ны аялал", { topics: ["dates"], certainty: "one", tripId: "sel" });
    assert.ok(!/Тэр хугацаанд гарах аялал алга/.test(textOf(date.sends)), `the selected trip departs on that date: ${textOf(date.sends)}`);
    assert.equal(date.selection?.tripId, "sel");
    const party = await harness.turn(sender, "2 том хүн", { topics: ["price"], passengers: [{ kind: "adult", count: 2 }] });
    assert.ok(textOf(party.sends).includes("2,414,000"), `two adults on the ORIGINAL trip: ${textOf(party.sends)}`);
    assert.ok(!textOf(party.sends).includes("4,380,000"), `not the sibling's fares: ${textOf(party.sends)}`);
  } finally {
    await harness.close();
  }
});

test("case 11 class: unseen wordings and spellings with the selected trip's town never leave it", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(landFamily);
  try {
    const wordings = [
      "Эрдэнээс онгоцоор явах уу", "Эрдэнээс буцах уу", "Эрдэн хотод хэд хононо вэ", "Эрдэнээс аялал хэдэн цагт эхлэх вэ",
      "Эрдэнэс нисэх үү", "Erdenees nisekh uu", "erdenees onogtsoor yavah uu", "Лумор хүртэл нисэх үү", "Эрдэн хүртэл нисэх үү",
    ];
    for (const [index, text] of wordings.entries()) {
      const sender = `rt-c11-class-${index}`;
      await selectLandTrip(harness, sender);
      const asked = await harness.turn(sender, text, { topics: ["transport"] });
      assert.equal(asked.selection?.tripId, "sel", `"${text}" must stay on the selected trip: ${textOf(asked.sends)}`);
      assert.ok(!textOf(asked.sends).includes("ВОЛДАР"), `"${text}" must not present the sibling: ${textOf(asked.sends)}`);
    }
  } finally {
    await harness.close();
  }
});

test("case 11 positives: naming another trip by what only it has still switches", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(landFamily);
  try {
    // A destination the selected trip does not have: a real change of mind.
    const sender = "rt-c11-switch";
    await selectLandTrip(harness, sender);
    const asked = await harness.turn(sender, "Волдар руу нисэж болох уу", one("far", { topics: ["transport"] }));
    assert.equal(asked.selection?.tripId, "far", `a new destination switches: ${textOf(asked.sends)}`);
    // The title as typed, with a party: the switch carries the head count the customer already gave.
    const other = "rt-c11-switch-title";
    await selectLandTrip(harness, other);
    await harness.turn(other, "2 том хүн", { topics: ["price"], passengers: [{ kind: "adult", count: 2 }] });
    const named = await harness.turn(other, "МАРИНА АРЛЫН АЯЛАЛ", one("isl", { topics: ["price"] }));
    assert.equal(named.selection?.tripId, "isl", `a trip named by its title switches: ${textOf(named.sends)}`);
    assert.equal(named.selection?.passengers.length, 1, "the party the customer gave travels with them");
    // An ordinary question about the selected trip is still answered from it.
    const price = "rt-c11-price";
    await selectLandTrip(harness, price);
    const answered = await harness.turn(price, "Үнэ хэд вэ", { topics: ["price"] });
    assert.ok(textOf(answered.sends).includes("1,207,000"), `the selected trip's fare: ${textOf(answered.sends)}`);
  } finally {
    await harness.close();
  }
});

test("corrections: 'not the previous one, the other one with the sea' never answers with the trip on screen", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(correctionsCatalog);
  try {
    const fix = "Өмнөх аяллынх биш, нөгөө далайтай аяллын үнэ.";
    const readings: Array<[string, ModelOverride]> = [
      ["no help", { topics: ["price"] }], ["sea trip", one("seaA", { topics: ["price"] })],
      ["several sea trips", { certainty: "several", trips: ["T2", "T3"], intent: "trip", topics: ["price"] }], ["unavailable", { unavailable: true }],
    ];
    for (const [label, model] of readings) {
      // The customer looked at a sea trip, then the city trip is the one on screen.
      const sender = `rt-corr-${label}`;
      await harness.turn(sender, "ВЭЛМОР ДАЛАЙН ЭРГИЙН АЯЛАЛ", one("seaA", { topics: ["price"] }));
      await harness.turn(sender, "НОРВЕЛ ХОТЫН АЯЛАЛ", one("city", { topics: ["price"] }));
      const corrected = await harness.turn(sender, fix, model);
      const said = textOf(corrected.sends);
      assert.ok(!said.includes("1,791,000"), `${label}: the city trip's fare must not answer a correction away from it: ${said}`);
      assert.ok(/ВЭЛМОР|ТАРСИС|далай/i.test(said), `${label}: a sea trip is what the correction asks for: ${said}`);
    }
    // The other trip is found from what was shown, without a kind word.
    for (const text of ["Эхний аяллын үнийг хэлээч", "Өмнөх аялал руугаа буцъя", "Энэ аялал биш, нөгөө аяллын үнэ"]) {
      const sender = `rt-back-${text}`;
      await harness.turn(sender, "ВЭЛМОР ДАЛАЙН ЭРГИЙН АЯЛАЛ", one("seaA", { topics: ["price"] }));
      await harness.turn(sender, "НОРВЕЛ ХОТЫН АЯЛАЛ", one("city", { topics: ["price"] }));
      const back = await harness.turn(sender, text, { topics: ["price"] });
      assert.ok(!textOf(back.sends).includes("1,791,000"), `"${text}" must not answer with the city trip: ${textOf(back.sends)}`);
    }
    // A negated trip named in the message still works: not A, but B.
    const sender = "rt-corr-negated";
    await harness.turn(sender, "ВЕРДАН ХОТЫН АЯЛАЛ", one("verdan", { topics: ["price"] }));
    const moved = await harness.turn(sender, "Бид Вердан биш Журан руу шууд явмаар байна", { topics: ["price"] });
    assert.notEqual(moved.selection?.tripId, "verdan", `the negated trip is not kept: ${textOf(moved.sends)}`);
    // Positive control: "нөгөө" as an everyday word in a trip question changes nothing.
    const control = "rt-corr-control";
    await harness.turn(control, "НОРВЕЛ ХОТЫН АЯЛАЛ", one("city", { topics: ["price"] }));
    const stays = await harness.turn(control, "нөгөө 2 хүн болон 1 хүүхдийн үнэ хэд вэ", { topics: ["price"], passengers: [{ kind: "adult", count: 2 }, { kind: "child", count: 1 }] });
    assert.equal(stays.selection?.tripId, "city", `an everyday "нөгөө" does not leave the trip: ${textOf(stays.sends)}`);
  } finally {
    await harness.close();
  }
});
