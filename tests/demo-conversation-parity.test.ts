import assert from "node:assert/strict";
import test from "node:test";
import { conversationGateHarness, type FixtureTrip } from "./helpers/conversationGateHarness";

function fixture(priceKnown = true, visaKnown = false): FixtureTrip {
  return { id: "parity-levnir", route_name: "ЛЭВНИР АЯЛАЛ", operator_name: "Fixture agency", category: "Аялал", status: "active",
    currency: "MNT", adult_price: priceKnown ? 1_968_000 : null, child_price: priceKnown ? 1_624_000 : null,
    infant_price: null, duration_text: "5 өдөр", departure_dates: ["2098-07-19"], seats_total: 20, seats_left: 10,
    hotel: "Мерлин буудал", has_food: null, photo_urls: [], notes: "", source_description: "",
    extra: { included_items: ["Өглөөний цай"], excluded_items: ["Даатгал"],
      age_rules: { adult: "12+ нас", child: "2-11 нас", infant: "0-23 сар" },
      ...(visaKnown ? { booking_terms: { visa: "Виз шаардахгүй" } } : {}) },
  } as unknown as FixtureTrip;
}

test("actual demo and signed webhook deliver identical structured coverage outcomes", async context => {
  const harness = await conversationGateHarness(context);
  try {
    await context.test("an explicitly excluded item is an answer in both channels", async () => {
      const trip = fixture(); harness.catalog([trip]);
      const text = `${trip.route_name} даатгал үнэд багтсан уу`;
      const webhook = await harness.turn("parity-webhook-excluded", text, { tripId: trip.id, place: trip.route_name, topics: ["includes"] });
      const demo = await harness.demoTurn("parity-demo-excluded", text, { tripId: trip.id, place: trip.route_name, topics: ["includes"] });
      assert.equal(webhook.status, 200); assert.equal(demo.status, 200);
      assert.equal(webhook.sends.length, 1); assert.equal(webhook.leads.length, 0);
      assert.equal(demo.body.handoff, undefined, "known negative facts must survive the demo presentation boundary");
      assert.equal(demo.body.reply, webhook.sends[0].text);
      assert.match(String(demo.body.reply), /Үнэд багтаагүй:[\s\S]*Даатгал/);
      assert.ok(demo.history.some(row => row.role === "assistant" && row.text === demo.body.reply), "demo persists its actual delivered known answer");
    });
    await context.test("known fare plus unknown visa is a handoff rather than a partial answer", async () => {
      const trip = fixture(); harness.catalog([trip]);
      const text = `${trip.route_name} үнэ хэд вэ визний нөхцөл ямар вэ`;
      const webhook = await harness.turn("parity-webhook-missing-visa", text, { tripId: trip.id, place: trip.route_name, topics: ["price", "booking_terms"] });
      const demo = await harness.demoTurn("parity-demo-missing-visa", text, { tripId: trip.id, place: trip.route_name, topics: ["price", "booking_terms"] });
      assert.equal(webhook.status, 200); assert.equal(demo.status, 200);
      assert.deepEqual(webhook.sends, []); assert.ok(webhook.leads.some(lead => lead.kind === "handoff"));
      assert.equal(demo.body.handoff, true);
      assert.doesNotMatch(String(demo.body.reply), /1,968,000|Виз шаардахгүй/);
    });
    await context.test("known visa cannot hide a missing requested fare", async () => {
      const trip = fixture(false, true); harness.catalog([trip]);
      const text = `${trip.route_name} үнэ хэд вэ визний нөхцөл ямар вэ`;
      const webhook = await harness.turn("parity-webhook-missing-fare", text, { tripId: trip.id, place: trip.route_name, topics: ["price", "booking_terms"] });
      const demo = await harness.demoTurn("parity-demo-missing-fare", text, { tripId: trip.id, place: trip.route_name, topics: ["price", "booking_terms"] });
      assert.equal(webhook.status, 200); assert.equal(demo.status, 200);
      assert.deepEqual(webhook.sends, []); assert.ok(webhook.leads.some(lead => lead.kind === "handoff"));
      assert.equal(demo.body.handoff, true);
      assert.doesNotMatch(String(demo.body.reply), /1,968,000|Виз шаардахгүй/);
    });
    await context.test("a fully known composite delivers the same complete answer", async () => {
      const trip = fixture(); harness.catalog([trip]);
      const text = `${trip.route_name} үнэ хэд вэ хэдэн хоног өглөөний цай орсон уу`;
      const webhook = await harness.turn("parity-webhook-known-composite", text, { tripId: trip.id, place: trip.route_name, topics: ["price", "duration", "includes"] });
      const demo = await harness.demoTurn("parity-demo-known-composite", text, { tripId: trip.id, place: trip.route_name, topics: ["price", "duration", "includes"] });
      assert.equal(webhook.status, 200); assert.equal(demo.status, 200);
      assert.equal(webhook.sends.length, 1); assert.equal(webhook.leads.length, 0);
      assert.equal(demo.body.handoff, undefined); assert.equal(demo.body.reply, webhook.sends[0].text);
      assert.match(String(demo.body.reply), /1,968,000/); assert.match(String(demo.body.reply), /5 өдөр/); assert.match(String(demo.body.reply), /Өглөөний цай/);
    });
    await context.test("a broad hotel topic cannot hide an unsupported amenity subquestion", async () => {
      const trip = fixture(); harness.catalog([trip]);
      const text = `${trip.route_name} үнэ хэд вэ ${trip.hotel} Wi-Fi байна уу`;
      // Simulate an interpreter that omitted the specific amenity requirement.
      const model = { tripId: trip.id, place: trip.route_name, topics: ["price", "hotel"] };
      const webhook = await harness.turn("parity-webhook-amenity", text, model);
      const demo = await harness.demoTurn("parity-demo-amenity", text, model);
      assert.equal(webhook.status, 200); assert.equal(demo.status, 200);
      assert.deepEqual(webhook.sends, []);
      assert.ok(webhook.leads.some(lead => lead.kind === "handoff" && lead.context.includes("hotel.connectivity")));
      assert.equal(demo.body.handoff, true);
    });
    await context.test("requesting full details preserves missing inclusion requirements in both channels", async () => {
      const trip = fixture();
      trip.extra = { ...trip.extra, included_items: ["Хоол"], excluded_items: [] };
      harness.catalog([trip]);
      for (const [index, detail] of ["", " дэлгэрэнгүй", " бүх мэдээллийг"].entries()) {
        const text = `${trip.route_name} хоол болон даатгал үнэд багтсан уу${detail}`;
        const model = { tripId: trip.id, place: trip.route_name, topics: ["includes"] };
        const webhook = await harness.turn(`parity-webhook-full-includes-${index}`, text, model);
        const demo = await harness.demoTurn(`parity-demo-full-includes-${index}`, text, model);
        assert.equal(webhook.status, 200); assert.equal(demo.status, 200);
        assert.deepEqual(webhook.sends, [], "unknown insurance cannot be covered by a known food answer");
        assert.ok(webhook.leads.some(lead => lead.kind === "handoff" && lead.context.includes("includes.Даатгал")));
        assert.equal(demo.body.handoff, true);
      }
    });
    await context.test("full detail keeps supported booking terms answerable without requiring unasked terms", async () => {
      const trip = fixture(true, true); harness.catalog([trip]);
      const text = `${trip.route_name} визний нөхцөл дэлгэрэнгүй`;
      const model = { tripId: trip.id, place: trip.route_name, topics: ["booking_terms"] };
      const webhook = await harness.turn("parity-webhook-full-visa", text, model);
      const demo = await harness.demoTurn("parity-demo-full-visa", text, model);
      assert.equal(webhook.status, 200); assert.equal(demo.status, 200);
      assert.equal(webhook.sends.length, 1); assert.equal(webhook.leads.length, 0);
      assert.equal(demo.body.handoff, undefined);
      assert.equal(demo.body.reply, webhook.sends[0].text);
      assert.match(String(demo.body.reply), /Виз шаардахгүй/);
    });
    await context.test("a full fare card cannot replace an unknown requested child fare with an adult fare", async () => {
      const trip = fixture();
      trip.child_price = null;
      harness.catalog([trip]);
      for (const [index, question] of ["хүүхдийн үнэ дэлгэрэнгүй", "2 том хүн хүүхдийн үнэ дэлгэрэнгүй"].entries()) {
        const text = `${trip.route_name} ${question}`;
        const model = { tripId: trip.id, place: trip.route_name, topics: ["price"] };
        const webhook = await harness.turn(`parity-webhook-full-child-${index}`, text, model);
        const demo = await harness.demoTurn(`parity-demo-full-child-${index}`, text, model);
        assert.equal(webhook.status, 200); assert.equal(demo.status, 200);
        assert.deepEqual(webhook.sends, []);
        assert.ok(webhook.leads.some(lead => lead.kind === "handoff"));
        assert.equal(demo.body.handoff, true);
      }
    });
  } finally { await harness.close(); }
});
