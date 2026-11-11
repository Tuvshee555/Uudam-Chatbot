import assert from "node:assert/strict";
import test from "node:test";
import { conversationGateHarness, type ModelOverride } from "./helpers/conversationGateHarness";
import { CATALOGUE, titleOf } from "./helpers/understandingCatalogue";

/**
 * Journeys for trip identity, context, weather and constraint memory (invented catalogue of the
 * understanding scenario suite, tests/helpers/understandingCatalogue.ts; mocked clock November 2026).
 * Each reproduces the shape of an open scenario: a weather question read as a trip list or a sold-out
 * notice, a rejected place answered with that very place, a land trip's flight question silenced, a
 * Latin "what time", a party stated before any trip, an existing customer seen only once per harness.
 */

const NOW = "2026-11-06T04:00:00Z";
const MIN = 60_000;
const weatherText = (source: string) => `🌍 Очих хотуудад одоогоор: ${source}: 14°C, багавтар үүлтэй.`;
const trip = (tripId: string, topics: string[], extra: ModelOverride = {}): ModelOverride => ({ intent: "trip", certainty: "one", tripId, topics, ...extra });
const topics = (list: string[], extra: ModelOverride = {}): ModelOverride => ({ intent: "trip", certainty: "none", topics: list, ...extra });
const text = (sends: Array<{ text: string }>) => sends.map((send) => send.text).join("\n");

