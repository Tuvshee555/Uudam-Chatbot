/**
 * The customer chatbot says what the trip data says (2026-11-05): nights in the
 * duration, the single supplement per hotel, a child fare's height/bed condition,
 * one hotel source for every hotel answer, and the AI catalogue's day meals,
 * packages, transport and destinations. Trip, hotel and place names and every
 * price here are invented.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { TravelTrip } from "../src/lib/travelTypes";
import type { FastPathRoute } from "../src/lib/fastPathRouting";
import { buildTripAnswerPlan, tripDurationText } from "../src/lib/tripAnswerPlan";
import { buildFareSection, fareCondition, tripsAtPrice } from "../src/lib/tripFareBlock";
import { buildHotelReply, tripHotels } from "../src/lib/tripHotelReply";
import { itineraryMealsText, tripKnowledgeModule } from "../src/lib/tripKnowledgeText";
import { verifyTripReply } from "../src/lib/tripReplyVerification";
import { resolveTripOffer, resolveTripOfferFareCard } from "../src/lib/tripOffers";
import { buildStructuredTripReply } from "../src/lib/travelFastPaths";

const NOW = new Date("2026-11-05T04:00:00Z");
const route: FastPathRoute = { matchText: "", scopedClarify: null, chosenTripId: "norvel" };

function trip(fields: Partial<TravelTrip> = {}): TravelTrip {
  return {
    id: "norvel", category: "Аялал", operator_name: "Uudam", route_name: "Норвел аялал", duration_text: "9 өдөр 8 шөнө",
    adult_price: 1_111_000, child_price: null, infant_price: null, currency: "MNT", departure_dates: ["2026-12-02"],
    seats_total: null, seats_left: null, has_food: true, status: "active", notes: "", hotel: "", source_description: "",
    photo_urls: [], extra: {}, created_at: "", updated_at: "", ...fields,
  };
}

/** Shaped like a live multi-hotel trip: hotel and package packed into one string, profiles spelled differently. */
function hotelTrip(): TravelTrip {
  return trip({
    hotel: "Vestarbay+Orlin, Orlin",
    extra: {
      duration_days: 9, duration_nights: 8,
      package_options: [{ id: "Хөтөлбөргүй", label: "Хөтөлбөргүй", note: "" }],
      hotel_profiles: [
        { name: "Vestar Bay", url: "https://example.com/vestar-bay", description: "Зохиомол буудал.", media: [] },
        { name: "Grand Ilmor", url: "", description: "Үнийн мөрөнд байхгүй буудал.", media: [] },
      ],
      itinerary_days: [{ day: 1, hotel: "Orlin", title: "Ирэх", meals: { breakfast: true } }, { day: 2, title: "Аялал" }],
      price_groups: [
        { dates: ["2026-12-02"], hotel: "Vestarbay+Orlin · Хөтөлбөргүй", adult_price: 2_111_000, single_price: 611_000 },
        { dates: ["2026-12-02"], hotel: "Orlin · Хөтөлбөргүй", adult_price: 2_511_000, single_price: 911_000 },
      ],
    },
  });
}

test("the duration answer keeps the nights the trip states (C2)", () => {
  assert.equal(tripDurationText(trip()), "9 өдөр 8 шөнө");
  // Nights entered as a number beside a days-only text.
  assert.equal(tripDurationText(trip({ duration_text: "9 өдөр", extra: { duration_nights: 8 } })), "9 өдөр 8 шөнө");
  // A stored count that disagrees with the text: only the days are certain.
  assert.equal(tripDurationText(trip({ extra: { duration_nights: 7 } })), "9 өдөр");
  // Structured days win over a text that says otherwise, and its nights are not borrowed.
  assert.equal(tripDurationText(trip({ duration_text: "8 өдөр 7 шөнө", extra: { duration_days: 9 } })), "9 өдөр");
  assert.equal(tripDurationText(trip({ duration_text: "" })), null);

  const plan = buildTripAnswerPlan({ text: "хэдэн хоног вэ?", trips: [trip()], route, now: NOW });
  assert.equal(plan?.status, "answered");
  assert.match(plan!.reply, /Хугацаа: 9 өдөр 8 шөнө\./);
  assert.equal(verifyTripReply({ reply: plan!.reply, trips: [trip()], now: NOW }), plan!.reply);
});

