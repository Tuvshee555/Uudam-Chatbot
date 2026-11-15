/**
 * One invented trip with a poster, for the assistant's change-action tests: two dated price rows
 * (one shared by two dates), child and infant tiers with age bands, a three-day program with day
 * photos, a photo-only poster slot, and website rows for two dates (one staff-paused).
 * Invented names, prices and dates only (owner rule: never a real trip in tests).
 */
import type { TravelTrip } from "../../src/lib/travelTypes";

export const CLOUD = "uudam-fixture";
export const photo = (name: string) => `https://res.cloudinary.com/${CLOUD}/image/upload/v1/fixture/${name}.jpg`;
export const P1 = photo("velmor-lake");
export const P2 = photo("velmor-forest");
export const P3 = photo("velmor-camp");
export const P4 = photo("velmor-sunrise");
export const NOW = new Date("2099-01-05T04:00:00.000Z");
export const VERSION = "2098-12-01T00:00:00.000Z";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function fixtureTrip(over: Partial<TravelTrip> = {}, extra: Record<string, unknown> = {}): TravelTrip {
  return clone({
    id: "trip-velmor", category: "Аялал", operator_name: "UUDAM TRAVEL AGENCY", route_name: "ВЭЛМОР НУУРЫН АЯЛАЛ",
    duration_text: "3 өдөр 2 шөнө", adult_price: 2_590_000, child_price: 2_190_000, infant_price: 500_000, currency: "MNT",
    departure_dates: ["2099-02-10", "2099-02-17", "2099-02-24"], seats_total: null, seats_left: null, has_food: true,
    status: "active", notes: "", hotel: "", source_description: "", photo_urls: [P1, P2, P3],
    extra: {
      poster_trip_id: "poster-velmor",
      customer_visible: true,
      age_rules: { infant: "0-23 сар", child: "2-11 нас", adult: "12+ нас" },
      price_groups: [
        {
          label: "2099-02-10, 2099-02-17", dates: ["2099-02-10", "2099-02-17"], display_dates: ["2099-02-10", "2099-02-17"], date_keys: ["2099-02-10", "2099-02-17"],
          adult_price: 2_590_000, child_price: 2_190_000, infant_price: 500_000, child_age: "2-11 нас", infant_age: "0-23 сар",
          passenger_prices: [
            { label: "Хүүхэд 2-11 нас", age_range: "2-11 нас", price: 2_190_000, currency: "MNT" },
            { label: "Нярай 0-23 сар", age_range: "0-23 сар", price: 500_000, currency: "MNT" },
          ],
          note: "",
        },
        {
          label: "2099-02-24", dates: ["2099-02-24"], display_dates: ["2099-02-24"], date_keys: ["2099-02-24"],
          adult_price: 2_790_000, child_price: 2_190_000, infant_price: 500_000, child_age: "2-11 нас", infant_age: "0-23 сар",
          passenger_prices: [
            { label: "Хүүхэд 2-11 нас", age_range: "2-11 нас", price: 2_190_000, currency: "MNT" },
            { label: "Нярай 0-23 сар", age_range: "0-23 сар", price: 500_000, currency: "MNT" },
          ],
          note: "",
        },
      ],
      itinerary_days: [
        { day: 1, title: "Улаанбаатар — Вэлмор нуур", description: "Нуурын эрэг хүрч буудаллана.", hotel: "Вэлмор кемп", meals: { breakfast: null, lunch: true, dinner: true }, photo: P1 },
        { day: 2, title: "Вэлмор ойн аялал", description: "Ойн замаар явган аялна.", hotel: "Вэлмор кемп", meals: { breakfast: true, lunch: true, dinner: true }, photo: P2 },
        { day: 3, title: "Вэлмор — Улаанбаатар", description: "Буцна.", meals: { breakfast: true, lunch: null, dinner: null } },
      ],
      photo_credits: { [P2]: { author: "Fixture Author", license: "CC BY 4.0" }, [P1]: { author: "Fixture Author" } },
      ...extra,
    },
    created_at: "2098-10-01T00:00:00.000Z", updated_at: VERSION, ...over,
  } as TravelTrip);
}

export function fixturePoster(): Record<string, unknown> {
  return clone({
    title: "ВЭЛМОР НУУРЫН АЯЛАЛ",
    hero_image: P1,
    departures: [{ date: "2099-02-10" }, { date: "2099-02-17" }, { date: "2099-02-24" }],
    days: [
      { day: 1, route: "Улаанбаатар — Вэлмор нуур", summary: "Нуурын эрэг хүрч буудаллана.", hotel: "Вэлмор кемп", meals: { breakfast: null, lunch: true, dinner: true }, photo: P1 },
      { day: 2, route: "Вэлмор ойн аялал", summary: "Ойн замаар явган аялна.", hotel: "Вэлмор кемп", meals: { breakfast: true, lunch: true, dinner: true }, photo: P2 },
      { day: 3, route: "Вэлмор — Улаанбаатар", summary: "Буцна.", hotel: null, meals: { breakfast: true, lunch: null, dinner: null }, photo: null },
      { day: 4, route: "", summary: "", photo: P3 },
    ],
    price_table: {
      columns: ["Том хүн", "Хүүхэд 2-11 нас", "Нярай 0-23 сар"],
      rows: [
        { dates: "2099 оны 2 сарын 10, 17", cells: ["2,590,000₮", "2,190,000₮", "500,000₮"] },
        { dates: "2099 оны 2 сарын 24", cells: ["2,790,000₮", "2,190,000₮", "500,000₮"] },
      ],
    },
  });
}
