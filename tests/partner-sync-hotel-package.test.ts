// A partner trip sold per hotel AND per package keeps the two as separate choices, and every price
// row names the hotel profile(s) it stays at. All hotel names, ids, links and fares here are invented.
import test from "node:test";
import assert from "node:assert/strict";
import { readHotels, hotelPageUrl } from "../src/lib/partnerSync/globalTravel";
import { hotelKey, hotelOptionParts, linkHotelOption, linkHotelOptions, matchHotelProfile, mergePartnerHotelProfiles, partnerHotelProfiles } from "../src/lib/partnerSync/hotelProfiles";
import { buildPriceTable, describeChanges } from "../src/lib/partnerSync/posterPayload";
import { partnerTripFields } from "../src/lib/partnerSync/tripPayload";
import { normalizeExtra, normalizeExtraPatch } from "../src/lib/tripExtraSchema";
import { buildFareSection, tripsAtPrice } from "../src/lib/tripFareBlock";
import { buildStructuredTripReply } from "../src/lib/travelFastPaths";
import { tripKnowledgeModule } from "../src/lib/tripKnowledgeText";
import { resolveTripOffer, resolveTripOfferFareCard } from "../src/lib/tripOffers";
import { websiteTripPayload } from "../src/lib/websiteTripPayload";
import { websiteDepartureSchedule } from "../src/lib/connectedTripMapping";
import { auditTripFacts } from "../src/lib/tripDataValidation";
import type { TravelTrip } from "../src/lib/travelTypes";
import type { PartnerTour } from "../src/lib/partnerSync/globalTravel";
import { prices, row, tour } from "./fixtures/partner-tour";

type Row = Record<string, unknown>;
const DATE = "2099-06-12";
const NOW = new Date("2099-06-01T00:00:00Z");
const COMBO = "Норвелгранд+Таврин";
const SINGLE = "Таврин";
const FREE = "Хөтөлбөргүй";
const PROGRAM = "Хөтөлбөртэй";

const PROFILES: PartnerTour["hotels"] = [
  { id: "h-norvel", name: "Норвел Гранд", stars: 4, description: "Норвел тайлбар", url: "" },
  { id: "h-tavrin", name: "Таврин Бэй Резорт", stars: 5, description: "Таврин тайлбар", url: "https://hotels.example.com/tavrin" },
  // A hotel the partner lists but sells in no price row.
  { id: "h-moron", name: "Мөрөнгө Палас", stars: 5, description: "", url: "" },
];

/** 2 hotels x 2 packages on one date. */
function sampleTour(): PartnerTour {
  const value = tour([
    row(DATE, COMBO, { seats: 7, prices: prices({ adult: 1_111_111, programAdult: 1_222_222, single: 611_111 }) }),
    row(DATE, SINGLE, { seats: 30, prices: prices({ adult: 1_333_333, programAdult: 1_444_444, single: 811_111 }) }),
  ]);
  return { ...value, hotels: PROFILES };
}

function sampleTrip(input = sampleTour(), existingExtra: Row = {}, poster: Row = {}): TravelTrip {
  const fields = partnerTripFields(input, poster, existingExtra);
  return {
    id: "sample-trip", category: "sample", operator_name: "Sample", route_name: "НОРВЕЛ ТАВРИН АЯЛАЛ", duration_text: "", adult_price: null,
    child_price: null, infant_price: null, currency: "MNT", departure_dates: [], seats_total: null, seats_left: null, has_food: null,
    status: "active", notes: "", hotel: "", source_description: "", photo_urls: [], created_at: "", updated_at: "",
    ...fields, extra: normalizeExtraPatch(fields.extra ?? {}),
  };
}
const groups = (trip: TravelTrip) => trip.extra.price_groups as Row[];

test("hotel keys ignore case, spaces and punctuation; a hotel is linked by the start of its name only when one profile fits", () => {
  assert.equal(hotelKey("Норвел Гранд"), hotelKey("НОРВЕЛГРАНД"));
  assert.equal(hotelKey("Норвел-Гранд."), hotelKey("норвел гранд"));
  assert.equal(matchHotelProfile("Норвелгранд", PROFILES)?.id, "h-norvel");
  assert.equal(matchHotelProfile("Таврин", PROFILES)?.id, "h-tavrin");
  assert.equal(matchHotelProfile("Таврин Бэй Резорт Хотел", PROFILES)?.id, "h-tavrin", "a longer spelling of the profile still links");
  const twoTavrins = [...PROFILES, { id: "h-tavrin-2", name: "Таврин Парк", stars: null, description: "" }];
  assert.equal(matchHotelProfile("Таврин", twoTavrins), null, "two profiles could be meant: no guess");
  assert.equal(matchHotelProfile("Но", PROFILES), null, "a two-letter name links nothing");
  assert.equal(matchHotelProfile("Зэлмүүн", PROFILES), null);
});

