/**
 * Does the bot agree with itself?
 *
 * Builds the answers the bot sends about every live trip (card, price, list
 * line, each upcoming date, a family total) and runs the bot's own reply
 * checker on them. A rejection means two parts of the code read the same trip
 * differently, and in production the customer gets silence. On 2026-10-10
 * this rejected 75 of 233 answers for 12 of 32 live trips; every weekly
 * "new" inaccuracy of the month before was one of these disagreements.
 * No AI calls: run it as often as you like (`npm run audit:self-consistency`).
 */
import type { TravelTrip } from "./travelTypes";
import { buildStructuredTripReply } from "./travelFastPaths";
import { buildAmbiguousTripReply } from "./travelFastPathsPricing";
import { verifyTripReply } from "./tripReplyVerification";
import { presentAssistantReply } from "./chatbotReplyPolicy";
import { enforceWebsiteForPayment, isReferReply, sanitizeAssistantReply } from "./reply";
import { shortDate, upcomingDepartures } from "./tripFareBlock";

export type SelfConsistencyFailure = { tripId: string; routeName: string; question: string; reply: string };
export type SelfConsistencyReport = { trips: number; answers: number; failures: SelfConsistencyFailure[] };

const LIVE = new Set(["active", "sold_out", "paused"]);

export function checkSelfConsistency(trips: TravelTrip[], now = new Date()): SelfConsistencyReport {
  const live = trips.filter((trip) => LIVE.has(trip.status));
  const failures: SelfConsistencyFailure[] = [];
  let answers = 0;
  for (const trip of live) {
    const dates = upcomingDepartures(trip, now).slice(0, 4).map((date) => shortDate(date, now));
    const questions: Array<[string, () => string | null]> = [
      ["trip card", () => buildStructuredTripReply(trip.route_name, live, now)],
      ["price", () => buildStructuredTripReply(`${trip.route_name} үнэ хэд вэ`, live, now)],
      ["list line", () => buildAmbiguousTripReply([trip])],
      ...dates.map((date): [string, () => string | null] => [`date ${date}`, () => buildStructuredTripReply(`${trip.route_name} ${date}`, live, now)]),
      ...dates.slice(0, 1).map((date): [string, () => string | null] => [`family total ${date}`,
        () => buildStructuredTripReply(`${trip.route_name} ${date} 2 том хүн 1 хүүхэд 7 настай`, live, now)]),
    ];
    for (const [question, build] of questions) {
      const raw = build();
      if (!raw || isReferReply(raw)) continue;
      answers++;
      const shown = presentAssistantReply({ reply: sanitizeAssistantReply(enforceWebsiteForPayment(raw)), userText: trip.route_name, hasPriorReply: true, phoneAlreadyRequested: true });
      const named = live.filter((other) => shown.includes(other.route_name));
      if (isReferReply(verifyTripReply({ reply: shown, trips: named.length ? named : [trip], now }))) {
        failures.push({ tripId: trip.id, routeName: trip.route_name, question, reply: shown });
      }
    }
  }
  return { trips: live.length, answers, failures };
}
