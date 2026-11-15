import assert from "node:assert/strict";
import test from "node:test";
import { conversationGateHarness, type FixtureTrip } from "./helpers/conversationGateHarness";
import { formatTripListCard } from "../src/lib/travelFastPathsPricing";
import { requestedDepartureScope } from "../src/lib/travelDates";
import { buildTripRequest, mergeTripSelection } from "../src/lib/tripRequest";
import { withoutNegatedTrips } from "../src/lib/negatedTrip";
import { conversationLeadContext } from "../src/lib/leadContext";
import { adultCountAnswer, ADULT_COUNT_QUESTION } from "../src/lib/selectionAnswer";

// Failures confirmed on 2026-10-30 by replaying real customer conversations (Sep–Oct) through
// the current webhook with the live catalogue and model. Each case below is that conversation's
// shape on an invented catalogue; no customer text, trip, place, price or date is real.
const trip = (id: string, name: string, dates: string[], fields: Record<string, unknown> = {}) => ({
  id, route_name: name, operator_name: "Fixture agency", category: "Аялал", adult_price: 2_291_000, child_price: 1_891_000, infant_price: 351_000,
  currency: "MNT", status: "active", duration_text: "9 өдөр 8 шөнө", departure_dates: dates, seats_total: 20, seats_left: 10,
  has_food: null, hotel: "", photo_urls: [], notes: "", source_description: "",
  extra: { customer_visible: true, age_rules: { adult: "12+ нас", child: "2-11 нас", infant: "0-23 сар" } }, ...fields,
} as unknown as FixtureTrip);

const combo = (id: string, name: string, adult: number, dates: string[]) =>
  trip(id, name, dates, { adult_price: adult, child_price: adult - 400_000, category: "Газар + нислэг хосолсон", source_description: "газар нислэг хосолсон" });
const listAsk = { certainty: "several", trips: ["T1", "T2", "T3"], intent: "catalog" };

test("a weekly-schedule trip shows its schedule in a list card, never 'undefined/undefined'", () => {
  const card = formatTripListCard(1, trip("w", "ВЭЛМОР ДӨРВӨН ХОТЫН АЯЛАЛ", []), { duration: "8 өдөр 7 шөнө", dates: ["Ням гараг бүр"] }, new Date("2098-02-01T04:00:00Z"));
  assert.match(card, /📅 Ням гараг бүр$/);
  assert.doesNotMatch(card, /undefined/);
});

