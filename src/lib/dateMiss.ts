/**
 * A date (with a destination) that no BOOKABLE departure has. Before the bot says "no trip then,
 * here are other dates" it asks two questions it never asked (real case 16, 2026-11-02, a traveller
 * already booked on a departure that was full and archived):
 *
 *  1. Is the customer an existing customer? A consultant wrote to them within 30 days (stored as
 *     role 'staff'). Selling them other dates is wrong; the bot stays silent and staff get a typed lead.
 *  2. Does the date match a departure of that destination that is CLOSED (sold out, cancelled, ended,
 *     archived)? Then the true answer is "that departure is closed", not "there is no trip then".
 *
 * Both are data-backed; nothing here guesses. The alternatives reply stays for everyone else.
 */
import { departureAvailability, departureIsClosed } from "./departureAvailability";
import { parseDepartureDateText, parseTripDepartureDateText } from "./travelDates";
import { queryNamedPlaces, tripMentionsAllPlaces } from "./travelFastPathsSearch";
import { shortDate } from "./tripFareBlock";
import type { TravelTrip } from "./travelTypes";

export type DateMissVerdict =
  | { kind: "existing_customer"; context: string }
  | { kind: "closed"; reply: string; tripIds: string[]; context: string };

/** Every date of this trip that is no longer on sale, with whether it was FULL (vs. closed or ended). */
function closedDates(trip: TravelTrip, now: Date): Map<string, "full" | "closed"> {
  const out = new Map<string, "full" | "closed">();
  for (const row of departureAvailability(trip)) {
    if (departureIsClosed(row)) out.set(row.date, row.status === "SOLD_OUT" || row.seatsLeft === 0 ? "full" : "closed");
  }
  if (trip.status === "archived" || trip.status === "sold_out" || trip.status === "paused") {
    const resolved = Array.isArray(trip.extra?.departure_dates_resolved) ? trip.extra.departure_dates_resolved as Array<{ ymd?: string }> : [];
    const raw = [...resolved.flatMap((row) => typeof row?.ymd === "string" ? [row.ymd] : []),
      ...trip.departure_dates.flatMap((text) => parseTripDepartureDateText(text, now))];
    for (const date of raw) if (!out.has(date)) out.set(date, trip.status === "sold_out" ? "full" : "closed");
  }
  return out;
}

/** The closed departure the customer's date and destination point at, or null. */
export function closedDepartureFor(input: { text: string; scope: TravelTrip[]; pool: TravelTrip[]; now?: Date }):
  { trip: TravelTrip; date: string; full: boolean } | null {
  const now = input.now || new Date();
  const requested = new Set(parseDepartureDateText(input.text, now));
  if (!requested.size) return null;
  const places = queryNamedPlaces(input.text, [...input.scope, ...input.pool]).places;
  if (!places.length) return null;
  const seen = new Set<string>();
  for (const trip of [...input.scope, ...input.pool]) {
    if (seen.has(trip.id)) continue;
    seen.add(trip.id);
    if (!tripMentionsAllPlaces(trip, places)) continue;
    for (const [date, how] of closedDates(trip, now)) {
      if (requested.has(date)) return { trip, date, full: how === "full" };
    }
  }
  return null;
}

export async function judgeDateMiss(input: {
  text: string; scope: TravelTrip[]; trips: TravelTrip[]; now?: Date;
  loadArchived: () => Promise<TravelTrip[]>; isExistingCustomer: () => Promise<boolean>;
}): Promise<DateMissVerdict | null> {
  if (await input.isExistingCustomer()) {
    return { kind: "existing_customer",
      context: "Зөвлөхтэй өмнө нь харилцсан хэрэглэгч асуусан огноонд гарах аялал хуваарьт олдсонгүй; бот өөр огноо санал болгоогүй, зөвлөх хариулна уу." };
  }
  const found = closedDepartureFor({ text: input.text, scope: input.scope, pool: [...input.trips, ...await input.loadArchived()], now: input.now });
  if (!found) return null;
  const wording = found.full ? "Суудал дүүрсэн" : "Захиалга авах боломжгүй";
  return { kind: "closed", tripIds: [found.trip.id],
    reply: [found.trip.route_name, `${shortDate(found.date, input.now)} — ${wording}.`].join("\n"),
    context: `Хэрэглэгчийн асуусан огноо (${found.date}) хаагдсан гаралттай таарсан: ${found.trip.route_name}; бот өөр огноо санал болгоогүй.` };
}