test("a stay in two hotels links both profiles and never one by the start of its name", () => {
  assert.deepEqual(linkHotelOption(COMBO, PROFILES), { hotelId: "h-norvel+h-tavrin", profileIds: ["h-norvel", "h-tavrin"] });
  assert.deepEqual(linkHotelOption(SINGLE, PROFILES), { hotelId: "h-tavrin", profileIds: ["h-tavrin"] });
  // One part unknown: the known hotel is still linked, but the option gets no identity of its own.
  assert.deepEqual(linkHotelOption("Норвел+Зэлмүүн", PROFILES), { hotelId: null, profileIds: ["h-norvel"] });
  // A profile without an id is linked by the key of its name.
  assert.deepEqual(linkHotelOption("Норвел Гранд", [{ name: "Норвел  Гранд" }]), { hotelId: hotelKey("Норвел Гранд"), profileIds: [hotelKey("Норвел Гранд")] });
});

test("2 hotels x 2 packages become 4 rows with the hotel and the package as separate fields", () => {
  const trip = sampleTrip();
  const rows = groups(trip);
  assert.equal(rows.length, 4);
  const packageIds = (trip.extra.package_options as Row[]).map((option) => option.id);
  assert.deepEqual([...packageIds].sort(), [FREE, PROGRAM].sort());
  for (const group of rows) {
    assert.doesNotMatch(String(group.hotel), /·/, "the package is not packed into the hotel name");
    assert.ok([COMBO, SINGLE].includes(String(group.hotel)));
    assert.ok(packageIds.includes(group.package_id), "every package_id is a package option id");
    assert.deepEqual(group.dates, [DATE]);
  }
  const pick = (hotel: string, pkg: string) => rows.find((group) => group.hotel === hotel && group.package_id === pkg)!;
  assert.equal(pick(COMBO, FREE).adult_price, 1_111_111);
  assert.equal(pick(COMBO, PROGRAM).adult_price, 1_222_222);
  assert.equal(pick(SINGLE, FREE).adult_price, 1_333_333);
  assert.equal(pick(SINGLE, PROGRAM).adult_price, 1_444_444);
  assert.equal(pick(COMBO, FREE).single_price, 611_111);
  assert.equal(pick(SINGLE, FREE).single_price, 811_111);
  assert.equal(pick(COMBO, FREE).seats_left, 7);
  assert.equal(pick(SINGLE, PROGRAM).seats_left, 30);
  assert.equal(pick(COMBO, PROGRAM).hotel_id, "h-norvel+h-tavrin");
  assert.deepEqual(pick(COMBO, PROGRAM).hotel_profile_ids, ["h-norvel", "h-tavrin"]);
  assert.equal(pick(SINGLE, FREE).hotel_id, "h-tavrin");
  // The poster still prints one readable row per hotel and package.
  assert.deepEqual(buildPriceTable(sampleTour()).rows.map((entry) => entry.cells[0]), [`${COMBO} · ${FREE}`, `${COMBO} · ${PROGRAM}`, `${SINGLE} · ${FREE}`, `${SINGLE} · ${PROGRAM}`]);
});

test("the resolver asks for the hotel and the package as two separate choices", () => {
  const trip = sampleTrip();
  const byDate = resolveTripOfferFareCard(trip, { date: DATE }, NOW);
  assert.equal(byDate.status, "needs_selection");
  assert.ok(byDate.status === "needs_selection");
  assert.deepEqual(byDate.fields, ["hotel"]);
  assert.deepEqual([...byDate.options].sort(), [COMBO, SINGLE].sort(), "two hotels, not four hotel+package strings");

  const byHotel = resolveTripOfferFareCard(trip, { date: DATE, hotel: SINGLE }, NOW);
  assert.ok(byHotel.status === "needs_selection");
  assert.equal(byHotel.reason, "package_required");
  assert.deepEqual([...byHotel.options].sort(), [FREE, PROGRAM].sort());

  const byPackage = resolveTripOfferFareCard(trip, { date: DATE, packageId: PROGRAM }, NOW);
  assert.ok(byPackage.status === "needs_selection");
  assert.equal(byPackage.reason, "hotel_required");
  assert.deepEqual([...byPackage.options].sort(), [COMBO, SINGLE].sort());

  for (const [hotel, pkg, adult, hotelId] of [[COMBO, FREE, 1_111_111, "h-norvel+h-tavrin"], [COMBO, PROGRAM, 1_222_222, "h-norvel+h-tavrin"], [SINGLE, FREE, 1_333_333, "h-tavrin"], [SINGLE, PROGRAM, 1_444_444, "h-tavrin"]] as const) {
    const card = resolveTripOfferFareCard(trip, { date: DATE, hotel, packageId: pkg }, NOW);
    assert.ok(card.status === "ready", `${hotel} / ${pkg} resolves`);
    assert.deepEqual(card.offer.prices.adult, { kind: "exact", amount: adult });
    assert.equal(card.offer.hotel, hotel);
    assert.equal(card.offer.packageId, pkg);
    assert.equal(card.offer.hotelId, hotelId);
  }

  const booking = resolveTripOffer(trip, { date: DATE, hotel: SINGLE, packageId: FREE, passengers: [{ kind: "adult", count: 2 }] }, NOW);
  assert.ok(booking.status === "ready");
  assert.deepEqual(booking.offer.total, { kind: "exact", amount: 2_666_666 });
  assert.equal(booking.offer.availability.seatsLeft, 30, "seats are the chosen hotel's, not another hotel's");

  const unknown = resolveTripOfferFareCard(trip, { date: DATE, hotel: SINGLE, packageId: "Зэлмүүн багц" }, NOW);
  assert.equal(unknown.status, "unavailable");
});

