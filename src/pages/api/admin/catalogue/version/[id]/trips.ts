import { getDeps } from "../../../../../../lib/catalogue/admin/deps";
import { CatalogueHttpError, catalogueRoute } from "../../../../../../lib/catalogue/admin/route";
import type { CatalogueVersionTripsResponse } from "../../../../../../lib/catalogue/admin/types";
import { firstQuery, isValidVersionId } from "../../../../../../lib/catalogue/admin/validation";

/**
 * The trips one stored version printed, with the persistent code each carries (read from the version's own
 * snapshot, never recomputed). Lets staff see that a trip keeps the same code in every edition and version.
 */
export default catalogueRoute({
  route: "api.admin.catalogue.version_trips",
  methods: ["GET"],
  async handle({ req, res }) {
    const id = firstQuery(req.query.id);
    if (!isValidVersionId(id)) throw new CatalogueHttpError(400, "invalid_request", "Хувилбарын дугаар буруу байна.");
    const store = await getDeps().store();
    await store.ensureCatalogueSchema();
    const snapshot = await store.getVersionSnapshot(id);
    if (!snapshot) throw new CatalogueHttpError(404, "version_not_found", "Хувилбар олдсонгүй.");
    const body: CatalogueVersionTripsResponse = {
      ok: true,
      versionId: id,
      trips: snapshot.trips.map((card) => ({ code: card.code, tripId: card.tripId, title: card.editorialTitle || card.title })),
    };
    res.status(200).json(body);
  },
});
