import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { AIChangeProposal } from "../src/lib/travelTypes";

applyTestEnv();

// The review of a new trip read from a file (2026-11-05). Every place, price and
// date below is invented; "now" is fixed far ahead so nothing depends on today.
const NOW = new Date("2098-03-01T04:00:00Z");
const ROUTE = "НОРВЕЛ ХОТЫН АЯЛАЛ";
type Row = Record<string, unknown>;

/** A partner's program: three days from the border town and back, dated day by day. */
import { itineraryOf } from "../src/lib/tripReview";
const borderProgram = () => [
  { day: 1, date: "5/12", title: "ЭРЭЭН – НОРВЕЛ", description: "Эрээн авто вокзал дээр аялагчдыг тосно. Норвел хотоос 22:05 цагт нисээд бууна.", meals: { breakfast: null, lunch: true, dinner: false }, meal_note: "Буфет — Лумиа хоолны газар" },
  { day: 2, date: "5/13", title: "НОРВЕЛ ХОТ", description: "Лумиа гүүр, хуучин хороолол.", hotel: "Норвел 4* буудал", meals: { breakfast: true, lunch: false, dinner: false } },
  { day: 3, date: "5/14", title: "НОРВЕЛ – ЭРЭЭН", description: "Өглөө нисээд Эрээнд ирнэ.", meals: { breakfast: true, lunch: null, dinner: null } },
];
const tripFields = (overrides: Row = {}, extra: Row = {}): Row => ({
  route_name: ROUTE, operator_name: "Fixture Travel", duration_text: "3 өдөр 2 шөнө", currency: "MNT",
  departure_dates: ["5 сарын 11"], adult_price: null, child_price: null,
  photo_urls: ["https://res.cloudinary.com/fixture/a.jpg", "https://res.cloudinary.com/fixture/b.jpg"],
  extra: {
    itinerary_days: borderProgram(),
    photo_credits: { "https://res.cloudinary.com/fixture/a.jpg": { title: "Lumia bridge", author: "Vel Mor", license: "CC0", page: "https://commons.example.test/a" } },
    source_evidence: { departure: "5-р сарын 11-нд хөдөлнө", duration: "Нийт: 2 шөнө / 3 өдөр" },
    ...extra,
  },
  ...overrides,
});
const proposalOf = (fields: Row): AIChangeProposal => ({
  summary: "", needs_confirmation: false, important_reason: "", conflicts: [], conflict_items: [],
  actions: [{ action: "upsert", fields: fields as never }],
});

test("departure dates become calendar days; a weekly rule stays as written", async () => {
  const { departureDays, formatYmd, weekdayOf, addDaysYmd } = await import("../src/lib/tripReview");
  const { days, other } = departureDays(["5 сарын 11", "2098-06-01", "1 сарын 9", "Пүрэв гараг бүр", "5 сарын 11"], NOW);
  assert.deepEqual(days, ["2098-05-11", "2098-06-01", "2099-01-09"], "a date that already passed this year is next year's");
  assert.deepEqual(other, ["Пүрэв гараг бүр"]);
  assert.equal(formatYmd("2098-05-11", NOW), "5-р сарын 11");
  assert.equal(formatYmd("2099-01-09", NOW), "2099 оны 1-р сарын 9", "another year is always named");
  assert.equal(weekdayOf("2098-05-11"), "Ням");
  assert.equal(addDaysYmd("2098-12-31", 1), "2099-01-01");
});

test("each meal of each day is included, own cost or not stated; the trip flag follows the days", async () => {
  const { dayMeals, deriveHasFood, nextMealState } = await import("../src/lib/tripReview");
  assert.deepEqual(dayMeals({ meals: { breakfast: true, lunch: false } }), { breakfast: true, lunch: false, dinner: null });
  assert.deepEqual([true, false, null].map(nextMealState), [false, null, true], "one click: included → own cost → not stated → included");
  assert.equal(deriveHasFood(borderProgram()), true);
  assert.equal(deriveHasFood([{ meals: { breakfast: false, lunch: false, dinner: null } }]), false, "stated, none included");
  assert.equal(deriveHasFood([{ meals: {} }, {}]), null, "a program silent about meals is unknown, never 'no meals'");
});

