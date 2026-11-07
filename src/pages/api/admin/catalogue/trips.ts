import { getDeps } from "../../../../lib/catalogue/admin/deps";
import { CatalogueHttpError, catalogueRoute, ulaanbaatarDay } from "../../../../lib/catalogue/admin/route";
import { loadReview } from "../../../../lib/catalogue/admin/review";
import { firstQuery, parseEdition } from "../../../../lib/catalogue/admin/validation";

/** Per-trip review rows (price + date used, price source, photo, warnings), computed live; nothing stored. */
export default catalogueRoute({
  route: "api.admin.catalogue.trips",
  methods: ["GET"],
  async handle({ req, res }) {
    const edition = parseEdition(firstQuery(req.query.edition) || "quick");
    if (!edition) throw new CatalogueHttpError(400, "invalid_request", "Каталогийн төрөл буруу байна (quick, complete эсвэл preview).");
    const deps = getDeps();
    const [store, data] = await Promise.all([deps.store(), deps.data()]);
    await store.ensureCatalogueSchema();
    const now = deps.now();
    const [config, activeTrips] = await Promise.all([store.getCatalogueConfig(), deps.listActiveTrips()]);
    const review = await loadReview({
      edition,
      nowIso: now.toISOString(),
      today: ulaanbaatarDay(now),
      activeTrips,
      editionConfig: config[edition],
      data,
    });
    res.status(200).json(review);
  },
});
