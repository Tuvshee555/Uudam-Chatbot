import type { TravelTrip } from "./travelTypes";
import type { FastPathRoute } from "./fastPathRouting";
import { buildTripRequest, mergeTripSelection, type TripRequest, type TripSelection, type TripTopic } from "./tripRequest";
import { normalizeTripOffers, resolveTripOffer, resolveTripOfferFareCard, renderTripOfferReply, type TripOfferResult } from "./tripOffers";
import { evaluateTripRequirement, tripTransport, type TripRequirement } from "./tripFacts";
import { tripDurationDays, getTripBrochureAsset, getTripWebsiteLink } from "./travelFastPathsSearch";
import { departureAvailability, departureIsClosed, departureIsLow, openDateWording } from "./departureAvailability";
import { compactReplyOptions, presentAssistantReply, replyPreferences } from "./chatbotReplyPolicy";
import { stripTripNamesForIntent } from "./customerTurn";
import { isOptionalExtrasQuestion } from "./tripExtrasReply";
import { customerDate as mnDate } from "./customerDate";
import { dateIsOnSale } from "./tripFareBlock";
import { hasSeatsIntent } from "./travelFastPaths";
import { isReferReply } from "./reply";
import { ADULT_COUNT_QUESTION } from "./selectionAnswer";

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
};

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")) : [];
const today = (now: Date) => new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
const TRANSPORT = { direct_flight: "Шууд нислэгтэй аялал.", land: "Газрын аялал.", land_flight: "Газар + нислэг хосолсон аялал.", cruise: "Усан онгоцны аялал." };

