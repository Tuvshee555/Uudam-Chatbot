import { getDeps, recipientLabel, recipientRef } from "../../../../lib/catalogue/admin/deps";
import { CatalogueHttpError, catalogueRoute } from "../../../../lib/catalogue/admin/route";
import { logInfo, logWarn, recordCounter } from "../../../../lib/observability";
import { parseTestSendBody } from "../../../../lib/catalogue/admin/validation";
import { evaluateTesterSend, viewOfTarget, type TesterLookup, type TesterSendTarget } from "../../../../lib/catalogue/testers";
import type { CatalogueEdition, CatalogueVersionMeta } from "../../../../lib/catalogue/types";
import type { CatalogueTestSendResponse } from "../../../../lib/catalogue/admin/types";

/** Replaces every occurrence of a PSID in a payload with its masked label (the browser never holds the id). */
function maskPsid<T>(value: T, psid: string, label: string): T {
  if (!psid) return value;
  return JSON.parse(JSON.stringify(value).split(psid).join(label)) as T;
}

/**
 * "Туршилтын илгээлт". Dry-run is the default: it asks the delivery module for the exact payload
 * and sends NOTHING, with no recipient addressed. A real send needs, all at once:
 *   - dryRun=false and confirm=true, said explicitly;
 *   - a recipient: a VERIFIED TESTER (paired by sending a one-time code from their own Messenger,
 *     see catalogue/testers.ts) whose 24 h Messenger window is open, or, as an optional extra,
 *     a PSID on the CATALOGUE_TEST_RECIPIENT_PSIDS allowlist;
 *   - the Meta kill switch / Vercel-preview suppression off (send.ts adds the page-level pause).
 * A named version may be a draft or the preview sample, so a file can be looked at on a phone before
 * it is published. No customer can ever be addressed from here.
 */
export default catalogueRoute({
  route: "api.admin.catalogue.test_send",
  methods: ["POST"],
  rateLimit: { limit: 10, windowMs: 60_000 },
  async handle({ req, res, actor, trace }) {
    const parsed = parseTestSendBody(req.body);
    if (!parsed.ok) throw new CatalogueHttpError(400, "invalid_request", parsed.message);
    const { dryRun, recipientPsid, recipientRef: ref, versionId, testerId } = parsed.value;

    const deps = getDeps();
    const allowlist = deps.testRecipientPsids();

    // A verified tester is addressed by opaque id. Unknown and revoked testers are refused in either mode.
    let tester: TesterSendTarget | null = null;
    if (testerId) {
      const lookup: TesterLookup = await (await deps.testers()).getTesterForSend(testerId);
      if (lookup.status === "not_found") {
        recordCounter("catalogue.test_send_refused_total", 1, { reason: "tester_not_found" });
        throw new CatalogueHttpError(404, "tester_not_found", "Баталгаажсан туршигч олдсонгүй. «Тестер холбох» дарж дахин бүртгүүлнэ үү.");
      }
      if (lookup.status === "revoked") {
        recordCounter("catalogue.test_send_refused_total", 1, { reason: "tester_revoked" });
        throw new CatalogueHttpError(409, "tester_revoked", "Энэ туршигчийн эрхийг цуцалсан байна. Шинээр холбоно уу.");
      }
      tester = lookup.target;
      if (!dryRun) {
        const verdict = evaluateTesterSend(lookup, deps.now());
        if (!verdict.ok) {
          recordCounter("catalogue.test_send_refused_total", 1, { reason: verdict.code });
          throw new CatalogueHttpError(409, verdict.code, verdict.reason);
        }
      }
    }

    // A named env recipient must be on the allowlist in either mode, so what the payload shows is
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
        "Энэ хүлээн авагч туршилтын жагсаалтад байхгүй тул илгээхгүй. Зөвхөн баталгаажсан туршигч (Тестер холбох) эсвэл CATALOGUE_TEST_RECIPIENT_PSIDS-д заасан хүнд илгээнэ.",
      );
    }

    if (!dryRun) {
      if (!tester && allowlist.length === 0) {
        throw new CatalogueHttpError(
          409,
          "test_recipients_not_configured",
          "Баталгаажсан туршигч алга. «Тестер холбох» дарж гарсан кодыг өөрийн Messenger-ээс манай Page руу нэг удаа бичнэ үү. Тэр болтол зөвхөн дээж (dry-run) ажиллана.",
        );
      }
      if (await deps.metaOutboundDisabled()) {
        throw new CatalogueHttpError(
          409,
          "meta_outbound_disabled",
          "Meta руу илгээх түр унтраалттай байна (өөрөө унтрааснаас эсвэл туршилтын орчин байгаагаас). Илгээхгүй.",
        );
      }
    }

    const store = await deps.store();
    await store.ensureCatalogueSchema();

    // Which file is being tested: a named version (draft, published or the preview sample) or the edition's published one.
    let target: CatalogueVersionMeta | null;
    let edition: CatalogueEdition;
    if (versionId) {
      target = await store.getVersionMeta(versionId);
      if (!target) throw new CatalogueHttpError(404, "version_not_found", "Хувилбар олдсонгүй.");
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
    // The preview sample may go to a verified tester (a design check on a phone), never to an env recipient by accident of edition.
    if (target.edition === "preview" && !tester && !dryRun) {
      throw new CatalogueHttpError(422, "preview_not_publishable", "Дээжийн хувилбарыг зөвхөн баталгаажсан туршигчид илгээнэ.");
    }

    const send = await deps.send();
    // A dry-run never carries a recipient: nothing is addressed, so no id can leak into the payload.
    const result = await send.sendCatalogueTest({
      recipientPsid: dryRun || tester ? "" : psid ?? "",
      edition,
      dryRun,
      versionId: target.id,
      ...(tester ? { testerId: tester.id } : {}),
    });

    const label = tester
      ? `Туршигч ${tester.label || tester.masked}`
      : psid
        ? `PSID ${recipientLabel(psid)}`
        : "туршилтын хүлээн авагч (дээж)";
    const secret = tester ? tester.psid : psid ?? "";
    const payload = result.payload
      ? {
          recipient: label,
          messages: maskPsid(result.payload.messages, secret, `<${label}>`),
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
      tester: tester ? { id: tester.id, ...pickTesterView(tester, deps.now()) } : null,
      outcome: {
        status: result.status,
        reason: result.reason ?? result.error,
        fileAccepted: result.fileAccepted,
        metaMessageId: dryRun ? null : result.metaMessageId,
      },
      payload,
    };
    recordCounter("catalogue.test_send_total", 1, { edition, mode: dryRun ? "dry_run" : "real", status: result.status, recipient: tester ? "tester" : "env" });
    logInfo("catalogue.admin.test_send", {
      requestId: trace.requestId,
      actor: actor ? "admin" : "token",
      edition,
      dryRun,
      versionId: target.id,
      status: result.status,
      recipient: tester ? "tester" : psid ? "env" : "none",
    });
    res.status(200).json(body);
  },
});

function pickTesterView(tester: TesterSendTarget, at: Date) {
  const view = viewOfTarget(tester, at);
  return { label: view.label, masked: view.masked, windowOpen: view.windowOpen, windowClosesAt: view.windowClosesAt };
}
