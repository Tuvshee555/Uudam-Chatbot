import type { TravelTrip } from "../travelTypes";
import { suggestTripByAI } from "./aiMatch";
import {
  keywordTokens,
  normalizeFilenameForMatch,
  normalizeTripName,
  tokenCoverageScore,
} from "./normalize";
import { type MatchConfidence, type MatchResult } from "./types";

function tripAliases(trip: TravelTrip): string[] {
  const aliases = trip.extra?.aliases;
  return Array.isArray(aliases) ? aliases.filter((a): a is string => typeof a === "string") : [];
}

function allTripNames(trip: TravelTrip): string[] {
  return [trip.route_name, ...tripAliases(trip)];
}

function scoreToConfidence(score: number): MatchConfidence {
  if (score >= 0.9) return "high";
  if (score >= 0.7) return "medium";
  if (score > 0) return "low";
  return "none";
}

const MIN_FUZZY_SCORE = 0.35;

export function matchImportItemToTrips(
  itemName: string,
  trips: TravelTrip[],
): MatchResult {
  const normalizedItem = normalizeFilenameForMatch(itemName);
  const itemTokens = keywordTokens(itemName);

  let best: MatchResult = {
    tripId: null,
    tripName: "",
    confidence: "none",
    score: 0,
    matchedBy: "none",
    reason: "Тохирох аялал олдсонгүй",
  };

  for (const trip of trips) {
    const names = allTripNames(trip);

    // 1. Exact normalized match on route or alias
    for (const name of names) {
      const normalizedName = normalizeTripName(name);
      if (
        normalizedName.length >= 3 &&
        (normalizedItem === normalizedName ||
          normalizedItem.includes(normalizedName) ||
          normalizedName.includes(normalizedItem))
      ) {
        const score = normalizedItem === normalizedName ? 1 : 0.95;
        if (score > best.score) {
          best = {
            tripId: trip.id,
            tripName: trip.route_name,
            confidence: scoreToConfidence(score),
            score,
            matchedBy: "exact",
            reason: `"${itemName}" нэрээр яг таарлаа`,
          };
        }
      }
    }

    // 2. Alias exact match (already covered above by allTripNames; keep explicit for clarity)
    for (const alias of tripAliases(trip)) {
      const normalizedAlias = normalizeTripName(alias);
      if (
        normalizedAlias.length >= 3 &&
        normalizedItem.includes(normalizedAlias)
      ) {
        const score = 0.92;
        if (score > best.score) {
          best = {
            tripId: trip.id,
            tripName: trip.route_name,
            confidence: "high",
            score,
            matchedBy: "alias",
            reason: `Хоч нэр "${alias}" таарлаа`,
          };
        }
      }
    }

    // 3. Fuzzy token coverage
    const fuzzyScores = names.map((name) => tokenCoverageScore(itemName, name));
    const fuzzyScore = Math.max(0, ...fuzzyScores);
    if (fuzzyScore > best.score) {
      best = {
        tripId: trip.id,
        tripName: trip.route_name,
        confidence: scoreToConfidence(fuzzyScore),
        score: fuzzyScore,
        matchedBy: "fuzzy",
        reason: `Түлхүүр үгийн тааруулалт (${Math.round(fuzzyScore * 100)}%)`,
      };
    }

    // Boost when item tokens are a subset of route tokens or vice versa
    if (itemTokens.length >= 2) {
      const routeTokens = new Set(keywordTokens(trip.route_name));
      const aliasTokens = tripAliases(trip).flatMap((a) => keywordTokens(a));
      const allTripTokens = new Set([...routeTokens, ...aliasTokens]);
      const overlap = itemTokens.filter((t) => allTripTokens.has(t)).length;
      const coverage = overlap / Math.max(itemTokens.length, allTripTokens.size);
      if (coverage > best.score) {
        best = {
          tripId: trip.id,
          tripName: trip.route_name,
          confidence: scoreToConfidence(coverage),
          score: coverage,
          matchedBy: "fuzzy",
          reason: `Түлхүүр үгийн давхцал (${Math.round(coverage * 100)}%)`,
        };
      }
    }
  }

  if (best.score < MIN_FUZZY_SCORE) {
    return {
      tripId: null,
      tripName: "",
      confidence: "none",
      score: 0,
      matchedBy: "none",
      reason: "Тохирох аялал олдсонгүй",
    };
  }

  return best;
}

export async function matchImportItemToTripsWithAI(
  itemName: string,
  trips: TravelTrip[],
): Promise<MatchResult> {
  const deterministic = matchImportItemToTrips(itemName, trips);
  if (deterministic.score >= 0.6) return deterministic;

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
