import assert from "node:assert/strict";
import test from "node:test";
import { conversationGateHarness, type FixtureTrip } from "./helpers/conversationGateHarness";

/**
 * The need gate's open turns of 2026-11-11 (understanding-scenarios EXB-04, EXB-05, POL-11, SVC-04, CASE-9.p2 and the
 * live greeting-led thank-you), replayed end to end through the signed webhook on an INVENTED catalogue with a mocked
 * model. Each journey keeps the SHAPE of the failing conversation and its word family (Cyrillic, Latin, typos):
 *
 *   - a booking already made ("Миний захиалсан аялал хэзээ гарах вэ", "zahialgaa tsutslah uu") got the booking
 *     collector's "Утасны дугаараа бичнэ үү.";
 *   - a bare discount question with no trip in view got "Аль аялал вэ?" (the owner has no discount policy);
 *   - a visa question naming a place with several trips got a list of those trips;
 *   - a group of 20 wanting a straight route ("shuud ..., busad hotiig uzehgui") got the package fare card;
 *   - a long thank-you that opened with "Сайн байна уу." got silence and a staff lead.
 */
const trip = (id: string, name: string, dates: string[], fares: [number, number, number | null], extra: Record<string, unknown> = {}) => ({
  id, route_name: name, operator_name: "Fixture agency", category: "Аялал", adult_price: fares[0], child_price: fares[1], infant_price: fares[2],
  currency: "MNT", status: "active", duration_text: "9 өдөр 8 шөнө", departure_dates: dates, seats_total: 20, seats_left: 10,
  has_food: null, hotel: "", photo_urls: [], notes: "", source_description: "",
  extra: { customer_visible: true, age_rules: { adult: "12+ нас", child: "2-11 нас", infant: "0-23 сар" }, ...extra },
} as unknown as FixtureTrip);

const VISA_TEXT = "Калдор руу 30 хоног хүртэл визгүй зорчино (fixture)";
const catalog = [
  trip("kaldor", "КАЛДОР ХОТЫН АЯЛАЛ", ["2098-03-14", "2098-03-28"], [1_691_000, 1_291_000, 381_000], { aliases: ["Калдор"], booking_terms: { visa: VISA_TEXT } }),
  trip("velm-a", "ВЕЛМАРА АЯЛАЛ — ОРСИ, ДУНЕ", ["2098-03-10", "2098-03-24"], [5_091_000, 4_591_000, 591_000], { aliases: ["Велмара"] }),
  trip("velm-b", "ВЕЛМАРА — ТОРМЕЛ АЯЛАЛ", ["2098-03-12", "2098-03-26"], [5_991_000, 5_491_000, 591_000], { aliases: ["Велмара"] }),
  trip("tergan", "ШЭНБАР – ХОЛМИН – ТЭРГАН 8 ШӨНӨ 9 ӨДӨР", ["2098-03-11", "2098-03-18"], [4_091_000, 3_791_000, 591_000], { aliases: ["Тэрган", "Tergan"] }),
];
const one = (tripId: string, extra: Record<string, unknown> = {}) => ({ certainty: "one", tripId, ...extra });
const PHONE_ASK = /Утасны дугаараа/;
const CATALOGUE_ANSWER = /[Кк]аталог/;

