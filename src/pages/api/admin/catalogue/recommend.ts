import { getDeps } from "../../../../lib/catalogue/admin/deps";
import { catalogueRoute } from "../../../../lib/catalogue/admin/route";
import type { CatalogueRecommendResponse } from "../../../../lib/catalogue/admin/types";

/**
 * The recommended Quick shortlist: a diverse set of trips (one place, one slot) with a Mongolian reason for
 * each and the trip that makes the best cover. Read-only suggestion: nothing is saved here. The admin fills
 * it into the selection, and staff still press "Хадгалах".
 */
export default catalogueRoute({
  route: "api.admin.catalogue.recommend",
  methods: ["GET"],
  async handle({ res }) {
    const deps = getDeps();
    const [store, data] = await Promise.all([deps.store(), deps.data()]);
    await store.ensureCatalogueSchema();
    const picked = await data.recommendedQuick();
    const body: CatalogueRecommendResponse = { ok: true, tripIds: picked.tripIds, reasons: picked.reasons, cover: picked.cover };
    res.status(200).json(body);
  },
});
