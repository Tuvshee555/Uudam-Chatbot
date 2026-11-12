import assert from "node:assert/strict";
import test from "node:test";
import { decideTripAnswer } from "../src/lib/tripAnswerDecision";
import type { TripAnswerPlan } from "../src/lib/tripAnswerPlan";

function plan(patch: Partial<TripAnswerPlan> = {}): TripAnswerPlan {
  return { status: "answered", tripId: "velmor", selection: { tripId: "velmor", date: null, hotel: null, package: null, passengers: [] },
    request: { topics: ["includes"], date: null, month: null, year: null, hotel: null, package: null, passengers: [], days: null },
    reply: "Вэлмор аялал\nҮнэд багтаагүй:\n• Даатгал", offer: null, answeredTopics: ["includes"], missingTopics: [], missingFacts: [],
    mediaUrls: [], brochureUrl: null, ...patch };
}

test("known exclusions and clarification are delivered by structured coverage in both channels", () => {
  const answered = decideTripAnswer(plan(), { userText: "Даатгал үнэд багтсан уу?" });
  assert.equal(answered.outcome, "answered");
  assert.match(answered.reply, /багтаагүй/);
  const clarify = decideTripAnswer(plan({ status: "clarify", reply: "Аль гарах өдрөөр аялах вэ?" }), { userText: "үнэ?" });
  assert.equal(clarify.outcome, "clarify");
});

test("missing coverage cannot be hidden by a valid-looking partial answer or status", () => {
  const unknown = decideTripAnswer(plan({ missingFacts: ["includes.insurance"] }), { userText: "Даатгал?" });
  assert.equal(unknown.outcome, "handoff");
  assert.equal(unknown.reply, "REFER");
  const partial = decideTripAnswer(plan({ request: { ...plan().request, topics: ["price", "includes"] } }), { userText: "үнэ, даатгал?" });
  assert.equal(partial.outcome, "handoff");
  assert.deepEqual(partial.missingFacts, ["topic.price"]);
});

test("a plan cannot use a different selection ID or deliver an empty answer", () => {
  const different = decideTripAnswer(plan({ selection: { ...plan().selection, tripId: "nerith" } }), { userText: "Вэлмор" });
  assert.equal(different.outcome, "handoff");
  assert.deepEqual(different.missingFacts, ["selection.trip"]);
  for (const reply of ["", "  ", "REFER", "SILENT"]) assert.equal(decideTripAnswer(plan({ reply }), { userText: "үнэ?" }).outcome, "handoff");
});

test("a plan that wrote nothing for the turn is a hand-off, never the cleaner's 'Хүний ажилтантай холбож өгье' line", async () => {
  // Live 2026-11-06..12: "Үнэ", "9 том хүн", "3 том хүн, 6,8 настай 2 хүүхэд" under a selected trip got an answer plan with
  // no section; presenting "" gave sanitizeAssistantReply's stand-in, which went out as an answer with no lead.
  const { presentAssistantReply } = await import("../src/lib/chatbotReplyPolicy");
  const { EMPTY_REPLY_FALLBACK } = await import("../src/lib/reply");
  const empty = presentAssistantReply({ reply: "", userText: "Үнэ" });
  assert.equal(empty, EMPTY_REPLY_FALLBACK, "what an empty plan reply becomes");
  const decision = decideTripAnswer(plan({ reply: empty, request: { ...plan().request, topics: [] }, answeredTopics: [] }), { userText: "Үнэ" });
  assert.equal(decision.outcome, "handoff");
  assert.equal(decision.reply, "REFER");
  assert.deepEqual(decision.missingFacts, ["reply.empty"]);
});