test("a border-start program gains the standard days; another transport takes them off again", async () => {
  const { applyTransport, itineraryOf, transportOf } = await import("../src/lib/tripReview");
  const { isTransitDay } = await import("../src/lib/tripTransitDays");
  const land = applyTransport(tripFields(), "land_flight");
  assert.deepEqual([land.added, land.programDays, land.fields.duration_text], [2, 3, "5 өдөр 4 шөнө"]);
  assert.deepEqual(itineraryOf(land.fields).map(isTransitDay), [true, false, false, false, true]);
  assert.equal(itineraryOf(land.fields)[1].date, "5/12", "the day's own date travels with it");
  const flight = applyTransport(land.fields, "direct_flight");
  assert.deepEqual([flight.added, itineraryOf(flight.fields).length, flight.fields.duration_text], [0, 3, "3 өдөр 2 шөнө"], "the program's own length comes back");
  assert.equal(transportOf(flight.fields), "direct_flight");
  const again = applyTransport(flight.fields, "land");
  assert.deepEqual([again.added, again.fields.duration_text], [2, "5 өдөр 4 шөнө"], "switching back never stacks a second set of days");
});

test("the departure is checked against the dates the file writes beside its own days", async () => {
  const { applyTransport, checkDeparture, itineraryOf } = await import("../src/lib/tripReview");
  const days = itineraryOf(applyTransport(tripFields(), "land_flight").fields);
  assert.deepEqual(checkDeparture(["2098-05-11"], days), { kind: "consistent", departure: "2098-05-11", programStart: "2098-05-12" },
    "the train leaves Ulaanbaatar the evening before the first program day");
  assert.deepEqual(checkDeparture(["2098-05-12"], days), { kind: "shift", departure: "2098-05-12", suggested: "2098-05-11", programStart: "2098-05-12" },
    "the 'departure' is the first day at the border: the admin is offered the day before, never moved silently");
  assert.deepEqual(checkDeparture(["2098-05-20"], days), { kind: "conflict", departure: "2098-05-20", programStart: "2098-05-12", expected: "2098-05-21" });
  assert.equal(checkDeparture(["2098-05-25", "2098-05-11"], days).kind, "consistent", "one departure matching the dated program is enough");
  assert.equal(checkDeparture(["2098-05-11"], days.map((day) => ({ ...day, date: "" }))).kind, "unknown", "no dates beside the days: nothing is claimed");
  assert.equal(checkDeparture([], days).kind, "unknown");
  const flightDays = itineraryOf(applyTransport(tripFields(), "direct_flight").fields);
  assert.equal(checkDeparture(["2098-05-12"], flightDays).kind, "consistent", "a flight leaves on its first program day");
});

test("a program dated across New Year is read in the right year", async () => {
  const { programDayDate } = await import("../src/lib/tripReview");
  assert.equal(programDayDate("1/02", "2098-12-30"), "2099-01-02");
  assert.equal(programDayDate("12 сарын 31", "2098-12-30"), "2098-12-31");
  assert.equal(programDayDate("2099.01.03", "2098-12-30"), "2099-01-03");
  assert.equal(programDayDate("27", "2098-12-27"), null, "a day number alone is not a date");
});

test("the stated length is compared with the program's days; the admin can take the program's", async () => {
  const { checkDuration, withProgramDuration, applyTransport } = await import("../src/lib/tripReview");
  assert.equal(checkDuration(tripFields()).kind, "consistent", "the evidence line says 3 days and the program has 3");
  const wrong = tripFields({ duration_text: "5 өдөр 4 шөнө" }, { program_duration_text: "4 ШӨНӨ 5 ӨДРИЙН аялал" });
  const check = checkDuration(wrong);
  assert.deepEqual([check.kind, check.kind === "mismatch" && check.writtenDays, check.kind === "mismatch" && check.programDays], ["mismatch", 5, 3]);
  const fixed = withProgramDuration(wrong);
  assert.deepEqual([fixed.duration_text, checkDuration(fixed).kind], ["3 өдөр 2 шөнө", "consistent"]);
  assert.equal(checkDuration(applyTransport(tripFields(), "land_flight").fields).kind, "consistent", "standard days are not counted against the file's length");
  assert.equal(checkDuration(tripFields({}, { itinerary_days: [], source_evidence: {} })).kind, "unknown");
});

