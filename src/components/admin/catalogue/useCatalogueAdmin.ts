import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CatalogueEdition } from "@/lib/catalogue/types";
import type { CatalogueAdminState, CatalogueReviewResponse, CatalogueVersionView } from "@/lib/catalogue/admin/types";
import { createCatalogueApi, type ApiFetch } from "./api";

export type ReviewMap = Partial<Record<CatalogueEdition, CatalogueReviewResponse>>;

/**
 * Loads and refreshes what the catalogue screen shows. The review rows are fetched per edition
 * on demand (they read every active trip), the rest on mount; nothing is cached across visits,
 * so a price changed on a trip shows the next time the screen opens.
 */
export function useCatalogueAdmin(apiFetch: ApiFetch) {
  const api = useMemo(() => createCatalogueApi(apiFetch), [apiFetch]);
  const [state, setState] = useState<CatalogueAdminState | null>(null);
  const [versions, setVersions] = useState<CatalogueVersionView[]>([]);
  const [reviews, setReviews] = useState<ReviewMap>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviewLoading, setReviewLoading] = useState<CatalogueEdition | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    try {
      const [nextState, nextVersions] = await Promise.all([api.state(), api.versions(40)]);
      if (!mounted.current) return;
      setState(nextState);
      setVersions(nextVersions.versions);
      setError(null);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : "Каталогийн мэдээллийг ачаалж чадсангүй.");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [api]);

  const loadReview = useCallback(
    async (edition: CatalogueEdition) => {
      setReviewLoading(edition);
      try {
        const review = await api.review(edition);
        if (!mounted.current) return;
        setReviews((current) => ({ ...current, [edition]: review }));
        setReviewError(null);
      } catch (err) {
        if (mounted.current) setReviewError(err instanceof Error ? err.message : "Аяллын жагсаалтыг ачаалж чадсангүй.");
      } finally {
        if (mounted.current) setReviewLoading((current) => (current === edition ? null : current));
      }
    },
    [api],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  return { api, state, versions, reviews, loading, error, reviewLoading, reviewError, reload, loadReview };
}

export type CatalogueAdmin = ReturnType<typeof useCatalogueAdmin>;
