import assert from "node:assert/strict";
import test, { before } from "node:test";
import { applyTestEnv } from "./helpers/env";
import { HOLIDAY_CATALOG, PRICE_NOISE_TRIPS, WEEKLY_TRIP, fixtureTrip } from "./helpers/holidayFixture";
import type { TravelTrip } from "../src/lib/travelTypes";

/**
 * The calendar / holiday / quoted-price decisions behind the holiday journeys
 * (tests/understanding-holiday-journeys.test.ts), as pure functions: the window a holiday means,
 * the year a customer states, a place no trip goes to, a party's fares by age, a quoted price.
 * Invented catalogue only (tests/helpers/holidayFixture.ts). Clock: early November 2026.
 */
const NOW = new Date("2026-11-06T04:00:00Z");
const catalogue = HOLIDAY_CATALOG as unknown as TravelTrip[];

let travelFastPaths: typeof import("../src/lib/travelFastPaths");
let catalogListing: typeof import("../src/lib/catalogListing");
let tripFareBlock: typeof import("../src/lib/tripFareBlock");
let holidayCalendar: typeof import("../src/lib/holidayCalendar");
let travelDates: typeof import("../src/lib/travelDates");
let pricing: typeof import("../src/lib/travelFastPathsPricing");
let verification: typeof import("../src/lib/tripReplyVerification");
before(async () => {
  applyTestEnv();
  travelFastPaths = await import("../src/lib/travelFastPaths");
  catalogListing = await import("../src/lib/catalogListing");
  tripFareBlock = await import("../src/lib/tripFareBlock");
  holidayCalendar = await import("../src/lib/holidayCalendar");
  travelDates = await import("../src/lib/travelDates");
  pricing = await import("../src/lib/travelFastPathsPricing");
  verification = await import("../src/lib/tripReplyVerification");
});

test("Tsagaan Sar 2027 stays 2027-02-06..09 and the search window is a week either side; a year past the table is unknown, never guessed", () => {
  const resolved = holidayCalendar.resolveHoliday("цагаан сарын үеэр", NOW);
  assert.equal(resolved?.status, "resolved");
  if (resolved?.status !== "resolved") return;
  assert.deepEqual(resolved.period, { startYmd: "2027-02-06", endYmd: "2027-02-09" });
  assert.deepEqual(resolved.window, ["2027-01-30", "2027-02-16"]);
  assert.match(resolved.phrase, /^Цагаан сарын үеэр \(2027 оны 2 сарын 6–9 орчим\)$/);
  const afterTheDays = holidayCalendar.resolveHoliday("цагаан сарын үеэр", new Date("2027-03-01T04:00:00Z"));
  assert.equal(afterTheDays?.status === "resolved" && afterTheDays.period.startYmd, "2028-02-24");
  assert.equal(holidayCalendar.resolveHoliday("2031 оны цагаан сар", NOW)?.status, "unknown");
});

test("a year the customer states is the year (also typed 'ионы'); an unstated month keeps rolling forward", () => {
  const month = (text: string) => travelDates.requestedDepartureScope(text, NOW);
  for (const text of ["2027 оны 2 сард", "2027 ионы 2-р сард аялах юмаа", "2027 оны 2 сард гарах уу", "2 сард явмаар байна"]) {
    assert.deepEqual(month(text), { kind: "month", year: 2027, month: 2 }, text);
  }
  // Asked in November 2026: "2027 оны 11 сард" is November 2027, not this month.
  assert.deepEqual(month("2027 оны 11 сард"), { kind: "month", year: 2027, month: 11 });
  assert.deepEqual(month("11 сард"), { kind: "month", year: 2026, month: 11 });
  assert.deepEqual(month("2026 оны 12 сард"), { kind: "month", year: 2026, month: 12 });
});

test("a relative year ('дараа жилийн') is a time word, so it cannot pick a trip whose title says 'жилийн'", () => {
  for (const text of ["Дараа жилийн 2 сард аялмаар байна", "ирэх оны 2 сард явъя", "daraa jiliin 2 sard yavmaar bna"]) {
    const cleaned = holidayCalendar.withoutHolidayNames(text);
    assert.doesNotMatch(cleaned, /жилийн|оны|jiliin/iu, cleaned);
  }
  // A year inside a place or a date is untouched.
  assert.match(holidayCalendar.withoutHolidayNames("Тарвия 2 сард"), /Тарвия 2 сард/u);
});