test("the shared fare card prints each hotel's own single supplement, and the checker accepts it (C4)", () => {
  const t = hotelTrip();
  const card = (buildFareSection(t, NOW) || []).join("\n");
  assert.match(card, /Буудал: Vestarbay\+Orlin · Хөтөлбөргүй\n• Том хүн: 2,111,000₮\n• Ганцаараа явах \(өрөөндөө ганцаараа\): 611,000₮/);
  assert.match(card, /Буудал: Orlin · Хөтөлбөргүй\n• Том хүн: 2,511,000₮\n• Ганцаараа явах \(өрөөндөө ганцаараа\): 911,000₮/);
  assert.equal(verifyTripReply({ reply: card, trips: [t], now: NOW }), card);
  // The supplement is not the trip's price: a "611,000₮ trip" search does not find it.
  assert.deepEqual(tripsAtPrice([t], 611_000, NOW), []);
  assert.equal(tripsAtPrice([t], 2_111_000, NOW)[0]?.label, "Том хүн");
});

test("one hotel's supplement is never printed under another hotel", () => {
  const t = hotelTrip();
  // A supplement under the wrong hotel is still rejected by the checker.
  const swapped = "12/2:\nБуудал: Orlin · Хөтөлбөргүй\n• Том хүн: 2,511,000₮\n• Ганцаараа явах (өрөөндөө ганцаараа): 611,000₮";
  assert.equal(verifyTripReply({ reply: swapped, trips: [t], now: NOW }), "REFER");
});

test("a child fare labelled by height is printed with its height, never as a bare child price (D7)", () => {
  const t = trip({ extra: { price_groups: [
    { dates: ["2026-12-02"], adult_price: 2_222_000, passenger_prices: [{ label: "Хүүхэд 1,2-1,4 м өндөр", age_range: "", price: 1_222_000 }] },
  ] } });
  const card = (buildFareSection(t, NOW) || []).join("\n");
  // "1,2-1,4" reads as the date 2/1 to the reply checker; the en dash keeps it a height.
  assert.match(card, /• Хүүхэд \/1,2–1,4 м өндөр\/: 1,222,000₮/);
  assert.doesNotMatch(card, /• Хүүхэд: /);
  assert.equal(verifyTripReply({ reply: card, trips: [t], now: NOW }), card);

  const plan = buildTripAnswerPlan({ text: "12 сарын 2-нд хүүхдийн үнэ хэд вэ?", trips: [t], route, now: NOW });
  assert.match(plan!.reply, /Хүүхэд \(1,2–1,4 м өндөр\): 1,222,000₮/);
  assert.equal(verifyTripReply({ reply: plan!.reply, trips: [t], now: NOW }), plan!.reply);

  // "1.2–1.4" reads as 1/2 and 1/4: printed with the comma decimal instead.
  const dotted = trip({ extra: { price_groups: [
    { dates: ["2026-12-02"], adult_price: 2_222_000, passenger_prices: [{ label: "Хүүхэд 1.2–1.4 м", age_range: "", price: 1_222_000 }] },
  ] } });
  const dottedCard = (buildFareSection(dotted, NOW) || []).join("\n");
  assert.match(dottedCard, /• Хүүхэд \/1,2–1,4 м\/: 1,222,000₮/);
  assert.equal(verifyTripReply({ reply: dottedCard, trips: [dotted], now: NOW }), dottedCard);
});

// Two height fares on one date are two fares, not a contradiction. The resolver
// (tripOffers.ts, not this track's file) reports them as a conflict until it
// carries each fare's condition; these run once it does.
function twoHeightFares(): TravelTrip {
  return trip({ extra: { price_groups: [
    { dates: ["2026-12-02"], adult_price: 2_222_000, passenger_prices: [
      { label: "Хүүхэд 1,2-1,4 м өндөр", age_range: "", price: 1_222_000 },
      { label: "Хүүхэд 1,2 м доош", age_range: "", price: 999_000 },
    ] },
  ] } });
}
const resolverCarriesConditions = (() => {
  const card = resolveTripOfferFareCard(twoHeightFares(), { date: "2026-12-02" }, NOW);
  return card.status === "ready" && card.offer.fares.some((fare) => "condition" in fare);
})();

