/**
 * Does an attached document look like a trip the catalogue already has?
 *
 * A cheap first look, in code, before anything is read by a model: the document's title lines
 * against every saved trip's name. A likely match sends the file to the assistant, which checks
 * properly and asks «энэ аялал аль хэдийн байна — шинэчлэх үү, шинээр нэмэх үү?»; no match and the
 * file goes straight to the new-trip reader, as before.
 *
 * Why (owner, 2026-11-21): the program of a trip already live, dropped in with no special words,
 * quietly became a second trip of the same name. He wants the assistant to notice by itself.
 *
 * It only decides who looks at the file next, so it errs towards "maybe": the place words of a
 * trip's name must mostly be in the document's first lines. Pure.
 */
import { distinctiveTokens } from "../tripNameTokens";
import type { TravelTrip } from "../travelTypes";

export type SimilarTrip = { trip_id: string; name: string; status: string; duration: string };

const HEAD_LINES = 8;
const HEAD_CHARS = 600;
const MAX_SIMILAR = 4;

/** The document's own title area: its first lines with something in them. */
function headOf(text: string): string {
  return String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, HEAD_LINES).join(" ").slice(0, HEAD_CHARS);
}

export function similarSavedTrips(text: string, trips: TravelTrip[]): SimilarTrip[] {
  const inFile = new Set(distinctiveTokens(headOf(text)));
  if (inFile.size < 2) return [];
  const scored: Array<{ trip: TravelTrip; score: number; live: boolean }> = [];
  for (const trip of trips) {
    if (trip.status === "draft" || trip.status === "cancelled") continue;
    const name = distinctiveTokens(trip.route_name);
    if (name.length < 2) continue;
    const shared = name.filter((token) => inFile.has(token)).length;
    // Two place words in common, and most of the name's own words.
    if (shared < 2 || shared / name.length < 0.6) continue;
    scored.push({ trip, score: shared / name.length, live: trip.status !== "archived" });
  }
  return scored
    .sort((a, b) => Number(b.live) - Number(a.live) || b.score - a.score)
    .slice(0, MAX_SIMILAR)
    .map(({ trip }) => ({ trip_id: trip.id, name: trip.route_name, status: trip.status, duration: trip.duration_text || "" }));
}
