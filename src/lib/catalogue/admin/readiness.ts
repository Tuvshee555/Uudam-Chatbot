/**
 * The "before publishing" checklist shown in the catalogue tab's header and returned by /state.
 *
 * Pure builder (buildReadiness) over facts the route gathers; nothing here is stored and nothing
 * launches a browser. Every item is green / amber / red with ONE Mongolian line saying what was
 * found and ONE saying what to do next. Red = fix before publishing, amber = look at it, green = fine.
 *
 * Trip codes are only COUNTED (never allocated or recomputed): they are persistent per trip id in
 * the store (codes.ts) and the review rows already carry the stored value.
 */

import type { CatalogueConfig, CatalogueEditionConfig } from "../types";
import type { CatalogueTesterView } from "../testers";
import type {
  CatalogueEditionState,
  CatalogueReadiness,
  CatalogueReadinessCounts,
  CatalogueReadinessItem,
  CatalogueReadinessStatus,
  CatalogueReviewResponse,
} from "./types";

/** What the trip review says, reduced to the numbers the checklist needs. Null when the review could not be read. */
export type ReadinessTripFacts = {
  eligible: number;
  heroWeak: number;
  heroMissing: number;
  /** Weak or missing heroes among the trips Quick prints (the staff list, else every eligible trip). */
  quickHeroesFlagged: number;
  codesAllocated: number;
  transportConflicts: number;
  durationConflicts: number;
  priceConflicts: number;
};

export type ReadinessInput = {
  database: { ok: boolean };
  /** Missing renderer files (repo-relative); null = the check itself failed. */
  missingAssets: string[] | null;
  editions: { quick: CatalogueEditionState; complete: CatalogueEditionState };
  testers: CatalogueTesterView[];
  testersError: boolean;
  envRecipients: number;
  metaOutboundDisabled: boolean;
  config: Pick<CatalogueConfig, "heroByTripId" | "coverPhoto">;
  trips: ReadinessTripFacts | null;
};

const RANK: Record<CatalogueReadinessStatus, number> = { green: 0, amber: 1, red: 2 };

export function worstStatus(statuses: CatalogueReadinessStatus[]): CatalogueReadinessStatus {
  return statuses.reduce<CatalogueReadinessStatus>((worst, status) => (RANK[status] > RANK[worst] ? status : worst), "green");
}

/** Pure: the review rows -> the checklist's trip facts. `quickConfig` decides which trips Quick would print. */
export function tripFactsFromReview(review: CatalogueReviewResponse, quickConfig: CatalogueEditionConfig): ReadinessTripFacts {
  const eligible = review.rows.filter((row) => row.eligible);
  const flagged = (row: { heroQuality: string }) => row.heroQuality === "weak" || row.heroQuality === "missing";
  const excluded = new Set(quickConfig.excludedTripIds);
  const quickPrinted = quickConfig.tripIds.length > 0
    ? eligible.filter((row) => quickConfig.tripIds.includes(row.tripId))
    : eligible.filter((row) => !excluded.has(row.tripId));
  const has = (code: string) => (row: { warnings: Array<{ code: string }> }) => row.warnings.some((warning) => warning.code === code);
  return {
    eligible: eligible.length,
    heroWeak: eligible.filter((row) => row.heroQuality === "weak").length,
    heroMissing: eligible.filter((row) => row.heroQuality === "missing").length,
    quickHeroesFlagged: quickPrinted.filter(flagged).length,
    codesAllocated: eligible.filter((row) => row.code !== null).length,
    transportConflicts: eligible.filter(has("transport_conflict")).length,
    durationConflicts: eligible.filter(has("duration_conflict")).length,
    priceConflicts: eligible.filter(has("price_conflict")).length,
  };
}

const EDITION_NAME = { quick: "Хурдан каталог", complete: "Бүрэн каталог" } as const;

function publishedItem(edition: "quick" | "complete", state: CatalogueEditionState): CatalogueReadinessItem {
  const id = edition === "quick" ? "published_quick" : "published_complete";
  const label = `${EDITION_NAME[edition]}: нийтлэгдсэн хувилбар`;
  const { published, freshness } = state;
  if (!published) {
    return {
      id, label, status: "amber",
      detail: state.latestDraft ? `Нийтлээгүй. Ноорог v${state.latestDraft.versionNo} байна.` : "Нийтлэгдсэн хувилбар алга.",
      next: "«Үүсгэх ба нийтлэх» хэсгээс үүсгэж, шалгаад нийтэлнэ үү.",
    };
  }
  const age = freshness.ageDays === null ? "" : ` · ${freshness.ageDays} хоногийн настай`;
  if (freshness.status === "stale") {
    return {
      id, label, status: "red",
      detail: `v${published.versionNo} хуучирсан${age}${freshness.reasons[0] ? `: ${freshness.reasons[0]}` : "."}`,
      next: "Шинэ хувилбар үүсгэж нийтэлнэ үү. Хуучирсан файлыг бот илгээхгүй.",
    };
  }
  if (freshness.status === "unknown") {
    return {
      id, label, status: "amber",
      detail: `v${published.versionNo}${age}: шинэ эсэхийг шалгаж чадсангүй.`,
      next: "Хуудсаа шинэчилнэ үү. Үргэлжилбэл аяллын сан холбогдож байгаа эсэхийг шалгана уу.",
    };
  }
  return { id, label, status: "green", detail: `v${published.versionNo} нийтлэгдсэн, шинэ${age}.`, next: null };
}