test("split rows carry no fare conflict for the validator", () => {
  const trip = sampleTrip();
  const codes = auditTripFacts(trip, NOW).errors.map((issue) => issue.code);
  assert.ok(!codes.some((code) => /price|fare/.test(code)), `no fare conflicts: ${codes.join(", ")}`);
  // Control: without package_id the two fares of one hotel and date ARE a conflict, so the package
  // is what keeps them apart (and why it used to be packed into the hotel name).
  const unpackaged = { ...trip, extra: { ...trip.extra, price_groups: groups(trip).map((group) => {
    const copy = { ...group };
    delete copy.package_id;
    return copy;
  }) } };
  assert.ok(auditTripFacts(unpackaged, NOW).errors.some((issue) => issue.code === "conflicting_price_groups"));
});

test("the website projection keeps hotel and package apart on every fare row", () => {
  const trip = sampleTrip();
  const website = websiteTripPayload(trip, websiteDepartureSchedule(trip, NOW), NOW);
  assert.equal(website.priceGroups.length, 4);
  const pairs = website.priceGroups.map((group) => `${group.hotel}|${group.package_id}`).sort();
  assert.deepEqual(pairs, [`${COMBO}|${FREE}`, `${COMBO}|${PROGRAM}`, `${SINGLE}|${FREE}`, `${SINGLE}|${PROGRAM}`].sort());
  assert.ok(website.priceGroups.every((group) => group.hotel_id), "the hotel identity reaches the website");
  assert.equal(website.price, 1_111_111);
});

test("hotel profiles carry the partner's id, stars and hotel link, and keep photos staff added", () => {
  const staffMedia = [{ url: "https://res.cloudinary.com/demo/image/upload/norvel-pool.jpg", caption: "Усан сан" }];
  const trip = sampleTrip(sampleTour(), { hotel_profiles: [
    { name: "Норвел Гранд", url: "https://own.example.com/norvel", media: staffMedia },
    { name: "Таврин Бэй Резорт", url: "https://own.example.com/tavrin-old", media: [{ url: "not-a-link" }] },
  ] });
  const profiles = trip.extra.hotel_profiles as Row[];
  // Мөрөнгө Палас is sold in no price row and holds only the partner's facts: it is left out.
  assert.deepEqual(profiles.map((profile) => profile.id), ["h-norvel", "h-tavrin"]);
  const norvel = profiles[0];
  assert.equal(norvel.url, "https://own.example.com/norvel", "the partner publishes no link: the staff link stays");
  assert.deepEqual(norvel.media, staffMedia);
  assert.equal(norvel.stars, 4);
  assert.equal(norvel.description, "Норвел тайлбар");
  assert.equal(profiles[1].url, "https://hotels.example.com/tavrin", "the partner's own hotel link wins");
  assert.deepEqual(profiles[1].media, []);
  assert.deepEqual(trip.extra.hotel_links, [
    { name: "Норвел Гранд", url: "https://own.example.com/norvel" },
    { name: "Таврин Бэй Резорт", url: "https://hotels.example.com/tavrin" },
  ]);
  // Without stored profiles every hotel is the partner's alone.
  assert.deepEqual(partnerHotelProfiles(PROFILES).map((profile) => profile.media), [[], [], []]);
});

test("partner hotel records keep id and hotel page link; partner-domain, http and nameless records are not copied", () => {
  const partnerUrl = "https://partner.example.com/tours/sample-tour";
  const hotels = readHotels([
    { id: "h-1", name: " Норвел Гранд ", stars: "4", description: "Тайлбар", url: "https://hotels.example.com/norvel",
      cover_photo: "https://api.partner.example.com/api/upload/file?file_id=1", gallery: ["https://api.partner.example.com/api/upload/file?file_id=2"] },
    { id: 7, name: "Таврин", url: "https://api.partner.example.com/hotels/7" },
    { name: "Мөрөнгө", url: "http://hotels.example.com/moron" },
    { name: "", url: "https://hotels.example.com/none" },
  ], partnerUrl);
  assert.deepEqual(hotels, [
    { id: "h-1", name: "Норвел Гранд", description: "Тайлбар", stars: 4, url: "https://hotels.example.com/norvel" },
    { id: "7", name: "Таврин", description: "", stars: null, url: "" },
    { id: null, name: "Мөрөнгө", description: "", stars: null, url: "" },
  ]);
  assert.equal(hotelPageUrl("https://www.partner.example.com/x", "https://www.partner.example.com/tours/a"), "");
  assert.equal(hotelPageUrl("javascript:alert(1)", partnerUrl), "");
});

