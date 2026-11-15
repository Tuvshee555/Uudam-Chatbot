/**
 * The partner watch inside the admin assistant (assistantReply.ts), all in code, before any model:
 *
 *  - a new trip read from a partner page keeps that page: extra.source_url (+ source_checked_at);
 *  - a pasted link that a trip was already made from is not read again as a new trip: one
 *    question with two buttons — «Хуваарь, суудлыг шинэчлэх» (the watch check for that trip, now,
 *    as a proposal to review) or «Шинэ аялал болгон дахин нэмэх» (read it as a new trip anyway);
 *  - the check's proposal: the seat states and fares that changed, built and checked by the
 *    agent's own action builder (buildAgentProposal), so the card promises only what save does;
 *    new and vanished dates are lines on the card with the instruction to type.
 */
import { buildAgentProposal } from "../assistantAgent/actions";
import { urlsInText } from "../assistantAgent/links";
import { tripOptionHint } from "../assistantAgent/turn";
import type { AssistantAskPayload } from "../assistantBrain";
import type { AIChangeProposal, ConflictItem, TravelTrip } from "../travelTypes";
import { seatChangeProblem, type WatchItem } from "./compare";
import { fetchPartnerPage, readTripAgainstPage, type WatchDeps } from "./run";
import { cleanSourceUrl, partnerSyncUrl, tripSourceUrl, tripsFromPage } from "./sourceUrl";

const CHECK_TAG = /\s*\[хамтрагч шалгах:\s*([A-Za-z0-9_.:-]+)\]/u;
const NEW_TRIP_TAG = /\s*\[шинэ аялал\]/gu;
const OUR_SITE = /^https?:\/\/(?:www\.)?uudamtravel\.mn\//i;
const MAX_CHECK_OPTIONS = 3;

/** The trip a tapped «Хуваарь, суудлыг шинэчлэх» names, or null. */
export function watchCheckTripId(text: string): string | null {
  return CHECK_TAG.exec(String(text || ""))?.[1] ?? null;
}

/** True when the admin chose «Шинэ аялал болгон дахин нэмэх»: the link is read as a new trip. */
export function forcesNewTrip(text: string): boolean {
  return /\[шинэ аялал\]/u.test(String(text || ""));
}

/** The instruction without the watch's own option tags. */
export function withoutWatchTags(text: string): string {
  return String(text || "").replace(CHECK_TAG, " ").replace(NEW_TRIP_TAG, " ").replace(/[ \t]{2,}/g, " ").trim();
}

/** Every new trip of a reading made from a page keeps that page (extra.source_url) and when it was read. */
export function withSourceUrl(proposal: AIChangeProposal, url: string | undefined, checkedAt: string): AIChangeProposal {
  const source = cleanSourceUrl(url);
  if (!source) return proposal;
  return {
    ...proposal,
    actions: proposal.actions.map((action) => {
      if (String(action.action || "").toLowerCase() !== "upsert" || action.trip_id || !action.fields) return action;
      const extra = action.fields.extra && typeof action.fields.extra === "object" ? action.fields.extra : {};
      return { ...action, fields: { ...action.fields, extra: { ...extra, source_url: source, source_checked_at: checkedAt } } };
    }),
  };
}

/**
 * The question for a pasted link a trip was already made from (any status), or null. Checked in
 * code before the model runs; our own website's links are identity links and never asked here.
 */
export function duplicateLinkAsk(instruction: string, trips: TravelTrip[], now: Date = new Date()): AssistantAskPayload | null {
  if (forcesNewTrip(instruction)) return null;
  for (const url of urlsInText(instruction)) {
    if (OUR_SITE.test(url)) continue;
    const known = tripsFromPage(trips, url);
    if (!known.length) continue;
    const names = known.map((trip) => `«${trip.route_name}»`).join(", ");
    // The watch checks trips made from a page; a partner-synced trip is the sync's, an archived one is not sold.
    const checkable = known.filter((trip) => !partnerSyncUrl(trip) && tripSourceUrl(trip) && trip.status !== "archived").slice(0, MAX_CHECK_OPTIONS);
    const synced = known.some((trip) => partnerSyncUrl(trip));
    const again = withoutWatchTags(instruction).slice(0, 4_000);
    return {
      id: "partner_link_known",
      text: `Энэ холбоосын аялал аль хэдийн нэмэгдсэн: ${names}${synced ? " (хамтрагчийн сайтаас 30 минут тутам автоматаар шинэчлэгддэг)" : ""}`,
      options: [
        ...checkable.map((trip) => ({
          label: checkable.length > 1 ? `«${trip.route_name}» — хуваарь, суудлыг шинэчлэх` : "Хуваарь, суудлыг шинэчлэх",
          answer: `«${trip.route_name}» аяллын хуваарь, суудлыг хамтрагчийн хуудастай тулгах [хамтрагч шалгах: ${trip.id}]`,
          hint: tripOptionHint(trip, now),
          ...(checkable.length === 1 ? { recommended: true } : {}),
        })),
        { label: "Шинэ аялал болгон дахин нэмэх", answer: `${again} [шинэ аялал]` },
      ],
      allow_custom: true,
      custom_placeholder: "Эсвэл юу хийхийг бичнэ үү…",
    };
  }
  return null;
}

/* ---------------------------------------------------------------- */
/* «Хуваарь, суудлыг шинэчлэх»                                       */
/* ---------------------------------------------------------------- */

