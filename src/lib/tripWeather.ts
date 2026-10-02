import type { TravelTrip } from "./travelTypes";
import { normText } from "./travelTextNorm";
import { resolveTripFromUserMessage } from "./travelFastPathsSearch";
import { parseDepartureDateText } from "./travelDates";
import { AMBIGUOUS_REPLY_MARKER, buildAmbiguousTripReply } from "./travelFastPaths";
import { BOOKING_WEBSITE_URL } from "./bookingWebsite";

/**
 * "What's the weather like on this trip?" — answered from the booking
 * website's /api/weather, the same report its trip page renders. The bot
 * sends the website's own text verbatim, so the chat and the site can never
 * give two different forecasts. The website owns the data: which cities a
 * trip visits, live forecasts (MET Norway / yr.no) and monthly normals
 * (NASA POWER). See uudam-booking-web/src/server/weather/.
 */

// Matched against normText() output (lower-case, punctuation → spaces).
// Bare "халуун" is deliberately absent: trip names say "халуун рашаан"
// (hot spring), which is not a weather question.
const WEATHER_PATTERNS: RegExp[] = [
  /цаг\s*агаар/,
  /агаарын\s*(байдал|температур|хэм)/,
  /градус/,
  /температур/,
  /хэдэн\s*хэм/,
  /\d+\s*хэм(?![а-яёөү])/,
  /(хүйтэн|дулаан|халуун|сэрүүн)\s*(байх|байна|байдаг|бол|уу|үү|юу|үү)(?![а-яёөү])/,
  /(хүйтэн|дулаан|халуун|сэрүүн)\s*(уу|үү|юу)\s*$/,
  /(бороо|цас)\s*(орох|орно|ордог|орж|их|бий)/,
  /ямар\s*хувцас/,
  /хувцас\s*(авах|авч|өмсөх)/,
  /\bweather\b/,
  /\btemperature\b/,
  /\bforecast\b/,
  /tsag\s*aa?gaa?r/,
];

export function hasWeatherIntent(text: string): boolean {
  const normalized = normText(text);
  return WEATHER_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * True for a weather question — or for the answer to "which trip?" that we
 * asked because of one. A tapped trip button carries only the trip's name;
 * without this the customer would have to ask about the weather again.
 */
export function isWeatherTurn(
  intentText: string,
  history: Array<{ role: "user" | "assistant"; text: string }>,
): boolean {
  if (hasWeatherIntent(intentText)) return true;
  const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
  if (!lastAssistant) return false;
  const askedWhichTrip =
    lastAssistant.text.includes(AMBIGUOUS_REPLY_MARKER) || /аль\s+аялл/i.test(lastAssistant.text);
  if (!askedWhichTrip) return false;
  // history may or may not already hold the current turn; the question that
  // led to the trip list is the user turn just before the list.
  const askedBefore = history
    .slice(0, history.lastIndexOf(lastAssistant))
    .reverse()
    .find((m) => m.role === "user");
  return Boolean(askedBefore && hasWeatherIntent(askedBefore.text));
}

const WEATHER_API_BASE = (process.env.BOOKING_WEBSITE_API_URL || BOOKING_WEBSITE_URL).replace(/\/$/, "");

type WeatherApiReport = { text?: string; tripSlug?: string };

export async function fetchTripWeather(tripId: string, date?: string): Promise<WeatherApiReport | null> {
  const dateParam = date ? `&date=${encodeURIComponent(date)}` : "";
  try {
    const res = await fetch(`${WEATHER_API_BASE}/api/weather?source=${encodeURIComponent(tripId)}${dateParam}`, {
      // A trip whose cities were never detected is detected on this first
      // request, which can take several seconds.
      signal: AbortSignal.timeout(15000),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      console.error("[tripWeather] website weather API", res.status, WEATHER_API_BASE, tripId);
      return null;
    }
    return (await res.json()) as WeatherApiReport;
  } catch (err) {
    console.error("[tripWeather] website weather API failed", err);
    return null;
  }
}

export const WEATHER_WHICH_TRIP_REPLY =
  "Аль аяллын цаг агаарыг мэдэхийг хүсэж байна вэ? Аяллын нэрийг бичээрэй — очих хотуудын одоогийн цаг агаар, аялах сарын дундаж хэмийг хэлж өгье 😊";

export type WeatherReply =
  | { kind: "answer"; reply: string; trip: TravelTrip }
  | { kind: "clarify"; reply: string; candidates: TravelTrip[] }
  | { kind: "ask"; reply: string };

/** Build the weather answer for whichever trip the (routed) message names. */
export async function buildTripWeatherReply(
  matchText: string,
  trips: TravelTrip[],
  fetchWeather: (tripId: string, date?: string) => Promise<WeatherApiReport | null> = fetchTripWeather,
  /** The trip picked from our own list, when the router knows it (see FastPathRoute.chosenTripId). */
  chosenTripId?: string,
  /**
   * The customer's own words with trip names removed (intentText). A date in
   * it ("10 сарын 14-нд") picks that departure; dates inside trip NAMES must
   * not, which is why this is not matchText.
   */
  askedText?: string,
): Promise<WeatherReply> {
  const chosen = chosenTripId ? trips.find((trip) => trip.id === chosenTripId) : undefined;
  // Strict match: a loose guess would forecast the wrong country.
  const resolution = chosen
    ? ({ status: "verified", trip: chosen, candidates: [] } as const)
    : resolveTripFromUserMessage(matchText, trips, { allowLooseFallback: false });
  if (resolution.status !== "verified") {
    if (resolution.status === "ambiguous" && resolution.candidates.length > 1) {
      return {
        kind: "clarify",
        reply: buildAmbiguousTripReply(resolution.candidates),
        candidates: resolution.candidates,
      };
    }
    return { kind: "ask", reply: WEATHER_WHICH_TRIP_REPLY };
  }
  const best = resolution.trip;

  const askedDate = askedText ? parseDepartureDateText(askedText)[0] : undefined;
  const report = await fetchWeather(best.id, askedDate);
  const link = report?.tripSlug ? `${BOOKING_WEBSITE_URL}/mn/trips/${report.tripSlug}` : BOOKING_WEBSITE_URL;
  if (!report?.text) {
    // Never let this fall through to the model: it would make weather up.
    return {
      kind: "answer",
      trip: best,
      reply: `Уучлаарай, яг одоо цаг агаарын мэдээг татаж чадсангүй. Аяллын хуудаснаас харах боломжтой 👉 ${link}`,
    };
  }
  return { kind: "answer", trip: best, reply: `${report.text}\n\n📲 Дэлгэрэнгүй: ${link}` };
}
