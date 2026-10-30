/**
 * Stateful fast-path text routing: decides what text the deterministic trip
 * matchers see, remembering clarification questions across turns.
 *
 * Layered on top of the stateless priorities in contextualText.ts:
 *
 * 1. If we JUST asked "which of these trips?", the customer's answer is
 *    resolved against the OFFERED candidates first — never against the whole
 *    catalog, never against stale turns. An attribute answer that fits one
 *    candidate ("усан парктай", "<хот>-оос") selects it; one that fits several
 *    ("шууд нислэгтэй" when both offered trips are direct flights) keeps the
 *    clarification scoped to exactly those; one that fits none means the
 *    customer changed topic and the state is dropped.
 * 2. Otherwise current-message-first routing (pickFastPathMatchText), while
 *    capturing any new ambiguity into clarification state for the next turn.
 *
 * The returned matchText always marks the customer's own turn (customerTurn.ts)
 * so builders read intent from the customer's words, not from the trip name or
 * the bot's previous reply that was prepended to identify the trip.
 */

import {
  getClarificationState,
  setClarificationState,
  clearClarificationState,
} from "./clarificationState";
import { customerTurn, intentTextOf, joinContextAndTurn, markNoTrip } from "./customerTurn";
import { unmetNote, unknownRequirementNote, type Understanding } from "./tripUnderstanding";
import { hasReferentialHint, isLikelyContextDependentText, lastAssistantReply, pickFastPathMatchText } from "./contextualText";
import { departureMatchesScope, hasDepartureDateAvailabilityIntent, parseDepartureDateText, requestedDepartureScope, requestsDateWindow, resolveRequestedDate, resolveRequestedMonth, tripMatchesRequestedDate, tripDepartsInMonth } from "./travelDates";
import {
  filterTripsByTransportIntent,
  getTripSearchHaystack,
  isGenericTripRequest,
  phoneticLatinText,
  queryWantsDirectFlight,
  queryWantsLandFlightCombo,
  queryWantsLandOnlyEnhanced,
  resolveTripFromUserMessage,
} from "./travelFastPathsSearch";
import { AMBIGUOUS_REPLY_MARKER, DATE_NOT_SCHEDULED_HEADING, isPassengerCountOnly } from "./travelFastPathsPricing";
import type { TravelTrip } from "./travelTypes";
import { isKnownGreetingPhrase } from "./greetingPhrases";
import { SMART_BUTTON_LABEL_LIST } from "./smartButtonLabels";
import { buildTripRequest, mergeTripSelection, type TripSelection } from "./tripRequest";
import { getTripSelection, setTripSelection } from "./tripSelectionState";
import { websiteTripLinksInText } from "./bookingWebsite";
import { upcomingDepartures } from "./tripFareBlock";
import { tripFromRecentMenu, tripMenuQuestionIndex } from "./tripMenuChoice";

/**
 * Did the customer tap one of OUR quick-reply buttons?
 *
 * The text that arrives is our own label, not the customer's words, so it
 * carries no trip identity — the trip is whatever the conversation was
 * already about. Several labels collide with live trip names ("Хөтөлбөр
 * үзэх" vs "…аяллын хөтөлбөр" and "<хот> -намрын тахилга үзэх аялал"), and
 * the name matcher "verified" one of those from the bare label: tapping
 * Хөтөлбөр үзэх under a <хот> reply sent the <хот> brochure instead
 * (confirmed in a real Messenger conversation, 2026-09-11).
 */
function isOwnButtonLabel(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return SMART_BUTTON_LABEL_LIST.some((label) => label.toLowerCase() === normalized);
}

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

function addsNarrowing(text: string, candidates: TravelTrip[]): boolean {
  if (hasReferentialHint(text)) return true;
  const narrowed = filterCandidatesByAttribute(text, candidates);
  return narrowed.length > 0 && narrowed.length < candidates.length;
}

