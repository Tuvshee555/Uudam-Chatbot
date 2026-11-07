/**
 * The per-trip review table the admin shows before anything is generated.
 *
 * Everything here is computed live on the request: titles, prices, dates and photos come from the
 * chatbot's trip store through the same snapshot builder the PDF uses, so what staff review is
 * exactly what would be printed. Nothing computed here is persisted.
 */

import type { TravelTrip } from "../../travelTypes";
import type {
  CatalogueEdition,
  CatalogueEditionConfig,
  CatalogueSnapshot,
  CatalogueTripCard,
  CatalogueWarning,
  IsoDay,
} from "../types";
import { isProvisionalCode } from "../diagnostics";
import type { CatalogueDataPort } from "./deps";
import type { CatalogueReviewResponse, CatalogueReviewRow, CatalogueReviewWarning } from "./types";

const SEVERITY_RANK = { blocking: 3, warning: 2, info: 1 } as const;

const PHOTO_SOURCE_LABEL: Record<string, string> = {
  poster_hero: "Постерын гол зураг",
  trip_photo: "Аяллын зураг",
  poster_day: "Постерын өдрийн зураг",
};

function toReviewWarnings(warnings: CatalogueWarning[]): CatalogueReviewWarning[] {
  return [...warnings]
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
    .map((w) => ({ code: w.code, severity: w.severity, message: w.message }));
}

function worstSeverity(warnings: CatalogueReviewWarning[]): CatalogueReviewRow["severity"] {
  let best = 0;
  let label: CatalogueReviewRow["severity"] = "ok";
  for (const w of warnings) {
    const rank = SEVERITY_RANK[w.severity];
    if (rank > best) {
      best = rank;
      label = w.severity;
    }
  }
  return label;
}

function priceSource(card: CatalogueTripCard): Pick<CatalogueReviewRow, "priceSource" | "priceSourceLabel"> {
  if (card.price.kind === "inquire") {
    return { priceSource: "none", priceSourceLabel: "Найдвартай үнэ олдсонгүй: «Үнэ лавлах» гэж харуулна" };
  }
  if (card.price.date) {
    return { priceSource: "dated_fare", priceSourceLabel: `Огнооны үнийн хүснэгт (${card.price.date})` };
  }
  return { priceSource: "trip_price", priceSourceLabel: "Аяллын үндсэн үнэ (огноогүй)" };
}

/** A stored trip code, or null for a missing one or an in-memory placeholder of a read-only load. */
function realCode(code: string | null | undefined): string | null {
  return code && !isProvisionalCode(code) ? code : null;
}

export type ReviewInput = {
  edition: CatalogueEdition;
  today: IsoDay;
  activeTrips: TravelTrip[];
  /** Snapshot of EVERY eligible trip (staff exclusions removed) so excluded trips still show their facts. */
  snapshot: CatalogueSnapshot;
  eligibility: Map<string, { eligible: boolean; reason: string | null }>;
  config: CatalogueEditionConfig;
  codeMap: Record<string, string>;
};

