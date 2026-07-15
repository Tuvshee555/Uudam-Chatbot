import type { TravelTrip } from "../travelTypes";
import { suggestTripByAI } from "./aiMatch";
import {
  normalizeFilenameForMatch,
  normalizeTripName,
  tokenCoverageScore,
} from "./normalize";
import { type MatchConfidence, type MatchResult } from "./types";

function tripAliases(trip: TravelTrip): string[] {
  const aliases = trip.extra?.aliases;
  return Array.isArray(aliases)
    ? aliases.filter((alias): alias is string => typeof alias === "string")
    : [];
}

function scoreToConfidence(score: number): MatchConfidence {
  if (score >= 0.9) return "high";
  if (score >= 0.7) return "medium";
  if (score > 0) return "low";
  return "none";
}

type TransportVariant = "air" | "ground" | "combined" | "rail";

function transportVariant(value: string): TransportVariant | null {
  const normalized = normalizeTripName(value);
  if (/хосол|combined|combo/.test(normalized)) return "combined";
  if (/галт\s*тэрэг|train|rail/.test(normalized)) return "rail";
  if (/нис(?:лэг|эх|эхийн|лэгтэй)?|онгоц|flight|air/.test(normalized)) return "air";
  if (/газ(?:ар|рын)|автобус|bus|coach/.test(normalized)) return "ground";
  return null;
}

function durationDays(value: string): number | null {
  const match = normalizeTripName(value).match(/\b(\d{1,2})\s*(?:өдөр|хоног|days?)\b/);
  return match ? Number(match[1]) : null;
}

function dateKeys(value: string): Set<string> {
  const normalized = normalizeTripName(value);
  const keys = new Set<string>();
  const add = (month: string, day: string) => {
    const monthNumber = Number(month);
    const dayNumber = Number(day);
    if (monthNumber >= 1 && monthNumber <= 12 && dayNumber >= 1 && dayNumber <= 31) {
      keys.add(`${monthNumber}-${dayNumber}`);
    }
  };
  for (const match of normalized.matchAll(/\b20\d{2}[-/.](\d{1,2})[-/.](\d{1,2})\b/g)) {
    add(match[1], match[2]);
  }
  for (const match of normalized.matchAll(/\b(\d{1,2})[-/.](\d{1,2})\b/g)) {
    add(match[1], match[2]);
  }
  for (const match of normalized.matchAll(/\b(\d{1,2})\s*сар(?:ын)?\s*(\d{1,2})\b/g)) {
    add(match[1], match[2]);
  }
  return keys;
}

function sharesAny<T>(left: Set<T>, right: Set<T>): boolean {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function emptyMatch(reason = "Тохирох аялал олдсонгүй"): MatchResult {
  return {
    tripId: null,
    tripName: "",
    confidence: "none",
    score: 0,
    matchedBy: "none",
    reason,
  };
}

const MIN_FUZZY_SCORE = 0.35;
const MIN_UNIQUE_MARGIN = 0.08;

export function matchImportItemToTrips(
  itemName: string,
  trips: TravelTrip[],
): MatchResult {
  const normalizedItem = normalizeFilenameForMatch(itemName);
  if (!normalizedItem || trips.length === 0) return emptyMatch();

  const itemVariant = transportVariant(itemName);
  const itemDuration = durationDays(itemName);
  const itemDates = dateKeys(itemName);

  const ranked = trips.map((trip) => {
    const names = [trip.route_name, ...tripAliases(trip)];
    let score = 0;
    let matchedBy: MatchResult["matchedBy"] = "fuzzy";
    let evidence = "түлхүүр үг";

    names.forEach((name, index) => {
      const normalizedName = normalizeTripName(name);
      if (normalizedName.length < 3) return;
      let nameScore = tokenCoverageScore(itemName, name);
      let nameMatchedBy: MatchResult["matchedBy"] = "fuzzy";
      if (normalizedItem === normalizedName) {
        nameScore = 1;
        nameMatchedBy = "exact";
      } else if (normalizedItem.includes(normalizedName)) {
        nameScore = Math.max(nameScore, index === 0 ? 0.94 : 0.92);
        nameMatchedBy = index === 0 ? "exact" : "alias";
      } else if (normalizedName.includes(normalizedItem)) {
        // A shortened folder title is useful, but ranks below a complete name.
        // The cross-trip margin check below prevents this from choosing an
        // arbitrary sibling when several routes contain the same short title.
        nameScore = Math.max(nameScore, 0.9);
        nameMatchedBy = "exact";
      }
      if (nameScore > score) {
        score = nameScore;
        matchedBy = nameMatchedBy;
        evidence = index === 0 ? "аяллын нэр" : `хоч нэр “${name}”`;
      }
    });

    const tripIdentity = [
      trip.route_name,
      trip.duration_text,
      ...(trip.departure_dates || []),
    ].join(" ");
    const tripVariant = transportVariant(tripIdentity);
    const tripDuration = durationDays(tripIdentity);
    const tripDates = dateKeys(tripIdentity);

    if (itemVariant && tripVariant) {
      score += itemVariant === tripVariant ? 0.08 : -0.22;
      evidence += itemVariant === tripVariant ? ", тээврийн төрөл" : ", тээврийн төрөл зөрсөн";
    }
    if (itemDuration && tripDuration) {
      score += itemDuration === tripDuration ? 0.08 : -0.18;
      evidence += itemDuration === tripDuration ? ", хоног" : ", хоног зөрсөн";
    }
    if (itemDates.size > 0 && tripDates.size > 0) {
      score += sharesAny(itemDates, tripDates) ? 0.1 : -0.2;
      evidence += sharesAny(itemDates, tripDates) ? ", огноо" : ", огноо зөрсөн";
    }

    score = Math.max(0, Math.min(1, score));
    return {
      trip,
      match: {
        tripId: trip.id,
        tripName: trip.route_name,
        confidence: scoreToConfidence(score),
        score,
        matchedBy,
        reason: `${evidence} таарсан (${Math.round(score * 100)}%)`,
      } satisfies MatchResult,
    };
  }).sort((left, right) => right.match.score - left.match.score);

  const best = ranked[0]?.match;
  if (!best || best.score < MIN_FUZZY_SCORE) return emptyMatch();

  const second = ranked[1]?.match;
  if (second && second.score >= MIN_FUZZY_SCORE && best.score - second.score < MIN_UNIQUE_MARGIN) {
    return emptyMatch(
      `Олон аялалтай адилхан байна: ${best.tripName}, ${second.tripName}. Хавтасны нэрэнд тээврийн төрөл, хоног эсвэл огноо нэмнэ үү.`,
    );
  }

  return best;
}

export async function matchImportItemToTripsWithAI(
  itemName: string,
  trips: TravelTrip[],
): Promise<MatchResult> {
  const deterministic = matchImportItemToTrips(itemName, trips);
  if (deterministic.score >= 0.6) return deterministic;
  // AI sees the same filename, not the image. It cannot safely break a tie
  // between sibling products that the filename itself does not distinguish.
  if (deterministic.reason.startsWith("Олон аялалтай")) return deterministic;

  const ai = await suggestTripByAI(itemName, trips);
  if (ai?.tripId && ai.confidence >= 0.5) {
    return {
      tripId: ai.tripId,
      tripName: ai.tripName,
      confidence: scoreToConfidence(ai.confidence),
      score: ai.confidence,
      matchedBy: "ai",
      reason: `AI санал: ${ai.reason}`,
    };
  }

  return deterministic;
}