test("two child fares with different heights are both priced, each with its height", { skip: !resolverCarriesConditions && "needs the tripOffers condition patch" }, () => {
  const t = twoHeightFares();
  const card = (buildFareSection(t, NOW) || []).join("\n");
  assert.match(card, /• Хүүхэд \/1,2–1,4 м өндөр\/: 1,222,000₮/);
  assert.match(card, /• Хүүхэд \/1,2 м доош\/: 999,000₮/);
  assert.doesNotMatch(card, /• Хүүхэд: /);
  assert.equal(verifyTripReply({ reply: card, trips: [t], now: NOW }), card);
  const plan = buildTripAnswerPlan({ text: "12 сарын 2-нд хүүхдийн үнэ хэд вэ?", trips: [t], route, now: NOW });
  assert.match(plan!.reply, /Хүүхэд \(1,2–1,4 м өндөр\): 1,222,000₮/);
  assert.match(plan!.reply, /Хүүхэд \(1,2 м доош\): 999,000₮/);
  assert.equal(verifyTripReply({ reply: plan!.reply, trips: [t], now: NOW }), plan!.reply);
  // A party total cannot pick a height for the customer, and a reply naming one cannot be carried
  // yet: staff quote it (a hand-off with a lead, as before the conditions were read).
  const total = resolveTripOffer(t, { date: "2026-12-02", passengers: [{ kind: "adult", count: 2 }, { kind: "child", count: 1 }] }, NOW);
  assert.equal(total.status, "conflict");
  const asked = buildTripAnswerPlan({ text: "12 сарын 2-нд 2 том хүн 1 хүүхэд нийт хэд вэ?", trips: [t], route, now: NOW });
  assert.notEqual(asked?.status, "clarify", "no question the customer's answer could not be used for");
  // Same price for both heights: the total needs no choice at all.
  const same = trip({ extra: { price_groups: [
    { dates: ["2026-12-02"], adult_price: 2_222_000, passenger_prices: [
      { label: "Хүүхэд 1,2-1,4 м өндөр", age_range: "", price: 1_222_000 },
      { label: "Хүүхэд 1,2 м доош", age_range: "", price: 1_222_000 },
    ] },
  ] } });
  const sameTotal = resolveTripOffer(same, { date: "2026-12-02", passengers: [{ kind: "adult", count: 2 }, { kind: "child", count: 1 }] }, NOW);
  assert.equal(sameTotal.status, "ready");
});

test("one condition written in different capitals is one fare: two prices for it stay a conflict", () => {
  const stale = trip({ extra: { price_groups: [
    { dates: ["2026-12-02"], adult_price: 2_222_000, passenger_prices: [
      { label: "Хүүхэд оргүй", age_range: "", price: 1_222_000 },
      { label: "ХҮҮХЭД ОРГҮЙ", age_range: "", price: 1_333_000 },
    ] },
  ] } });
  assert.equal(resolveTripOfferFareCard(stale, { date: "2026-12-02" }, NOW).status, "conflict");
});

test("a no-bed child fare keeps its condition; an age written in the label is left to the age field", () => {
  const bed = trip({ extra: { price_groups: [
    { dates: ["2026-12-02"], adult_price: 2_222_000, passenger_prices: [{ label: "Хүүхэд оргүй", age_range: "", price: 1_333_000 }] },
  ] } });
  assert.match((buildFareSection(bed, NOW) || []).join("\n"), /• Хүүхэд \/оргүй\/: 1,333,000₮/);
  // A slash in the label lists alternatives; it cannot close the printed band early.
  const either = trip({ extra: { price_groups: [
    { dates: ["2026-12-02"], adult_price: 2_222_000, passenger_prices: [{ label: "ХҮҮХЭД 1,1М-С ДООШ/ДЭЭШ", age_range: "", price: 1_555_000 }] },
  ] } });
  const eitherCard = (buildFareSection(either, NOW) || []).join("\n");
  assert.match(eitherCard, /• Хүүхэд \/1,1М-С ДООШ, ДЭЭШ\/: 1,555,000₮/);
  assert.equal(verifyTripReply({ reply: eitherCard, trips: [either], now: NOW }), eitherCard);
  // "6-11 нас" in the label without age_range: the checker reads ages, so it is not added here.
  const aged = trip({ extra: { price_groups: [
    { dates: ["2026-12-02"], adult_price: 2_222_000, passenger_prices: [{ label: "Хүүхэд 6-11 нас", age_range: "", price: 1_444_000 }] },
  ] } });
  assert.match((buildFareSection(aged, NOW) || []).join("\n"), /• Хүүхэд: 1,444,000₮/);
});

