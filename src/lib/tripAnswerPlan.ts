import { asksClockTime, scheduleTimeSection } from "./scheduleTimes";
import { dealDateNote } from "./departureDeals";
import type { TravelTrip } from "./travelTypes";
import type { FastPathRoute } from "./fastPathRouting";
import { buildTripRequest, mergeTripSelection, type TripRequest, type TripSelection, type TripTopic } from "./tripRequest";
import { normalizeTripOffers, resolveTripOffer, resolveTripOfferFareCard, type PassengerKind, type TripOfferResult } from "./tripOffers";
import { evaluateTripRequirement, tripTransport, type TripRequirement } from "./tripFacts";
import { tripDurationDays, getTripBrochureAsset, getTripWebsiteLink } from "./travelFastPathsSearch";
import { departureAvailability, departureIsClosed, departureIsLow, openDateWording } from "./departureAvailability";
import { compactReplyOptions, presentAssistantReply, replyPreferences } from "./chatbotReplyPolicy";
import { stripTripNamesForIntent } from "./customerTurn";
import { isOptionalExtrasQuestion } from "./tripExtrasReply";
import { customerDate as mnDate } from "./customerDate";
import { dateIsOnSale, renderOfferReplyWithConditions } from "./tripFareBlock";
import { formatTripHotel, tripHotels } from "./tripHotelReply";
import { hasSeatsIntent } from "./travelFastPaths";
import { formatPassengerPriceLines } from "./travelFastPathsPricing";
import { GENERIC_ROUTE_WORDS, normText } from "./travelTextNorm";
import { isReferReply } from "./reply";
import { ADULT_COUNT_QUESTION } from "./selectionAnswer";

/** "Баасан гараг бүр", "өдөр бүр": a recurring schedule written as text, with no calendar dates. */
export function recurringScheduleTexts(trip: TravelTrip): string[] {
  return (trip.departure_dates || []).filter((text) => typeof text === "string" && !/\d/.test(text)
    && /гар(?:а|и)г|даваа|мягмар|лхагва|пүрэв|баасан|бямба|ням|бүр|болгон|тутам|every|daily|weekly/iu.test(text)).map((text) => text.trim());
}

/**
 * The message asks about a word (5+ letters) of the trip's own included or excluded items that is
 * not part of the trip's name or aliases and not a generic travel word.
 */
function asksAboutTripItem(text: string, trip: TravelTrip): boolean {
  const items = [...strings(trip.extra.included_items), ...strings(trip.extra.excluded_items)];
  if (!items.length || !/[?？]|(?:^|[^\p{L}])(?:уу|үү|юу|вэ|бэ|yu|uu|ve|бий|байгаа|байдаг|байна|bga|baigaa|bn|bna)(?:[^\p{L}]|$)/iu.test(text)) return false;
  const words = (value: string) => normText(value).split(/\s+/).filter((word) => word.length >= 5);
  const identity = new Set([trip.route_name, ...strings(trip.extra.aliases)].flatMap(words));
  const itemWords = [...new Set(items.flatMap(words))].filter((word) => !identity.has(word) && !GENERIC_ROUTE_WORDS.has(word));
  return words(text).some((word) => !identity.has(word) && !GENERIC_ROUTE_WORDS.has(word)
    && itemWords.some((item) => item === word || word.startsWith(item) || item.startsWith(word)));
}

/** How a closed departure reads: the website's own status, never an inferred seat count. */
function closedDepartureWording(row: { status: string; seatsLeft: number | null }): string {
  if (row.status === "PAUSED") return "захиалга түр хаалттай.";
  if (row.status === "CANCELLED") return "гаралт цуцлагдсан.";
  if (row.status === "DEPARTED") return "аялал хөдөлсөн.";
  return "суудал дүүрсэн.";
}

/**
 * A weekly-schedule trip has no dated offer, so the offer engine cannot price it. Its fares are
 * the trip's own figures (the same ones the trip card prints), shown only when the trip has no
 * per-date or per-hotel price rows that could contradict them.
 */
function recurringFareLines(trip: TravelTrip, fareKinds: readonly ("adult" | "child" | "infant")[]): string | null {
  const groups = Array.isArray(trip.extra?.price_groups) ? trip.extra.price_groups : [];
  if (groups.length) return null;
  const ages = trip.extra?.age_rules && typeof trip.extra.age_rules === "object" ? trip.extra.age_rules as Record<string, unknown> : {};
  const age = (kind: string) => (typeof ages[kind] === "string" ? ages[kind] as string : "");
  const wanted = (kind: "adult" | "child" | "infant") => !fareKinds.length || fareKinds.includes(kind);
  const lines = formatPassengerPriceLines({
    adult: wanted("adult") ? trip.adult_price : null, child: wanted("child") ? trip.child_price : null, infant: wanted("infant") ? trip.infant_price : null,
    childAge: age("child"), infantAge: age("infant"), currency: trip.currency || "MNT",
  });
  return lines.length ? lines.join("\n") : null;
}

export type TripAnswerPlan = {
  status: "answered" | "clarify" | "handoff";
  tripId: string;
  selection: TripSelection;
  request: TripRequest;
  reply: string;
  offer: TripOfferResult | null;
  answeredTopics: TripTopic[];
  missingTopics: TripTopic[];
  /** Requested facts the data could not establish; never inferred from reply prose. */
  missingFacts: string[];
  mediaUrls: string[];
  brochureUrl: string | null;
  /** Preferences the data cannot answer, for the staff lead written with this answer. */
  staffNotes?: string[];
  /** The reply's line telling the customer those preferences went to staff; dropped if no lead was written. */
  staffLine?: string;
};

/** Said when the asked date or window has no departure; the nearest departures follow. */
export const REQUESTED_TIME_NOT_SCHEDULED = "Таны асуусан хугацаанд гарах хуваарь байхгүй.";
const NEAREST_DEPARTURES = 3;

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")) : [];
const today = (now: Date) => new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
const TRANSPORT = { direct_flight: "Шууд нислэгтэй аялал.", land: "Газрын аялал.", land_flight: "Газар + нислэг хосолсон аялал.", cruise: "Усан онгоцны аялал." };

