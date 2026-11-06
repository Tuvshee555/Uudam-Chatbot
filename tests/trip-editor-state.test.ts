import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

applyTestEnv();

// The trip editor's state to and from a trip's fields (tripEditorState.ts), used
// for a saved trip, a new one, and a trip read from a file that is opened in the
// full editor before it is saved. Invented places and prices only.
type Row = Record<string, unknown>;
const fileTrip = (): Row => ({
  route_name: "НОРВЕЛ ДАЛАЙН АЯЛАЛ", duration_text: "6 өдөр 5 шөнө", adult_price: 1_111_111, child_price: null, infant_price: 0,
  departure_dates: ["2098-05-11", "2098-05-18"], hotel: "Норвел 5* эсвэл Лумиа 4*", status: "active", photo_urls: ["https://res.cloudinary.com/fixture/a.jpg"],
  extra: {
    itinerary_days: [{ day: 1, date: "5/11", title: "УЛААНБААТАР – НОРВЕЛ", description: "Улаанбаатараас нисээд Норвелд бууна.", meals: { breakfast: null, lunch: null, dinner: true }, meal_note: "Буфет" }],
    price_groups: [{ label: "", dates: ["2098-05-11"], display_dates: [], date_keys: [], adult_price: 1_111_111, adult_price_range: null, child_price: null, infant_price: null, child_age: "", infant_age: "", passenger_prices: [], note: "", hotel: "Норвел 5*", package_id: "Хөтөлбөртэй", single_price: 222_222 }],
    hotel_profiles: [{ name: "Норвел 5*", url: "https://hotel.example.test/norvel", description: "Далайн эрэгт", media: [{ url: "https://hotel.example.test/1.jpg", caption: "" }] }],
    booking_terms: { deposit: "50%", payment: "", documents: "", visa: "", cancellation: "" },
    source_evidence: { duration: "6 өдөр 5 шөнө" }, program_duration_text: "6 өдөр 5 шөнө", transport_type: "direct_flight",
    photo_credits: { "https://res.cloudinary.com/fixture/a.jpg": { title: "Norvel bay", author: "Vel Mor", license: "CC0" } },
  },
});

test("a trip read from a file opens in the editor with every field, and comes back unchanged", async () => {
  const { tripToEditorState, editorStateToFields, mergeEditorResult } = await import("../src/lib/tripEditorState");
  const before = fileTrip();
  const state = tripToEditorState(before as never);
  assert.equal(state.tripDraft.departure_dates, "2098-05-11, 2098-05-18");
  assert.equal(state.tripDraft.infant_price, "0");
  assert.equal(state.tripPriceGroups[0].package_id, "Хөтөлбөртэй");
  assert.equal(JSON.parse(state.tripDraft.hotelProfiles)[0].url, "https://hotel.example.test/norvel");
  const fields = editorStateToFields(state, null) as unknown as Row;
  assert.deepEqual([fields.route_name, fields.adult_price, fields.child_price, fields.infant_price], ["НОРВЕЛ ДАЛАЙН АЯЛАЛ", 1_111_111, null, 0]);
  assert.deepEqual(fields.departure_dates, ["2098-05-11", "2098-05-18"], "calendar days keep their year");
  const extra = fields.extra as Row;
  const day = (extra.itinerary_days as Row[])[0];
  assert.deepEqual([day.meals, day.meal_note], [{ breakfast: null, lunch: null, dinner: true }, "Буфет"], "'not stated' and the meal note survive the editor");
  assert.equal((extra.price_groups as Row[])[0].single_price, 222_222);
  assert.deepEqual((extra.hotel_profiles as Row[])[0], { name: "Норвел 5*", url: "https://hotel.example.test/norvel", description: "Далайн эрэгт", media: [{ url: "https://hotel.example.test/1.jpg", caption: "" }] });
  const merged = mergeEditorResult(before, fields) as Row;
  const mergedExtra = merged.extra as Row;
  assert.deepEqual([mergedExtra.source_evidence, mergedExtra.transport_type, Object.keys(mergedExtra.photo_credits as Row).length], [{ duration: "6 өдөр 5 шөнө" }, "direct_flight", 1],
    "what only the review keeps is not lost when the full editor hands the trip back");
});