test("what is missing: a name stops saving, dates stop publishing, a price stops nothing", async () => {
  const { applyTransport, reviewIssues } = await import("../src/lib/tripReview");
  const ready = applyTransport(tripFields(), "land_flight").fields;
  assert.deepEqual(reviewIssues(ready, NOW).map((issue) => [issue.key, issue.blocks]), [["price", null]]);
  assert.deepEqual(reviewIssues({ ...ready, adult_price: 3_290_000 }, NOW), []);
  assert.deepEqual(reviewIssues({ ...ready, route_name: " " }, NOW)[0], { key: "name", text: "Аяллын нэр хоосон байна.", blocks: "save" });
  assert.equal(reviewIssues({ ...ready, departure_dates: [] }, NOW).find((issue) => issue.key === "dates")?.blocks, "publish");
  assert.equal(reviewIssues({ ...ready, departure_dates: ["2098-02-01"] }, NOW).find((issue) => issue.key === "past_dates")?.blocks, "publish");
  assert.equal(reviewIssues({ ...ready, departure_dates: ["Пүрэв гараг бүр"] }, NOW).some((issue) => issue.blocks === "publish"), false, "a weekly schedule is a departure");
  assert.equal(reviewIssues(tripFields(), NOW).find((issue) => issue.key === "boundary")?.blocks, "save",
    "a program that never leaves from Ulaanbaatar is said before the save, not as an error after it");
  const perDate = { ...ready, extra: { ...(ready.extra as Row), departure_date_groups: [{ dates: ["5 сарын 11"], adult_price: 3_590_000 }] } };
  assert.equal(reviewIssues(perDate, NOW).some((issue) => issue.key === "price"), false, "a trip priced per date is priced");
});

test("the reviewed trip is saved as shown: draft or published, unknown never zero, review-only evidence left out", async () => {
  const { applyTransport, reviewedFields, itineraryOf } = await import("../src/lib/tripReview");
  const shown = applyTransport(tripFields({ adult_price: 0, child_price: undefined, infant_price: 0, departure_dates: ["5 сарын 11", "Пүрэв гараг бүр"] }), "land_flight").fields;
  const draft = reviewedFields(shown, "draft", NOW);
  assert.equal(draft.status, "draft");
  assert.deepEqual([draft.adult_price, draft.child_price, draft.infant_price], [null, null, 0], "an unknown price is empty, a free infant stays free");
  assert.deepEqual(draft.departure_dates, ["2098-05-11", "Пүрэв гараг бүр"], "calendar days are saved with their year");
  const extra = draft.extra as Row;
  assert.ok(!("source_evidence" in extra) && !("program_duration_text" in extra), "quotes and working values are not trip data");
  const days = itineraryOf(draft);
  assert.ok(days.every((day) => !("date" in day)), "a day's date belongs to one departure, not to the trip");
  assert.deepEqual(days[1].meals, { breakfast: null, lunch: true, dinner: false }, "'not stated' survives the save");
  assert.equal(days[1].meal_note, "Буфет — Лумиа хоолны газар");
  assert.equal(draft.has_food, true);
  assert.equal(reviewedFields(shown, "publish", NOW).status, "active");
  assert.equal((shown.extra as Row).source_evidence !== undefined, true, "the review itself keeps its evidence");
});

test("per-date fares follow the calendar: a removed day takes its fare, the 'from' price is the lowest row", async () => {
  const { priceRows, reviewedFields, setDepartureDays, departureDays } = await import("../src/lib/tripReview");
  const fields = tripFields({ departure_dates: ["5 сарын 11", "5 сарын 18", "6 сарын 1"] }, { departure_date_groups: [
    { label: "A", dates: ["5 сарын 11", "5 сарын 18"], adult_price: 3_590_000, child_price: 3_260_000, date_keys: ["5/11", "5/18"] },
    { label: "B", dates: ["6 сарын 1"], adult_price: 3_390_000, passenger_prices: [{ label: "Хүүхэд 2–5 нас", price: 2_730_000 }, { label: "Нярай", price: 0 }] },
  ] });
  const rows = priceRows(fields, NOW);
  assert.deepEqual(rows.map((row) => [row.dates.join(","), row.adult, row.child]), [["2098-05-11,2098-05-18", 3_590_000, 3_260_000], ["2098-06-01", 3_390_000, null]]);
  assert.deepEqual(rows[1].bands, [{ label: "Хүүхэд 2–5 нас", price: 2_730_000 }, { label: "Нярай", price: 0 }]);
  const fewer = setDepartureDays(fields, ["2098-05-18", "2098-06-08"], NOW);
  assert.deepEqual(departureDays(fewer.departure_dates, NOW).days, ["2098-05-18", "2098-06-08"], "a day added on the calendar is a departure too");
  const groups = (fewer.extra as Row).departure_date_groups as Row[];
  assert.deepEqual(groups.map((group) => group.dates), [["5 сарын 18"]], "the fare of a removed day is gone; a row left without days goes with it");
  const saved = reviewedFields(fields, "publish", NOW);
  assert.deepEqual([saved.adult_price, saved.child_price], [3_390_000, null], "the lowest adult fare, and only that row's child fare");
  assert.deepEqual(((saved.extra as Row).departure_date_groups as Row[])[0].dates, ["2098-05-11", "2098-05-18"], "fares carry the same calendar days as the trip");
});

