import assert from "node:assert/strict";
import test from "node:test";
import { conversationGateHarness, type FixtureTrip } from "./helpers/conversationGateHarness";

function fixture(variant: number) {
  const names = variant ? ["ЗЭВРИ ЛУМЭР", "ЗЭВРИ ТЭЛУН", "РЭВНОР"] : ["ВЭЛМОР ЛУМИР", "ВЭЛМОР СЭЛВЭН", "НОРВЕЛ"];
  const hotels = variant ? ["Лэрус", "Мэвин", "Ривол"] : ["Орин", "Тэлис", "Сэврол"];
  const prices = variant ? [2_847_000, 1_736_000, 3_958_000] : [1_731_000, 2_842_000, 3_953_000];
  const trips = names.map((name, index) => ({ id: `v${variant}-t${index}`, route_name: `${name} АЯЛАЛ`, operator_name: "Fixture agency", category: "Аялал",
    adult_price: prices[index], child_price: prices[index] - 200_000, infant_price: null, currency: "MNT", status: "active",
    duration_text: "8 өдөр", departure_dates: [(variant ? ["2098-05-19", "2098-05-24", "2098-06-08"] : ["2098-03-17", "2098-03-22", "2098-04-09"])[index]],
    seats_total: 24, seats_left: 12, has_food: null, hotel: `${hotels[index]} буудал`, photo_urls: [], notes: "", source_description: "",
    extra: { aliases: [names[index]], included_items: ["Өглөөний цай"], customer_visible: true,
      age_rules: { adult: "12+ нас", child: "2-11 нас", infant: "0-23 сар" } },
  } as unknown as FixtureTrip));
  return { trips, catalog: variant ? [trips[2], trips[1], trips[0]] : trips, family: names[0].split(" ")[0] };
}

