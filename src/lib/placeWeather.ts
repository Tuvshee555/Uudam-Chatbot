/**
 * "Вердан хотын цаг агаар ямар байна", "tsag agaar n <city> <landmark> odoo ymar bga ve": a weather
 * question is about a PLACE. Routing reads the place as trips: several sibling trips share it (and the
 * reply became a list of their fares), or the trip it names is fully booked (and the reply became a
 * sold-out notice with its open siblings' prices). Neither answers the weather. The weather of the place
 * is the same whichever of those trips visits it, so it is answered once, from one of them, with the
 * booking website's own report (tripWeather.ts). The report could not be read: no weather is made up
 * and no trip is offered instead — staff take the question ("REFER").
 *
 * Decided before the sold-out notice and the sibling list. A trip the customer picked that can be
 * booked keeps its own weather answer in the answer plan; a list of trips with no place in common
 * ("which trip?") keeps the existing question.
 */
import type { FastPathRoute } from "./fastPathRouting";
import { fetchTripWeather } from "./tripWeather";
import { BOOKING_WEBSITE_URL } from "./bookingWebsite";
import { parseDepartureDateText } from "./travelDates";
import { getTripNameHaystack } from "./travelFastPathsSearch";
import { phoneticLatinText } from "./travelTextNorm";
import type { TravelTrip } from "./travelTypes";

export type PlaceWeatherAnswer = { reply: string; trip: TravelTrip; candidates: TravelTrip[] };

// Words of the question itself, and words every trip name shares: none of them is a place.
const NOT_A_PLACE = new Set([
  "цаг", "агаар", "агаарын", "аялал", "аяллын", "аялалд", "хотын", "хотод", "хот", "ямар", "байна", "байдаг", "одоо", "хүйтэн", "дулаан",
  "халуун", "сэрүүн", "хэдэн", "хэм", "температур", "градус", "бороо", "хувцас", "шууд", "нислэгтэй", "газрын", "хөтөлбөр", "аяллын",
  "tsag", "agaar", "aylal", "ayalal", "ayliin", "aylliin", "hotiin", "hotyn", "yamar", "ymar", "baina", "odoo", "huiten", "hvyten",
  "dulaan", "haluun", "heden", "temperatur", "gradus", "weather", "temperature", "forecast", "shuud", "nislegtei",
].map((word) => phoneticLatinText(word)));

function placeWords(text: string): string[] {
  return phoneticLatinText(text).split(/\s+/).filter((word) => word.length >= 4 && !/^\d+$/.test(word) && !NOT_A_PLACE.has(word));
}

function haystackWords(trip: TravelTrip): string[] {
  const destinations = Array.isArray((trip.extra as { destinations?: unknown } | null | undefined)?.destinations)
    ? ((trip.extra as { destinations: unknown[] }).destinations).filter((value): value is string => typeof value === "string") : [];
  return phoneticLatinText(`${getTripNameHaystack(trip)} ${destinations.join(" ")}`).split(/\s+/).filter((word) => word.length >= 4);
}

const sameWord = (asked: string, word: string) => word.startsWith(asked) || (asked.startsWith(word) && word.length >= 5)
  // Inflected forms: "verdangiin", "вердангийн" against "вердан".
  || (asked.length >= 5 && word.length >= 5 && asked.slice(0, 5) === word.slice(0, 5));

/** A word of the customer's message that every candidate trip holds: the place they share. */
export function sharedPlace(text: string, candidates: TravelTrip[]): string | null {
  if (candidates.length < 2) return null;
  const words = candidates.map(haystackWords);
  return placeWords(text).find((asked) => words.every((tripWords) => tripWords.some((word) => sameWord(asked, word)))) ?? null;
}

/** The trip whose report is closest to the place alone: the fewest other stops, a bookable one first. */
function representative(candidates: TravelTrip[]): TravelTrip {
  const stops = (trip: TravelTrip) => {
    const destinations = (trip.extra as { destinations?: unknown } | null | undefined)?.destinations;
    return Array.isArray(destinations) && destinations.length ? destinations.length : 99;
  };
  return [...candidates].sort((left, right) => stops(left) - stops(right)
    || Number(right.status === "active") - Number(left.status === "active")
    || left.route_name.length - right.route_name.length)[0];
}

/** The place's weather, or null when this module does not decide the turn (see the file comment). */
export async function placeWeatherAnswer(input: {
  routed: FastPathRoute; trips: TravelTrip[]; text: string; askedText: string;
  fetchWeather?: typeof fetchTripWeather;
}): Promise<PlaceWeatherAnswer | null> {
  const { routed, trips } = input;
  if (routed.unsupportedRequest || routed.notInCatalog) return null;
  const chosen = routed.chosenTripId ? trips.find((trip) => trip.id === routed.chosenTripId) : undefined;
  let candidates: TravelTrip[] = [];
  if (chosen) {
    // A bookable pick keeps its own weather answer (tripAnswerRuntime.ts).
    if (chosen.status === "active") return null;
    candidates = [chosen];
  } else if (routed.scopedClarify && routed.scopedClarify.length > 1 && !routed.informationalAlternatives) {
    if (!sharedPlace(`${routed.requestText || ""} ${input.text}`, routed.scopedClarify)) return null;
    candidates = routed.scopedClarify;
  } else {
    return null;
  }
  const trip = representative(candidates);
  const askedDate = parseDepartureDateText(input.askedText)[0];
  const report = await (input.fetchWeather || fetchTripWeather)(trip.id, askedDate).catch(() => null);
  if (!report?.text) return { reply: "REFER", trip, candidates };
  const link = report.tripSlug ? `${BOOKING_WEBSITE_URL}/mn/trips/${report.tripSlug}` : BOOKING_WEBSITE_URL;
  return { reply: `${report.text}\n\n📲 Дэлгэрэнгүй: ${link}`, trip, candidates };
}