test("a photo can be removed or made the cover, and keeps its credit", async () => {
  const { makeCover, removePhoto, tripPhotos } = await import("../src/lib/tripReview");
  const fields = tripFields({}, { itinerary_days: borderProgram().map((day, index) => (index === 1 ? { ...day, photo: "https://res.cloudinary.com/fixture/b.jpg" } : day)) });
  assert.deepEqual(tripPhotos(fields).map((photo) => [photo.url.slice(-5), photo.day, photo.author]), [["a.jpg", null, "Vel Mor"], ["b.jpg", 2, ""]]);
  const covered = makeCover(fields, "https://res.cloudinary.com/fixture/b.jpg");
  assert.equal((covered.photo_urls as string[])[0], "https://res.cloudinary.com/fixture/b.jpg");
  const removed = removePhoto(fields, "https://res.cloudinary.com/fixture/b.jpg");
  assert.deepEqual(removed.photo_urls, ["https://res.cloudinary.com/fixture/a.jpg"]);
  assert.equal(tripPhotos(removed).length, 1, "off the gallery and off its day");
  assert.equal(Object.keys(((removePhoto(fields, "https://res.cloudinary.com/fixture/a.jpg").extra as Row).photo_credits as Row)).length, 0, "its credit goes with it");
});

test("the save request carries the reviewed proposal; an unreviewed one sends only its id", async () => {
  const { proposalApplyBody, reviewedProposal, applyFailureText, applyCanRetry } = await import("../src/lib/adminProposalApply");
  const { applyTransport } = await import("../src/lib/tripReview");
  const stored = { ...proposalOf(tripFields()), actions: [...proposalOf(tripFields()).actions, { action: "patch", trip_id: "trip-1", fields: { adult_price: 1_111_111 } }] } as never;
  const edited = applyTransport(tripFields({ route_name: "НОРВЕЛ — ЗАССАН НЭР", adult_price: 3_290_000 }), "land_flight").fields;
  const reviewed = reviewedProposal(stored, { 0: edited }, "draft", NOW);
  assert.deepEqual([reviewed.actions[0].fields?.route_name, reviewed.actions[0].fields?.status, reviewed.actions[0].fields?.adult_price], ["НОРВЕЛ — ЗАССАН НЭР", "draft", 3_290_000]);
  assert.deepEqual(reviewed.actions[1], { action: "patch", trip_id: "trip-1", fields: { adult_price: 1_111_111 } }, "a change to an existing trip is not touched by the review");
  const message = { id: "m", requestId: 7, proposal: reviewed, instruction: "[File] x.docx", reviewed: true } as never;
  const body = proposalApplyBody(message, "session-1");
  assert.deepEqual([body.request_id, body.apply, body.confirm, body.session_id], [7, true, true, "session-1"]);
  assert.equal(body.proposal_edit, reviewed, "what the admin corrected is what the server receives");
  assert.equal("proposal_edit" in proposalApplyBody({ id: "m", requestId: 7, proposal: stored, instruction: "" } as never, "s"), false);
  assert.equal(proposalApplyBody({ id: "m", requestId: null, proposal: reviewed, instruction: "i" } as never, "s").proposal_direct, reviewed);
  assert.equal(applyFailureText({ message: "Some actions failed.", results: ["«A»: нэг", "«B»: хоёр"] }), "«A»: нэг\n«B»: хоёр");
  assert.deepEqual([applyCanRetry(409, { retry: true }), applyCanRetry(409, {}), applyCanRetry(500, {})], [true, false, true]);
});