test("fa-ctx journeys: weather of a place, negation, transport, clock time, constraint ledger", async (t) => {
  const harness = await conversationGateHarness(t);
  const { setTripSelection } = await import("../src/lib/tripSelectionState");
  t.mock.timers.setTime(Date.parse(NOW));
  harness.catalog(CATALOGUE);
  let weather: "ok" | "down" = "ok";
  const innerFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/weather")) {
      if (weather === "down") throw new Error("weather api down");
      const source = new URL(url).searchParams.get("source") || "unknown";
      return new Response(JSON.stringify({ text: weatherText(source), tripSlug: `slug-${source}` }), { status: 200 });
    }
    return innerFetch(input as never, init);
  }) as typeof fetch;
  const at = (iso: string) => t.mock.timers.setTime(Date.parse(iso));

  try {
    await t.test("a place several sibling trips share: its weather once, never their fare list", async () => {
      at(NOW);
      const result = await harness.turn("fa-weather-shared", "Verdan tsag agaar yamar bn", topics(["weather"], { certainty: "several", place: "Verdan" }));
      const reply = text(result.sends);
      assert.match(reply, /Очих хотуудад одоогоор/);
      assert.doesNotMatch(reply, /₮|Аяллууд:|сонголт бий/);
    });

    await t.test("the named trip is fully booked: the weather of its place, not a sold-out notice with prices", async () => {
      at(NOW);
      const result = await harness.turn("fa-weather-sold", "Вердан зорентын хаалга хүйтэн үү", topics(["weather"], { certainty: "several", place: "Вердан зорентын хаалга" }));
      const reply = text(result.sends);
      assert.match(reply, /Очих хотуудад одоогоор/);
      assert.doesNotMatch(reply, /₮|дууссан|нээлттэй байна/);
    });

    await t.test("the weather service is down: silence and a lead, no trip content", async () => {
      at(NOW);
      weather = "down";
      try {
        const result = await harness.turn("fa-weather-down", "Tsag agaar n Verdan zorentiin haalga odoo ymar bga ve", topics(["weather"], { certainty: "several", place: "Verdan zorentiin haalga" }));
        assert.equal(result.sends.length, 0, text(result.sends));
        assert.ok(harness.leads.some((lead) => lead.sender_id === "fa-weather-down"), "staff get the question");
      } finally { weather = "ok"; }
    });

    await t.test("'анхны аяллын цаг агаар' is the weather of the FIRST trip of the conversation", async () => {
      at(NOW);
      const sender = "fa-weather-first";
      await harness.turn(sender, "Вэлмор далайн эргийн аялал", trip("sea-a", ["price"]));
      await harness.turn(sender, "Норвел хотын аялал", trip("norvel", ["price"]));
      const result = await harness.turn(sender, "Анхны аяллын цаг агаар ямар байна", trip("sea-a", ["weather"]));
      const reply = text(result.sends);
      assert.match(reply, /sea-a/);
      assert.doesNotMatch(reply, /norvel/);
    });

    await t.test("a place the customer rejects ('… парк хэрэггүй', 'lunaria orohgui') is left out of the answer", async () => {
      at(NOW);
      for (const [sender, said] of [["fa-neg-cyr", "Пекара явъя, Лунариа парк хэрэггүй"], ["fa-neg-lat", "pekara yavmaar bna lunaria orohgui"], ["fa-neg-but", "Пекара үзмээр байна гэхдээ Лунариа хэрэггүй."]]) {
        const result = await harness.turn(sender, said, topics(["price"], { certainty: "several", place: "Пекара" }));
        const reply = text(result.sends);
        assert.match(reply, /ПЕКАРА/, said);
        assert.ok(!reply.includes(titleOf("pekara-park")), `${said}: names the rejected trip\n${reply}`);
      }
    });

    await t.test("'<trip> ни биш, далайтай аяллын үнэ': the sea trip's fare, not the rejected one", async () => {
      at(NOW);
      const sender = "fa-neg-particle";
      await harness.turn(sender, "Вэлмор далайн эргийн аялал", trip("sea-a", ["price"]));
      await harness.turn(sender, "Норвел хотын аялал", trip("norvel", ["price"]));
      const result = await harness.turn(sender, "Норвел ни биш, далайтай аяллын үнэ", trip("sea-a", ["price"]));
      const reply = text(result.sends);
      assert.match(reply, /1,391,000₮/);
      assert.ok(reply.includes(titleOf("sea-a")), reply);
      assert.ok(!reply.includes(titleOf("norvel")), reply);
    });

    await t.test("a land trip asked 'does it fly from <its own town>': answered from its transport, not silenced or the sibling", async () => {
      at(NOW);
      const sender = "fa-land-fly";
      await setTripSelection(sender, { tripId: "erdan-land", date: null, hotel: null, package: null, passengers: [] });
      const result = await harness.turn(sender, "Эрдэнээс нисэх юм уу", trip("erdan-land", ["transport"]));
      const reply = text(result.sends);
      assert.match(reply, /Газрын аялал/);
      assert.ok(!reply.includes(titleOf("volda-fly")), reply);
      assert.equal(result.selection?.tripId, "erdan-land");
    });

    await t.test("Latin 'hezhe tsagt niseh ve' asks the clock time of the flight: the itinerary's times", async () => {
      at("2026-11-02T04:00:00Z");
      const sender = "fa-clock-latin";
      await setTripSelection(sender, { tripId: "verdan-nov", date: null, hotel: null, package: null, passengers: [] });
      const result = await harness.turn(sender, "Hezhe tsagt niseh ve", trip("verdan-nov", ["dates", "transport"]));
      const reply = text(result.sends);
      assert.match(reply, /\d{1,2}:\d{2}/);
      assert.doesNotMatch(reply, /^Шууд нислэгтэй аялал\.?\s*$/m);
    });

    await t.test("every existing customer is recognised, not only the first one a harness sees", async () => {
      at("2026-11-02T04:00:00Z");
      const ago = 5 * 86_400_000;
      for (const sender of ["fa-existing-1", "fa-existing-2"]) {
        harness.thread(sender, { messages: [
          { from: "customer", text: "Сайн байна уу", agoMs: ago + 12 * MIN },
          { from: "page", source: "mobile", text: "Сайн байна уу, би аяллын зөвлөх", agoMs: ago },
        ] });
        const result = await harness.turn(sender, "11 сарын 3-ны вердан", topics(["dates"], { place: "Verdan" }), undefined, { platform: "facebook" });
        assert.equal(result.sends.length, 0, `${sender}: ${text(result.sends)}`);
        assert.ok(result.leads.some((lead) => /Зөвлөхтэй өмнө нь харилцсан/.test(lead.context)), `${sender}: ${result.leads.map((lead) => lead.context).join(" | ")}`);
      }
    });

    await t.test("a party told before any trip is named is priced when the trip comes", async () => {
      at(NOW);
      const sender = "fa-ledger-party";
      await harness.turn(sender, "2 том 2 хүүхэдтэй явна", topics(["price"], { passengers: [{ kind: "adult", count: 2 }, { kind: "child", count: 2 }] }));
      const result = await harness.turn(sender, "Норвел", trip("norvel", ["price"], { passengers: [{ kind: "adult", count: 2 }, { kind: "child", count: 2 }] }));
      assert.match(text(result.sends), /Нийт: 6,764,000₮/);
    });
  } finally {
    globalThis.fetch = innerFetch;
    await harness.close();
  }
});

