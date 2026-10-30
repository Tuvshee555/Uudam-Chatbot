import type { TravelTrip } from "./travelTypes";

/** Visible menu rows, in their displayed order; hidden options cannot become
 * buttons or shift what the customer's numeric choice means. */
export function displayedClarificationTrips(reply: string, candidates: TravelTrip[]): TravelTrip[] {
  const lines = reply.split("\n");
  const position = (trip: TravelTrip) => lines.findIndex(line => line.trim() === `• ${trip.route_name}`
    || line.startsWith(`• ${trip.route_name} —`) || line.startsWith(`• ${trip.route_name}:`));
  return candidates.filter(trip => position(trip) >= 0).sort((left, right) => position(left) - position(right));
}
