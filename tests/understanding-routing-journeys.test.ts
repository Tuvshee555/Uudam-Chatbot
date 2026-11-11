import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { conversationGateHarness, type ModelOverride as BaseOverride } from "./helpers/conversationGateHarness";
import { closedDepartureCatalog, correctionsCatalog, landFamily, siblingIslandsCatalog } from "./helpers/understandingRoutingCatalogs";
import { TRIP_LIST_MARKERS, textOf } from "./helpers/understandingRoutingFixtures";

/**
 * IDENTITY AND CONTEXT. The customer keeps answering about the trip they are on; a name, alias or
 * attribute word does not hijack it; "not that one, the other" never answers with the one on screen.
 * Every trip, town and price below is invented. The shapes are the real conversations of 2026-11
 * (docs: understanding audit): a land trip hijacked by a sibling whose TITLE says "<town>-ээс нислэгтэй",
 * a thank-you that got a trip list, "barter?" that re-sent a list, and corrections.
 */
/** The harness passes extra keys (the numbered `trips` of the model's reading) straight through. */
type ModelOverride = BaseOverride & { trips?: string[]; requestedFacts?: Array<{ field: string; evidence: string }> };
/** The two-trip reading the model gives a destination ask. */
const listOf2 = (intent: "catalog" | "trip"): ModelOverride => ({ certainty: "several", trips: ["T1", "T2"], intent, topics: ["price"] });
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
    // The customer picked the city trip from ONE list that also held both sea trips (nothing was shown before).
    for (const [label, model] of readings) {
      const sender = `rt-corr-list-${label}`;
      await harness.turn(sender, "Норвел Вэлмор Тарсис аялал", list(3));
      const picked = await harness.turn(sender, "1", {});
      assert.equal(picked.selection?.tripId, "city", "setup: the city trip is selected from the list");
      const corrected = await harness.turn(sender, fix, model);
      const said = textOf(corrected.sends);
      assert.ok(!said.includes("1,791,000"), `${label} (list): the city trip's fare must not answer the correction: ${said}`);
      assert.ok(/ВЭЛМОР|ТАРСИС/.test(said), `${label} (list): the sea trips are offered: ${said}`);
    }
    // Two trips were listed, the customer picked the second: "the other one" is the first, which was shown.
    const two = "rt-corr-two";
    await harness.turn(two, "Вэлмор Тарсис аялал", { certainty: "several", trips: ["T2", "T3"], intent: "trip", topics: ["price"] } as ModelOverride);
    const second = await harness.turn(two, "2", {});
    assert.equal(second.selection?.tripId, "seaB", "setup: the second listed trip is selected");
    const otherOne = await harness.turn(two, "Нөгөө аялал нь хэд вэ", { topics: ["price"] });
    assert.ok(textOf(otherOne.sends).includes("1,391,000") && !textOf(otherOne.sends).includes("2,291,000"), `the other listed trip's fare: ${textOf(otherOne.sends)}`);
    // "Not this one" with nothing else to point at: the refused trip is not quoted again.
    const refused = "rt-corr-refused";
    await harness.turn(refused, "НОРВЕЛ ХОТЫН АЯЛАЛ", one("city", { topics: ["price"] }));
    const none = await harness.turn(refused, "Энэ аялал биш", { topics: ["price"] });
    assert.ok(!textOf(none.sends).includes("1,791,000"), `the refused trip's card is not repeated: ${textOf(none.sends)}`);
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

