import type { TravelLead } from "./travelTypes";

/**
 * A customer who booked belongs to staff, so the bot pauses for them (pause.ts). Their next
 * question ("Хэзээ холбогдох вэ?", "Захиалга маань юу болсон бэ?") used to be stored and met
 * with silence, and with no staff alert channel nobody saw it (live replay 2026-10-30). The
 * reply below states only what the lead record holds: when the request was received, the
 * trip and phone on it, and what staff marked. It never says the booking is confirmed or
 * when anyone will call.
 */
export const BOOKED_STATUS_HEADING = "Таны захиалгын хүсэлт";

const STATUS_LINE: Record<TravelLead["lead_status"], string> = {
  new_lead: "Аяллын зөвлөх тантай хараахан холбогдоогүй байна.",
  no_answer: "Аяллын зөвлөх тан руу залгасан боловч холбогдож чадаагүй гэж бүртгэлд байна.",
  contacted: "Таны захиалгыг аяллын зөвлөх хариуцаж байна.",
  booked: "Таны захиалгыг аяллын зөвлөх хариуцаж байна.",
};

/** The status reply for a booking lead whose follow-up was just recorded; null for other leads. */
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

/** The line added to the lead so staff see what the customer asked while waiting. */
export function followupLeadLine(text: string, now = new Date(), label = "Хариулаагүй асуулт"): string {
  const clock = new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(5, 16).replace("T", " ");
  return `${label} (${clock}): ${text.replace(/\s+/g, " ").trim().slice(0, 300)}`;
}

/**
 * "Хэзээ холбогдох вэ?", "Над руу залгах уу?", "Захиалга маань юу болсон бэ?" — a waiting
 * customer asking about their own request (Cyrillic or Latin script), answered from the lead.
 */
export function isBookingStatusQuestion(text: string): boolean {
  const value = text.toLowerCase().replace(/\s+/g, " ").trim();
  return /хэзээ\s+(?:холбогд|залга|ярь|хариу)|(?:холбогдох|залгах)\s+(?:уу|юм\s+уу|вэ|бол)|над\s+(?:руу|луу)\s+залга/u.test(value)
    || /захиалга\s*(?:маань|минь|чинь)?\s*(?:юу\s+болсон|яасан|ямар\s+байна|баталгаажсан\s+уу|болсон\s+уу|хаана\s+явна)/u.test(value)
    || /hezee\s+(?:holbogd|zalga|yari|hariu)|(?:holbogdoh|zalgah)\s+(?:uu|yu|ve)|nad\s+(?:ruu|luu)\s+zalga|zahialga\s*(?:maani|mini)?\s*(?:yu\s+bolson|yaasan|bolson\s+uu)/u.test(value);
}

export const NO_NEWS_LINE = "Шинэ мэдээлэл алга байна — аяллын зөвлөх тантай холбогдоно. Асуултыг тань дамжууллаа.";

/**
 * The reply to a status question: the lead's status; right after that same status, a one-line
 * "nothing new"; after that line, nothing more (the question still reaches staff on the lead).
 */
export function bookedStatusTurn(lead: TravelLead, previousReply?: string): string | null {
  const status = bookedFollowupReply(lead)
    ?? `Таны хүсэлт бүртгэгдсэн. ${STATUS_LINE[lead.lead_status]} Асуултыг тань зөвлөхөд дамжууллаа.`;
  if (!previousReply) return status;
  if (previousReply.trim() === NO_NEWS_LINE) return null;
  if (previousReply.trim() === status.trim()) return NO_NEWS_LINE;
  return status;
}
