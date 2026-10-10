/**
 * What a trip-wide "seats left" edit may do to each departure's own count.
 *
 * The admin's "Үлдсэн суудал" belongs to the whole trip. The sync used to copy
 * it onto EVERY departure, so typing 3 made every date on the website read
 * "few seats". Few seats is now a flag on one date (status ALMOST_FULL), set
 * per date, and a trip-wide number can only do what is true of every date:
 *   - 0 closes them all (the trip is full),
 *   - a number clears the counts that came from the previous trip-wide
 *     value or from a full trip, so reopening a full trip reopens its dates,
 *   - any other count a date carries is that date's own and stays.
 */
export function departureSeatsAfterTripEdit(input: {
  tripChanged: boolean;
  previousTripSeatsLeft: number | null;
  tripSeatsLeft: number | null;
  rowSeatsLeft: number | null;
}): number | null {
  const { tripChanged, previousTripSeatsLeft, tripSeatsLeft, rowSeatsLeft } = input;
  if (!tripChanged) return rowSeatsLeft;
  if (tripSeatsLeft === 0) return 0;
  if (rowSeatsLeft === 0 || (rowSeatsLeft !== null && rowSeatsLeft === previousTripSeatsLeft)) return null;
  return rowSeatsLeft;
}
