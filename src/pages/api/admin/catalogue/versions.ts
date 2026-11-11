import { getDeps } from "../../../../lib/catalogue/admin/deps";
import { CatalogueHttpError, catalogueRoute } from "../../../../lib/catalogue/admin/route";
import { firstQuery, parseBoundedInt, parseEdition } from "../../../../lib/catalogue/admin/validation";
import { toVersionView } from "../../../../lib/catalogue/admin/views";

/** Version history, newest first, drafts and superseded versions included. */
export default catalogueRoute({
  route: "api.admin.catalogue.versions",
  methods: ["GET"],
  async handle({ req, res }) {
    const editionParam = firstQuery(req.query.edition);
    const edition = editionParam ? parseEdition(editionParam) : undefined;
    if (editionParam && !edition) {
      throw new CatalogueHttpError(400, "invalid_request", "Каталогийн төрөл буруу байна (quick, complete эсвэл preview).");
    }
    const limit = parseBoundedInt(firstQuery(req.query.limit), 1, 50, 20);
    const store = await getDeps().store();
    await store.ensureCatalogueSchema();
    const versions = await store.listVersions(edition ?? undefined, limit);
    res.status(200).json({ ok: true, versions: versions.map(toVersionView) });
  },
});
