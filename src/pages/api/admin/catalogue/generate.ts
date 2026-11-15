import { getDeps } from "../../../../lib/catalogue/admin/deps";
import { CatalogueHttpError, catalogueRoute } from "../../../../lib/catalogue/admin/route";
import { logInfo, logWarn, recordCounter, recordHistogram } from "../../../../lib/observability";
import { parseGenerateBody, selectionBoundsMessage } from "../../../../lib/catalogue/admin/validation";
import { toVersionView } from "../../../../lib/catalogue/admin/views";
import type { CatalogueEdition } from "../../../../lib/catalogue/types";

/**
 * PDF rendering launches headless Chromium (same stack as /api/poster-pdf). A browser that cannot
 * start surfaces as the typed render error and is answered 503 (route.ts); it is not probed
 * separately, because a probe would launch Chromium twice inside the 60 s budget.
 */
export const config = { maxDuration: 60 };

/** One generation per edition at a time on this instance: a double click must not render twice. */
const generating = new Set<CatalogueEdition>();

/**
 * Generate -> a DRAFT version. One consistent snapshot of the live trip data is built, rendered
 * once, and stored together (snapshot + PDF + page images), so the preview staff review is
 * byte-for-byte what publishing would send. Nothing is published or sent here.
 */
export default catalogueRoute({
  route: "api.admin.catalogue.generate",
  methods: ["POST"],
  rateLimit: { limit: 6, windowMs: 60_000 },
  async handle({ req, res, actor, trace }) {
    const parsed = parseGenerateBody(req.body);
    if (!parsed.ok) throw new CatalogueHttpError(400, "invalid_request", parsed.message);
    const { edition } = parsed.value;
    if (generating.has(edition)) {
      throw new CatalogueHttpError(409, "generation_in_progress", "Энэ каталогийг одоо үүсгэж байна. Дуустал хүлээнэ үү.");
    }
    generating.add(edition);
    const startedAt = Date.now();
    try {
      const deps = getDeps();
      const [store, data, render] = await Promise.all([deps.store(), deps.data(), deps.render()]);
      await store.ensureCatalogueSchema();

      const nowIso = deps.now().toISOString();
      // Generating is the moment photos are measured for real (sizes drive hero ranking); the review table stays cheap.
      const input = await data.loadSnapshotInput(edition, { nowIso, measurePhotos: true });
      const snapshot = data.buildCatalogueSnapshot(input);

      if (edition === "complete" && snapshot.trips.length < 1) {
        throw new CatalogueHttpError(422, "no_eligible_trips", "Каталогт оруулах боломжтой идэвхтэй аялал одоогоор алга.");
      }
      if (edition !== "complete") {
        const boundsMessage = selectionBoundsMessage(edition, snapshot.trips.length);
        if (boundsMessage) {
          const present = new Set(snapshot.trips.map((trip) => trip.tripId));
          const lost = input.config.tripIds.filter((id) => !present.has(id));
          throw new CatalogueHttpError(
            422,
            "selection_out_of_bounds",
            lost.length > 0
              ? `${boundsMessage} Сонгосон ${lost.length} аялал одоо каталогт тохирохгүй болсон тул «Сонголт» хэсгээс шинэчилнэ үү.`
              : boundsMessage,
            { lostTripIds: lost },
          );
        }
      }

      // The closing page prints the version the file will be saved as (the store assigns the same
      // number under its lock; two staff generating at the same instant is the only way they differ).
      const nextVersionNo = ((await store.listVersions(edition, 1))[0]?.versionNo ?? 0) + 1;
      const rendered = await render.renderCatalogue(snapshot, { pageImages: true, versionLabel: `v${nextVersionNo}` });
      const meta = await store.saveDraftVersion({ edition, snapshot, rendered, actor });

      const blocking = meta.warnings.filter((w) => w.severity === "blocking").length;
      const warnings = meta.warnings.filter((w) => w.severity === "warning").length;
      const durationMs = Date.now() - startedAt;
      recordCounter("catalogue.generated_total", 1, { edition });
      recordHistogram("catalogue.generate_ms", durationMs, { edition });
      logInfo("catalogue.admin.generated", {
        requestId: trace.requestId,
        versionId: meta.id,
        edition,
        versionNo: meta.versionNo,
        pages: meta.pageCount,
        sizeBytes: meta.sizeBytes,
        trips: meta.tripCount,
        blocking,
        warnings,
        renderMs: rendered.renderMs,
        durationMs,
      });
      if (blocking > 0) {
        logWarn("catalogue.admin.generated_with_blocking_warnings", { requestId: trace.requestId, versionId: meta.id, blocking });
      }
      res.status(200).json({
        ok: true,
        version: toVersionView(meta),
        summary: {
          pages: meta.pageCount,
          sizeBytes: meta.sizeBytes,
          trips: meta.tripCount,
          blocking,
          warnings,
          weakHeroes: snapshot.trips.filter((card) => card.heroQuality === "weak" || card.heroQuality === "missing").length,
          renderMs: rendered.renderMs,
          durationMs,
        },
      });
    } finally {
      generating.delete(edition);
    }
  },
});