function selectionQuestion(result: TripOfferResult, text: string, quote?: (option: string) => string | null, dateMark?: (date: string) => string): string | null {
  if (result.status !== "needs_selection") return null;
  const field = result.fields[0];
  const question = field === "date" ? "Аль гарах өдрөөр аялах вэ?"
    : field === "hotel" ? "Аль буудлын хувилбарыг сонгох вэ?"
      : field === "package" ? "Аль багцыг сонгох вэ?"
        : field === "passengers" ? "Хүүхэд тус бүрийн насыг хэлнэ үү."
          : "Хямдралын нөхцөл танд тохирох эсэхийг тодруулна уу.";
  return [question, ...(field === "date" ? listedDates(result.options, text) : compactReplyOptions(result.options, text)).map((option) => {
    const price = result.options.includes(option) ? quote?.(option) : null;
    const mark = field === "date" && result.options.includes(option) ? dateMark?.(option) : "";
    return `• ${field === "date" ? mnDate(option) : option}${mark ? ` — ${mark}` : ""}${price ? `\n${price}` : ""}`;
  })].join("\n");
}

/** A missing choice should help the customer compare, rather than repeat a
 * bare menu. Unit fares never imply a total for an unselected hotel/package. */
function selectionFareQuote(trip: TravelTrip, selection: TripSelection, result: TripOfferResult, now: Date, text: string) {
  if (result.status !== "needs_selection" || !selection.date || !["hotel", "package"].includes(result.fields[0])) return undefined;
  const preferences = replyPreferences(text);
  const fareKinds = preferences.full || preferences.fareKinds.length ? preferences.fareKinds : ["adult", "child"] as const;
  return (option: string): string | null => {
    const card = resolveTripOfferFareCard(trip, { date: selection.date,
      hotel: result.fields[0] === "hotel" ? option : selection.hotel,
      packageId: result.fields[0] === "package" ? option : selection.package,
    }, now);
    if (card.status !== "ready" || missingRequestedFares(card, preferences.requiredFareKinds).length) return null;
    return renderOfferReplyWithConditions(trip, card, { fareKinds: [...fareKinds], showTotal: false })?.split("\n")
      .filter(line => line !== mnDate(card.offer.date)
        && line !== (result.fields[0] === "hotel" ? card.offer.hotel : card.offer.packageId)).join("\n") || null;
  };
}

function unavailableText(result: TripOfferResult): string | null {
  if (result.status !== "unavailable") return null;
  const date = result.date ? `${mnDate(result.date)}: ` : "";
  switch (result.reason) {
    case "sold_out": return `${date}суудал дүүрсэн.`;
    case "paused": return `${date}захиалга түр хаалттай.`;
    case "cancelled": return `${date}гаралт цуцлагдсан.`;
    case "departed": return `${date}аялал хөдөлсөн.`;
    case "insufficient_seats": return `${date}танай зорчигчдын тоонд хүрэлцэх суудал үлдээгүй.`;
    case "hotel_not_offered": return `${date}энэ буудлын хувилбар байхгүй.`;
    case "package_not_offered": return `${date}энэ багцын хувилбар байхгүй.`;
    case "departure_not_offered": return `${date}гарах хуваарь байхгүй.`;
    default: return null;
  }
}

function ageQualifiedPartyCoversKind(text: string, result: Extract<TripOfferResult, { status: "ready" }>, kind: "adult" | "child" | "infant") {
  if (kind === "adult") return false;
  const label = kind === "child" ? "(?:хүүх(?:эд|дийн)|child(?:ren)?|huuhed|huuhdiin)" : "(?:нярай(?:н)?|infant(?:s)?|nyarai)";
  return result.offer.passengerPrices.some(passenger => {
    if (passenger.age === null || passenger.fare.kind === "unknown") return false;
    const age = String(passenger.age).replace(".", "[.,]");
    const unit = passenger.ageUnit === "month" ? "(?:сартай|months?\\s*old)" : "(?:настай|nas(?:tai)?|years?\\s*old)";
    // An age-named child may legitimately use the adult fare. Only that
    // customer's age/label phrase authorizes the reclassification; another
    // adult's age cannot answer a separate child-fare question.
    return new RegExp(`(?<![\\d.,])${age}\\s*${unit}\\s*${label}|${label}\\s*(?:(?:нь|is|aged)\\s*)?${age}\\s*${unit}`, "iu").test(text);
  });
}

function missingRequestedFares(result: TripOfferResult, kinds: ReturnType<typeof replyPreferences>["requiredFareKinds"], customerText = "") {
  if (result.status !== "ready") return [];
  if (result.offer.passengerPrices.length) return kinds.filter(kind =>
    !result.offer.passengerPrices.some(passenger => passenger.kind === kind && passenger.fare.kind !== "unknown")
    && !ageQualifiedPartyCoversKind(customerText, result, kind));
  return kinds.filter(kind => !result.offer.fares.some(fare => fare.kind === kind && fare.fare.kind !== "unknown"));
}

function stableFarePreview(trip: TravelTrip, selection: TripSelection, result: TripOfferResult, now: Date, text: string, fareKindsOverride?: PassengerKind[]): string | null {
  if (result.status !== "needs_selection" || result.fields[0] !== "date") return null;
  if (selection.passengers.length) return stablePartyTotal(trip, selection, result.options, now, text);
  const cards = result.options.map((date) => resolveTripOfferFareCard(trip, { date, hotel: selection.hotel, packageId: selection.package }, now));
  const preferences = replyPreferences(text);
  const fareKinds = fareKindsOverride ?? preferences.fareKinds;
  const requiredFareKinds = fareKindsOverride ?? preferences.requiredFareKinds;
  if (cards.some(card => missingRequestedFares(card, requiredFareKinds).length)) return null;
  const signature = (card: TripOfferResult) => card.status === "ready" ? JSON.stringify({
    hotel: card.offer.hotel, package: card.offer.packageId, currency: card.offer.currency,
    conditions: [...card.offer.conditions].sort(),
    fares: card.offer.fares.filter((fare) => !fareKinds.length || fareKinds.includes(fare.kind)).map((fare) => ({ kind: fare.kind, ageRange: fare.ageRange, fare: fare.fare })),
  }) : null;
  if (!cards.length || !signature(cards[0])) return null;
  if (cards.some((card) => signature(card) !== signature(cards[0]))) return fareKinds.length ? faresByDate(trip, cards, fareKinds) : null;
  const first = cards[0];
  if (first.status !== "ready") return null;
  return renderOfferReplyWithConditions(trip, first, { fareKinds })?.split("\n").filter((line) => line !== mnDate(first.offer.date)).join("\n") || null;
}

/** At most this many groups of departures with their own fares; more is a menu, not an answer. */
const MAX_FARE_DATE_GROUPS = 4;
/** One trip's dates listed whole up to this many (they are one short line each). */
const MAX_LISTED_DATES = 6;
const listedDates = (dates: string[], text: string) => dates.length <= MAX_LISTED_DATES ? dates : compactReplyOptions(dates, text);

