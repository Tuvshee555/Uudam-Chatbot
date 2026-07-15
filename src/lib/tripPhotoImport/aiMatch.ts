import { askGemini } from "../gemini";
import type { TravelTrip } from "../travelTypes";
import { tokenCoverageScore } from "./normalize";

export type AIMatchSuggestion = {
  tripId: string;
  tripName: string;
  confidence: number;
  reason: string;
} | null;

function cleanJson(text: string): string {
  return text.replace(/```json|```/gi, "").trim();
}

export async function suggestTripByAI(
  fileName: string,
  trips: TravelTrip[],
): Promise<AIMatchSuggestion> {
  if (trips.length === 0) return null;

  const candidates = trips
    .map((trip) => ({
      trip,
      score: Math.max(
        tokenCoverageScore(fileName, trip.route_name),
        ...(Array.isArray(trip.extra?.aliases)
          ? (trip.extra.aliases as string[]).map((alias) =>
              tokenCoverageScore(fileName, alias),
            )
          : [0]),
      ),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 30)
    .map(({ trip }) => ({
    id: trip.id,
    route_name: trip.route_name,
    category: trip.category,
    duration: trip.duration_text,
    departure_dates: trip.departure_dates,
    aliases: Array.isArray(trip.extra?.aliases)
      ? (trip.extra.aliases as string[]).filter((a): a is string => typeof a === "string")
      : [],
    }));

  const prompt = `You are matching a zip/folder of trip photos to the correct trip.
Given the filename/folder name "${fileName}", choose the best matching trip from the list below.
Use route, transport variant, duration, and departure date. If the filename does not distinguish two sibling trips, return no match rather than guessing.
Respond with JSON only:
{
  "trip_id": "...",
  "confidence": 0.0-1.0,
  "reason": "short reason in Mongolian"
}
If no trip matches, return {"trip_id": null, "confidence": 0, "reason": ""}.

Trips:
${JSON.stringify(candidates, null, 2)}`;

  try {
    const result = await askGemini(prompt, {
      jsonMode: true,
      temperature: 0,
      timeoutMs: 10_000,
      maxRetries: 0,
      source: "trip-photo-import.ai-match",
    });
    const cleaned = cleanJson(result.text);
    const parsed = JSON.parse(cleaned) as {
      trip_id?: string | null;
      confidence?: number;
      reason?: string;
    };
    const tripId = typeof parsed.trip_id === "string" ? parsed.trip_id : null;
    const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
    if (!tripId || confidence < 0.4) return null;
    const trip = trips.find((t) => t.id === tripId);
    if (!trip) return null;
    return {
      tripId: trip.id,
      tripName: trip.route_name,
      confidence,
      reason: parsed.reason || "AI тааруулалт",
    };
  } catch {
    return null;
  }
}