function looseNorm(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Destination membership cannot establish where an itinerary starts. */
export function hasUnsupportedOriginRequest(text: string): boolean {
  const normalized = text.normalize("NFKC");
  return /\p{L}{2,}(?:аас|ээс|оос|өөс)\s+(?:(?:аялал\p{L}*|шууд|нислэг\p{L}*)\s+){0,3}(?:эхл\p{L}*|хөдл\p{L}*|гар(?:ах|даг|на|даггүй)\p{L}*)/iu.test(normalized)
    || /[a-z]{2,}(?:aas|ees|oos|uus)\s+(?:(?:aylal\w*|shuud|nisleg\w*)\s+){0,3}(?:ehle\w*|hodlo\w*|garah\w*)/iu.test(normalized)
    || /\b(?:depart(?:s|ing|ure)?|start(?:s|ing)?|leav(?:e|es|ing))\s+(?:from|in)\s+\p{L}/iu.test(normalized);
}

const DATES_ONLY_RE = /^(?:огноо|огноог|өдөр|өдрүүд|гарах\s+өдөр(?:үүд)?|хэзээ|ogno|udur|hezee)(?:\s+(?:нь|ni|вэ|ve|юу|yu))*\s*[?.!]*$/iu;

// A fare question that names nothing else: "хүүхдийн үнэ", "үнэ хэд вэ", "нярай хэд вэ",
// "huuhdiin une hed ve". Every word must be a fare word, a passenger word or a filler.
const FARE_WORDS = new Set(["үнэ", "үнийг", "үнийн", "үнэтэй", "vne", "une", "price", "хэд", "hed"]);
const PASSENGER_WORDS = new Set(["хүүхэд", "хүүхдийн", "хүүхдэд", "хүүхдүүд", "хүүхдүүдийн", "том", "хүн", "хүний", "томчуудын",
  "нярай", "нярайн", "нярайд", "huuhed", "huuhdiin", "huuhded", "tom", "hun", "hunii", "nyarai", "nyarain", "child", "adult", "infant"]);
const FARE_FILLER = new Set(["нь", "ni", "вэ", "ve", "бэ", "be", "юу", "yu", "уу", "uu", "байна", "бна", "bna", "bn", "бол", "bol"]);
export function isFareOnlyQuestion(text: string): boolean {
  const words = text.toLowerCase().replace(/[?.!,]+/g, " ").split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 6 && words.some((word) => FARE_WORDS.has(word))
    && words.every((word) => FARE_WORDS.has(word) || PASSENGER_WORDS.has(word) || FARE_FILLER.has(word));
}

const DATE_FOLLOWUP_WORDS = new Set([
  "оны", "он", "сарын", "сар", "нд", "д", "ны", "ний", "нь", "ni", "nii", "nd", "sariin", "sar",
  "өнөөдөр", "маргааш", "нөгөөдөр", "today", "tomorrow", "margaash", "margash", "nuguudur",
  "аялал", "аяллын", "aylal", "aylaliin", "үнэ", "une", "vne", "хэд", "хэдэн", "hed", "heden",
  "вэ", "ве", "ve", "байна", "байгаа", "бол", "уу", "юу", "uu", "yu", "бну", "бна", "bnu", "bna", "baina",
  // Phone typing: "11 sard bn", "11.04нийг сонирхож бна" (accusative -ийг).
  "bn", "bnuu", "bgayu", "бнуу", "бга", "бгаа", "бгаюу", "нийг", "ыг", "ийг", "sarin", "saryn", "sarun",
  "гарах", "явах", "garah", "yavah", "yvah", "хөтөлбөр", "үзэх", "hutulbur", "uzey", "uzye",
]);

const CALENDAR_FOLLOWUP_WORDS = new Set([
  ...DATE_FOLLOWUP_WORDS, "сард", "сарынх", "сарых", "sard", "sariinh", "р", "r", "дугаар", "дахь", "дэх",
  "эхний", "эхээр", "эхэнд", "сүүлийн", "сүүлчийн", "сүүлээр", "дунд", "дундуур", "долоо", "хоног", "хоногт", "хоногийн", "хооронд",
  "ehnii", "eheer", "ehend", "suuliin", "suuleer", "dund", "doloo", "honog", "hoorond",
  // "1 сарын 20доор" = around the 20th.
  "доор", "door", "орчим", "orchim",
  "сонирхож", "sonirhoj", "болох", "боломжтой", "суудал", "suudal", "bga", "bgaa", "baigaa",
  "шууд", "нислэгтэй", "нислэг", "shuud", "nislegtei", "nisleg", "хэдээр", "үнэтэй", "price", "cost",
  "нэг", "хоёр", "гурав", "дөрөв", "тав", "зургаа", "долоо", "найм", "ес", "арав", "арван",
  // The same month numbers typed in Latin: "neg sard" read as a new destination and got silence (live 2026-10-30).
  "neg", "nig", "tav", "hoyor", "hoyr", "hoer", "gurav", "guraw", "dorov", "duruv", "taw", "zurgaa", "naim", "yes", "yos", "arav", "araw", "arvan",
  // Who travels is not a new destination: "12/20 nd 2 hun", "11/4-нд 3 хүн", "2 том хүн 1 хүүхэд".
  "хүн", "хүний", "hun", "huun", "humuus", "том", "tom", "хүүхэд", "хүүхдийн", "huuhed", "huuhdiin", "нярай", "nyarai",
  // A start-date constraint is not a destination either: "Хүүхдийн амралт 11.1-с эхлэх гээд бдаг...яах вэ".
  "с", "аас", "ээс", "оос", "өөс", "хойш", "хойшоо", "эхлэх", "эхлэн", "эхэлнэ", "эхэлдэг", "эхлэхээр", "hoish", "ehleh", "ehlen",
  "амралт", "амралтаар", "амралтанд", "amralt", "сургууль", "хичээл", "гээд", "geed", "бдаг", "байдаг", "bdag", "яах", "yah",
]);

function calendarWordsAreContextOnly(text: string): boolean {
  const words = text.normalize("NFKC").toLowerCase().replace(/[^\p{L}]+/gu, " ").trim().split(/\s+/).filter(Boolean);
  return words.every(word => CALENDAR_FOLLOWUP_WORDS.has(word));
}

/** A date and generic question words carry no new destination identity. */
function dateFollowup(text: string, now: Date): string | null {
  if (!hasDepartureDateAvailabilityIntent(text, now) || requestsDateWindow(text, now)) return null;
  const requested = resolveRequestedDate(text, now);
  if (!requested) return null;
  const words = text.normalize("NFKC").toLowerCase().replace(/[^\p{L}]+/gu, " ").trim().split(/\s+/).filter(Boolean);
  return words.every(word => DATE_FOLLOWUP_WORDS.has(word)) ? requested.ymd : null;
}

/**
 * "2", "2.", "2)", "2-р", "2. <trip name, cut off>..." — the customer picking an
 * option from a numbered list. Deliberately NOT "2 том хүн 2 хүүхэд" or
 * "1 сард": a number followed by words is a passenger count or a month, and
 * reading it as "option 2" answered with the wrong trip (replayed from real
 * 2026-09-15 / 09-16 chats).
 */
export function parseNumberedChoice(text: string): { index: number; namePrefix: string } | null {
  const ordinal = /^\s*(\d{1,2})\s*-?\s*(?:р|дугаар|дахь|dahi)(?:\s+(?:нь|аялал|ni))?\s*[.!?]?\s*$/iu.exec(text);
  if (ordinal) return { index: Number(ordinal[1]) - 1, namePrefix: "" };
  const numbered = /^\s*(\d{1,2})\s*(?:[.)]\s*([\s\S]*))?$/u.exec(text);
  if (!numbered) return null;
  const namePrefix = (numbered[2] || "").replace(/(?:\.\.\.|…)\s*$/u, "").trim();
  return { index: Number(numbered[1]) - 1, namePrefix };
}

