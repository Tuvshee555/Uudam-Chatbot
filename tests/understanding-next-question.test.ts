import assert from "node:assert/strict";
import test from "node:test";
import type { ConstraintLedger } from "../src/lib/constraintLedger";
import {
  appendNextQuestion, askedSlots, nextQuestion, replyAsksSomething, NEXT_QUESTION_BUDGET, NEXT_QUESTION_DATE, NEXT_QUESTION_DESTINATION,
  NEXT_QUESTION_NEXT_STEP, NEXT_QUESTION_PARTY, NEXT_QUESTION_PICK, NEXT_QUESTION_PICK_UNNUMBERED, NEXT_QUESTION_WHEN, type NextQuestionInput,
} from "../src/lib/nextQuestion";
import type { TripSelection } from "../src/lib/tripRequest";
import type { TravelTrip } from "../src/lib/travelTypes";

/**
 * The next question (owner, 2026-11-12: "it should ask … what kind of trip, how many of you, when,
 * what is your budget"). One slot at a time in the customer's order, never one already given, never
 * the question the bot just asked. Invented trips only.
 */
const now = new Date("2098-02-01T04:00:00Z");
function trip(id: string, dates: string[], status = "active"): TravelTrip {
  return { id, route_name: `${id.toUpperCase()} АЯЛАЛ`, operator_name: "Fixture agency", category: "Аялал", status, currency: "MNT",
    adult_price: 1_791_000, child_price: 1_591_000, infant_price: null, duration_text: "6 өдөр 5 шөнө", departure_dates: dates,
    seats_total: 20, seats_left: 10, has_food: null, hotel: "", photo_urls: [], notes: "", source_description: "", extra: {} } as unknown as TravelTrip;
}
const TRIPS = [trip("norvel", ["2098-03-15", "2098-03-29"]), trip("velmor", ["2098-03-20"]), trip("dalan", ["2098-03-22"], "sold_out")];
const select = (tripId: string, extra: Partial<TripSelection> = {}): TripSelection => ({ tripId, date: null, hotel: null, package: null, passengers: [], ...extra });
const ledger = (extra: Partial<ConstraintLedger> = {}): ConstraintLedger =>
  ({ destinations: [], dateScope: null, passengers: [], groupSize: null, purpose: null, updatedAt: now.getTime(), ...extra });
const FARE_CARD = "НОРВЕЛ АЯЛАЛ\n\nТом хүн (12+ нас): 1,791,000₮\nХүүхэд (2-11 нас): 1,591,000₮";
function ask(overrides: Partial<NextQuestionInput>) {
  return nextQuestion({ purpose: "reply", reply: FARE_CARD, previousBotText: null, history: [], customerText: "", selection: null,
    pendingTripIds: [], ledger: null, trips: TRIPS, phoneKnown: false, now, ...overrides });
}

test("(a) nothing in play: where and when, in one question", () => {
  assert.equal(ask({ reply: "Манай аяллуудыг вэбсайтаас үзнэ үү." })?.text, NEXT_QUESTION_DESTINATION);
  // A destination the ledger holds, without a month: only when.
  assert.equal(ask({ reply: "Манай аяллуудыг вэбсайтаас үзнэ үү.", ledger: ledger({ destinations: ["норвел"] }) })?.text, NEXT_QUESTION_WHEN);
  // The month already said ("3 сард"): nothing to ask about either.
  assert.equal(ask({ reply: "Манай аяллуудыг вэбсайтаас үзнэ үү.", ledger: ledger({ destinations: ["норвел"] }), customerText: "3 сард явмаар байна" }), null);
});

test("(b) a list on screen and nothing chosen: which one (numbered or not)", () => {
  const numbered = "Аяллууд:\n\n1. НОРВЕЛ АЯЛАЛ\n📅 3/15\n\n2. ВЕЛМОР АЯЛАЛ\n📅 3/20";
  assert.equal(ask({ reply: numbered, pendingTripIds: ["norvel", "velmor"] })?.text, NEXT_QUESTION_PICK);
  const bulleted = "Эдгээр аяллын гарах өдрүүд:\n• НОРВЕЛ АЯЛАЛ: 3/15\n• ВЕЛМОР АЯЛАЛ: 3/20";
  assert.equal(ask({ reply: bulleted, pendingTripIds: ["norvel", "velmor"] })?.text, NEXT_QUESTION_PICK_UNNUMBERED);
  // The list already asks which one: a follow-up asks the party instead, never the same thing again.
  const asking = `${numbered}\n\nАль аяллыг нь сонирхож байна вэ?\n1 эсвэл 2 гэж бичээрэй 😊`;
  assert.equal(ask({ purpose: "follow_up", reply: asking, pendingTripIds: ["norvel", "velmor"] })?.text, NEXT_QUESTION_PARTY);
  // A stale pending list does not count when the reply is about one trip.
  assert.equal(ask({ pendingTripIds: ["norvel", "velmor"], selection: select("norvel") })?.slot, "date");
});

