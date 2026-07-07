import assert from "node:assert/strict";
import test, { before } from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { CustomerDocument } from "../src/lib/customerDocuments";

// customerDocuments.ts transitively loads env at import time.
let summarizeCustomerDocumentForMemory: typeof import("../src/lib/customerDocuments").summarizeCustomerDocumentForMemory;

before(async () => {
  applyTestEnv();
  const mod = await import("../src/lib/customerDocuments");
  summarizeCustomerDocumentForMemory = mod.summarizeCustomerDocumentForMemory;
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