/**
 * "хүүхдийн үнэ" for a trip whose fare differs by departure: the asked fare for each departure,
 * departures with the same fare together ("11 сарын 18, 11 сарын 25" / fare). Asking "which
 * departure?" again re-sent the same date menu word for word, and the customer never got the price.
 * Null when a date cannot be priced or there are too many different fares.
 */
function faresByDate(trip: TravelTrip, cards: TripOfferResult[], fareKinds: readonly ("adult" | "child" | "infant")[]): string | null {
  const groups = new Map<string, { dates: string[]; body: string }>();
  for (const card of cards) {
    if (card.status !== "ready") return null;
    const rendered = renderOfferReplyWithConditions(trip, card, { fareKinds: [...fareKinds] });
    const body = rendered?.split("\n").filter((line) => line !== mnDate(card.offer.date)).join("\n");
    if (!body) return null;
    const group = groups.get(body);
    if (group) group.dates.push(card.offer.date);
    else groups.set(body, { dates: [card.offer.date], body });
  }
  if (groups.size < 2 || groups.size > MAX_FARE_DATE_GROUPS) return null;
  return [...groups.values()].map((group) => `${group.dates.map((date) => mnDate(date)).join(", ")}\n${group.body}`).join("\n\n");
}

/**
 * A price question on a trip priced per date asks which date (the date decides the fare). Each date of that question
 * carries its adult fare: the question went out with no price at all (2026-11-23). "" when the date has no single
 * adult fare.
 */
function dateAdultFare(trip: TravelTrip, selection: TripSelection, date: string, now: Date): string {
  const card = resolveTripOfferFareCard(trip, { date, hotel: selection.hotel, packageId: selection.package }, now);
  if (card.status !== "ready" || card.offer.currency !== "MNT") return "";
  const adult = card.offer.fares.filter((fare) => fare.kind === "adult");
  return adult.length === 1 && adult[0].fare.kind === "exact" ? `Том хүн ${adult[0].fare.amount.toLocaleString("en-US")}₮` : "";
}

/**
 * "2 том хүн 1 хүүхэд" for a trip whose every date sells at the same fares: the party
 * total is the same whichever date is picked, so it is given now. The date question
 * came back instead, and again after "одоо 3 том хүн" (live replay 2026-10-30).
 * Null whenever any date would give a different total or cannot be priced.
 */
function stablePartyTotal(trip: TravelTrip, selection: TripSelection, dates: string[], now: Date, text: string): string | null {
  const offers = dates.map((date) => resolveTripOffer(trip, { date, hotel: selection.hotel, packageId: selection.package, passengers: selection.passengers }, now));
  if (!offers.length || offers.some((offer) => offer.status !== "ready" || !offer.offer.total)) return null;
  const signature = (offer: TripOfferResult) => offer.status === "ready" ? JSON.stringify({
    total: offer.offer.total, hotel: offer.offer.hotel, package: offer.offer.packageId, currency: offer.offer.currency,
    conditions: [...offer.offer.conditions].sort(), passengers: offer.offer.passengerPrices.map((passenger) => ({ kind: passenger.kind, count: passenger.count, fare: passenger.fare })),
  }) : null;
  if (offers.some((offer) => signature(offer) !== signature(offers[0]))) return null;
  const first = offers[0];
  if (first.status !== "ready") return null;
  return renderOfferReplyWithConditions(trip, first, { fareKinds: replyPreferences(text).fareKinds, showTotal: true })
    ?.split("\n").filter((line) => line !== mnDate(first.offer.date)).join("\n") || null;
}

/**
 * A price question for a date sold at several hotels: each hotel's fare for that date.
 * "<сар> сарын <өдөр>-нд … хэд вэ?" got only "Аль буудлын хувилбарыг сонгох вэ?" — the
 * customer asked the price and both prices are known (2026-10-21).
 */
function hotelFarePreview(trip: TravelTrip, selection: TripSelection, result: TripOfferResult, now: Date, text: string): string | null {
  if (result.status !== "needs_selection" || result.fields[0] !== "hotel" || !selection.date || result.options.length > 4) return null;
  const { fareKinds, requiredFareKinds } = replyPreferences(text);
  const blocks: string[] = [];
  for (const hotel of result.options) {
    const first = resolveTripOfferFareCard(trip, { date: selection.date, hotel, packageId: selection.package }, now);
    // A hotel sold in packages (with / without the programme): one fare per package.
    const packages = first.status === "needs_selection" && first.fields[0] === "package" ? first.options : [null];
    for (const packageId of packages) {
      const card = packageId ? resolveTripOfferFareCard(trip, { date: selection.date, hotel, packageId }, now) : first;
      if (card.status !== "ready" || missingRequestedFares(card, requiredFareKinds).length) return null;
      const body = renderOfferReplyWithConditions(trip, card, { fareKinds })?.split("\n").filter((line) => line !== mnDate(card.offer.date) && !/^Буудал:/.test(line) && ![hotel, packageId, `${hotel} · ${packageId}`].includes(line.trim())).join("\n");
      if (!body) return null;
      blocks.push(`Буудал: ${hotel}${packageId ? ` · ${packageId}` : ""}\n${body}`);
    }
  }
  if (blocks.length > 4) return null;
  return blocks.length ? [mnDate(selection.date), ...blocks].join("\n\n") : null;
}

/**
 * The date is still open but every date sells the same per-hotel fares: the hotel fares, then the
 * dates to choose from. Null when any date would price a hotel differently.
 */
function dateIndependentHotelPreview(trip: TravelTrip, selection: TripSelection, result: TripOfferResult, now: Date, text: string): string | null {
  if (result.status !== "needs_selection" || result.fields[0] !== "date" || selection.hotel || result.options.length > 6) return null;
  const previews = result.options.map((date) => {
    const card = resolveTripOfferFareCard(trip, { date, hotel: null, packageId: selection.package }, now);
    if (card.status !== "needs_selection" || card.fields[0] !== "hotel") return null;
    return hotelFarePreview(trip, { ...selection, date }, card, now, text)?.split("\n").slice(1).join("\n").trim() || null;
  });
  if (!previews.length || previews.some((preview) => !preview || preview !== previews[0])) return null;
  return [previews[0], "Аль гарах өдрөөр аялах вэ?", ...listedDates(result.options, text).map((option) => `• ${result.options.includes(option) ? mnDate(option) : option}`)].join("\n");
}