test("(c) one trip, several open departures, none chosen: which date; one departure skips it", () => {
  assert.equal(ask({ selection: select("norvel") })?.text, NEXT_QUESTION_DATE);
  assert.equal(ask({ selection: select("velmor") })?.text, NEXT_QUESTION_PARTY, "a single departure is no choice");
  // A window holding one of the two departures settles the date too.
  assert.equal(ask({ selection: select("norvel", { dateScope: { month: 3, year: 2098, range: ["2098-03-25", "2098-03-31"] } }) })?.slot, "party");
});

test("(d) trip and date known, party unknown: how many; (f) all known: the consultant", () => {
  assert.equal(ask({ selection: select("norvel", { date: "2098-03-15" }) })?.text, NEXT_QUESTION_PARTY);
  const party = [{ kind: "adult" as const, count: 2 }];
  assert.equal(ask({ selection: select("norvel", { date: "2098-03-15", passengers: party }) })?.text, NEXT_QUESTION_NEXT_STEP);
  assert.equal(ask({ selection: select("norvel", { date: "2098-03-15", passengers: party }), phoneKnown: true }), null, "a phone already given");
  // The party in the customer's own words counts as given, even before routing stored it.
  assert.equal(ask({ selection: select("norvel", { date: "2098-03-15" }), customerText: "2 том хүн 1 хүүхэд" })?.slot, "next_step");
  assert.equal(ask({ selection: select("norvel", { date: "2098-03-15" }), history: [{ role: "user", text: "гэр бүлээрээ явна" }] })?.slot, "next_step");
});

test("(e) browsing broadly with the party known and no price: the budget", () => {
  const party = ledger({ passengers: [{ kind: "adult", count: 2 }] });
  const reply = "Ямар аялал, чиглэл сонирхож байна вэ?";
  assert.equal(ask({ purpose: "follow_up", reply, ledger: party })?.text, NEXT_QUESTION_BUDGET);
  assert.equal(ask({ purpose: "follow_up", reply: `${reply}\nТом хүн 1,791,000₮`, ledger: party }), null, "a price already in play");
  assert.equal(ask({ purpose: "follow_up", reply, ledger: party, customerText: "5 сая төсөвтэй" }), null, "a budget already given");
});

test("never the question the bot just asked, never one already in the reply", () => {
  // The previous message asked the date; the next answer asks the party, not the date again.
  assert.equal(ask({ selection: select("norvel"), previousBotText: "Аль гарах өдрөөр аялах вэ?" })?.slot, "party");
  // The party was asked last time and is still unknown: a reply adds nothing more ...
  assert.equal(ask({ selection: select("norvel", { date: "2098-03-15" }), previousBotText: NEXT_QUESTION_PARTY }), null);
  // ... and the follow-up after silence offers the programme (owner, 2026-11-13), never the party again;
  assert.equal(ask({ purpose: "follow_up", selection: select("norvel", { date: "2098-03-15" }), reply: `${FARE_CARD}\n\n${NEXT_QUESTION_PARTY}` })?.slot, "program");
  // once the programme went out, it hands the booking to the consultant.
  assert.equal(ask({ purpose: "follow_up", selection: select("norvel", { date: "2098-03-15" }),
    reply: `${FARE_CARD}\nPDF хөтөлбөрийг хавсаргалаа.\n\n${NEXT_QUESTION_PARTY}` })?.slot, "next_step");
  // A party total that asked the departure ("9 том хүн" → totals + "Аль гарах өдрөөр аялах вэ?"): the same.
  const nine = select("norvel", { passengers: [{ kind: "adult", count: 9 }] });
  assert.equal(ask({ selection: nine, reply: `${FARE_CARD}\nАль гарах өдрөөр аялах вэ?\n• 3 сарын 15` }), null, "the answer itself adds nothing");
  assert.equal(ask({ purpose: "follow_up", selection: nine, reply: `${FARE_CARD}\nАль гарах өдрөөр аялах вэ?\n• 3 сарын 15` })?.slot, "program");
  // The programme offer is asked once: never again right after it.
  assert.equal(ask({ purpose: "follow_up", selection: nine, previousBotText: "Аяллын дэлгэрэнгүй хөтөлбөрийг авах уу? 😊",
    reply: `${FARE_CARD}\nАль гарах өдрөөр аялах вэ?\n• 3 сарын 15` })?.slot, "next_step");
  // The destination question also asks the month.
  assert.equal(ask({ reply: "Хэдэн сард аялах вэ?" }), null);
});

