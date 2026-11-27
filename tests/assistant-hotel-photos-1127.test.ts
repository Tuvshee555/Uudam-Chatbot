import test from "node:test";
import assert from "node:assert/strict";
import { planHotelPhotos, tripHotelChoices } from "../src/lib/tripHotelPhotos";
import { planTripEdit, sanitizeTripEditAction } from "../src/lib/tripActionPlan";
import { withoutPlaceOnlyHotels } from "../src/lib/tripHotelNames";
import { applyTestEnv } from "./helpers/env";
import { applyFareChange } from "../src/lib/tripFareChange";
import { attachmentRoute, isPhotoInstruction, isSavedTripInstruction } from "../src/components/admin/assistantChatLogic";
import { documentedFreeFare } from "../src/lib/tripCompleteness";
import type { AIChangeProposal, TravelTrip } from "../src/lib/travelTypes";

// The finalizer reaches the model layer, which reads the server environment when it loads.
applyTestEnv();
const finalize = () => import("../src/lib/tripProposalFinalize");

/**
 * 2026-11-25/27: ten hotel pictures sent with a trip link, a PDF whose dates sit beside yuan prices, a rename that
 * dropped the gallery, an infant «үнэгүй» saved as a bare 0. Every hotel, trip and price below is invented.
 */
const HOSTED = (name: string) => `https://res.cloudinary.com/test-cloud/image/upload/v1/uudam-travel-trips/${name}.jpg`;

function trip(extra: Record<string, unknown> = {}, more: Partial<TravelTrip> = {}): TravelTrip {
  return {
    id: "fixture-hotel-trip", route_name: "ЗЭЛМОР АЯЛАЛ", operator_name: "Uudam", category: "Аялал", duration_text: "5 өдөр 4 шөнө",
    adult_price: 2_000_000, child_price: 1_500_000, infant_price: null, currency: "MNT", departure_dates: ["2099-03-01"],
    seats_total: null, seats_left: null, has_food: null, status: "active", notes: "", hotel: "Орвел: Kaldara Tower Hotel; Норвел: Norvel Bay Resort hotel",
    source_description: "", photo_urls: [],
    extra: {
      itinerary_days: [
        { day: 1, title: "УБ – ОРВЕЛ", hotel: "Орвел / Kaldara Tower" },
        { day: 2, title: "ОРВЕЛ", hotel: "Орвел / Kaldara Tower" },
        { day: 3, title: "НОРВЕЛ", hotel: "Норвел / Norvel Bay Resort hotel" },
      ],
      hotel_profiles: [
        { name: "Орвел: Kaldara Tower Hotel; Норвел: Norvel Bay Resort hotel", url: "", description: "", media: [] },
      ],
      ...extra,
    },
    created_at: "", updated_at: "2099-01-01T00:00:00.000Z",
  } as TravelTrip;
}

test("hotel photos go to the one hotel the name points to, never to a profile that names several hotels", () => {
  const owned = trip();
  assert.deepEqual(tripHotelChoices(owned), ["Kaldara Tower", "Norvel Bay Resort hotel"]);
  const outcome = planHotelPhotos(owned, { hotel: "Norvel Bay Resort Jomtien", new_urls: [HOSTED("a1"), HOSTED("a2"), HOSTED("a1")] });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const profiles = (outcome.plan.fields.extra as { hotel_profiles: Array<{ name: string; media: Array<{ url: string }> }> }).hotel_profiles;
  assert.equal(profiles.length, 2, "a profile for this hotel is added beside the combined one");
  assert.equal(profiles[0].media.length, 0, "the combined profile stays empty");
  assert.deepEqual(profiles[1].media.map((item) => item.url), [HOSTED("a1"), HOSTED("a2")], "listed once each");
  assert.equal(profiles[1].name, "Norvel Bay Resort hotel");
  // The second hotel's photos land in their own profile; the first hotel's stay.
  const again = planHotelPhotos({ ...owned, extra: { ...owned.extra, hotel_profiles: profiles } } as TravelTrip, { hotel: "The Kaldara Tower Hotel", new_urls: [HOSTED("b1")] });
  assert.equal(again.ok, true);
  if (again.ok) {
    const next = (again.plan.fields.extra as { hotel_profiles: Array<{ name: string; media: unknown[] }> }).hotel_profiles;
    assert.deepEqual(next.map((profile) => [profile.name, profile.media.length]), [[profiles[0].name, 0], ["Norvel Bay Resort hotel", 2], ["Kaldara Tower", 1]]);
  }
});