/** All factual sections are built from the same ID and offer selection. */
export function buildTripAnswerPlan(input: {
  text: string; trips: TravelTrip[]; route: FastPathRoute; now?: Date; weatherReply?: string;
}): TripAnswerPlan | null {
  const { route, trips } = input;
  // Requirement failures must be delivered as alternatives, never selected here.
  if (route.informationalAlternatives || route.scopedClarify?.length) return null;
  const trip = trips.find((candidate) => candidate.id === route.chosenTripId);
  if (!trip) return null;
  const now = input.now || new Date();
  const requestText = route.requestText || input.text;
  const intentText = stripTripNamesForIntent(requestText, trips);
  const preferences = replyPreferences(intentText);
  const request = buildTripRequest(requestText, trips, route.understanding, now);
  // "Хэдэн цагт нисэх вэ" asks for a clock time, whatever topic the reading gave it: the itinerary's
  // own times answer it, a transport label does not (scheduleTimes.ts).
  const asksClock = asksClockTime(intentText);
  if (asksClock && !request.topics.includes("transport")) request.topics = [...request.topics, "transport"];
  // Package identities belong to the selected trip; a sibling's labels cannot
  // make this trip's customer-supplied package ambiguous.
  const packageRequest = buildTripRequest(requestText, [trip], route.understanding, now);
  request.package = packageRequest.package;
  const selection = mergeTripSelection(trip.id, request, route.selection || null);
  if (request.unsupportedPassengerSelection) {
    return {
      status: "handoff", tripId: trip.id, selection, request, reply: "REFER", offer: null,
      answeredTopics: [], missingTopics: request.topics, missingFacts: ["price.passengers"], mediaUrls: [], brochureUrl: null,
    };
  }
  if (request.unsupportedDateWindow) {
    return {
      status: "handoff", tripId: trip.id, selection, request, reply: "REFER", offer: null,
      answeredTopics: [], missingTopics: request.topics, missingFacts: ["dates.window"], mediaUrls: [], brochureUrl: null,
    };
  }
  if (request.packagePreference && !selection.package) {
    return {
      status: "handoff", tripId: trip.id, selection, request, reply: "REFER", offer: null,
      answeredTopics: [], missingTopics: request.topics, missingFacts: ["price.package"], mediaUrls: [], brochureUrl: null,
    };
  }
  if (request.requestedFacts?.length) {
    // The catalog has no typed source for these requested properties. A hotel
    // name, a fare, or another answered topic cannot establish them.
    return {
      status: "handoff", tripId: trip.id, selection, request, reply: "REFER", offer: null,
      answeredTopics: [], missingTopics: request.topics,
      missingFacts: [...new Set(request.requestedFacts.map(fact => fact.field))], mediaUrls: [], brochureUrl: null,
    };
  }
  if (isOptionalExtrasQuestion(intentText)) {
    // Listing an add-on and its price cannot establish whether it is mandatory.
    // No supported mandatory/optional field exists in the source schema yet.
    return {
      status: "handoff", tripId: trip.id, selection, request,
      reply: "REFER", offer: null, answeredTopics: [], missingTopics: request.topics,
      missingFacts: ["extras.mandatory"], mediaUrls: [], brochureUrl: null,
    };
  }
  // "Орвелиа аялалд орчуулагч байгаа юу": a word of this trip's own included or excluded items,
  // asked about, is an inclusions question. "байгаа юу" alone read as availability and got fares
  // and dates (held-out 2026-11-02).
  if (asksAboutTripItem(intentText, trip) && request.topics.every((topic) => topic === "availability" || topic === "price")) {
    const keepAvailability = Boolean(request.date || request.range || request.month || request.dates);
    request.topics = [...request.topics.filter((topic) => keepAvailability || topic !== "availability"), "includes"];
  }
  if (!request.topics.length || request.topics.some((topic) => ["comparison", "budget"].includes(topic))) return null;
  const wantsPartyTotal = /нийт|total|\d+\s*(?:том\s*хүн|хүүхэд|нярай|adult|child|infant|tom\s*hun|huuhed|nyarai)/i.test(intentText) || !preferences.fareKinds.length;
  const partyPassengers = wantsPartyTotal ? selection.passengers
    : request.passengers.length ? request.passengers
      : [];
  // Children or infants with no adult ("2 хүүхэдтэй"): a "Нийт" over the minors alone
  // read as the family's price (live replay 2026-10-30). Their per-person fares are
  // given and the one missing fact, the number of adults, is asked.
  const minorsOnly = request.topics.includes("price") && partyPassengers.length > 0 && !partyPassengers.some((passenger) => passenger.kind === "adult");
  const pricePassengers = minorsOnly ? [] : partyPassengers;
  // "1 настай хүүхэд хэд вэ": the fare shown is the one the stated AGE falls in (нярай), not the
  // one the word "хүүхэд" names — a one-year-old was quoted the child fare (dev evaluation 2026-11-02).
  const minorKinds: PassengerKind[] | null = minorsOnly ? [...new Set(partyPassengers.map((passenger) => passenger.kind))] : null;
  const requirements: TripRequirement[] = [];
  if (request.days) requirements.push({ kind: "days", days: request.days });
  if (request.transport) requirements.push({ kind: "transport", transport: request.transport });
  const failed = requirements.find((requirement) => evaluateTripRequirement(trip, requirement, now) !== "match");
  if (failed) {
    return {
      status: "handoff", tripId: trip.id, selection, request, offer: null, reply: "REFER",
      answeredTopics: [], missingTopics: request.topics, missingFacts: [`requirement.${failed.kind}`], mediaUrls: [], brochureUrl: null,
    };
  }
  // The resolved trip is already recorded in the plan/selection. Repeating its
  // full marketing title adds no answer to a one-fact follow-up.
  const lines: string[] = [];
  const answered = new Set<TripTopic>();
  const offers = normalizeTripOffers(trip, now);
  const dates = [...new Set(offers.filter((offer) => offer.source !== "discount").flatMap((offer) => offer.dates))].filter((date) => date >= today(now)).sort();
  const dateScope = selection.dateScope || request;
  const scopedDates = dates.filter((date) => (!dateScope.month || Number(date.slice(5, 7)) === dateScope.month)
    && (!dateScope.year || Number(date.slice(0, 4)) === dateScope.year)
    && (!dateScope.range || (date >= dateScope.range[0] && date <= dateScope.range[1]))
    && (!dateScope.dates || dateScope.dates.includes(date)));
  const websiteAvailability = departureAvailability(trip);
  // Few seats, closed or on sale: the same mark beside a date wherever the date is listed (2026-11-23).
  const dateMark = (date: string) => {
    const row = websiteAvailability.find((entry) => entry.date === date);
    return row && departureIsClosed(row) ? "захиалга хаалттай" : [row && departureIsLow(row) ? "цөөн суудал" : "", dealDateNote(trip, date)].filter(Boolean).join(", ");
  };
  const recurring = dates.length ? [] : recurringScheduleTexts(trip);
  const sections: Partial<Record<TripTopic, string>> = {};
  const incomplete = new Map<TripTopic, string[]>();
  const missingFact = (topic: TripTopic, field: string) => incomplete.set(topic, [...(incomplete.get(topic) || []), `${topic}.${field}`]);
  const asksSeats = hasSeatsIntent(intentText);
  // "suudal bga yu" on a date marked open with no seat count: the date is open, the seats are not known. Staff found
  // such dates full the next day (live 2026-11-12/16), so the count is left to the consultant instead of implied.
  const unknownSeatsNote = (availability: { seatsLeft: number | null; low?: boolean }) =>
    asksSeats && availability.seatsLeft === null ? " Үлдсэн суудлын тоог аяллын зөвлөх баталгаажуулна." : "";
  let result: TripOfferResult | null = null;
  let needsSelection = false;
  // This turn asked for a date or a window the trip does not depart in. A departed or sold-out
  // date is a listed one and keeps its own wording below.
  const listedDates = new Set(offers.filter((offer) => offer.source !== "discount").flatMap((offer) => offer.dates));
  const askedWindow = !request.date && Boolean(request.range || request.month || request.dates);
  const missedAnchor = request.date && !listedDates.has(request.date) ? request.date
    : askedWindow && !scopedDates.length ? request.range ? midpoint(request.range)
      : request.dates?.[0] || (request.month ? `${request.year || today(now).slice(0, 4)}-${String(request.month).padStart(2, "0")}-15` : null)
      : null;
  const nearest = missedAnchor ? nearestDepartures(dates.filter((date) => dateIsOnSale(trip, date, now)), missedAnchor) : [];
  if (missedAnchor && nearest.length) {
    // The Oct 24 family heard only "not then, here are the dates": the nearest departures
    // are said first, then every other part of the message is answered for them.
    selection.date = null;
    delete selection.dateScope;
    const wantsPrice = request.topics.includes("price");
    result = resolveTripOffer(trip, { date: nearest.length === 1 ? nearest[0] : null, hotel: selection.hotel, packageId: selection.package, passengers: wantsPrice ? pricePassengers : [] }, now);
    if (result.status === "needs_selection" && result.fields[0] === "date") result = { ...result, options: nearest };
    // The asked day is a listed departure staff closed: say that ("2 сарын 15: суудал дүүрсэн."),
    // not "no schedule then" (dev evaluation 2026-11-02). The open departures follow either way.
    const closed = request.date ? websiteAvailability.find((row) => row.date === request.date && departureIsClosed(row)) : null;
    lines.push([closed ? `${mnDate(closed.date)}: ${closedDepartureWording(closed)}` : REQUESTED_TIME_NOT_SCHEDULED, "Ойрын гарах өдрүүд:", ...nearest.map((date) => `• ${mnDate(date)}`)].join("\n"));
    answered.add("availability");
    answered.add("dates");
    if (wantsPrice) {
      // The departures are listed just above, so a fare valid for them does not restate a date.
      const price = result.status === "ready"
        ? renderOfferReplyWithConditions(trip, result, { fareKinds: minorKinds ?? [...(preferences.full || preferences.fareKinds.length || result.offer.passengerPrices.length ? preferences.fareKinds : ["adult", "child"] as const)], showTotal: wantsPartyTotal && !minorsOnly })
          ?.split("\n").filter((line) => line !== mnDate(nearest[0])).join("\n") || null
        : stableFarePreview(trip, { ...selection, passengers: pricePassengers }, result, now, intentText, minorKinds ?? undefined);
      if (price) sections.price = price;
      else if (result.status === "needs_selection") {
        // Fares differ by date: the date is chosen from the departures just listed.
        lines.push("Аль гарах өдрөөр аялах вэ?");
        needsSelection = true;
        answered.add("price");
      }
    }
  } else if (request.topics.includes("price") || request.topics.includes("availability") || request.topics.includes("discount")) {
    const hasDateScope = Boolean(dateScope.month || dateScope.year || dateScope.range || dateScope.dates);
    // A newly requested month overrides an old exact-date selection. Never use
    // October's stored offer to answer a November fare question.
    if (hasDateScope && !request.date && selection.date && !scopedDates.includes(selection.date)) selection.date = null;
    if (hasDateScope && !selection.date && scopedDates.length === 1) selection.date = scopedDates[0];
    // A stated group is checked against the date's seats (never priced here): "open, 12 seats left"
    // answered a 50-person group as if it fit (held-out 2026-11-02).
    const seatParty = request.groupSize ? [{ kind: "adult" as const, count: request.groupSize }] : [];
    result = resolveTripOffer(trip, { date: selection.date, hotel: selection.hotel, packageId: selection.package, passengers: request.topics.includes("price") && pricePassengers.length ? pricePassengers : seatParty }, now);
    if (hasDateScope && !selection.date) {
      if (!scopedDates.length) result = { status: "missing", reason: "requested_schedule_missing" };
      else if (result.status === "needs_selection" && result.fields[0] === "date") result = { ...result, options: result.options.filter((date) => scopedDates.includes(date)) };
    }
    // Offering a sold-out date to choose from ("10 сарын 20", then "суудал дүүрсэн") wastes the
    // customer's turn; the menu lists only dates that can be booked.
    if (result.status === "needs_selection" && result.fields[0] === "date") {
      const bookable = result.options.filter((date) => dateIsOnSale(trip, date, now));
      if (bookable.length && bookable.length < result.options.length) result = { ...result, options: bookable };
    }
    const unavailable = unavailableText(result);
    const recurringFares = result.status === "missing" && result.reason === "departure_date_missing" && recurring.length && !pricePassengers.length
      ? recurringFareLines(trip, preferences.full || preferences.fareKinds.length ? preferences.fareKinds : ["adult", "child"]) : null;
    if (unavailable) {
      sections.availability = unavailable;
      // A closed offer cannot be sold or priced as an available booking.
      if (request.topics.includes("price")) answered.add("price");
    } else if (recurringFares) {
      // "Солмар үнэ хэд вэ" for a trip that leaves every Friday: the fares and the schedule.
      if (request.topics.includes("price")) sections.price = [trip.hotel ? `Буудал: ${trip.hotel}` : null, recurringFares].filter(Boolean).join("\n");
      if (request.topics.includes("availability")) sections.availability = `Гарах өдрүүд: ${recurring.join(", ")}.`;
    } else if (result.status === "ready") {
      if (request.topics.includes("price")) {
        for (const kind of missingRequestedFares(result, preferences.requiredFareKinds, intentText)) missingFact("price", kind);
        const fareKinds = minorKinds ?? (preferences.full || preferences.fareKinds.length || result.offer.passengerPrices.length
          ? preferences.fareKinds : ["adult", "child"] as const);
        const reply = renderOfferReplyWithConditions(trip, result, { fareKinds: [...fareKinds], showTotal: wantsPartyTotal && !minorsOnly });
        // The trip's own hotel line, named (and linked) as every hotel answer names it.
        const tripLevel = !result.offer.hotel && offers.every((offer) => !offer.hotel) && Boolean(trip.hotel);
        const own = tripLevel ? tripHotels(trip, {}, now) : null;
        const baseHotel = !tripLevel ? null : own?.source === "trip" ? own.hotels.map(formatTripHotel).join(", ") : trip.hotel;
        sections.price = reply ? [baseHotel ? `Буудал: ${baseHotel}` : null, reply].filter(Boolean).join("\n") : undefined;
      }
      if (request.topics.includes("availability")) {
        if (result.offer.availability.status === "open") sections.availability = `${mnDate(result.offer.date)}: ${openDateWording(result.offer.availability)}.${unknownSeatsNote(result.offer.availability)}`;
        else if (asksSeats) missingFact("availability", "seats");
        else sections.availability = `${mnDate(result.offer.date)}: гарах хуваарьтай.`;
      }
    } else {
      if (request.topics.includes("availability") && result.status === "missing" && result.reason === "fare_missing" && offers.every((offer) => offer.source === "base")) {
        const date = selection.date || (dates.length === 1 ? dates[0] : null);
        const availability = date ? offers[0]?.availability.find((row) => row.date === date) : null;
        if (availability?.status === "open") sections.availability = `${mnDate(date ?? "")}: ${openDateWording(availability)}.${unknownSeatsNote(availability)}`;
        else if (availability?.status === "unknown") {
          if (asksSeats) missingFact("availability", "seats");
          else sections.availability = `${mnDate(date ?? "")}: гарах хуваарьтай.`;
        }
      }
      // "Is there a <trip>?" is answered with the fare as well as the date question when every date sells at one price.
      const wantsPreview = request.topics.includes("price") ? !request.topics.includes("availability") : request.topics.every((topic) => topic === "availability");
      // A party total depends on the hotel, so that question still asks for one first.
      // Fares that differ by hotel but not by date ("Норвел үнэ"): each hotel's fare is shown
      // before the date is asked, instead of a bare date menu (dev evaluation 2026-11-02).
      const hotelPreview = request.topics.includes("price") && !pricePassengers.length
        ? hotelFarePreview(trip, selection, result, now, intentText) || dateIndependentHotelPreview(trip, selection, result, now, intentText) : null;
      const preview = hotelPreview || (wantsPreview ? stableFarePreview(trip, { ...selection, passengers: pricePassengers }, result, now, intentText, minorKinds ?? undefined) : null);
      if (preview) sections.price = preview;
      if (hotelPreview) {
        answered.add("price");
        if (request.topics.includes("availability")) answered.add("availability");
      }
      const question = selectionQuestion(result, intentText, request.topics.includes("price")
        ? selectionFareQuote(trip, selection, result, now, intentText) : undefined,
      // Only a plain price question: a child or infant fare asked is never answered with the adult one.
      request.topics.includes("price") && !pricePassengers.length && !replyPreferences(intentText).requiredFareKinds.length
        ? (date) => [dateAdultFare(trip, selection, date, now), dateMark(date)].filter(Boolean).join(", ") : dateMark);
      // A seats question with no date ("суудал байна уу") gets the fare and the bookable dates to
      // pick from; it used to get the preview dropped and nothing else, so the bot handed off.
      const availabilityOnly = !request.topics.includes("price");
      // A party total valid for every date still needs a date to book: the total and
      // the bookable dates go out together, so neither has to be asked for again.
      const partyTotal = Boolean(preview) && pricePassengers.length > 0;
      if (question && !hotelPreview && (!preview || availabilityOnly || partyTotal)) {
        if (preview) lines.push(preview);
        lines.push(question);
        needsSelection = true;
        // The specific missing selection is a useful answer, not a staff handoff.
        if (request.topics.includes("price")) answered.add("price");
        if (request.topics.includes("availability")) answered.add("availability");
      }
    }
  }
  // Up to six dates of one trip are listed whole: "хэзээ гарах вэ" got three and "Өөр 2 сонголт бий.", and the
  // customer had to ask again for the dates staff would simply have listed (2026-11-23).
  const datesSection = (list: string[]) => {
    const lines = list.map((date) => {
      const note = dateMark(date);
      return `• ${mnDate(date)}${note ? ` — ${note}` : ""}`;
    });
    return `Гарах өдрүүд:\n${(lines.length <= MAX_LISTED_DATES ? lines : compactReplyOptions(lines, intentText)).join("\n")}`;
  };
  if (request.topics.includes("dates") && !answered.has("dates")) {
    if (needsSelection && result?.status === "needs_selection" && result.fields[0] === "date") answered.add("dates");
    // A weekly schedule is the trip's own text ("Баасан гараг бүр"): it went out as silence when
    // only calendar dates counted (dev evaluation 2026-11-02).
    else sections.dates = scopedDates.length ? datesSection(scopedDates) : recurring.length && !askedWindow ? `Гарах өдрүүд: ${recurring.join(", ")}.` : undefined;
  }
  if (request.topics.includes("duration")) {
    const duration = tripDurationText(trip);
    if (duration) sections.duration = `Хугацаа: ${duration}.`;
  }
  if (request.topics.includes("transport")) {
    if (asksClock) {
      const times = scheduleTimeSection(trip, intentText);
      if (times) sections.transport = times;
      else missingFact("transport", "clock_time");
    } else {
      const transport = tripTransport(trip);
      if (transport) sections.transport = TRANSPORT[transport];
    }
  }
  // A price above already names the hotel(s) as the resolver sells them ("Буудал: …", or a priced
  // offer's own hotel line). The reply checker reads those names to scope the fares under them, so
  // they stay as they are, and the hotel is not named a second, different way in the same message.
  const priceNamesHotel = (said: Array<string | undefined>) => {
    const text = said.filter(Boolean).join("\n");
    const offerHotel = result?.status === "ready" ? result.offer.hotel : null;
    return /(?:^|\n)Буудал:/.test(text) || Boolean(offerHotel && text.split("\n").some((line) => line.trim() === offerHotel));
  };
  if (request.topics.includes("hotel")) {
    if (priceNamesHotel([sections.price, ...lines])) answered.add("hotel");
    else {
      // The same hotels the route-only hotel reply names (tripHotelReply.ts): price-row hotels
      // with their profile name and link, else the trip's own line, else the itinerary's.
      const found = tripHotels(trip, { date: selection.date, hotel: selection.hotel }, now);
      if (found?.source === "trip" && found.hotels.length === 1) sections.hotel = `Буудал: ${formatTripHotel(found.hotels[0])}`;
      else if (found) sections.hotel = `Буудал:\n${compactReplyOptions(found.hotels.map(formatTripHotel), intentText).map((hotel) => `• ${hotel}`).join("\n")}`;
    }
  }
  if (request.topics.includes("includes")) {
    const included = strings(trip.extra.included_items).filter((item) => !preferences.includes.length || preferences.includes.some((target) => target.pattern.test(item)));
    const excluded = strings(trip.extra.excluded_items).filter((item) => !preferences.includes.length || preferences.includes.some((target) => target.pattern.test(item)));
    const foodTarget = preferences.requiredIncludes.find((target) => target.label === "Хоол");
    const foodFallback = foodTarget && ![...included, ...excluded].some((item) => foodTarget.pattern.test(item)) && trip.has_food !== null;
    const unknownTargets = preferences.requiredIncludes.filter((target) => !(target.label === "Хоол" && foodFallback) && ![...included, ...excluded].some((item) => target.pattern.test(item)));
    for (const target of unknownTargets) missingFact("includes", target.label);
    if (included.length || excluded.length || foodFallback) sections.includes = [
      ...(included.length ? ["Үнэд багтсан:", ...included.map((item) => `• ${item}`)] : []),
      ...(excluded.length ? ["Үнэд багтаагүй:", ...excluded.map((item) => `• ${item}`)] : []),
      ...(foodFallback ? [`Хоол: ${trip.has_food ? "багтсан" : "багтаагүй"}.`] : []),
    ].join("\n");
  }
  if (request.topics.includes("booking_terms")) {
    const storedTerms = trip.extra.booking_terms && typeof trip.extra.booking_terms === "object" ? trip.extra.booking_terms as Record<string, unknown> : {};
    const website = trip.extra.website_details && typeof trip.extra.website_details === "object" ? trip.extra.website_details as Record<string, unknown> : {};
    const terms = { ...storedTerms, documents: storedTerms.documents || website.requirements, cancellation: storedTerms.cancellation || website.cancellationPolicy } as Record<string, unknown>;
    const labels: Record<string, string> = { deposit: "Урьдчилгаа", payment: "Төлбөр", documents: "Бичиг баримт", visa: "Виз", cancellation: "Цуцлалт, буцаалт" };
    const requestedTerms = Object.entries(labels).filter(([key]) => !preferences.requiredTermKeys.length || preferences.requiredTermKeys.includes(key as typeof preferences.requiredTermKeys[number]));
    const displayedTerms = Object.entries(labels).filter(([key]) => !preferences.termKeys.length || preferences.termKeys.includes(key as typeof preferences.termKeys[number]));
    const termsLines = displayedTerms.flatMap(([key, label]) => typeof terms[key] === "string" && terms[key] ? [`${label}: ${terms[key]}`] : []);
    for (const [key] of requestedTerms) if (typeof terms[key] !== "string" || !terms[key]) missingFact("booking_terms", key);
    if (termsLines.length) sections.booking_terms = termsLines.join("\n");
  }
  let mediaUrls: string[] = [];
  let brochureUrl: string | null = null;
  if (request.topics.includes("program")) {
    const itinerary = records(trip.extra.itinerary_days).flatMap((day, index) => {
      const text = [day.route, day.title, day.summary, day.description].filter((value): value is string => typeof value === "string" && Boolean(value.trim())).join(" — ");
      return text ? [`${typeof day.day === "number" ? day.day : index + 1}-р өдөр: ${text}`] : [];
    });
    const asset = getTripBrochureAsset(trip);
    const link = getTripWebsiteLink(trip);
    if (!link && asset?.type === "url") brochureUrl = asset.value;
    const askedDay = request.itineraryDay ? itinerary.find((line) => line.startsWith(`${request.itineraryDay}-р өдөр:`)) : null;
    // One day asked: that day only; a day the programme does not list is not answered from guesswork.
    if (request.itineraryDay) { if (askedDay) sections.program = askedDay; else missingFact("program", "day"); }
    else if (itinerary.length || brochureUrl || link) sections.program = [
      ...(preferences.full ? itinerary : link ? [] : itinerary.slice(0, 3)),
      ...(!preferences.full && !link && itinerary.length > 3 ? ["Бүтэн өдөрчилсөн хөтөлбөрийг хүсвэл хэлээрэй."] : []),
      ...(link ? [link] : []), ...(!link && brochureUrl ? [brochureUrl] : []),
    ].join("\n");
  }
  if (request.topics.includes("photos")) {
    const link = getTripWebsiteLink(trip);
    if (link) sections.photos = link;
    else {
      mediaUrls = trip.photo_urls.filter((url) => url.startsWith("https://")).slice(0, preferences.full ? 5 : 3);
      if (mediaUrls.length) sections.photos = "Аяллын зургуудыг хавсаргалаа.";
    }
  }
  if (request.topics.includes("weather")) {
    if (input.weatherReply?.trim() && !isReferReply(input.weatherReply)) sections.weather = input.weatherReply;
    else missingFact("weather", "report");
  }
  if (request.topics.includes("discount")) {
    const discounts = offers.filter((offer) => offer.discount?.active && (!selection.date || !offer.dateScoped || offer.dates.includes(selection.date)) && (!selection.hotel || !offer.hotel || offer.hotel.toLowerCase() === selection.hotel.toLowerCase()));
    const conditions = [...new Set(discounts.flatMap((offer) => offer.discount?.condition ? [offer.discount.condition] : []))];
    if (!discounts.length) sections.discount = "Одоогоор баталгаажсан идэвхтэй хямдралын мэдээлэл алга.";
    else if (conditions.length) sections.discount = `Хямдралын нөхцөл:\n${conditions.map((condition) => `• ${condition}`).join("\n")}\nТанд тохирох нөхцөлийг баталгаажуулсны дараа хямдарсан үнийг тооцно.`;
    else if (result?.status === "ready") sections.discount = "Сонгосон гаралт, буудалд үйлчлэх баталгаажсан хямдралыг үнэд тооцсон.";
  }
  for (const topic of request.topics) if (sections[topic]) { lines.push(sections[topic]!); answered.add(topic); }
  // The customer named a time ("2 сарын 5 хавьцаа", "2 сарын сүүлээр"). An answer that neither
  // asks for a date nor prices one departure says which departures fall in it: the family's
  // fares and programme came back without the dates they asked about (live replay 2026-10-30).
  if (askedWindow && scopedDates.length && !missedAnchor && !needsSelection && !answered.has("dates")
    && result?.status !== "ready" && lines.length) lines.unshift(datesSection(scopedDates));
  // A villa/resort preference: the data holds only the hotel names, so those are given and
  // the preference itself goes to staff with the lead (never inferred from a name).
  let staffLine: string | undefined;
  const staffNotes: string[] = [];
  if (request.lodging && lines.length) {
    const hotels = priceNamesHotel(lines) ? [] : tripHotels(trip, { date: selection.date }, now)?.hotels.map((hotel) => hotel.name) || [];
    if (hotels.length && hotels.length <= 4) lines.push(`Буудал: ${hotels.join(", ")}`);
    staffNotes.push(`Байрлах хүсэлт: ${request.lodging.evidence}`);
    staffLine = `${request.lodging.dative.charAt(0).toUpperCase()}${request.lodging.dative.slice(1)} байрлах хүсэлтийг тань аяллын зөвлөхөд дамжууллаа.`;
    lines.push(staffLine);
  }
  // A group of ten or more: its total, discount and seats are arranged by staff; the lead carries it.
  if (request.groupSize && lines.length && !staffLine) {
    staffNotes.push(`Групп: ${request.groupSize} хүн`);
    staffLine = `${request.groupSize} хүний группийн суудал, нийт үнийг аяллын зөвлөхөд дамжууллаа.`;
    lines.push(staffLine);
  }
  if (minorsOnly && sections.price && !needsSelection) {
    lines.push(ADULT_COUNT_QUESTION);
    needsSelection = true;
  }
  // A trip new to the conversation is named: the customer may not know which one is meant.
  if (route.newTrip && lines.length && !lines[0].includes(trip.route_name)) lines.unshift(trip.route_name);
  for (const topic of incomplete.keys()) answered.delete(topic);
  let missing = request.topics.filter((topic) => !answered.has(topic));
  // A topic only the understanding model read (nothing in the customer's words asks it) does not
  // silence an answer that covers every topic the words do ask: "юу багтдаг вэ" read as
  // "includes + programme" went silent for a trip with no programme data (dev 2026-11-02). A
  // topic the words ask and the data lacks still hands off, as the owner's rule requires.
  if (route.understanding && answered.size && missing.length) {
    const ownTopics = new Set(buildTripRequest(requestText, trips, undefined, now).topics);
    if (asksAboutTripItem(intentText, trip)) ownTopics.add("includes");
    if (missing.every((topic) => !ownTopics.has(topic))) {
      const dropped = new Set(missing);
      request.topics = request.topics.filter((topic) => !dropped.has(topic));
      for (const topic of dropped) incomplete.delete(topic);
      missing = [];
    }
  }
  const missingFacts = [...new Set(missing.flatMap((topic) => incomplete.get(topic) || [topic]))];
  const handoff = missing.length > 0;
  return {
    status: handoff ? "handoff" : needsSelection ? "clarify" : "answered",
    tripId: trip.id, selection, request, reply: handoff ? "REFER" : presentAssistantReply({ reply: [...new Set(lines)].join("\n\n"), userText: intentText }),
    offer: result, answeredTopics: [...answered], missingTopics: missing, missingFacts,
    mediaUrls: handoff ? [] : mediaUrls, brochureUrl: handoff ? null : brochureUrl,
    ...(staffLine && !handoff ? { staffNotes, staffLine } : {}),
  };
}

