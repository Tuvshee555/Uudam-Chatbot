import assert from "node:assert/strict";
import test from "node:test";
import { conversationGateHarness, type FixtureTrip } from "./helpers/conversationGateHarness";

/**
 * Staff takeover on Facebook, end to end through the signed webhook (owner, 2026-10-30): the bot
 * never talks over a consultant, keeps helping a customer who is only waiting for one, and
 * when Meta's thread cannot be read it does not pretend nobody replied. Production threads
 * showed the bot, a consultant on a computer and Meta's automations all as `source:web`, so the
 * bot knows its own messages by the ids it recorded when sending them (staffTakeover.ts).
 * Invented catalogue; the model is mocked.
 */
const city = {
  id: "city", route_name: "НОРВЕЛ ХОТЫН АЯЛАЛ", operator_name: "Fixture agency", category: "Аялал",
  adult_price: 1_791_000, child_price: 1_591_000, infant_price: 381_000, currency: "MNT", status: "active",
  duration_text: "6 өдөр 5 шөнө", departure_dates: ["2098-03-15", "2098-03-29"], seats_total: 20, seats_left: 10,
  has_food: null, hotel: "", photo_urls: [], notes: "", source_description: "",
  extra: { customer_visible: true, aliases: ["Норвел"], age_rules: { adult: "12+ нас", child: "2-11 нас", infant: "0-23 сар" } },
} as unknown as FixtureTrip;
const one = { certainty: "one", tripId: "city" };
const MIN = 60_000;