test("a fare written once with a condition and once bare at the same price gets no condition", () => {
  const t = trip({ departure_dates: ["2026-12-02", "2026-12-09"], extra: { price_groups: [
    { dates: ["2026-12-02"], adult_price: 2_222_000, passenger_prices: [{ label: "Хүүхэд оргүй", age_range: "", price: 1_333_000 }] },
    { dates: ["2026-12-09"], adult_price: 2_222_000, passenger_prices: [{ label: "Хүүхэд", age_range: "", price: 1_333_000 }] },
  ] } });
  const childOn = (date: string) => {
    const card = resolveTripOfferFareCard(t, { date }, NOW);
    assert.equal(card.status, "ready");
    return card.status === "ready" ? card.offer.fares.find((fare) => fare.kind === "child") : undefined;
  };
  // Read from the labels alone, the same fare is both "оргүй" and bare: no condition is claimed.
  // A resolver that carries each row's own condition knows which row priced which date.
  assert.equal(fareCondition(t, childOn("2026-12-02")!), resolverCarriesConditions ? "оргүй" : null);
  assert.equal(fareCondition(t, childOn("2026-12-09")!), null);
});

test("every hotel answer reads the price rows' hotels, named and linked by their profiles (D4)", () => {
  const t = hotelTrip();
  // The day-1 hotel ("Orlin") alone used to be the answer; the package is not a hotel.
  assert.equal(buildHotelReply(t, "ямар буудалд буудаллах вэ", NOW),
    "🏨 Норвел аялал — буудал:\n• Vestar Bay + Orlin — https://example.com/vestar-bay\n• Orlin");
  const plan = buildTripAnswerPlan({ text: "12 сарын 2-нд ямар буудалд буудаллах вэ?", trips: [t], route, now: NOW });
  const section = plan!.reply.slice(plan!.reply.indexOf("Буудал:\n"));
  assert.match(section, /^Буудал:\n• Vestar Bay \+ Orlin — https:\/\/example\.com\/vestar-bay\n• Orlin$/m);
  // A profile no price row sells is not offered; the package stays out of the hotel list.
  assert.doesNotMatch(plan!.reply, /Grand Ilmor/);
  assert.doesNotMatch(section, /Хөтөлбөргүй/);
  // The customer's chosen variant keeps only that hotel.
  assert.deepEqual(tripHotels(t, { hotel: "Orlin · Хөтөлбөргүй" }, NOW)?.hotels.map((hotel) => hotel.name), ["Orlin"]);
});

test("a price row linked to its hotel profiles by id is named and linked by those profiles", () => {
  const t = trip({ extra: {
    package_options: [{ id: "Хөтөлбөртэй", label: "Хөтөлбөртэй", note: "" }, { id: "Хөтөлбөргүй", label: "Хөтөлбөргүй", note: "" }],
    hotel_profiles: [
      { id: "vestar", name: "Vestar Bay", url: "https://example.com/vestar-bay", description: "", media: [] },
      { id: "orlin", name: "Orlin Island Resort", url: "https://example.com/orlin", description: "", media: [] },
    ],
    price_groups: [
      { dates: ["2026-12-02"], hotel: "Vestarbay+Orlin", package_id: "Хөтөлбөргүй", hotel_id: "vestar+orlin", hotel_profile_ids: ["vestar", "orlin"], adult_price: 2_111_000 },
      { dates: ["2026-12-02"], hotel: "Vestarbay+Orlin", package_id: "Хөтөлбөртэй", hotel_id: "vestar+orlin", hotel_profile_ids: ["vestar", "orlin"], adult_price: 2_411_000 },
      // Only one of the two hotels is linked: the row keeps its own name, with the link that was found.
      { dates: ["2026-12-02"], hotel: "Kaldor+Orlin", package_id: "Хөтөлбөргүй", hotel_profile_ids: ["orlin"], adult_price: 2_711_000 },
    ],
  } });
  assert.equal(buildHotelReply(t, "ямар буудалд буудаллах вэ", NOW), "🏨 Норвел аялал — буудал:\n"
    + "• Vestar Bay + Orlin Island Resort — https://example.com/vestar-bay https://example.com/orlin\n"
    + "• Kaldor+Orlin — https://example.com/orlin");
});