test("hotel profiles: blank rows are dropped, a trip that never had any gains no empty key", async () => {
  const { tripToEditorState, editorStateToFields } = await import("../src/lib/tripEditorState");
  const plain = tripToEditorState({ route_name: "НОРВЕЛ", extra: {} } as never);
  assert.equal("hotel_profiles" in (editorStateToFields(plain, null).extra as Row), false);
  const withBlank = { ...plain, tripDraft: { ...plain.tripDraft, hotelProfiles: JSON.stringify([{ name: " ", url: "", description: "", media: [] }, { name: "Лумиа 4*", url: " https://x.example.test ", description: "", media: [{ url: "", caption: "" }] }]) } };
  assert.deepEqual((editorStateToFields(withBlank, null).extra as Row).hotel_profiles, [{ name: "Лумиа 4*", url: "https://x.example.test", description: "", media: [] }]);
  const saved = { id: "t1", extra: { hotel_profiles: [{ name: "Лумиа 4*" }] } };
  const cleared = { ...plain, tripDraft: { ...plain.tripDraft, hotelProfiles: "[]" } };
  assert.deepEqual((editorStateToFields(cleared, saved as never).extra as Row).hotel_profiles, [], "removing the last hotel of a saved trip is saved as removal");
});

test("website fields typed on a trip that is not saved yet are kept", async () => {
  const { tripToEditorState, editorStateToFields } = await import("../src/lib/tripEditorState");
  const state = tripToEditorState({ route_name: "НОРВЕЛ", extra: {} } as never);
  state.tripDraft.websiteDetails = JSON.stringify({ meetingPoint: "Нисэх буудал" });
  const patch = (editorStateToFields(state, null).extra as Row).website_details_patch as Row;
  assert.deepEqual(patch.values, { meetingPoint: "Нисэх буудал" });
});

test("days added or removed in the review move days and nights together, renumbered", async () => {
  const { setProgramDays, itineraryOf } = await import("../src/lib/tripReview");
  const day = (title: string) => ({ title, description: "", meals: {} });
  const trip = { duration_text: "3 өдөр 1 шөнө", extra: { itinerary_days: [day("А"), day("Б"), day("В")] } };
  const longer = setProgramDays(trip, [day("А"), day("Б"), day("Шинэ"), day("В")]);
  assert.equal(longer.duration_text, "4 өдөр 2 шөнө", "a hand-set night count keeps its offset");
  assert.deepEqual(itineraryOf(longer).map((entry) => entry.day), [1, 2, 3, 4]);
  const shorter = setProgramDays(longer, itineraryOf(longer).slice(1));
  assert.equal(shorter.duration_text, "3 өдөр 1 шөнө");
});

test("hotel names offered for linking: price-row hotels and the trip's hotels, never a star rating", async () => {
  const { hotelNamesOf } = await import("../src/components/admin/tripEditor/HotelProfilesEditor");
  assert.deepEqual(hotelNamesOf([], "Норвел хотын зочид буудал, 4 од"), ["Норвел хотын зочид буудал"]);
  assert.deepEqual(hotelNamesOf([{ hotel: "Лумиа · Хөтөлбөртэй" }, { hotel: "Лумиа · Хөтөлбөргүй" }, { hotel: "Норвел 5*" }], "Лумиа эсвэл Норвел 5*"), ["Лумиа", "Норвел 5*"]);
  assert.deepEqual(hotelNamesOf([], "5*"), []);
});

test("a price row read from a file opens in the editor with every field the controls need", async () => {
  const { completePriceGroup } = await import("../src/lib/tripEditorState");
  const group = completePriceGroup({ dates: ["2098-05-11"], adult_price: 1_111_111, passenger_prices: [{ label: "Хүүхэд 1.2–1.4 м", price: 999_999 }] });
  assert.deepEqual([group.label, group.note, group.date_keys, group.passenger_prices[0].age_range, group.passenger_prices[0].currency], ["", "", ["2098-05-11"], "", "MNT"]);
  const { parseAgeRange } = await import("../src/components/admin/tripEditor/PricingEditor");
  assert.deepEqual(parseAgeRange(undefined), { min: "", max: "", unit: "нас" }, "a band without an age range never crashes the editor");
});