test("a place no catalogue trip goes to is found; ordinary date, party and verb words are not places", async () => {
  const { unknownPlaceTokens } = await import("../src/lib/placeLikeTokens");
  const unknown = (text: string) => unknownPlaceTokens(text, catalogue);
  for (const text of ["Шинэ жилээр Оролго явах аялал байна уу", "12 сард Оролго явах аялал байна уу", "Цагаан сараар Оролго явмаар байна",
    "12 сарын шинэ жилийн хөтөлбөртэй Оролгын аялал байна уу?", "Shine jileer Orolgo yavmaar bna"]) {
    assert.ok(unknown(text).length > 0, `a place nothing holds: ${text}`);
  }
  for (const text of ["2 сард явмаар байна", "тэгвэл цагаан сараар гарах уу", "2027 ионы 2-р сард аялах юмаа",
    "Он гараад цагаан сар тааруулсан ийм хөтөлбөртэй аялал гарах уу?", "Аяллыг 12 сарын 30-нд эхлээд шинэ он гарсны дараа буцахаар байна уу?",
    "2 том 2 хүүхэдтэй явбал нийт хэд вэ", "4 болон 7 настай хүүхэд төлбөр хэд вэ", "2027 оны цагаан сараар хүүхдүүдтэйгээ аялахад юу байна?",
    "Цагаан сарын үеэр ямар аялалууд байна", "Дараа жилийн 2 сард аялмаар байна",
    // A word of the catalogue is a destination the bot knows.
    "Цагаан сараар Тарвия явмаар байна", "Шинэ жилээр Пекара явах аялал байна уу"]) {
    assert.deepEqual(unknown(text), [], text);
  }
});

test("a time-only listing never drops a named place: an unknown one is REFER, a known one narrows the list", () => {
  const listing = (text: string) => catalogListing.buildCatalogListingReply(text, catalogue, NOW);
  for (const text of ["Шинэ жилээр Оролго явах аялал байна уу", "Цагаан сараар Оролго явмаар байна", "12 сард Оролго явах аялал байна уу",
    "12 сарын 30-нд шинэ жилээр Оролго явах аялал байна уу", "10 хоногийн Оролго аялал байна уу"]) {
    const answer = listing(text);
    assert.equal(answer?.reply, "REFER", text);
    assert.deepEqual(answer?.listed, [], text);
    assert.ok(answer?.unknownPlace?.length, `the listing says which word was the place: ${text}`);
  }
  const narrowed = listing("Шинэ жилээр Тарвия явах аялал бий юу");
  assert.ok(narrowed && narrowed.listed.length > 0 && narrowed.listed.every((trip) => /ТАРВИЯ/u.test(trip.route_name)), narrowed?.reply);
  // The kind of trip a listing is made of (sea, direct flight) is not an unknown place for the webhook.
  assert.equal(catalogListing.listingAnswersDespitePlace({ reply: "x", listed: [catalogue[0]], authoritative: true, kind: "category" }, "Оролго", "Оролго", catalogue), true);
  assert.equal(catalogListing.listingAnswersDespitePlace({ reply: "x", listed: [catalogue[0]], authoritative: true, kind: "time" }, "Оролго", "Шинэ жилээр Оролго явах", catalogue), false);
});

test("an ended trip is named from the part of its name the customer uses; a shared word or a generic question names none", () => {
  const ended = (id: string, name: string) => ({ ...fixtureTrip(id, name, ["2026-10-01"], [1_000_000, null, null]), status: "archived",
    extra: { customer_visible: true, archived_reason: "all_departure_dates_passed" } }) as unknown as TravelTrip;
  const archived = [ended("a1", "ВОРНЕЛ МАНЗЕРИЙН АЯЛАЛ"), ended("a2", "ВОРНЕЛ ЧИРОНИЙН АЯЛАЛ")];
  for (const text of ["Манзерийн аялал байна уу?", "Манзер аялал", "манзерийн шинэ жилийн хөтөлбөртэй аялал"]) {
    assert.equal(travelFastPaths.buildArchivedTripNotice(text, archived)?.trip.id, "a1", text);
  }
  for (const text of ["Ворнел аялал байна уу", "Үнэ хэд вэ", "Ормелийн аялал", "шинэ жилийн аялал"]) {
    assert.equal(travelFastPaths.buildArchivedTripNotice(text, archived), null, text);
  }
  const unknown = catalogListing.withEndedTripNotice({ reply: "REFER", listed: [], authoritative: true, unknownPlace: ["манзерийн"], kind: "time" }, "Шинэ жилээр Манзерийн аялал байна уу", archived);
  assert.match(unknown.reply, /ВОРНЕЛ МАНЗЕРИЙН АЯЛАЛ аяллын бүх гарах өдөр өнгөрсөн/u);
  const stillUnknown = catalogListing.withEndedTripNotice({ reply: "REFER", listed: [], authoritative: true, unknownPlace: ["оролго"], kind: "time" }, "Шинэ жилээр Оролго аялал", archived);
  assert.equal(stillUnknown.reply, "REFER");
});