test("without hotel price rows the trip's own line answers, then the itinerary's hotels; only https links are sent", () => {
  const itineraryOnly = {
    hotel_profiles: [{ name: "Alpha Bay", url: "http://example.com/alpha", description: "", media: [] }],
    hotel_links: [{ name: "Delta Cove", url: "https://example.com/delta" }],
    itinerary_days: [{ day: 1, hotel: "Alpha Bay" }, { day: 2, hotel: "Alpha Bay" }, { day: 3, hotel: "Delta Cove" }],
  };
  const days = trip({ hotel: "", extra: itineraryOnly });
  assert.equal(buildHotelReply(days, "буудал хаана вэ", NOW),
    "🏨 Норвел аялал — буудал:\n• 1–2-р өдөр: Alpha Bay\n• 3-р өдөр: Delta Cove — https://example.com/delta");
  // A trip with its own hotel line answers with it, as the answer plan and the website's hotel section do.
  const both = trip({ hotel: "Kestrel Inn", extra: itineraryOnly });
  assert.equal(buildHotelReply(both, "буудал хаана вэ", NOW), "🏨 Норвел аялал — буудал:\n• Kestrel Inn");
  // A hotel the customer named that only the itinerary gives keeps its days.
  assert.deepEqual(tripHotels(both, { hotel: "Delta Cove" }, NOW), { source: "itinerary", hotels: [{ name: "Delta Cove", urls: ["https://example.com/delta"], days: [3] }] });
  // The profile spells the trip's hotel differently; it is the same hotel, named as the profile names it.
  const own = trip({ hotel: "Kestrel Inn", extra: { hotel_profiles: [{ name: "KESTREL-INN", url: "https://example.com/kestrel", description: "", media: [] }] } });
  assert.equal(buildHotelReply(own, "ямар буудалд байрлах вэ", NOW), "🏨 Норвел аялал — буудал:\n• KESTREL-INN — https://example.com/kestrel");
  const plan = buildTripAnswerPlan({ text: "ямар буудалд буудаллах вэ?", trips: [own], route, now: NOW });
  assert.match(plan!.reply, /Буудал: KESTREL-INN — https:\/\/example\.com\/kestrel/);
  // A price row selling a hotel the customer did not choose never falls back to the trip line.
  assert.equal(tripHotels(hotelTrip(), { hotel: "Kestrel Inn" }, NOW), null);
});

test("the AI catalogue lists each day's stated meals compactly (C1)", () => {
  const meals = itineraryMealsText([
    { day: 1, meals: { breakfast: true, lunch: null, dinner: null } },
    { day: 2, meals: { breakfast: true, lunch: true, dinner: true } },
    { day: 3, meals: { breakfast: true, lunch: true, dinner: true } },
    { day: 4, meals: { breakfast: true, lunch: null, dinner: false }, meal_note: "Далайн эргийн ресторан" },
    { day: 5, meals: { breakfast: null, lunch: null, dinner: null } },
  ]);
  assert.equal(meals, "1-р өдөр — өглөөний хоол багтсан; 2–3-р өдөр — бүх хоол багтсан; "
    + "4-р өдөр — өглөөний хоол багтсан, оройн хоол багтаагүй (Далайн эргийн ресторан)");
  // All three false with no meal note is the legacy "not stated" shape (statedDayMeals); a note makes it stated.
  assert.equal(itineraryMealsText([{ day: 1, meals: { breakfast: false, lunch: false, dinner: false } }]), null);
  assert.equal(itineraryMealsText([{ day: 1, meals: { breakfast: false, lunch: false, dinner: false }, meal_note: "Зохиомол тэмдэглэл" }]),
    "1-р өдөр — хоол багтаагүй (Зохиомол тэмдэглэл)");
  assert.equal(itineraryMealsText([{ day: 1, meals: {} }]), null);
  const description = tripKnowledgeModule(trip({ extra: { itinerary_days: [{ day: 1, meals: { dinner: true } }] } }), NOW).description;
  assert.match(description, /Өдөр бүрийн хоол: 1-р өдөр — оройн хоол багтсан/);
});