test("the change report names a hotel record change, and an unchanged tour reports nothing about hotels", () => {
  const before = sampleTour();
  const after = { ...sampleTour(), hotels: PROFILES.map((hotel) => (hotel.id === "h-norvel" ? { ...hotel, url: "https://hotels.example.com/norvel" } : hotel)) };
  assert.ok(describeChanges(before, after).some((line) => /Буудлын мэдээлэл/.test(line)));
  assert.ok(!describeChanges(before, sampleTour()).some((line) => /Буудлын мэдээлэл/.test(line)));
  // A snapshot stored before hotel ids/links were read still compares without throwing.
  const legacy = { ...before, hotels: before.hotels.map(({ name, stars, description }) => ({ name, stars, description })) };
  assert.ok(describeChanges(legacy, before).some((line) => /Буудлын мэдээлэл/.test(line)));
});

test("normalising the stored partner extra twice changes nothing, so an unchanged sync stays a no-op", () => {
  const fields = partnerTripFields(sampleTour());
  const once = normalizeExtraPatch(fields.extra ?? {});
  assert.deepEqual(normalizeExtraPatch(once), once);
});

test("the shared price card prints every hotel x package of the nearest date, each with its own fares", async () => {
  const { buildFarePriceLines } = await import("../src/lib/tripFareBlock");
  const block = buildFarePriceLines(sampleTrip(), NOW);
  assert.ok(block, "the card prints prices instead of falling back to the old per-row card");
  const text = block.lines.join("\n");
  for (const amount of [1_111_111, 1_222_222, 1_333_333, 1_444_444]) {
    assert.ok(text.includes(`${amount.toLocaleString("en-US")}₮`), `${amount} is on the card`);
  }
  assert.equal(block.lines.filter((line) => line.startsWith("Буудал: ")).length, 4, "four hotel x package blocks, none hidden by the cap");
  assert.equal(block.lines.filter((line) => line.startsWith("Багц: ")).length, 4);
  assert.equal(block.lines.filter((line) => line.endsWith(":") && /\d/.test(line)).length, 1, "one date heading for the four blocks of that date");
  assert.deepEqual(block.onSale, [DATE]);
});

test("a full hotel is left off the card while the date still sells at the other one", async () => {
  const { buildFarePriceLines } = await import("../src/lib/tripFareBlock");
  const input = tour([
    row(DATE, COMBO, { open: false, seats: 0, prices: prices({ adult: 1_111_111, programAdult: 1_222_222, single: 611_111 }) }),
    row(DATE, SINGLE, { seats: 30, prices: prices({ adult: 1_333_333, programAdult: 1_444_444, single: 811_111 }) }),
  ]);
  const block = buildFarePriceLines(sampleTrip({ ...input, hotels: PROFILES }), NOW);
  assert.ok(block);
  const text = block.lines.join("\n");
  assert.ok(!text.includes("1,111,111₮") && !text.includes(COMBO), "the full hotel is not offered");
  assert.ok(text.includes("1,333,333₮") && text.includes("1,444,444₮"));
});

// ---- Review round 2 (2026-11-05). These tests also cover files of other tracks that must ship
// with tripPayload.ts: tripFareBlock.ts (the per-package loop), tripKnowledgeText.ts (the package
// in the AI catalogue). Without them the split rows lose the bot's fare card, its short "which
// date?" reply, the bare-price lookup and the package label in the AI catalogue.

const DATES = ["2099-06-12", "2099-06-19", "2099-06-26", "2099-07-03"];

/** 2 hotels x 2 packages on several dates; `step` makes every date's fares its own. */
function datedTour(dates = DATES, step = 0): PartnerTour {
  const value = tour(dates.flatMap((date, index) => [
    row(date, COMBO, { seats: 7, prices: prices({ adult: 1_111_111 + index * step, programAdult: 1_222_222 + index * step }) }),
    row(date, SINGLE, { seats: 30, prices: prices({ adult: 1_333_333 + index * step, programAdult: 1_444_444 + index * step }) }),
  ]));
  return { ...value, hotels: PROFILES };
}

test("the bot's fare card, short trip reply and price lookup still work on split hotel and package rows", () => {
  const trip = sampleTrip(datedTour());
  const section = buildFareSection(trip, NOW);
  assert.ok(section, "the fare card is built, not dropped for a hotel that needs a package");
  assert.equal(section.filter((line) => line.startsWith("Буудал: ")).length, 4);
  assert.equal(section.filter((line) => line.startsWith("Багц: ")).length, 4);
  assert.equal(section.filter((line) => line.startsWith("• Том хүн")).length, 4);

  // Picking the trip asks for the date in a few lines; it is not the whole uncapped per-row card.
  const reply = buildStructuredTripReply(trip.route_name, [trip], NOW);
  assert.ok(reply && reply.length < 240, String(reply));
  assert.match(reply, /Аль гарах өдрөөр/);
  assert.doesNotMatch(reply, /₮/);

  // "Which trip costs 1,333,333₮?" finds it on every date.
  const found = tripsAtPrice([trip], 1_333_333, NOW);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].dates, DATES);
});

