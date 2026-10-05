import assert from "node:assert/strict";
import test from "node:test";
import { auditFaqParity, auditTripPair, hasParityValue, sameParityValue } from "../src/lib/tripWebsiteParity";
import { websiteTripToCanonicalFields } from "../src/lib/websiteTripBridge";

const website = { id: "web", sourceTripId: "canonical", slug: "trip", title: "Trip", description: "Website text", summary: "Summary",
  price: 1000000, durationDays: 2, durationNights: 1, currency: "MNT", isPublished: true,
  included: ["Flight"], excluded: [], importantNotes: [], itinerary: [], departures: [], image: "", extraImages: [] };

test("equal shared facts are not flagged; auditing does not mutate inputs", () => {
  const chatbot = { ...websiteTripToCanonicalFields(website).fields, id: "canonical" };
  const before = JSON.stringify({ website, chatbot });
  assert.deepEqual(auditTripPair(website, chatbot).differences, []);
  assert.equal(JSON.stringify({ website, chatbot }), before);
});

test("conflicting copy retains both values for individual review", () => {
  const chatbot = { ...websiteTripToCanonicalFields(website).fields, notes: "Chatbot text" };
  const difference = auditTripPair(website, chatbot).differences.find(item => item.websiteField === "description");
  assert.deepEqual(difference, { websiteField: "description", chatbotField: "notes", kind: "different", websiteValue: "Website text", chatbotValue: "Chatbot text" });
});

test("unmapped website fields and canonical seat resets are inventoried", () => {
  const web = { ...website, requirements: "Passport", hotelMedia: [{ url: "photo" }], weather: { city: "Sanya" } };
  const chatbot = { ...websiteTripToCanonicalFields(web).fields, seats_total: 20, seats_left: 8 };
  const audit = auditTripPair(web, chatbot);
  assert.equal(audit.websiteSeparateValues.requirements, "Passport");
  assert.deepEqual(audit.websiteSeparateValues.weather, { city: "Sanya" });
  assert.equal(audit.websiteSaveResetsCanonicalSeats, true);
});

test("zero and false are real values, and object key order is not a conflict", () => {
  assert.equal(hasParityValue(0), true);
  assert.equal(hasParityValue(false), true);
  assert.equal(sameParityValue({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
  assert.equal(sameParityValue(["a", "b"], ["b", "a"]), false);
});

test("duration wording, hosted itinerary photos and import filenames are not content conflicts", () => {
  const web = { ...website, description: "Poster subtitle", summary: null, itinerary: [{ dayNumber: 1, title: "Day", description: "Tour", meals: [], image: "https://example.com/day.jpg" }] };
  const chatbot = { ...websiteTripToCanonicalFields(web).fields, duration_text: "1 шөнө / 2 өдөр", notes: "", source_description: "original-poster.pdf",
    extra: { included_items: ["Flight"], itinerary_days: [{ day: 1, title: "Day", description: "Tour", meals: {} }] } };
  const audit = auditTripPair(web, chatbot, { subtitle: "Poster subtitle" });
  assert.deepEqual(audit.differences, []);
  assert.equal(audit.websiteSaveWouldReplaceImportSource, true);
  assert.equal(audit.itineraryDetailsNotRepresented.length, 1);
  assert.equal(audit.customerTextNotStoredInCanonical.length, 1);
});

test("FAQ answer conflicts retain both sources and do not guess similar questions", () => {
  const faq = auditFaqParity([{q:"Payment?",a:"Contact staff"},{q:"Refund?",a:"Ask staff"}], [{question:"PAYMENT?",answer:"Pay online"},{question:"Cancellation?",answer:"Ask staff"}]);
  assert.deepEqual(faq.conflictingExactQuestions, [{question:"Payment?",websiteAnswer:"Contact staff",chatbotAnswer:"Pay online"}]);
  assert.equal(faq.websiteQuestionsWithoutExactChatbotMatch.length,1);
  assert.equal(faq.chatbotQuestionsWithoutExactWebsiteMatch.length,1);
});