test("a reviewed draft passes the save checks unchanged; a program that cannot be saved is refused before anything is written", async () => {
  const { reviewedProposal } = await import("../src/lib/adminProposalApply");
  const { applyTransport } = await import("../src/lib/tripReview");
  const { validateAIChangeProposal } = await import("../src/lib/travelAIValidation");
  const { newTripSaveProblems } = await import("../src/lib/travelAIApply");
  const { cleanFields } = await import("../src/lib/travelDb");
  const { normalizeExtra } = await import("../src/lib/tripExtraSchema");
  const shown = applyTransport(tripFields(), "land_flight").fields;
  const reviewed = reviewedProposal(proposalOf(tripFields()) as never, { 0: shown }, "draft", NOW);
  const validation = validateAIChangeProposal(reviewed as never, [], { now: NOW });
  assert.deepEqual(validation.blocking_conflicts, []);
  const action = validation.proposal.actions[0];
  assert.deepEqual([action.action, action.fields?.status, action.fields?.adult_price, action.fields?.departure_dates], ["upsert", "draft", null, ["2098-05-11"]],
    "a draft without a price is saved as one; nothing turns it active or archives it");
  assert.deepEqual(newTripSaveProblems(validation.proposal), []);
  // The row upsertTrip builds from it: meals keep "not stated", the note stays, working keys are gone.
  const stored = normalizeExtra(cleanFields(action.fields!, true).extra as Row).extra;
  const days = stored.itinerary_days as Row[];
  assert.equal(days.length, 5);
  assert.deepEqual([days[1].meals, days[1].meal_note], [{ breakfast: null, lunch: true, dinner: false }, "Буфет — Лумиа хоолны газар"]);
  assert.ok(!("date" in days[1]) && !("source_evidence" in stored) && !("program_duration_text" in stored));
  assert.equal(stored.transport_type, "land_flight");

  const unsaveable = reviewedProposal(proposalOf(tripFields()) as never, {}, "draft", NOW);
  const problems = newTripSaveProblems(validateAIChangeProposal(unsaveable as never, [], { now: NOW }).proposal);
  assert.equal(problems.length, 2, "start and end are both named");
  assert.ok(problems.every((problem) => problem.startsWith(`«${ROUTE}»: `)), "each problem names its trip");
});

test("reading a file: no blanket date warning, a real shift is offered, quotes are kept only when the file has them", async () => {
  const { finalizeNewTripActions, keptEvidence } = await import("../src/lib/tripProposalFinalize");
  const { DEPARTURE_CONFLICT, DEPARTURE_SHIFT } = await import("../src/lib/tripReview");
  const { TRANSPORT_CHOICE } = await import("../src/lib/tripTransitDays");
  const { buildProposalClarifications } = await import("../src/lib/adminProposalUtils");
  const source = "НОРВЕЛ ХОТЫН АЯЛАЛ\n5-р сарын 11-нд хөдөлнө\nНийт: 2 шөнө / 3 өдөр\n1-р өдөр | Эрээн – Норвел 5/12";

  const consistent = proposalOf(tripFields({ adult_price: 3_290_000 }, { website_summary: "Аялал 5-р сарын 11-нд эхэлж Эрээнд дуусна.",
    source_evidence: { departure: "5-р сарын 11-нд хөдөлнө", duration: "Нийт: 2 шөнө / 3 өдөр", meals: "Өглөө бүр буфет" } }));
  await finalizeNewTripActions(consistent, { sourceText: source, now: NOW });
  const types = consistent.conflict_items!.map((item) => item.type);
  assert.ok(!types.includes("dates_check") && !types.includes(DEPARTURE_SHIFT) && !types.includes(DEPARTURE_CONFLICT), "dates that agree raise nothing");
  const extra = consistent.actions[0].fields!.extra as Row;
  assert.deepEqual(extra.source_evidence, { departure: "5-р сарын 11-нд хөдөлнө", duration: "Нийт: 2 шөнө / 3 өдөр" }, "a quote the file does not contain is dropped");
  assert.equal(extra.website_summary, "", "a summary that only restates the schedule is not a summary");
  assert.equal(consistent.actions[0].fields!.has_food, true);
  assert.deepEqual((extra.itinerary_days as Row[])[2].meals, { breakfast: true, lunch: false, dinner: false });
  assert.deepEqual((extra.itinerary_days as Row[])[3].meals, { breakfast: true, lunch: null, dinner: null }, "'not stated' is kept per meal");
  const transport = consistent.conflict_items!.find((item) => item.type === TRANSPORT_CHOICE);
  assert.match(transport!.text, /3 өдөр 2 шөнө.*5 өдөр 4 шөнө/, "the note says what the file had and what it became");
  assert.deepEqual(buildProposalClarifications(consistent as never), [], "transport is a switch in the review, not a question");

  const shifted = proposalOf(tripFields({ departure_dates: ["5 сарын 12"] }));
  await finalizeNewTripActions(shifted, { sourceText: source, now: NOW });
  const shift = shifted.conflict_items!.find((item) => item.type === DEPARTURE_SHIFT);
  assert.deepEqual([shift?.severity, shift?.data?.departure, shift?.data?.suggested], ["info", "2098-05-12", "2098-05-11"]);
  assert.deepEqual(shifted.actions[0].fields!.departure_dates, ["5 сарын 12"], "the date itself is never changed without the admin");

  const clash = proposalOf(tripFields({ departure_dates: ["5 сарын 20"] }));
  await finalizeNewTripActions(clash, { sourceText: source, now: NOW });
  assert.equal(clash.conflict_items!.find((item) => item.type === DEPARTURE_CONFLICT)?.severity, "warning");

  const undated = proposalOf(tripFields({ departure_dates: [] }));
  await finalizeNewTripActions(undated, { now: NOW });
  assert.ok(undated.conflict_items!.some((item) => item.type === "dates_missing"));

  assert.deepEqual(keptEvidence({ departure: "Ланд үнэ 3300 юань", duration: "ab" }, source), {}, "a price or a scrap is never a quote");
});

