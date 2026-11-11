import { getDeps } from "../../../../lib/catalogue/admin/deps";
import { catalogueRoute } from "../../../../lib/catalogue/admin/route";
import { firstQuery, parseBoundedInt } from "../../../../lib/catalogue/admin/validation";

/** Delivery counts per version over the last N days (max 14). Counts only: no sender data leaves the store. */
export default catalogueRoute({
  route: "api.admin.catalogue.stats",
  methods: ["GET"],
  async handle({ req, res }) {
    const days = parseBoundedInt(firstQuery(req.query.days), 1, 14, 14);
    const store = await getDeps().store();
    await store.ensureCatalogueSchema();
    const stats = await store.deliveryStats(days);
    res.status(200).json({ ok: true, ...stats });
  },
});
