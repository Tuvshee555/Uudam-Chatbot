// Turns a partner tour (see globalTravel.ts) into the poster shape the admin itself saves, so the
// mirrored trip flows through the normal poster -> chatbot -> website pipeline with no special cases.
import type { PartnerOffer, PartnerTour } from "./globalTravel";

const money = (amount: number) => `${amount.toLocaleString("en-US")}₮`;

/**
 * The poster price table, in the exact shape src/lib/poster/tripMapper.ts reads:
 * a "Буудал" column it recognises as the accommodation label, and a "Том хүний үнэ"
 * column it recognises as the adult fare (see isAdultColumn / findPriceColumnIndex there).
 * One row per departure date x package x hotel, because a row carries a single adult price.
 *
 * Writing a wider table with one column per package, as the partner's own page does, makes the
 * mapper find no adult column at all and store a null price, so the shape below is deliberate.
 */
export const PRICE_TABLE_COLUMNS = ["Явах огноо", "Буудал", "Том хүний үнэ"] as const;

/**
 * The accommodation label the rest of the system keys fares on. The partner sells the same hotel at
 * two prices depending on the package, so the package has to be part of the label: with the hotel
 * alone, tripDataValidation rejects the trip for holding two different adult fares for one hotel,
 * date and passenger category, which is the correct complaint about an ambiguous offer.
 */
export const accommodationLabel = (offer: PartnerOffer) => `${offer.hotelLabel} · ${offer.packageLabel}`;

export function buildPriceTable(tour: PartnerTour) {
  return {
    note: `Үнэ, огноо, буудлыг ${new URL(tour.sourceUrl).host}-аас автоматаар авсан. Том хүний үнэ.`,
    columns: [...PRICE_TABLE_COLUMNS],
    rows: tour.offers.map((offer) => ({
      dates: offer.date,
      cells: [
        offer.date,
        accommodationLabel(offer),
        offer.inStock ? money(offer.adultPrice) : `${money(offer.adultPrice)} (дууссан)`,
      ],
    })),
  };
}

/**
 * price_groups drive the chatbot's fare answers: one group per date x package x hotel.
 * Only the adult price is published by the partner, so child/infant are left unset rather than
 * invented; the bot then says it does not know instead of quoting a made-up number.
 */
export function buildPriceGroups(tour: PartnerTour) {
  return tour.offers.map((offer) => ({
    id: `${tour.sourceUrl}#${offer.date}|${offer.packageLabel}|${offer.hotelLabel}`,
    label: offer.date,
    dates: [offer.date],
    display_dates: [offer.date],
    date_keys: [offer.date],
    hotel: accommodationLabel(offer),
    package_id: offer.packageLabel,
    adult_price: offer.adultPrice,
    currency: offer.currency,
    sold_out: !offer.inStock,
    note: "",
  }));
}

/** The lowest adult price the partner currently advertises, used as the trip's headline price. */
export function lowestAdultPrice(tour: PartnerTour): number | null {
  const available = tour.offers.filter((offer) => offer.inStock).map((offer) => offer.adultPrice);
  const prices = available.length ? available : tour.offers.map((offer) => offer.adultPrice);
  return prices.length ? Math.min(...prices) : null;
}

export function buildPosterData(tour: PartnerTour, agencyName: string): Record<string, unknown> {
  const adultPrice = lowestAdultPrice(tour);
  return {
    title: tour.title,
    subtitle: tour.destinations.join(", "),
    agency: agencyName,
    operator: agencyName,
    source_url: tour.sourceUrl,
    hero_image: tour.heroImage,
    duration_days: tour.durationDays,
    duration_nights: tour.durationNights,
    duration_text: tour.durationDays ? `${tour.durationDays} өдөр ${tour.durationNights} шөнө` : "",
    destinations: tour.destinations,
    hotel: tour.hotels.join(", "),
    hotels: tour.hotels,
    currency: tour.offers[0]?.currency ?? "MNT",
    adult_price: adultPrice,
    price_desc: tour.description,
    price_note: `Эх сурвалж: ${tour.sourceUrl}`,
    price_table: buildPriceTable(tour),
    departures: tour.dates.map((date) => ({ date })),
    // The poster mapper reads `route` and `summary` per day (see PosterDay in poster/tripMapper.ts);
    // `title`/`lines` would be carried along but never read, so the day text is written into both.
    days: tour.days.map((day) => ({
      day: day.day,
      route: day.title,
      summary: day.lines.join("\n"),
      title: day.title,
      lines: day.lines,
    })),
    includes: tour.includes,
    excludes: tour.excludes,
    faq: tour.faq,
    package_options: tour.packages.map((label) => ({ id: label, label, note: "" })),
    price_groups: buildPriceGroups(tour),
    partner_sync: {
      source_url: tour.sourceUrl,
      content_hash: tour.contentHash,
      partner_updated: tour.dateModified,
      synced_at: new Date().toISOString(),
    },
  };
}

/** A short human summary of what changed between two syncs, for the Telegram message. */
export function describeChanges(before: PartnerTour | null, after: PartnerTour): string[] {
  if (!before) return [`Анхны хуулалт: ${after.offers.length} үнэ, ${after.dates.length} огноо.`];
  const lines: string[] = [];
  const key = (offer: PartnerOffer) => `${offer.date}|${offer.packageLabel}|${offer.hotelLabel}`;
  const previous = new Map(before.offers.map((offer) => [key(offer), offer]));
  const current = new Map(after.offers.map((offer) => [key(offer), offer]));

  for (const [id, offer] of current) {
    const was = previous.get(id);
    if (!was) { lines.push(`➕ ${offer.date} ${offer.packageLabel} · ${offer.hotelLabel}: ${money(offer.adultPrice)}`); continue; }
    if (was.adultPrice !== offer.adultPrice) {
      const delta = offer.adultPrice - was.adultPrice;
      lines.push(`${delta > 0 ? "📈" : "📉"} ${offer.date} ${offer.packageLabel} · ${offer.hotelLabel}: ${money(was.adultPrice)} → ${money(offer.adultPrice)}`);
    }
    if (was.inStock !== offer.inStock) lines.push(`${offer.inStock ? "✅" : "❌"} ${offer.date} ${offer.packageLabel} · ${offer.hotelLabel}: ${offer.inStock ? "дахин нээгдлээ" : "дууссан"}`);
  }
  for (const [id, offer] of previous) {
    if (!current.has(id)) lines.push(`➖ ${offer.date} ${offer.packageLabel} · ${offer.hotelLabel} жагсаалтаас хасагдлаа`);
  }
  if (before.days.length !== after.days.length) lines.push(`📝 Хөтөлбөр: ${before.days.length} → ${after.days.length} өдөр`);
  if (before.includes.length !== after.includes.length) lines.push(`📝 Үнэд багтсан: ${before.includes.length} → ${after.includes.length} зүйл`);
  return lines;
}