/** Pure: same input, same rows. */
export function buildReviewRows(input: ReviewInput): CatalogueReviewResponse {
  const cards = new Map(input.snapshot.trips.map((card) => [card.tripId, card]));
  const groupLabels = new Map(input.snapshot.groups.map((group) => [group.key, group.label]));
  const positions = new Map(input.config.tripIds.map((id, index) => [id, index + 1]));
  const featured = new Set(input.config.featuredTripIds);
  const excluded = new Set(input.config.excludedTripIds);
  const isComplete = input.edition === "complete";

  const rows: CatalogueReviewRow[] = input.activeTrips.map((trip) => {
    const card = cards.get(trip.id);
    const eligibility = input.eligibility.get(trip.id) ?? { eligible: false, reason: null };
    const eligible = eligibility.eligible && Boolean(card);
    const warnings = toReviewWarnings(card?.warnings ?? []);
    if (eligibility.eligible && !card) {
      warnings.push({
        code: "other",
        severity: "warning",
        message: "Аялал каталогийн өгөгдөлд орж ирсэнгүй. Дахин ачаална уу.",
      });
    }
    const position = positions.get(trip.id) ?? null;
    const isExcluded = excluded.has(trip.id);
    return {
      tripId: trip.id,
      code: realCode(card?.code ?? input.codeMap[trip.id]),
      title: card?.title ?? trip.route_name,
      groupKey: card?.groupKey ?? null,
      groupLabel: card ? groupLabels.get(card.groupKey) ?? card.groupKey : null,
      durationText: card?.durationText ?? trip.duration_text,
      transportLabel: card?.transportLabel ?? null,
      eligible,
      eligibilityReason: eligible ? null : eligibility.reason ?? "Каталогт тохиромжгүй",
      priceDisplay: card ? card.price.display : null,
      priceAmountMnt: card && card.price.kind === "from" ? card.price.amountMnt : null,
      priceDate: card && card.price.kind === "from" ? card.price.date : null,
      ...(card ? priceSource(card) : { priceSource: "none" as const, priceSourceLabel: "Үнэ тооцоолоогүй" }),
      nextDeparture: card?.dates.nextDeparture ?? null,
      departureCount: card?.dates.departures.length ?? 0,
      dateLabel: card?.dates.label ?? null,
      photo: card?.photo
        ? { url: card.photo.url, source: card.photo.source, width: card.photo.width, height: card.photo.height }
        : null,
      photoSourceLabel: card?.photo ? PHOTO_SOURCE_LABEL[card.photo.source] ?? card.photo.source : "Зураггүй: орлуулагч хэрэглэнэ",
      warnings,
      severity: worstSeverity(warnings),
      selected: isComplete ? eligible && !isExcluded : position !== null,
      position,
      featured: featured.has(trip.id),
      excluded: isExcluded,
      groupOverride: input.config.groupOverrides[trip.id] ?? null,
    };
  });

  // Stable, useful order: curated position first, then code, then title.
  rows.sort((a, b) => {
    if (a.position !== null || b.position !== null) {
      if (a.position === null) return 1;
      if (b.position === null) return -1;
      return a.position - b.position;
    }
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (a.code === null && b.code !== null) return 1;
    if (b.code === null && a.code !== null) return -1;
    return (a.code ?? "").localeCompare(b.code ?? "") || a.title.localeCompare(b.title);
  });

  const eligibleRows = rows.filter((row) => row.eligible);
  return {
    ok: true,
    edition: input.edition,
    today: input.today,
    rows,
    groups: input.snapshot.groups.map((group) => ({ key: group.key, label: group.label })),
    counts: {
      active: rows.length,
      eligible: eligibleRows.length,
      blocking: eligibleRows.filter((row) => row.severity === "blocking").length,
      warning: eligibleRows.filter((row) => row.severity === "warning").length,
    },
  };
}

/** Loads live data through the DATA port and builds the review. Impure: reads the trip store. */
export async function loadReview(params: {
  edition: CatalogueEdition;
  nowIso: string;
  today: IsoDay;
  activeTrips: TravelTrip[];
  /** The staff curation of the requested edition (from the store's config). */
  editionConfig: CatalogueEditionConfig;
  data: CatalogueDataPort;
}): Promise<CatalogueReviewResponse> {
  const { data, activeTrips, today } = params;
  const eligibility = new Map(activeTrips.map((trip) => [trip.id, data.isTripEligible(trip, today)]));
  // Edition "complete" supplies every eligible trip; staff exclusions are lifted so the table
  // can still explain an excluded trip's price, date and photo.
  // readOnlyCodes: this table is served on GET, which the read-only API token may call, so it must
  // never allocate permanent trip codes. Trips without a code are shown with a null code.
  const base = await data.loadSnapshotInput("complete", { nowIso: params.nowIso, readOnlyCodes: true });
  const snapshot = data.buildCatalogueSnapshot({
    ...base,
    // Staff exclusions are lifted; the groups shown are the ones THIS edition would print.
    config: { ...base.config, groupOverrides: params.editionConfig.groupOverrides, excludedTripIds: [] },
  });
  return buildReviewRows({
    edition: params.edition,
    today,
    activeTrips,
    snapshot,
    eligibility,
    config: params.editionConfig,
    codeMap: base.codeMap,
  });
}