test("on 16 dates with fares of their own the card shows the nearest date's 4 hotel x package fares and points to the rest", () => {
  const dates = Array.from({ length: 16 }, (_, index) => new Date(Date.UTC(2099, 5, 2 + index * 3)).toISOString().slice(0, 10));
  const section = buildFareSection(sampleTrip(datedTour(dates, 1)), NOW);
  assert.ok(section);
  assert.equal(section.filter((line) => line.startsWith("• Том хүн")).length, 4, "the nearest date's four fares, no more");
  assert.ok(section.some((line) => /Бусад гарах өдрийн үнийг/.test(line)));
  assert.ok(section.length < 50, `${section.length} lines`);
});

test("the AI catalogue tells the two fares of one hotel and date apart by package, and lists only sold hotels' links", () => {
  const hotels = PROFILES.map((hotel) => (hotel.id === "h-moron" ? { ...hotel, url: "https://hotels.example.com/moron" } : hotel));
  const description = tripKnowledgeModule(sampleTrip({ ...sampleTour(), hotels }), NOW).description;
  assert.match(description, new RegExp(`Буудал ${SINGLE}: Багц ${FREE}: Том 1333333₮`));
  assert.match(description, new RegExp(`Буудал ${SINGLE}: Багц ${PROGRAM}: Том 1444444₮`));
  assert.match(description, /Таврин Бэй Резорт — https:\/\/hotels\.example\.com\/tavrin/);
  assert.doesNotMatch(description, /Мөрөнгө|hotels\.example\.com\/moron/, "a hotel no row sells is not offered with a link");
});

test("a partner hotel no row sells: no profile and no link, unless staff added to it or a row's hotel could not be linked", () => {
  const hotels = PROFILES.map((hotel) => (hotel.id === "h-moron" ? { ...hotel, url: "https://hotels.example.com/moron" } : hotel));
  const input = { ...sampleTour(), hotels };
  const plain = sampleTrip(input);
  assert.ok(!(plain.extra.hotel_profiles as Row[]).some((profile) => profile.id === "h-moron"));
  assert.ok(!(plain.extra.hotel_links as Row[]).some((link) => /moron/.test(String(link.url))));

  // Staff added a photo: the profile stays (nothing of staff's is lost), but it is still not a sold hotel's link.
  const photo = [{ url: "https://res.cloudinary.com/demo/image/upload/moron.jpg", caption: "" }];
  const withPhoto = sampleTrip(input, { hotel_profiles: [{ id: "h-moron", name: "Мөрөнгө Палас", url: "", media: photo }] });
  const kept = (withPhoto.extra.hotel_profiles as Row[]).find((profile) => profile.id === "h-moron");
  assert.deepEqual(kept?.media, photo);
  assert.ok(!(withPhoto.extra.hotel_links as Row[]).some((link) => /moron/.test(String(link.url))));

  // A row whose hotel matches no profile: which hotels are unsold is not known, so none is dropped.
  const unknownRow = tour([...input.rows, row(DATE, "Зэлмүүн", { prices: prices({ adult: 1_555_555, programAdult: 1_666_666 }) })]);
  const unsure = sampleTrip({ ...unknownRow, hotels });
  assert.ok((unsure.extra.hotel_profiles as Row[]).some((profile) => profile.id === "h-moron"));
  assert.ok(!(unsure.extra.hotel_links as Row[]).some((link) => /moron/.test(String(link.url))));
});

test("a text that names two hotels is never linked to the first one by the start of its name", () => {
  const both = { hotelId: "h-norvel+h-tavrin", profileIds: ["h-norvel", "h-tavrin"] };
  const none = { hotelId: null, profileIds: [] };
  // The website splits exactly these too (booking-web splitHotelNames): +, a spaced " / ", эсвэл, or.
  for (const option of ["Норвел Гранд эсвэл Таврин", "Норвел Гранд ЭСВЭЛ Таврин", "Норвел Гранд or Таврин",
    "Норвел Гранд / Таврин", "Норвел Гранд+Таврин"]) {
    assert.deepEqual(linkHotelOption(option, PROFILES), both, option);
  }
  // "&", an unspaced "/", "буюу", a comma or "болон" do not split ("Resort & Spa" is one hotel),
  // and the text is not read as its first hotel either.
  for (const option of ["Норвел Гранд, Таврин", "Норвел Гранд болон Таврин", "Норвел Гранд ба Таврин", "Норвел Гранд Таврин",
    "Норвел Гранд & Таврин", "Норвелгранд/Таврин", "Норвел Гранд буюу Таврин"]) {
    assert.deepEqual(linkHotelOption(option, PROFILES), none, option);
  }
  assert.deepEqual(hotelOptionParts("Норвелгранд/Таврин"), ["Норвелгранд/Таврин"]);
  assert.deepEqual(hotelOptionParts("Altara Resort & Spa"), ["Altara Resort & Spa"]);
  assert.deepEqual(hotelOptionParts("Норвел Гранд, Шинэ хот"), ["Норвел Гранд, Шинэ хот"]);
  // A longer spelling of one hotel still links, and so does a name with a joiner that IS a profile's whole name.
  assert.equal(matchHotelProfile("Таврин Бэй Резорт Хотел", PROFILES)?.id, "h-tavrin");
  assert.equal(matchHotelProfile("Таврин Бэй Резорт Хотел", PROFILES, { longerSpelling: false }), null);
  const amp = [{ id: "h-amp", name: "Норвел & Спа" }];
  assert.deepEqual(linkHotelOption("Норвел & Спа", amp), { hotelId: "h-amp", profileIds: ["h-amp"] });
});