test("hotel photos are refused with the trip's own hotels named when the hotel is not one of them, or a photo is not hosted", () => {
  const unknown = planHotelPhotos(trip(), { hotel: "Hilton Zelmor", new_urls: [HOSTED("a1")] });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.reason, /Kaldara Tower; Norvel Bay Resort hotel/u);
  const outside = planHotelPhotos(trip(), { hotel: "Kaldara Tower", new_urls: ["https://example.com/room.jpg"] });
  assert.equal(outside.ok, false);
  const twice = planHotelPhotos(trip({ hotel_profiles: [{ name: "Kaldara Tower", url: "", description: "", media: [{ url: HOSTED("a1"), caption: "" }] }] }), { hotel: "Kaldara Tower", new_urls: [HOSTED("a1")] });
  assert.equal(twice.ok, false, "nothing new to add is said, not saved again");
});

test("add_hotel_photos is a planned verb: sanitised and planned like the others", () => {
  const action = sanitizeTripEditAction({ action: "add_hotel_photos", trip_id: "fixture-hotel-trip", summary: "x", hotel_name: " Kaldara Tower ", new_urls: [HOSTED("a1"), HOSTED("a1"), "", HOSTED("a2")], junk: "dropped" } as never);
  assert.deepEqual({ ...action }, { action: "add_hotel_photos", trip_id: "fixture-hotel-trip", summary: "x", hotel_name: "Kaldara Tower", new_urls: [HOSTED("a1"), HOSTED("a2")] });
  const planned = planTripEdit(trip(), action, null);
  assert.equal(planned.ok, true);
  if (planned.ok) assert.match(planned.plan.lines.join(" "), /Kaldara Tower: 2 зураг нэмнэ/u);
});

test("«буудлын зураг» goes to the assistant as hotel photos, and «шинэ аялал болгож нэм» says a new trip", () => {
  assert.equal(isPhotoInstruction("https://uudamtravel.mn/mn/trips/trip-aaaaaaaaaaaaaaaaaaaa энэ аяллын буудлын зургууд. Буудлын зураг болгож нэмээрэй"), true);
  assert.equal(isPhotoInstruction("buudliin zurag nemeerei"), true);
  assert.equal(isPhotoInstruction("аяллын буудлын зургийг шинэ аялал болгон нэм"), false, "a new trip stays with the reader");
  const photos = Array.from({ length: 10 }, (_, index) => ({ name: `photo-${index}.jpg`, mimeType: "image/jpeg" })) as never[];
  const route = attachmentRoute("энэ аяллын буудлын зургууд", photos);
  assert.equal(route.kind, "agent_images");
  if (route.kind === "agent_images") assert.equal(route.images.length, 10, "ten photos are not cut to six");
  // «болгож»: a file that looks like a saved trip is not sent to «update or new?» when the admin said new.
  const pdf = [{ name: "program.pdf", mimeType: "application/pdf" }] as never[];
  assert.equal(isSavedTripInstruction("Энэ аяллыг шинэ аялал болгож нэм", pdf), false);
  assert.equal(isSavedTripInstruction("Энэ аяллыг шинэ аялал болгон нэм", pdf), false);
});

test("a city written as the hotel is not a hotel; the days keep their city", () => {
  const fields = { hotel: "Орвел", extra: {
    destinations: ["Орвел"], hotel_profiles: [{ name: "Орвел", url: "", description: "", media: [] }],
    itinerary_days: [{ title: "УБ – ОРВЕЛ" }],
    price_groups: [{ dates: ["2099-03-01"], hotel: "Орвел", adult_price: 2_000_000 }],
  } };
  const cleaned = withoutPlaceOnlyHotels(fields) as typeof fields;
  assert.equal(cleaned.hotel, "");
  assert.deepEqual(cleaned.extra.hotel_profiles, []);
  assert.equal(cleaned.extra.price_groups[0].hotel, "");
  const real = { hotel: "Kaldara Tower Hotel", extra: { destinations: ["Орвел"], hotel_profiles: [{ name: "Kaldara Tower Hotel", url: "", description: "", media: [] }] } };
  assert.equal(withoutPlaceOnlyHotels(real), real, "a real hotel is left alone");
});