test("barter after a list: a follow-up with no topic, no place and no pointing word never re-lists the trips (case 8)", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(siblingIslandsCatalog);
  try {
    // The shape of the real thread: a two-trip list, a free-text answer to a group question (the list is
    // now stale), then a business-policy question the model mislabels as a trip follow-up.
    const labels: ModelOverride[] = [
      { intent: "trip", certainty: "none", topics: [] },
      { intent: "trip", certainty: "several", trips: ["T1", "T2"], topics: [] },
      { intent: "other", certainty: "none", topics: [] },
    ];
    for (const [index, label] of labels.entries()) {
      for (const text of ["barter awdag u", "Бартер авдаг уу", "Бартер эсвэл гэрээгээр төлж болох уу"]) {
        const sender = `rt-barter-${index}-${text}`;
        const listed = await harness.turn(sender, "sain baina uu dorman 2 aylalin tlr medeelel awy", listOf2("catalog"));
        assert.ok(TRIP_LIST_MARKERS.some((marker) => textOf(listed.sends).includes(marker)), "setup: the list was sent");
        await harness.turn(sender, "baiguullagara 40-45 hun ywah bol hymdral uzuuldeg uu", { intent: "other", certainty: "none", topics: [], finalReply: "Манай аяллын зөвлөх тантай холбогдож тодруулна." });
        const asked = await harness.turn(sender, text, label);
        const said = textOf(asked.sends);
        for (const marker of TRIP_LIST_MARKERS) assert.ok(!said.includes(marker), `"${text}" (${JSON.stringify(label)}) must not re-list trips: ${said}`);
        for (const name of siblingIslandsCatalog.map((value) => value.route_name)) assert.ok(!said.includes(name), `"${text}" names no trip: ${said}`);
      }
    }
    // Positive controls: the list is still the answer to a fare question, and a number still picks.
    const sender = "rt-barter-control";
    await harness.turn(sender, "sain baina uu dorman 2 aylalin tlr medeelel awy", listOf2("catalog"));
    const picked = await harness.turn(sender, "2", {});
    assert.equal(picked.selection?.tripId, "isl-b", `a number picks from the list: ${textOf(picked.sends)}`);
    const other = "rt-barter-control-price";
    await harness.turn(other, "sain baina uu dorman 2 aylalin tlr medeelel awy", listOf2("catalog"));
    const fares = await harness.turn(other, "Үнэ хэд вэ", listOf2("trip"));
    assert.ok(/2,291,000|2,491,000/.test(textOf(fares.sends)), `a price question under the list is answered with the listed fares: ${textOf(fares.sends)}`);
  } finally {
    await harness.close();
  }
});

test("a list answers 'which trip?', not a question none of the listed trips can answer", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(closedDepartureCatalog);
  try {
    const both: ModelOverride = { certainty: "several", trips: ["T2", "T3"], intent: "trip", topics: ["price"] };
    // A typed requested fact the catalogue has no source for (wi-fi, a property of the room, another unsupported question).
    const unanswerable: Array<[string, ModelOverride]> = [
      ["Вердан аялал wifi байна уу", both],
      ["Вердан аяллын өрөө том уу, буудлын одтой юу", both],
      ["Вердан аялал дээр хүнсний хориотой хүн явж болох уу", { ...both, requestedFacts: [{ field: "other.unsupported", evidence: "хүнсний хориотой" }] }],
      ["verdan aylal wifi bn uu", both],
    ];
    for (const [index, [text, model]] of unanswerable.entries()) {
      const result = await harness.turn(`rt-list-hand-${index}`, text, model);
      for (const marker of TRIP_LIST_MARKERS) assert.ok(!textOf(result.sends).includes(marker), `"${text}" must not be answered with a list: ${textOf(result.sends)}`);
      assert.deepEqual(result.sends, [], `"${text}": no data, no answer: ${textOf(result.sends)}`);
      assert.ok(result.leads.length > 0, `"${text}": staff get the lead`);
    }
    // Positive controls: the same destination with an ordinary question is still listed.
    for (const [index, text] of ["Вердан аялал байна уу", "Вердан аяллын үнэ хэд вэ", "Вердан аяллууд хэзээ гарах вэ"].entries()) {
      const result = await harness.turn(`rt-list-control-${index}`, text, both);
      assert.ok(TRIP_LIST_MARKERS.some((marker) => textOf(result.sends).includes(marker)) || /2,990,000/.test(textOf(result.sends)), `"${text}" is still answered with its trips: ${textOf(result.sends)}`);
    }
  } finally {
    await harness.close();
  }
});

// Known open failures of this stream (kept visible, owner's rule): none of them is a wrong confident answer.
test.todo("a bare alias shared by a full trip and an open sibling is announced as 'one is full, one is open' (today the open sibling is named alone)");
test.todo("model unavailable: a genuine switch to a trip named by one destination word is offered as a menu of ONE trip instead of being chosen");
test.todo("an existing customer who names one trip and a date it does not depart on still gets the nearest departures from the answer plan (only the multi-trip date miss is silent)");
test.todo("Instagram threads carry no consultant rows, so the existing-customer signal is Facebook-only");
