import { getDeps, recipientLabel, recipientRef } from "../../../../lib/catalogue/admin/deps";
import { CatalogueHttpError, catalogueRoute } from "../../../../lib/catalogue/admin/route";
import { logInfo, logWarn, recordCounter } from "../../../../lib/observability";
import { parseTestSendBody } from "../../../../lib/catalogue/admin/validation";
import type { CatalogueEdition, CatalogueVersionMeta } from "../../../../lib/catalogue/types";
import type { CatalogueTestSendResponse } from "../../../../lib/catalogue/admin/types";

/** Replaces every occurrence of a PSID in a payload with its masked label (the browser never holds the id). */
function maskPsid<T>(value: T, psid: string, label: string): T {
  if (!psid) return value;
  return JSON.parse(JSON.stringify(value).split(psid).join(label)) as T;
}

/**
 * "Туршилтын илгээлт". Dry-run is the default: it asks the delivery module for the exact payload
 * and sends NOTHING, with no recipient involved. A real send goes ONLY to a PSID on the
 * environment allowlist CATALOGUE_TEST_RECIPIENT_PSIDS, only when the caller asks explicitly
 * (dryRun=false and confirm=true), and never while the Meta kill switch / Vercel-preview
 * suppression is active. A named version may be a draft, so a file can be tested before publishing.
 */
export default catalogueRoute({
  route: "api.admin.catalogue.test_send",
  methods: ["POST"],
  rateLimit: { limit: 10, windowMs: 60_000 },
  async handle({ req, res, actor, trace }) {
    const parsed = parseTestSendBody(req.body);
    if (!parsed.ok) throw new CatalogueHttpError(400, "invalid_request", parsed.message);
    const { dryRun, recipientPsid, recipientRef: ref, versionId } = parsed.value;

    const deps = getDeps();
    const allowlist = deps.testRecipientPsids();

    // A named recipient must be on the allowlist in either mode, so what the payload shows is
    // for someone who could really receive it. Anyone else is refused before anything else runs.
    let psid: string | null = null;
    if (recipientPsid) {
      psid = allowlist.includes(recipientPsid) ? recipientPsid : null;
    } else if (ref) {
      psid = allowlist.find((candidate) => recipientRef(candidate) === ref) ?? null;
    }
    if ((recipientPsid || ref) && !psid) {
      recordCounter("catalogue.test_send_refused_total", 1, { reason: "not_allowlisted" });
      logWarn("catalogue.admin.test_send_refused", { requestId: trace.requestId, reason: "not_allowlisted" });
      throw new CatalogueHttpError(
        403,
        "recipient_not_allowed",
        "Энэ хүлээн авагч туршилтын жагсаалтад байхгүй тул илгээхгүй. Зөвхөн CATALOGUE_TEST_RECIPIENT_PSIDS-д заасан хүнд илгээнэ.",
      );
    }

    if (!dryRun) {
      if (allowlist.length === 0) {
        throw new CatalogueHttpError(
          409,
          "test_recipients_not_configured",
          "CATALOGUE_TEST_RECIPIENT_PSIDS тохируулаагүй тул жинхэнэ илгээлт хаалттай. Дээж (dry-run) ашиглана уу.",
        );
      }
      if (await deps.metaOutboundDisabled()) {
        throw new CatalogueHttpError(
          409,
          "meta_outbound_disabled",
          "Meta-д илгээх үйлдэл унтраалттай байна (kill switch эсвэл Vercel preview). Илгээхгүй.",
        );
      }
    }

    const store = await deps.store();
    await store.ensureCatalogueSchema();

    // Which file is being tested: a named version (draft or published) or the edition's published one.
    let target: CatalogueVersionMeta | null;
    let edition: CatalogueEdition;
    if (versionId) {
      target = await store.getVersionMeta(versionId);
      if (!target) throw new CatalogueHttpError(404, "version_not_found", "Хувилбар олдсонгүй.");
      if (target.edition === "preview") {
        throw new CatalogueHttpError(422, "preview_not_publishable", "Дээжийн хувилбарыг Messenger-ээр туршихгүй.");
      }
      if (target.status === "superseded") {
        throw new CatalogueHttpError(409, "version_not_testable", "Хуучирсан хувилбарыг туршихгүй. Ноорог эсвэл нийтлэгдсэн хувилбарыг сонгоно уу.");
      }
      if (parsed.value.edition && parsed.value.edition !== target.edition) {
        throw new CatalogueHttpError(400, "invalid_request", "Хувилбар болон каталогийн төрөл таарахгүй байна.");
      }
      edition = target.edition;
    } else {
      edition = parsed.value.edition as CatalogueEdition;
      target = await store.getPublished(edition);
      if (!target) {
        throw new CatalogueHttpError(409, "no_published_version", "Энэ каталогийн нийтлэгдсэн хувилбар алга. Эхлээд нийтэлнэ үү.");
      }
    }

    const send = await deps.send();
    // A dry-run never carries a recipient: nothing is addressed, so no id can leak into the payload.
    const result = await send.sendCatalogueTest({
      recipientPsid: dryRun ? "" : psid ?? "",
      edition,
      dryRun,
      versionId: target.id,
    });

    const label = psid ? `PSID ${recipientLabel(psid)}` : "туршилтын хүлээн авагч (дээж)";
    const payload = result.payload
      ? {
          recipient: label,
          messages: maskPsid(result.payload.messages, psid ?? "", `<${label}>`),
          file: { name: result.payload.fileName, sizeBytes: result.payload.sizeBytes, pages: target.pageCount, versionNo: result.payload.versionNo },
          attachmentSource: result.payload.attachmentSource,
          publicUrl: result.payload.publicUrl,
          fallbackText: result.payload.fallbackText,
        }
      : null;
    const body: CatalogueTestSendResponse = {
      ok: true,
      dryRun,
      edition,
      versionId: target.id,
      versionNo: target.versionNo,
      fileName: target.fileName,
      outcome: {
        status: result.status,
        reason: result.reason ?? result.error,
        fileAccepted: result.fileAccepted,
        metaMessageId: dryRun ? null : result.metaMessageId,
      },
      payload,
    };
    recordCounter("catalogue.test_send_total", 1, { edition, mode: dryRun ? "dry_run" : "real", status: result.status });
    logInfo("catalogue.admin.test_send", {
      requestId: trace.requestId,
      actor: actor ? "admin" : "token",
      edition,
      dryRun,
      versionId: target.id,
      status: result.status,
    });
    res.status(200).json(body);
  },
});