test("need gate, 2026-11-11 open turns: booked trips, discounts, visas, custom group routes, greeting-led thanks", async (context) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(catalog);
  const say = async (sender: string, text: string, model: Record<string, unknown> = {}) => {
    const result = await harness.turn(sender, text, model);
    return { ...result, text: result.sends.map((send) => send.text).join("\n") };
  };
  const leadOf = (sender: string) => harness.leads.find((lead) => lead.sender_id === sender);
  try {
    // ── EXB-04, EXB-05: a booking the customer already made ───────────────────────────────────────────────
    await context.test("a question about a booking already made is never the booking collector: silence and a typed lead", async () => {
      const asks = [
        "Миний захиалсан аялал хэзээ гарах вэ", "bid zahialsan ayalaa hezee garah ve", "minii zahialsan aylal hezee yavah ve",
        "zahialgaa tsutslah uu", "zakhialgaa tsuclax bolomjtoi yu", "zahialgaa tsutsalj boloh uu",
      ];
      for (const [index, text] of asks.entries()) {
        const sender = `exb-${index}`;
        const reply = await say(sender, text);
        assert.deepEqual(reply.sends, [], `${text}: not 'Утасны дугаараа бичнэ үү.'`);
        assert.equal(reply.modelCalls, 0, text);
        assert.ok(leadOf(sender)?.context.startsWith("[need:existing_booking]"), `${text}: ${leadOf(sender)?.context}`);
      }
      const { isBookingIntent } = await import("../src/lib/webhookMedia");
      for (const text of asks) assert.equal(isBookingIntent(text), false, `${text}: the collector refuses it`);
      for (const text of ["zahialgaa hiie", "Захиалъя", "Калдор аялал захиалмаар байна"]) assert.equal(isBookingIntent(text), true, `${text}: still a booking request`);
    });

    await context.test("a customer with a booking lead asking about their booked trip gets the lead's own status, not a phone ask", async () => {
      // While the bot's own booking pause holds, the paused-customer branch answers (control, unchanged).
      await say("exb-booked", "Калдор хотын аялал", one("kaldor"));
      assert.match((await say("exb-booked", "Захиалга өгье")).text, PHONE_ASK, "a real booking request still starts the collector");
      const phone = await say("exb-booked", "90000000");
      assert.equal(phone.leads[0]?.kind, "booking");
      const after = await say("exb-booked", "Миний захиалсан аялал хэзээ гарах вэ");
      assert.equal(after.sends.length, 1);
      assert.match(after.text, /^Таны захиалгын хүсэлт бүртгэгдсэн\.\nАялал: КАЛДОР ХОТЫН АЯЛАЛ/);
      assert.doesNotMatch(after.text, PHONE_ASK);
      assert.equal(after.modelCalls, 0);
      assert.match(leadOf("exb-booked")!.context, /Миний захиалсан аялал хэзээ гарах вэ/, "staff read the question on the lead");
      // After a consultant hands the chat back the pause is gone: the need gate answers from the same lead.
      harness.resume("exb-booked");
      const released = await say("exb-booked", "minii zahialsan aylal hezee garah ve");
      assert.equal(released.sends.length, 1, released.text);
      // The same status was just sent, so the lead's flow says "nothing new" (bookedFollowup.ts NO_NEWS_LINE).
      assert.equal(released.text, "Шинэ мэдээлэл алга байна — аяллын зөвлөх тантай холбогдоно. Асуултыг тань дамжууллаа.");
      assert.doesNotMatch(released.text, PHONE_ASK);
      assert.equal(released.modelCalls, 0);
    });

    // ── POL-11: a discount question with no trip in view and no owner discount data ─────────────────────────
    await context.test("a bare discount question with no trip in view is silence and a typed lead, never 'Аль аялал вэ?' or an invented discount", async () => {
      const invents = { intent: "other", certainty: "none", topics: ["discount"], finalReply: "Тийм, өвлийн улиралд 15% хөнгөлөлт байдаг." };
      for (const [index, text] of ["Хөнгөлөлт байдаг уу", "hymdral bga yu", "uramshuulal bga uu", "hungulult baidag uu"].entries()) {
        const sender = `pol-${index}`;
        const reply = await say(sender, text, invents);
        assert.deepEqual(reply.sends, [], `${text}: ${reply.text}`);
        assert.equal(reply.modelCalls, 0, text);
        assert.ok(leadOf(sender)?.context.startsWith("[need:commercial_policy]"), `${text}: ${leadOf(sender)?.context}`);
      }
      // Under a trip card the question is that trip's discount: the existing data path answers honestly.
      await say("pol-trip", "Калдор хотын аялал", one("kaldor"));
      const underTrip = await say("pol-trip", "Хөнгөлөлт байдаг уу", one("kaldor", { topics: ["discount"] }));
      assert.equal(underTrip.sends.length, 1, "the trip's own discount path answers");
      assert.doesNotMatch(underTrip.text, /15%/);
      assert.ok(!harness.leads.some((lead) => lead.sender_id === "pol-trip" && lead.context.startsWith("[need:")), "the gate did not claim it");
    });

    // ── SVC-04: a visa question ───────────────────────────────────────────────────────────────────────────
    await context.test("a visa or passport question that names no single trip is silence and a [need:policy] lead, never a trip list", async () => {
      const asks: Array<[string, Record<string, unknown>]> = [
        ["Велмара виз хэрэгтэй юу", { certainty: "several", trips: ["T2", "T3"] }],
        ["velmara viz heregtei yu", { certainty: "several", trips: ["T2", "T3"] }],
        ["viz heregtei yu", {}],
        ["Паспорт хэрэгтэй юу", {}],
        ["Аяллын даатгал хийлгэх шаардлагатай юу", {}],
      ];
      for (const [index, [text, model]] of asks.entries()) {
        const sender = `svc-${index}`;
        const reply = await say(sender, text, model);
        assert.deepEqual(reply.sends, [], `${text}: ${reply.text}`);
        assert.equal(reply.modelCalls, 0, text);
        assert.ok(leadOf(sender)?.context.startsWith("[need:policy]"), `${text}: ${leadOf(sender)?.context}`);
      }
    });

    await context.test("a visa question about one trip that holds visa terms is answered from them", async () => {
      const reply = await say("svc-data", "Калдор аялалд виз хэрэгтэй юу", one("kaldor", { topics: ["booking_terms"] }));
      assert.equal(reply.sends.length, 1, reply.text);
      assert.ok(reply.text.includes(VISA_TEXT), reply.text);
      assert.ok(!harness.leads.some((lead) => lead.sender_id === "svc-data" && lead.context.startsWith("[need:")), "the gate stepped aside");
    });

    // ── CASE-9.p2: a group of 20 that wants a straight route ──────────────────────────────────────────────
    await context.test("a group of 10+ wanting its own route gets no fare card: the catalogue or silence, and a typed lead with the head count", async () => {
      const asks: Array<[string, number]> = [
        ["tergan ruu 20 hun shuud yavmaar bn, busad hotiig uzehgui", 20],
        ["Тэрган руу 15 хүн шууд явна, өөр хот үзэхгүй", 15],
        ["Тэрган руу 22 хүн зөвхөн Тэрган үзнэ", 22],
        ["tergan ruu 25 hun yavna, holmin shenbar hereggui", 25],
      ];
      for (const [index, [text, size]] of asks.entries()) {
        const sender = `custom-${index}`;
        const reply = await say(sender, text, one("tergan", { topics: ["availability"] }));
        assert.ok(reply.sends.length <= 1, text);
        if (reply.sends.length) assert.match(reply.text, CATALOGUE_ANSWER, text);
        assert.doesNotMatch(reply.text, /₮|ТЭРГАН|Аль гарах өдрөөр/, `${text}: no package card`);
        assert.equal(reply.modelCalls, 0, text);
        assert.match(leadOf(sender)?.context ?? "", new RegExp(`Хүний тоо: ${size}`), text);
      }
      const control = await say("custom-control", "Тэрган хотын аялал үнэ хэд вэ", one("tergan", { topics: ["price"] }));
      assert.match(control.text, /4,091,000₮/, "an ordinary price question keeps its card");
    });

    // ── the live greeting-led thank-you ───────────────────────────────────────────────────────────────────
    await context.test("a long thank-you that opens with a greeting gets the thanks line: no lead, no trip, no model call", async () => {
      const thanks = [
        "Сайн байна уу. Бид саяхан танай компаниар аялаад ирлээ. Хөтөч маш сайн байсан, хөтөлбөрт нэмэх хасах санал хүсэлт болгоныг маань сонсож тусалсанд маш их баярлалаа. Дараа дахин танайхаар аялна.",
        "Sain bainuu. Bid saya aylaad irlee, hutuch mash sain baisan, mash ih bayarlalaa",
      ];
      for (const [index, text] of thanks.entries()) {
        const sender = `greet-thanks-${index}`;
        const reply = await say(sender, text, { intent: "smalltalk", certainty: "none", topics: [] });
        assert.equal(reply.sends.length, 1, text);
        assert.match(reply.text, /^Зүгээр ээ 😊/, text);
        assert.equal(reply.leads.length, 0, `${text}: a thank-you is no work for staff`);
        assert.equal(reply.modelCalls, 0, text);
      }
      const question = await say("greet-question", "Сайн байна уу, Калдор аялал хэзээ гарах вэ", one("kaldor", { topics: ["dates"] }));
      assert.doesNotMatch(question.text, /^Зүгээр ээ/, "a real question after the greeting still wins");
      assert.match(question.text, /3 сарын 14/);
    });
  } finally { await harness.close(); }
});