test("a holiday list puts the trips on the road over the holiday first, the one named for it before the rest, and no check-up trip unless asked", () => {
  const answer = catalogListing.buildCatalogListingReply("Шинэ жилийн аялал", catalogue, NOW);
  assert.ok(answer);
  assert.equal(answer.listed[0].id, "sanvia-ny", "the trip named for New Year comes first");
  assert.ok(answer.listed.every((trip) => trip.id !== "hortan-check"), "a medical check-up trip is not a family New Year trip");
  assert.match(answer.reply, /✅ Шинэ жилийн өдрүүдийг хамарна/u);
  // Only the days that touch the holiday are printed for a trip that has any.
  const dates = (id: string) => answer.reply.split("\n\n").find((card) => card.includes(catalogue.find((trip) => trip.id === id)!.route_name))?.match(/📅 (.*)/u)?.[1];
  assert.equal(dates("velmora"), "12/29");
  // Asked for, the check-up trips are the list.
  const checkup = catalogListing.buildCatalogListingReply("Шинэ жилийн шинжилгээтэй аялал байна уу", catalogue, NOW);
  assert.deepEqual(checkup?.listed.map((trip) => trip.id), ["hortan-check"]);
});

test("'after' and 'before' a holiday read their own window, and a holiday with nothing in it prints the departures nearest to it", () => {
  const listing = (text: string) => catalogListing.buildCatalogListingReply(text, catalogue, NOW);
  const after = listing("Цагаан сарын дараа Тарвия явах аялал байна уу")!;
  assert.match(after.reply, /^🌙 Цагаан сарын дараа \(/u);
  assert.deepEqual(after.listed.map((trip) => trip.id).sort(), ["tarvia-a", "tarvia-b"]);
  assert.doesNotMatch(after.reply, /📅 [^\n]*(?:11\/|12\/)/u, `no November or December date: ${after.reply}`);
  const before = listing("Цагаан сарын өмнө Тарвия явах аялал байна уу")!;
  assert.deepEqual(before.listed.map((trip) => trip.id), ["tarvia-a"]);
  assert.match(before.reply, /📅 1\/30/u);
  // Nothing over Naadam: the window is named, the schedule "not out yet", and the dates are the ones nearest to July.
  const naadam = listing("Наадмаар Пекара явах аялал байна уу")!;
  assert.match(naadam.reply, /^Наадмын үеэр \(2027 оны 7 сарын 11–15\) Пекара чиглэлд гарах аяллын хуваарь одоогоор гараагүй байна/u);
  assert.match(naadam.reply, /1\/10/u, "the departure nearest to July is January's");
  // Close to the holiday it is "nearby dates", not months away.
  const near = catalogListing.buildCatalogListingReply("Цагаан сарын үеэр Пекара явах аялал байна уу", [
    fixtureTrip("near", "ПЕКАРА - БЛИЖНИЙ АЯЛАЛ", ["2027-02-20"], [1_000_000, null, null]) as unknown as TravelTrip], NOW)!;
  assert.match(near.reply, /^Одоогоор Цагаан сарын үеэр \(2027 оны 2 сарын 6–9 орчим\) Пекара чиглэлд гарах аялал хуваарьт алга байна\.\n\nГэхдээ ойролцоо өдрүүдэд гарах аяллууд:/u);
});

test("a date typed beside a holiday is the window ('12 сарын 30-нд … шинэ он гарсны дараа буцах'), narrowed to the place named", () => {
  const listing = (text: string) => catalogListing.buildCatalogListingReply(text, catalogue, NOW)!;
  const trips = listing("Аяллыг 12 сарын 30-нд эхлээд шинэ он гарсны дараа буцахаар байна уу?");
  assert.match(trips.reply, /^12 сарын 30-нд гарах аяллууд/u);
  assert.deepEqual(trips.listed.map((trip) => trip.id).sort(), ["pekara-air", "sanvia-ny"]);
  const placed = listing("12 сарын 30-нд Пекара шинэ жилээр явмаар байна");
  assert.deepEqual(placed.listed.map((trip) => trip.id), ["pekara-air"]);
});

test("a party named by ages is priced per trip through each trip's age bands; a child of 13 pays the adult fare; no band is not invented", () => {
  const noBand = fixtureTrip("noband", "ФОРТАН - ЛЕВИР АЯЛАЛ", ["2026-12-29"], [3_000_000, 2_500_000, null], { extra: { customer_visible: true } }) as unknown as TravelTrip;
  const listed = [catalogue.find((trip) => trip.id === "sanvia-ny")!, catalogue.find((trip) => trip.id === "velmora")!, noBand];
  const ages = travelFastPaths.buildAmbiguousPassengerTotalReply("4 bolon 7 nastai huuhed tulbur hed ve?", listed, NOW)!;
  assert.match(ages, /• САНВИЯ - ХОРТ НИСЛЭГТЭЙ ШИНЭ ЖИЛИЙН АЯЛАЛ: 2 хүүхэд \/2-11 нас\/ x 3,990,000₮/u);
  assert.match(ages, /• ВЕЛМОРА — ДОРНАН АЯЛАЛ: 2 хүүхэд \/2-11 нас\/ x 4,490,000₮/u);
  assert.match(ages, /• ФОРТАН - ЛЕВИР АЯЛАЛ: 2 хүүхэд x 2,500,000₮/u, "a trip with no age band keeps its own fare, with no band");
  assert.doesNotMatch(ages, /Нийт|2 том/u, "children alone have no family total");
  assert.match(ages, /Аль аялал вэ\?$/u);
  const teen = travelFastPaths.buildAmbiguousPassengerTotalReply("хүүхэд 13 настай үнэ хэд вэ", listed, NOW)!;
  assert.match(teen, /1 том хүн \/12\+ нас\/ x 4,290,000₮/u);
  const family = travelFastPaths.buildAmbiguousPassengerTotalReply("2 том 2 хүүхэдтэй явбал нийт хэд вэ", listed, NOW)!;
  assert.match(family, /16,560,000₮ \(2 том хүн \/12\+ нас\/ x 4,290,000₮ \+ 2 хүүхэд \/2-11 нас\/ x 3,990,000₮\)/u);
  // No party in the message: no per-party answer.
  assert.equal(travelFastPaths.buildAmbiguousPassengerTotalReply("хэзээ гарах вэ", listed, NOW), null);
  for (const reply of [ages, teen, family]) assert.equal(verification.verifyTripReply({ reply, trips: listed, now: NOW }), reply);
});

test("a quoted price is parsed however it is written", () => {
  const price = pricing.extractNormalizedPrice;
  for (const [text, expected] of [["990000 geed bga yum", 990_000], ["990k", 990_000], ["990К", 990_000], ["990 мянга", 990_000], ["990 мянгатай аялал байна уу", 990_000],
    ["990,000₮", 990_000], ["1 сая", 1_000_000], ["1 саяын аялал байна уу", 1_000_000], ["1 сая орчим", 1_000_000], ["3 сая 990", 3_990_000], ["1.2 сая", 1_200_000]] as const) {
    assert.equal(price(text), expected, text);
  }
  for (const text of ["990k", "990К", "990 мянгатай аялал байна уу", "1 сая орчим", "1 саяын аялал байна уу", "990000 geed bga yum", "990 мянга орчим", "990 мянган төгрөгийн аялал"]) {
    assert.ok(travelFastPaths.isBarePriceMessage(text), text);
  }
  // Anything else around the number is a different message.
  for (const text of ["Тарвия 990k", "2 хүн 990k", "990k төлсөн", "990k шилжүүлсэн", "99 мянга"]) assert.ok(!travelFastPaths.isBarePriceMessage(text), text);
});

test("a quoted price lists trips whose ADULT fare is that price: not child or infant lines that end in it, and weekday-schedule trips count", () => {
  const trips = [...catalogue, WEEKLY_TRIP, ...PRICE_NOISE_TRIPS] as unknown as TravelTrip[];
  const found = tripFareBlock.tripsAtPrice(trips, 990_000, NOW);
  assert.deepEqual(found.map((row) => row.trip.id), ["jorvin"], "the adult fare only");
  assert.equal(found[0].label, "Том хүн");
  const weekly = tripFareBlock.tripsAtPrice(trips, 880_000, NOW);
  assert.deepEqual(weekly.map((row) => row.trip.id), ["kordan-weekly"]);
  assert.equal(weekly[0].schedule, "Пүрэв, Ням гариг");
  const reply = travelFastPaths.buildBarePriceOrBudgetReply("990k", trips, NOW)!;
  assert.match(reply, /^990,000₮ үнэтэй тохирох аяллууд:/u);
  assert.match(reply, /ЖОРВИН-МИНИ ВАЛДА-ХОРТАН ХОТЫН АЯЛАЛ/u);
  assert.doesNotMatch(reply, /ЛОРНАН/u);
  assert.match(reply, /Зарын постер эсвэл линкээ илгээвэл яг аль аялал болохыг баталгаажуулъя\./u, "it does not claim to know which advert the price came from");
  assert.equal(verification.verifyTripReply({ reply, trips, now: NOW }), reply);
  assert.match(travelFastPaths.buildBarePriceOrBudgetReply("880 мянга", trips, NOW)!, /КОРДАН - МИРЕЛ[^\n]*гарах: Пүрэв, Ням гариг/u);
});

test("a price no trip sells exactly is read as a budget; a number far above any fare (a phone number) is no price", () => {
  const trips = [...catalogue, WEEKLY_TRIP as unknown as TravelTrip];
  const budget = travelFastPaths.buildBarePriceOrBudgetReply("1 саяын аялал байна уу", trips, NOW)!;
  assert.match(budget, /^Таны хэлсэн 1 сая төгрөгтэй яг таарах аялал олдсонгүй\. 1 сая төгрөг хүртэлх аяллууд:/u);
  assert.match(budget, /ЖОРВИН-МИНИ ВАЛДА-ХОРТАН ХОТЫН АЯЛАЛ — Том хүн 990,000₮/u);
  assert.match(budget, /КОРДАН - МИРЕЛ[^\n]*Том хүн 880,000₮/u);
  assert.doesNotMatch(budget, /үнэтэй тохирох/u, "not presented as the advertised package");
  assert.equal(verification.verifyTripReply({ reply: budget, trips, now: NOW }), budget);
  assert.equal(travelFastPaths.buildBarePriceOrBudgetReply("1 сая орчим", trips, NOW), budget);
  assert.equal(travelFastPaths.buildBarePriceOrBudgetReply("700k", trips, NOW), null, "nothing at or under 700 мянга");
  assert.equal(travelFastPaths.buildBarePriceOrBudgetReply("99168432", trips, NOW), null);
  // A full digit string typed like an advert's price is not read as a budget (tests/forensic-regressions.test.ts).
  assert.equal(travelFastPaths.buildBarePriceOrBudgetReply("1234567 geed bga yum", trips, NOW), null);
  assert.equal(travelFastPaths.buildBarePriceOrBudgetReply("1,200,000", trips, NOW), null);
  assert.match(travelFastPaths.buildBarePriceOrBudgetReply("1.2 сая", trips, NOW)!, /^Таны хэлсэн 1\.2 сая төгрөгтэй/u);
  // The exact-only builder is unchanged: it never guesses.
  assert.equal(travelFastPaths.buildBarePriceReply("1,234,567", trips), null);
});

test("the date window an earlier turn asked for is inherited by a later turn that names only a place", async () => {
  const { getInheritedDateScope } = await import("../src/lib/inheritedDateScope");
  const list = ["🌙 Цагаан сарын үеэр (2027 оны 2 сарын 6–9 орчим) аялах боломжтой аяллууд:", "", "1. ТАРВИЯ АЯЛАЛ — ЛУМАР, ВЕЛНА", "📅 2/6", "", "2. ВЕЛМОРА — ДОРНАН АЯЛАЛ", "📅 2/6"].join("\n");
  const history = (user: string, reply: string) => [{ role: "user" as const, text: user }, { role: "assistant" as const, text: reply }];
  const inherited = getInheritedDateScope({ history: history("Цагаан сараар явмаар байна", list), trips: catalogue, now: NOW });
  assert.equal(inherited?.scope.kind, "range");
  assert.equal(inherited?.text, "Цагаан сараар явмаар байна");
  const month = getInheritedDateScope({ history: history("2 сард явмаар байна", list), trips: catalogue, now: NOW });
  assert.deepEqual(month?.scope, { kind: "month", year: 2027, month: 2 });
  // Told "nothing then", the customer's next pick drops the window; a place nothing holds was never answered with a list.
  assert.equal(getInheritedDateScope({ history: history("Цагаан сараар явмаар байна", "Тэр хугацаанд гарах аялал алга. Гарах өдрүүд:\n• ТАРВИЯ: 2 сарын 6"), trips: catalogue, now: NOW }), null);
  assert.equal(getInheritedDateScope({ history: history("Цагаан сараар Оролго явмаар байна", list), trips: catalogue, now: NOW }), null);
  assert.equal(getInheritedDateScope({ history: [], trips: catalogue, now: NOW }), null);
});