test("the AI catalogue names each row's package and the trip's package options (C5)", () => {
  const t = trip({ extra: {
    package_options: [{ id: "Хөтөлбөртэй", label: "Хөтөлбөртэй", note: "Өдрийн аялалтай" }, { id: "Хөтөлбөргүй", label: "Хөтөлбөргүй", note: "" }],
    price_groups: [
      { dates: ["2026-12-02"], label: "2026-12-02", hotel: "Orlin", package_id: "Хөтөлбөртэй", adult_price: 2_511_000,
        passenger_prices: [{ label: "Хүүхэд 6-11 нас оргүй", age_range: "6-11 нас", price: 1_511_000 }] },
    ],
  } });
  const description = tripKnowledgeModule(t, NOW).description;
  assert.match(description, /Багцын сонголт: Хөтөлбөртэй \(Өдрийн аялалтай\); Хөтөлбөргүй/);
  // The date-only label is not repeated, and an age already in the label is not printed twice.
  assert.match(description, /\[2026-12-02: Буудал Orlin: Багц Хөтөлбөртэй: Том 2511000₮ \/ Хүүхэд 6-11 нас оргүй 1511000₮\]/);
});

test("the AI catalogue states transport and destinations and keeps the website's own lines (C6)", () => {
  const same = tripKnowledgeModule(trip({ extra: {
    transport_type: "direct_flight", destinations: ["Норвел"],
    website_details: { destinations: ["норвел"], transport: ["Онгоц"] },
  } }), NOW).description;
  assert.match(same, /Тээврийн төрөл: шууд нислэгтэй аялал/);
  assert.match(same, /Очих газрууд: Норвел/);
  assert.match(same, /Веб аяллын тээвэр: Онгоц/);
  assert.doesNotMatch(same, /Веб аяллын очих газрууд/);
  const differs = tripKnowledgeModule(trip({ extra: {
    destinations: ["Норвел"], website_details: { destinations: ["Норвел", "Илмор"] },
  } }), NOW).description;
  assert.match(differs, /Веб аяллын очих газрууд: Норвел, Илмор/);
  // Fields stay one per " | " so the compact catalogue line can keep or drop each.
  assert.ok(same.split(" | ").every((field) => !field.includes("\n")));
});

// ---- 2026-11-05 review fixes ----

test("the customer naming the trip's own hotel is answered when the itinerary spells it otherwise", () => {
  const t = trip({ hotel: "Kestrel Inn", extra: {
    itinerary_days: [{ day: 1, hotel: "Kestrel Inn 4*" }, { day: 2, hotel: "Kestrel Inn 4*" }],
    price_groups: [{ dates: ["2026-12-02"], adult_price: 2_111_000 }],
  } });
  assert.deepEqual(tripHotels(t, { hotel: "Kestrel Inn" }, NOW), { source: "trip", hotels: [{ name: "Kestrel Inn", urls: [], days: [] }] });
  for (const text of ["Kestrel Inn буудал ямар вэ?", "12 сарын 2-нд Kestrel Inn буудалтай юу, үнэ хэд вэ?"]) {
    const plan = buildTripAnswerPlan({ text, trips: [t], route, now: NOW });
    assert.equal(plan?.status, "answered", text);
    assert.match(plan!.reply, /Kestrel Inn/);
    assert.match(plan!.reply, /Том хүн: 2,111,000₮/);
    assert.doesNotMatch(plan!.reply, /4\*/);
    assert.equal(verifyTripReply({ reply: plan!.reply, trips: [t], now: NOW }), plan!.reply);
  }
});

/** Two (or four) departures at one passenger fare, each with its own single supplement. */
function supplementTrip(singles: number[]): TravelTrip {
  const dates = ["2026-12-02", "2026-12-09", "2026-12-16", "2026-12-23"].slice(0, singles.length);
  return trip({ departure_dates: dates, extra: { price_groups: dates.map((date, index) => ({
    dates: [date], adult_price: 2_111_000, child_price: 1_511_000, single_price: singles[index],
  })) } });
}

