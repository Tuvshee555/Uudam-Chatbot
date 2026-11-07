import { getDeps } from "../../../../../../../lib/catalogue/admin/deps";
import { CatalogueHttpError, catalogueRoute } from "../../../../../../../lib/catalogue/admin/route";
import { firstQuery, isValidVersionId, parsePageNumber } from "../../../../../../../lib/catalogue/admin/validation";

/**
 * One page of a stored version as the JPEG the renderer captured in the same browser session as
 * the PDF (page numbers start at 1). A version is immutable, so the image may be cached privately.
 */
export default catalogueRoute({
  route: "api.admin.catalogue.version_page",
  methods: ["GET"],
  async handle({ req, res }) {
    const id = firstQuery(req.query.id);
    const page = parsePageNumber(firstQuery(req.query.n));
    if (!isValidVersionId(id) || page === null) {
      throw new CatalogueHttpError(400, "invalid_request", "Хувилбар эсвэл хуудасны дугаар буруу байна.");
    }
    const store = await getDeps().store();
    await store.ensureCatalogueSchema();
    const jpeg = await store.getVersionPageImage(id, page);
    if (!jpeg) throw new CatalogueHttpError(404, "page_not_found", "Хуудасны зураг олдсонгүй.");
    res.status(200);
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Content-Length", String(jpeg.length));
    res.setHeader("Cache-Control", "private, max-age=600");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(jpeg);
  },
});