test("saving a trip never strips hotel fields the editor does not show", async () => {
  const { tripToEditorState, editorStateToFields } = await import("../src/lib/tripEditorState");
  const saved = { id: "t1", route_name: "НОРВЕЛ", extra: { hotel_profiles: [{ id: "h-7", name: "Лумиа 4*", url: "", description: "Далайн эрэгт", media: [], stars: 4 }] } };
  const fields = editorStateToFields(tripToEditorState(saved as never), saved as never);
  assert.deepEqual((fields.extra as Row).hotel_profiles, saved.extra.hotel_profiles);
});

test("the full editor hands back only what the admin changed: no invented age bands, an emptied hotel list stays empty", async () => {
  const { changedEditorFields, editorStateToFields, tripToEditorState } = await import("../src/lib/tripEditorState");
  const opened: Row = { route_name: "НОРВЕЛ АЯЛАЛ", duration_text: "6 өдөр 5 шөнө", departure_dates: ["2098-05-11"],
    extra: { hotel_profiles: [{ name: "Норвел Гранд", url: "", description: "", media: [] }], itinerary_days: [] } };
  const state = tripToEditorState(opened);
  const baseline = editorStateToFields(state, null, { hadProfiles: true });
  // Opened and returned untouched: nothing comes back, the default age bands included.
  assert.deepEqual(changedEditorFields(baseline, editorStateToFields(state, null, { hadProfiles: true })), {});
  // Every hotel removed: an empty list comes back instead of nothing.
  const emptied = editorStateToFields({ ...state, tripDraft: { ...state.tripDraft, hotelProfiles: "[]" } }, null, { hadProfiles: true });
  assert.deepEqual(changedEditorFields(baseline, emptied), { extra: { hotel_profiles: [] } });
  // A longer trip: the structured numbers the bot and the website read change with the text.
  const longer = editorStateToFields({ ...state, tripDraft: { ...state.tripDraft, duration_text: "8 өдөр 7 шөнө" } }, null, { hadProfiles: true });
  assert.deepEqual(changedEditorFields(baseline, longer), { duration_text: "8 өдөр 7 шөнө", extra: { duration_days: 8, duration_nights: 7 } });
});

test("a departure schedule with a comma stays one entry; dates still split", async () => {
  const { splitDepartureText } = await import("../src/lib/tripEditorState");
  assert.deepEqual(splitDepartureText("2098-05-11, Даваа, Пүрэв гараг бүр"), ["2098-05-11", "Даваа, Пүрэв гараг бүр"]);
  assert.deepEqual(splitDepartureText("2098-05-11, 2098-05-18"), ["2098-05-11", "2098-05-18"]);
});

test("moving a departure to the UB train evening moves its fare row with it", async () => {
  const { shiftDepartureDay } = await import("../src/lib/tripReview");
  const fields: Row = { departure_dates: ["2098-05-11", "2098-05-18"], adult_price: null, extra: { price_groups: [
    { dates: ["2098-05-11"], date_keys: ["2098-05-11"], display_dates: ["2098-05-11"], adult_price: 1_111_111, passenger_prices: [{ label: "Хүүхэд", age_range: "2-11 нас", price: 999_000 }] },
    { dates: ["2098-05-18"], date_keys: ["2098-05-18"], display_dates: ["2098-05-18"], adult_price: 1_222_222 },
  ] } };
  const moved = shiftDepartureDay(fields, "2098-05-11", "2098-05-10", new Date("2098-01-01T00:00:00Z"));
  assert.deepEqual(moved.departure_dates, ["2098-05-10", "2098-05-18"]);
  const groups = (moved.extra as Row).price_groups as Row[];
  const first = groups.find((group) => (group.dates as string[]).includes("2098-05-10"));
  assert.equal(first?.adult_price, 1_111_111, "the moved departure keeps its own fare");
  assert.equal((first?.passenger_prices as Row[])[0].price, 999_000);
  assert.equal(groups.length, 2);
});

test("nights never reach the day count", async () => {
  const { clampNights, shiftDuration } = await import("../src/components/admin/tripEditor/DurationSteppers");
  assert.equal(clampNights(5, 7), 4);
  assert.equal(clampNights(9, 8), 8);
  assert.equal(clampNights(1, 3), 0);
  assert.equal(shiftDuration("10 өдөр 9 шөнө", 2, -1), "2 өдөр 1 шөнө");
});
