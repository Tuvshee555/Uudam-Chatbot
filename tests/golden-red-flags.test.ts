import assert from "node:assert/strict";
import test from "node:test";
import {
  appendLeadCaptureCta,
  buildDiscountReply,
  buildSeatsReply,
  buildStructuredTripReply,
} from "../src/lib/travelFastPaths";
import { filterFutureDepartureDates } from "../src/lib/travelDates";
import type { TravelTrip } from "../src/lib/travelOps";

/**
 * Golden red-flag net over the DETERMINISTIC reply layer (fast paths + date
 * logic). These strings must NEVER reach a customer, no matter the trip data.
 * The live end-to-end golden run against a real server is scripts/golden-questions.mjs.
 */
const NOW = new Date("2026-06-24T04:00:00.000Z");

const RED_FLAGS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bREFER\b/, label: "raw REFER token" },
  { pattern: /\bSILENT\b/, label: "raw SILENT token" },
  { pattern: /NEEDS_MANUAL_FIX/, label: "NEEDS_MANUAL_FIX sentinel" },
  { pattern: /Varies by departure date|Travel category|Unknown/, label: "English placeholder" },
  { pattern: /source_description|\bJSON\b|database/i, label: "internal field/word" },
  { pattern: /өмнө нь (хэлсэн|хуваалцсан)/, label: "scolding repeat phrase" },
  { pattern: /хүний нөөцийн менежер/i, label: "wrong staff title" },
  { pattern: /\b20(1\d|2[0-4])\b/, label: "past year (<=2024)" },
];

function assertNoRedFlags(reply: string | null | undefined, context: string) {
  const text = reply || "";
  for (const flag of RED_FLAGS) {
    assert.ok(
      !flag.pattern.test(text),
      `${context}: red flag "${flag.label}" appeared in reply:\n${text}`,
    );
  }
}

function trip(fields: Partial<TravelTrip>): TravelTrip {
  return {
    id: "trip-1",
    category: "Шууд нислэгтэй",
    operator_name: "Uudam Travel",
    route_name: "Бээжин шууд нислэгтэй аялал",
    duration_text: "5 өдөр / 4 шөнө",
    adult_price: 1890000,
    child_price: 1590000,
    currency: "MNT",
    departure_dates: ["1 сарын 5", "7 сарын 15"], // one past (Jan), one future (Jul)
    seats_total: null,
    seats_left: null,
    has_food: true,
    status: "active",
    notes: "",
    hotel: "",
    source_description: "",
    photo_urls: [],
    extra: {},
    created_at: "",
    updated_at: "",
    ...fields,
  };
}

const TRIPS: TravelTrip[] = [
  trip({}),
  trip({
    id: "hainan-no-price",
    category: "Далайн амралт",
    route_name: "Хайнан Саньяа аялал",
    adult_price: null, // missing price must NOT surface as a sentinel
    child_price: null,
    departure_dates: ["8 сарын 1"],
  }),
];

test("structured trip reply never leaks internal markers or past dates", () => {
  const reply = buildStructuredTripReply("Бээжин шууд нислэгтэй үнэ хэд вэ?", TRIPS, NOW);
  assertNoRedFlags(reply, "structured price reply");
  // The stored "1 сарын 5" is in the past relative to NOW and must be gone.
  assert.doesNotMatch(reply || "", /1\/5\b|1 сарын 5/);
});

test("seats reply invents no seat count and leaks no marker", () => {
  const reply = buildSeatsReply("Хайнан суудал байгаа юу?", TRIPS);
  assertNoRedFlags(reply, "seats reply");
});

test("discount reply leaks no marker even with a priceless trip", () => {
  const reply = buildDiscountReply("Хайнан хямдрал байгаа юу?", TRIPS);
  assertNoRedFlags(reply, "discount reply");
});

test("lead-capture CTA is appended to a fresh answer and leaks no marker", () => {
  const reply = buildStructuredTripReply("Бээжин шууд нислэгтэй үнэ хэд вэ?", TRIPS, NOW);
  const withCta = appendLeadCaptureCta(reply || "", false);
  assert.match(withCta, /утас/i);
  assertNoRedFlags(withCta, "reply + CTA");
});

test("filterFutureDepartureDates drops the past January date but keeps July", () => {
  const kept = filterFutureDepartureDates(["1 сарын 5", "7 сарын 15"], NOW);
  assert.deepEqual(kept, ["7 сарын 15"]);
});
