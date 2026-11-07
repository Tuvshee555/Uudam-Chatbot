import assert from "node:assert/strict";
import test from "node:test";
import { conversationGateHarness, type FixtureTrip } from "./helpers/conversationGateHarness";
import { flushPersistedLogs } from "../src/lib/observability";

/**
 * The need gate, end to end through the signed webhook (messageNeed.ts + needDispatch.ts). Every journey is
 * the SHAPE of a real conversation that failed between 2026-10-31 and 2026-11-05 (organisation asks answered
 * with "system is down", a fare card or a made-up group discount; barter answered with a trip list; a
 * thank-you answered with a programme; a ticket-only wish answered with a trip list; "ok" greeted back;
 * booking questions answered with "Утасны дугаараа бичнэ үү."), replayed on an INVENTED catalogue with a
 * mocked model. The model is never called by the gate itself, so the "unavailable" runs prove a billing
 * outage cannot reach it.
 */
const trip = (id: string, name: string, dates: string[], fares: [number, number, number | null], fields: Record<string, unknown> = {}) => ({
  id, route_name: name, operator_name: "Fixture agency", category: "Аялал", adult_price: fares[0], child_price: fares[1], infant_price: fares[2],
  currency: "MNT", status: "active", duration_text: "9 өдөр 8 шөнө", departure_dates: dates, seats_total: 20, seats_left: 10,
  has_food: null, hotel: "", photo_urls: [], notes: "", source_description: "",
  extra: { customer_visible: true, age_rules: { adult: "12+ нас", child: "2-11 нас", infant: "0-23 сар" } }, ...fields,
} as unknown as FixtureTrip);
const combo = (id: string, name: string, adult: number, dates: string[]) =>
  trip(id, name, dates, [adult, adult - 400_000, 351_000], { category: "Газар + нислэг хосолсон", source_description: "газар нислэг хосолсон" });

const catalog = [
  combo("a1", "ЛУМАРА А ГАЗАР НИСЛЭГ ХОСОЛСОН", 2_991_000, ["2098-03-08", "2098-03-22"]),
  combo("a2", "ЛУМАРА Б ГАЗАР НИСЛЭГ ХОСОЛСОН", 2_651_000, ["2098-03-08", "2098-03-13"]),
  combo("a3", "ЛУМАРА В ГАЗАР НИСЛЭГ ХОСОЛСОН", 2_291_000, ["2098-03-11", "2098-03-18"]),
  trip("city", "НОРВЕЛ ХОТЫН АЯЛАЛ", ["2098-03-15", "2098-03-29"], [1_791_000, 1_591_000, 381_000], { extra: { customer_visible: true, aliases: ["Норвел"] } }),
  trip("kaldor", "КАЛДОР ХОТЫН АЯЛАЛ", ["2098-03-14", "2098-03-28"], [1_691_000, 1_291_000, 381_000], { extra: { customer_visible: true, aliases: ["Калдор"] } }),
  // Its alias "Сана" sits inside the everyday word "санал" (suggestion): the false trip evidence of the case-14 thank-you.
  trip("sanara", "САНАРА АРЛЫН АЯЛАЛ", ["2098-03-14", "2098-03-28"], [1_591_000, 1_291_000, 381_000], { extra: { customer_visible: true, aliases: ["Сана", "Sana"] } }),
];
const comboList = { certainty: "several", trips: ["T1", "T2", "T3"], intent: "catalog" };
const one = (tripId: string, extra: Record<string, unknown> = {}) => ({ certainty: "one", tripId, ...extra });

// The company's own published wording (reply.ts GROUP_INQUIRY_REPLY), matched by fragments so a wording change
// shows up as a deliberate edit here, and by what it must NEVER say.
const GROUP_WORDING = /тусгай аялал зохион байгуулах боломж бий[\s\S]*аяллын зөвлөх хөтөлбөр, үнийн санал бэлтгэнэ[\s\S]*Захиалга нь нөхцөл тохирсны дараа баталгаажна/;
const NEVER_SAID = /хямдр|хөнгөлөлт|бартер|үнэгүй|баталгаатай үнэ|₮|систем түр саатаж|Утасны дугаараа/;
const questions = (text: string) => (text.match(/\?/g) || []).length;

