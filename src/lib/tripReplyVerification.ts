import type { TravelTrip } from "./travelTypes";
import type { TripSelection } from "./tripRequest";
import { guardInventedBookingTerms, guardUnverifiedDates, guardUnverifiedPrices, isReferReply, replySectionTrips } from "./reply";
import { tripDurationDays, tripIdentityName } from "./travelFastPathsSearch";
import { tripTransport, isTripOfferPrice } from "./tripFacts";
import { normalizeTripOffers, resolveTripOffer, resolveTripOfferFareCard, type PassengerKind } from "./tripOffers";
import { parseDepartureDateText } from "./travelDates";
import { withoutHolidaySpans } from "./holidayCalendar";
import { departureAvailability, departureIsClosed } from "./departureAvailability";

const AMOUNT = /(\d{1,3}(?:[.,]\d{3})+|\d+)\s*(?:₮|төгрөг|MNT)(?![\p{L}])/giu;

/** "2-12 нас" / "2 – 12 нас" → "2-12нас"; "" when there is no band. */
function bandKey(text: string): string {
  const match = /(\d{1,2})\s*[-–]\s*(\d{1,2})\s*(нас|сар|years?|months?)?/i.exec(text);
  if (match) return `${match[1]}-${match[2]}${/сар|month/i.test(match[3] || "") ? "сар" : "нас"}`;
  // "2 нас хүртэл" / "up to 2 years" is the band 0-2, as the trip's own fare label writes it.
  const upTo = /(\d{1,2})\s*(нас|сар|years?|months?)\s*(?:хүртэл|хүртлэх|болтол|доош|and\s+under|or\s+under)/i.exec(text)
    || /(?:under|up\s+to)\s*(\d{1,2})\s*(years?|months?)/i.exec(text);
  return upTo ? `0-${upTo[1]}${/сар|month/i.test(upTo[2] || "") ? "сар" : "нас"}` : "";
}

const FARE_LINE = /том\s*хүн|хүүх(?:эд|дийн)|нярай|adult|child|infant|нийт\s*:/i;
const squash = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** Everything the operator wrote about a trip in their own words: program, inclusions, notes. */
function tripOwnText(trip: TravelTrip): string {
  const extra = (trip.extra || {}) as Record<string, unknown>;
  const list = (value: unknown) => Array.isArray(value) ? value.flatMap((item) => typeof item === "string" ? [item] : item && typeof item === "object" ? Object.values(item).filter((v): v is string => typeof v === "string") : []) : [];
  return squash([
    ...list(extra.itinerary_days), ...list(extra.included_items), ...list(extra.excluded_items), ...list(extra.important_notes),
    typeof extra.important_notes === "string" ? extra.important_notes : "",
    // A departure the operator wrote as words ("12/15-аас өмнөх өдрүүдэд хамт олны захиалгаар") is printed
    // as written; it is their own text, not a departure the bot invented (live 2026-11-11).
    ...(Array.isArray(trip.departure_dates) ? trip.departure_dates.filter((text) => typeof text === "string" && /\p{L}{4,}/u.test(text)) : []),
  ].join(" | "));
}

/**
 * A line copied word for word from the trip's own program or inclusion list cannot invent a
 * price or a date — "Өрөөнд ганцаараа байрлах нэмэлт төлбөр 990,000₮", "✈ 12:00 – 16:30" — but the
 * price and date guards read those numbers as quoted fares and departures and rejected the whole
 * reply: the customer asking "what is included?" or "program" got silence. Such lines are left
 * out of the checks; every other line is checked as before.
 */
function withoutOwnText(reply: string, trips: TravelTrip[]): string {
  let active = trips;
  return reply.split(/\r?\n/).filter((line) => {
    const named = replySectionTrips(line, trips);
    if (named.length) active = named;
    const own = active.map(tripOwnText).join(" | ");
    const core = squash(line.replace(/^\s*[•\-*]\s*/, "").replace(/^\d{1,2}-р өдөр:\s*[^—]*—\s*/, "").replace(/^\s*(?:📅\s*)?Гарах өдрүүд:\s*/u, ""));
    // Fare lines are always checked: a stale price in the program text must never pass as a fare.
    return core.length < 12 || FARE_LINE.test(line) || !own.includes(core);
  }).join("\n");
}

/**
 * "Нийт: 7,670,000₮" under "Том хүн x 2: 2,690,000₮" and "Хүүхэд x 1: 2,290,000₮" is arithmetic on
 * fares that are checked line by line; the price guard does not add up, so it read the total as an
 * unknown fare and the party-total answer became silence. A total that equals the sum of the
 * per-person lines above it is dropped from the check; a conflicting total is rejected even
 * when that number happens to match one of the trip's unit fares.
 */