test("the phone ask (owner, 2026-11-14: 'wanted numbers most'): from the first answer, at most every third message", async () => {
  const { phoneInvite } = await import("../src/lib/nextQuestion");
  const { PHONE_INVITE, PARTY_AND_PHONE_INVITE } = await import("../src/lib/nextQuestionText");
  const base: NextQuestionInput = { purpose: "reply", reply: FARE_CARD, previousBotText: null, history: [], customerText: "", selection: select("norvel"),
    pendingTripIds: [], ledger: null, trips: TRIPS, phoneKnown: false, now };
  const earlier = [{ role: "user", text: "норвел" }, { role: "assistant", text: FARE_CARD }];
  assert.equal(phoneInvite(base, null)?.text, PARTY_AND_PHONE_INVITE, "the first answer asks too (most who leave, leave after it)");
  assert.equal(phoneInvite({ ...base, history: earlier }, null)?.text, PARTY_AND_PHONE_INVITE, "party unknown: one line asks both");
  assert.equal(phoneInvite({ ...base, history: earlier }, { slot: "party", text: NEXT_QUESTION_PARTY })?.text, PHONE_INVITE, "the party is being asked: the phone only");
  assert.equal(phoneInvite({ ...base, history: earlier, customerText: "2 том хүн" }, null)?.text, PHONE_INVITE, "party known: the phone only");
  assert.equal(phoneInvite({ ...base, history: earlier, phoneKnown: true }, null), null, "a phone already given");
  const askedLastTime = [...earlier, { role: "user", text: "3/15" }, { role: "assistant", text: `${FARE_CARD}\n\n${PHONE_INVITE}` }];
  assert.equal(phoneInvite({ ...base, history: askedLastTime }, null), null, "asked in the last message");
  const askedTwoAgo = [...askedLastTime, { role: "user", text: "хоол багтсан уу" }, { role: "assistant", text: "Өглөөний хоол багтсан." }];
  assert.equal(phoneInvite({ ...base, history: askedTwoAgo }, null), null, "asked two messages ago");
  const askedThreeAgo = [...askedTwoAgo, { role: "user", text: "зочид буудал" }, { role: "assistant", text: "4 одтой зочид буудал." }];
  assert.ok(phoneInvite({ ...base, history: askedThreeAgo }, null), "asked again on the third message");
  assert.equal(phoneInvite({ ...base, history: earlier, purpose: "follow_up" }, null), null, "never on the follow-up itself");
});

test("null: a full or unknown trip is not sold further; nothing worth asking is nothing", () => {
  assert.equal(ask({ selection: select("dalan") }), null, "a sold-out trip");
  assert.equal(ask({ selection: select("missing") }), null, "a trip no longer in the catalogue");
  assert.equal(ask({ reply: "Аль аялал вэ?" }), null, "the bot just asked which trip");
});

test("asked slots are read from questions only: a date list heading asks nothing", () => {
  assert.deepEqual([...askedSlots("Таны асуусан хугацаанд гарах хуваарь байхгүй.\nОйрын гарах өдрүүд:\n• 3 сарын 15")], []);
  assert.deepEqual([...askedSlots("Аль гарах өдрөөр аялах вэ?\n• 3 сарын 15")], ["date"]);
  assert.ok(askedSlots("Аль аяллыг нь сонирхож байна вэ?\n1 эсвэл 2 гэж бичээрэй 😊").has("pick"));
  assert.ok(askedSlots(NEXT_QUESTION_NEXT_STEP).has("next_step"));
});

test("the question is appended after one blank line, with at most one inline emoji, and states no fact", () => {
  assert.equal(appendNextQuestion("12 сарын 27: захиалга нээлттэй.\n", { slot: "party", text: NEXT_QUESTION_PARTY }),
    `12 сарын 27: захиалга нээлттэй.\n\n${NEXT_QUESTION_PARTY}`);
  // Line-leading icons are layout; an inline emoji already in the reply drops the question's own.
  assert.equal(appendNextQuestion("💰 Том хүн 1,791,000₮", { slot: "party", text: NEXT_QUESTION_PARTY }), `💰 Том хүн 1,791,000₮\n\n${NEXT_QUESTION_PARTY}`);
  assert.equal(appendNextQuestion("Сайхан аялал 😊", { slot: "party", text: NEXT_QUESTION_PARTY }), "Сайхан аялал 😊\n\nХэдэн хүн явах вэ? Хүүхэд байвал насыг нь бичээрэй");
  for (const question of [NEXT_QUESTION_DESTINATION, NEXT_QUESTION_WHEN, NEXT_QUESTION_PICK, NEXT_QUESTION_PICK_UNNUMBERED, NEXT_QUESTION_DATE,
    NEXT_QUESTION_PARTY, NEXT_QUESTION_BUDGET, NEXT_QUESTION_NEXT_STEP]) {
    assert.doesNotMatch(question, /\d|₮|[А-ЯӨҮЁ]{4,}/u, `no price, date or trip name: ${question}`);
  }
  assert.equal(replyAsksSomething("Аль өдөр нь танд тохирох вэ?"), true);
  assert.equal(replyAsksSomething("https://uudamtravel.mn/trips/norvel-aylal"), false);
});
