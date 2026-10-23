/**
 * What the overview tells the owner about the bot's answers: why it stayed silent, what it
 * was asked and could not answer, and which topics the trip data covers. The bot answers only
 * from the trip data (owner's rule), so a topic with no data is a topic it stays silent on.
 * Pure functions over stored records; no customer identity is read or returned.
 */
import type { CoverageTopic, SilenceReason } from "./adminAnalyticsTypes";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const filled = (value: unknown) => typeof value === "string" ? value.trim().length > 0 : list(value).some((item) => typeof item === "string" ? item.trim() : Boolean(item));

/**
 * A staff hand-off's stored context says why the bot did not answer. The texts are the
 * system's own (webhook / attachment pipeline), so they classify reliably.
 */
export function classifySilence(context: string, customerMessage: string): SilenceReason {
  const text = context.toLowerCase();
  if (/ai түр саатсан|ai_outage/.test(text)) return "ai_outage";
  if (/дуут мессеж|аяллын зураг илгээсэн/.test(text)) return "media";
  // Asked for the bank account, or said the money was sent.
  if (/дансны мэдээлэл|төлбөр|payment_claim/.test(text)) return "payment";
  if (/structured_trip_not_found|not_in_catalog/.test(text)) return "not_found";
  if (/sold_out/.test(text)) return "sold_out";
  // A reply naming a trip the chat never mentioned (or the AI's answer about another trip),
  // or a bare number with no open list.
  if (/дурдагдаагүй аялал|өөр аяллын|ungrounded|bare_number/.test(text)) return "unclear_trip";
  // "????" alone: the customer is waiting for someone, not asking for missing data.
  if (/punctuation_only/.test(text)) return "asked_person";
  // The explicit hand-off branch stores no context: the customer asked for a person.
  if (!text.trim()) return customerMessage.trim() ? "asked_person" : "other";
  if (/мэдээлэлгүй|no_data|fast_path|answer_plan|date_availability|scoped_clarify|clarify|program|generic/.test(text)) return "no_data";
  return "other";
}

/** Reasons where the customer asked something the bot could not answer — the questions worth reading. */
export const QUESTION_REASONS: ReadonlySet<SilenceReason> = new Set(["no_data", "not_found", "unclear_trip"]);

const TOPIC_PATTERNS: Array<[CoverageTopic, RegExp]> = [
  ["documents", /виз|паспорт|бичиг\s*баримт|visa|passport|\bviz/i],
  ["terms", /урьдчилгаа|цуцл|буцаа|deposit|cancel|uridchilgaa/i],
  ["includes", /багтсан|багтаагүй|орсон\s*уу|хоол|bagts|hool|includ/i],
  ["hotel", /буудал|зочид|hotel|buudal|\d\s*од/i],
  ["program", /хөтөлбөр|hotolbor|hutulbur|hötölbör|program|itinerary/i],
  ["photos", /зураг|zurag|photo/i],
  ["price", /үнэ|une\b|vne|хэд\s*вэ|hed\s*ve|төг|price|хямд/i],
  ["dates", /хэзээ|огноо|гарах|hezee|ognoo|garah|\d{1,2}\s*(?:сар|sar)|\d{1,2}\s*[./]\s*\d{1,2}/i],
];

/** The topic a customer's question is about, when its words say so. */
export function questionTopic(text: string): CoverageTopic | null {
  return TOPIC_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

// Facts the answer planner records as missing ("price.child", "booking_terms.visa", "program").
const FACT_TOPICS: Array<[RegExp, CoverageTopic]> = [
  [/^booking_terms\.(?:visa|documents)\b/, "documents"],
  [/^booking_terms\b/, "terms"],
  [/^price\b/, "price"],
  [/^(?:dates|availability)\b/, "dates"],
  [/^program\b/, "program"],
  [/^hotel\b/, "hotel"],
  [/^includes\b/, "includes"],
  [/^photos\b/, "photos"],
];

/**
 * The topic of the fact the bot itself recorded as missing (the hand-off context ends with
 * "[booking_terms.visa]"): null when the record names a fact outside these topics (weather,
 * transport), undefined when there is no record and the question's words must decide.
 */
export function missingFactTopic(context: string): CoverageTopic | null | undefined {
  const facts = /\[([^\]]+)\]/.exec(context)?.[1];
  if (!facts) return undefined;
  for (const fact of facts.split(",")) {
    const topic = FACT_TOPICS.find(([pattern]) => pattern.test(fact.trim()))?.[1];
    if (topic) return topic;
  }
  return null;
}

export const COVERAGE_TOPICS: CoverageTopic[] = ["price", "dates", "program", "hotel", "includes", "documents", "terms", "photos"];

/**
 * Which topics one active trip's data can answer — the same fields the bot answers from,
 * including the website page's requirements and cancellation policy.
 */
export function tripCoverage(trip: Row): Set<CoverageTopic> {
  const extra = record(trip.extra);
  const groups = list(extra.price_groups).map(record);
  const days = list(extra.itinerary_days).map(record);
  const terms = record(extra.booking_terms);
  const website = record(extra.website_details);
  const covered = new Set<CoverageTopic>();
  if (Number(trip.adult_price) > 0 || groups.some((group) => Number(group.adult_price) > 0)) covered.add("price");
  if (filled(trip.departure_dates) || filled(extra.departure_rule)) covered.add("dates");
  if (days.some((day) => filled(day.summary) || filled(day.description) || filled(day.title))) covered.add("program");
  if (filled(trip.hotel) || groups.some((group) => filled(group.hotel)) || days.some((day) => filled(day.hotel))) covered.add("hotel");
  if (filled(extra.included_items)) covered.add("includes");
  if (filled(terms.visa) || filled(terms.documents) || filled(website.requirements)) covered.add("documents");
  if (filled(terms.deposit) || filled(terms.cancellation) || filled(terms.payment) || filled(website.cancellationPolicy)) covered.add("terms");
  if (filled(trip.photo_urls) || Number(extra.poster_photo_count) > 0 || filled(extra.poster_trip_id)) covered.add("photos");
  return covered;
}

/**
 * Logged events that are normal operation, not failures: staff replying in Messenger, the
 * bot staying silent on purpose, and the staff-alert channel the owner chose not to use.
 * They made the overview report "5 техникийн асуудал" on a healthy day.
 */
export const NOT_A_FAILURE_EVENTS: ReadonlySet<string> = new Set([
  "staff_alert.no_channel_configured",
  "webhook.staff_takeover_detected",
  "webhook.ai_no_data_customer_silenced",
  "webhook.ai_ungrounded_trip_reply_suppressed",
  "webhook.ai_refer",
  "webhook.ai_refer_customer_silenced",
  "webhook.no_data_reply_suppressed",
  "webhook.trip_answer_decision",
]);
