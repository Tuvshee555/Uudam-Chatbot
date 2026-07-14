/**
 * Stateful fast-path text routing: decides what text the deterministic trip
 * matchers see, remembering clarification questions across turns.
 *
 * Layered on top of the stateless priorities in contextualText.ts:
 *
 * 1. If we JUST asked "which of these trips?", the customer's answer is
 *    resolved against the OFFERED candidates first — never against the whole
 *    catalog, never against stale turns. An attribute answer that fits one
 *    candidate ("усан парктай") selects it; one that fits several ("шууд
 *    нислэгтэй" when both offered trips are direct flights) keeps the
 *    clarification scoped to exactly those; one that fits none means the
 *    customer changed topic and the state is dropped.
 * 2. Otherwise current-message-first routing (pickFastPathMatchText), while
 *    capturing any new ambiguity into clarification state for the next turn.
 */

import {
  getClarificationState,
  setClarificationState,
  clearClarificationState,
} from "./clarificationState";
import { isLikelyContextDependentText, pickFastPathMatchText } from "./contextualText";
import { getTripSearchHaystack, phoneticLatinText, resolveTripFromUserMessage } from "./travelFastPathsSearch";
import type { TravelTrip } from "./travelTypes";

/**
 * Attribute answer matching against offered candidates: which of them contain
 * the customer's (normalized or transliterated) answer in their searchable
 * text? Handles answers that are qualities, not names — "шууд нислэгтэй",
 * "усан парктай", "газрын".
 *
 * Deliberately does NOT use keywordTokens/phoneticKeywordTokens: those filter
 * out generic route words ("шууд", "нислэгтэй") because they're useless for
 * whole-catalog matching — but inside a 2-3 candidate clarification they are
 * exactly the discriminating signal. Prefix matching in phonetic space also
 * absorbs transliteration variance ("nislegtein" vs "nislegtei").
 */
export function filterCandidatesByAttribute(
  text: string,
  candidates: TravelTrip[],
): TravelTrip[] {
  const phoneticTokens = (value: string) =>
    phoneticLatinText(value)
      .split(/\s+/)
      .filter((word) => word.length >= 3);
  const queryTokens = phoneticTokens(text);
  if (queryTokens.length === 0) return [];
  return candidates.filter((trip) => {
    const hayTokens = phoneticTokens(
      `${getTripSearchHaystack(trip)} ${trip.category || ""}`,
    );
    return queryTokens.every((query) =>
      hayTokens.some((hay) => hay.startsWith(query) || query.startsWith(hay)),
    );
  });
}

export type FastPathRoute = {
  /** Text the deterministic matchers should see. */
  matchText: string;
  /**
   * Non-null when the customer's answer narrows to SEVERAL of the offered
   * candidates ("шууд нислэгтэй" when both offered trips are direct flights).
   * The caller must send a clarification listing exactly these trips instead
   * of running the matchers — handing a builder several names lets it rescore
   * and confidently pick one, which is a guess, not an answer.
   */
  scopedClarify: TravelTrip[] | null;
};

export async function routeFastPathText(input: {
  senderId: string;
  text: string;
  contextualUserText: string;
  trips: TravelTrip[];
}): Promise<FastPathRoute> {
  const { senderId, text, contextualUserText, trips } = input;
  const resolve = (t: string, pool: TravelTrip[]) =>
    resolveTripFromUserMessage(t, pool, { allowLooseFallback: false });

  // --- 1. Pending clarification: scope the answer to what we offered. ---
  const pending = await getClarificationState(senderId);
  const pendingTrips = pending
    ? pending.candidateTripIds
        .map((id) => trips.find((trip) => trip.id === id))
        .filter((trip): trip is TravelTrip => Boolean(trip))
    : [];
  if (pendingTrips.length > 0) {
    const scoped = resolve(text, pendingTrips);
    if (scoped.status === "verified") {
      await clearClarificationState(senderId);
      return { matchText: `${scoped.trip.route_name}\n${text}`, scopedClarify: null };
    }
    const catalogDirect = resolve(text, trips);
    if (
      catalogDirect.status === "verified" &&
      !pendingTrips.some((trip) => trip.id === catalogDirect.trip.id)
    ) {
      await clearClarificationState(senderId);
      return {
        matchText: `${catalogDirect.trip.route_name}\n${text}`,
        scopedClarify: null,
      };
    }
    if (scoped.status === "ambiguous") {
      await setClarificationState(senderId, scoped.candidates.map((trip) => trip.id));
      return { matchText: text, scopedClarify: scoped.candidates };
    }
    // The resolver saw nothing — try attribute containment ("усан парктай"
    // is an answer a human understands but no name-matcher scores).
    const byAttribute = filterCandidatesByAttribute(text, pendingTrips);
    if (byAttribute.length === 1) {
      await clearClarificationState(senderId);
      return { matchText: `${byAttribute[0].route_name}\n${text}`, scopedClarify: null };
    }
    if (byAttribute.length > 1) {
      await setClarificationState(senderId, byAttribute.map((trip) => trip.id));
      return { matchText: text, scopedClarify: byAttribute };
    }
    // Nothing fits the offered options — the customer moved on.
    await clearClarificationState(senderId);
  }

  // --- 2. Stateless current-message-first routing, capturing new ambiguity. ---
  const direct = resolve(text, trips);
  const contextual = contextualUserText !== text ? resolve(contextualUserText, trips) : null;
  if (
    contextualUserText !== text &&
    isLikelyContextDependentText(text) &&
    contextual?.status === "verified" &&
    (direct.status !== "verified" || direct.trip.id !== contextual.trip.id)
  ) {
    return { matchText: contextualUserText, scopedClarify: null };
  }
  const picked = pickFastPathMatchText(text, contextualUserText, (t) =>
    t === text ? direct : contextual ?? resolve(t, trips),
  );

  if (direct.status === "ambiguous") {
    await setClarificationState(senderId, direct.candidates.map((trip) => trip.id));
  } else if (
    direct.status !== "verified" &&
    contextual?.status === "ambiguous"
  ) {
    await setClarificationState(senderId, contextual.candidates.map((trip) => trip.id));
  }

  return { matchText: picked, scopedClarify: null };
}
