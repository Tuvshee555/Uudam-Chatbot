import { getDeps } from "../../../../lib/catalogue/admin/deps";
import { CatalogueHttpError, catalogueRoute } from "../../../../lib/catalogue/admin/route";
import { logInfo, recordCounter } from "../../../../lib/observability";
import { parseRollbackBody } from "../../../../lib/catalogue/admin/validation";
import { toVersionView } from "../../../../lib/catalogue/admin/views";

/** Makes an earlier (superseded) version the published one again. */
export default catalogueRoute({
  route: "api.admin.catalogue.rollback",
  methods: ["POST"],
  rateLimit: { limit: 20, windowMs: 60_000 },
  async handle({ req, res, actor, trace }) {
    const parsed = parseRollbackBody(req.body);
    if (!parsed.ok) throw new CatalogueHttpError(400, "invalid_request", parsed.message);
    const store = await getDeps().store();
    await store.ensureCatalogueSchema();
    const meta = await store.getVersionMeta(parsed.value.versionId);
    if (!meta) throw new CatalogueHttpError(404, "version_not_found", "Хувилбар олдсонгүй.");
    if (meta.edition === "preview") {
      throw new CatalogueHttpError(422, "preview_not_publishable", "Дээжийн хувилбарыг нийтлэх, буцаах боломжгүй.");
    }
    if (meta.status === "published") {
      throw new CatalogueHttpError(409, "already_published", "Энэ хувилбар одоо нийтлэгдсэн байна.");
    }
    if (meta.status !== "superseded") {
      throw new CatalogueHttpError(
        409,
        "rollback_requires_previous_version",
        "Зөвхөн өмнө нийтлэгдэж байсан хувилбар руу буцаана. Ноорог хувилбарыг «Нийтлэх» товчоор нийтэлнэ.",
      );
    }
    const restored = await store.rollbackTo(meta.id, actor);
    recordCounter("catalogue.rolled_back_total", 1, { edition: meta.edition });
    logInfo("catalogue.admin.rolled_back", {
      requestId: trace.requestId,
      versionId: meta.id,
      edition: meta.edition,
      versionNo: meta.versionNo,
    });
    res.status(200).json({ ok: true, version: toVersionView(restored) });
  },
});
