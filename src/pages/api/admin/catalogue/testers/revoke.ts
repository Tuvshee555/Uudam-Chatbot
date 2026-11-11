import { getDeps } from "../../../../../lib/catalogue/admin/deps";
import { CatalogueHttpError, catalogueRoute } from "../../../../../lib/catalogue/admin/route";
import { parseRevokeBody } from "../../../../../lib/catalogue/admin/validationPhotos";
import { logInfo, recordCounter } from "../../../../../lib/observability";

/** Revoke a verified tester: it can never be sent a test again (pair again to re-add). Signed-in session only. */
export default catalogueRoute({
  route: "api.admin.catalogue.testers_revoke",
  methods: ["POST"],
  rateLimit: { limit: 20, windowMs: 60_000 },
  async handle({ req, res, actor, trace }) {
    const parsed = parseRevokeBody(req.body);
    if (!parsed.ok) throw new CatalogueHttpError(400, "invalid_request", parsed.message);
    const revoked = await (await getDeps().testers()).revokeTester(parsed.value.testerId, actor);
    if (!revoked) throw new CatalogueHttpError(404, "tester_not_found", "Туршигч олдсонгүй эсвэл аль хэдийн цуцлагдсан байна.");
    recordCounter("catalogue.tester_revoked_total", 1);
    logInfo("catalogue.admin.tester_revoked", { requestId: trace.requestId, actor: actor ? "admin" : "token" });
    res.status(200).json({ ok: true });
  },
});