test("days written as one month and a list («12сар5/10/12») are read from the verified departure line", async () => {
  const { daysFromDepartureLine } = await finalize();
  const now = new Date("2098-11-25T04:00:00Z");
  const fields = (departure: string) => ({ departure_dates: [], extra: { source_evidence: { departure } } });
  assert.deepEqual(daysFromDepartureLine(fields("12сар5/10/12"), "x 12сар5/10/12 y", now), ["2098-12-05", "2098-12-10", "2098-12-12"]);
  assert.deepEqual(daysFromDepartureLine(fields("1-р сар 3/17"), "1-р сар 3/17", now), ["2099-01-03", "2099-01-17"]);
  assert.deepEqual(daysFromDepartureLine(fields("12сар5/10/12"), "a different text", now), [], "a line not in the file is never read");
  assert.deepEqual(daysFromDepartureLine({ departure_dates: ["2098-12-20"], extra: { source_evidence: { departure: "12сар5/10/12" } } }, "12сар5/10/12", now), [], "dates already read stay");
  // The quoted line is the table's heading: the days are on the row under it.
  const table = "№ Гарах сар/өдөр Тээш Үнэ/том\n1 12сар5/10/12 10Кг 3450юань";
  assert.deepEqual(daysFromDepartureLine(fields("№ Гарах сар/өдөр Тээш Үнэ/том"), table, now), ["2098-12-05", "2098-12-10", "2098-12-12"]);
});

test("«year not written, which year?» is dropped when every day falls within the coming year", async () => {
  const { dropYearOnlyNotes } = await finalize();
  const now = new Date("2098-11-25T04:00:00Z");
  const proposal = () => ({ summary: "", conflicts: [], conflict_items: [
    { text: "\"ЗЭЛМОР АЯЛАЛ\"-ын гарах өдрүүд \"12сар5/10/12\". Жилийг бичээгүй байна. Аль жилийн аялал вэ?", severity: "blocker" },
    { text: "other note", severity: "info", type: "transport_choice" },
  ] }) as unknown as AIChangeProposal;
  const near = proposal();
  dropYearOnlyNotes(near, { departure_dates: ["2098-12-05", "2098-12-10"] }, "ЗЭЛМОР АЯЛАЛ", now);
  assert.deepEqual((near.conflict_items ?? []).map((item) => item.text), ["other note"]);
  const far = proposal();
  dropYearOnlyNotes(far, { departure_dates: ["2100-12-05"] }, "ЗЭЛМОР АЯЛАЛ", now);
  assert.equal((far.conflict_items ?? []).length, 2, "a day more than a year out keeps the question");
});

test("a trip titled only «<place> аялал» takes the more precise name of its file", async () => {
  const { specificFileTitle } = await finalize();
  const fromFile = (route: string, file: string) => specificFileTitle({ route_name: route, extra: { source_file_name: file } });
  assert.equal(fromFile("Зелмор аялал", "№УБ-Зелмор хямдралтай аялал.pdf.parsed-text-001-of-001.txt"), "УБ-Зелмор хямдралтай аялал");
  assert.equal(fromFile("Зелмор + Орвел хаалга аялал", "№УБ-Зелмор хямдралтай аялал.pdf"), null, "a title that already says more is kept");
  assert.equal(fromFile("Зелмор аялал", "program.pdf"), null, "a file name that adds nothing is not used");
});

test("a revision of a new-trip card keeps its gallery, also under a new name", async () => {
  const { carryOverPhotoExtras } = await finalize();
  const card = (name: string, photos: string[]) => ({ summary: "", conflicts: [], actions: [{ action: "upsert", fields: { route_name: name, photo_urls: photos, extra: {} } }] }) as unknown as AIChangeProposal;
  const before = card("Зелмор аялал", [HOSTED("p1"), HOSTED("p2")]);
  const renamed = card("УБ-Зелмор хямдралтай аялал", []);
  carryOverPhotoExtras(before, renamed);
  assert.deepEqual((renamed.actions[0].fields as { photo_urls: string[] }).photo_urls, [HOSTED("p1"), HOSTED("p2")]);
});

test("an infant fare set to free is a documented free fare, not a bare 0 the bot reads as unknown", () => {
  const priced = trip({ price_groups: [{ dates: ["2099-03-01"], adult_price: 2_000_000, child_price: 1_500_000, passenger_prices: [{ label: "Хүүхэд", age_range: "2-11 нас", price: 1_500_000, currency: "MNT" }] }] });
  const result = applyFareChange(priced, { infant: { set: 0 } });
  assert.equal(result.fields.infant_price, 0);
  const rules = (result.fields.extra as { child_rules?: Array<Record<string, unknown>> } | undefined)?.child_rules ?? [];
  assert.equal(documentedFreeFare({ child_rules: rules }, "infant"), true, JSON.stringify(rules));
});
