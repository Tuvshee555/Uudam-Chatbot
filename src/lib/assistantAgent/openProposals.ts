/**
 * New-trip cards the admin has open but not saved yet. The page sends them with a typed message
 * (`open_proposals`), and a message about one of them changes that card, never a saved trip.
 *
 * Why (2026-11-14): a New Year Hohhot trip was read from a file and left on its card. "сүүлийн
 * өдрийг нэм" then went to the saved catalogue and patched another trip, and "… линк" answered
 * with a different trip's website link: the assistant only knew trips already saved. Pure.
 */
import { sharedDistinctive } from "../tripNameTokens";
import { urlsInText } from "./links";
import type { TravelTrip } from "../travelTypes";

export type OpenProposal = { request_id: number; names: string[]; latest: boolean };

const MAX_OPEN = 3;

/** The page's `open_proposals`, checked: integer ids, 1–3 names of ≤200 characters, at most three cards. */
export function parseOpenProposals(value: unknown): OpenProposal[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): OpenProposal[] => {
    if (!item || typeof item !== "object") return [];
    const raw = item as { request_id?: unknown; names?: unknown; latest?: unknown };
    if (typeof raw.request_id !== "number" || !Number.isInteger(raw.request_id) || raw.request_id <= 0) return [];
    const names = Array.isArray(raw.names)
      ? raw.names.filter((name): name is string => typeof name === "string").map((name) => name.trim().slice(0, 200)).filter(Boolean).slice(0, 3)
      : [];
    return names.length ? [{ request_id: raw.request_id, names, latest: raw.latest === true }] : [];
  }).slice(0, MAX_OPEN);
}

/** A change verb (add, remove, fix, make, change, replace, put in, write, delete, move, raise, lower). */
const EDIT_WORDS = /(?:^|[^\p{L}])(?:нэм|хас|зас|болго|өөрчил|сол[иь]|оруул|тавь|бич|устга|шилжүүл|өсгө|бууруул|багас|nem|has|zas|bolgo|oorchil|soli)/iu;
/** Asks for a link or the trip's page. */
const LINK_WORDS = /линк|холбоос|\blink\b|\burl\b/iu;
/** "шинэ аялал нэм": another trip, not a change of the open one ("Шинэ жилийн аялал" is a name). */
const NEW_TRIP = /шинэ\s+аял|new\s+trip/iu;

export type OpenProposalRoute =
  | { kind: "revise"; target: OpenProposal; name: string }
  | { kind: "link"; target: OpenProposal; name: string };

/**
 * Which open card a message is about, or null (then it goes to the saved catalogue as before).
 * - A card whose trip name shares a place word with the message ("Хөх", "Чунчин"), at least as
 *   many as any saved trip does, is the one meant.
 * - A change that names no trip at all ("сүүлийн өдрийг нэм") belongs to the card the assistant
 *   just showed, when that card is still the last thing it said.
 * - A pasted link is a new source, never a change of an open card.
 */
export function openProposalRoute(instruction: string, open: OpenProposal[], trips: TravelTrip[]): OpenProposalRoute | null {
  if (!open.length || urlsInText(instruction).length || NEW_TRIP.test(instruction)) return null;
  const saved = trips.filter((trip) => trip.status !== "archived");
  const savedBest = Math.max(0, ...saved.map((trip) => sharedDistinctive(trip.route_name, instruction)));
  let best: { target: OpenProposal; name: string; score: number } | null = null;
  for (const card of open) {
    for (const name of card.names) {
      const score = sharedDistinctive(name, instruction);
      if (score > 0 && score > (best?.score ?? 0)) best = { target: card, name, score };
    }
  }
  const kind = LINK_WORDS.test(instruction) ? "link" : "revise";
  if (best && best.score >= savedBest) return { kind, target: best.target, name: best.name };
  const latest = open.find((card) => card.latest);
  if (latest && savedBest === 0 && (kind === "link" || EDIT_WORDS.test(instruction))) {
    return { kind, target: latest, name: latest.names[0] };
  }
  return null;
}

/** The answer to "that trip's link" while the trip is still an unsaved card. */
export function unsavedTripLinkNote(name: string): string {
  return `«${name}» хараахан хадгалагдаагүй байна — вэбсайт дээрх хуудас, линк нь аяллыг нийтэлсний дараа гарна (ноорог сайтад гарахгүй). Дээрх картыг шалгаад нийтлээрэй.`;
}
