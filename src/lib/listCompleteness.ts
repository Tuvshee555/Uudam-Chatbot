/**
 * A list of candidate trips ("which of these?") is an answer only to "which trip?". When the customer
 * also asked something none of the candidates can answer, the list is a non-answer presented as one.
 * The single-trip answer plan already hands such a turn to staff (silence plus a lead); this is the
 * same completeness check for the multi-trip path: a typed requested fact the catalogue has no source
 * for (wi-fi, a pool, a room property, any other unsupported question) or an optional-extras
 * question. A question a trip CAN answer after it is chosen (programme, hotel, terms) is not missing:
 * the list is how the customer chooses.
 */
import { intentTextOf } from "./customerTurn";
import type { Understanding } from "./tripUnderstanding";
import { buildTripRequest } from "./tripRequest";
import { isOptionalExtrasQuestion } from "./tripExtrasReply";
import type { TravelTrip } from "./travelTypes";

export function unanswerableForList(input: { text: string; trips: TravelTrip[]; understanding?: Understanding; now?: Date }): string[] {
  const request = buildTripRequest(input.text, input.trips, input.understanding, input.now);
  const facts: string[] = (request.requestedFacts || []).map((fact) => fact.field);
  if (isOptionalExtrasQuestion(intentTextOf(input.text, input.trips))) facts.push("extras.mandatory");
  return [...new Set(facts)];
}
