/**
 * Fast-path helpers that answer common queries directly from the DB without
 * calling the AI — faster and more accurate than Gemini for structured data.
 *
 * Feature 2: Seats availability — instant seats_left lookup
 * Feature 3: Trip comparison — side-by-side structured reply
 */

import type { TravelTrip } from "./travelOps";

// ─── Seats fast-path (Feature 2) ────────────────────────────────────────────

const SEATS_KEYWORDS_MN = [
  "суудал",
  "зай",
  "хоосон",
  "үлдсэн",
  "бий юу",
  "бий эсэх",
  "хүрэлцэх",
];
const SEATS_KEYWORDS_EN = ["seat", "seats", "available", "left", "space", "vacancy"];

function normText(t: string) {
  return t.toLowerCase().replace(/[^\wа-яөүё\s]/gi, " ");
}

export function hasSeatsIntent(text: string): boolean {
  const n = normText(text);
  const hasMn = SEATS_KEYWORDS_MN.some((k) => n.includes(k));
  const hasEn = SEATS_KEYWORDS_EN.some((k) => n.includes(k));
  return hasMn || hasEn;
}

/**
 * If the user asks about seat availability and exactly one active trip matches
 * the message text, return a direct answer from the DB.
 * Returns null when ambiguous (>1 trips) or no seats data is present — in
 * those cases, fall through to the AI.
 */
export function buildSeatsReply(text: string, trips: TravelTrip[]): string | null {
  const n = normText(text);
  const activeTrips = trips.filter((t) => t.status === "active");

  // Find trips whose route_name appears in the user's message
  const matched = activeTrips.filter((t) => {
    const routeNorm = normText(t.route_name);
    // Match if any word from the route name (≥3 chars) appears in the message
    return routeNorm
      .split(/\s+/)
      .filter((w) => w.length >= 3)
      .some((w) => n.includes(w));
  });

  if (matched.length === 0 || matched.length > 3) return null;

  const lines: string[] = [];
  for (const trip of matched) {
    if (trip.seats_left === null) {
      lines.push(`${trip.route_name}: суудлын мэдээлэл одоогоор байхгүй байна.`);
    } else if (trip.seats_left === 0 || trip.status === "sold_out") {
      lines.push(`${trip.route_name}: суудал дүүрсэн байна.`);
    } else {
      lines.push(`${trip.route_name}: ${trip.seats_left} суудал үлдсэн байна.`);
    }
  }
  return lines.join("\n");
}

// ─── Trip comparison (Feature 3) ────────────────────────────────────────────

const COMPARE_KEYWORDS_MN = [
  "харьцуул",
  "ялгаа",
  "аль нь дээр",
  "аль нь сайн",
  "ялгаатай",
  "зэрэгцүүл",
  "vs",
];
const COMPARE_KEYWORDS_EN = ["compare", "comparison", "vs", "versus", "difference", "better"];

export function hasCompareIntent(text: string): boolean {
  const n = normText(text);
  const hasMn = COMPARE_KEYWORDS_MN.some((k) => n.includes(k));
  const hasEn = COMPARE_KEYWORDS_EN.some((k) => n.includes(k));
  return hasMn || hasEn;
}

/**
 * Finds up to 4 trips mentioned in the user's message and returns a
 * formatted side-by-side comparison.
 * Returns null if fewer than 2 trips can be identified.
 */
export function buildCompareReply(text: string, trips: TravelTrip[]): string | null {
  const n = normText(text);
  const activeTrips = trips.filter((t) => t.status === "active");

  const matched = activeTrips.filter((t) => {
    const routeNorm = normText(t.route_name);
    return routeNorm
      .split(/\s+/)
      .filter((w) => w.length >= 3)
      .some((w) => n.includes(w));
  });

  if (matched.length < 2) return null;
  const candidates = matched.slice(0, 4);

  const lines: string[] = ["📊 Аялал харьцуулалт:"];
  lines.push("");

  for (const t of candidates) {
    const price = t.adult_price ?? null;
    lines.push(`▶ ${t.route_name}`);
    lines.push(`  Үнэ (насанд хүрэгчид): ${price != null ? `${price.toLocaleString()} ${t.currency || "₮"}` : "тодорхойгүй"}`);
    lines.push(`  Хугацаа: ${t.duration_text || "тодорхойгүй"}`);
    lines.push(`  Хоол: ${t.has_food === true ? "Тийм ✓" : t.has_food === false ? "Үгүй" : "тодорхойгүй"}`);
    if (t.departure_dates && t.departure_dates.length > 0) {
      lines.push(`  Гарах өдрүүд: ${t.departure_dates.slice(0, 3).join(", ")}${t.departure_dates.length > 3 ? " …" : ""}`);
    }
    if (t.seats_left !== null) {
      lines.push(`  Үлдсэн суудал: ${t.seats_left}`);
    }
    lines.push("");
  }

  lines.push("Дэлгэрэнгүй мэдээлэл эсвэл захиалга хийхийн тулд манай ажилтантай холбогдоорой.");
  return lines.join("\n");
}
