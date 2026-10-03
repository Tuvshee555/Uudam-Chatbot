import { buildTripAnswerPlan } from "./tripAnswerPlan";
import { buildTripRequest } from "./tripRequest";
import { buildTripWeatherReply, fetchTripWeather } from "./tripWeather";

/** Only weather needs an external read; prices and selections remain deterministic. */
export async function buildTripAnswerRuntime(
  input: Parameters<typeof buildTripAnswerPlan>[0],
  weatherSource: typeof fetchTripWeather = fetchTripWeather,
) {
  const trip = input.trips.find((candidate) => candidate.id === input.route.chosenTripId);
  if (!trip || input.route.scopedClarify?.length || input.route.informationalAlternatives) return null;
  const request = buildTripRequest(input.text, input.trips, input.route.understanding, input.now);
  if (!request.topics.includes("weather")) return buildTripAnswerPlan(input);
  const date = request.date || input.route.selection?.date || undefined;
  const weather = await buildTripWeatherReply(input.text, [trip], (id) => weatherSource(id, date), trip.id);
  return buildTripAnswerPlan({ ...input, weatherReply: weather.kind === "answer" ? weather.reply : undefined });
}