test("two different options sold on one date that read as one profile keep apart; one hotel spelled two ways on two dates keeps its id", () => {
  const profiles: PartnerTour["hotels"] = [{ id: "h-tavrin", name: "Таврин Бэй Резорт", stars: 5, description: "", url: "" }];
  const wings = { ...tour([
    row(DATE, "Таврин", { seats: 30, prices: prices({ adult: 1_111_111, programAdult: 1_222_222 }) }),
    row(DATE, "Таврин Бэй", { seats: 10, prices: prices({ adult: 1_333_333, programAdult: 1_444_444 }) }),
  ]), hotels: profiles };
  const trip = sampleTrip(wings);
  for (const group of groups(trip)) {
    assert.equal("hotel_id" in group, false, `${group.hotel} gets no shared hotel_id`);
    assert.deepEqual(group.hotel_profile_ids, ["h-tavrin"], "both still show the hotel's profile");
  }
  assert.ok(!auditTripFacts(trip, NOW).errors.some((issue) => issue.code === "conflicting_price_groups"), "the save is not refused");
  const card = resolveTripOfferFareCard(trip, { date: DATE }, NOW);
  assert.ok(card.status === "needs_selection");
  assert.deepEqual([...card.options].sort(), ["Таврин", "Таврин Бэй"]);
  assert.ok(buildFareSection(trip, NOW));

  const links = linkHotelOptions([{ hotel: "Таврин", dates: ["2099-06-12"] }, { hotel: "Таврин Бэй", dates: ["2099-06-19"] }], profiles);
  assert.equal(links.get("Таврин")?.hotelId, "h-tavrin");
  assert.equal(links.get("Таврин Бэй")?.hotelId, "h-tavrin");
});

/** The hotels staff and partner both write to, for the staff-edit tests. */
const STAFF_HOTELS: PartnerTour["hotels"] = [
  { id: "h-norvel", name: "Норвел Гранд", stars: 4, description: "", url: "" },
  { id: "h-tavrin", name: "Таврин Бэй Резорт", stars: 5, description: "Партнерын тайлбар", url: "https://hotels.example.com/tavrin" },
];
const staffTour = (hotels = STAFF_HOTELS): PartnerTour => ({ ...sampleTour(), hotels });
const storedProfiles = (trip: TravelTrip) => normalizeExtraPatch({ hotel_profiles: trip.extra.hotel_profiles }).hotel_profiles as Row[];

test("the partner sync keeps what staff wrote on a partner hotel: description, corrected link, photos and their own hotels", () => {
  const first = sampleTrip(staffTour());
  const photo = (name: string) => ({ url: `https://res.cloudinary.com/demo/image/upload/${name}.jpg`, caption: "" });
  // Staff edit in the admin: a description where the partner has none, a corrected link and
  // description, photos, a hotel the partner does not list, and photos saved under a shorter spelling.
  const edited: Row[] = storedProfiles(first).map((profile) => profile.id === "h-norvel"
    ? { ...profile, description: "Ажилтны тайлбар", media: [photo("norvel")] }
    : { ...profile, url: "https://own.example.com/tavrin-fixed", description: "Засварласан тайлбар" });
  edited.push({ name: "Зэлмүүн Лодж", url: "https://own.example.com/zelmuun", description: "Нэмсэн", media: [photo("zelmuun")] });
  edited.push({ name: "Таврин", url: "", description: "", media: [photo("tavrin-pool")] });
  const stored = normalizeExtraPatch({ hotel_profiles: edited });
  // The poster keeps the partner tour these profiles were written from (buildPosterData keeps the stored poster's).
  const poster = { partner_snapshot: staffTour() };

  const next = sampleTrip(staffTour(), stored, poster);
  const profiles = storedProfiles(next);
  const byId = (id: string) => profiles.find((profile) => profile.id === id)!;
  assert.equal(byId("h-norvel").description, "Ажилтны тайлбар");
  assert.deepEqual(byId("h-norvel").media, [photo("norvel")]);
  assert.equal(byId("h-tavrin").url, "https://own.example.com/tavrin-fixed", "a staff correction is not undone by the partner's link");
  assert.equal(byId("h-tavrin").description, "Засварласан тайлбар");
  assert.deepEqual(byId("h-tavrin").media, [photo("tavrin-pool")], "photos saved under a shorter spelling move onto the hotel");
  assert.equal(byId("h-tavrin").name, "Таврин Бэй Резорт", "the partner still names the hotel");
  assert.ok(!profiles.some((profile) => profile.name === "Таврин"), "no second profile for the same hotel");
  const own = profiles.find((profile) => profile.name === "Зэлмүүн Лодж");
  assert.deepEqual(own, { name: "Зэлмүүн Лодж", url: "https://own.example.com/zelmuun", description: "Нэмсэн", media: [photo("zelmuun")] });

  // The next run over the same data changes nothing (the sync stays a no-op).
  const again = sampleTrip(staffTour(), { ...stored, hotel_profiles: profiles }, poster);
  assert.deepEqual(storedProfiles(again), profiles);
});

