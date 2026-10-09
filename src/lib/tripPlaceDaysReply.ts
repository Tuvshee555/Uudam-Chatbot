import type { TravelTrip } from "./travelTypes";
import { normText, phoneticLatinText, phoneticTokenMatches } from "./travelTextNorm";

type Day = { day: number; title: string; description: string };

// The customer is asking about the place, not just naming it: "орохгүй юм биш
// үү?", "юу үзэх вэ", "багтсан уу". A bare place name still gets the trip card.
const ASKS_ABOUT_PLACE = /(?:\?|уу\b|үү\b|юу\b|юү\b|биш|байхгүй|бхгүй|орох|ордог|орно|очих|очдог|үзэх|үздэг|үзнэ|багтсан|багтаа|\bbnu\b|\buu\b|\byu\b|bish|baihgui|orohgui|oroh|ochih|uzeh|bagtsan)/iu;

function itineraryDays(trip: TravelTrip): Day[] {
  const raw = Array.isArray(trip.extra?.itinerary_days) ? trip.extra.itinerary_days : [];
  return raw.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") return [];
    const day = entry as Record<string, unknown>;
    const title = typeof day.title === "string" ? day.title.trim() : "";
    const description = typeof day.description === "string" ? day.description.replace(/\s+/g, " ").trim() : "";
    if (!title && !description) return [];
    return [{ day: typeof day.day === "number" ? day.day : index + 1, title, description }];
  });
}

function phoneticWords(text: string): string[] {
  return normText(text).split(/[^\p{L}]+/u).filter((word) => word.length >= 4).map(phoneticLatinText);
}

function firstSentence(text: string, max = 220): string {
  const sentence = text.split(/(?<=[.!?])\s+/)[0] || text;
  return sentence.length > max ? `${sentence.slice(0, max).trimEnd()}…` : sentence;
}

/**
 * "<хот> орохгүй юм биш үү?" about a trip whose title names that city: the
 * answer is the day that goes there. The bot used to re-send the trip card,
 * which shows only the first days, so the customer concluded the city was
 * missing and the card came back a second time. Only place words from the
 * trip's own title count, so generic words ("аялал", "хөтөлбөр") never match.
 */
export function buildPlaceDaysReply(trip: TravelTrip, turn: string): string | null {
  if (!ASKS_ABOUT_PLACE.test(turn)) return null;
  const titlePlaces = new Set(phoneticWords(trip.route_name));
  const asked = phoneticWords(turn).filter((word) => [...titlePlaces].some((place) => phoneticTokenMatches(word, place)));
  if (!asked.length) return null;
  const days = itineraryDays(trip).filter((day) =>
    phoneticWords(`${day.title} ${day.description}`).some((word) => asked.some((place) => phoneticTokenMatches(place, word))));
  if (!days.length) return null;
  return [
    `✈️ ${trip.route_name}`,
    "Энэ аялалд багтсан өдрүүд 😊",
    ...days.map((day) => `• ${day.day}-р өдөр — ${day.title}${day.description ? `: ${firstSentence(day.description)}` : ""}`),
  ].join("\n");
}