test("customer turns from real conversations get grounded answers, not the free-text model or silence", async (context) => {
  const harness = await conversationGateHarness(context);
  try {
    // Sep 11 / Oct 30 shape: a typed "3" or "1" under a list went to the free-text model (or got
    // silence) while tapping the same option's button got the trip card.
    await context.test("a typed number picks the shown option and gets the same card as its button", async () => {
      harness.catalog([combo("a", "ЛУМАРА А ГАЗАР НИСЛЭГ ХОСОЛСОН", 2_991_000, ["2098-03-08"]),
        combo("b", "ЛУМАРА Б ГАЗАР НИСЛЭГ ХОСОЛСОН", 2_651_000, ["2098-03-10"]),
        combo("c", "ЛУМАРА В ГАЗАР НИСЛЭГ ХОСОЛСОН", 2_291_000, ["2098-03-11", "2098-03-18"])]);
      await harness.turn("typed-pick", "Нислэг газар хосолсон", listAsk);
      const picked = await harness.turn("typed-pick", "3", { finalReply: "FREE-TEXT MODEL ANSWER" });
      assert.equal(picked.answerModelCalls, 0, "the free-text model is not asked");
      assert.equal(picked.selection?.tripId, "c");
      assert.match(picked.sends[0]?.text || "", /^✈️ ЛУМАРА В ГАЗАР НИСЛЭГ ХОСОЛСОН\n\n🗓 Хугацаа: 9 өдөр 8 шөнө\n\n💰 Үнэ:/);
    });

    // Sep 11 + Oct 30: the booking flow read the trip only from the last reply's words; after a
    // compact answer it asked "Аль аялал вэ?" after the phone and wrote no lead until answered.
    await context.test("booking after a pick completes on the phone with the picked trip on the lead", async () => {
      await harness.turn("book-picked", "Нислэг газар хосолсон", listAsk);
      await harness.turn("book-picked", "1");
      const start = await harness.turn("book-picked", "zahialga hiie");
      assert.equal(start.sends[0]?.text, "Утасны дугаараа бичнэ үү.");
      const done = await harness.turn("book-picked", "90000000");
      assert.equal(done.leads.length, 1);
      assert.match(done.leads[0].context, /ЛУМАРА А ГАЗАР НИСЛЭГ ХОСОЛСОН/);
      assert.equal(done.sends[0]?.text, "ЛУМАРА А ГАЗАР НИСЛЭГ ХОСОЛСОН\nЗахиалгын хүсэлтийг хүлээн авлаа.");
      assert.doesNotMatch(done.sends.map((send) => send.text).join("\n"), /Аль аялал/);
    });

    // Oct 30 shape: "Захиалга өгөх" → a destination → phone. The lead said only "left a phone".
    await context.test("a phone typed after a list tells staff which trips the customer was looking at", async () => {
      await harness.turn("phone-after-list", "Нислэг газар хосолсон", listAsk);
      const phone = await harness.turn("phone-after-list", "90000001");
      assert.equal(phone.leads.length, 1);
      assert.match(phone.leads[0].context, /Сүүлд санал болгосон: ЛУМАРА А/);
      assert.match(phone.leads[0].context, /Нислэг газар хосолсон/);
    });

    // Live replay: "2 хүүхэдтэй" printed a "Нийт" over the children alone; "одоо 3 том хүн"
    // dropped the child; a head count under a single-fare trip asked for the date twice.
    await context.test("party follow-ups keep every traveller and ask only the missing count", async () => {
      harness.catalog([trip("p", "ВЭЛМОР НУУРЫН АЯЛАЛ", ["2098-03-12", "2098-03-26"])]);
      const one = { certainty: "one", tripId: "p" };
      await harness.turn("party", "Вэлмор нуур үнэ", one);
      const minors = await harness.turn("party", "2 хүүхэдтэй", { ...one, passengers: [{ kind: "child", count: 2 }] });
      assert.match(minors.sends[0]?.text || "", /1,891,000₮/);
      assert.ok((minors.sends[0]?.text || "").endsWith(ADULT_COUNT_QUESTION), "one question: the number of adults");
      assert.doesNotMatch(minors.sends[0]?.text || "", /Нийт/, "no total over the children alone");
      const adults = await harness.turn("party", "2", one);
      assert.match(adults.sends[0]?.text || "", /Нийт: 8,364,000₮/, "2 adults and the 2 children asked about");
      assert.match(adults.sends[0]?.text || "", /Аль гарах өдрөөр аялах вэ\?/, "the bookable dates come with the total");
      const changed = await harness.turn("party", "Одоо 3 том хүн", { ...one, passengers: [{ kind: "adult", count: 3 }] });
      assert.match(changed.sends[0]?.text || "", /Нийт: 10,655,000₮/, "3 adults and the same 2 children");
    });

    // Oct 15 + Oct 26: "Хүүхдийн амралт 11.1-с эхлэх гээд бдаг", "11/14-с хойш" got the card
    // again or silence; "сарын 1-ээс хойш" was read as that single day.
    await context.test("a 'from this date on' constraint lists only departures from that day", async () => {
      harness.catalog([trip("s", "ЛУМАРА ТЭНГИСИЙН ГАЗРЫН АЯЛАЛ", ["2098-02-15", "2098-02-20", "2098-03-06", "2098-03-20"])]);
      await harness.turn("onward", "Лумара тэнгис", { certainty: "one", tripId: "s" });
      const reply = (await harness.turn("onward", "Хүүхдийн амралт 3.1-с эхлэх гээд бдаг...яах вэ", { certainty: "one", tripId: "s" })).sends[0]?.text || "";
      assert.match(reply, /3 сарын 6/);
      assert.match(reply, /3 сарын 20/);
      assert.doesNotMatch(reply, /2 сарын 1[05]|2 сарын 20/);
    });

    // Live replay: "<place> биш, далайтай нь" answered with that very place's trip.
    await context.test("a correction rules the named place out and lists what was asked for", async () => {
      harness.catalog([trip("city1", "ЛУМАРА ХОТЫН АЯЛАЛ", ["2098-03-08"], { extra: { customer_visible: true, aliases: ["Лумара"] } }),
        trip("city2", "ЛУМАРА ДАЛАЙН ЭРГИЙН АЯЛАЛ", ["2098-03-09"], { extra: { customer_visible: true, aliases: ["Лумара"] } }),
        trip("sea", "ВЭЛМОР ДАЛАЙН ЭРГИЙН АЯЛАЛ", ["2098-03-10"])]);
      const unknownSea = { certainty: "none", trips: [], unknown_destination: "далай" };
      const reply = (await harness.turn("correction", "Лумара биш, далайтай нь", unknownSea)).sends[0]?.text || "";
      assert.match(reply, /ВЭЛМОР ДАЛАЙН ЭРГИЙН АЯЛАЛ/);
      assert.doesNotMatch(reply, /ЛУМАРА/, "the ruled-out place's trips are left out");
    });

    // Nov 4 shape: the agency's post advertised company New Year trips. "Sain bnuu ene shine jiliin
    // ayalal haashaa be" reached the free-text model, which answered "no trip with that special name;
    // which country?", and the customer's "<price> geed bga yum" (the post's price) ended in a
    // staff hand-off. The catalogue holds both answers: the trips leaving over New Year, and the
    // trip sold at exactly that price.
    await context.test("a New Year trip question lists the New Year departures, and the post's price finds its trip", async () => {
      harness.catalog([
        trip("ny", "ЛУМАРА ХОТЫН АЯЛАЛ", ["2098-12-27", "2099-01-02"], { adult_price: 991_000, child_price: 891_000, duration_text: "4 өдөр 3 шөнө" }),
        trip("dec", "ВЭЛМОР ДАЛАЙН ЭРГИЙН АЯЛАЛ", ["2098-12-05"], { adult_price: 1_991_000, child_price: 1_591_000 }),
        trip("spring", "НОРВЕЛ ХОТЫН АЯЛАЛ", ["2098-03-15"])]);
      const modelGuess = { certainty: "none", trips: [], unknown_destination: "шинэ жил", finalReply: "Шинэ жилийн аялал гэсэн тусгай нэртэй аялал байхгүй байна. Аль чиглэл, улс сонирхож байна вэ?" };
      for (const [sender, text] of [["ny-latin", "Sain bnuu ene shine jiliin ayalal haashaa be"], ["ny-cyr", "Шинэ жилийн аяллын мэдээлэл авъя"], ["ny-where", "шинэ жилээр хаашаа явах вэ"]]) {
        const asked = await harness.turn(sender, text, modelGuess);
        const reply = asked.sends.map((send) => send.text).join("\n");
        assert.equal(asked.sends.length, 1, `${text}: one reply`);
        assert.equal(asked.answerModelCalls, 0, `${text}: answered from the catalogue, not the free-text model`);
        assert.match(reply, /Шинэ жилийн үеэр/, `${text}: ${reply}`);
        assert.match(reply, /ЛУМАРА ХОТЫН АЯЛАЛ/, `${text}: the trip leaving over New Year`);
        assert.match(reply, /ВЭЛМОР ДАЛАЙН ЭРГИЙН АЯЛАЛ/, `${text}: the December trip`);
        assert.doesNotMatch(reply, /НОРВЕЛ/, `${text}: a spring trip is not a New Year trip`);
        assert.match(reply, /uudamtravel\.mn/, `${text}: and the website for the rest`);
        assert.doesNotMatch(reply, /тусгай нэртэй|байхгүй байна/, `${text}: never 'no such trip'`);
        assert.equal(asked.leads.length, 0, `${text}: no hand-off`);
      }
      // The price from the post, quoted in chat words: the trip that sells at it, by name.
      for (const [sender, text] of [["ny-latin", "991000 geed bga yum"], ["ny-cyr", "991,000 гээд байгаа юм"], ["price-only", "991000 гэсэн үнэтэй аялал байна лээ"]]) {
        const quoted = await harness.turn(sender, text, { certainty: "none", finalReply: "REFER" });
        const reply = quoted.sends.map((send) => send.text).join("\n");
        assert.equal(quoted.sends.length, 1, `${text}: one reply`);
        assert.match(reply, /991,000₮ үнэтэй тохирох аяллууд/, `${text}: ${reply}`);
        assert.match(reply, /ЛУМАРА ХОТЫН АЯЛАЛ — Том хүн/, `${text}: the trip at that price`);
        assert.doesNotMatch(reply, /ВЭЛМОР|НОРВЕЛ/, `${text}: only the trip at that price`);
        assert.equal(quoted.answerModelCalls, 0, `${text}: no free-text model`);
        assert.equal(quoted.leads.length, 0, `${text}: no hand-off`);
      }
      // A quoted price no trip sells at is still not guessed: the conversation goes on as before.
      const none = await harness.turn("ny-latin", "1234567 geed bga yum", { certainty: "none", finalReply: "REFER" });
      assert.doesNotMatch(none.sends.map((send) => send.text).join("\n"), /ЛУМАРА|ВЭЛМОР|НОРВЕЛ/, "no near-price trip is offered");
      // No trip leaves over New Year: say so, point to the website, and show the nearest departures.
      harness.catalog([trip("spring", "НОРВЕЛ ХОТЫН АЯЛАЛ", ["2098-03-15"]), trip("sea", "ВЭЛМОР ДАЛАЙН ЭРГИЙН АЯЛАЛ", ["2098-04-10"])]);
      const empty = await harness.turn("ny-empty", "шинэ жилийн аялал байна уу", modelGuess);
      const emptyReply = empty.sends.map((send) => send.text).join("\n");
      assert.equal(empty.sends.length, 1);
      assert.match(emptyReply, /Шинэ жилийн үеэр[^\n]*одоогоор[^\n]*алга/, emptyReply);
      assert.match(emptyReply, /uudamtravel\.mn/);
      assert.match(emptyReply, /Ойрын гарах аяллууд/);
      assert.match(emptyReply, /НОРВЕЛ ХОТЫН АЯЛАЛ/);
      assert.equal(empty.answerModelCalls, 0);
    });

    // Live 2026-11-04: "<border town>-аас Улаанбаатар орох хүн авах боломж байдаг уу" (a one-way
    // pick-up the agency does not sell) was answered with the flight trip whose TITLE names the
    // home city, listing the days that touch Ulaanbaatar as if that were the answer. Every trip
    // starts and ends in the home city, so the word names no trip; with no data, the bot is silent
    // and staff get the lead.
    await context.test("the home city in a trip's title never picks that trip; an unanswerable ask is silence plus a lead", async () => {
      harness.catalog([
        trip("fly", "СОЛМАРА – Улаанбаатар - Велтана нислэг", ["2098-03-07", "2098-03-14"], { duration_text: "8 өдөр 7 шөнө", extra: {
          customer_visible: true, age_rules: { adult: "12+ нас", child: "2-11 нас", infant: "0-23 сар" },
          itinerary_days: [{ day: 1, title: "Улаанбаатар – Велтана", description: "Улаанбаатараас Велтана хот руу шууд ниснэ." },
            { day: 8, title: "Велтана – Улаанбаатар", description: "Улаанбаатарт буцаж ирнэ." }],
        } }),
        trip("land", "ДОРМАН ХОТЫН АЯЛАЛ", ["2098-03-10"], { extra: { customer_visible: true, aliases: ["Дорман"] } }),
      ]);
      await harness.turn("pickup", "Сайн байна уу");
      const asked = await harness.turn("pickup", "Кервада Тальмараас Улаанбаатар орох хүн авах боломж байдаг уу", { certainty: "none" });
      assert.deepEqual(asked.sends.map((send) => send.text), [], "no trip answers a question about a service we do not sell");
      assert.equal(asked.leads.length, 1, "staff get the question");
      assert.equal(asked.leads[0].kind, "handoff");
      // The home city still works as a word inside a question about the trip on screen.
      const card = await harness.turn("ub-word", "Солмара Велтана нислэг", { tripId: "fly", certainty: "one" });
      assert.match(card.sends[0]?.text || "", /СОЛМАРА – Улаанбаатар - Велтана нислэг/);
    });

    // Live 2026-11-04: after a trip list, "цагаан сарын үейр ямар аялалууд байна" got the
    // catalogue's soonest (November) departures: the holiday was not read as a time at all.
    // A holiday is a date window (holidayCalendar.ts). This calendar year (2098) has no published
    // Tsagaan Sar days, so it must not be guessed: silence and a staff lead. Naadam is fixed
    // (11–15 July): the trips leaving around it, and with a place named, only that place's.
    await context.test("a holiday is a time: its own departures, never the soonest ones, never a guessed date", async () => {
      harness.catalog([
        trip("soon", "ЛУМАРА ХОТЫН АЯЛАЛ", ["2098-02-10", "2098-02-17"], { extra: { customer_visible: true, aliases: ["Лумара"] } }),
        trip("summer", "ДОРМАН ХОТЫН АЯЛАЛ", ["2098-03-01", "2098-07-09"], { extra: { customer_visible: true, aliases: ["Дорман"] } }),
        trip("sea", "ВЭЛМОР ДАЛАЙН ЭРГИЙН АЯЛАЛ", ["2098-07-12"], { extra: { customer_visible: true, aliases: ["Вэлмор"] } }),
      ]);
      await harness.turn("holiday", "Нислэг газар хосолсон", listAsk);
      const lunar = await harness.turn("holiday", "цагаан сарын үейр ямар аялалууд байна", { certainty: "none" });
      assert.deepEqual(lunar.sends.map((send) => send.text), [], "unknown holiday days are never guessed or replaced by the soonest trips");
      assert.equal(lunar.leads.length, 1, "staff get the question");
      const naadam = await harness.turn("naadam", "Наадмын үеэр ямар аялалууд байна", { certainty: "none" });
      const listed = naadam.sends.map((send) => send.text).join("\n");
      assert.match(listed, /Наадмын үеэр \(7 сарын 11–15\)/, listed);
      assert.match(listed, /ДОРМАН ХОТЫН АЯЛАЛ/);
      assert.match(listed, /ВЭЛМОР ДАЛАЙН ЭРГИЙН АЯЛАЛ/);
      assert.doesNotMatch(listed, /ЛУМАРА|3\/1|2\/10/, "no departure outside the holiday");
      assert.equal(naadam.answerModelCalls, 0, "answered from the catalogue");
      const place = await harness.turn("naadam-place", "Наадмаар Дорман явж болох уу", { certainty: "none" });
      const placed = place.sends.map((send) => send.text).join("\n");
      assert.match(placed, /ДОРМАН ХОТЫН АЯЛАЛ/, placed);
      assert.match(placed, /7\/9|7 сарын 9/);
      assert.doesNotMatch(placed, /3\/1|3 сарын 1(?!\d)|ВЭЛМОР/, "only the named place, only around the holiday");
      // Live replay 2026-11-04: under a trip list, the holiday's words read as an unknown place
      // and both questions got silence. "Which trips" at the holiday asks the whole catalogue;
      // a bare holiday follow-up asks about the trips on screen.
      await harness.turn("naadam-list", "Нислэг газар хосолсон", listAsk);
      const underList = await harness.turn("naadam-list", "Наадмын үеэр ямар аялалууд байна", { certainty: "none" });
      const underListText = underList.sends.map((send) => send.text).join("\n");
      assert.match(underListText, /Наадмын үеэр \(7 сарын 11–15\)/, underListText);
      assert.match(underListText, /ДОРМАН ХОТЫН АЯЛАЛ[\s\S]*ВЭЛМОР ДАЛАЙН ЭРГИЙН АЯЛАЛ|ВЭЛМОР ДАЛАЙН ЭРГИЙН АЯЛАЛ[\s\S]*ДОРМАН ХОТЫН АЯЛАЛ/);
      await harness.turn("naadam-followup", "Дорман", { tripId: "summer", certainty: "one" });
      const followup = await harness.turn("naadam-followup", "Наадмаар гарах уу", { certainty: "none" });
      const followupText = followup.sends.map((send) => send.text).join("\n");
      assert.ok(followup.sends.length > 0, "a holiday follow-up about the trip on screen is answered");
      assert.match(followupText, /7\/9|7 сарын 9/, followupText);
      assert.doesNotMatch(followupText, /ВЭЛМОР/, "about the trip on screen only");
      // The holiday greeting is not a trip question.
      const greeting = await harness.turn("greet", "Сар шинэдээ сайхан шинэлж байна уу", { certainty: "none" });
      assert.doesNotMatch(greeting.sends.map((send) => send.text).join("\n"), /ЛУМАРА|ДОРМАН|ВЭЛМОР/);
    });
  } finally {
    await harness.close();
  }
});

