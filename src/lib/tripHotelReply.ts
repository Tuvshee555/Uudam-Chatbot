/**
 * "Ямар буудалд буудаллах вэ?" about a named trip. It used to fall through to
 * the generic trip card (prices and dates), which never names a hotel even
 * when every day of the itinerary does.
 */
import type { TravelTrip } from "./travelTypes";

const HOTEL_WORD = /зочид\s*буудал|буудал|буудл|hotel|buudal|buudl/iu;
// "Буудал" is also any station or stop: an airport, bus or train station.
const NOT_A_HOTEL = /(?:нисэх|онгоцны|автобусны|тэрэгний|галт)\s+буу?д|airport|метро|mrt/iu;

export function isHotelQuestion(text: string): boolean {
  return HOTEL_WORD.test(text) && !NOT_A_HOTEL.test(text);
}

/** [1, 2, 3, 4, 7] → "1-4, 7". */
function formatDayNumbers(days: number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    while (i + 1 < sorted.length && sorted[i + 1] === sorted[i] + 1) i++;
    parts.push(start === sorted[i] ? String(start) : `${start}-${sorted[i]}`);
  }
  return parts.join(", ");
}

export function buildHotelReply(trip: TravelTrip, text: string): string | null {
  if (!isHotelQuestion(text)) return null;
  const days = Array.isArray(trip.extra?.itinerary_days) ? (trip.extra.itinerary_days as Array<Record<string, unknown>>) : [];
  const byHotel = new Map<string, number[]>();
  days.forEach((day, index) => {
    const hotel = typeof day.hotel === "string" ? day.hotel.trim() : "";
    if (!hotel) return;
    const dayNumber = typeof day.day === "number" ? day.day : index + 1;
    byHotel.set(hotel, [...(byHotel.get(hotel) || []), dayNumber]);
  });
  const lines = byHotel.size > 0
    ? [...byHotel.entries()].map(([hotel, dayNumbers]) => `• ${formatDayNumbers(dayNumbers)}-р өдөр: ${hotel}`)
    : trip.hotel?.trim()
      ? [`• ${trip.hotel.trim()}`]
      : [];
  if (lines.length === 0) return null;
  return [`🏨 ${trip.route_name} — буудал:`, ...lines].join("\n");
}