function testersItem(input: ReadinessInput, counts: CatalogueReadinessCounts): CatalogueReadinessItem {
  const label = "Баталгаажсан тестер";
  if (input.testersError) {
    return { id: "testers", label, status: "amber", detail: "Тестерийн жагсаалтыг уншиж чадсангүй.", next: "Хуудсаа шинэчилнэ үү." };
  }
  if (counts.verifiedTesters === 0 && input.envRecipients === 0) {
    return {
      id: "testers", label, status: "amber", detail: "Тестер холбоогүй байна.",
      next: "«Туршилтын илгээлт» хэсэгт «Тестер холбох» дарж кодыг Messenger-ээс бичнэ үү.",
    };
  }
  if (counts.openWindowTesters === 0 && input.envRecipients === 0) {
    return {
      id: "testers", label, status: "amber",
      detail: `${counts.verifiedTesters} тестер холбогдсон, гэхдээ 24 цагийн цонх хаагдсан.`,
      next: "Тестер Page руу дахин бичнэ үү.",
    };
  }
  return {
    id: "testers", label, status: "green",
    detail: `${counts.verifiedTesters} тестер холбогдсон, ${counts.openWindowTesters} нь одоо хүлээн авч чадна (24 цагийн цонх нээлттэй).`,
    next: null,
  };
}

