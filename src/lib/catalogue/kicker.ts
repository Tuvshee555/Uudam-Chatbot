/**
 * The small line above a trip's headline ("kicker"). It must never mislead, so it is derived in
 * this order and left empty when nothing trustworthy exists:
 *
 *   1. the website's own region / country (staff-written, structured);
 *   2. places from the trip's destination list that the trip's TITLE also names, with
 *        - the agency's departure and border points dropped (they are legs, not destinations),
 *        - a place the title marks as a starting point ("<place>-оос / -ээс / -аас / -өөс") dropped.
 *
 * Why the title: a trip's destination list is route order and mixes transit hubs, border towns and
 * landmarks with the real destinations, and the order differs from trip to trip, so position says
 * nothing. The title is what staff wrote for customers, so a place it names is a place the trip
 * is about. A destination the title does not name is never promoted to a headline.
 *
 * Pure: no clock, no database, no network.
 */
import { STANDARD_DAYS } from "../tripTransitDays";

export type KickerInput = {
  title: string;
  country?: string;
  region?: string;
  destinations?: readonly string[];
  /** Overrides the agency's departure / border points (tests pass invented ones). */
  fixedPoints?: readonly string[];
};

const LETTERS = /[^\p{L}\p{N}]+/gu;
const compact = (value: string) => value.toLowerCase().replace(LETTERS, "");

/**
 * The agency's own fixed points, read from the standard transit days (one source of truth):
 * the home city, the border crossing and the border town, plus the home city's abbreviation.
 */
function defaultFixedPoints(): string[] {
  const names = [STANDARD_DAYS.departure.title, STANDARD_DAYS.borderOutbound.title].flatMap(t => t.split(/\s*[–—-]\s*/u));
  return [...new Set([...names, "УБ"].map(compact).filter(Boolean))];
}

const FIXED_POINTS = defaultFixedPoints();

function isFixedPoint(name: string, fixed: readonly string[]): boolean {
  const key = compact(name);
  if (!key) return true;
  // A fixed point of 4+ letters matches inflected spellings too ("<name>аас", "<name>хот").
  return fixed.some(point => key === point || (point.length >= 4 && key.startsWith(point)));
}

/** How many leading letters of a place name must appear in the title (tolerates endings and spelling drift). */
function stemLength(letterCount: number): number {
  return letterCount <= 4 ? letterCount : Math.max(4, letterCount - 2);
}

const SEPARATOR = "[\\s\\-‐‑–—.,/]*";
const ORIGIN_ENDING = /(?:аас|ээс|оос|өөс)$/u;

/**
 * Where the title names `name`: "absent", "origin" (the title says "from <name>") or "named".
 * The stem may span a word gap ("хөх хот" and "хөххот" are the same place).
 */
function titleMention(title: string, name: string): "absent" | "origin" | "named" {
  const letters = [...compact(name)];
  if (letters.length < 3) return "absent";
  const stem = letters.slice(0, stemLength(letters.length)).map(ch => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(SEPARATOR);
  const found = new RegExp(`(?<!\\p{L})${stem}(\\p{L}*)`, "iu").exec(title);
  if (!found) return "absent";
  return ORIGIN_ENDING.test(found[1]!.toLowerCase()) ? "origin" : "named";
}

/** True when `name` is one of the agency's own departure / border points (a leg, never a destination). */
export function isAgencyFixedPoint(name: string): boolean {
  return isFixedPoint(name, FIXED_POINTS);
}

/** Up to two destination names, title-anchored and without departure / border legs. */
export function titleAnchoredPlaces(title: string, destinations: readonly string[], fixedPoints?: readonly string[]): string[] {
  if (!title.trim()) return [];
  const fixed = (fixedPoints ?? FIXED_POINTS).map(compact);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of destinations) {
    const clean = name.trim();
    if (!clean || isFixedPoint(clean, fixed)) continue;
    if (titleMention(title, clean) !== "named") continue;
    const key = compact(clean).slice(0, 5);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length === 2) break;
  }
  return out;
}

export function deriveKicker(input: KickerInput): string {
  const country = (input.country ?? "").trim();
  const region = (input.region ?? "").trim();
  if (region && country) return compact(region) === compact(country) ? country : `${region} / ${country}`;
  if (country) return country;
  if (region) return region;
  return titleAnchoredPlaces(input.title, input.destinations ?? [], input.fixedPoints).join(" · ");
}
