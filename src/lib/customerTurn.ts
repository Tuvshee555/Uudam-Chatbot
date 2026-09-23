/**
 * Separates WHICH TRIP a message is about from WHAT the customer is asking.
 *
 * Routing hands the reply builders one string: context that identifies the
 * trip (a trip name, or the bot's previous reply) followed by the customer's
 * current message. Every intent detector used to read that whole string, so:
 *   - words inside TRIP NAMES became questions — tapping a trip named
 *     "<хот> [сар]-р сарын аяллын хөтөлбөр" sent the PDF ("хөтөлбөр"), tapping
 *     any "…шууд нислэгтэй аялал" answered only "Энэ аялал шууд нислэгтэй",
 *     and a name ending in a date ("…-[сар]/[өдөр]") was read as a date question;
 *   - the bot's OWN previous reply became the question — "амжилт" or
 *     "za bolchloo" after a price answer was treated as a price question,
 *     matched no trip, and the customer was silently handed to staff.
 *
 * The customer's turn is now marked inside routed text, and intent is read
 * only from that turn, with trip names removed.
 */

import type { TravelTrip } from "./travelTypes";

/** U+2029 PARAGRAPH SEPARATOR — never typed by customers; whitespace to every matcher. */
export const CUSTOMER_TURN_MARK = " ";

/** Context (trip name / previous reply) followed by the marked customer turn. */
export function joinContextAndTurn(context: string, turn: string): string {
  const cleanTurn = turn.split(CUSTOMER_TURN_MARK).join(" ").trim();
  return context.trim() ? `${context.trim()}\n${CUSTOMER_TURN_MARK}${cleanTurn}` : cleanTurn;
}

/** The customer's own current message inside routed text. */
export function customerTurn(text: string): string {
  const index = text.lastIndexOf(CUSTOMER_TURN_MARK);
  return (index >= 0 ? text.slice(index + 1) : text).trim();
}

function looseNorm(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const patternCache = new Map<string, RegExp | null>();

function tripNamePattern(name: string): RegExp | null {
  if (patternCache.has(name)) return patternCache.get(name) ?? null;
  const parts = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const pattern = parts.length === 0
    ? null
    : new RegExp(
        `(?<![\\p{L}\\p{N}])${parts
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("[^\\p{L}\\p{N}]+")}(?![\\p{L}\\p{N}])`,
        "giu",
      );
  if (patternCache.size > 500) patternCache.clear();
  patternCache.set(name, pattern);
  return pattern;
}

/** "2. <first letters of a trip name>…" — one of our numbered trip buttons, possibly truncated. */
const NUMBERED_BUTTON_LINE = /^\s*\d{1,2}\s*[.)]\s*(.+?)\s*(?:\.\.\.|…)?\s*$/u;

/**
 * The text with every catalog trip NAME removed (exact names, and numbered
 * button titles that are a prefix of a name). Use it for intent detection
 * only — never for deciding which trip the message is about.
 */
export function stripTripNamesForIntent(text: string, trips: TravelTrip[]): string {
  const names = Array.from(new Set(trips.map((trip) => trip.route_name).filter(Boolean)))
    .sort((a, b) => b.length - a.length);
  const looseNames = names.map(looseNorm);
  return text
    .split("\n")
    .map((line) => {
      const button = NUMBERED_BUTTON_LINE.exec(line);
      if (button) {
        const rest = looseNorm(button[1]);
        if (rest.length >= 3 && looseNames.some((name) => name.startsWith(rest))) return "";
      }
      let stripped = line;
      for (const name of names) {
        const pattern = tripNamePattern(name);
        if (pattern) stripped = stripped.replace(pattern, " ");
      }
      return stripped.replace(/[ \t]{2,}/g, " ").trim();
    })
    .join("\n")
    .trim();
}

/** What the customer is asking: their current turn, trip names removed. */
export function intentTextOf(text: string, trips: TravelTrip[]): string {
  return stripTripNamesForIntent(customerTurn(text), trips);
}