test("dates at one fare stay one group when only the single supplement differs", () => {
  const t = supplementTrip([611_000, 622_000]);
  const section = buildFareSection(t, NOW) || [];
  // The trip card counts these lines to choose its full form.
  assert.equal(section.filter((line) => /^\s*•\s*Том хүн/.test(line)).length, 1);
  const card = section.join("\n");
  assert.match(card, /💰 Үнэ:\n• Том хүн: 2,111,000₮\n• Хүүхэд: 1,511,000₮\n• Ганцаараа явах \(өрөөндөө ганцаараа\) — 12\/2: 611,000₮\n• Ганцаараа явах \(өрөөндөө ганцаараа\) — 12\/9: 622,000₮/);
  assert.equal(verifyTripReply({ reply: card, trips: [t], now: NOW }), card);
  // The named trip gets its full card with prices, not "Аль гарах өдрөөр аялах вэ?".
  const reply = buildStructuredTripReply("Норвел аялал", [t], NOW) || "";
  assert.match(reply, /• Том хүн: 2,111,000₮/);
  assert.doesNotMatch(reply, /Аль гарах өдрөөр/);

  // Four such dates: one fare group, nothing hidden behind "Бусад гарах өдрийн үнийг…".
  const four = (buildFareSection(supplementTrip([611_000, 622_000, 611_000, 622_000]), NOW) || []).join("\n");
  assert.doesNotMatch(four, /Бусад гарах өдрийн/);
  assert.match(four, /— 12\/2, 12\/16: 611,000₮\n• Ганцаараа явах \(өрөөндөө ганцаараа\) — 12\/9, 12\/23: 622,000₮/);
  // One supplement for every date of the group is printed once, without dates.
  const same = (buildFareSection(supplementTrip([611_000, 611_000]), NOW) || []).join("\n");
  assert.match(same, /• Хүүхэд: 1,511,000₮\n• Ганцаараа явах \(өрөөндөө ганцаараа\): 611,000₮\n\n📅/);
  // A date with no supplement is not given another date's.
  const partial = (buildFareSection(supplementTrip([611_000, 0]), NOW) || []).join("\n");
  assert.match(partial, /— 12\/2: 611,000₮/);
  assert.doesNotMatch(partial, /12\/9: 611,000₮|Ганцаараа явах \(өрөөндөө ганцаараа\): 611,000₮/);
  assert.deepEqual(tripsAtPrice([t], 611_000, NOW), []);
});

test("a dated price-and-hotel answer names each hotel once, as the price lines name it", () => {
  const t = hotelTrip();
  const plan = buildTripAnswerPlan({ text: "12 сарын 2-нд ямар буудал байна, үнэ хэд вэ?", trips: [t], route, now: NOW });
  assert.equal(plan?.status, "answered");
  assert.match(plan!.reply, /Буудал: Vestarbay\+Orlin · Хөтөлбөргүй\n/);
  assert.doesNotMatch(plan!.reply, /Vestar Bay \+ Orlin|Буудал:\n•/);
  assert.equal(verifyTripReply({ reply: plan!.reply, trips: [t], now: NOW }), plan!.reply);

  // A trip-level hotel and a different itinerary hotel: the trip's own line, once.
  const kestrel = trip({ hotel: "Kestrel Inn", extra: {
    itinerary_days: [{ day: 1, hotel: "Alpha Bay" }],
    price_groups: [{ dates: ["2026-12-02"], adult_price: 2_111_000 }],
  } });
  for (const text of ["12 сарын 2-нд ямар буудалд буудаллах вэ, үнэ хэд вэ?", "далайн эрэг дээрх буудалд байрлах боломжтой юу? үнэ хэд вэ"]) {
    const reply = buildTripAnswerPlan({ text, trips: [kestrel], route, now: NOW })?.reply || "";
    assert.match(reply, /Буудал: Kestrel Inn/, text);
    assert.doesNotMatch(reply, /Alpha Bay/, text);
    assert.equal((reply.match(/Буудал:/g) || []).length, 1, text);
  }
});

