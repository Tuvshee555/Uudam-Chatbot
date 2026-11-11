import test, { before } from "node:test";
import assert from "node:assert/strict";
import { applyTestEnv } from "./helpers/env";
import { detectHoliday, holidayPromptLine, resolveHoliday, withoutHolidaySpans } from "../src/lib/holidayCalendar";
import { buildDepartureDateAvailabilityReply, requestedDepartureScope } from "../src/lib/travelDates";
import type { TravelTrip } from "../src/lib/travelTypes";

// The listing and the checker load the env-validated graph; import them after the test env is set.
let buildCatalogListingReply: typeof import("../src/lib/catalogListing").buildCatalogListingReply;
let verifyTripReply: typeof import("../src/lib/tripReplyVerification").verifyTripReply;
before(async () => {
  applyTestEnv();
  ({ buildCatalogListingReply } = await import("../src/lib/catalogListing"));
  ({ verifyTripReply } = await import("../src/lib/tripReplyVerification"));
});

// Live 2026-11-04: "цагаан сарын үеэр ямар аялалууд байна" got the catalogue's November
// departures. A holiday is a time: it resolves to that year's real days and the catalogue is
// searched there. Invented trips only; the holiday calendar is public data.
const now = new Date("2026-11-04T04:00:00Z");
const trip = (id: string, name: string, dates: string[], extra: Record<string, unknown> = {}): TravelTrip => ({
  id, route_name: name, operator_name: "Fixture agency", category: "Аялал", duration_text: "8 өдөр 7 шөнө",
  adult_price: 2_291_000, child_price: 1_891_000, infant_price: null, currency: "MNT", departure_dates: dates,
  seats_total: null, seats_left: null, has_food: null, status: "active", notes: "", hotel: "", source_description: "",
  photo_urls: [], extra: { customer_visible: true, ...extra }, created_at: "", updated_at: "",
} as TravelTrip);
// Overlaps the holiday (leaves a week before, 8 days long); leaves just after; leaves in November only.
const over = trip("over", "ЛУМАРА ХОТЫН АЯЛАЛ", ["2026-11-20", "2027-01-31"], { aliases: ["Лумара"] });
const after = trip("after", "ВЭЛМОР ДАЛАЙН ЭРГИЙН АЯЛАЛ", ["2027-02-12"], { aliases: ["Вэлмор"] });
const november = trip("nov", "НОРВЕЛ ХОТЫН АЯЛАЛ", ["2026-11-15", "2026-11-22"], { aliases: ["Норвел"] });
const summer = trip("summer", "ДОРМАН ХОТЫН АЯЛАЛ", ["2027-07-09", "2027-08-20"], { aliases: ["Дорман"] });
const catalog = [over, after, november, summer];

test("holiday words resolve to the coming holiday's real days, with the year", () => {
  const cases: Array<[string, string, string]> = [
    ["Цагаан сарын үеэр ямар аялалууд байна?", "2027-01-30", "2027-02-16"],
    ["цагаан сарын үейр ямар аялалууд байна", "2027-01-30", "2027-02-16"],
    ["Ирэх Цагаан сараар хэдэнд аялал байна?", "2027-01-30", "2027-02-16"],
    ["Шинийн нэгнээр гадагшаа явж болох уу?", "2027-01-30", "2027-02-16"],
    ["tsagaan sariin uyeer aylal bnu", "2027-01-30", "2027-02-16"],
    ["Цагаан сарын дараа ямар аялал байна?", "2027-02-10", "2027-03-11"],
    ["Наадмын үеэр ямар аялал байна?", "2027-07-04", "2027-07-22"],
    ["Шинэ жилээр ямар аялал байна?", "2026-12-01", "2027-01-10"],
  ];
  for (const [text, start, end] of cases) {
    const resolved = resolveHoliday(text, now);
    assert.equal(resolved?.status, "resolved", text);
    if (resolved?.status === "resolved") assert.deepEqual(resolved.window, [start, end], text);
    assert.deepEqual(requestedDepartureScope(text, now), { kind: "range", startYmd: start, endYmd: end }, text);
  }
  // A month typed is that month, not a holiday.
  assert.deepEqual(requestedDepartureScope("2 сард ямар аялал байна?", now), { kind: "month", year: 2027, month: 2 });
  // Not holidays: a flower, a thank-you, a medical test.
  for (const text of ["цагаан сараана", "Баярлалаа", "шинжилгээтэй аялал"]) assert.equal(detectHoliday(text), null, text);
  assert.equal(detectHoliday("Баярын өдрүүдээр аялмаар байна"), "unspecified");
});

test("a year whose Tsagaan Sar days are not published is never guessed", () => {
  assert.equal(resolveHoliday("2031 оны цагаан сараар аялал байна уу", now)?.status, "unknown");
  assert.deepEqual(requestedDepartureScope("2031 оны цагаан сараар аялал байна уу", now), { kind: "unsupported" });
  assert.equal(resolveHoliday("цагаан сараар аялал байна уу", new Date("2098-02-01T04:00:00Z"))?.status, "unknown");
  assert.equal(buildCatalogListingReply("цагаан сарын үеэр ямар аялалууд байна", catalog, new Date("2098-02-01T04:00:00Z"))?.reply, "REFER");
  assert.match(holidayPromptLine("2031 оны цагаан сар", now)!, /REFER/);
});