test("a value staff never changed follows the partner, and a hotel the partner drops goes unless staff added to it", () => {
  const poster = { partner_snapshot: staffTour() };
  const stored = { hotel_profiles: storedProfiles(sampleTrip(staffTour())) };
  const moved = STAFF_HOTELS.map((hotel) => (hotel.id === "h-tavrin" ? { ...hotel, url: "https://hotels.example.com/tavrin-new", description: "Шинэ тайлбар" } : hotel));
  const tavrin = storedProfiles(sampleTrip(staffTour(moved), stored, poster)).find((profile) => profile.id === "h-tavrin")!;
  assert.equal(tavrin.url, "https://hotels.example.com/tavrin-new");
  assert.equal(tavrin.description, "Шинэ тайлбар");

  const merged = (existing: Row[]) => mergePartnerHotelProfiles([STAFF_HOTELS[1]], existing, STAFF_HOTELS).map((entry) => entry.profile.name);
  const norvel = storedProfiles(sampleTrip(staffTour())).find((profile) => profile.id === "h-norvel")!;
  assert.deepEqual(merged([norvel]), ["Таврин Бэй Резорт"], "the partner no longer lists it and nothing of staff's is on it");
  assert.deepEqual(merged([{ ...norvel, media: [{ url: "https://res.cloudinary.com/demo/image/upload/n.jpg" }] }]), ["Таврин Бэй Резорт", "Норвел Гранд"]);

  // Without a stored snapshot a staff value cannot be told from an older partner value:
  // the partner's non-empty value wins, and an empty one keeps what is stored.
  const blind = mergePartnerHotelProfiles(STAFF_HOTELS, [
    { id: "h-norvel", name: "Норвел Гранд", description: "Ажилтны тайлбар" },
    { id: "h-tavrin", name: "Таврин Бэй Резорт", url: "https://own.example.com/x", description: "Хуучин" },
  ]).map((entry) => entry.profile);
  assert.equal(blind[0].description, "Ажилтны тайлбар");
  assert.equal(blind[1].url, "https://hotels.example.com/tavrin");
  assert.equal(blind[1].description, "Партнерын тайлбар");
});

test("hotel photos and links follow one https rule in the schema and in the partner sync", () => {
  const media = [{ url: "http://cdn.example.com/a.jpg", caption: "" }, { url: "https://cdn.example.com/b.jpg", caption: "" }];
  const { extra, warnings } = normalizeExtra({ hotel_profiles: [{ name: "Норвел Гранд", url: "http://own.example.com/norvel", media }] });
  const saved = (extra.hotel_profiles as Row[])[0];
  assert.deepEqual(saved.media, [media[1]]);
  assert.equal(saved.url, "");
  assert.ok(warnings.some((warning) => /https биш/.test(warning)));
  assert.ok(warnings.some((warning) => /1 зураг https URL-гүй/.test(warning)));
  const synced = partnerHotelProfiles([STAFF_HOTELS[0]], [{ name: "Норвел Гранд", url: "http://own.example.com/norvel", media }], STAFF_HOTELS)[0];
  assert.deepEqual(synced.media, saved.media);
  assert.equal(synced.url, saved.url);
});

test("a hotel sold in only one package still names it, and the reply checker accepts the card in either row order", async () => {
  const { buildFareSection } = await import("../src/lib/tripFareBlock");
  const { verifyTripReply } = await import("../src/lib/tripReplyVerification");
  const both = row(DATE, COMBO, { seats: 7, prices: prices({ adult: 1_111_111, programAdult: 1_222_222, single: 611_111 }) });
  const one = row(DATE, SINGLE, { seats: 30, prices: prices({ adult: 1_333_333, programAdult: null, single: 811_111 }) });
  for (const rows of [[both, one], [one, both]]) {
    const trip = sampleTrip({ ...tour(rows), hotels: PROFILES });
    const section = buildFareSection(trip, NOW);
    assert.ok(section, "the card prints");
    const text = section.join("\n");
    assert.equal(section.filter((line) => line.startsWith("Багц: ")).length, 3, `every block names its package:\n${text}`);
    assert.ok(text.includes("1,333,333₮"));
    assert.notEqual(verifyTripReply({ reply: text, trips: [trip], now: NOW }), "REFER", `checker accepts:\n${text}`);
  }
});

