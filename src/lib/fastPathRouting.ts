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
import { parseDepartureDateText, tripMatchesRequestedDate } from "./travelDates";
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
  // Numbers ARE the discriminating signal between "…5 өдөр 4 шөнө" and
  // "…4 өдөр 3 шөнө" — the old length filter dropped them, so "5 өдөр нь"
  // degraded to just "өдөр" and matched every candidate with a duration.
  const phoneticTokens = (value: string) =>
    phoneticLatinText(value)
      .split(/\s+/)
      .filter((word) => word.length >= 3 || /^\d+$/.test(word));
  const queryTokens = phoneticTokens(text);
  if (queryTokens.length === 0) return [];
  // A lone bare digit ("1") is too weak to select a trip by containment.
  if (queryTokens.every((word) => /^\d$/.test(word))) return [];
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
  /**
   * Optional context line for the scoped clarification ("8 сарын 24-нд эдгээр
   * аяллууд гарна:") so a date answer that fits several candidates reads as
   * an informed follow-up, not a blind re-ask.
   */
  scopedClarifyNote?: string;
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
    // A date answer ("8 сарын 24-нд хэд вэ") narrows by DEPARTURE DATE — the
    // name/attribute matchers can't read dates, which used to clear the state
    // and re-clarify from the whole catalog. One departing candidate → that's
    // the trip; several → keep the clarification scoped to exactly those,
    // with the date echoed so the re-ask reads as informed.
    const requestedYmd = parseDepartureDateText(text)[0];
    if (requestedYmd) {
      const byDate = pendingTrips.filter((trip) =>
        tripMatchesRequestedDate(trip, requestedYmd),
      );
      if (byDate.length === 1) {
        await clearClarificationState(senderId);
        return { matchText: `${byDate[0].route_name}\n${text}`, scopedClarify: null };
      }
      if (byDate.length > 1) {
        await setClarificationState(senderId, byDate.map((trip) => trip.id));
        const [, month, day] = requestedYmd.split("-");
        return {
          matchText: text,
          scopedClarify: byDate,
          scopedClarifyNote: `${Number(month)} сарын ${Number(day)}-нд эдгээр аялал гарна:`,
        };
      }
    }
    if (scoped.status === "ambiguous") {
      // Refine the resolver's candidates with attribute containment: for
      // "5 өдөр нь" the resolver kept {4 өдөр, 5 өдөр} (digit-blind scoring),
      // but only one of them actually contains the customer's "5".
      const refined = filterCandidatesByAttribute(text, scoped.candidates);
      if (refined.length === 1) {
        await clearClarificationState(senderId);
        return { matchText: `${refined[0].route_name}\n${text}`, scopedClarify: null };
      }
      const candidates = refined.length > 1 ? refined : scoped.candidates;
      await setClarificationState(senderId, candidates.map((trip) => trip.id));
      return { matchText: text, scopedClarify: candidates };
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
  // Bug (found 2026-07-17 replaying real traffic): "beejin" alone after a
  // Chunchin (unrelated) reply returned Chunchin. isLikelyContextDependentText
  // treats ANY 1-2 word message as a follow-up reference (needed for real
  // pronouns like "тэр хэд вэ?"), but a bare destination name like "beejin"
  // is a complete, self-sufficient query — it happened to resolve AMBIGUOUS
  // (several real Beijing trips), not "nothing", so it has its own opinion
  // that must be respected. Only let the contextual winner override when it's
  // actually one of the direct candidates (the same guard pickFastPathMatchText
  // already applies below) — otherwise it's a stale unrelated trip hijacking
  // an unrelated fresh query, exactly the class of bug this file's own
  // docstring warns about.
  const directRejectsContextual =
    direct.status === "ambiguous" &&
    !(
      contextual?.status === "verified" &&
      direct.candidates.some((trip) => trip.id === contextual.trip.id)
    );
  if (
    contextualUserText !== text &&
    isLikelyContextDependentText(text) &&
    contextual?.status === "verified" &&
    (direct.status !== "verified" || direct.trip.id !== contextual.trip.id) &&
    !directRejectsContextual
  ) {
    return {
      matchText: `${contextual.trip.route_name}\n${text}`,
      scopedClarify: null,
    };
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

  // Context is only for identifying the trip. Do not pass the whole previous
  // answer back into price/date/program builders: it may contain stale
  // qualifiers ("тийзгүй", "7 сар", an old price) that override what the
  // customer asks in the current turn. Once context resolves one trip, reduce
  // it to the canonical trip name plus the current message.
  const matchText =
    picked === contextualUserText && contextual?.status === "verified"
      ? `${contextual.trip.route_name}\n${text}`
      : picked;

  return { matchText, scopedClarify: null };
}