export type WatchCheckReply =
  | { kind: "proposal"; proposal: AIChangeProposal; request_id: number | null }
  | { kind: "note"; text: string };

export type WatchCheckOptions = {
  now?: Date;
  fetchPage?: WatchDeps["fetchPage"];
  record?: WatchDeps["record"];
  /** Stores the proposal as a change request (travelAI.persistProposal). */
  persist?: (instruction: string, proposal: AIChangeProposal) => Promise<number | null>;
};

type RawAction = Record<string, unknown>;

/** The changes the admin may save from this card: seat states (those set_date_state can write) and fares. */
function rawActions(trip: TravelTrip, items: WatchItem[], now: Date): { actions: RawAction[]; lines: ConflictItem[] } {
  const actions: RawAction[] = [];
  const lines: ConflictItem[] = [];
  const fares = new Map<string, RawAction>();
  for (const item of items) {
    if (item.kind === "seat_state") {
      const problem = seatChangeProblem(trip, item, now);
      if (problem) lines.push({ text: `${item.text} — ${problem}.`, severity: "warning", type: "partner_watch" });
      else actions.push({ action: "set_date_state", trip_id: trip.id, date: item.date, state: item.to.state });
    } else if (item.kind === "price") {
      const key = `${item.date}|${item.row_hotel ?? ""}|${item.fare === "child" ? item.band ?? "" : ""}`;
      const action = fares.get(key) ?? { action: "set_date_price", trip_id: trip.id, date: item.date, fares: {}, ...(item.row_hotel ? { hotel: item.row_hotel } : {}) };
      (action.fares as Record<string, unknown>)[item.fare] = { set: item.to };
      if (item.fare === "child" && item.band) action.band = item.band;
      fares.set(key, action);
    } else {
      const hint = item.instruction ? ` Өөрчлөх бол: «${item.instruction}».` : "";
      lines.push({ text: `${item.text}.${hint}`, severity: "info", type: "partner_watch" });
    }
  }
  return { actions: [...actions, ...fares.values()], lines };
}

/** The watch check for one trip, now: its partner page read again and shown as a proposal (nothing saved). */
export async function partnerCheckReply(tripId: string, trips: TravelTrip[], options: WatchCheckOptions = {}): Promise<WatchCheckReply> {
  const now = options.now ?? new Date();
  const trip = trips.find((entry) => entry.id === tripId);
  if (!trip) return { kind: "note", text: "Энэ аялал бүртгэлд олдсонгүй — юу ч өөрчлөхгүй." };
  const name = `«${trip.route_name}»`;
  if (partnerSyncUrl(trip)) return { kind: "note", text: `${name} хамтрагчийн сайтаас 30 минут тутам автоматаар шинэчлэгддэг — гараар тулгах шаардлагагүй.` };
  const url = cleanSourceUrl(tripSourceUrl(trip));
  if (!url) return { kind: "note", text: `${name} хамтрагчийн хуудаснаас нэмэгдээгүй тул тулгах хуудас алга.` };
  const page = await (options.fetchPage ?? fetchPartnerPage)(url).catch((error: unknown) => ({ ok: false as const, url, error: error instanceof Error ? error.message : String(error) }));
  const read = readTripAgainstPage(trip, page, now);
  const record = options.record ?? (async (event) => (await import("./store")).recordWatchEvent(event));
  await Promise.resolve(record({ trip_id: trip.id, source_url: url, ok: read.ok, applied: [], pending: read.ok ? read.items : [], error: read.ok ? null : read.error })).catch(() => undefined);
  if (!read.ok) return { kind: "note", text: `${name}: ${read.error} Юу ч өөрчлөөгүй.` };
  const notes: ConflictItem[] = read.notes.map((text) => ({ text, severity: "info", type: "partner_watch" }));
  if (!read.items.length) {
    return { kind: "note", text: [`${name} хамтрагчийн хуудастай таарч байна — хуваарь, суудал, үнэд өөрчлөлт алга.`, ...read.notes].join(" ") };
  }
  const { actions, lines } = rawActions(trip, read.items, now);
  const built = buildAgentProposal(actions, "", {
    trips, now, fetched: new Map([[trip.id, trip.updated_at]]), seen: new Set([trip.id]),
    linkTrips: new Set(), linkUnresolved: false, hosted: new Set(),
  });
  if ("note" in built) {
    return { kind: "note", text: [`${name}: хамтрагчийн хуудсаар хадгалах өөрчлөлт гарсангүй.`, built.note, ...[...lines, ...notes].map((line) => line.text)].filter(Boolean).join("\n") };
  }
  const extra = [...lines, ...notes];
  const conflict_items = [...(built.proposal.conflict_items || []), ...extra];
  const proposal: AIChangeProposal = {
    ...built.proposal,
    summary: `${name}: хамтрагчийн хуудаснаас ${built.proposal.actions.length} өөрчлөлт — хянаад хадгална уу.`,
    conflict_items,
    conflicts: conflict_items.map((item) => item.text),
  };
  const persist = options.persist ?? (async (instruction: string, value: AIChangeProposal) => (await import("../travelAI")).persistProposal(instruction, value));
  const request_id = await persist(`${name} хамтрагчийн хуудастай тулгах`, proposal);
  return { kind: "proposal", proposal, request_id };
}