test("the holiday list holds the trips travelling over it, overlapping ones first, never November", () => {
  const listing = buildCatalogListingReply("Цагаан сарын үеэр ямар аялалууд байна?", catalog, now)!;
  assert.match(listing.reply, /^🌙 Цагаан сарын үеэр \(2027 оны 2 сарын 6–9 орчим\) аялах боломжтой аяллууд:/);
  assert.deepEqual(listing.listed.map((t) => t.id), ["over", "after"]);
  assert.doesNotMatch(listing.reply, /НОРВЕЛ|ДОРМАН|11\/20/, "no November departure, no summer trip");
  assert.equal(listing.authoritative, true);
  assert.equal(verifyTripReply({ reply: listing.reply, trips: listing.listed, now }), listing.reply, "the checker accepts it");
  // The original live message, typo and all.
  assert.deepEqual(buildCatalogListingReply("цагаан сарын үейр ямар аялалууд байна", catalog, now)!.listed.map((t) => t.id), ["over", "after"]);
});

test("a place named with the holiday narrows to that place; 'after' starts when the holiday ends", () => {
  const place = buildCatalogListingReply("Цагаан сараар Вэлмор явж болох уу?", catalog, now)!;
  assert.deepEqual(place.listed.map((t) => t.id), ["after"]);
  assert.match(place.reply, /Вэлмор чиглэлд/);
  const later = buildCatalogListingReply("Цагаан сарын дараа ямар аялал байна?", catalog, now)!;
  assert.deepEqual(later.listed.map((t) => t.id), ["after"], "the trip leaving before the holiday ends is not 'after'");
  const naadam = buildCatalogListingReply("Наадмын үеэр ямар аялал байна?", catalog, now)!;
  assert.deepEqual(naadam.listed.map((t) => t.id), ["summer"]);
  assert.match(naadam.reply, /📅 7\/9/);
  assert.doesNotMatch(naadam.reply, /8\/20/, "a departure outside the holiday window is not shown as one");
});

test("nothing over the holiday: said plainly, closest departures labelled, never as holiday trips", () => {
  const near = buildCatalogListingReply("Цагаан сараар Лумара явж болох уу?", [trip("x", "ЛУМАРА ХОТЫН АЯЛАЛ", ["2027-02-25"], { aliases: ["Лумара"] })], now)!;
  assert.match(near.reply, /^Одоогоор Цагаан сарын үеэр \(2027 оны 2 сарын 6–9 орчим\) Лумара чиглэлд гарах аялал хуваарьт алга байна\.\n\nГэхдээ ойролцоо өдрүүдэд гарах аяллууд:/);
  assert.match(near.reply, /2\/25/);
  const far = buildCatalogListingReply("Наадмын үеэр ямар аялал байна?", [november], now)!;
  assert.match(far.reply, /хуваарь одоогоор гараагүй байна/);
  // Changed 2026-11-11: November departures are months from Naadam; they are no longer listed as "the
  // closest" — the schedule is not out, and the website link is the whole answer.
  assert.doesNotMatch(far.reply, /хамгийн ойр гарах аяллууд|НОРВЕЛ|11\/15|11\/22/);
  assert.match(far.reply, /https:\/\/uudamtravel\.mn/);
  assert.doesNotMatch(far.reply, /ойролцоо өдрүүдэд/, "months away is not 'nearby'");
});

// Live 2026-11-04: a trip titled "<place> – … ШИНЭ ЖИЛИЙН АЯЛАЛ" was added, and "шинэ" in its
// title counted as a place the customer named, so the New Year list stopped being sent.
test("a trip named for New Year does not turn the New Year question into a place question", () => {
  const named = trip("ny", "ЗАНДАН – ДАМЖИН НИСЛЭГТЭЙ ШИНЭ ЖИЛИЙН АЯЛАЛ", ["2026-12-28"], { aliases: ["Зандан", "Шинэ жил", "Шинэ он"] });
  for (const text of ["Шинэ жилээр ямар аялал байна?", "Шинэ жилийн аялал", "shine jiliin ayalal haashaa be"]) {
    const listing = buildCatalogListingReply(text, [...catalog, named], now)!;
    assert.match(listing.reply, /^🎄 Шинэ жилийн үеэр гарах аяллууд/, text);
    assert.ok(listing.listed.some((t) => t.id === "ny"), `${text}: the New Year trip is in the New Year list`);
  }
});

test("the holiday greeting and an unnamed holiday are not answered with trips", () => {
  for (const text of ["Сар шинэдээ сайхан шинэлж байна уу", "Цагаан сарын мэнд хүргэе", "Сар шинийн мэнд"]) {
    assert.equal(buildCatalogListingReply(text, catalog, now), null, text);
  }
  const which = buildCatalogListingReply("Баярын өдрүүдээр аялмаар байна.", catalog, now)!;
  assert.match(which.reply, /^Аль баярын үеэр аялахыг хүсэж байна вэ\?/);
  assert.match(which.reply, /Цагаан сар — 2027 оны 2 сарын 6–9 орчим/);
  assert.equal(which.listed.length, 0);
});

test("the date path and the model's context read the holiday too", () => {
  const dated = buildDepartureDateAvailabilityReply({ userText: "Цагаан сараар гарах аялал байна уу", trips: catalog, now })!;
  assert.match(dated, /Цагаан сарын үеэр \(2027 оны 2 сарын 6–9 орчим\) гарах аяллууд байна/);
  assert.doesNotMatch(dated, /11 сарын/);
  assert.match(holidayPromptLine("цагаан сарын үеэр", now)!, /2027-02-06\.\.2027-02-09; matching departures are 2027-01-30\.\.2027-02-16/);
  // Only the bracket restating the holiday is dropped for the checker; a date the model states stays.
  assert.equal(withoutHolidaySpans("Цагаан сарын үеэр (2 сарын 6–9 орчим) гарна"), "Цагаан сарын үеэр   гарна");
  assert.equal(withoutHolidaySpans("Цагаан сарын үеэр 2 сарын 6-нд гарна"), "Цагаан сарын үеэр 2 сарын 6-нд гарна");
});