function selectionQuestion(result: TripOfferResult, text: string, quote?: (option: string) => string | null): string | null {
  if (result.status !== "needs_selection") return null;
  const field = result.fields[0];
  const question = field === "date" ? "Аль гарах өдрөөр аялах вэ?"
    : field === "hotel" ? "Аль буудлын хувилбарыг сонгох вэ?"
      : field === "package" ? "Аль багцыг сонгох вэ?"
        : field === "passengers" ? "Хүүхэд тус бүрийн насыг хэлнэ үү."
          : "Хямдралын нөхцөл танд тохирох эсэхийг тодруулна уу.";
  return [question, ...compactReplyOptions(result.options, text).map((option) => {
    const price = result.options.includes(option) ? quote?.(option) : null;
    return `• ${field === "date" ? mnDate(option) : option}${price ? `\n${price}` : ""}`;
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
    return renderTripOfferReply(card, { fareKinds: [...fareKinds], showTotal: false })?.split("\n")
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

function stableFarePreview(trip: TravelTrip, selection: TripSelection, result: TripOfferResult, now: Date, text: string): string | null {
  if (result.status !== "needs_selection" || result.fields[0] !== "date") return null;
  if (selection.passengers.length) return stablePartyTotal(trip, selection, result.options, now, text);
  const cards = result.options.map((date) => resolveTripOfferFareCard(trip, { date, hotel: selection.hotel, packageId: selection.package }, now));
  const { fareKinds, requiredFareKinds } = replyPreferences(text);
  if (cards.some(card => missingRequestedFares(card, requiredFareKinds).length)) return null;
  const signature = (card: TripOfferResult) => card.status === "ready" ? JSON.stringify({
    hotel: card.offer.hotel, package: card.offer.packageId, currency: card.offer.currency,
    conditions: [...card.offer.conditions].sort(),
    fares: card.offer.fares.filter((fare) => !fareKinds.length || fareKinds.includes(fare.kind)).map((fare) => ({ kind: fare.kind, ageRange: fare.ageRange, fare: fare.fare })),
  }) : null;
  if (!cards.length || !signature(cards[0]) || cards.some((card) => signature(card) !== signature(cards[0]))) return null;
  const first = cards[0];
  if (first.status !== "ready") return null;
  return renderTripOfferReply(first, { fareKinds })?.split("\n").filter((line) => line !== mnDate(first.offer.date)).join("\n") || null;
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
  return renderTripOfferReply(first, { fareKinds: replyPreferences(text).fareKinds, showTotal: true })
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
      const body = renderTripOfferReply(card, { fareKinds })?.split("\n").filter((line) => line !== mnDate(card.offer.date) && !/^Буудал:/.test(line) && ![hotel, packageId, `${hotel} · ${packageId}`].includes(line.trim())).join("\n");
      if (!body) return null;
      blocks.push(`Буудал: ${hotel}${packageId ? ` · ${packageId}` : ""}\n${body}`);
    }
  }
  if (blocks.length > 4) return null;
  return blocks.length ? [mnDate(selection.date), ...blocks].join("\n\n") : null;
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
  const sections: Partial<Record<TripTopic, string>> = {};
  const incomplete = new Map<TripTopic, string[]>();
  const missingFact = (topic: TripTopic, field: string) => incomplete.set(topic, [...(incomplete.get(topic) || []), `${topic}.${field}`]);
  const asksSeats = hasSeatsIntent(intentText);
  let result: TripOfferResult | null = null;
  let needsSelection = false;
  if (request.topics.includes("price") || request.topics.includes("availability") || request.topics.includes("discount")) {
    const hasDateScope = Boolean(dateScope.month || dateScope.year || dateScope.range || dateScope.dates);
    // A newly requested month overrides an old exact-date selection. Never use
    // October's stored offer to answer a November fare question.
    if (hasDateScope && !request.date && selection.date && !scopedDates.includes(selection.date)) selection.date = null;
    if (hasDateScope && !selection.date && scopedDates.length === 1) selection.date = scopedDates[0];
    result = resolveTripOffer(trip, { date: selection.date, hotel: selection.hotel, packageId: selection.package, passengers: request.topics.includes("price") ? pricePassengers : [] }, now);
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
    if (unavailable) {
      sections.availability = unavailable;
      // A closed offer cannot be sold or priced as an available booking.
      if (request.topics.includes("price")) answered.add("price");
    } else if (result.status === "ready") {
      if (request.topics.includes("price")) {
        for (const kind of missingRequestedFares(result, preferences.requiredFareKinds, intentText)) missingFact("price", kind);
        const fareKinds = preferences.full || preferences.fareKinds.length || result.offer.passengerPrices.length
          ? preferences.fareKinds : ["adult", "child"] as const;
        const reply = renderTripOfferReply(result, { fareKinds: [...fareKinds], showTotal: wantsPartyTotal && !minorsOnly });
        const baseHotel = !result.offer.hotel && offers.every((offer) => !offer.hotel) && trip.hotel;
        sections.price = reply ? [baseHotel ? `Буудал: ${baseHotel}` : null, reply].filter(Boolean).join("\n") : undefined;
      }
      if (request.topics.includes("availability")) {
        if (result.offer.availability.status === "open") sections.availability = `${mnDate(result.offer.date)}: ${openDateWording(result.offer.availability)}.`;
        else if (asksSeats) missingFact("availability", "seats");
        else sections.availability = `${mnDate(result.offer.date)}: гарах хуваарьтай.`;
      }
    } else {
      if (request.topics.includes("availability") && result.status === "missing" && result.reason === "fare_missing" && offers.every((offer) => offer.source === "base")) {
        const date = selection.date || (dates.length === 1 ? dates[0] : null);
        const availability = date ? offers[0]?.availability.find((row) => row.date === date) : null;
        if (availability?.status === "open") sections.availability = `${mnDate(date ?? "")}: ${openDateWording(availability)}.`;
        else if (availability?.status === "unknown") {
          if (asksSeats) missingFact("availability", "seats");
          else sections.availability = `${mnDate(date ?? "")}: гарах хуваарьтай.`;
        }
      }
      // "Is there a <trip>?" is answered with the fare as well as the date question when every date sells at one price.
      const wantsPreview = request.topics.includes("price") ? !request.topics.includes("availability") : request.topics.every((topic) => topic === "availability");
      // A party total depends on the hotel, so that question still asks for one first.
      const hotelPreview = request.topics.includes("price") && !pricePassengers.length ? hotelFarePreview(trip, selection, result, now, intentText) : null;
      const preview = hotelPreview || (wantsPreview ? stableFarePreview(trip, { ...selection, passengers: pricePassengers }, result, now, intentText) : null);
      if (preview) sections.price = preview;
      if (hotelPreview) {
        answered.add("price");
        if (request.topics.includes("availability")) answered.add("availability");
      }
      const question = selectionQuestion(result, intentText, request.topics.includes("price")
        ? selectionFareQuote(trip, selection, result, now, intentText) : undefined);
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
  if (request.topics.includes("dates")) {
    if (needsSelection && result?.status === "needs_selection" && result.fields[0] === "date") answered.add("dates");
    else sections.dates = scopedDates.length ? `Гарах өдрүүд:\n${compactReplyOptions(scopedDates.map((date) => {
      const row = websiteAvailability.find((entry) => entry.date === date);
      return `• ${mnDate(date)}${row && departureIsClosed(row) ? " — захиалга хаалттай" : row && departureIsLow(row) ? " — цөөн суудал" : ""}`;
    }), intentText).join("\n")}` : undefined;
  }
  if (request.topics.includes("duration")) {
    const days = tripDurationDays(trip);
    if (days !== null) sections.duration = `Хугацаа: ${days} өдөр.`;
  }
  if (request.topics.includes("transport")) {
    const transport = tripTransport(trip);
    if (transport) sections.transport = TRANSPORT[transport];
  }
  if (request.topics.includes("hotel")) {
    const hotels = [...new Set(offers.filter((offer) => (!selection.date || !offer.dateScoped || offer.dates.includes(selection.date)) && (!selection.hotel || offer.hotel?.toLowerCase() === selection.hotel.toLowerCase())).map((offer) => offer.hotel).filter((hotel): hotel is string => Boolean(hotel)))];
    if (hotels.length) sections.hotel = `Буудал:\n${compactReplyOptions(hotels, intentText).map((hotel) => `• ${hotel}`).join("\n")}`;
    else if (trip.hotel && (!selection.hotel || selection.hotel.trim().toLowerCase() === trip.hotel.trim().toLowerCase())
      && offers.every((offer) => !offer.hotel && !offer.hotelId)) sections.hotel = `Буудал: ${trip.hotel}`;
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
    if (itinerary.length || brochureUrl || link) sections.program = [
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
  if (minorsOnly && sections.price && !needsSelection) {
    lines.push(ADULT_COUNT_QUESTION);
    needsSelection = true;
  }
  // Read from old turns only: say which trip, the customer may be back after weeks.
  if (route.fromHistory && lines.length) lines.unshift(trip.route_name);
  for (const topic of incomplete.keys()) answered.delete(topic);
  const missing = request.topics.filter((topic) => !answered.has(topic));
  const missingFacts = [...new Set(missing.flatMap((topic) => incomplete.get(topic) || [topic]))];
  const handoff = missing.length > 0;
  return {
    status: handoff ? "handoff" : needsSelection ? "clarify" : "answered",
    tripId: trip.id, selection, request, reply: handoff ? "REFER" : presentAssistantReply({ reply: [...new Set(lines)].join("\n\n"), userText: intentText }),
    offer: result, answeredTopics: [...answered], missingTopics: missing, missingFacts,
    mediaUrls: handoff ? [] : mediaUrls, brochureUrl: handoff ? null : brochureUrl,
  };
}
