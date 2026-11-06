import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";
import { ALPHA, BETA, NOW, trip, TRIPS } from "./helpers/agentFixtures";

applyTestEnv();

/**
 * The brain is now the fallback (budget spent, model unreachable) and the reader of tapped
 * brain options. The mapping's bugs in it: "N мянгаар" (B3), "…гүй болго" read as "do
 * nothing" (B6), a "?" inside a link read as a question (B11), a pasted link falling back to
 * the conversation's trip (B1), and "12/2-ны үнийг … хас" removing the departure.
 */

test("'мянгаар' amounts are read (the tab's own example chip), in Cyrillic and Latin", async () => {
  const { parseIntent } = await import("../src/lib/assistantBrain");
  assert.deepEqual(parseIntent("«БЕТА НУУРЫН АЯЛАЛ» том хүний үнийг 100 мянгаар нэм", NOW), { kind: "price", change: { adult: { delta: 100_000 } }, mentioned: true });
  assert.deepEqual(parseIntent("«БЕТА НУУРЫН АЯЛАЛ» хүүхэд 300 мянгаар бага", NOW), { kind: "price", change: { child: { belowAdult: 300_000 } }, mentioned: true });
  assert.deepEqual(parseIntent("beta tom hun 200 myangaar nem", NOW), { kind: "price", change: { adult: { delta: 200_000 } }, mentioned: true });
  assert.deepEqual(parseIntent("«БЕТА НУУРЫН АЯЛАЛ» бүх үнийг 100,000-аар нэм", NOW), { kind: "price", change: { everyone: 100_000 }, mentioned: true });
});

test("'идэвхгүй болго' / 'idvehgui bolgooch' / 'сайтаас нуу' hide the trip; 'битгий нуу' still does nothing", async () => {
  const { parseIntent, think } = await import("../src/lib/assistantBrain");
  for (const text of ["Бета идэвхгүй болго", "beta idvehgui bolgooch", "Бета харагдахгүй болго", "Бета аяллыг сайтаас нуу", "beta hide"]) {
    assert.deepEqual(parseIntent(text, NOW), { kind: "visibility", visible: false }, text);
  }
  assert.deepEqual(parseIntent("Бета аяллыг харагдах болго", NOW), { kind: "visibility", visible: true });
  assert.equal(parseIntent("Бета аяллыг битгий нуу", NOW).kind, "negated");
  assert.equal(parseIntent("Хөвсгөл нуурын аялал цуцал", NOW).kind, "status", "нуур (lake) is not нуу (hide)");
  const out = think({ text: "«БЕТА НУУРЫН АЯЛАЛ» idvehgui bolgooch", trips: TRIPS, now: NOW });
  assert.equal(out.kind, "proposal");
  if (out.kind === "proposal") {
    assert.deepEqual(out.proposal.actions, [{ action: "set_visibility", trip_id: "t-beta", visible: false, summary: "Сайт, ботоос нуух (идэвхгүй)", expected_updated_at: BETA.updated_at }]);
    assert.match(out.proposal.important_reason, /архивт орохгүй/);
  }
});

test("a link's '?' is not a question and its words never pick the conversation's trip", async () => {
  const { parseIntent, resolveTrip, think } = await import("../src/lib/assistantBrain");
  const link = "https://uudamtravel.mn/mn/trips/trip-0123456789abcdef0123?fbclid=IwAR0x";
  assert.deepEqual(parseIntent(`${link} устга`, NOW), { kind: "archive" });
  const context = `Админ: «${ALPHA.route_name}» мэдээлэл\nAI: «${ALPHA.route_name}» — идэвхтэй`;
  assert.deepEqual(resolveTrip(`${link} устга`, TRIPS, { context, now: NOW }), { kind: "none" }, "no fallback to the trip talked about");
  assert.equal(resolveTrip("энэ аяллыг устга", TRIPS, { context, now: NOW }).kind, "certain", "without a link the conversation still helps");
  const out = think({ text: `${link} устга`, trips: TRIPS, now: NOW, context });
  assert.notEqual(out.kind, "proposal", "the brain never archives a trip it could not identify from the link");
});

test("'12/2-ны үнийг 100 мянгаар хас' lowers a price, never removes the departure; a dated price is not a trip-wide edit", async () => {
  const { parseIntent, think } = await import("../src/lib/assistantBrain");
  const intent = parseIntent("«ТУРШИЛТ – АЛЬФА ХОТЫН АЯЛАЛ» 12/2-ны үнийг 100 мянгаар хас", NOW);
  assert.equal(intent.kind, "price");
  const out = think({ text: "«ТУРШИЛТ – АЛЬФА ХОТЫН АЯЛАЛ» 12/2-ны үнийг 100 мянгаар хас", trips: TRIPS, now: NOW });
  assert.equal(out.kind, "defer", "the per-date price goes to the agent (or the admin is told), never to every date");
  assert.equal(parseIntent("«ТУРШИЛТ – АЛЬФА ХОТЫН АЯЛАЛ» 12/2-г хас", NOW).kind, "dates", "a date with no money is still removed");
});

test("the agent's hint readers: dates and amounts, links never read as either", async () => {
  const { amountsInText, datesInText } = await import("../src/lib/assistantBrain");
  assert.deepEqual(datesInText("https://partner.example/2098/12/05 12/2 болон 12 сарын 9-нд", NOW).sort(), ["2098-12-02", "2098-12-09"]);
  assert.deepEqual(amountsInText("100 мянгаар нэм, хүүхэд 1.2 сая, нярай 300k, https://x.example/?p=500000"), [100_000, 1_200_000, 300_000]);
});