function withoutAddedUpTotals(text: string): string {
  let sum = 0;
  const out: string[] = [];
  const amount = (value: string) => Number(value.replace(/[.,]/g, ""));
  for (const line of text.split(/\r?\n/)) {
    // The same arithmetic on one line, as the "which trip?" totals print it:
    // "• <trip>: 6,833,000₮ (2 том хүн x 3,111,000₮ + 1 нярай x 611,000₮)".
    // The unit fares stay in the line and are checked; only a total that adds up is dropped.
    const inline = /^(.*?:\s*)([\d.,]+)\s*₮\s*\(([^()]*)\)(.*)$/u.exec(line);
    // Terms are joined by " + "; an age band like "/12+ нас/" has no space before its "+".
    const parts = inline ? inline[3].split(/\s\+\s/) : [];
    const terms = parts.map((part) => /^\s*(\d{1,3})\s+.*x\s*([\d.,]+)\s*₮\s*$/u.exec(part));
    if (inline && terms.length && terms.every(Boolean)) {
      if (terms.reduce((total, term) => total + Number(term![1]) * amount(term![2]), 0) !== amount(inline[2])) return "REFER";
      out.push(`${inline[1]}(${inline[3]})${inline[4]}`);
      continue;
    }
    const each = /x\s*(\d{1,3})\s*:\s*([\d.,]+)\s*₮/i.exec(line);
    if (each) sum += Number(each[1]) * Number(each[2].replace(/[.,]/g, ""));
    const total = /^\s*нийт\s*:\s*([\d.,]+)\s*₮\s*$/i.exec(line);
    if (total && sum > 0 && Number(total[1].replace(/[.,]/g, "")) === sum) { sum = 0; continue; }
    if (total && sum > 0) return "REFER";
    if (total) sum = 0;
    out.push(line);
  }
  return out.join("\n");
}

/**
 * "3 сарын 1–14-ны хооронд гарах аяллууд" restates the window the customer asked about; its
 * ends are not departures. Read as dates, "3 сарын 1" was an unknown departure and the whole
 * correct list became silence whenever a "which trip?" list was open (2026-10-19). Only the
 * window phrase is dropped — every departure listed under it is still checked.
 */
function withoutAskedWindows(text: string): string {
  return withoutHolidaySpans(text)
    .replace(/\d{1,2}\s*(?:-?\s*р)?\s*сарын\s*\d{1,2}\s*[–—-]\s*(?:\d{1,2}\s*(?:-?\s*р)?\s*сарын\s*)?\d{1,2}\s*(?:-?\s*(?:ны|ний|нд|ний))?\s*(?:хооронд|хүртэл)/giu, " ")
    .replace(/\d{1,2}\s*(?:-?\s*р)?\s*сарын\s*\d{1,2}\s*-?\s*(?:ны|ний)?\s*-?(?:аас|ээс|оос|өөс|наас|нээс)\s*(?:\d{1,2}\s*(?:-?\s*р)?\s*сарын\s*)?\d{1,2}\s*-?\s*(?:ны|ний)?\s*(?:хооронд|хүртэл)/giu, " ");
}

/** Shared final check for AI and code-generated replies in both channels. */
/**
 * The reply with the digits of a trip title's NOTE masked: the part of a title that is a staff instruction
 * (tripIdentityName drops it for matching: "… - 2026-12-15-с өмнөх өдрүүдэд … авна"). Ordinary names are
 * left exactly as typed, since the guards tell trips apart by them.
 */
function withoutTripNameDigits(text: string, trips: TravelTrip[]): string {
  let out = text;
  for (const trip of trips) {
    const name = trip.route_name || "";
    const identity = tripIdentityName(name);
    if (identity === name || !/\d/.test(name.slice(identity.length))) continue;
    out = out.split(name).join(identity + name.slice(identity.length).replace(/\d/g, "x"));
  }
  return out;
}

