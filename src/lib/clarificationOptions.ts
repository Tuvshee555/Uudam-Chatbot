import type { TravelTrip } from "./travelTypes";

/** Visible menu rows, in their displayed order; hidden options cannot become
 * buttons or shift what the customer's numeric choice means. */
export function displayedClarificationTrips(reply: string, candidates: TravelTrip[]): TravelTrip[] {
  // A row is "• <name>" or a numbered card "2. <name>", alone or followed by " —" / ":".
  const lines = reply.split("\n").map(line => line.trim().replace(/^\d{1,2}\.\s+/u, "• "));
  const position = (trip: TravelTrip) => lines.findIndex(line => line === `• ${trip.route_name}`
    || line.startsWith(`• ${trip.route_name} —`) || line.startsWith(`• ${trip.route_name}:`));
  return candidates.filter(trip => position(trip) >= 0).sort((left, right) => position(left) - position(right));
}