test("negation: what is and is not ruled out", async () => {
  const { withoutNegatedTrips } = await import("../src/lib/negatedTrip");
  const names = (word: string) => /^(?:Лунариа|lunaria|Норвел)$/iu.test(word) ? ["park"] : /^парк$/iu.test(word) ? ["park"] : false;
  assert.deepEqual(withoutNegatedTrips("Пекара явъя, Лунариа парк хэрэггүй", names), { text: "Пекара явъя", negated: ["Лунариа парк"] });
  assert.deepEqual(withoutNegatedTrips("pekara yavmaar bna lunaria orohgui", names), { text: "pekara yavmaar bna", negated: ["lunaria"] });
  assert.deepEqual(withoutNegatedTrips("Норвел ни биш, далайтай аялал", names), { text: "далайтай аялал", negated: ["Норвел"] });
  assert.deepEqual(withoutNegatedTrips("Лунариагаас бусад аялал", names), { text: "аялал", negated: ["Лунариа"] });
  assert.deepEqual(withoutNegatedTrips("Пекара лунариагүй", names), { text: "Пекара", negated: ["лунариа"] });
  // A question, a package part, a pronoun: nothing is ruled out.
  assert.deepEqual(withoutNegatedTrips("Лунариа орохгүй юу", names), { text: "Лунариа орохгүй юу", negated: [] });
  assert.deepEqual(withoutNegatedTrips("Норвел хөтөлбөр хэрэггүй", (word) => /хөтөлбөр|Норвел/iu.test(word)), { text: "Норвел хөтөлбөр хэрэггүй", negated: [] });
  assert.deepEqual(withoutNegatedTrips("энэ биш", () => true), { text: "энэ биш", negated: [] });
});

test("clock time: 'хэзээ цагт' / 'hezhe tsagt' with a leg word, not a bare 'when'", async () => {
  const { asksClockTime } = await import("../src/lib/scheduleTimes");
  assert.equal(asksClockTime("Hezhe tsagt niseh ve"), true);
  assert.equal(asksClockTime("хэзээ цагт нисэх вэ"), true);
  assert.equal(asksClockTime("хэзээ нисэх вэ"), false);
});

test("constraint ledger: stated values replace, unknown places keep, exact dates never travel", async () => {
  const { nextConstraintLedger, ledgerCarryFor } = await import("../src/lib/constraintLedger");
  const { buildTripRequest, mergeTripSelection } = await import("../src/lib/tripRequest");
  const now = new Date(NOW);
  const step = (previous: ReturnType<typeof nextConstraintLedger> | null, said: string) =>
    nextConstraintLedger(previous, { text: said, request: buildTripRequest(said, CATALOGUE, undefined, now), trips: CATALOGUE, now: now.getTime() });
  const party = step(null, "2 том 2 хүүхэдтэй явна");
  assert.deepEqual(party.passengers, [{ kind: "adult", count: 2 }, { kind: "child", count: 2 }]);
  const december = step(party, "12 сард Норвел");
  assert.equal(december.dateScope?.month, 12);
  assert.ok(december.destinations.length > 0);
  assert.deepEqual(december.passengers, party.passengers, "a turn that states no party keeps it");
  const unknown = step(december, "Зааркан руу явмаар байна");
  assert.deepEqual(unknown.destinations, december.destinations, "an unknown place does not clear the stored destination");
  const restated = step(unknown, "3 том хүн 1 хүүхэд");
  assert.deepEqual(restated.passengers, [{ kind: "adult", count: 3 }, { kind: "child", count: 1 }], "a stated party replaces the stored one");
  const exact = step(restated, "12 сарын 6-нд");
  assert.equal(exact.dateScope, null, "an exact date replaces the window and is not carried");
  const norvel = CATALOGUE.find((entry) => entry.id === "norvel")!;
  const sea = CATALOGUE.find((entry) => entry.id === "sea-b")!;
  assert.equal(ledgerCarryFor(december, norvel, now)?.dateScope?.month, 12);
  assert.equal(ledgerCarryFor(step(party, "1 сард"), sea, now)?.dateScope, null, "a window the trip does not depart in is not inherited");
  // An empty ledger leaves the selection merge exactly as it was.
  const request = buildTripRequest("Норвел", CATALOGUE, undefined, now);
  assert.deepEqual(mergeTripSelection("norvel", request, null, null), mergeTripSelection("norvel", request, null));
  assert.equal(ledgerCarryFor(null, norvel, now), null);
});