/** Pure. Same input, same checklist. */
export function buildReadiness(input: ReadinessInput): CatalogueReadiness {
  const { trips } = input;
  const counts: CatalogueReadinessCounts = {
    eligibleTrips: trips ? trips.eligible : null,
    verifiedTesters: input.testers.length,
    openWindowTesters: input.testers.filter((tester) => tester.windowOpen).length,
    heroesConfigured: Object.keys(input.config.heroByTripId ?? {}).length,
    heroesWeak: trips?.heroWeak ?? 0,
    heroesMissing: trips?.heroMissing ?? 0,
    quickHeroesFlagged: trips?.quickHeroesFlagged ?? 0,
    codesAllocated: trips ? trips.codesAllocated : null,
    transportConflicts: trips?.transportConflicts ?? 0,
    durationConflicts: trips?.durationConflicts ?? 0,
    priceConflicts: trips?.priceConflicts ?? 0,
    staleEditions: (["quick", "complete"] as const).filter((edition) => input.editions[edition].freshness.status === "stale").length,
  };
  const items: CatalogueReadinessItem[] = [];

  items.push(
    input.database.ok
      ? { id: "database", label: "Өгөгдлийн сан", status: "green", detail: "Холбогдсон, каталогийн хүснэгтүүд бэлэн.", next: null }
      : { id: "database", label: "Өгөгдлийн сан", status: "red", detail: "Өгөгдлийн сан эсвэл каталогийн хүснэгт бэлэн биш.", next: "Серверийн DATABASE_URL тохиргоог шалгаад хуудсаа шинэчилнэ үү." },
  );

  if (input.missingAssets === null) {
    items.push({ id: "renderer", label: "PDF үүсгэгчийн файлууд", status: "amber", detail: "Фонт, лого байгаа эсэхийг шалгаж чадсангүй.", next: "Хуудсаа шинэчилнэ үү." });
  } else if (input.missingAssets.length > 0) {
    items.push({
      id: "renderer", label: "PDF үүсгэгчийн файлууд", status: "red",
      detail: `${input.missingAssets.length} файл олдсонгүй: ${input.missingAssets.slice(0, 3).join(", ")}${input.missingAssets.length > 3 ? "…" : ""}`,
      next: "Фонт, логоны файлууд deploy-д орсон эсэхийг шалгана уу. Эс бөгөөс PDF үүсэхгүй.",
    });
  } else {
    items.push({ id: "renderer", label: "PDF үүсгэгчийн файлууд", status: "green", detail: "Фонт болон лого байна. Хөтөч (Chromium) эндээс ажиллуулагдахгүй: үүсгэх үед шалгагдана.", next: null });
  }

  items.push(publishedItem("quick", input.editions.quick), publishedItem("complete", input.editions.complete));
  items.push(testersItem(input, counts));

  items.push(
    input.metaOutboundDisabled
      ? { id: "meta_switch", label: "Meta илгээлт", status: "amber", detail: "Meta руу илгээх түр унтраалттай (өөрөө унтрааснаас эсвэл туршилтын орчин байгаагаас).", next: "Зөвхөн дээж (dry-run) ажиллана. Жинхэнэ туршилт хийх бол асаах шаардлагатай." }
      : { id: "meta_switch", label: "Meta илгээлт", status: "green", detail: "Илгээх боломжтой (унтраалт идэвхгүй).", next: null },
  );

  if (!trips) {
    items.push({ id: "heroes", label: "Аяллын гол зураг", status: "amber", detail: "Аяллын зургийг шалгаж чадсангүй.", next: "Хуудсаа шинэчилнэ үү." });
  } else if (counts.quickHeroesFlagged > 0) {
    items.push({
      id: "heroes", label: "Аяллын гол зураг", status: "red",
      detail: `Хурдан каталогт хэвлэгдэх ${counts.quickHeroesFlagged} аяллын зураг сул эсвэл алга (нийт ${counts.heroesWeak + counts.heroesMissing} аялал). Гараар сонгосон: ${counts.heroesConfigured}.`,
      next: "«Зураг ба гарчиг» хэсэгт эдгээрт зураг сонгоно уу.",
    });
  } else if (counts.heroesWeak + counts.heroesMissing > 0) {
    items.push({
      id: "heroes", label: "Аяллын гол зураг", status: "amber",
      detail: `${counts.heroesWeak + counts.heroesMissing} аяллын зураг сул эсвэл алга (Хурдан каталогт орохгүй). Гараар сонгосон: ${counts.heroesConfigured}.`,
      next: "Бүрэн каталог нийтлэхээс өмнө «Зураг ба гарчиг» хэсэгт солино уу.",
    });
  } else {
    items.push({ id: "heroes", label: "Аяллын гол зураг", status: "green", detail: `Бүх аяллын зураг хэвлэхэд тохиромжтой. Гараар сонгосон: ${counts.heroesConfigured}.`, next: null });
  }

  items.push(
    input.config.coverPhoto
      ? { id: "cover", label: "Нүүр зураг", status: "green", detail: "Нүүр зургийг гараар сонгосон.", next: null }
      : { id: "cover", label: "Нүүр зураг", status: "amber", detail: "Нүүр зургийг сонгоогүй: автоматаар хуудсанд ороогүй хамгийн сайн зургийг авна.", next: "«Зураг ба гарчиг» хэсгээс нүүр зургаа сонговол илүү найдвартай." },
  );

  if (!trips) {
    items.push({ id: "codes", label: "Аяллын код", status: "amber", detail: "Кодыг шалгаж чадсангүй.", next: "Хуудсаа шинэчилнэ үү." });
  } else {
    const missing = trips.eligible - trips.codesAllocated;
    items.push(
      missing > 0
        ? { id: "codes", label: "Аяллын код", status: "amber", detail: `${trips.codesAllocated}/${trips.eligible} аялалд байнгын код олгосон.`, next: "Кодгүй аялал каталог үүсгэх үед автоматаар код авна (A01, A02… хэзээ ч солигдохгүй)." }
        : { id: "codes", label: "Аяллын код", status: "green", detail: `${trips.codesAllocated}/${trips.eligible} аялалд байнгын код олгосон. Хэвлэл бүрт ижил.`, next: null },
    );
  }

  if (!trips) {
    items.push({ id: "data_conflicts", label: "Өгөгдлийн зөрүү", status: "amber", detail: "Зөрүүг шалгаж чадсангүй.", next: "Хуудсаа шинэчилнэ үү." });
  } else {
    const total = counts.transportConflicts + counts.durationConflicts + counts.priceConflicts;
    const parts = [
      counts.priceConflicts ? `үнэ ${counts.priceConflicts}` : "",
      counts.transportConflicts ? `тээвэр ${counts.transportConflicts}` : "",
      counts.durationConflicts ? `хугацаа ${counts.durationConflicts}` : "",
    ].filter(Boolean);
    items.push(
      counts.priceConflicts > 0
        ? { id: "data_conflicts", label: "Өгөгдлийн зөрүү", status: "red", detail: `Зөрүүтэй аялал: ${parts.join(", ")}.`, next: "«Шалгалт» хэсэгт зөрүүтэй мөрийг нээж, аялал засварлагч дээр үнийг засна уу." }
        : total > 0
          ? { id: "data_conflicts", label: "Өгөгдлийн зөрүү", status: "amber", detail: `Гарчиг/програм бүртгэлтэй зөрсөн: ${parts.join(", ")}. Зөрсөн тээврийг PDF-д хэвлэхгүй.`, next: "«Шалгалт» хэсэгт зөрүүтэй мөрийг нээж, аялал засварлагч дээр шалгана уу." }
          : { id: "data_conflicts", label: "Өгөгдлийн зөрүү", status: "green", detail: "Үнэ, тээвэр, хугацааны зөрүү олдсонгүй.", next: null },
    );
  }

  return { overall: worstStatus(items.map((item) => item.status)), items, counts };
}