/** Trips whose name starts with a (possibly truncated) button title. */
function tripsNamedByPrefix(prefix: string, pool: TravelTrip[]): TravelTrip[] {
  const wanted = looseNorm(prefix);
  if (wanted.replace(/\s/g, "").length < 3) return [];
  const named = pool.filter((trip) => trip.status !== "draft" && looseNorm(trip.route_name).startsWith(wanted));
  // A sold-out sibling with the same opening words must not turn a tapped,
  // bookable trip into a "which one?" question.
  const bookable = named.filter((trip) => trip.status === "active");
  return bookable.length > 0 ? bookable : named;
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
  /**
   * The exact trip the customer picked from our list. `matchText` carries
   * only its NAME, and two catalogue trips can share a name (a cheaper and
   * a dearer hotel tier) — re-matching the name then re-asks forever.
   */
  chosenTripId?: string;
  /** What the understanding step read from the message, when it ran. */
  understanding?: Understanding;
  /** A destination the customer asked for that no trip goes to — answer that honestly. */
  notInCatalog?: string;
  /** The list is informational because a stated requirement failed or is unknown. */
  informationalAlternatives?: boolean;
  selection?: TripSelection;
  /** No offered/selected trip has this requested date: silently hand the question to staff. */
  unavailableDateWithinScope?: boolean;
  /** A requested property or new identity cannot be established from the available source. */
  unsupportedRequest?: boolean;
  /** Original customer question answered by a bare choice in the last trip menu. */
  requestText?: string;
  /** The trip enters the conversation this turn (no earlier selection of it): the answer names it. */
  newTrip?: boolean;
};

/** The message asks something besides when the trip departs. */
function asksBeyondDate(text: string, trips: TravelTrip[], now: Date): boolean {
  const request = buildTripRequest(text, trips, undefined, now);
  return request.passengers.length > 0 || Boolean(request.lodging)
    || request.topics.some((topic) => topic !== "availability" && topic !== "dates");
}

/** A reply that asked the customer to pick a trip — the only kind a pending clarification belongs to. */
function isTripChoiceQuestion(reply: string): boolean {
  // "Not then; these trips depart on …" keeps those trips in scope: "hoyor sard" right after it
  // asks about them and got silence once the list counted as stale (live replay 2026-10-30).
  return reply.includes(AMBIGUOUS_REPLY_MARKER) || /аль\s+аялл/i.test(reply) || reply.startsWith(DATE_NOT_SCHEDULED_HEADING);
}

