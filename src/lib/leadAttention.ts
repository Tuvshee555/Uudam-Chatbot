import type { TravelLead } from "./travelTypes";

/**
 * Which leads a consultant should open first. On 2026-10-30 every one of the 172 real leads of
 * the past 30 days was still "new": the Leads tab listed them by creation time, so the customer
 * waiting on an answer looked like everything else. Pure (shared by the admin API and page).
 *
 * - waiting: the customer is waiting on a person — the bot stayed silent (no data, outage,
 *   a message that kept failing) or a consultant owns the chat and the customer wrote again;
 * - booking: a booking request (phone left) not yet seen;
 * - new: any other unseen lead;
 * - staff: a consultant replied in the Messenger thread after the customer last wrote;
 * - seen: a consultant marked it seen.
 * Attention lapses after ATTENTION_DAYS without activity, so old unread leads stop crowding it.
 */
export type LeadAttentionTier = "waiting" | "booking" | "new" | "staff" | "seen";
export type LeadAttention = {
  tier: LeadAttentionTier;
  needsAttention: boolean;
  /** Latest customer activity on the lead: creation, or the newest note appended to it. */
  lastActivityAt: string;
  /** The newest note appended to the lead ("Хариулаагүй асуулт (10-30 18:05): …"). */
  latestNote: string | null;
};

export const ATTENTION_DAYS = 7;
export const TIER_LABELS: Record<LeadAttentionTier, string> = {
  waiting: "Хариу хүлээж байна",
  booking: "Захиалгын хүсэлт",
  new: "Шинэ хүсэлт",
  staff: "Ажилтан Messenger-ээр хариулсан",
  seen: "Үзсэн",
};
const TIER_ORDER: Record<LeadAttentionTier, number> = { waiting: 0, booking: 1, new: 2, staff: 3, seen: 4 };

/** Notes the webhook appends (bookedFollowup.followupLeadLine): "<label> (MM-DD HH:MM): <text>". */
const NOTE_RE = /^(.+?) \((\d{2})-(\d{2}) (\d{2}):(\d{2})\): .+$/gmu;
const WAITING_NOTE_LABELS = new Set(["Хариулаагүй асуулт", "Захиалгын төлөв асуусан"]);
/** Lead contexts the webhook writes when the customer got no answer from the bot. */
const SILENT_CONTEXT_RE = /хэрэглэгчид хариу илгээсэнгүй|хэрэглэгчид хариу (?:очоогүй|дутуу)|^AI түр саатсан/mu;

/** Mongolia time (UTC+8) on the note, in the lead's year, or the next one across New Year. */
function noteTime(createdAt: string, month: number, day: number, hour: number, minute: number): number {
  const created = new Date(Date.parse(createdAt) + 8 * 3_600_000);
  const year = created.getUTCFullYear() + (month < created.getUTCMonth() + 1 ? 1 : 0);
  return Date.UTC(year, month - 1, day, hour, minute) - 8 * 3_600_000;
}

export function leadAttention(lead: TravelLead & { last_activity_at?: string | null; staff_replied_at?: string | null }, now = new Date()): LeadAttention {
  let latestNote: string | null = null;
  let latestNoteLabel: string | null = null;
  let latestNoteAt = 0;
  for (const match of lead.context.matchAll(NOTE_RE)) {
    const at = noteTime(lead.created_at, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]));
    if (Number.isFinite(at) && at >= latestNoteAt) { latestNoteAt = at; latestNote = match[0]; latestNoteLabel = match[1]; }
  }
  const created = Date.parse(lead.created_at);
  const stored = lead.last_activity_at ? Date.parse(lead.last_activity_at) : NaN;
  const last = Math.max(Number.isFinite(created) ? created : 0, latestNoteAt, Number.isFinite(stored) ? stored : 0);
  const lastActivityAt = new Date(last || now.getTime()).toISOString();
  if (lead.status !== "new") return { tier: "seen", needsAttention: false, lastActivityAt, latestNote };
  // A consultant replied in the Messenger thread after the customer last wrote (seen by the bot
  // as an operator_reply pause): answered there, even though nobody opened the Leads tab.
  const staffAt = lead.staff_replied_at ? Date.parse(lead.staff_replied_at) : NaN;
  if (Number.isFinite(staffAt) && staffAt > last) return { tier: "staff", needsAttention: false, lastActivityAt, latestNote };
  const waiting = latestNoteLabel ? WAITING_NOTE_LABELS.has(latestNoteLabel) : SILENT_CONTEXT_RE.test(lead.context);
  const tier: LeadAttentionTier = waiting ? "waiting" : lead.kind === "booking" ? "booking" : "new";
  return { tier, needsAttention: now.getTime() - last <= ATTENTION_DAYS * 86_400_000, lastActivityAt, latestNote };
}

/** Needing attention first, then by tier, then the most recent activity. */
export function compareLeadsByAttention(a: LeadAttention, b: LeadAttention): number {
  return Number(b.needsAttention) - Number(a.needsAttention)
    || TIER_ORDER[a.tier] - TIER_ORDER[b.tier]
    || Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
}

export type LeadAttentionSummary = { needsAttention: number; waiting: number; booking: number; latestActivityAt: string | null };

export function summarizeLeadAttention(leads: Array<TravelLead & { last_activity_at?: string | null }>, now = new Date()): LeadAttentionSummary {
  const summary: LeadAttentionSummary = { needsAttention: 0, waiting: 0, booking: 0, latestActivityAt: null };
  for (const lead of leads) {
    const attention = leadAttention(lead, now);
    if (!attention.needsAttention) continue;
    summary.needsAttention += 1;
    if (attention.tier === "waiting") summary.waiting += 1;
    if (attention.tier === "booking") summary.booking += 1;
    if (!summary.latestActivityAt || attention.lastActivityAt > summary.latestActivityAt) summary.latestActivityAt = attention.lastActivityAt;
  }
  return summary;
}