/**
 * "9 өдөр 8 шөнө". The answer plan said "Хугацаа: 9 өдөр." and dropped the nights
 * the trip card and the website both show (2026-11-05). The days are always the
 * ones the reply checker reads (tripDurationDays); the nights come from the stored
 * count or the trip's own wording, and are left out when the two disagree. The
 * trip's wording is kept as written when it says nothing but the duration.
 */
export function tripDurationText(trip: TravelTrip): string | null {
  const days = tripDurationDays(trip);
  if (days === null) return null;
  const text = (trip.duration_text || "").replace(/\s+/g, " ").trim();
  const textDays = /(\d{1,2})\s*(?:өдөр|хоног)/i.exec(text);
  const textNightsMatch = /(\d{1,2})\s*шөнө/i.exec(text);
  // Nights written beside a different day count belong to a different reading.
  const textNights = textNightsMatch && (!textDays || Number(textDays[1]) === days) ? Number(textNightsMatch[1]) : null;
  const rawStored = trip.extra?.duration_nights;
  const stored = typeof rawStored === "number" && Number.isInteger(rawStored) && rawStored >= 0 && rawStored <= days ? rawStored : null;
  const nights = stored !== null && textNights !== null && stored !== textNights ? null : stored ?? (textNights !== null && textNights <= days ? textNights : null);
  const onlyDuration = /^\d{1,2}\s*(?:өдөр|хоног)(?:\s*[/,·-]?\s*\d{1,2}\s*шөнө)?$/i.test(text);
  if (onlyDuration && textDays && Number(textDays[1]) === days && (textNightsMatch ? textNights === nights : nights === null)) return text;
  return nights !== null ? `${days} өдөр ${nights} шөнө` : `${days} өдөр`;
}

function midpoint([start, end]: [string, string]): string {
  return new Date((Date.parse(`${start}T00:00:00Z`) + Date.parse(`${end}T00:00:00Z`)) / 2).toISOString().slice(0, 10);
}

/** The departures closest to the asked date, in calendar order. */
function nearestDepartures(dates: string[], anchor: string): string[] {
  const at = Date.parse(`${anchor}T00:00:00Z`);
  return [...dates].sort((a, b) => Math.abs(Date.parse(`${a}T00:00:00Z`) - at) - Math.abs(Date.parse(`${b}T00:00:00Z`) - at) || a.localeCompare(b))
    .slice(0, NEAREST_DEPARTURES).sort();
}