export async function routeFastPathText(input: {
  senderId: string;
  text: string;
  contextualUserText: string;
  trips: TravelTrip[];
  /** Conversation so far; used to tell whether the last reply asked "which trip?". */
  history?: Array<{ role: "user" | "assistant"; text: string }>;
  now?: Date;
  /**
   * Reads which trip(s) the message is about (see tripUnderstanding.ts). Given
   * the trips of the list the bot last offered, in order. Null = could not
   * tell (model down, bad output) and the keyword routing below decides.
   */
  understand?: (pendingTripIds: string[], selection?: TripSelection | null) => Promise<Understanding | null>;
}): Promise<FastPathRoute> {
  const { senderId, text, contextualUserText, trips } = input;
  const now = input.now || new Date();
  const numericChoice = parseNumberedChoice(text);
  let requestText = text;
  if (numericChoice && input.history) {
    // Choosing an option completes the pending question; the digit does not
    // replace its requested facts. Use only the question before the latest
    // actual trip menu, never arbitrary older assistant prose.
    const lastReplyIndex = input.history.findLastIndex(message => message.role === "assistant");
    if (lastReplyIndex >= 0 && isTripChoiceQuestion(input.history[lastReplyIndex].text)) {
      const original = input.history.slice(0, lastReplyIndex).findLast(message => message.role === "user");
      const menu = input.history[lastReplyIndex].text;
      const belongsToMenu = !numericChoice.namePrefix || tripsNamedByPrefix(numericChoice.namePrefix, trips)
        .some(trip => looseNorm(menu).includes(looseNorm(trip.route_name)));
      if (belongsToMenu && original && !parseNumberedChoice(original.text)) requestText = original.text;
    }
  }
  // A destination supplied in answer to a calendar-only question completes
  // that request. Keep its date until the customer supplies a new one.
  if (!numericChoice && input.history && !requestedDepartureScope(intentTextOf(text, trips), now)) {
    const lastReplyIndex = input.history.findLastIndex(message => message.role === "assistant");
    const reply = input.history[lastReplyIndex]?.text || "";
    const original = input.history.slice(0, lastReplyIndex).findLast(message => message.role === "user");
    const current = resolveTripFromUserMessage(text, trips, { allowLooseFallback: false });
    const displaysTripList = /(?:^|\n)\s*(?:[•*-]|\d{1,2}\.)\s+/u.test(reply)
      && trips.filter(trip => looseNorm(reply).includes(looseNorm(trip.route_name))).length > 1;
    // Not after "that date has no departure; here are the dates": the customer
    // was told the date is off the schedule, so picking a trip drops it.
    if (original && !reply.startsWith(DATE_NOT_SCHEDULED_HEADING)
      && (displaysTripList || /(?:аль|ямар)\s+(?:аялл?|чиглэл)|which\s+(?:trip|destination)/iu.test(reply))
      && calendarWordsAreContextOnly(original.text) && requestedDepartureScope(original.text, now)
      && current.status !== "not_found") requestText = `${original.text}\n${text}`;
  }
  const storedSelection = await getTripSelection(senderId);
  const previousSelection = storedSelection && trips.some((trip) => trip.id === storedSelection.tripId)
    ? storedSelection : null;
  const resolve = (t: string, pool: TravelTrip[]) =>
    resolveTripFromUserMessage(t, pool, { allowLooseFallback: false });
  const chose = async (trip: TravelTrip, understanding?: Understanding): Promise<FastPathRoute> => {
    await clearClarificationState(senderId);
    const selection = mergeTripSelection(trip.id, buildTripRequest(requestText, trips, understanding, now), previousSelection);
    await setTripSelection(senderId, selection);
    // A typed "3" picks the trip exactly as tapping its "3. <name>…" button does. As a
    // bare digit the turn asked for nothing, so no card was built and the free-text
    // model answered instead (or nothing was sent) — live replay 2026-10-30.
    const turn = numericChoice && !numericChoice.namePrefix ? trip.route_name : websiteTripLinksInText(text).textWithoutUrls;
    // A trip that enters the conversation this turn is named in the answer: "tailand …" has several
    // trips, a pick by number names none, and a customer back after weeks may not remember. A follow-up
    // on the trip already selected stays compact (2026-10-30).
    return { matchText: joinContextAndTurn(trip.route_name, turn), scopedClarify: null, chosenTripId: trip.id, selection,
      ...(requestText !== text ? { requestText } : {}), ...(previousSelection?.tripId !== trip.id ? { newTrip: true } : {}) };
  };
  if (hasUnsupportedOriginRequest(text)) {
    return { matchText: markNoTrip(text), scopedClarify: null, unsupportedRequest: true };
  }
  // A shared website page identifies its trip before model interpretation,
  // old conversation context or a pending list can replace that identity.
  if (websiteTripLinksInText(text).slugs.length > 0) {
    const linked = resolve(text, trips);
    if (linked.status === "verified") return chose(linked.trip);
    await setTripSelection(senderId, null);
    await clearClarificationState(senderId);
    if (linked.status === "ambiguous") {
      await setClarificationState(senderId, linked.candidates.map((trip) => trip.id));
      return { matchText: text, scopedClarify: linked.candidates };
    }
    return { matchText: markNoTrip(text), scopedClarify: null };
  }
  if (tripMenuQuestionIndex(text) !== null) {
    const explicit = resolve(text, trips);
    if (explicit.status === "verified") return chose(explicit.trip);
    const trip = explicit.status === "ambiguous" ? null : tripFromRecentMenu(text, input.history || [], trips);
    return trip ? chose(trip) : { matchText: markNoTrip(text), scopedClarify: null, unsupportedRequest: true };
  }
  const tappedOwnButton = isOwnButtonLabel(text);
  const choice = parseNumberedChoice(text);

  // --- 1. Pending clarification: scope the answer to what we offered. ---
  // The state is saved whenever a message matches several trips, even when
  // another branch then answered about one trip ("10 сарын 8-нд <хот>" got
  // that day's single trip). A follow-up "Үнэ хэд вэ" re-listed all six. The
  // list only counts if the last reply actually asked which trip; tapped
  // buttons carry the trip's name and are still honoured.
  const previousReply = input.history ? lastAssistantReply(input.history) : undefined;
  const pendingIsStale =
    previousReply !== undefined && !isTripChoiceQuestion(previousReply) && !choice && !tappedOwnButton;
  const pending = pendingIsStale ? null : await getClarificationState(senderId);
  if (pendingIsStale) await clearClarificationState(senderId);
  const pendingTrips = pending
    ? pending.candidateTripIds
        .map((id) => trips.find((trip) => trip.id === id))
        .filter((trip): trip is TravelTrip => Boolean(trip))
    : [];

  // "Огноо нь", "хэзээ вэ" right after a "which trip?" list: the customer wants THOSE trips' dates.
  // Nothing names a trip, so it used to fall through to silence while staff were paged.
  if (pendingTrips.length > 1 && DATES_ONLY_RE.test(text.trim())) {
    return { matchText: text, scopedClarify: pendingTrips, scopedClarifyNote: "Эдгээр аяллын гарах өдрүүд:", informationalAlternatives: true };
  }

  // A head count under the list ("2 том хүн 1 нярай") prices the offered trips.
  // Decided before model interpretation: a reading of "the same trips" used to
  // drop the list and answer "Аль аялал вэ?", and asking again re-sent the list
  // without totals (live 2026-10-26).
  if (pendingTrips.length > 1 && !choice && !tappedOwnButton && isPassengerCountOnly(text)) {
    await setClarificationState(senderId, pendingTrips.map((trip) => trip.id));
    return { matchText: text, scopedClarify: pendingTrips };
  }

  // A fare question right under the list ("хүүхдийн үнэ") asks the listed trips' fares. It got
  // "Аль аялал вэ?" (P2-1); the list now shows each trip's fare and still lets them choose.
  if (pendingTrips.length > 1 && !choice && !tappedOwnButton && isFareOnlyQuestion(text)) {
    await setClarificationState(senderId, pendingTrips.map((trip) => trip.id));
    return { matchText: text, scopedClarify: pendingTrips };
  }

  // A date under a trip or a destination list is a follow-up to that scope.
  // Run before model interpretation and whole-catalog matching: a missing
  // date must never replace the destination with an unrelated departure.
  // A dotted date can also resemble a numbered button ("4.11 ..."). Its
  // complete date shape takes precedence over that syntactic interpretation.
  const requestedFollowupDate = !tappedOwnButton ? dateFollowup(text, now) : null;
  const dateScope = pendingTrips.length ? pendingTrips
    : previousSelection ? trips.filter(trip => trip.id === previousSelection.tripId) : [];
  if (requestedFollowupDate && dateScope.length) {
    const departing = dateScope.filter(trip => trip.status === "active" && tripMatchesRequestedDate(trip, requestedFollowupDate, now));
    if (departing.length === 1) return chose(departing[0]);
    const candidates = departing.length ? departing : dateScope;
    await setClarificationState(senderId, candidates.map(trip => trip.id));
    return { matchText: text, scopedClarify: candidates, unavailableDateWithinScope: departing.length === 0 };
  }

  // Read a calendar constraint before a model or an attribute scorer can
  // replace it with a generic destination menu. Keep the source trips intact;
  // presentation uses the same constraint to select their displayed dates.
  const calendarScope = !tappedOwnButton && !(numericChoice && requestText !== text)
    ? requestedDepartureScope(intentTextOf(requestText, trips), now) : null;
  if (calendarScope) {
    const current = resolve(text, trips);
    const named = current.status === "verified" ? [current.trip]
      : current.status === "ambiguous" ? current.candidates : [];
    const contextOnly = calendarWordsAreContextOnly(text);
    // A date does not erase a new, unresolved destination. Prior selection is
    // evidence only for an actual follow-up, never for a different name that
    // happens to ask about the same month.
    const scope = named.length ? named : contextOnly ? dateScope : [];
    if (!named.length && dateScope.length && !contextOnly) {
      return { matchText: markNoTrip(text), scopedClarify: null, unsupportedRequest: true };
    }
    if (calendarScope.kind === "unsupported") {
      return { matchText: requestText, scopedClarify: scope.length ? scope : null, unavailableDateWithinScope: true,
        unsupportedRequest: true, ...(requestText !== text ? { requestText } : {}) };
    }
    if (scope.length) {
      const ofKind = filterTripsByTransportIntent(text, scope);
      const matching = ofKind.filter(trip => upcomingDepartures(trip, now).some(date => departureMatchesScope(date, calendarScope))
        || (calendarScope.kind === "dates" && calendarScope.dates.some(date => tripMatchesRequestedDate(trip, date, now))));
      if (matching.length === 1) return chose(matching[0]);
      // One trip, nothing departing in the asked time, and the message asks more than the date
      // (the children's fares, the programme, the hotel): the trip's answer covers every part
      // and offers the nearest departures. "Not then, here are the dates" alone ignored the rest
      // of a family's opening message (Oct 24 shape).
      if (!matching.length && scope.length === 1 && asksBeyondDate(requestText, trips, now)) return chose(scope[0]);
      const candidates = matching.length ? matching : scope;
      await setClarificationState(senderId, candidates.map(trip => trip.id));
      return { matchText: requestText, scopedClarify: candidates, unavailableDateWithinScope: matching.length === 0,
        ...(requestText !== text ? { requestText, ...(matching.length ? {} : { unsupportedRequest: true }) } : {}) };
    }
    if (calendarScope.kind === "dates" && hasDepartureDateAvailabilityIntent(text, now)
      && !filterTripsByTransportIntent(text, trips).some(trip => upcomingDepartures(trip, now)
      .some(date => departureMatchesScope(date, calendarScope)))) {
      return { matchText: markNoTrip(text), scopedClarify: null, unsupportedRequest: true };
    }
  }

  // --- 0. Understanding: one reading of the whole message decides the trip. ---
  // A numbered pick ("2", "2. <name>…") and a tap on one of our own buttons
  // stay deterministic below; everything else — names in any spelling,
  // follow-ups, "тэр", a date or length that narrows a destination — is read
  // once here instead of by keyword scoring.
  if (input.understand && !choice && !tappedOwnButton) {
    const understanding = await input.understand(pendingTrips.map((trip) => trip.id), previousSelection);
    if (understanding) {
      if ((understanding.unmet || understanding.unknownRequirement) && understanding.trips.length > 0) {
        await clearClarificationState(senderId);
        return {
          matchText: text,
          scopedClarify: understanding.trips,
          scopedClarifyNote: unmetNote(understanding) || unknownRequirementNote(understanding),
          informationalAlternatives: true,
          understanding,
        };
      }
      if (understanding.certainty === "one") {
        return { ...(await chose(understanding.trips[0], understanding)), understanding };
      }
      if (understanding.certainty === "several" && understanding.intent !== "catalog") {
        // A question ABOUT the trips we just listed ("4 одтой юу?") is not a
        // new search: asking "which one?" again word for word reads as broken.
        // Leave the list pending and let the answer cover them.
        const offered = new Set(pendingTrips.map((trip) => trip.id));
        const sameAsOffered =
          !understanding.unmet &&
          offered.size === understanding.trips.length &&
          understanding.trips.every((trip) => offered.has(trip.id));
        if (sameAsOffered) return { matchText: text, scopedClarify: null, understanding };
        await setClarificationState(senderId, understanding.trips.map((trip) => trip.id));
        return {
          matchText: text,
          scopedClarify: understanding.trips,
          scopedClarifyNote: unmetNote(understanding),
          understanding,
        };
      }
      // No trip meant (or a catalog question): the trip matchers downstream
      // must not pull one in from a weak word ("aylal", "мэнд", "үнэ").
      await clearClarificationState(senderId);
      if (understanding.intent === "catalog" || understanding.unknownDestination) await setTripSelection(senderId, null);
      // A named destination we do not sell — said plainly, but only when the
      // keyword matcher agrees nothing fits, so a typo of a real destination
      // can never be told "we don't have that".
      const notInCatalog =
        understanding.unknownDestination && resolve(text, trips).status === "not_found"
          ? understanding.unknownDestination
          : undefined;
      return { matchText: markNoTrip(text), scopedClarify: null, understanding, notInCatalog };
    }
  }

  if (pendingTrips.length > 0) {
    if (choice) {
      // The NAME in a tapped "2. <trip name>..." outranks its number:
      // the number belongs to whichever list the button came from, which may
      // not be the list we asked last.
      const byIndex = pendingTrips[choice.index];
      const named = choice.namePrefix ? tripsNamedByPrefix(choice.namePrefix, trips) : [];
      const namedPending = named.filter((trip) => pendingTrips.includes(trip));
      if (named.length > 0) {
        if (byIndex && named.includes(byIndex)) return chose(byIndex);
        if (namedPending.length === 1) return chose(namedPending[0]);
        if (named.length === 1) return chose(named[0]);
        const scoped = namedPending.length > 1 ? namedPending : named;
        await setClarificationState(senderId, scoped.map((trip) => trip.id));
        return { matchText: text, scopedClarify: scoped };
      }
      if (byIndex) return chose(byIndex);
    }
    // One of our own buttons ("Хөтөлбөр үзэх") is not an answer to "which
    // trip?". Attribute-matching the label against candidates picked one at
    // random (its words appear in a trip description) and sent that PDF.
    if (tappedOwnButton) {
      // A "list" of one: there is nothing to choose between.
      if (pendingTrips.length === 1) return chose(pendingTrips[0]);
      const contextual = contextualUserText !== text ? resolve(contextualUserText, trips) : null;
      if (contextual?.status === "verified") return chose(contextual.trip);
      await setClarificationState(senderId, pendingTrips.map((trip) => trip.id));
      return { matchText: text, scopedClarify: pendingTrips };
    }
    // "Огноо нь" asks about the options already on screen. Re-render those
    // exact options with their dates instead of clearing the list and going
    // silent because the phrase names no individual trip.
    const pendingDateQuestion = /^(?:огноо(?:\s+нь)?|гарах\s+огноо(?:\s+нь)?|хэзээ(?:\s+гарах)?|ognoo(?:\s+ni)?|garah\s+ognoo(?:\s+ni)?|hezee(?:\s+garah)?)$/iu.test(looseNorm(text));
    if (pendingDateQuestion) {
      await setClarificationState(senderId, pendingTrips.map((trip) => trip.id));
      return {
        matchText: text,
        scopedClarify: pendingTrips,
        scopedClarifyNote: "Эдгээр аяллын гарах өдрүүд:",
      };
    }
    // A head count under the list ("2 том хүн 2 хүүхэд") prices every offered
    // trip, and "мэдээлэл явуулаад өгөөрэй" asks about them — neither is a
    // change of topic. Re-offer the list instead of handing it to the model.
    const asksForCategory =
      queryWantsDirectFlight(text) || queryWantsLandFlightCombo(text) || queryWantsLandOnlyEnhanced(text);
    const refersToOfferedTrip =
      hasReferentialHint(text) ||
      /(?:аялал|aylal|ayalal)\s*(?:нь|ni)\b|(?:aylal|ayalal)n\b/iu.test(looseNorm(text));
    if (isPassengerCountOnly(text) || (isGenericTripRequest(text) && !asksForCategory)) {
      await setClarificationState(senderId, pendingTrips.map((trip) => trip.id));
      return { matchText: text, scopedClarify: pendingTrips };
    }
    const scoped = resolve(text, pendingTrips);
    if (scoped.status === "verified") return chose(scoped.trip);
    // An attribute answer that fits exactly one offered trip ("<хот>-оос",
    // the departure city in one candidate's description) settles it before
    // the whole catalog gets a say — the catalog check below took that city
    // as an unrelated trip with the city in its NAME (2026-09-21).
    const byAttribute = filterCandidatesByAttribute(text, pendingTrips);
    if (byAttribute.length === 1) return chose(byAttribute[0]);
    const catalogDirect = resolve(text, trips);
    if (
      catalogDirect.status === "verified" &&
      !pendingTrips.some((trip) => trip.id === catalogDirect.trip.id)
    ) {
      return chose(catalogDirect.trip);
    }
    // If the current words identify a fresh trip, the branch above wins. With
    // no fresh match, "энэ/аялал нь ...?" is a question about the options on
    // screen, not a request for an unrelated whole-catalog transport list.
    if (asksForCategory && refersToOfferedTrip && filterTripsByTransportIntent(text, pendingTrips).length === 0) {
      const requestedKind = queryWantsDirectFlight(text)
        ? "шууд нислэгтэй"
        : queryWantsLandFlightCombo(text)
          ? "газар + нислэг хосолсон"
          : "газрын";
      await setClarificationState(senderId, pendingTrips.map((trip) => trip.id));
      return {
        matchText: text,
        scopedClarify: pendingTrips,
        scopedClarifyNote: `Эдгээр аялал ${requestedKind} биш. Одоогийн мэдээллээр:`,
        informationalAlternatives: true,
      };
    }
    // A date answer ("8 сарын 24-нд хэд вэ") narrows by DEPARTURE DATE — the
    // name/attribute matchers can't read dates, which used to clear the state
    // and re-clarify from the whole catalog. One departing candidate → that's
    // the trip; several → keep the clarification scoped to exactly those,
    // with the date echoed so the re-ask reads as informed.
    // "…шууд нислэгтэй ямар аялал" under a list: the date narrows, but only
    // to trips of that kind — a combo trip leaving that day was served as the
    // answer to a direct-flight question. No trip of that kind among the
    // offered ones means a fresh catalog question: fall through.
    const ofAskedKind = (list: TravelTrip[]) => (asksForCategory ? filterTripsByTransportIntent(text, list) : list);
    const requestedYmd = parseDepartureDateText(text, now)[0];
    if (requestedYmd) {
      const byDate = ofAskedKind(pendingTrips.filter((trip) =>
        tripMatchesRequestedDate(trip, requestedYmd, now),
      ));
      if (byDate.length === 1) return chose(byDate[0]);
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
    // A month answer ("1 сард", "10sar", "11 сард бна уу") narrows the same
    // way. When none of the offered trips departs that month, say so and list
    // what they DO have, instead of silently answering about one of them.
    const requestedMonth = requestedYmd ? null : resolveRequestedMonth(text, now);
    if (requestedMonth && (!asksForCategory || ofAskedKind(pendingTrips).length > 0)) {
      const byMonth = ofAskedKind(pendingTrips.filter((trip) => tripDepartsInMonth(trip, requestedMonth.month, now)));
      if (byMonth.length === 1) return chose(byMonth[0]);
      await setClarificationState(senderId, (byMonth.length > 0 ? byMonth : ofAskedKind(pendingTrips)).map((trip) => trip.id));
      return {
        matchText: text,
        scopedClarify: byMonth.length > 0 ? byMonth : ofAskedKind(pendingTrips),
        scopedClarifyNote: byMonth.length > 0
          ? `${requestedMonth.month} сард эдгээр аялал гарна:`
          : `${requestedMonth.month} сард гарах аялал эдгээрээс алга байна. Эдгээрийн гарах өдрүүд:`,
      };
    }
    if (scoped.status === "ambiguous") {
      // Refine the resolver's candidates with attribute containment: for
      // "5 өдөр нь" the resolver kept {4 өдөр, 5 өдөр} (digit-blind scoring),
      // but only one of them actually contains the customer's "5".
      const refined = filterCandidatesByAttribute(text, scoped.candidates);
      if (refined.length === 1) return chose(refined[0]);
      const candidates = refined.length > 1 ? refined : scoped.candidates;
      await setClarificationState(senderId, candidates.map((trip) => trip.id));
      return { matchText: text, scopedClarify: candidates };
    }
    if (byAttribute.length > 1) {
      await setClarificationState(senderId, byAttribute.map((trip) => trip.id));
      return { matchText: text, scopedClarify: byAttribute };
    }
    // Nothing fits the offered options — the customer moved on.
    await clearClarificationState(senderId);
  }

  // A numbered button title with no (or an expired) pending question: its
  // name alone identifies the trip.
  if (choice?.namePrefix) {
    const named = tripsNamedByPrefix(choice.namePrefix, trips);
    if (named.length === 1) return chose(named[0]);
    if (named.length > 1) {
      await setClarificationState(senderId, named.map((trip) => trip.id));
      return { matchText: text, scopedClarify: named };
    }
  }

  // --- 2. Stateless current-message-first routing, capturing new ambiguity. ---
  const direct = resolve(text, trips);
  // Bug (found 2026-07-22 replaying real traffic): "hi" sent two days after
  // asking about a trip got that trip's stale price/dates re-served. A
  // greeting asks nothing and has no context to resolve — checked here (not
  // just in buildContextualUserText, which now never builds that pollution
  // for a greeting in the first place) so routeFastPathText is never
  // dependent on a caller having sanitized contextualUserText first.
  if (contextualUserText !== text && direct.status === "not_found" && isKnownGreetingPhrase(text)) {
    return { matchText: text, scopedClarify: null };
  }
  // Our own button label never names a trip, however well it scores against
  // one — skip straight to context so the tap applies to the trip the
  // customer was actually looking at.
  if (direct.status === "verified" && !tappedOwnButton) {
    return { ...(await chose(direct.trip)), matchText: text };
  }
  const followupRequest = previousSelection ? buildTripRequest(text, trips, undefined, now) : null;
  const passengerWords = text.toLowerCase().replace(/[^\p{L}]+/gu, " ").trim().split(/\s+/);
  const onlyPassengerQuestion = Boolean(followupRequest?.passengers.length) && passengerWords.every((word) =>
    /^(?:том|хүн|хүүхэд|хүүхдүүд|нярай|настай|сартай|нийт|үнэ|хэд|хэдэн|төгрөг|вэ|ве|бид|явбал|байна|бна|бол|нэг|tom|hun|huuhed|nyarai|nastai|nas|niit|une|hed|heden|ve|adult|adults|child|children|infant|infants|years?|months?|old|total|price|how|much|for|and|with)$/iu.test(word));
  if (previousSelection && direct.status === "not_found" && !isKnownGreetingPhrase(text)
    && (tappedOwnButton || Boolean(followupRequest?.hotel) || onlyPassengerQuestion
      || (isLikelyContextDependentText(text) && Boolean(followupRequest?.topics.length)))) {
    const focused = trips.find((trip) => trip.id === previousSelection.tripId);
    if (focused) return chose(focused);
  }
  const contextual = contextualUserText !== text ? resolve(contextualUserText, trips) : null;
  if (tappedOwnButton && contextual?.status === "verified") {
    return chose(contextual.trip);
  }
  // Bug (found 2026-07-17 replaying real traffic): "<city>" alone after a
  // <city> (unrelated) reply returned <city>. isLikelyContextDependentText
  // treats ANY 1-2 word message as a follow-up reference (needed for real
  // pronouns like "тэр хэд вэ?"), but a bare destination name like "<city>"
  // is a complete, self-sufficient query — it happened to resolve AMBIGUOUS
  // (several real <city> trips), not "nothing", so it has its own opinion
  // that must be respected. Only let the contextual winner override when it's
  // actually one of the direct candidates (the same guard pickFastPathMatchText
  // already applies below) — otherwise it's a stale unrelated trip hijacking
  // an unrelated fresh query, exactly the class of bug this file's own
  // docstring warns about.
  // Context may narrow an ambiguous message only when the message ADDS
  // something ("шууд нислэгтэй нь", "газрын", "тэр үнэ"). A place name typed
  // again ("<хот>" right after one of its trips' cards) asks for the
  // destination again — it used to re-serve the card on screen instead of the
  // list of that destination's trips.
  const directRejectsContextual =
    direct.status === "ambiguous" &&
    !(
      contextual?.status === "verified" &&
      direct.candidates.some((trip) => trip.id === contextual.trip.id) &&
      addsNarrowing(text, direct.candidates)
    );
  if (
    contextualUserText !== text &&
    isLikelyContextDependentText(text) &&
    contextual?.status === "verified" &&
    !directRejectsContextual
  ) {
    return chose(contextual.trip);
  }
  const picked = directRejectsContextual
    ? text
    : pickFastPathMatchText(text, contextualUserText, (t) =>
        t === text ? direct : contextual ?? resolve(t, trips),
      );

  if (direct.status === "ambiguous") {
    await setClarificationState(senderId, direct.candidates.map((trip) => trip.id));
  } else if (contextual?.status === "ambiguous") {
    await setClarificationState(senderId, contextual.candidates.map((trip) => trip.id));
  }

  // Context is only for identifying the trip. Do not pass the whole previous
  // answer back into price/date/program builders: it may contain stale
  // qualifiers ("тийзгүй", "7 сар", an old price) that override what the
  // customer asks in the current turn. Once context resolves one trip, reduce
  // it to the canonical trip name plus the current message — and when context
  // resolves NOTHING, it has nothing to offer: the bot's previous reply full
  // of "үнэ"/"гарах" made "амжилт" a price question that matched no trip and
  // silently handed the customer to staff.
  if (picked === contextualUserText && contextual?.status === "verified") {
    return chose(contextual.trip);
  }
  if (picked === contextualUserText && contextual?.status !== "ambiguous") {
    return { matchText: customerTurn(picked), scopedClarify: null };
  }
  return { matchText: picked, scopedClarify: null };
}