test("16 dates x 4 variants with a supplement that changes every date still makes one Messenger-sized card", async () => {
  const { buildFareSection } = await import("../src/lib/tripFareBlock");
  const { verifyTripReply } = await import("../src/lib/tripReplyVerification");
  const dates = Array.from({ length: 16 }, (_, index) => `2099-06-${String(index + 10).padStart(2, "0")}`);
  const rows = dates.flatMap((date, index) => [
    row(date, COMBO, { seats: 7, prices: prices({ adult: 1_111_111, programAdult: 1_222_222, single: 600_000 + index * 1_000 }) }),
    row(date, SINGLE, { seats: 30, prices: prices({ adult: 1_333_333, programAdult: 1_444_444, single: 800_000 + index * 1_000 }) }),
  ]);
  const trip = sampleTrip({ ...tour(rows), hotels: PROFILES });
  const text = (buildFareSection(trip, NOW) || []).join("\n");
  assert.ok(text.length < 2000, `card is ${text.length} chars:\n${text}`);
  assert.ok(text.includes("Бусад өдрийн ганцаараа явах үнийг"));
  assert.notEqual(verifyTripReply({ reply: text, trips: [trip], now: NOW }), "REFER");
});

test("a hotel full on the nearest date: the next date is shown whole or not at all", async () => {
  const { buildFareSection } = await import("../src/lib/tripFareBlock");
  const LATER = "2099-06-19";
  const input = tour([
    row(DATE, COMBO, { seats: 7, prices: prices({ adult: 1_111_111, programAdult: 1_222_222 }) }),
    row(DATE, SINGLE, { open: false, seats: 0, prices: prices({ adult: 1_333_333, programAdult: 1_444_444 }) }),
    row(LATER, COMBO, { seats: 7, prices: prices({ adult: 1_111_111, programAdult: 1_222_222 }) }),
    row(LATER, SINGLE, { seats: 30, prices: prices({ adult: 1_555_555, programAdult: 1_666_666 }) }),
  ]);
  const text = (buildFareSection(sampleTrip({ ...input, hotels: PROFILES }), NOW) || []).join("\n");
  const shownSingle = ["1,555,555₮", "1,666,666₮"].filter((amount) => text.includes(amount)).length;
  assert.ok(shownSingle === 0 || shownSingle === 2, `both or neither package of the later hotel:\n${text}`);
});

test("asked about a date, the hotel answer leaves out a hotel that is full on that date", async () => {
  const { tripHotels } = await import("../src/lib/tripHotelReply");
  const input = tour([
    row(DATE, COMBO, { seats: 7, prices: prices({ adult: 1_111_111, programAdult: 1_222_222 }) }),
    row(DATE, SINGLE, { open: false, seats: 0, prices: prices({ adult: 1_333_333, programAdult: 1_444_444 }) }),
  ]);
  const hotels = tripHotels(sampleTrip({ ...input, hotels: PROFILES }), { date: DATE }, NOW);
  const names = (hotels?.hotels || []).map((hotel) => hotel.name).join(" | ");
  assert.ok(!/Таврин Бэй|Таврин$/.test(names.replace(/Норвел.*?\+\s*/g, "")) || names.includes("+"), names);
  assert.ok((hotels?.hotels || []).every((hotel) => hotel.name !== "Таврин Бэй Резорт"), `the full hotel is not offered: ${names}`);
});

test("the AI catalogue marks a hotel x package row that is full on its date", async () => {
  const { tripKnowledgeModule } = await import("../src/lib/tripKnowledgeText");
  const input = tour([
    row(DATE, COMBO, { seats: 7, prices: prices({ adult: 1_111_111, programAdult: 1_222_222 }) }),
    row(DATE, SINGLE, { open: false, seats: 0, prices: prices({ adult: 1_333_333, programAdult: 1_444_444 }) }),
  ]);
  const text = JSON.stringify(tripKnowledgeModule(sampleTrip({ ...input, hotels: PROFILES }), NOW));
  const fullRows = text.match(/Буудал Таврин:[^\]]*\]/g) || [];
  assert.ok(fullRows.length >= 1 && fullRows.every((rowText) => rowText.includes("суудал дүүрсэн, санал болгохгүй")), fullRows.join("\n"));
  const openRows = text.match(/Буудал Норвелгранд\+Таврин:[^\]]*\]/g) || [];
  assert.ok(openRows.length >= 1 && openRows.every((rowText) => !rowText.includes("дүүрсэн")), openRows.join("\n"));
});
