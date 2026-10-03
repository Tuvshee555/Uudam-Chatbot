import type { TravelTrip } from "./travelTypes";
import type { FastPathRoute } from "./fastPathRouting";
import { buildTripRequest, mergeTripSelection, type TripRequest, type TripSelection, type TripTopic } from "./tripRequest";
import { normalizeTripOffers, resolveTripOffer, resolveTripOfferFareCard, renderTripOfferReply, type TripOfferResult } from "./tripOffers";
import { evaluateTripRequirement, tripTransport, type TripRequirement } from "./tripFacts";
import { tripDurationDays, getTripBrochureAsset, getTripWebsiteLink } from "./travelFastPathsSearch";
import { departureAvailability, departureIsClosed } from "./departureAvailability";

export type TripAnswerPlan = {
  status: "answered" | "clarify" | "handoff";
  tripId: string;
  selection: TripSelection;
  request: TripRequest;
  reply: string;
  offer: TripOfferResult | null;
  answeredTopics: TripTopic[];
  missingTopics: TripTopic[];
  mediaUrls: string[];
  brochureUrl: string | null;
};

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")) : [];
const today = (now: Date) => new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
const TRANSPORT = { direct_flight: "Шууд нислэгтэй аялал.", land: "Газрын аялал.", land_flight: "Газар + нислэг хосолсон аялал.", cruise: "Усан онгоцны аялал." };

function selectionQuestion(result: TripOfferResult): string | null {
  if (result.status !== "needs_selection") return null;
  const field = result.fields[0];
  const question = field === "date" ? "Аль гарах өдрөөр аялах вэ?"
    : field === "hotel" ? "Аль буудлын хувилбарыг сонгох вэ?"
      : field === "package" ? "Аль багцыг сонгох вэ?"
        : field === "passengers" ? "Хүүхэд тус бүрийн насыг хэлнэ үү."
          : "Хямдралын нөхцөл танд тохирох эсэхийг тодруулна уу.";
  return [question, ...result.options.slice(0, 8).map((option) => `• ${option}`)].join("\n");
}

