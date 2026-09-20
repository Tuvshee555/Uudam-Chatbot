import type { PoolClient } from "pg";
import { askOpenAIParts } from "./openaiProvider";
import { record, records } from "./connectedTripMapping";
import type { TravelTrip } from "./travelTypes";

/**
 * Picks which website Category a newly-synced trip belongs in
 * (газрын аялал / шууд нислэгтэй / газар+нислэг хосолсон / круз / Өвлийн / …).
 *
 * Never called for a trip that already has a category — staff's own choice
 * in the website admin always wins; see the one call site in
 * websiteTripSync.ts. Categories themselves are staff-authored free text on
 * the website (see Category model), so this reads the live list rather than
 * assuming fixed names, and the model is only ever asked to pick one of
 * THOSE exact names — it cannot invent a category that doesn't exist.
 *
 * Winter is decided deterministically from departure months (never guessed
 * by the model): a trip departing only in Dec/Jan/Feb is a winter trip
 * regardless of transport mode, if a winter-shaped category exists.
 */

export type CategoryRow = { id: string; categoryName: string };

const WINTER_MONTHS = new Set([12, 1, 2]);
// "Өвөл" (winter) declines to "Өвлийн" (wintery/winter's) — the second
// syllable's vowel drops before the -ийн suffix, so a plain substring match
// on "өвөл" misses the real category name "Өвлийн аялал". Match both forms.
// Winter and cruise are decided here without the model — both are cheap,
// objective signals (calendar month; an unambiguous transport keyword).
// Land vs. flight vs. combined genuinely needs the itinerary read, since a
// title alone (e.g. "Жанжиажэ") says nothing about how the trip GETS there —
// that classification is left entirely to the model, further down.
const WINTER_NAME_PATTERN = /өвөл|өвлийн|winter/i;
const CRUISE_NAME_PATTERN = /круз|cruise|усан онгоц/i;

export function departureMonths(dates: readonly string[]): number[] {
  const months = new Set<number>();
  for (const text of dates) {
    const match = /(\d{1,2})\s*(?:-?р\s*)?сарын/i.exec(text);
    if (match) {
      const m = Number(match[1]);
      if (m >= 1 && m <= 12) months.add(m);
    }
  }
  return [...months];
}

export function isWinterOnly(dates: readonly string[]): boolean {
  const months = departureMonths(dates);
  return months.length > 0 && months.every((m) => WINTER_MONTHS.has(m));
}

/** Compact itinerary text the model actually reads — title + each day's route/summary. */
function summarizeItinerary(trip: TravelTrip): string {
  const days = records((trip.extra as Record<string, unknown> | undefined)?.itinerary_days);
  const lines = days.slice(0, 12).map((d) => {
    const r = record(d);
    const title = typeof r.title === "string" ? r.title : "";
    const desc = typeof r.description === "string" ? r.description.slice(0, 160) : "";
    return `Өдөр ${r.day ?? ""}: ${title} — ${desc}`;
  });
  return lines.join("\n");
}

async function fetchCategories(client: PoolClient): Promise<CategoryRow[]> {
  const res = await client.query<CategoryRow>(
    `SELECT id, "categoryName" FROM "Category" WHERE "parentId" IS NULL ORDER BY "categoryName"`,
  );
  return res.rows;
}

/** Deterministic pre-checks that don't need the model at all. */
export function ruleBasedGuess(trip: TravelTrip, categories: CategoryRow[]): CategoryRow | null {
  const winterCategory = categories.find((c) => WINTER_NAME_PATTERN.test(c.categoryName));
  if (winterCategory && isWinterOnly(trip.departure_dates)) return winterCategory;

  const haystack = `${trip.route_name} ${trip.notes ?? ""}`.toLowerCase();
  if (CRUISE_NAME_PATTERN.test(haystack)) {
    const cruise = categories.find((c) => CRUISE_NAME_PATTERN.test(c.categoryName));
    if (cruise) return cruise;
  }
  return null;
}

/**
 * Returns a Category id, or null when nothing confident could be decided
 * (no OpenAI configured, no categories exist, or the model declined) — the
 * trip is then simply left uncategorized, same as before this feature.
 */
export async function classifyTripCategory(
  client: PoolClient,
  trip: TravelTrip,
): Promise<string | null> {
  const categories = await fetchCategories(client);
  if (categories.length === 0) return null;

  const ruled = ruleBasedGuess(trip, categories);
  if (ruled) return ruled.id;

  const itinerary = summarizeItinerary(trip);
  const categoryList = categories.map((c) => `- ${c.categoryName}`).join("\n");
  const prompt = [
    "Read this Mongolian tour agency itinerary and decide which ONE category it belongs to.",
    "Reply with ONLY the exact category name text, copied character-for-character from the list — nothing else, no punctuation, no explanation.",
    "If genuinely none fit, reply with exactly: NONE",
    "",
    "Categories:",
    categoryList,
    "",
    "How to decide (use the itinerary text, not the title alone):",
    "- If travel between cities/border towns is by TRAIN or BUS the whole way (mentions Замын-Үүд, Эрээн, галт тэрэг, автобус, no flights), it is a land trip (газрын аялал / land).",
    "- If the trip is a direct international FLIGHT with no long train/bus legs, it is a flight trip (шууд нислэгтэй / flight).",
    "- If it genuinely combines both — e.g. train/bus to a border town THEN a domestic flight onward (Хөх хот, Чанша, Чунчин нислэг) — it is a combined trip (хосолсон / combined).",
    "- If it is a cruise ship / усан онгоц voyage, it is the cruise category.",
    "",
    `Trip title: ${trip.route_name}`,
    `Duration: ${trip.duration_text}`,
    `Departure dates as written: ${trip.departure_dates.join(", ") || "(none)"}`,
    "Itinerary:",
    itinerary || "(no day-by-day text available)",
  ].join("\n");

  let text: string;
  try {
    const result = await askOpenAIParts([{ text: prompt }], {
      source: "websiteTripSync.classifyCategory",
      timeoutMs: 15_000,
      maxOutputTokens: 60,
      temperature: 0,
    });
    text = result.text.trim();
  } catch {
    return null;
  }

  if (!text || /^NONE$/i.test(text)) return null;
  const normalized = text.trim().toLowerCase();
  const matched = categories.find((c) => c.categoryName.trim().toLowerCase() === normalized);
  return matched?.id ?? null;
}