test("staff takeover journeys on Facebook", async (context) => {
  const harness = await conversationGateHarness(context);
  harness.catalog([city]);
  const fb = (sender: string, text: string, model: Record<string, unknown> = {}, eventId?: string) =>
    harness.turn(sender, text, model, eventId, { platform: "facebook" });
  const tick = (ms: number) => context.mock.timers.tick(ms);
  /** The bot answers once (its message id is recorded), then ten minutes pass. */
  const opened = async (sender: string) => {
    const first = await fb(sender, "Норвел хотын аялал үнэ", one);
    assert.ok(first.sends.length >= 1, `${sender}: the bot answers first`);
    const botMid = harness.botMids().at(-1)!;
    tick(10 * MIN);
    return botMid;
  };
  const answeredPrice = (turn: Awaited<ReturnType<typeof fb>>) => turn.sends.map((send) => send.text).join("\n");
  /** What staff read on the customer's lead in the Leads tab. */
  const leadContext = (sender: string) => harness.leads.find((lead) => lead.sender_id === sender)?.context ?? "";

  try {
    await context.test("1. a consultant replying from the phone app silences the bot", async () => {
      const botMid = await opened("mobile");
      harness.thread("mobile", { messages: [
        { from: "customer", text: "Норвел хотын аялал үнэ", agoMs: 10 * MIN },
        { from: "page", id: botMid, source: "web", text: "НОРВЕЛ ХОТЫН АЯЛАЛ", agoMs: 10 * MIN - 2_000 },
        { from: "page", source: "mobile", text: "Сайн байна уу, би аяллын зөвлөх", agoMs: 2 * MIN },
      ] });
      const after = await fb("mobile", "Хүүхдийн үнэ хэд вэ?", one);
      assert.equal(after.sends.length, 0, "the bot stays out");
      assert.equal(harness.pauseState("mobile")?.pause_reason, "operator_reply");
      assert.ok(after.history.some((row) => row.role === "user" && row.text === "Хүүхдийн үнэ хэд вэ?"), "the message is kept");
      assert.match(leadContext("mobile"), /Хариулаагүй асуулт \([^)]+\): Хүүхдийн үнэ хэд вэ\?/, "and lands on the lead for staff");
    });

    await context.test("2. a consultant replying from Business Suite on a computer silences the bot", async () => {
      const botMid = await opened("desktop");
      harness.thread("desktop", { messages: [
        { from: "customer", text: "Норвел хотын аялал үнэ", agoMs: 10 * MIN },
        { from: "page", id: botMid, source: "web", text: "НОРВЕЛ ХОТЫН АЯЛАЛ", agoMs: 10 * MIN - 2_000 },
        { from: "page", id: "m_desktop_staff", source: "web", text: "Сайн байна уу, захиалгыг тань хүлээн авлаа", agoMs: 3 * MIN },
      ] });
      const after = await fb("desktop", "Баярлалаа, хэзээ гарах вэ?", one);
      assert.equal(after.sends.length, 0, "a source:web message the bot did not send is a consultant");
      assert.equal(harness.pauseState("desktop")?.pause_reason, "operator_reply");
    });

    await context.test("3. the bot's own messages in the thread are never taken for a consultant", async () => {
      const botMid = await opened("own");
      harness.thread("own", { messages: [
        { from: "customer", text: "Норвел хотын аялал үнэ", agoMs: 10 * MIN },
        { from: "page", id: botMid, source: "web", text: "НОРВЕЛ ХОТЫН АЯЛАЛ", agoMs: 10 * MIN - 2_000 },
      ] });
      const after = await fb("own", "Хүүхдийн үнэ хэд вэ?", one);
      assert.equal(after.sends.length, 1, "the bot keeps answering");
      assert.match(answeredPrice(after), /1,591,000₮/);
      assert.equal(harness.pauseState("own"), null);
    });

    await context.test("4. Meta's automated greeting right after the customer is not a consultant", async () => {
      await opened("greeting");
      harness.thread("greeting", { messages: [
        { from: "customer", text: "Сайн уу", agoMs: 60_000 },
        { from: "page", id: "m_meta_instant", source: "web", text: "Hi! Please let us know how we can help you.", agoMs: 58_000 },
        { from: "page", id: "m_meta_notice", source: "web", text: "Bat replied to your automated welcome message.", agoMs: 30_000 },
      ] });
      const after = await fb("greeting", "Норвел хотын аялал үнэ хэд вэ?", one);
      assert.equal(after.sends.length, 1);
      assert.match(answeredPrice(after), /1,791,000₮/);
    });

    await context.test("5. repeated consultant replies keep the bot out, counted from the latest", async () => {
      const botMid = await opened("repeat");
      harness.thread("repeat", { messages: [
        { from: "customer", text: "Норвел хотын аялал үнэ", agoMs: 10 * MIN },
        { from: "page", id: botMid, source: "web", agoMs: 10 * MIN - 2_000 },
        { from: "page", source: "mobile", text: "Сайн байна уу", agoMs: 6 * MIN },
        { from: "page", source: "mobile", text: "Дансны мэдээллийг явууллаа", agoMs: 1 * MIN },
      ] });
      const first = await fb("repeat", "Ойлголоо", one);
      const second = await fb("repeat", "Хүүхэд хэд вэ?", one);
      assert.deepEqual([first.sends.length, second.sends.length], [0, 0]);
      const until = Date.parse(harness.pauseState("repeat")!.expires_at!);
      assert.ok(Math.abs(until - (Date.now() - MIN + 3 * 86_400_000)) < 5_000, "three days from the latest consultant message");
    });

    await context.test("6. a consultant's manual take-over silences the bot; 8. later messages stay with staff", async () => {
      await opened("manual");
      harness.pause("manual");
      const paused = await fb("manual", "Үнэ хэд вэ дахиад", one);
      assert.equal(paused.sends.length, 0);
      assert.ok(paused.history.some((row) => row.role === "user" && row.text === "Үнэ хэд вэ дахиад"));
      const again = await fb("manual", "Хариулаач", one);
      assert.equal(again.sends.length, 0, "every later message too, until released");
      assert.match(leadContext("manual"), /Хариулаагүй асуулт/);
    });

    await context.test("7. after the consultant releases the conversation the bot answers again", async () => {
      harness.resume("manual");
      const released = await fb("manual", "Норвел хотын аялал хүүхдийн үнэ", one);
      assert.equal(released.sends.length, 1);
      assert.match(answeredPrice(released), /1,591,000₮/);
    });

    await context.test("9. a customer waiting for a consultant after a booking request keeps getting help", async () => {
      await opened("waiting");
      harness.pause("waiting", new Date(Date.now() + 3 * 86_400_000).toISOString(), "booked_customer");
      const question = await fb("waiting", "Хүүхдийн үнэ хэд вэ?", one);
      assert.equal(question.sends.length, 1, "it used to get three days of silence");
      assert.match(answeredPrice(question), /1,591,000₮/);
      const status = await fb("waiting", "Захиалга маань юу болсон бэ?", one);
      assert.equal(status.sends.length, 1);
      assert.match(status.sends[0].text, /бүртгэгдсэн/, "the status from the lead");
      assert.doesNotMatch(status.sends[0].text, /баталгаажсан|confirmed|төлбөр хүлээн/i, "never a confirmation");
      const repeat = await fb("waiting", "Захиалга маань юу болсон бэ?", one);
      assert.match(repeat.sends[0]?.text ?? "", /Шинэ мэдээлэл алга/, "a repeat gets one line");
      const third = await fb("waiting", "Захиалга маань юу болсон бэ?", one);
      assert.equal(third.sends.length, 0, "and no spam after that");
      assert.match(leadContext("waiting"), /Захиалгын төлөв асуусан/);
      assert.match(leadContext("waiting"), /Хүлээж байхдаа асуусан \(бот хариулсан\)/, "answered questions reach the lead too");
    });

    await context.test("10–12. when the thread cannot be read, a conversation staff may own waits for staff", async () => {
      for (const fail of ["timeout", "permission", "incomplete"] as const) {
        const sender = `unverified-${fail}`;
        await opened(sender);
        harness.pause(sender, new Date(Date.now() + 3 * 86_400_000).toISOString(), "booked_customer");
        await fb(sender, "Хүүхдийн үнэ хэд вэ?", one); // creates the waiting customer's lead
        harness.thread(sender, { fail });
        const held = await fb(sender, "Норвел хотын аялал хэзээ гарах вэ?", one);
        assert.equal(held.sends.length, 0, `${fail}: not a reply that could talk over a consultant`);
        assert.ok(held.history.some((row) => row.role === "user" && row.text === "Норвел хотын аялал хэзээ гарах вэ?"), `${fail}: kept`);
        assert.match(leadContext(sender), /Бот хариулаагүй — ажилтны хариуг шалгаж чадсангүй/, `${fail}: visible to staff`);
      }
      // A customer with no lead and no consultant is answered as usual: one failed lookup does not
      // make the bot unavailable.
      harness.thread("unverified-new", { fail: "timeout" });
      const fresh = await fb("unverified-new", "Норвел хотын аялал үнэ", one);
      assert.equal(fresh.sends.length, 1);
    });

    await context.test("13. a duplicate webhook delivery during a takeover stores the message once", async () => {
      const botMid = await opened("duplicate");
      harness.thread("duplicate", { messages: [
        { from: "page", id: botMid, source: "web", agoMs: 10 * MIN - 2_000 },
        { from: "page", source: "mobile", text: "Би хариулъя", agoMs: 2 * MIN },
      ] });
      await fb("duplicate", "Тийм ээ", one, "dup-event-1");
      const again = await fb("duplicate", "Тийм ээ", one, "dup-event-1");
      assert.equal(again.sends.length, 0);
      assert.equal(again.history.filter((row) => row.role === "user" && row.text === "Тийм ээ").length, 1, "Meta's redelivery is not stored twice");
    });

    await context.test("14. a consultant's reply while a booking lead is active silences the waiting-customer help", async () => {
      const botMid = await opened("booked-staff");
      harness.pause("booked-staff", new Date(Date.now() + 3 * 86_400_000).toISOString(), "booked_customer");
      await fb("booked-staff", "Хүүхдийн үнэ хэд вэ?", one);
      harness.thread("booked-staff", { messages: [
        { from: "page", id: botMid, source: "web", agoMs: 10 * MIN - 2_000 },
        { from: "page", id: "m_staff_web", source: "web", text: "Таны захиалгыг хүлээн авлаа", agoMs: 1 * MIN },
      ] });
      const after = await fb("booked-staff", "Хэзээ холбогдох вэ?", one);
      assert.equal(after.sends.length, 0, "the consultant answers, not the bot's status line");
      assert.equal(harness.pauseState("booked-staff")?.pause_reason, "operator_reply");
    });
    // Hotfix 2026-10-31 — live 2026-10-30 22:37 UTC, a brand-new customer's first message.
    await context.test("15. Meta's automated welcome greeting before a new customer's first message does not silence the bot", async () => {
      harness.thread("greeted", { messages: [
        { from: "page", id: "m_meta_welcome", source: "web", text: "Hi Bat! Please let us know how we can help you.", agoMs: 5_000 },
        { from: "customer", text: "Норвел хотын аялал үнэ", agoMs: 0 },
      ] });
      const first = await fb("greeted", "Норвел хотын аялал үнэ", one);
      assert.equal(first.sends.length, 1, "the new customer is answered");
      assert.match(answeredPrice(first), /1,791,000₮/);
      assert.equal(harness.pauseState("greeted"), null, "and not paused for three days");
    });

    await context.test("16. a consultant's photo from the phone right after a bot reply silences the bot", async () => {
      const botMid = await opened("photo");
      // The consultant's photo (no text) comes 60 s after the bot's reply was stored.
      harness.thread("photo", { messages: [
        { from: "customer", text: "Норвел хотын аялал үнэ", agoMs: 10 * MIN },
        { from: "page", id: botMid, source: "web", text: "НОРВЕЛ ХОТЫН АЯЛАЛ", agoMs: 10 * MIN - 2_000 },
        { from: "page", id: "m_staff_photo", source: "mobile", text: "", agoMs: 9 * MIN },
      ] });
      const after = await fb("photo", "Ойлголоо, баярлалаа. Хэзээ гарах вэ?", one);
      assert.equal(after.sends.length, 0);
      assert.equal(harness.pauseState("photo")?.pause_reason, "operator_reply");
    });

    await context.test("17. a failed lookup never lets the bot answer over a consultant who replied this week", async () => {
      const botMid = await opened("recent-staff");
      harness.thread("recent-staff", { messages: [
        { from: "customer", text: "Норвел хотын аялал үнэ", agoMs: 10 * MIN },
        { from: "page", id: botMid, source: "web", agoMs: 10 * MIN - 2_000 },
        { from: "page", source: "mobile", text: "Сайн байна уу, зөвлөх байна", agoMs: 2 * MIN },
      ] });
      await fb("recent-staff", "Ойлголоо", one); // the consultant's reply is seen and recorded
      tick(3 * 86_400_000 + 3_600_000); // the three-day pause has ended
      harness.thread("recent-staff", { fail: "timeout" });
      const held = await fb("recent-staff", "Хүүхдийн үнэ хэд вэ?", one);
      assert.equal(held.sends.length, 0, "the thread cannot be read and a consultant replied this week: no bot reply");
      assert.match(leadContext("recent-staff"), /Бот хариулаагүй — ажилтны хариуг шалгаж чадсангүй/);
    });
    // Release after takeover (bot_released_at): "Ботод буцаах" must actually hand the
    // conversation back — before the fix the next customer message re-read the thread, found
    // the SAME old consultant reply inside the 3-day window and silently re-paused.
    await context.test("18. after 'Ботод буцаах' the old consultant reply no longer re-pauses; a NEW one takes over again", async () => {
      const botMid = await opened("released");
      harness.thread("released", { messages: [
        { from: "customer", text: "Норвел хотын аялал үнэ", agoMs: 10 * MIN },
        { from: "page", id: botMid, source: "web", agoMs: 10 * MIN - 2_000 },
        { from: "page", source: "mobile", text: "Сайн байна уу, зөвлөх байна", agoMs: 2 * MIN },
      ] });
      const silenced = await fb("released", "Ойлголоо", one);
      assert.equal(silenced.sends.length, 0);
      assert.equal(harness.pauseState("released")?.pause_reason, "operator_reply");
      harness.resume("released"); // staff press "Ботод буцаах"
      const answered = await fb("released", "Хүүхдийн үнэ хэд вэ?", one);
      assert.equal(answered.sends.length, 1, "released: the old consultant reply does not re-silence the bot");
      assert.match(answeredPrice(answered), /1,591,000₮/);
      assert.equal(harness.pauseState("released"), null, "and no new pause was written");
      tick(5 * MIN);
      harness.thread("released", { messages: [
        { from: "customer", text: "Норвел хотын аялал үнэ", agoMs: 20 * MIN },
        { from: "page", id: botMid, source: "web", agoMs: 20 * MIN - 2_000 },
        { from: "page", source: "mobile", text: "Сайн байна уу, зөвлөх байна", agoMs: 12 * MIN },
        { from: "page", source: "mobile", text: "Би энэ харилцагчийг дахин авлаа", agoMs: 1 * MIN },
      ] });
      const retaken = await fb("released", "За", one);
      assert.equal(retaken.sends.length, 0, "a consultant replying AFTER the release takes the conversation over again");
      assert.equal(harness.pauseState("released")?.pause_reason, "operator_reply");
    });

    await context.test("19. after a release with the lead closed, a failed thread read answers as usual", async () => {
      const botMid = await opened("released-closed");
      harness.thread("released-closed", { messages: [
        { from: "customer", text: "Норвел хотын аялал үнэ", agoMs: 10 * MIN },
        { from: "page", id: botMid, source: "web", agoMs: 10 * MIN - 2_000 },
        { from: "page", source: "mobile", text: "Зөвлөх байна", agoMs: 2 * MIN },
      ] });
      await fb("released-closed", "Ойлголоо", one); // silenced; the consultant's reply is recorded
      for (const lead of harness.leads.filter((row) => row.sender_id === "released-closed")) {
        harness.updateLead(lead.id, { lead_status: "closed" });
      }
      harness.resume("released-closed");
      harness.thread("released-closed", { fail: "timeout" });
      const answered = await fb("released-closed", "Хүүхдийн үнэ хэд вэ?", one);
      assert.equal(answered.sends.length, 1,
        "the release cleared the staff-risk hold: one failed lookup does not silence a handed-back customer");
    });
  } finally {
    await harness.close();
  }
});