function unavailableText(result: TripOfferResult): string | null {
  if (result.status !== "unavailable") return null;
  const date = result.date ? `${result.date}: ` : "";
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

function stableFarePreview(trip: TravelTrip, selection: TripSelection, result: TripOfferResult, now: Date): string | null {
  if (selection.passengers.length || result.status !== "needs_selection" || result.fields[0] !== "date") return null;
  const cards = result.options.map((date) => resolveTripOfferFareCard(trip, { date, hotel: selection.hotel, packageId: selection.package }, now));
  const signature = (card: TripOfferResult) => card.status === "ready" ? JSON.stringify({
    hotel: card.offer.hotel, package: card.offer.packageId, currency: card.offer.currency,
    fares: card.offer.fares.map((fare) => ({ kind: fare.kind, ageRange: fare.ageRange, fare: fare.fare })),
  }) : null;
  if (!cards.length || !signature(cards[0]) || cards.some((card) => signature(card) !== signature(cards[0]))) return null;
  const first = cards[0];
  if (first.status !== "ready") return null;
  return renderTripOfferReply(first)?.split("\n").filter((line) => line !== first.offer.date).join("\n") || null;
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
  const request = buildTripRequest(input.text, trips, route.understanding, now);
  if (!request.topics.length || request.topics.some((topic) => ["comparison", "budget"].includes(topic))) return null;
  if (request.topics.includes("weather") && !input.weatherReply) return null;
  const selection = mergeTripSelection(trip.id, request, route.selection || null);
  const requirements: TripRequirement[] = [];
  if (request.days) requirements.push({ kind: "days", days: request.days });
  if (route.understanding?.transport) requirements.push({ kind: "transport", transport: route.understanding.transport });
  const failed = requirements.find((requirement) => evaluateTripRequirement(trip, requirement, now) !== "match");
  if (failed) {
    return {
      status: "clarify", tripId: trip.id, selection, request, offer: null,
      reply: failed.kind === "days" ? `«${trip.route_name}» аяллын хугацаа: ${trip.duration_text || "аяллын зөвлөхөөс тодруулна"}. Таны хүссэн хоногт тохирох хувилбарыг тодруулах уу?`
        : `«${trip.route_name}» аяллын тээврийн төрөл таны хүсэлттэй таарах эсэхийг аяллын зөвлөхөөс тодруулъя.`,
      answeredTopics: [], missingTopics: request.topics, mediaUrls: [], brochureUrl: null,
    };
  }
  const lines = [trip.route_name];
  const answered = new Set<TripTopic>();
  const offers = normalizeTripOffers(trip, now);
  const dates = [...new Set(offers.filter((offer) => offer.source !== "discount").flatMap((offer) => offer.dates))].filter((date) => date >= today(now)).sort();
  const websiteAvailability = departureAvailability(trip);
  const sections: Partial<Record<TripTopic, string>> = {};
  let result: TripOfferResult | null = null;
  let needsSelection = false;
  if (request.topics.includes("price") || request.topics.includes("availability") || request.topics.includes("discount")) {
    result = resolveTripOffer(trip, { date: selection.date, hotel: selection.hotel, packageId: selection.package, passengers: request.topics.includes("price") ? selection.passengers : [] }, now);
    const unavailable = unavailableText(result);
    if (unavailable) {
      sections.availability = unavailable;
      // A closed offer cannot be sold or priced as an available booking.
      if (request.topics.includes("price")) answered.add("price");
    } else if (result.status === "ready") {
      if (request.topics.includes("price")) sections.price = renderTripOfferReply(result) || undefined;
      if (request.topics.includes("availability")) {
        sections.availability = result.offer.availability.status === "open"
          ? `${result.offer.date}: захиалга нээлттэй${result.offer.availability.seatsLeft !== null ? `, ${result.offer.availability.seatsLeft} суудал үлдсэн` : ""}.`
          : `${result.offer.date}: гарах хуваарьтай. Суудлын үлдэгдлийг аяллын зөвлөхөөс тодруулна уу.`;
      }
    } else {
      if (request.topics.includes("availability") && result.status === "missing" && result.reason === "fare_missing" && offers.every((offer) => offer.source === "base")) {
        const date = selection.date || (dates.length === 1 ? dates[0] : null);
        const availability = date ? offers[0]?.availability.find((row) => row.date === date) : null;
        if (availability && ["open", "unknown"].includes(availability.status)) sections.availability = availability.status === "open"
          ? `${date}: захиалга нээлттэй${availability.seatsLeft !== null ? `, ${availability.seatsLeft} суудал үлдсэн` : ""}.`
          : `${date}: гарах хуваарьтай. Суудлын үлдэгдлийг аяллын зөвлөхөөс тодруулна уу.`;
      }
      const preview = request.topics.includes("price") && !request.topics.includes("availability") ? stableFarePreview(trip, selection, result, now) : null;
      if (preview) sections.price = preview;
      const question = selectionQuestion(result);
      if (question && !preview) {
        lines.push(question);
        needsSelection = true;
        // The specific missing selection is a useful answer, not a staff handoff.
        if (request.topics.includes("price")) answered.add("price");
        if (request.topics.includes("availability")) answered.add("availability");
      }
    }
  }
  if (request.topics.includes("dates")) {
    sections.dates = dates.length ? `Гарах өдрүүд:\n${dates.slice(0, 10).map((date) => {
      const row = websiteAvailability.find((entry) => entry.date === date);
      return `• ${date}${row && departureIsClosed(row) ? " — захиалга хаалттай" : ""}`;
    }).join("\n")}` : undefined;
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
    if (hotels.length) sections.hotel = `Буудал:\n${hotels.map((hotel) => `• ${hotel}`).join("\n")}`;
    else if (trip.hotel && !selection.hotel && !selection.date) sections.hotel = `Буудал: ${trip.hotel}`;
  }
  if (request.topics.includes("includes")) {
    const included = strings(trip.extra.included_items);
    const excluded = strings(trip.extra.excluded_items);
    const askedFood = /хоол|food|meal|hool/i.test(input.text);
    if (included.length || excluded.length || (askedFood && trip.has_food !== null)) sections.includes = [
      ...(included.length ? ["Үнэд багтсан:", ...included.map((item) => `• ${item}`)] : []),
      ...(excluded.length ? ["Үнэд багтаагүй:", ...excluded.map((item) => `• ${item}`)] : []),
      ...(!included.length && !excluded.length && askedFood && trip.has_food !== null ? [`Хоол: ${trip.has_food ? "багтсан" : "багтаагүй"}.`] : []),
    ].join("\n");
  }
  if (request.topics.includes("booking_terms")) {
    const terms = trip.extra.booking_terms && typeof trip.extra.booking_terms === "object" ? trip.extra.booking_terms as Record<string, unknown> : {};
    const labels: Record<string, string> = { deposit: "Урьдчилгаа", payment: "Төлбөр", documents: "Бичиг баримт", visa: "Виз", cancellation: "Цуцлалт, буцаалт" };
    const termsLines = Object.entries(labels).flatMap(([key, label]) => typeof terms[key] === "string" && terms[key] ? [`${label}: ${terms[key]}`] : []);
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
    if (itinerary.length || brochureUrl || link) sections.program = [...itinerary.slice(0, 12), ...(link ? [link] : []), ...(!link && brochureUrl ? [brochureUrl] : [])].join("\n");
  }
  if (request.topics.includes("photos")) {
    const link = getTripWebsiteLink(trip);
    if (link) sections.photos = link;
    else {
      mediaUrls = trip.photo_urls.filter((url) => url.startsWith("https://")).slice(0, 5);
      if (mediaUrls.length) sections.photos = "Аяллын зургуудыг хавсаргалаа.";
    }
  }
  if (request.topics.includes("weather")) sections.weather = input.weatherReply;
  if (request.topics.includes("discount")) {
    const discounts = offers.filter((offer) => offer.discount?.active && (!selection.date || !offer.dateScoped || offer.dates.includes(selection.date)) && (!selection.hotel || !offer.hotel || offer.hotel.toLowerCase() === selection.hotel.toLowerCase()));
    const conditions = [...new Set(discounts.flatMap((offer) => offer.discount?.condition ? [offer.discount.condition] : []))];
    if (!discounts.length) sections.discount = "Одоогоор баталгаажсан идэвхтэй хямдралын мэдээлэл алга.";
    else if (conditions.length) sections.discount = `Хямдралын нөхцөл:\n${conditions.map((condition) => `• ${condition}`).join("\n")}\nТанд тохирох нөхцөлийг баталгаажуулсны дараа хямдарсан үнийг тооцно.`;
    else if (result?.status === "ready") sections.discount = "Сонгосон гаралт, буудалд үйлчлэх баталгаажсан хямдралыг үнэд тооцсон.";
  }
  for (const topic of request.topics) if (sections[topic]) { lines.push(sections[topic]!); answered.add(topic); }
  const missing = request.topics.filter((topic) => !answered.has(topic));
  if (missing.length && answered.size) lines.push("Үлдсэн асуултын баталгаатай мэдээлэл одоогоор алга. Аяллын зөвлөхөөс тодруулах шаардлагатай.");
  return {
    status: answered.size === 0 ? "handoff" : needsSelection ? "clarify" : "answered",
    tripId: trip.id, selection, request, reply: answered.size ? [...new Set(lines)].join("\n\n") : "REFER",
    offer: result, answeredTopics: [...answered], missingTopics: missing, mediaUrls, brochureUrl,
  };
}
