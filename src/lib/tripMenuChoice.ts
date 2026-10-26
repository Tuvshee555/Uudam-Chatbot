import type { TravelTrip } from "./travelTypes";
import { normText } from "./travelTextNorm";

type Turn = { role: "user" | "assistant"; text: string };

/** An ordinal followed by a factual question refers to a displayed trip menu. */
export function tripMenuQuestionIndex(text: string): number | null {
  const match = /^\s*(\d+)\s*-?\s*(?:ийн|ын|р|iin|in|dahi|dugaar)\s+(?:(?:нь|ni)\s+)?((?:хөтөлбөр|үнэ|огноо|зураг|[hx][uoө]t[uoө]lb[uoө]r|une|vne|price|program|itinerary|pdf|zurag)[\s\S]*)$/iu.exec(text);
  if (!match) return null;
  return Number(match[1]) - 1;
}

/** Use the most recent actual menu, preserving its displayed order. */
export function tripFromRecentMenu(text: string, history: Turn[], trips: TravelTrip[]): TravelTrip | null {
  const index = tripMenuQuestionIndex(text);
  if (index === null) return null;
  for (const turn of history.slice(-12).reverse()) {
    if (turn.role !== "assistant" || !/аль\s+аялл/iu.test(turn.text)) continue;
    const rows = turn.text.split(/\r?\n/).flatMap(line => {
      const match = /^\s*(?:[•*\-]\s+|(\d+)[.)]\s+)(.+)$/.exec(line);
      return match ? [{ ordinal: match[1] ? Number(match[1]) - 1 : null, title: match[2].split(/\s+—\s+/)[0] }] : [];
    });
    if (!rows.length) continue;
    // Keep the displayed slots even when a trip was removed or appears twice.
    // Explicit numbering may contain gaps and must not be compressed either.
    const selected = rows.some(row => row.ordinal !== null) ? rows.filter(row => row.ordinal === index) : rows.slice(index, index + 1);
    if (index < 0 || selected.length !== 1) return null;
    const name = normText(selected[0].title.replace(/\*\*/g, ""));
    const matches = trips.filter(trip => normText(trip.route_name) === name);
    return matches.length === 1 ? matches[0] : null;
  }
  return null;
}
