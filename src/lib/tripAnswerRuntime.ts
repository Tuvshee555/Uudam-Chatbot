import { buildTripAnswerPlan } from "./tripAnswerPlan";
import { buildTripRequest, mergeTripSelection } from "./tripRequest";
import { buildTripWeatherReply, fetchTripWeather } from "./tripWeather";

/** Only weather needs an external read; prices and selections remain deterministic. */
export async function buildTripAnswerRuntime(
  input: Parameters<typeof buildTripAnswerPlan>[0],
  weatherSource: typeof fetchTripWeather = fetchTripWeather,
) {
  const trip = input.trips.find((candidate) => candidate.id === input.route.chosenTripId);
  if (!trip || input.route.scopedClarify?.length || input.route.informationalAlternatives) return null;
  const requestText = input.route.requestText || input.text;
  const request = buildTripRequest(requestText, input.trips, input.route.understanding, input.now);
  if (!request.topics.includes("weather")) return buildTripAnswerPlan(input);
  const date = mergeTripSelection(trip.id, request, input.route.selection || null).date || undefined;
  try {
    const weather = await buildTripWeatherReply(requestText, [trip], (id) => weatherSource(id, date), trip.id);
    return buildTripAnswerPlan({ ...input, weatherReply: weather.kind === "answer" ? weather.reply : undefined });
  } catch {
    // An unavailable external fact still produces a terminal plan; it must not
    // become a new opportunity for a fallback path to guess the answer.
    return buildTripAnswerPlan({ ...input, weatherReply: undefined });
  }
}
