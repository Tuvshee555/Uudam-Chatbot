import { CATALOGUE_QUICK_MAX_TRIPS, CATALOGUE_QUICK_MIN_TRIPS, type CatalogueEdition } from "../../../../lib/catalogue/types";
import { getDeps, recipientLabel, recipientRef, type LazyDeps } from "../../../../lib/catalogue/admin/deps";
import { CATALOGUE_MAX_AGE_DAYS } from "../../../../lib/catalogue/freshness";
import { catalogueRoute, ulaanbaatarDay } from "../../../../lib/catalogue/admin/route";
import {
  CATALOGUE_PREVIEW_MAX_TRIPS,
  CATALOGUE_PREVIEW_MIN_TRIPS,
  type CatalogueAdminState,
  type CatalogueEditionState,
} from "../../../../lib/catalogue/admin/types";
import { computeFreshness, toVersionView } from "../../../../lib/catalogue/admin/views";

async function editionState(deps: LazyDeps, edition: "quick" | "complete"): Promise<CatalogueEditionState> {
  const store = await deps.store();
  const [published, versions] = await Promise.all([store.getPublished(edition), store.listVersions(edition as CatalogueEdition, 20)]);
  const latestDraft = [...versions]
    .filter((version) => version.status === "draft")
    .sort((a, b) => b.versionNo - a.versionNo)[0];
  return {
    published: published ? toVersionView(published) : null,
    latestDraft: latestDraft ? toVersionView(latestDraft) : null,
    freshness: await computeFreshness({ meta: published, deps }),
  };
}

/** Everything the catalogue screen needs to draw itself: published versions, freshness, config, test-send readiness. */
export default catalogueRoute({
  route: "api.admin.catalogue.state",
  methods: ["GET"],
  async handle({ res }) {
    const deps = getDeps();
    const store = await deps.store();
    await store.ensureCatalogueSchema();
    const now = deps.now();
    const [config, quick, complete, metaOutboundDisabled] = await Promise.all([
      store.getCatalogueConfig(),
      editionState(deps, "quick"),
      editionState(deps, "complete"),
      deps.metaOutboundDisabled(),
    ]);
    const recipients = deps.testRecipientPsids().map((psid) => ({ ref: recipientRef(psid), label: recipientLabel(psid) }));
    const blockedReason = recipients.length === 0
      ? "CATALOGUE_TEST_RECIPIENT_PSIDS тохируулаагүй тул жинхэнэ туршилтын илгээлт хаалттай. Зөвхөн дээж (dry-run) ажиллана."
      : metaOutboundDisabled
        ? "Meta-д илгээх үйлдэл унтраалттай байна (kill switch эсвэл Vercel preview). Зөвхөн дээж (dry-run) ажиллана."
        : null;
    const body: CatalogueAdminState = {
      ok: true,
      serverTime: now.toISOString(),
      today: ulaanbaatarDay(now),
      limits: {
        quickMin: CATALOGUE_QUICK_MIN_TRIPS,
        quickMax: CATALOGUE_QUICK_MAX_TRIPS,
        previewMin: CATALOGUE_PREVIEW_MIN_TRIPS,
        previewMax: CATALOGUE_PREVIEW_MAX_TRIPS,
        staleAfterDays: CATALOGUE_MAX_AGE_DAYS,
      },
      editions: { quick, complete },
      testSend: {
        recipients,
        metaOutboundDisabled,
        realSendPossible: blockedReason === null,
        blockedReason,
      },
      config,
    };
    res.status(200).json(body);
  },
});