test("the rules behind those answers", () => {
  const now = new Date("2098-10-15T04:00:00Z");
  for (const [text, start] of [["Хүүхдийн амралт 11.1-с эхлэх гээд бдаг...яах вэ", "2098-11-01"], ["11/14-с хойш", "2098-11-14"], ["11 сарын 1-ээс хойш гарах уу", "2098-11-01"]]) {
    const scope = requestedDepartureScope(text, now);
    assert.equal(scope?.kind, "range", text);
    if (scope?.kind === "range") assert.equal(scope.startYmd, start, text);
  }
  assert.equal(buildTripRequest("11 сарын 1-ээс хойш гарах уу", [], undefined, now).date, null, "a start date is not that single day");

  const previous = { tripId: "t", date: null, hotel: null, package: null, passengers: [{ kind: "adult" as const, count: 2 }, { kind: "child" as const, count: 1 }] };
  assert.deepEqual(mergeTripSelection("t", buildTripRequest("Одоо 3 том хүн", [], undefined, now), previous).passengers,
    [{ kind: "child", count: 1 }, { kind: "adult", count: 3 }]);
  assert.deepEqual(mergeTripSelection("t", buildTripRequest("зөвхөн 3 том хүн", [], undefined, now), previous).passengers, [{ kind: "adult", count: 3 }]);
  const minors = { ...previous, passengers: [{ kind: "child" as const, count: 2 }] };
  assert.deepEqual(mergeTripSelection("t", buildTripRequest("2 том хүн", [], undefined, now), minors).passengers,
    [{ kind: "child", count: 2 }, { kind: "adult", count: 2 }]);

  assert.equal(adultCountAnswer([{ role: "assistant", text: `Хүүхэд: 1₮\n\n${ADULT_COUNT_QUESTION}` }], "2"), "2 том хүн");
  assert.equal(adultCountAnswer([{ role: "assistant", text: "Аль аялал вэ?" }], "2"), null);

  assert.deepEqual(withoutNegatedTrips("Лумара биш, далайтай нь", (word) => word === "Лумара"), { text: "далайтай нь", negated: ["Лумара"] });
  assert.deepEqual(withoutNegatedTrips("энэ биш", () => false), { text: "энэ биш", negated: [] });
  assert.deepEqual(withoutNegatedTrips("Лумара биш", () => true), { text: "Лумара биш", negated: [] }, "nothing else asked: kept as written");

  const context = conversationLeadContext({ history: [{ role: "user", text: "Лумара" }, { role: "assistant", text: "…" }, { role: "user", text: "90000000" }],
    currentText: "Захиалга өгье", selectedTrip: trip("x", "ЛУМАРА ХОТЫН АЯЛАЛ", []) });
  assert.equal(context, "Сонгосон аялал: ЛУМАРА ХОТЫН АЯЛАЛ\nСүүлийн мессежүүд: Лумара / Захиалга өгье");
});