test("the need gate: what the customer needs is read before any trip is looked up", async (context) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(catalog);
  const say = async (sender: string, text: string, model: Record<string, unknown> = {}) => {
    const result = await harness.turn(sender, text, model);
    return { ...result, text: result.sends.map((send) => send.text).join("\n") };
  };
  const leadOf = (sender: string) => harness.leads.find((lead) => lead.sender_id === sender);
  const outcomes = () => harness.logs.filter((log) => log.event === "webhook.inbound_outcome");
  // The error-log store admits 120 rows a minute per instance (errorLogStore.ts flood guard) and the harness
  // clock is frozen, so a test that reads persisted rows lets the queued writes land, then starts a fresh minute.
  const freshLogWindow = async () => { await flushPersistedLogs(); context.mock.timers.tick(61_000); };
  try {
    // ── business / group / custom travel (cases 7, 9, 15, 17) ─────────────────────────────────────────
    await context.test("case 7: an organisation of 50-60 gets the company's own wording, one question and a typed lead, with the provider healthy", async () => {
      await say("org-ok", "мэдээлэл авья");
      const reply = await say("org-ok", "50-60хүнтэй байгууллага байгаа юм");
      assert.equal(reply.sends.length, 1);
      assert.match(reply.text, GROUP_WORDING);
      assert.match(reply.text, /Таны хүсэлтийг аяллын зөвлөхөд дамжууллаа/, "the lead was saved, so the hand-off sentence is true");
      assert.equal(questions(reply.text), 1, "exactly one question");
      assert.match(reply.text, /Аль чиглэлд явахыг хүсэж байна вэ\?$/, "the head count is known, so the destination is asked");
      assert.doesNotMatch(reply.text, NEVER_SAID);
      assert.equal(reply.modelCalls, 0, "the gate makes no model call");
      assert.equal(reply.answerModelCalls, 0);
      const lead = leadOf("org-ok")!;
      assert.equal(lead.kind, "handoff");
      assert.ok(lead.context.startsWith("[need:business_group]"), lead.context);
      assert.match(lead.context, /Хүний тоо: 60/);
      assert.match(lead.context, /50-60хүнтэй байгууллага байгаа юм/, "staff read the customer's own words");
    });

    await context.test("case 7 with the provider out of credit: the same reply, never 'the system is down'", async () => {
      const reply = await say("org-down", "50-60хүнтэй байгууллага байгаа юм", { unavailable: true });
      assert.equal(reply.sends.length, 1);
      assert.match(reply.text, GROUP_WORDING);
      assert.doesNotMatch(reply.text, /систем|саатаж/);
      assert.equal(reply.modelCalls, 0);
      assert.ok(leadOf("org-down")!.context.startsWith("[need:business_group]"));
    });

    await context.test("paraphrases of an organisation ask (Cyrillic, Latin, typos) are read the same way", async () => {
      const asks: Array<[string, RegExp]> = [
        ["Alban baiguulaga", /Нийт хэдэн хүн явах вэ\?$/],
        ["albanii baiguullaga aylal zohion baiguulj ugdug uu", /Нийт хэдэн хүн явах вэ\?$/],
        ["Манай 35 ажилтныг шинэ жилээр дулаан орон руу явуулах гэсэн юм.", /төсөв хэд орчим вэ\?$/],
        ["Манай компани 80 хүнтэй, өвлийн амралтаар явмаар байна", /Аль чиглэлд явахыг хүсэж байна вэ\?$/],
        ["hamt olnoor 25 hun ywna, tusgai marshrut gargaj ugch bolh uu", /Аль чиглэлд явахыг хүсэж байна вэ\?$/],
      ];
      for (const [index, [text, question]] of asks.entries()) {
        const reply = await say(`org-para-${index}`, text);
        assert.equal(reply.sends.length, 1, text);
        assert.match(reply.text, GROUP_WORDING, text);
        assert.match(reply.text, question, text);
        assert.equal(questions(reply.text), 1, text);
        assert.doesNotMatch(reply.text, NEVER_SAID, text);
        assert.equal(reply.modelCalls, 0, text);
        assert.ok(leadOf(`org-para-${index}`)!.context.startsWith("[need:business_group]"), text);
      }
    });

    await context.test("case 9: a group naming a trip's place gets no fare card; the destination words and head count go to staff", async () => {
      const reply = await say("org-card", "Kaldor hotruuu aylah tuluwtui bga manai hamt olon niit 20s 25 hun", one("kaldor"));
      assert.equal(reply.sends.length, 1);
      assert.match(reply.text, GROUP_WORDING);
      assert.doesNotMatch(reply.text, /КАЛДОР|1,691,000|Том хүн|Аль гарах өдөр/i, "no fare card for a group ask");
      assert.match(reply.text, /Аль сард явахыг хүсэж байна вэ\?$/, "head count and destination are known, so the month is asked");
      const lead = leadOf("org-card")!;
      assert.match(lead.context, /Хүний тоо: 25/);
      assert.match(lead.context, /Чиглэл: kaldor/i);
      assert.equal(reply.modelCalls, 0);
    });

    await context.test("case 17: a bespoke itemised quote among three candidate trips gets no totals and no trip list", async () => {
      const reply = await say("quote", "Бид Лумара руу 14-18 хооронд энгийн аяллын хөтөлбөрт хамрагдахгүйгээр нислэг, 4 шөнийн буудал, трансфер, даатгалтай нийт үнийн санал авмаар байна. 1 том 2 хүүхэд 9, 11 настай.", { certainty: "several", trips: ["T1", "T2", "T3"] });
      assert.equal(reply.sends.length, 1);
      assert.match(reply.text, GROUP_WORDING);
      assert.doesNotMatch(reply.text, /Нийт:|ЛУМАРА|Аль аялал вэ|Аль аяллыг/, "no totals, no candidate list");
      assert.doesNotMatch(reply.text, /\d{1,3}(?:,\d{3})+₮/);
      const lead = leadOf("quote")!;
      assert.ok(lead.context.startsWith("[need:business_group]"));
      assert.match(lead.context, /нийт үнийн санал/, "the whole quote request reaches staff");
    });

    await context.test("a second message from a customer staff already hold is appended to the lead, not dropped; the answer to the one question is recorded quietly", async () => {
      const first = await say("org-follow", "Alban baiguulaga");
      assert.equal(first.sends.length, 1);
      assert.equal(harness.leads.filter((lead) => lead.sender_id === "org-follow").length, 1);
      // The customer answers the question the bot asked: it goes onto the lead, nothing more is sent.
      const answer = await say("org-follow", "40 хүн");
      assert.deepEqual(answer.sends, []);
      assert.equal(answer.modelCalls, 0);
      assert.match(leadOf("org-follow")!.context, /Хариулт[^\n]*40 хүн/);
      // A new organisation message later: the open lead keeps it, and the customer is not re-served the same wording.
      const again = await say("org-follow", "Манай байгууллага 40 хүнтэй, 3 сард явна");
      assert.equal(harness.leads.filter((lead) => lead.sender_id === "org-follow").length, 1, "still one open lead");
      assert.match(leadOf("org-follow")!.context, /3 сард явна/, "the new message is on the lead");
      assert.equal(again.sends.length, 1);
    });

    await context.test("a human owns the conversation: an organisation message gets silence from the bot (operator_reply and manual)", async () => {
      for (const reason of ["operator_reply", "manual"]) {
        const sender = `org-paused-${reason}`;
        harness.pause(sender, undefined, reason);
        const reply = await say(sender, "50-60хүнтэй байгууллага байгаа юм");
        assert.deepEqual(reply.sends, [], reason);
        assert.equal(reply.modelCalls, 0, reason);
        assert.equal(reply.answerModelCalls, 0, reason);
      }
    });

    // ── commercial terms (case 8) ───────────────────────────────────────────────────────────────────────
    await context.test("case 8: 'organisation of 40-45, any discount?' is never answered 'Тийм'; barter does not re-send the trip list", async () => {
      await say("claim", "Лумара аяллын мэдээлэл авья", comboList);
      const discount = await say("claim", "baiguullagara 40-45 hun ywah bol hymdral uzuuldeg uu", { finalReply: "Тийм. 40-45 хүнтэй группт тусгай хямдрал санал болгодог. Нарийн үнийг манай аяллын зөвлөхөөс лавлана уу." });
      assert.equal(discount.sends.length, 1);
      assert.doesNotMatch(discount.text, /Тийм|тусгай хямдрал|санал болгодог/, "no invented discount policy");
      assert.doesNotMatch(discount.text, NEVER_SAID);
      assert.equal(discount.answerModelCalls, 0, "the free-text model is not asked about company policy");
      assert.match(leadOf("claim")!.context, /\[need:business_group\][\s\S]*Хүний тоо: 45/);
      const barter = await say("claim", "barter awdag u", { intent: "trip", certainty: "none" });
      assert.deepEqual(barter.sends, [], "barter has no data: silence, and above all not the trip list again");
      assert.equal(barter.answerModelCalls, 0);
      assert.match(leadOf("claim")!.context, /barter awdag u/, "the barter question reached staff on the open lead");
    });

    await context.test("commercial-policy paraphrases are silent with a typed lead and never a list, a card or model text", async () => {
      const asks = [
        "Бартер авдаг уу", "Бартер эсвэл байгууллагын гэрээгээр төлж болох уу?", "Нэхэмжлэх гаргаж өгөх үү",
        "barteraar aylj bolh uu", "Сараар хувааж төлж болох уу", "Картаар төлж болох уу",
      ];
      for (const [index, text] of asks.entries()) {
        const sender = `policy-${index}`;
        await say(sender, "Лумара аяллын мэдээлэл авья", comboList);
        const reply = await say(sender, text, { intent: "trip", certainty: "several", trips: ["T1", "T2"], finalReply: "Тийм, бартер болон гэрээгээр төлж болно." });
        assert.deepEqual(reply.sends, [], text);
        assert.equal(reply.answerModelCalls, 0, text);
        const lead = harness.leads.find((row) => row.sender_id === sender && row.context.startsWith("[need:commercial_policy]"));
        assert.ok(lead, `${text}: typed lead [need:commercial_policy]`);
      }
    });

    await context.test("a discount claim the data does not hold is REFERed even when the question slips past the gate (the output guard)", async () => {
      const reply = await say("claim-guard", "Олуулаа явбал ямар нөхцөлтэй вэ", { intent: "other", certainty: "none", topics: [], finalReply: "Тийм. Группт тусгай хямдрал бий." });
      assert.equal(reply.answerModelCalls, 1, "this one does reach the reply model");
      assert.deepEqual(reply.sends, [], "an invented discount is never sent");
      assert.ok(harness.leads.some((lead) => lead.sender_id === "claim-guard"), "staff get the question instead");
    });

    // ── a service that is not a trip (case 10 class) ──────────────────────────────────────────────────────
    await context.test("case 10 class: pick-up, transfer and ticket-only wishes with a place word get a typed lead and silence, never a list or card", async () => {
      const asks: Array<[string, Record<string, unknown>]> = [
        ["Нельмара хилээс Улаанбаатар орох хүн авах боломж байдаг уу", {}],
        ["Хорвата хилээс Улаанбаатар хүртэл автобусаар хүргэж өгөх үү", { certainty: "several", trips: ["T1", "T2"] }],
        ["Велтанагаас Улаанбаатар буцахад онгоцны тийз тусад нь авч болох уу", { certainty: "several", trips: ["T1", "T2"] }],
        ["Калдор руу онгоцны тийз л авъя аялал биш", one("kaldor")],
        ["tiz l avmaar bna aylal bish", {}],
      ];
      for (const [index, [text, model]] of asks.entries()) {
        const sender = `transport-${index}`;
        const reply = await say(sender, text, model);
        assert.deepEqual(reply.sends, [], text);
        assert.equal(reply.modelCalls, 0, `${text}: no model call`);
        assert.ok(leadOf(sender)!.context.startsWith("[need:transport_only]"), `${text}: ${leadOf(sender)?.context}`);
      }
    });

    // ── thanks, praise, acknowledgement (case 14, 'ok' as greeting) ───────────────────────────────────────
    await context.test("case 14: a long thank-you naming 'хөтөлбөр' and 'санал' gets the thanks line: no itinerary, no list, no lead", async () => {
      const thanks = [
        "Танай компанид баярлалаа. Хөтөлбөрт нэмэх хасах зүйл, санал хүсэлт болгоныг сонсож, хамгийн сайн үйлчилгээ үзүүлсэнд, хөтөч нартаа баярлалаа. Дараагийн аялалд дахин уулзъя.",
        "Аялал маш сайхан боллоо. Баярлалаа.",
        "bayarlalaa",
        "Санал болгосонд баярлалаа",
        "Хөтөлбөр нь их сайхан байсан, баярлалаа",
      ];
      for (const [index, text] of thanks.entries()) {
        const sender = `thanks-${index}`;
        const reply = await say(sender, text, one("sanara", { topics: ["program"] }));
        assert.equal(reply.sends.length, 1, text);
        assert.match(reply.text, /^Зүгээр ээ 😊/, text);
        assert.doesNotMatch(reply.text, /САНАРА|1,591,000|өдөр|Аль аялал|Аль аяллыг/, text);
        assert.equal(reply.leads.length, 0, `${text}: a thank-you is no work for staff`);
        assert.equal(reply.modelCalls, 0, text);
      }
    });

    await context.test("praise without a thank-you is met with a warm line; a farewell and a bare 'ok' stay silent", async () => {
      const praise = await say("praise", "Аялал маш сайхан боллоо");
      assert.equal(praise.sends.length, 1);
      assert.match(praise.text, /^Таны сайхан үгэнд баярлалаа 😊/);
      assert.equal(praise.leads.length, 0);
      for (const text of ["Баяртай", "сайхан амраарай"]) {
        const reply = await say(`farewell-${text}`, text);
        assert.deepEqual(reply.sends, [], text);
        assert.equal(reply.leads.length, 0, text);
      }
    });

    await context.test("'ok' under a price answer is not a greeting: silent, no lead, no model call; so are its paraphrases", async () => {
      await freshLogWindow();
      await say("ack", "Норвел 3 сарын 15 үнэ", one("city", { date: "2098-03-15" }));
      for (const text of ["ok", "ок", "Ok", "за ойлголоо", "okey", "за бодоод үзье"]) {
        const reply = await say("ack", text);
        assert.deepEqual(reply.sends, [], `${text}: not 'Ямар аялал сонирхож байна?'`);
        assert.equal(reply.leads.length, 0, text);
        assert.equal(reply.modelCalls, 0, text);
      }
      const silentRows = () => outcomes().filter((log) => String(log.fields.silent || "").startsWith("need:social_"));
      await harness.settle(() => silentRows().length >= 6);
      assert.ok(silentRows().length >= 6, "the silence is recorded with its reason in the inbound trail");
    });

    // ── a booking that already exists (P10-P12, booking-collector misfire) ───────────────────────────────
    await context.test("questions about a booking are not a booking request: no phone ask, a typed lead for staff", async () => {
      const asks = [
        "захиалгаа цуцлах боломжтой юу", "миний захиалга баталгаажсан уу", "Захиалга маань батлагдсан уу",
        "zahialgaa uurchluh bolomjtoi yu", "захиалсан мөнгөө буцаан авч болох уу",
      ];
      for (const [index, text] of asks.entries()) {
        const sender = `booked-${index}`;
        const reply = await say(sender, text);
        assert.deepEqual(reply.sends, [], `${text}: not 'Утасны дугаараа бичнэ үү.'`);
        assert.equal(reply.modelCalls, 0, text);
        assert.ok(leadOf(sender)!.context.startsWith("[need:existing_booking]"), `${text}: ${leadOf(sender)?.context}`);
      }
    });

    await context.test("a customer who says they paid and asks if it is confirmed gets the payment deferral and a lead, never the collector", async () => {
      const reply = await say("paid", "төлбөрөө хийсэн захиалга баталгаажсан уу");
      assert.equal(reply.sends.length, 1);
      assert.match(reply.text, /Төлбөр, захиалгын баталгаажуулалтыг манай аяллын зөвлөх шалгаж/);
      assert.doesNotMatch(reply.text, /Утасны дугаараа/);
      assert.equal(reply.leads.length, 1);
    });

    await context.test("a complaint about a service already received goes to staff through the hand-off branch, not a trip card", async () => {
      const reply = await say("complaint", "Калдор аялалд явсан чинь хоол муу байсан гомдолтой байна", one("kaldor"));
      assert.equal(reply.sends.length, 1);
      assert.match(reply.text, /Таны хүсэлтийг хүлээн авлаа/);
      assert.doesNotMatch(reply.text, /КАЛДОР|1,691,000|₮/);
      assert.ok(leadOf("complaint")!.context.startsWith("[need:complaint]"));
      assert.equal(harness.pauseState("complaint")?.pause_reason, "handoff");
    });

    // ── positive controls: ordinary questions must still be answered ─────────────────────────────────────
    await context.test("positive controls: ordinary trip questions keep their answers", async () => {
      const price = await say("pc-price", "Баярлалаа, Норвел хотын аяллын үнэ хэд вэ", one("city"));
      assert.match(price.text, /1,791,000₮/, "a thanks word beside a real question does not turn it into thanks");
      const child = await say("pc-child", "Норвел хүүхдийн үнэ хэд вэ", one("city"));
      assert.match(child.text, /1,591,000₮/);
      await say("pc-group", "Норвел хотын аялал үнэ", one("city"));
      const heads = await say("pc-group", "50 хүн");
      assert.match(heads.text, /1,791,000₮/, "a bare head count under a trip card keeps the group-size path");
      assert.doesNotMatch(heads.text, /хөнгөлөлт|хямдрал/, "and it no longer hints at a group discount");
      const party = await say("pc-group", "2 том 2 хүүхэд");
      assert.match(party.text, /Нийт: 6,764,000₮/);
      const book = await say("pc-book", "Норвел аяллыг захиалъя", one("city"));
      assert.match(book.text, /Утасны дугаараа бичнэ үү/, "a real booking request still starts the collector");
      const discount = await say("pc-discount", "Норвел 3 сард хямдрал байна уу", one("city", { topics: ["discount"] }));
      assert.match(discount.text, /баталгаажсан идэвхтэй хямдралын мэдээлэл алга/, "a trip discount question keeps its honest no-data answer");
    });

    await context.test("the gate is logged without customer text, and persisted for the observe/enforce comparison", async () => {
      await freshLogWindow();
      const before = harness.logs.filter((log) => log.event === "webhook.need_classified").length;
      for (const [index, text] of ["Alban baiguulaga", "barter awdag u", "Калдор руу онгоцны тийз л авъя аялал биш", "захиалгаа цуцлах боломжтой юу",
        "Аялал маш сайхан боллоо. Баярлалаа.", "Хоол муу байсан гомдолтой байна"].entries()) await say(`logged-${index}`, text);
      const classes = () => new Set(harness.logs.filter((log) => log.event === "webhook.need_classified").map((log) => log.fields.need));
      const classifiedRows = () => harness.logs.filter((log) => log.event === "webhook.need_classified");
      await harness.settle(() => classifiedRows().length >= before + 6);
      const classified = classifiedRows();
      assert.ok(classified.length >= before + 6);
      const needs = classes();
      for (const need of ["business_group", "commercial_policy", "transport_only", "existing_booking", "social", "complaint"]) assert.ok(needs.has(need), `${need} was logged`);
      for (const log of classified) {
        assert.equal(log.fields.source, "rule");
        assert.ok(Array.isArray(log.fields.signals) && log.fields.signals.length > 0);
        // Signal names ("barter", "org") are cue labels; none of the customer's own words may be in the row.
        assert.doesNotMatch(JSON.stringify(log), /baiguulaga|awdag|Калдор|тийз|цуцлах|боллоо|Баярлалаа|гомдолтой|logged-/i, "no customer text in the log");
      }
    });

    // ── the model's proposed need (observe by default, enforce on request) ───────────────────────────────
    // A relatives' trip of 14: no organisation word, so the rules name no need; the model may. NEED_MODEL is read
    // per message, so one harness serves both modes.
    const relatives = "Манай ахан дүүс 14 хүн өвлийн амралтаар хамт явъя гэж байна";
    const proposal = { intent: "other", certainty: "none", topics: [], need: "business_group", need_evidence: "14 хүн" };
    const withNeedModel = async <T>(mode: string, run: () => Promise<T>): Promise<T> => {
      const before = process.env.NEED_MODEL;
      process.env.NEED_MODEL = mode;
      try { return await run(); } finally { if (before === undefined) delete process.env.NEED_MODEL; else process.env.NEED_MODEL = before; }
    };

    await context.test("NEED_MODEL=observe (the default) only logs the model's need: the customer sees what they saw before", async () => {
      await freshLogWindow();
      await withNeedModel("observe", async () => {
        const turn = await say("model-observe", relatives, proposal);
        assert.deepEqual(turn.sends, [], "observe mode changes nothing the customer sees");
        assert.ok(!harness.leads.some((lead) => lead.sender_id === "model-observe" && lead.context.startsWith("[need:")), "and writes no typed lead");
        await harness.settle(() => harness.logs.some((log) => log.event === "webhook.need_observed"));
        const logged = harness.logs.filter((log) => log.event === "webhook.need_observed");
        assert.equal(logged.length, 1);
        assert.equal(logged[0].fields.need, "business_group");
        assert.equal(logged[0].fields.source, "model");
        assert.equal(logged[0].fields.agreesWithRule, false);
        assert.doesNotMatch(JSON.stringify(logged[0]), /14 хүн|ахан дүүс/, "no customer text in the log");
        // Evidence that is not in the message, or without a cue of the class, is dropped before it can even be observed.
        await say("model-bad-evidence", relatives, { ...proposal, need_evidence: "50 хүний баг" });
        await say("model-bad-cue", relatives, { ...proposal, need: "commercial_policy", need_evidence: "14 хүн" });
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(harness.logs.filter((log) => log.event === "webhook.need_observed").length, 1, "only the validated proposal was logged");
      });
    });

    await context.test("NEED_MODEL=enforce: a validated model need acts exactly like a rule need; an unvalidated one does nothing", async () => {
      await withNeedModel("enforce", async () => {
        const acted = await say("model-enforce", relatives, proposal);
        assert.equal(acted.sends.length, 1);
        assert.match(acted.text, GROUP_WORDING);
        assert.equal(questions(acted.text), 1);
        assert.doesNotMatch(acted.text, NEVER_SAID);
        assert.match(leadOf("model-enforce")!.context, /^\[need:business_group\] \(model\)/);
        const refused = await say("model-enforce-bad", relatives, { ...proposal, need_evidence: "50 хүний баг" });
        assert.deepEqual(refused.sends, []);
        assert.ok(!harness.leads.some((lead) => lead.sender_id === "model-enforce-bad" && lead.context.startsWith("[need:")));
      });
    });

    await context.test("NEED_MODEL=off ignores the model's need entirely", async () => {
      await flushPersistedLogs();
      await withNeedModel("off", async () => {
        const before = harness.logs.filter((log) => log.event === "webhook.need_observed").length;
        const turn = await say("model-off", relatives, proposal);
        assert.deepEqual(turn.sends, []);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(harness.logs.filter((log) => log.event === "webhook.need_observed").length, before);
      });
    });

    await context.test("absent need fields change nothing: the existing understanding JSON drives the same decisions", async () => {
      const price = await say("legacy", "Норвел хотын аялал үнэ", one("city"));
      assert.match(price.text, /1,791,000₮/);
      const dates = await say("legacy", "хэзээ гарах вэ", one("city"));
      assert.match(dates.text, /3 сарын 15/);
    });
  } finally { await harness.close(); }
});