test("hotels on non-consecutive itinerary days pass the reply checker on a dated question", () => {
  const t = trip({ hotel: "", extra: {
    itinerary_days: [1, 2, 3, 4, 5].map((day) => ({ day, hotel: day === 3 ? "Delta Cove" : "Alpha Bay" })),
    price_groups: [{ dates: ["2026-12-02"], adult_price: 2_111_000 }],
  } });
  for (const text of ["12 сарын 2-нд ямар буудалд буудаллах вэ?", "12 сарын 2-нд үнэ хэд, буудал аль вэ?"]) {
    const plan = buildTripAnswerPlan({ text, trips: [t], route, now: NOW });
    assert.equal(plan?.status, "answered", text);
    assert.match(plan!.reply, /• 1–2, 4–5-р өдөр: Alpha Bay\n• 3-р өдөр: Delta Cove/, text);
    assert.equal(verifyTripReply({ reply: plan!.reply, trips: [t], now: NOW }), plan!.reply, text);
    // The same days written with a hyphen read as the departure 1/2: the reason for the en dash.
    assert.equal(verifyTripReply({ reply: plan!.reply.replace(/–/g, "-"), trips: [t], now: NOW }), "REFER", text);
  }
  const routeOnly = buildHotelReply(t, "ямар буудалд буудаллах вэ", NOW) || "";
  assert.match(routeOnly, /• 1–2, 4–5-р өдөр: Alpha Bay/);
  assert.equal(verifyTripReply({ reply: routeOnly, trips: [t], now: NOW }), routeOnly);
});

test("the AI catalogue gives hotel links only when a profile holds an https link", () => {
  const description = tripKnowledgeModule(hotelTrip(), NOW).description;
  assert.match(description, /Буудлын холбоос: Vestar Bay — https:\/\/example\.com\/vestar-bay/);
  assert.doesNotMatch(description, /Grand Ilmor —/);
  assert.match(description, /Ганцаараа явах \(өрөөндөө ганцаараа\) 611000₮/);
});

test("the AI catalogue links only hotels the trip still stays at", async () => {
  const { tripKnowledgeModule } = await import("../src/lib/tripKnowledgeText");
  const base = {
    id: "links-trip", category: "Аялал", operator_name: "Туршилт", route_name: "Туршилтын аялал", duration_text: "5 өдөр 4 шөнө",
    adult_price: 1_111_111, child_price: null, infant_price: null, currency: "MNT", departure_dates: ["2099-06-12"], seats_total: null,
    seats_left: null, has_food: null, status: "active", notes: "", hotel: "", source_description: "", photo_urls: [], created_at: "", updated_at: "",
  };
  const extra = {
    price_groups: [{ dates: ["2099-06-12"], hotel: "Vestar+Orlin", adult_price: 1_111_111 }],
    hotel_profiles: [
      { id: "h-vestar", name: "Vestar Bay Resort", url: "https://hotels.example.com/vestar", media: [] },
      { id: "h-orlin", name: "Orlin", url: "https://hotels.example.com/orlin", media: [] },
      { id: "h-unsold", name: "Kelmar Palace", url: "https://hotels.example.com/kelmar", media: [] },
      { id: "h-stop", name: "Tamir Transit", url: "https://hotels.example.com/tamir", media: [] },
    ],
    itinerary_days: [{ day: 1, title: "Өдөр нэг", hotel: "Tamir Transit буудал" }],
  };
  const text = JSON.stringify(tripKnowledgeModule({ ...base, extra } as never, new Date("2099-06-01T00:00:00Z")));
  assert.ok(text.includes("hotels.example.com/vestar") && text.includes("hotels.example.com/orlin"), "the sold hotels are linked");
  assert.ok(text.includes("hotels.example.com/tamir"), "a stop-over hotel the program names stays");
  assert.ok(!text.includes("hotels.example.com/kelmar"), "a hotel no row sells and no day names is not linked");
});

test("what a label says beside its age is kept: the no-bed fare is not every 6-11-year-old's price", () => {
  const t = trip({ extra: { price_groups: [
    { dates: ["2026-12-02"], adult_price: 2_222_000, passenger_prices: [
      { label: "Хүүхэд 6-11 нас оргүй", age_range: "6-11 нас", price: 1_444_000 },
      { label: "6-11 насны хүүхэд", age_range: "6-11 нас", price: 1_444_000 },
    ] },
  ] } });
  const card = (buildFareSection(t, NOW) || []).join("\n");
  assert.match(card, /• Хүүхэд \/6-11 нас, оргүй\/: 1,444,000₮/);
  assert.equal(verifyTripReply({ reply: card, trips: [t], now: NOW }), card);
  const plain = trip({ extra: { price_groups: [
    { dates: ["2026-12-02"], adult_price: 2_222_000, passenger_prices: [{ label: "6-11 насны хүүхэд", age_range: "6-11 нас", price: 1_444_000 }] },
  ] } });
  assert.match((buildFareSection(plain, NOW) || []).join("\n"), /• Хүүхэд \/6-11 нас\/: 1,444,000₮/);
});
