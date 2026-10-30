import type { TravelLead } from "./travelTypes";
import { normalizeLowerText } from "./handoffDetection";

/**
 * After a booking request (phone left, booking form, documents, payment claim) the bot marks
 * the customer as waiting for a consultant (pause.ts, reason "booked_customer"). That marker
 * used to silence the bot for three days; since 2026-10-30 it does not. The bot keeps
 * helping, and only a human takeover (a staff reply in the thread, or a manual pause) stops
 * it. A status question ("Хэзээ холбогдох вэ?", "Захиалга маань юу болсон бэ?") is answered
 * from the lead record alone: the request was received, the trip and phone on it, and what
 * staff marked. It never calls an inquiry a confirmed booking or promises when anyone calls.
 */
export const BOOKED_STATUS_HEADING = "Таны захиалгын хүсэлт";
const UNCHANGED_PREFIX = "Шинэ мэдээлэл алга:";

/** Pause reasons the bot sets itself: they mark a waiting customer, they do not silence the bot. */
export const BOT_OWNED_PAUSE_REASONS: ReadonlySet<string> = new Set(["booked_customer", "auto_handoff"]);

const STATUS_LINE: Record<TravelLead["lead_status"], string> = {
  new_lead: "Аяллын зөвлөх тантай хараахан холбогдоогүй байна.",
  no_answer: "Аяллын зөвлөх тан руу залгасан боловч холбогдож чадаагүй гэж бүртгэлд байна.",
  contacted: "Таны захиалгын хүсэлтийг аяллын зөвлөх хариуцаж байна.",
  // Only a consultant sets "booked" (Leads tab); the bot never infers it.
  booked: "Аяллын зөвлөх таны захиалгыг бүртгэлд «захиалсан» гэж тэмдэглэсэн.",
};

/**
 * "When will you contact me?", "will you call me?", "what happened to my booking?" — in
 * Cyrillic or Latin letters. Anything else from a waiting customer is answered normally.
 */
export function isBookingStatusQuestion(text: string): boolean {
  const value = normalizeLowerText(text);
  return /хэзээ\s+(?:холбогд|залга|ярь|хариу)|(?:холбогдох|залгах)\s+(?:уу|юм\s+уу|вэ|бол)|над\s+руу\s+залга|над\s+луу\s+залга/u.test(value)
    || /захиалга\s*(?:маань|минь|чинь)?\s*(?:юу\s+болсон|яасан|ямар\s+байна|баталгаажсан\s+уу|болсон\s+уу|хаана\s+явна)/u.test(value)
    || /hezee\s+(?:holbogd|zalga|yari|hariu)|(?:holbogdoh|zalgah)\s+(?:uu|yu|ve)|nad\s+ruu\s+zalga|zahialga\s*(?:maani|mini)?\s*(?:yu\s+bolson|yaasan|bolson\s+uu)/u.test(value);
}

/** The status reply for a booking lead; null for other leads. */
export function bookedFollowupReply(lead: TravelLead): string | null {
  if (lead.kind !== "booking") return null;
  const trip = /^Хүссэн аялал:\s*(.+)$/m.exec(lead.context)?.[1]?.trim();
  const digits = lead.contact_phone.replace(/\D/g, "");
  return [
    `${BOOKED_STATUS_HEADING} бүртгэгдсэн.`,
    ...(trip ? [`Аялал: ${trip}`] : []),
    ...(digits.length >= 4 ? [`Холбогдох утас: ••••${digits.slice(-4)}`] : []),
    `${STATUS_LINE[lead.lead_status]} Асуултыг тань зөвлөхөд дамжууллаа.`,
  ].join("\n");
}

/**
 * What to send for a status question, given the previous bot reply and customer message:
 * the full status; a one-line "nothing new" when the status was just given and has not
 * changed; or nothing when the customer repeats the very same question (no spam — it still
 * reaches the lead).
 */
export function bookedStatusTurn(lead: TravelLead, previous: { reply?: string; question?: string }, text: string): string | null {
  const full = bookedFollowupReply(lead);
  if (!full) return null;
  const statusLine = STATUS_LINE[lead.lead_status];
  const short = `${UNCHANGED_PREFIX} ${statusLine} Асуултыг тань зөвлөхөд дахин дамжууллаа.`;
  const justTold = previous.reply === full || previous.reply === short;
  if (!justTold) return full;
  const sameQuestion = previous.question !== undefined && normalizeLowerText(previous.question) === normalizeLowerText(text);
  return sameQuestion ? null : short;
}

/** The line added to the lead so staff see what the customer wrote while waiting. */
export function followupLeadLine(text: string, now = new Date(), label = "Хариулаагүй асуулт"): string {
  const clock = new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(5, 16).replace("T", " ");
  return `${label} (${clock}): ${text.replace(/\s+/g, " ").trim().slice(0, 300)}`;
}