test("signed webhook conversation gate: catalog facts beat model guesses across turns and held-out catalogs", async context => {
  const harness = await conversationGateHarness(context);
  const metrics = { catalogs: 0, conversations: 0, turns: 0, wrongTrip: 0, wrongPrice: 0, wrongDate: 0, lostHandoff: 0, unknownAnswers: 0, knownAnswerMissing: 0 };
  const check = (condition: boolean, metric: keyof typeof metrics, message: string) => { if (!condition) metrics[metric]++; assert.ok(condition, message); };
  const expectedReply = (result: { sends: Array<{ text: string }> }) => {
    check(result.sends.length === 1, "knownAnswerMissing", "one complete grounded answer is required when fixture facts cover the request");
    return result.sends[0].text;
  };
  const quote = (reply: string, trip: FixtureTrip, others: FixtureTrip[]) => {
    const rightTrip = reply.includes(trip.route_name) && !others.some(other => reply.includes(other.route_name));
    const rightPrice = reply.includes(trip.adult_price!.toLocaleString("en-US")) && !others.some(other => reply.includes(other.adult_price!.toLocaleString("en-US")));
    if (!rightTrip) metrics.wrongTrip++;
    if (!rightPrice) metrics.wrongPrice++;
    assert.ok(rightTrip, `answer must identify the customer-evidenced trip: ${reply}`);
    assert.ok(rightPrice, `quoted fare must follow fixture data, including counterfactual changes: ${reply}`);
  };
  try {
    for (const variant of [0, 1]) {
      const { trips, catalog, family } = fixture(variant);
      const [first, sibling, other] = trips;
      harness.catalog(catalog); metrics.catalogs++;
      const sender = (name: string) => `conversation-${variant}-${name}`;
      await context.test(`catalog ${variant}: explicit trip survives valid but contradictory model identity`, async () => {
        metrics.conversations++; metrics.turns++;
        const result = await harness.turn(sender("identity"), `${first.route_name} үнэ хэд вэ`, { tripId: other.id, place: other.route_name });
        assert.equal(result.status, 200); expectedReply(result);
        assert.ok(result.modelCalls > 0, "the adversarial model boundary must actually execute");
        quote(result.sends[0].text, first, [sibling, other]);
      });
      await context.test(`catalog ${variant}: current name replaces stale selection and follow-up keeps it`, async () => {
        metrics.conversations++;
        const id = sender("switch");
        for (const [index, [trip, hostile]] of ([[first, first], [other, first], [other, first]] as const).entries()) {
          metrics.turns++;
          const text = index === 2 ? "үнэ нь хэд вэ" : `${trip.route_name} үнэ хэд вэ`;
          const result = await harness.turn(id, text, { tripId: hostile.id, place: text.includes(trip.route_name) ? hostile.route_name : null });
          assert.equal(result.status, 200); expectedReply(result);
          quote(result.sends[0].text, trip, trips.filter(candidate => candidate !== trip));
          assert.equal(result.selection?.tripId, trip.id);
        }
        assert.equal(harness.history.filter(row => row.sender_id === id && row.role === "user").length, 3, "all real inbound turns survive across handler invocations");
        assert.equal(harness.history.filter(row => row.sender_id === id && row.role === "assistant").length, 3, "accepted answers persist beside each inbound turn");
      });
      await context.test(`catalog ${variant}: generic greeting and price cannot identify a catalog trip`, async () => {
        metrics.conversations++; metrics.turns++;
        const result = await harness.turn(sender("generic"), "Сайн байна уу үнэ хэд вэ", { tripId: other.id, place: null,
          finalReply: `• ${other.route_name} — ${other.adult_price!.toLocaleString("en-US")}₮` });
        assert.equal(result.status, 200);
        check(!result.sends.some(send => trips.some(trip => send.text.includes(trip.adult_price!.toLocaleString("en-US")))), "unknownAnswers", "a generic greeting/price must not acquire a fare from model choice");
      });
      await context.test(`catalog ${variant}: model-produced single bullet needs customer trip evidence`, async () => {
        metrics.conversations++; metrics.turns++;
        const result = await harness.turn(sender("model-bullet"), "Надад энгийнээр тайлбарлаад өгөөч", { intent: "other", topics: [],
          finalReply: `• ${other.route_name} — ${other.adult_price!.toLocaleString("en-US")}₮` });
        assert.equal(result.status, 200);
        assert.ok(result.answerModelCalls > 0, "the final-answer provider must run for this exit-boundary regression");
        check(result.sends.length === 0, "unknownAnswers", "one bullet still cannot authorize an arbitrary trip");
        check(result.leads.some(lead => lead.kind === "handoff"), "lostHandoff", "rejected model answer must reach staff durably");
      });
      await context.test(`catalog ${variant}: a model-produced list cannot widen an explicit trip`, async () => {
        metrics.conversations++; metrics.turns += 2;
        const id = sender("model-list");
        const known = await harness.turn(id, `${first.route_name} үнэ хэд вэ`, { tripId: first.id, place: first.route_name });
        quote(expectedReply(known), first, [sibling, other]);
        const result = await harness.turn(id, "Энгийнээр тайлбарлаад өгөөч", { tripId: first.id,
          place: null, topics: [], finalReply: `• ${first.route_name}\n• ${other.route_name}` });
        assert.equal(result.status, 200);
        assert.ok(result.answerModelCalls > 0, "the adversarial final-answer list must actually be produced");
        check(result.sends.length === 0, "unknownAnswers", "multiple bullets cannot introduce a trip outside current customer scope");
        check(result.leads.some(lead => lead.kind === "handoff"), "lostHandoff", "wrong-scope model prose must leave a durable handoff");
      });
      await context.test(`catalog ${variant}: offered sibling list owns the numeric follow-up`, async () => {
        metrics.conversations++; metrics.turns++;
        const id = sender("offered");
        const offered = await harness.turn(id, `${family} аялал үнэ хэд вэ`, { tripId: first.id, place: family, certainty: "several" });
        assert.equal(offered.status, 200); expectedReply(offered);
        const text = offered.sends[0].text;
        assert.ok(text.includes(first.route_name) && text.includes(sibling.route_name), "shared place must offer both matching trips");
        const ordered = [first, sibling].sort((a, b) => text.indexOf(a.route_name) - text.indexOf(b.route_name));
        metrics.turns++;
        const chosen = await harness.turn(id, "2", { tripId: other.id, place: other.route_name });
        assert.equal(chosen.status, 200); expectedReply(chosen);
        quote(chosen.sends[0].text, ordered[1], trips.filter(trip => trip !== ordered[1]));
      });
      await context.test(`catalog ${variant}: a fabricated model date cannot replace the written date`, async () => {
        metrics.conversations++; metrics.turns++;
        const writtenDate = first.departure_dates[0];
        const result = await harness.turn(sender("date"), `${first.route_name} ${writtenDate} үнэ хэд вэ`, { tripId: first.id, place: first.route_name, date: sibling.departure_dates[0] });
        assert.equal(result.status, 200); expectedReply(result);
        quote(result.sends[0].text, first, [sibling, other]);
        check(result.selection?.date === writtenDate, "wrongDate", "selected date follows explicit current evidence");
        const words = (date: string) => { const [, month, day] = date.split("-"); return `${Number(month)} сарын ${Number(day)}`; };
        check(result.sends[0].text.includes(words(writtenDate)) && !result.sends[0].text.includes(words(sibling.departure_dates[0])),
          "wrongDate", "delivered date must follow the customer's date, not the model's other valid catalog date");
      });
      await context.test(`catalog ${variant}: model hotel/party guesses cannot create customer requirements`, async () => {
        metrics.conversations++; metrics.turns++;
        const result = await harness.turn(sender("offer"), `${first.route_name} үнэ хэд вэ`, { tripId: first.id, place: first.route_name,
          hotel: sibling.hotel!, date: first.departure_dates[0], passengers: [{ kind: "adult", count: 9 }, { kind: "child", count: 7, age: 5 }] });
        assert.equal(result.status, 200); expectedReply(result);
        quote(result.sends[0].text, first, [sibling, other]);
        assert.deepEqual(result.selection?.passengers, [], "invented party must not persist into follow-up totals");
        assert.notEqual(result.selection?.hotel, sibling.hotel, "unspoken hotel cannot replace the offer");
        check(result.selection?.date === null, "wrongDate", "a model-only departure date cannot persist as a customer choice");
      });
      await context.test(`catalog ${variant}: written party and hotel survive contradictory valid model fields`, async () => {
        metrics.conversations++; metrics.turns++;
        const result = await harness.turn(sender("party"), `${first.route_name} ${first.hotel} 2 том хүн 1 хүүхэд 6 настай нийт үнэ хэд вэ`, {
          tripId: first.id, place: first.route_name, hotel: sibling.hotel!, passengers: [{ kind: "adult", count: 9 }],
        });
        assert.equal(result.status, 200); expectedReply(result);
        quote(result.sends[0].text, first, [sibling, other]);
        assert.equal(result.selection?.hotel, first.hotel);
        assert.deepEqual(result.selection?.passengers.map(passenger => ({ kind: passenger.kind, count: passenger.count,
          age: passenger.age ?? null, ageUnit: passenger.ageUnit || "year" })), [
          { kind: "adult", count: 2, age: null, ageUnit: "year" }, { kind: "child", count: 1, age: 6, ageUnit: "year" },
        ]);
        check(result.sends[0].text.includes((first.adult_price! * 2 + first.child_price!).toLocaleString("en-US")), "wrongPrice", "total must use the party stated by the customer");
      });
      await context.test(`catalog ${variant}: known and unknown topics produce silence plus durable staff lead`, async () => {
        metrics.conversations++; metrics.turns++;
        const id = sender("composite");
        const result = await harness.turn(id, `${first.route_name} үнэ хэд вэ визний нөхцөл ямар вэ`, { tripId: first.id, place: first.route_name, topics: ["price", "booking_terms"] });
        assert.equal(result.status, 200);
        check(result.sends.length === 0, "unknownAnswers", "a known price must not hide the unanswered visa requirement");
        check(result.leads.some(lead => lead.sender_id === id && lead.kind === "handoff"), "lostHandoff", "silent unknown answer must leave a durable lead");
      });
      await context.test(`catalog ${variant}: all known composite topics are answered together`, async () => {
        metrics.conversations++; metrics.turns++;
        const result = await harness.turn(sender("known-composite"), `${first.route_name} үнэ хэд вэ хэдэн хоног өглөөний цай орсон уу`, {
          tripId: first.id, place: first.route_name, topics: ["price", "duration", "includes"],
        });
        assert.equal(result.status, 200); expectedReply(result);
        quote(result.sends[0].text, first, [sibling, other]);
        assert.match(result.sends[0].text, /8\s*(?:өдөр|хоног)/);
        assert.match(result.sends[0].text, /Өглөөний цай/);
        assert.equal(result.leads.length, 0, "complete known facts do not create a no-data handoff");
      });
    }
  } finally {
    console.log(`CONVERSATION_GATE_METRICS ${JSON.stringify(metrics)}`);
    await harness.close();
  }
});