test("a day's state and a price in one message are not one change: nothing is proposed, the simple mode asks for one at a time", async () => {
  const { parseIntent, think } = await import("../src/lib/assistantBrain");
  for (const text of [
    "«ТУРШИЛТ – АЛЬФА ХОТЫН АЯЛАЛ» 12/2 дүүрсэн, 12/9 үнийг 100k нэм",
    "«ТУРШИЛТ – АЛЬФА ХОТЫН АЯЛАЛ» 12/2 цөөн суудалтай, 12/9-ний хүүхдийн үнийг 2,100,000 болго",
  ]) {
    assert.deepEqual(parseIntent(text, NOW), { kind: "several_changes" }, text);
    const out = think({ text, trips: TRIPS, now: NOW });
    assert.equal(out.kind, "note", text);
    if (out.kind === "note") assert.match(out.text, /огнооны төлөв ба үнийн өөрчлөлт хоёулаа/);
  }
  const single = think({ text: "«ТУРШИЛТ – АЛЬФА ХОТЫН АЯЛАЛ» 12/2 дүүрсэн", trips: TRIPS, now: NOW });
  assert.equal(single.kind, "proposal", "one state on one day still works");
});

test("a partner trip's prices, seats and departures are never proposed by the brain", async () => {
  const { think } = await import("../src/lib/assistantBrain");
  for (const text of [
    "«ГАММА – ХАМТРАГЧИЙН АЯЛАЛ» үнийг 100k нэм",
    "«ГАММА – ХАМТРАГЧИЙН АЯЛАЛ» үлдсэн суудал 3",
    "«ГАММА – ХАМТРАГЧИЙН АЯЛАЛ» 12/30 гаралт нэм",
    "«ГАММА – ХАМТРАГЧИЙН АЯЛАЛ» 12/16 дүүрсэн",
    "бүх аяллын үнийг 100,000-аар нэм [аялал: «ГАММА – ХАМТРАГЧИЙН АЯЛАЛ» trip_id=t-gamma]",
  ]) {
    const out = think({ text, trips: TRIPS, now: NOW });
    assert.equal(out.kind, "note", `${text} → ${out.kind}`);
    if (out.kind === "note") assert.match(out.text, /хамтрагчийн сайтаас 30 минут тутам/, text);
  }
});

test("'идэвхжүүл' / 'сэргээ' on a hidden trip shows it again (one action), never 'already active'", async () => {
  const { think } = await import("../src/lib/assistantBrain");
  const hidden = trip({ id: "t-hidden", route_name: "НУУСАН ТУРШИЛТЫН АЯЛАЛ", departure_dates: ["2098-12-20"], extra: { customer_visible: false } });
  const archived = trip({ id: "t-archived", route_name: "АРХИВЫН ТУРШИЛТЫН АЯЛАЛ", status: "archived", departure_dates: ["2098-12-20"], extra: { customer_visible: false } });
  const trips = [...TRIPS, hidden, archived];
  for (const text of ["«НУУСАН ТУРШИЛТЫН АЯЛАЛ» идэвхжүүл", "«НУУСАН ТУРШИЛТЫН АЯЛАЛ» сэргээ"]) {
    const out = think({ text, trips, now: NOW });
    assert.equal(out.kind, "proposal", text);
    if (out.kind === "proposal") assert.deepEqual(out.proposal.actions.map((action) => [action.action, action.visible]), [["set_visibility", true]], text);
  }
  const restored = think({ text: "«АРХИВЫН ТУРШИЛТЫН АЯЛАЛ» сэргээ", trips, now: NOW });
  assert.equal(restored.kind, "proposal");
  if (restored.kind === "proposal") {
    assert.deepEqual(restored.proposal.actions.map((action) => [action.action, action.fields]), [["patch", { status: "active", extra: { customer_visible: true } }]]);
  }
  const visible = think({ text: "«БЕТА НУУРЫН АЯЛАЛ» идэвхжүүл", trips, now: NOW });
  assert.equal(visible.kind, "note", "a visible active trip is already so");
});

test("a brain card is checked like save: a blocked part is dropped and said; nothing left is a note", async () => {
  const { checkedBrainProposal } = await import("../src/lib/assistantReply");
  const base = { summary: "", needs_confirmation: true, important_reason: "", conflicts: [], conflict_items: [] };
  const partnerDay = { action: "set_date_state" as const, trip_id: "t-gamma", date: "2098-12-16", state: "full" as const, expected_updated_at: BETA.updated_at };
  const seats = { action: "patch" as const, trip_id: "t-beta", fields: { seats_left: 5 }, expected_updated_at: BETA.updated_at };
  const mixed = checkedBrainProposal({ ...base, actions: [partnerDay, seats] }, TRIPS, NOW);
  assert.ok("proposal" in mixed);
  if ("proposal" in mixed) {
    assert.deepEqual(mixed.proposal.actions, [seats], "the brain's own action is kept as it was");
    assert.ok(mixed.proposal.conflicts.some((line) => /хамтрагчийн сайтаас/.test(line)), mixed.proposal.conflicts.join(" | "));
  }
  const none = checkedBrainProposal({ ...base, actions: [partnerDay] }, TRIPS, NOW);
  assert.ok("note" in none && /хамтрагчийн сайтаас/.test(none.note));
});
