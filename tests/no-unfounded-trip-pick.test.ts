import assert from "node:assert/strict";
import test from "node:test";
import { findBestTripMatch, resolveDateQuestionScope, resolveTripFromUserMessage } from "../src/lib/travelFastPaths";
import type { TravelTrip } from "../src/lib/travelTypes";

/**
 * 2026-10-16: "10.20-23-ны хооронд эхлэх аялал бнуу" (any trip starting Oct 20–23?) was answered
 * about ONE trip — "хооронд" (between) was read as that trip's alias "Эзэн хороо" + a case ending.
 * Replaying 60 days of real messages, every trip the loose fallback picked when the strict matcher
 * found none was wrong (dates inside trip names, "дулаан" read as "улаан"). Invented trips below.
 */
function trip(id: string, route_name: string, extra: Record<string, unknown> = {}): TravelTrip {
  return { id, category: "", operator_name: "Invented", route_name, duration_text: "5 өдөр", adult_price: 1_000_000, child_price: null,
    infant_price: null, currency: "MNT", departure_dates: ["2026-10-18"], seats_total: null, seats_left: null, has_food: null,
    status: "active", notes: "", hotel: "", source_description: "", photo_urls: [], extra, created_at: "", updated_at: "" };
}
const CATALOG = [
  trip("vel", "Вэлмор -намрын баяр үзэх аялал", { aliases: ["Лотус хороо"] }),
  trip("bart", "БАРТЭН - ПАРК -сурагчдын амралтын аялал - 10/29"),
  trip("tar", "Тармиз - Улаан хад - Кардан аялал"),
];

test("'хооронд' (between) is never a place, so a date-span question picks no trip", () => {
  assert.equal(resolveDateQuestionScope("10.20-23-ны хооронд эхлэх аялал бнуу", CATALOG).focusTrip, null);
});

test("a date or an everyday word does not pick a trip that only shares a number or a sound", () => {
  for (const text of ["10 сарын аялал", "10.29nd", "Дулаан газар явмаар байна", "Удаан биш богино аялал"]) {
    assert.equal(findBestTripMatch(text, CATALOG).best, null, text);
    assert.equal(resolveTripFromUserMessage(text, CATALOG).status, "not_found", text);
  }
  // A real name still resolves.
  assert.equal(findBestTripMatch("Тармиз аялал үнэ", CATALOG).best?.id, "tar");
});

// 2026-10-31: once a trip named "...ХАЛУУН РАШААН..." went live, "Haluun gazar baih" (is there
// somewhere warm?) picked it on the single word "халуун". Warm is a guess, not that trip.
test("'халуун' (hot/warm) alone does not pick a hot-spring trip; its own name still does", () => {
  const catalog = [...CATALOG, trip("spring", "ВЭЛМОР ХАЛУУН РАШААН ЛУМИА ХОТ-ШИНЖИЛГЭЭТЭЙ АЯЛАЛ")];
  for (const text of ["Haluun gazar baih", "Халуун газар явмаар байна", "халуун уу"]) {
    assert.equal(resolveTripFromUserMessage(text, catalog).status, "not_found", text);
  }
  assert.equal(resolveTripFromUserMessage("Вэлмор халуун рашаан аялал", catalog).trip?.id, "spring");
  assert.equal(findBestTripMatch("халуун рашаантай аялал", catalog).best?.id, "spring");
});

test("a message made only of describing words is not one trip, even when an alias contains it", () => {
  const catalog = [
    trip("peak", "Лумиа - Гортал аялал", { aliases: ["Лумиа - Гортал уулын аялал"] }),
    trip("kids", "БАРТЭН -сурагчдын амралтын аялал"),
    trip("hk", "Тиранш – Хонконг аялал"),
  ];
  for (const text of ["Уулын аялал", "Амралтын өдрүүдээр", "Оюутан хөнгөлөлт"]) {
    assert.equal(findBestTripMatch(text, catalog).best, null, text);
  }
  assert.equal(findBestTripMatch("Гортал уулын аялал", catalog).best?.id, "peak");
});
