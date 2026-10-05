import { websiteTripToCanonicalFields } from "./websiteTripBridge";
import { duration } from "./connectedTripMapping";

type Row = Record<string, unknown>;

export function parityRecord(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

export function hasParityValue(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.values(value).some(hasParityValue);
  return true;
}

function canonical(value: unknown): unknown {
  if (typeof value === "string") return value.trim().replace(/\r\n/g, "\n");
  if (value === undefined || value === null || value === "") return null;
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}

export function sameParityValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export function auditFaqParity(websiteValue: unknown, chatbotValue: unknown) {
  const rows = (value: unknown) => (Array.isArray(value) ? value : []).map(parityRecord).map(row => ({
    question: String(row.question || row.q || "").trim(), answer: String(row.answer || row.a || "").trim(),
  })).filter(row => row.question);
  const website = rows(websiteValue);
  const chatbot = rows(chatbotValue);
  const key = (question: string) => question.toLocaleLowerCase().replace(/\s+/g, " ").trim();
  return { websiteCount: website.length, chatbotCount: chatbot.length,
    websiteQuestionsWithoutExactChatbotMatch: website.filter(item => !chatbot.some(other => key(item.question) === key(other.question))),
    chatbotQuestionsWithoutExactWebsiteMatch: chatbot.filter(item => !website.some(other => key(item.question) === key(other.question))),
    conflictingExactQuestions: website.flatMap(item => chatbot.filter(other => key(item.question) === key(other.question) && !sameParityValue(item.answer, other.answer))
      .map(other => ({ question: item.question, websiteAnswer: item.answer, chatbotAnswer: other.answer }))),
  };
}

// These are not copied by the website -> chatbot bridge. Some are deliberately
// presentation-only; the audit inventories them without guessing equivalence.
export const websiteSeparateFields = [
  "slug", "country", "city", "region", "destinations", "meetingPoint", "latitude", "longitude", "mapUrl",
  "minTravelers", "maxTravelers", "difficulty", "transport", "languages", "season", "highlights", "requirements",
  "cancellationPolicy", "video", "videos", "oldPrice", "discount", "singleSupplement", "extraFees", "roomPrices",
  "childPriceNotes", "hotelMedia", "travelerMedia", "weather", "categoryId", "categories", "tags", "isFeatured",
  "salesCount", "avgRating", "reviewCount",
] as const;

export const chatbotSeparateFields = [
  "aliases", "discounts", "extra_fees", "room_prices", "booking_terms", "answer_hints", "source_provenance",
  "needs_human_review", "review_reasons", "marketing_badge", "transport_type", "destinations",
] as const;

export type ParityDifference = {
  websiteField: string;
  chatbotField: string;
  kind: "different" | "website_only_value" | "chatbot_only_value";
  websiteValue: unknown;
  chatbotValue: unknown;
};

function itineraryFacts(value: unknown) {
  return (Array.isArray(value) ? value : []).map(parityRecord).map((day, index) => ({
    day: Number(day.day) || index + 1,
    title: day.title || "", description: day.description || "", hotel: day.hotel || "",
    meals: { breakfast: parityRecord(day.meals).breakfast === true, lunch: parityRecord(day.meals).lunch === true, dinner: parityRecord(day.meals).dinner === true },
  }));
}

export function auditTripPair(website: Row, chatbot: Row, poster: Row = {}) {
  const fields = websiteTripToCanonicalFields(website).fields;
  const extra = parityRecord(chatbot.extra);
  const expectedExtra = parityRecord(fields.extra);
  const direct = [
    ["title", "route_name"], ["description", "notes"],
    ["hotel", "hotel"], ["foodIncluded", "has_food"], ["durationDays/durationNights", "duration_text"],
    ["currency", "currency"], ["image/extraImages", "photo_urls"],
  ];
  const structured = [
    ["summary", "website_summary"], ["included", "included_items"], ["excluded", "excluded_items"],
    ["importantNotes", "important_notes"], ["departureRule", "departure_rule"],
    ["itinerary", "itinerary_days"],
  ];
  const differences: ParityDifference[] = [];
  for (const [websiteField, chatbotField] of [...direct, ...structured]) {
    const isExtra = structured.some(pair => pair[1] === chatbotField);
    let websiteValue = isExtra ? expectedExtra[chatbotField] : (fields as Row)[chatbotField];
    let chatbotValue = isExtra ? extra[chatbotField] : chatbot[chatbotField];
    if (chatbotField === "duration_text") {
      websiteValue = { days: website.durationDays, nights: website.durationNights };
      const parsed = duration(String(chatbot.duration_text || ""));
      chatbotValue = { days: extra.duration_days ?? parsed.days, nights: extra.duration_nights ?? parsed.nights };
    }
    if (chatbotField === "notes") chatbotValue = chatbot.notes || poster.subtitle || chatbot.route_name;
    if (chatbotField === "itinerary_days") {
      websiteValue = itineraryFacts(websiteValue);
      chatbotValue = itineraryFacts(chatbotValue);
    }
    if (sameParityValue(websiteValue, chatbotValue)) continue;
    if (!hasParityValue(websiteValue) && !hasParityValue(chatbotValue)) continue;
    differences.push({ websiteField, chatbotField,
      kind: !hasParityValue(chatbotValue) ? "website_only_value" : !hasParityValue(websiteValue) ? "chatbot_only_value" : "different",
      websiteValue: websiteValue ?? null, chatbotValue: chatbotValue ?? null });
  }
  const scalarFares = ["adult_price", "child_price", "infant_price"];
  const fareDifferences = scalarFares.filter(key => !sameParityValue((fields as Row)[key], chatbot[key]))
    .map(key => ({ field: key, websiteValue: (fields as Row)[key] ?? null, chatbotValue: chatbot[key] ?? null,
      review: "Display fare versus canonical offers; not an automatic overwrite." }));
  const websiteFields = websiteSeparateFields.filter(key => hasParityValue(website[key]));
  const chatbotFields = chatbotSeparateFields.filter(key => hasParityValue(extra[key]));
  const customerTextNotStoredInCanonical = [
    { websiteField: "description", value: website.description, candidates: [chatbot.notes, chatbot.source_description, chatbot.route_name] },
    { websiteField: "summary", value: website.summary, candidates: [extra.website_summary, chatbot.source_description] },
  ].filter(item => hasParityValue(item.value) && !item.candidates.some(candidate => sameParityValue(item.value, candidate)))
    .map(item => ({ websiteField: item.websiteField, websiteValue: item.value,
      explanation: "May be generated from the poster, but is not stored as this customer text in the canonical trip. Projection equality is not answer-context equality." }));
  return { websiteId: website.id, sourceTripId: website.sourceTripId, slug: website.slug, title: website.title,
    published: website.isPublished, differences, fareDifferences,
    customerTextNotStoredInCanonical,
    importSourceDescription: chatbot.source_description,
    websiteSaveWouldReplaceImportSource: !sameParityValue(fields.source_description, chatbot.source_description),
    websiteSeparateValues: Object.fromEntries(websiteFields.map(key => [key, website[key]])),
    chatbotSeparateValues: Object.fromEntries(chatbotFields.map(key => [key, extra[key]])),
    itineraryDetailsNotRepresented: (Array.isArray(website.itinerary) ? website.itinerary : [])
      .filter(day => hasParityValue(parityRecord(day).location) || hasParityValue(parityRecord(day).video) || hasParityValue(parityRecord(day).image))
      .map(day => { const row = parityRecord(day); return { dayNumber: row.dayNumber, location: row.location, video: row.video, image: row.image }; }),
    websiteSaveResetsCanonicalSeats: hasParityValue(chatbot.seats_total) || hasParityValue(chatbot.seats_left),
  };
}
