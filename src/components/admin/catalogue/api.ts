import { ensureOk } from "@/lib/adminUtils";
import { CATALOGUE_ADMIN_API, type CatalogueConfig, type CatalogueEdition, type CatalogueEditionConfig } from "@/lib/catalogue/types";
import type {
  CatalogueAdminState,
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

    testSend: async (input: { edition?: CatalogueEdition; versionId?: string; dryRun: boolean; recipientRef?: string }) =>
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
