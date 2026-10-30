import assert from "node:assert/strict";
import test from "node:test";
import { compareLeadsByAttention, leadAttention, summarizeLeadAttention } from "../src/lib/leadAttention";
import { collectDeliveryQuality } from "../src/lib/deliveryQuality";
import type { TravelLead } from "../src/lib/travelTypes";

const now = new Date("2098-02-10T04:00:00Z");
const lead = (fields: Partial<TravelLead> & { staff_replied_at?: string | null; last_activity_at?: string | null } = {}) => ({
  id: 1, kind: "handoff", platform: "facebook", sender_id: "fixture-customer", customer_message: "асуулт", contact_phone: "",
  context: "", status: "new", lead_status: "new_lead", created_at: "2098-02-09T04:00:00Z", seen_at: null, ...fields,
}) as TravelLead & { staff_replied_at?: string | null; last_activity_at?: string | null };

test("leads are ranked by who is waiting on a person", () => {
  // 172 real leads were all "new" on 2026-10-30: the waiting customer looked like every other.
  const silent = leadAttention(lead({ context: "Бот мэдээлэлгүй fast-path хариуг зөвлөхөд шилжүүлж, хэрэглэгчид хариу илгээсэнгүй: answer_plan" }), now);
  assert.equal(silent.tier, "waiting");
  assert.equal(silent.needsAttention, true);
  const booking = leadAttention(lead({ kind: "booking", context: "Утас: 90000000" }), now);
  assert.equal(booking.tier, "booking");
  assert.ok(compareLeadsByAttention(silent, booking) < 0, "the waiting customer first");
  // Notes as the webhook appends them (Mongolia time in the stamp).
  const followup = leadAttention(lead({ kind: "booking", context: "Утас\nХариулаагүй асуулт (02-10 10:00): Хэзээ залгах вэ?" }), now);
  assert.equal(followup.tier, "waiting", "a question to a consultant's chat is waiting");
  assert.equal(followup.lastActivityAt, "2098-02-10T02:00:00.000Z", "the note's time is the lead's latest activity");
  assert.match(followup.latestNote ?? "", /Хэзээ залгах вэ\?/);
  const answered = leadAttention(lead({ kind: "booking", context: "Утас\nЗахиалгын дараах мессеж (02-10 10:00): Хүүхдийн үнэ?" }), now);
  assert.equal(answered.tier, "booking", "a message the bot answered does not make the customer wait");
  assert.equal(leadAttention(lead({ context: "хэрэглэгчид хариу илгээсэнгүй", staff_replied_at: "2098-02-09T06:00:00Z" }), now).tier, "staff",
    "a consultant's Messenger reply after the lead answers it");
  assert.equal(leadAttention(lead({ status: "seen" }), now).needsAttention, false);
  assert.equal(leadAttention(lead({ created_at: "2098-01-20T04:00:00Z" }), now).needsAttention, false, "attention lapses after a week of quiet");
  const summary = summarizeLeadAttention([lead({ context: "хэрэглэгчид хариу илгээсэнгүй" }), lead({ kind: "booking" }), lead({ status: "seen" })], now);
  assert.deepEqual({ ...summary, latestActivityAt: undefined }, { needsAttention: 2, waiting: 1, booking: 1, latestActivityAt: undefined });
});

test("the quality overview counts real customers' outcomes from records only", async () => {
  const sqls: string[] = [];
  const rows: Record<string, Array<Record<string, unknown>>> = {
    received: [{ deliveries: "12", messages: "10", text_messages: "9", customers: "6", since: "2098-02-08T00:00:00Z" }],
    outcomes: [{ status: "answered", silent: null, reason: "", count: "6" }, { status: "silent", silent: "staff_takeover", reason: "", count: "1" },
      { status: "failed", silent: null, reason: "delivery_failed", count: "1" }],
    repeated: [{ count: "1" }],
    events: [{ event: "webhook.inbound_duplicate", count: "2", dropped: "0" }, { event: "error_log_store.flood_dropped", count: "1", dropped: "4" }],
    people: [{ customers: "7", inbound: "20" }],
    leads: [{ bookings: "2", handoffs: "3" }],
  };
  const quality = await collectDeliveryQuality(async (sql) => {
    sqls.push(sql);
    const key = /quality:(\w+)/.exec(sql)![1];
    return { rows: rows[key] };
  }, [lead({ context: "хэрэглэгчид хариу илгээсэнгүй" })], now);
  assert.equal(quality.trail.answered, 6);
  assert.equal(quality.trail.failed, 1);
  assert.deepEqual(quality.trail.failureReasons, [{ reason: "delivery_failed", count: 1 }]);
  assert.equal(quality.trail.withoutOutcome, 1, "9 text messages, 8 outcomes");
  assert.equal(quality.trail.duplicateDeliveries, 2);
  assert.equal(quality.droppedLogRecords, 4, "an incomplete trail is reported, not hidden");
  assert.equal(quality.leads.attention.waiting, 1);
  for (const sql of sqls.filter((value) => /travel_conversations|travel_leads/.test(value))) assert.match(sql, /NOT LIKE 'demo:%'/, "test sessions never count");
  for (const sql of sqls.filter((value) => /webhook\.inbound/.test(value))) assert.match(sql, /deploymentRevision/, "production records only");
});