test("a photo of food or an object is never offered, and a dish is never searched for", async () => {
  const { searchCommonsPhotos, photoQueriesForTrip } = await import("../src/lib/tripPhotoFinder");
  const page = (title: string, index: number) => [String(index + 1), { title: `File:${title}.jpg`, imageinfo: [{ url: `https://upload.example.test/${index}.jpg`,
    thumburl: `https://thumb.example.test/a/b/${index}.jpg/1920px-${index}.jpg`, descriptionurl: "https://commons.example.test/x", width: 3000, height: 2000, mime: "image/jpeg",
    extmetadata: { LicenseShortName: { value: "CC0" }, Artist: { value: "Fixture Author" } } }] }];
  const titles = ["Norvel riverside at night", "Norvel. Original spicy hotpot base", "Bowl of Norvel noodles", "Norvel street food stall", "Lumia bridge panorama"];
  const fetchImpl = (async () => new Response(JSON.stringify({ query: { pages: Object.fromEntries(titles.map(page)) } }), { status: 200 })) as unknown as typeof fetch;
  const photos = await searchCommonsPhotos("Norvel", { fetchImpl });
  assert.deepEqual(photos.map((photo) => photo.title).sort(), ["Lumia bridge panorama", "Norvel riverside at night"]);

  let prompt = "";
  const ask = (async (parts: Array<{ text?: string }>) => {
    prompt = parts.map((part) => part.text || "").join("\n");
    return { text: JSON.stringify({ queries: [{ q: "Lumia bridge", day: 2 }, { q: "Norvel hotpot", day: 2 }, { q: "Norvel noodle soup", day: 3 }] }), usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
  }) as never;
  const queries = await photoQueriesForTrip({ title: ROUTE, days: borderProgram(), ask });
  assert.deepEqual(queries.map((query) => query.query), ["Lumia bridge"], "a dish the model still suggests is dropped");
  assert.match(prompt, /never a dish|food/i, "the prompt asks for places only");
});

test("one boat ride on a river does not make a city trip a cruise; a ship on several days does", async () => {
  const { detectTransportType } = await import("../src/lib/tripTransitDays");
  const city = borderProgram().map((day, index) => (index === 1 ? { ...day, description: `${day.description} Орой усан онгоцоор голын шөнийн үзэмж үзнэ.` } : day));
  assert.deepEqual(detectTransportType({ title: ROUTE, days: city }), { transport: "land_flight", sure: true });
  const ship = borderProgram().map((day, index) => (index > 0 ? { ...day, description: `${day.description} Усан онгоцондоо хононо.` } : { ...day, description: "Боомт хотод ирнэ." }));
  assert.deepEqual(detectTransportType({ title: ROUTE, days: ship }), { transport: "cruise", sure: false });
});

test("the model's own 'price in tugrug is unclear' remarks never become a question", async () => {
  const { scrubPartnerPrices } = await import("../src/lib/tripProposalFinalize");
  const p = proposalOf(tripFields());
  p.conflict_items = [
    { text: "Норвел хотын аяллын үнийг төгрөгөөр тодруулах шаардлагатай.", severity: "blocker", type: "true_price_conflict" },
    { text: "Норвел хотын аяллын үнийг төгрөгөөр тодорхойгүй байна.", severity: "warning", type: "ocr_suspect" },
    { text: "Хоёр өөр буудлын нэр бичигдсэн байна.", severity: "warning" },
  ];
  p.conflicts = p.conflict_items.map((item) => item.text);
  scrubPartnerPrices(p);
  assert.deepEqual(p.conflict_items.map((item) => item.text), ["Хоёр өөр буудлын нэр бичигдсэн байна."]);
  assert.deepEqual(p.conflicts, ["Хоёр өөр буудлын нэр бичигдсэн байна."]);
});

test("a whole program read from a file is a new trip, never an edit of the live trip it resembles", async () => {
  const { keepFileProgramsNew } = await import("../src/lib/travelAI");
  const { validateAIChangeProposal } = await import("../src/lib/travelAIValidation");
  const { buildProposalClarifications } = await import("../src/lib/adminProposalUtils");
  const live = { id: "trip-live-1", operator_name: "Fixture Travel", route_name: ROUTE, status: "active", departure_dates: ["2098-04-01"], adult_price: 2_990_000, extra: {} };
  const read = proposalOf(tripFields({ adult_price: 3_290_000 }));
  read.actions[0] = { ...read.actions[0], action: "patch", trip_id: "trip-live-1", match: { operator_name: "Fixture Travel", route_name: ROUTE } } as never;
  read.actions.push({ action: "patch", trip_id: "trip-live-2", fields: { adult_price: 1_111_111 } } as never);
  read.conflict_items = [{ text: `"${ROUTE}"-ыг шинэ аялал болгон нэмэх үү, эсвэл одоо байгааг шинэчлэх үү?`, severity: "blocker", type: "duplicate_route" }];
  read.conflicts = [read.conflict_items[0].text];
  keepFileProgramsNew(read);
  assert.deepEqual([read.actions[0].action, read.actions[0].trip_id, read.actions[0].match], ["upsert", undefined, undefined]);
  assert.deepEqual(read.actions[1], { action: "patch", trip_id: "trip-live-2", fields: { adult_price: 1_111_111 } }, "a price change without a program still updates its trip");
  assert.equal(read.conflict_items.length, 1, "with another kind of change in the proposal the question stays");

  const only = proposalOf(tripFields({ adult_price: 3_290_000 }));
  only.actions[0] = { ...only.actions[0], action: "patch", trip_id: "trip-live-1" } as never;
  only.conflict_items = [...read.conflict_items];
  only.conflicts = [...read.conflicts];
  keepFileProgramsNew(only);
  assert.deepEqual([only.conflict_items, only.conflicts], [[], []], "the question is already answered: new");
  const validation = validateAIChangeProposal(only as never, [live as never, { ...live, id: "trip-live-2", route_name: "ӨӨР АЯЛАЛ" } as never], { now: NOW });
  assert.deepEqual(validation.blocking_conflicts, []);
  assert.deepEqual([validation.proposal.actions[0].action, validation.proposal.actions[0].trip_id], ["upsert", undefined], "saving creates a trip; the live one is not touched");
  const note = validation.proposal.conflict_items!.find((item) => item.type === "same_name_exists");
  assert.equal(note?.severity, "warning");
  assert.match(note!.text, /ШИНЭ аялал болж нэмэгдэнэ/);
  assert.deepEqual(buildProposalClarifications(validation.proposal as never), [], "said in the review, not asked as a question");
  const again = validateAIChangeProposal(validation.proposal as never, [live as never], { now: NOW });
  assert.equal(again.proposal.conflict_items!.filter((item) => item.type === "same_name_exists").length, 1, "validated again at save, the note is not doubled");
});

test("a partner's settlement price among the notes never reaches the trip's lists", async () => {
  const { scrubPartnerPrices } = await import("../src/lib/tripProposalFinalize");
  const p = proposalOf(tripFields({ adult_price: 4_290_000 }, {
    important_notes: ["Захиалга 5-р сарын 1-нд хаагдана.", "Тооцоо нийлэх үнэ: 4,000,000₮", "Цуцалбал 1400 юань хураамж авна."],
    included_items: ["Онгоцны тийз", "Ланд үнэд тасалбар багтсан"],
  }));
  scrubPartnerPrices(p);
  const extra = p.actions[0].fields!.extra as Row;
  assert.deepEqual(extra.important_notes, ["Захиалга 5-р сарын 1-нд хаагдана.", "Цуцалбал 1400 юань хураамж авна."], "a cancellation fee is a condition and stays, in its own currency");
  assert.deepEqual(extra.included_items, ["Онгоцны тийз"]);
});

test("photos: one per day, never fewer than six; every program day gets one", async () => {
  const { photosWantedFor } = await import("../src/lib/tripPhotoFinder");
  assert.deepEqual([3, 4, 6, 7, 9, 30].map(photosWantedFor), [6, 6, 6, 7, 9, 12]);

  const { finalizeNewTripActions } = await import("../src/lib/tripProposalFinalize");
  const { isTransitDay } = await import("../src/lib/tripTransitDays");
  const sharp = (await import("sharp")).default;
  const jpeg = await sharp({ create: { width: 24, height: 16, channels: 3, background: "#7a8b9c" } }).jpeg().toBuffer();
  const fetchImpl = (async (input: string) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/w/api.php")) {
      const query = (url.searchParams.get("gsrsearch") || "").replace(" filetype:bitmap", "").replace(' incategory:"Quality images"', "");
      const pages = Object.fromEntries([1, 2, 3, 4].map((n) => [`${query}-${n}`, { title: `File:${query} ${n}.jpg`, imageinfo: [{ url: `https://upload.example.test/${encodeURIComponent(query)}-${n}.jpg`,
        thumburl: `https://thumb.example.test/${encodeURIComponent(query)}/1920px-${n}.jpg`, descriptionurl: "https://commons.example.test/x", width: 3000, height: 2000, mime: "image/jpeg",
        extmetadata: { LicenseShortName: { value: "CC0" }, Artist: { value: "Fixture Author" } } }] }]));
      return new Response(JSON.stringify({ query: { pages } }), { status: 200 });
    }
    return new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg" } });
  }) as unknown as typeof fetch;
  let asked = 0;
  const ask = (async (parts: Array<{ text?: string }>) => {
    const prompt = parts.map((part) => part.text || "").join("\n");
    if (prompt.includes("search phrases")) {
      return { text: JSON.stringify({ queries: [1, 2, 3, 4, 5, 6, 7].map((day) => ({ q: `Norvel sight ${day}`, day })), cities: [{ name: "Norvel", stopover: false }, { name: "Lumia", stopover: true }] }), usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
    }
    asked += 1;
    const count = Number(/Aim for (\d+)/.exec(prompt)?.[1] || 0);
    const offered = (prompt.match(/^Photo \d+ /gm) || []).length;
    return { text: JSON.stringify({ picks: Array.from({ length: Math.min(count, offered) }, (_, i) => i + 1) }), usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
  }) as never;
  const uploads: string[] = [];
  const upload = async (_buffer: Buffer, name: string) => { const url = `https://res.cloudinary.com/fixture/${uploads.length}-${name}`; uploads.push(url); return url; };
  const program = Array.from({ length: 7 }, (_, i) => ({ day: i + 1, title: i === 0 ? "ЭРЭЭН – НОРВЕЛ" : i === 6 ? "НОРВЕЛ – ЭРЭЭН" : `НОРВЕЛ ${i + 1}`, description: i === 0 ? "Эрээн авто вокзал дээр тосно. Норвел руу ниснэ." : i === 6 ? "Өглөө нисээд Эрээнд ирнэ." : `Норвелийн үзвэр ${i + 1}.`, meals: {} }));
  const p = proposalOf({ route_name: ROUTE, adult_price: 3_290_000, departure_dates: ["5 сарын 11"], extra: { itinerary_days: program } });
  await finalizeNewTripActions(p, { photos: { fetchImpl, ask, upload }, now: NOW });
  const fields = p.actions[0].fields as Row;
  const days = itineraryOf(fields);
  assert.equal(days.length, 9, "seven program days plus the two standard days");
  assert.equal(uploads.length, 9, "a 9-day trip gets nine photos");
  assert.deepEqual(days.filter((day) => !isTransitDay(day)).map((day) => Boolean(day.photo)), [true, true, true, true, true, true, true], "every program day has its photo");
  assert.ok(days.filter(isTransitDay).every((day) => !day.photo), "the train days never get one");
  assert.equal(asked, 1, "enough photos qualified: no second search");
});

test("adding or removing a day in the review keeps the duration in step", async () => {
  const { applyTransport, setProgramDays, itineraryOf } = await import("../src/lib/tripReview");
  const start = applyTransport(tripFields(), "land_flight").fields;
  const days = itineraryOf(start);
  const added = setProgramDays(start, [...days.slice(0, 4), { title: "НОРВЕЛ ЧӨЛӨӨТ", description: "", meals: {} }, ...days.slice(4)].map((day, i) => ({ ...day, day: i + 1 })));
  assert.deepEqual([added.duration_text, (added.extra as Row).duration_days, (added.extra as Row).duration_nights], ["6 өдөр 5 шөнө", 6, 5]);
  const removed = setProgramDays(added, itineraryOf(added).filter((_, i) => i !== 4));
  assert.equal(removed.duration_text, "5 өдөр 4 шөнө");
  const edited = setProgramDays(start, days.map((day) => ({ ...day, title: `${day.title}!` })));
  assert.equal(edited.duration_text, start.duration_text, "editing a day's text changes nothing else");
});
