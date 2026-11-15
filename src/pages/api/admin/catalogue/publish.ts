import { getDeps } from "../../../../lib/catalogue/admin/deps";
import { CatalogueHttpError, catalogueRoute } from "../../../../lib/catalogue/admin/route";
import { logInfo, recordCounter } from "../../../../lib/observability";
import { parsePublishBody, selectionBoundsMessage } from "../../../../lib/catalogue/admin/validation";
import { toVersionView } from "../../../../lib/catalogue/admin/views";

/**
 * Publishes a reviewed draft. Blocking warnings stop it unless the person acknowledged them
 * explicitly; the store enforces the same rule again, so a direct call cannot skip it either.
 */
export default catalogueRoute({
  route: "api.admin.catalogue.publish",
  methods: ["POST"],
  rateLimit: { limit: 20, windowMs: 60_000 },
  async handle({ req, res, actor, trace }) {
    const parsed = parsePublishBody(req.body);
    if (!parsed.ok) throw new CatalogueHttpError(400, "invalid_request", parsed.message);
    const { versionId, acknowledgeWarnings } = parsed.value;
    const store = await getDeps().store();
    await store.ensureCatalogueSchema();
    const meta = await store.getVersionMeta(versionId);
    if (!meta) throw new CatalogueHttpError(404, "version_not_found", "Хувилбар олдсонгүй.");
    if (meta.edition === "preview") {
      throw new CatalogueHttpError(422, "preview_not_publishable", "Дээжийн хувилбарыг нийтлэх боломжгүй.");
    }
    if (meta.status !== "draft") {
      throw new CatalogueHttpError(
        409,
        "version_not_draft",
        meta.status === "published"
          ? "Энэ хувилбар аль хэдийн нийтлэгдсэн байна."
          : "Өмнө нийтлэгдэж байсан хувилбарыг «Буцаах» товчоор сэргээнэ.",
      );
    }
    if (meta.edition === "quick") {
      const boundsMessage = selectionBoundsMessage("quick", meta.tripCount);
      if (boundsMessage) throw new CatalogueHttpError(422, "selection_out_of_bounds", boundsMessage);
    }
    const blocking = meta.warnings.filter((warning) => warning.severity === "blocking");
    if (blocking.length > 0 && !acknowledgeWarnings) {
      throw new CatalogueHttpError(
        409,
        "blocking_warnings_unacknowledged",
        `${blocking.length} хориглосон анхааруулга байна. Анхааруулгыг уншиж, «Ойлголоо» гэж баталгаажуулсны дараа нийтэлнэ.`,
        {
          blocking: blocking.map((warning) => ({
            code: warning.code,
            message: warning.message,
            tripId: warning.tripId ?? null,
          })),
        },
      );
    }
    const published = await store.publishVersion(meta.id, actor, {
      acknowledgeWarnings: blocking.length > 0 && acknowledgeWarnings,
    });
    recordCounter("catalogue.published_total", 1, { edition: meta.edition, acknowledged: blocking.length > 0 });
    logInfo("catalogue.admin.published", {
      requestId: trace.requestId,
      versionId: meta.id,
      edition: meta.edition,
      versionNo: meta.versionNo,
      blockingAcknowledged: blocking.length,
    });
    res.status(200).json({ ok: true, version: toVersionView(published) });
  },
});
