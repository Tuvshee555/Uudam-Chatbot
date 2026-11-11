import { ensureOk } from "@/lib/adminUtils";
import { CATALOGUE_ADMIN_API, type CatalogueConfig, type CatalogueEdition, type CatalogueEditionConfig, type CatalogueHeroChoice } from "@/lib/catalogue/types";
import type {
  CatalogueAdminState,
  CatalogueCoverCandidatesResponse,
  CatalogueVersionTripsResponse,
  CataloguePairingResponse,
  CataloguePhotosResponse,
  CatalogueRecommendResponse,
  CatalogueTestersResponse,
  CatalogueReviewResponse,
  CatalogueStatsResponse,
  CatalogueTestSendResponse,
  CatalogueVersionView,
} from "@/lib/catalogue/admin/types";

export type ApiFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type GenerateSummary = {
  pages: number;
  sizeBytes: number;
  trips: number;
  blocking: number;
  warnings: number;
  /** Trips whose hero photo is weak or missing (to replace in the photo picker). */
  weakHeroes?: number;
  renderMs: number;
  durationMs: number;
};

const JSON_HEADERS = { "Content-Type": "application/json" };

function post(apiFetch: ApiFetch, path: string, body: unknown, method: "POST" | "PUT" = "POST") {
  return apiFetch(`${CATALOGUE_ADMIN_API}/${path}`, { method, headers: JSON_HEADERS, body: JSON.stringify(body) });
}

/** Thin typed client for /api/admin/catalogue/*. Every call throws the server's own Mongolian message on failure. */
export function createCatalogueApi(apiFetch: ApiFetch) {
  return {
    state: async () =>
      ensureOk<CatalogueAdminState>(await apiFetch(`${CATALOGUE_ADMIN_API}/state`), "Каталогийн төлөвийг ачаалж чадсангүй."),

    review: async (edition: CatalogueEdition) =>
      ensureOk<CatalogueReviewResponse>(
        await apiFetch(`${CATALOGUE_ADMIN_API}/trips?edition=${edition}`),
        "Аяллын шалгалтын жагсаалтыг ачаалж чадсангүй.",
      ),

    versions: async (limit = 30) =>
      ensureOk<{ versions: CatalogueVersionView[] }>(
        await apiFetch(`${CATALOGUE_ADMIN_API}/versions?limit=${limit}`),
        "Хувилбарын түүхийг ачаалж чадсангүй.",
      ),

    saveConfig: async (edition: CatalogueEdition, config: CatalogueEditionConfig, expectedUpdatedAt: string | null) =>
      ensureOk<{ config: CatalogueConfig; dropped: string[] }>(
        await post(apiFetch, "config", { edition, config, expectedUpdatedAt }, "PUT"),
        "Сонголтыг хадгалж чадсангүй.",
      ),

    generate: async (edition: CatalogueEdition) =>
      ensureOk<{ version: CatalogueVersionView; summary: GenerateSummary }>(
        await post(apiFetch, "generate", { edition }),
        "Каталог үүсгэж чадсангүй.",
      ),

    publish: async (versionId: string, acknowledgeWarnings: boolean) =>
      ensureOk<{ version: CatalogueVersionView }>(
        await post(apiFetch, "publish", { versionId, acknowledgeWarnings }),
        "Нийтэлж чадсангүй.",
      ),

    rollback: async (versionId: string) =>
      ensureOk<{ version: CatalogueVersionView }>(
        await post(apiFetch, "rollback", { versionId }),
        "Өмнөх хувилбар руу буцааж чадсангүй.",
      ),

    testers: async () =>
      ensureOk<CatalogueTestersResponse>(await apiFetch(`${CATALOGUE_ADMIN_API}/testers`), "Туршигчдын жагсаалтыг ачаалж чадсангүй."),

    /** "Тестер холбох": a one-time code to send to the Page from the staff member's own Messenger. */
    pairTester: async (label: string) =>
      ensureOk<CataloguePairingResponse>(await post(apiFetch, "testers", { label }), "Холбох код үүсгэж чадсангүй."),

    revokeTester: async (testerId: string) =>
      ensureOk<{ ok: true }>(await post(apiFetch, "testers/revoke", { testerId }), "Туршигчийн эрхийг цуцалж чадсангүй."),

    photos: async (tripId: string) =>
      ensureOk<CataloguePhotosResponse>(
        await apiFetch(`${CATALOGUE_ADMIN_API}/photos?tripId=${encodeURIComponent(tripId)}`),
        "Зургийн жагсаалтыг ачаалж чадсангүй.",
      ),

    /** hero: undefined leaves it, null clears the staff choice. titleOverride likewise. */
    savePhoto: async (input: { tripId: string; hero?: CatalogueHeroChoice | null; titleOverride?: string | null; expectedUpdatedAt: string | null }) =>
      ensureOk<{ config: CatalogueConfig; chosen: CatalogueHeroChoice | null; titleOverride: string | null }>(
        await post(apiFetch, "photos", input, "PUT"),
        "Зургийг хадгалж чадсангүй.",
      ),

    /** The best approved photos no trip page uses (bounded server-side search), for the cover chooser. */
    coverCandidates: async () =>
      ensureOk<CatalogueCoverCandidatesResponse>(
        await apiFetch(`${CATALOGUE_ADMIN_API}/photos?cover=1`),
        "Нүүр зургийн жагсаалтыг ачаалж чадсангүй.",
      ),

    /** The cover photograph: a trip's own photo (tripId names the trip) or null for the automatic one. */
    saveCover: async (input: { coverPhoto: { url: string; tripId: string; focal?: { x: number; y: number }; zoom?: number } | null; expectedUpdatedAt: string | null }) =>
      ensureOk<{ config: CatalogueConfig }>(await post(apiFetch, "config", input, "PUT"), "Нүүр зургийг хадгалж чадсангүй."),

    versionTrips: async (versionId: string) =>
      ensureOk<CatalogueVersionTripsResponse>(
        await apiFetch(`${CATALOGUE_ADMIN_API}/version/${encodeURIComponent(versionId)}/trips`),
        "Хувилбарын аяллын жагсаалтыг ачаалж чадсангүй.",
      ),

    recommend: async () =>
      ensureOk<CatalogueRecommendResponse>(await apiFetch(`${CATALOGUE_ADMIN_API}/recommend`), "Санал болгосон жагсаалтыг ачаалж чадсангүй."),

    testSend: async (input: { edition?: CatalogueEdition; versionId?: string; dryRun: boolean; recipientRef?: string; testerId?: string }) =>
      ensureOk<CatalogueTestSendResponse>(
        await post(apiFetch, "test-send", { ...input, ...(input.dryRun ? {} : { confirm: true }) }),
        "Туршилтын илгээлт амжилтгүй боллоо.",
      ),

    stats: async (days: number) =>
      ensureOk<CatalogueStatsResponse>(
        await apiFetch(`${CATALOGUE_ADMIN_API}/stats?days=${days}`),
        "Илгээлтийн статистикийг ачаалж чадсангүй.",
      ),
  };
}

export type CatalogueApi = ReturnType<typeof createCatalogueApi>;

export function pageImageUrl(version: Pick<CatalogueVersionView, "pagePath">, page: number): string {
  return `${version.pagePath}/${page}`;
}
