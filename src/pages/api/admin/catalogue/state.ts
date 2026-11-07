import { CATALOGUE_QUICK_MAX_TRIPS, CATALOGUE_QUICK_MIN_TRIPS, type CatalogueEdition } from "../../../../lib/catalogue/types";
import { getDeps, recipientLabel, recipientRef, type LazyDeps } from "../../../../lib/catalogue/admin/deps";
import { CATALOGUE_MAX_AGE_DAYS } from "../../../../lib/catalogue/freshness";
import { TESTER_CODE_TTL_MS, type CatalogueTesterView } from "../../../../lib/catalogue/testers";
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
    const [config, quick, complete, metaOutboundDisabled, testerList] = await Promise.all([
      store.getCatalogueConfig(),
      editionState(deps, "quick"),
      editionState(deps, "complete"),
      deps.metaOutboundDisabled(),
      deps.testers().then((port) => port.listTesters()).then(
        (testers): { testers: CatalogueTesterView[]; error: string | null } => ({ testers, error: null }),
        (): { testers: CatalogueTesterView[]; error: string | null } => ({ testers: [], error: "Туршигчийн жагсаалтыг ачаалж чадсангүй." }),
      ),
    ]);
    const recipients = deps.testRecipientPsids().map((psid) => ({ ref: recipientRef(psid), label: recipientLabel(psid) }));
    const reachable = testerList.testers.some((tester) => tester.windowOpen) || recipients.length > 0;
    const blockedReason = metaOutboundDisabled
      ? "Meta-д илгээх үйлдэл унтраалттай байна (kill switch эсвэл Vercel preview). Зөвхөн дээж (dry-run) ажиллана."
      : testerList.testers.length === 0 && recipients.length === 0
        ? "Баталгаажсан туршигч алга. Нэг удаа: «Тестер холбох» дарж гарсан кодыг өөрийн Messenger-ээс манай Page руу бичнэ үү. Тэр болтол зөвхөн дээж (dry-run) ажиллана."
        : !reachable
          ? "Бүх туршигчийн Messenger-ийн 24 цагийн цонх хаагдсан байна. Туршигч өөрийн Messenger-ээс манай Page руу дурын мессеж бичээд шинэчилнэ үү."
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
        testers: testerList.testers,
        testersError: testerList.error,
        pairingCodeTtlMinutes: TESTER_CODE_TTL_MS / 60_000,
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