export function verifyTripReply(input: {
  reply: string; trips: TravelTrip[]; selection?: TripSelection | null; now?: Date;
}): string {
  const { reply, trips, selection } = input;
  const now = input.now || new Date();
  if (isReferReply(reply)) return reply;
  if (!trips.length) return [...reply.matchAll(AMOUNT)].length ? "REFER" : reply;
  // Links (a poster PDF id is full of digits) are not prices or dates.
  const checked = withoutAskedWindows(withoutAddedUpTotals(withoutOwnText(reply.replace(/https?:\/\/\S+/g, " "), trips)));
  // A trip's own name is its data: digits in it ("… - 2026-12-15-с өмнөх …", live 2026-11-11) are not a quoted
  // price or a departure. They are masked for the price and date guards only; section detection below keeps the name.
  const guarded = withoutTripNameDigits(checked, trips);
  const priceChecked = guardUnverifiedPrices(guarded, trips, now);
  if (isReferReply(priceChecked)) return "REFER";
  const datesChecked = guardUnverifiedDates(guarded, trips, undefined, now);
  if (isReferReply(datesChecked)) return "REFER";
  if (isReferReply(guardInventedBookingTerms(checked, "", trips))) return "REFER";
  let active = trips;
  let date = selection?.date || null;
  let hotel = selection?.hotel || null;
  let packageId = selection?.package || null;
  let packageFromLine = false;
  // A header listing several departures ("12/19, 12/22:") scopes the fare lines under it.
  let dateSet: string[] = [];
  const maskedLines = guarded.split(/\r?\n|[|;]/);
  for (const [lineIndex, line] of checked.split(/\r?\n|[|;]/).entries()) {
    // Numbers are read from the masked line (a title's note is not a fare); sections from the line as typed.
    const numbersLine = maskedLines[lineIndex] ?? line;
    const named = replySectionTrips(line, trips);
    if (named.length) {
      active = named;
      date = selection?.tripId === named[0].id ? selection.date : null;
      hotel = selection?.tripId === named[0].id ? selection.hotel : null;
      packageId = selection?.tripId === named[0].id ? selection.package || null : null;
      packageFromLine = false;
      dateSet = [];
    }
    if (isReferReply(guardInventedBookingTerms(line, "", active))) return "REFER";
    const dates = parseDepartureDateText(numbersLine, now);
    if (dates.length === 1) { date = dates[0]; dateSet = []; } else if (dates.length > 1) { date = null; dateSet = dates; }
    // Longest name first: "Lotus + Pearl" must not be read as "Lotus" (same rule as mentionedOfferHotel).
    const hotels = active.flatMap((trip) => normalizeTripOffers(trip, now).map((offer) => offer.hotel))
      .filter((value): value is string => Boolean(value)).sort((a, b) => b.length - a.length);
    const mentioned = hotels.find((value) => line.toLowerCase().includes(value.toLowerCase()));
    // A newly named hotel starts its own block: a package an earlier line of this reply named
    // belongs to the previous hotel, not this one (the customer's own choice still holds).
    if (mentioned && packageFromLine && mentioned !== hotel) {
      packageId = selection?.package || null;
      packageFromLine = false;
    }
    if (mentioned) hotel = mentioned;
    const packages = active.flatMap((trip) => normalizeTripOffers(trip, now).map((offer) => offer.packageId))
      .filter((value): value is string => Boolean(value)).sort((a, b) => b.length - a.length);
    const mentionedPackage = packages.find((value) => line.toLowerCase().includes(value.toLowerCase()));
    if (mentionedPackage) { packageId = mentionedPackage; packageFromLine = true; }
    for (const fragment of numbersLine.split(/(?=том\s*хүн|насанд\s*хүрэгч|adult|нярай|infant|хүүх(?:эд|дийн)|child)/i)) {
      const kind = /том\s*хүн|насанд\s*хүрэгч|adult/i.test(fragment) ? "adult" : /нярай|infant/i.test(fragment) ? "infant" : /хүүх(?:эд|дийн)|child/i.test(fragment) ? "child" : null;
      const amounts = [...fragment.matchAll(AMOUNT)].map((match) => Number(match[1].replace(/[.,]/g, "")));
      const freeFare = /^(?:том\s*хүн|насанд\s*хүрэгч|adults?|нярай|infants?|хүүх(?:эд|дийн)|child(?:ren)?)(?:\s*(?:\([^)]*\)|\/[^/]*\/))?\s*(?:x\s*\d+)?\s*:?\s*(?:үнэгүй|free)\s*[.!]?\s*$/iu.test(fragment.trim());
      if (kind && freeFare) amounts.push(0);
      // "10 сарын 26" is a date ("the 26th of month 10"), never a 10-month-old.
      const ageMatch = /(?<![\d.,])(\d{1,2}(?:\.\d+)?)\s*(?:[-–]\s*(\d{1,2})\s*)?(?:нас|настай|years?\s*old|сар(?!ын)|months?)/i.exec(fragment);
      // "Хүүхэд /2-11 нас/" labels the fare's band. Its LOWER end read as a
      // 2-year-old made the infant rule reject the real child fare, and the
      // customer who tapped that trip got silence (2026-10-09). The upper end
      // still sits inside the band, so a 2-5 band quoted at the 6-11 fare fails.
      const age = ageMatch ? [ageMatch[0], ageMatch[2] ?? ageMatch[1]] as const : null;
      // A band printed exactly as one of the trip's own fares ("Хүүхэд /2-12 нас/:
      // 3,250,000₮") is that fare. Turning the band into one age broke wherever a
      // trip's bands touch ("2-12" next to "12+", "0-2" next to "2-8").
      // "/2 нас хүртэл/" ("up to 2") is a band label too, not a 2-year-old (live 2026-11-11: a free infant
      // fare written that way silenced the whole price card of a new trip).
      const upToBand = !ageMatch?.[2] ? bandKey(fragment) : "";
      const printedBand = ageMatch?.[2] ? bandKey(ageMatch[0]) : upToBand.startsWith("0-") ? upToBand : null;
      if ((kind || packageId || amounts.some((amount) => amount < 1_000)) && amounts.length) {
        for (const amount of amounts) {
          // Asked of the resolver, so a hotel row that inherits the trip's infant
          // fare is judged exactly as the card that printed it was built.
          const ownFare = printedBand !== null && active.some((trip) => {
            const departures = date ? [date] : dateSet.length ? dateSet : [...new Set(normalizeTripOffers(trip, now).flatMap((offer) => offer.dates))];
            return departures.some((departure) => {
              const selection = { date: departure, ...(hotel ? { hotel } : {}), ...(packageId ? { packageId } : {}) };
              const first = resolveTripOfferFareCard(trip, selection, now);
              // A hotel sold as several packages prints one card per package.
              const cards = first.status === "needs_selection" && first.fields.includes("package")
                ? first.options.map((packageId) => resolveTripOfferFareCard(trip, { ...selection, packageId }, now)) : [first];
              return cards.some((card) => card.status === "ready" && card.offer.fares.some((fare) => fare.kind === kind && bandKey(fare.ageRange || "") === printedBand
                && (fare.fare.kind === "exact" || fare.fare.kind === "free") && fare.fare.amount === amount));
            });
          });
          if (ownFare) continue;
          const supported = active.some((trip) => {
            const offers = normalizeTripOffers(trip, now);
            const possibleDates = date ? [date] : dateSet.length ? dateSet : [...new Set(offers.flatMap((offer) => offer.dates))];
            if (!kind && offers.some((offer) => (!offer.discount || offer.discount.active)
              && (!hotel || !offer.hotel || offer.hotel === hotel)
              && (!packageId || !offer.packageId || offer.packageId === packageId)
              && (!offer.dateScoped || possibleDates.some((departure) => offer.dates.includes(departure)))
              && offer.supplementalFares.some(({ fare }) => fare.kind === "range" ? amount >= fare.min && amount <= fare.max : fare.kind !== "unknown" && fare.amount === amount))) return true;
            if (!possibleDates.length) {
              if (offers.some((offer) => (!hotel || offer.hotel === hotel)
                && (!packageId || offer.packageId === packageId)
                && offer.fares.some((fare) => (!kind || fare.kind === kind) && (fare.fare.kind === "exact" || fare.fare.kind === "free") && fare.fare.amount === amount))) return true;
              // A trip with no dated departure (sold on request, "12/15-аас өмнөх өдрүүдэд хамт олны захиалгаар")
              // prints its own base fares; those are its data, not an invented price (live 2026-11-11).
              const base: Record<PassengerKind, number | null | undefined> = { adult: trip.adult_price, child: trip.child_price, infant: trip.infant_price };
              return (kind ? [kind as PassengerKind] : (["adult", "child", "infant"] as PassengerKind[])).some((fareKind) => { const value = base[fareKind]; return typeof value === "number" && value > 0 && value === amount; });
            }
            const kinds: PassengerKind[] = kind ? [kind] : ["adult", "child", "infant"];
            return possibleDates.some((departure) => kinds.some((fareKind) => isTripOfferPrice(trip, { date: departure, hotel, packageId,
              ...(age ? { passengers: [{ kind: fareKind, age: Number(age[1]), ageUnit: /сар|month/i.test(age[0]) ? "month" : "year", count: 1 }] } : {}),
            }, fareKind, amount, now)));
          });
          if (!supported) return "REFER";
        }
      }
    }
    if (!/байхгүй|биш|гарахгүй|таарахгүй|хүссэн|хүсэлт|асууж|хуваарьгүй/i.test(line)) {
      const duration = /(?:хугацаа\s*:|үргэлжлэх(?:\s+хугацаа)?\s*:?)\s*(\d{1,2})\s*(?:өдөр|хоног)/i.exec(line);
      if (duration && !active.some((trip) => tripDurationDays(trip) === Number(duration[1]))) return "REFER";
      if (/шууд\s+нислэгтэй/i.test(line) && !active.some((trip) => tripTransport(trip) === "direct_flight")) return "REFER";
      if (date && /захиалга\s+нээлттэй|суудал\s+байгаа|суудал\s+байна/i.test(line)) {
        const supported = active.some((trip) => {
          const row = departureAvailability(trip).find((entry) => entry.date === date);
          if (row && departureIsClosed(row)) return false;
          const result = resolveTripOffer(trip, { date, hotel, packageId }, now);
          return result.status === "ready" && result.offer.availability.status === "open";
        });
        if (!supported) return "REFER";
      }
    }
  }
  return reply;
}
