import assert from "node:assert/strict";
import test, { before } from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { CustomerDocument } from "../src/lib/customerDocuments";

// customerDocuments.ts transitively loads env at import time.
let summarizeCustomerDocumentForMemory: typeof import("../src/lib/customerDocuments").summarizeCustomerDocumentForMemory;
let extractMongolianPhone: typeof import("../src/lib/customerDocuments").extractMongolianPhone;
let matchTripFromDocument: typeof import("../src/lib/customerDocuments").matchTripFromDocument;

before(async () => {
  applyTestEnv();
  const mod = await import("../src/lib/customerDocuments");
  summarizeCustomerDocumentForMemory = mod.summarizeCustomerDocumentForMemory;
  extractMongolianPhone = mod.extractMongolianPhone;
  matchTripFromDocument = mod.matchTripFromDocument;
});

function doc(overrides: Partial<CustomerDocument>): CustomerDocument {
  return {
    id: 1,
    platform: "facebook",
    sender_id: "s-1",
    page_id: "p-1",
    source_url: "https://cdn/img.jpg",
    stored_url: "https://cloudinary/img.jpg",
    image_sha256: "abc",
    mime_type: "image/jpeg",
    category: "other",
    extracted_json: {},
    matched_trip_id: null,
    matched_payment_id: null,
    duplicate_of_id: null,
    confidence: 0.9,
    auto_action: "",
    status: "needs_review",
    created_at: "2026-07-07",
    updated_at: "2026-07-07",
    ...overrides,
  };
}

test("booking-code memory summary masks the raw code (it enters every AI prompt)", () => {
  const summary = summarizeCustomerDocumentForMemory(
    doc({
      category: "booking_code",
      extracted_json: {
        booking: { code: "XK92-77413", trip_name: "Бээжин шууд" },
      },
    }),
  );
  assert.doesNotMatch(summary, /XK92-77413/);
  assert.match(summary, /code ending •••413/);
  assert.match(summary, /Бээжин шууд/);
});

test("very short codes are fully masked, never echoed", () => {
  const summary = summarizeCustomerDocumentForMemory(
    doc({
      category: "booking_code",
      extracted_json: { booking: { code: "77" } },
    }),
  );
  assert.doesNotMatch(summary, /77/);
  assert.match(summary, /•••/);
});

test("passport memory summary carries NO extracted personal data", () => {
  const summary = summarizeCustomerDocumentForMemory(
    doc({
      category: "passport",
      extracted_json: {
        passport: { full_name: "BATAA DORJ", passport_number: "E1234567" },
      },
    }),
  );
  assert.doesNotMatch(summary, /BATAA|E1234567/);
  assert.match(summary, /staff review required/);
});

test("payment memory summary keeps amount and date (bot may confirm receipt arrived)", () => {
  const summary = summarizeCustomerDocumentForMemory(
    doc({
      category: "payment_screenshot",
      extracted_json: {
        payment: { amount: "2,990,000", currency: "MNT", date: "2026-07-06" },
      },
    }),
  );
  assert.match(summary, /payment receipt sent/);
  assert.match(summary, /2,990,000 MNT/);
  assert.match(summary, /2026-07-06/);
});

test("trip screenshot summary surfaces what trip the customer is interested in", () => {
  const summary = summarizeCustomerDocumentForMemory(
    doc({
      category: "trip_screenshot",
      extracted_json: { trip: { title: "Хайнан - Саньяа аялал" } },
    }),
  );
  assert.match(summary, /trip screenshot sent/);
  assert.match(summary, /Хайнан - Саньяа аялал/);
});

test("extractMongolianPhone pulls the customer phone from real transaction memos", () => {
  // Real-world memo shapes staff use for matching (from live receipts).
  assert.equal(
    extractMongolianPhone("Angel Rosa Батцэцэг Номин аялалын үлдэгдэл 99592422"),
    "99592422",
  );
  assert.equal(extractMongolianPhone("EB -Timmka Tamir 88112594 Dalyan"), "88112594");
  assert.equal(extractMongolianPhone("EB -Hatnaa zealot 99183371 аялалын төлбөр"), "99183371");
});

test("extractMongolianPhone never captures a landline or account-number fragment", () => {
  // 7-prefix = Ulaanbaatar landline (often the agency's own number).
  assert.equal(extractMongolianPhone("залгах утас 77136633"), "");
  // Long digit runs (account/journal numbers) must not yield a false phone.
  assert.equal(extractMongolianPhone("Дансны дугаар 413143429 Журналын № 363495622"), "");
  assert.equal(extractMongolianPhone(""), "");
});

test("matchTripFromDocument resolves a trip screenshot against the catalog", () => {
  const trips = [
    { id: "hainan", route_name: "Хайнан - Саньяа шууд нислэгтэй аялал" },
    { id: "beijing", route_name: "Бээжин газрын аялал" },
  ];
  const resolve = (text: string) =>
    text.includes("Хайнан")
      ? ({ status: "verified", trip: trips[0] } as const)
      : ({ status: "not_found" } as const);
  const match = matchTripFromDocument(
    { trip: { title: "Хайнан - Саньяа", destination: "Хайнан" } },
    "trip_screenshot",
    trips,
    resolve,
  );
  assert.ok(match);
  assert.equal(match!.id, "hainan");
});

test("matchTripFromDocument reads the payment memo for booking context", () => {
  const trips = [{ id: "dalian", route_name: "Далянь хотын шууд нислэгтэй аялал" }];
  const resolve = (text: string) =>
    /dalyan|далянь/i.test(text)
      ? ({ status: "verified", trip: trips[0] } as const)
      : ({ status: "not_found" } as const);
  const match = matchTripFromDocument(
    { payment: { description: "EB -Timmka Tamir 88112594 Dalyan" } },
    "payment_screenshot",
    trips,
    resolve,
  );
  assert.ok(match);
  assert.equal(match!.id, "dalian");
});

test("matchTripFromDocument returns null when nothing resolves (no guessing)", () => {
  const trips = [{ id: "x", route_name: "X аялал" }];
  const match = matchTripFromDocument(
    { trip: { title: "огт хамаагүй зураг" } },
    "trip_screenshot",
    trips,
    () => ({ status: "not_found" }),
  );
  assert.equal(match, null);
});

test("payment memory summary includes phone and matched trip when known", () => {
  const summary = summarizeCustomerDocumentForMemory(
    doc({
      category: "payment_screenshot",
      extracted_json: {
        payment: { amount: "11,860,000", currency: "MNT", phone: "99183371" },
        trip_match: { id: "dalian", route_name: "Далянь хотын аялал" },
      },
    }),
  );
  assert.match(summary, /11,860,000 MNT/);
  assert.match(summary, /phone 99183371/);
  assert.match(summary, /trip: Далянь хотын аялал/);
});

test("matched trip screenshot summary names the catalog trip for the bot", () => {
  const summary = summarizeCustomerDocumentForMemory(
    doc({
      category: "trip_screenshot",
      extracted_json: {
        trip: { title: "unreadable poster" },
        trip_match: { id: "hainan", route_name: "Хайнан - Саньяа аялал" },
      },
    }),
  );
  assert.match(summary, /matched our trip: Хайнан - Саньяа аялал/);
});
