import { getDeps } from "../../../../../lib/catalogue/admin/deps";
import { CatalogueHttpError, catalogueRoute } from "../../../../../lib/catalogue/admin/route";
import { parsePairingBody } from "../../../../../lib/catalogue/admin/validationPhotos";
import type { CataloguePairingResponse, CatalogueTestersResponse } from "../../../../../lib/catalogue/admin/types";
import { logInfo, recordCounter } from "../../../../../lib/observability";

/**
 * Verified test recipients.
 *   GET   the testers: label, masked tail, verified time, whether the 24 h Messenger window is open. Never a PSID.
 *   POST  "Тестер холбох": mints a one-time pairing code (valid 30 minutes, stored hashed). The signed-in staff
 *         member sends exactly that code from their own Messenger account to the Page; the webhook then registers
 *         that sender as a verified tester. A read-only API token cannot mint a code (writes need a signed-in session).
 */
export default catalogueRoute({
  route: "api.admin.catalogue.testers",
  methods: ["GET", "POST"],
  rateLimit: { limit: 10, windowMs: 60_000 },
  async handle({ req, res, actor, trace }) {
    const deps = getDeps();
    const testers = await deps.testers();

    if (req.method === "GET") {
      const body: CatalogueTestersResponse = { ok: true, testers: await testers.listTesters() };
      return void res.status(200).json(body);
    }

    const parsed = parsePairingBody(req.body);
    if (!parsed.ok) throw new CatalogueHttpError(400, "invalid_request", parsed.message);
    if (!actor) {
      // Only a signed-in staff member can pair a device: the code is what ties a Messenger account to that person.
      throw new CatalogueHttpError(403, "session_required", "Туршигч холбохын тулд админаар нэвтэрсэн байх шаардлагатай.");
    }
    let issued;
    try {
      issued = await testers.createPairingCode({ actor, label: parsed.value.label });
    } catch (error) {
      if (error instanceof Error && error.name === "TesterError") {
        throw new CatalogueHttpError(409, "too_many_testers", "Туршигч хэт олон байна. Хэрэггүй туршигчийн эрхийг цуцалсны дараа дахин холбоно уу.");
      }
      throw error;
    }
    recordCounter("catalogue.tester_code_issued_total", 1);
    // The code is a short-lived secret: it is returned to the one caller who asked and is never logged.
    logInfo("catalogue.admin.tester_code_issued", { requestId: trace.requestId, ttlMinutes: issued.ttlMinutes });
    const body: CataloguePairingResponse = {
      ok: true,
      code: issued.code,
      expiresAt: issued.expiresAt,
      ttlMinutes: issued.ttlMinutes,
      instruction: `Энэ кодыг өөрийн Messenger-ээс манай Page руу яг ийм байдлаар (өөр үггүйгээр) бичээрэй. Код ${issued.ttlMinutes} минут хүчинтэй, зөвхөн нэг удаа ашиглагдана.`,
    };
    res.status(200).json(body);
  },
});
