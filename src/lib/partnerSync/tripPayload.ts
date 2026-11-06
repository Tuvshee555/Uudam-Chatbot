import { mapPosterTripToFields } from "../poster/tripMapper";
import type { TripMutationFields } from "../travelTypes";
import type { PartnerTour } from "./globalTravel";
import { hotelProfileId, linkHotelOptions, mergePartnerHotelProfiles, snapshotHotels } from "./hotelProfiles";
import { accommodationLabel, buildPosterData, lowestAdultPrice, packageVariants } from "./posterPayload";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * The trip's hotels and each price row's hotel link.
 *
 * Profiles are the partner's hotels merged with what staff stored (hotelProfiles.ts). A partner
 * hotel that no price row sells, holding nothing but the partner's own facts, is left out: the
 * website already hides a hotel the trip does not sell, and the bot's AI catalogue listed it with
 * its booking link as if it did. It is kept while any row's hotel could not be linked, because
 * then "no row sells it" is not known. `hotel_links` (the older name -> link list) lists only
 * hotels a row sells.
 */
function tripHotels(tour: PartnerTour, poster: Record<string, unknown>, existingExtra: unknown) {
  const merged = mergePartnerHotelProfiles(tour.hotels, record(existingExtra).hotel_profiles, snapshotHotels(poster.partner_snapshot));
  const links = linkHotelOptions(tour.rows.map((row) => ({ hotel: row.hotel, dates: [row.date] })), merged.map((entry) => entry.profile));
  const sold = new Set([...links.values()].flatMap((link) => link.profileIds));
  const everyRowLinked = [...links.values()].every((link) => link.hotelId);
  const profiles = merged
    .filter((entry) => !entry.partnerOnly || sold.has(hotelProfileId(entry.profile)) || !everyRowLinked)
    .map((entry) => entry.profile);
  const hotelLinks = profiles.filter((profile) => profile.url && sold.has(hotelProfileId(profile))).map(({ name, url }) => ({ name, url }));
  return { links, profiles, hotelLinks };
}

/**
 * The partner owns each day's title, text, hotel and meals. Uudam's staff add a day's meal note
 * ("буфет", a restaurant) and its photo: those come forward from the stored day of the same day
 * number (by position when none has it), the rule mergeDays in posterPayload.ts keeps for the
 * poster day. Built from the partner's days alone, every 30-minute run dropped them, and run.ts
 * then saw a difference and wrote the trip again.
 */
function partnerItineraryDays(tour: PartnerTour, existingExtra: unknown) {
  const storedDays = record(existingExtra).itinerary_days;
  const stored = Array.isArray(storedDays) ? storedDays.map(record) : [];
  return tour.days.map((day, index) => {
    const own = stored.find((item) => Number(item.day) === day.day) ?? stored[index] ?? {};
    const photo = typeof own.photo === "string" ? own.photo.trim() : "";
    const mealNote = typeof own.meal_note === "string" ? own.meal_note.trim() : "";
    return {
      day: day.day, title: day.title, description: day.lines.join("\n"), hotel: day.accommodation ?? "", meals: day.meals,
      ...(photo ? { photo } : {}),
      ...(mealNote ? { meal_note: mealNote } : {}),
    };
  });
}

/**
 * The full commercial replacement, including removals of old imported facts.
 *
 * `existingExtra` is the trip's stored extra: hotel photos, links, descriptions and hotels that
 * Uudam's staff added are kept (hotelProfiles.ts). `poster.partner_snapshot`, when present, is the
 * partner tour the stored profiles were written from (buildPosterData keeps the stored poster's).
 */
export function buildTripFields(tour: PartnerTour, poster: Record<string, unknown>, existingExtra: unknown = {}): TripMutationFields {
  const mapped = mapPosterTripToFields(poster as Parameters<typeof mapPosterTripToFields>[0]);
  const variants = tour.rows.flatMap((row) => packageVariants(row).map((pkg) => ({ row, pkg })));
  const hotels = tripHotels(tour, poster, existingExtra);
  const groups = (mapped.extra?.price_groups ?? []).map((group) => {
    const match = variants.find(({ row, pkg }) => group.dates.includes(row.date) && group.hotel === accommodationLabel(row.hotel, pkg.package));
    if (!match) throw new Error("Partner price table did not round-trip through the poster mapper");
    // The poster row names hotel and package together; the trip keeps them as two choices, so a
    // customer picks the hotel and the package separately (and the website shows a package picker).
    const link = hotels.links.get(match.row.hotel) ?? { hotelId: null, profileIds: [] };
    return {
      ...group,
      hotel: match.row.hotel,
      package_id: match.pkg.package,
      ...(link.hotelId ? { hotel_id: link.hotelId } : {}),
      ...(link.profileIds.length ? { hotel_profile_ids: link.profileIds } : {}),
      partner_source: true, status: match.row.open ? "open" : "sold_out", seats_left: match.row.open ? match.row.seats : 0,
    };
  });
  if (groups.length !== variants.length) throw new Error("Partner price groups were lost during mapping");
  const primary = variants.filter(({ row }) => row.open).sort((a, b) => a.pkg.adult! - b.pkg.adult!)[0]
    ?? variants.sort((a, b) => a.pkg.adult! - b.pkg.adult!)[0];
  return {
    duration_text: mapped.duration_text,
    adult_price: lowestAdultPrice(tour),
    child_price: primary?.pkg.child6to11 ?? primary?.pkg.child2to5 ?? null,
    infant_price: primary?.row.prices.infant ?? null,
    currency: "MNT",
    departure_dates: tour.dates,
    seats_left: null,
    seats_total: null,
    hotel: tour.hotelOptions.join(", "),
    notes: tour.description,
    has_food: mapped.has_food,
    extra: {
      ...mapped.extra,
      price_groups: groups,
      departure_date_groups: [], discounts: [], discount_groups: [], child_rules: [], child_price_rules: [], passenger_prices: [],
      room_prices: [], extra_fees: [], answer_hints: [], recurring_schedule: "",
      // The links of the hotels a row sells, for readers that only know the older name -> link list.
      hotel_links: hotels.hotelLinks,
      // Every package_id on a price row is one of these ids.
      package_options: [...new Set(variants.map(({ pkg }) => pkg.package))].map((label) => ({ id: label, label, note: "" })),
      departure_rule: "",
      included_items: tour.includes, excluded_items: tour.excludes,
      itinerary_days: partnerItineraryDays(tour, existingExtra),
      website_summary: tour.description,
      partner_sync: { source_url: tour.sourceUrl, content_hash: tour.contentHash },
      partner_departure_availability: tour.dates.map((date) => {
        const rows = tour.rows.filter((row) => row.date === date && row.open);
        return { date, status: rows.length ? "OPEN" : "SOLD_OUT", seatsLeft: rows.length ? null : 0 };
      }),
      hotel_profiles: hotels.profiles,
    },
  };
}

export function partnerTripFields(tour: PartnerTour, existing: unknown = {}, existingExtra: unknown = {}) {
  return buildTripFields(tour, buildPosterData(tour, existing), existingExtra);
}
