import { mapPosterTripToFields } from "../poster/tripMapper";
import type { TripMutationFields } from "../travelTypes";
import type { PartnerTour } from "./globalTravel";
import { accommodationLabel, buildPosterData, lowestAdultPrice, packageVariants } from "./posterPayload";

/** The full commercial replacement, including removals of old imported facts. */
export function buildTripFields(tour: PartnerTour, poster: Record<string, unknown>): TripMutationFields {
  const mapped = mapPosterTripToFields(poster as Parameters<typeof mapPosterTripToFields>[0]);
  const variants = tour.rows.flatMap((row) => packageVariants(row).map((pkg) => ({ row, pkg })));
  const groups = (mapped.extra?.price_groups ?? []).map((group) => {
    const match = variants.find(({ row, pkg }) => group.dates.includes(row.date) && group.hotel === accommodationLabel(row.hotel, pkg.package));
    if (!match) throw new Error("Partner price table did not round-trip through the poster mapper");
    return { ...group, partner_source: true, status: match.row.open ? "open" : "sold_out", seats_left: match.row.open ? match.row.seats : 0 };
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
      room_prices: [], extra_fees: [], answer_hints: [], hotel_links: [], recurring_schedule: "",
      package_options: [...new Set(variants.map(({ pkg }) => pkg.package))].map((label) => ({ id: label, label, note: "" })),
      departure_rule: "",
      included_items: tour.includes, excluded_items: tour.excludes,
      itinerary_days: tour.days.map((day) => ({ day: day.day, title: day.title, description: day.lines.join("\n"), hotel: day.accommodation ?? "", meals: day.meals })),
      website_summary: tour.description,
      partner_sync: { source_url: tour.sourceUrl, content_hash: tour.contentHash },
      partner_departure_availability: tour.dates.map((date) => {
        const rows = tour.rows.filter((row) => row.date === date && row.open);
        return { date, status: rows.length ? "OPEN" : "SOLD_OUT", seatsLeft: rows.length ? null : 0 };
      }),
      hotel_profiles: tour.hotels.map((hotel) => ({ name: hotel.name, description: hotel.description, url: "", media: [] })),
    },
  };
}

export function partnerTripFields(tour: PartnerTour, existing: unknown = {}) {
  return buildTripFields(tour, buildPosterData(tour, existing));
}
