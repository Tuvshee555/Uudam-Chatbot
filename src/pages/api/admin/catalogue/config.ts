import { getDeps } from "../../../../lib/catalogue/admin/deps";
import { CatalogueHttpError, catalogueRoute, ulaanbaatarDay } from "../../../../lib/catalogue/admin/route";
import { parseConfigUpdate } from "../../../../lib/catalogue/admin/validation";
import type { CatalogueConfig, CatalogueEditionConfig } from "../../../../lib/catalogue/types";

/**
 * Staff curation only: which trips, in what order, which are featured, group overrides, exclusions.
 * Trip titles, prices and dates are never accepted here and never stored.
 */
export default catalogueRoute({
  route: "api.admin.catalogue.config",
  methods: ["GET", "PUT"],
  rateLimit: { limit: 60, windowMs: 60_000 },
  async handle({ req, res, actor }) {
    const deps = getDeps();
    const store = await deps.store();
    await store.ensureCatalogueSchema();

    if (req.method === "GET") {
      return void res.status(200).json({ ok: true, config: await store.getCatalogueConfig() });
    }

    const parsed = parseConfigUpdate(req.body);
    if (!parsed.ok) throw new CatalogueHttpError(400, "invalid_request", parsed.message);
    const { edition, config, expectedUpdatedAt } = parsed.value;

    const [trips, data] = await Promise.all([deps.listActiveTrips(), deps.data()]);
    const byId = new Map(trips.map((trip) => [trip.id, trip]));
    const today = ulaanbaatarDay(deps.now());

    // A selection must consist of trips that are active and catalogue-eligible right now.
    if (edition !== "complete") {
      const problems: Array<{ tripId: string; reason: string }> = [];
      for (const tripId of config.tripIds) {
        const trip = byId.get(tripId);
        if (!trip) {
          problems.push({ tripId, reason: "Идэвхгүй эсвэл олдохгүй аялал" });
          continue;
        }
        const eligibility = data.isTripEligible(trip, today);
        if (!eligibility.eligible) problems.push({ tripId, reason: eligibility.reason ?? "Каталогт тохиромжгүй" });
      }
      if (problems.length > 0) {
        throw new CatalogueHttpError(
          422,
          "trip_not_selectable",
          `Сонгосон ${problems.length} аялал каталогт тохирохгүй байна. Жагсаалтаас хасна уу.`,
          { problems },
        );
      }
    }

    // Stale ids (a trip archived since staff last saved) are dropped from the soft lists, not trapped there.
    const known = (ids: string[]) => ids.filter((id) => byId.has(id));
    const dropped: string[] = [];
    const keep = (ids: string[]) => {
      const kept = known(ids);
      dropped.push(...ids.filter((id) => !byId.has(id)));
      return kept;
    };
    const clean: CatalogueEditionConfig = {
      tripIds: edition === "complete" ? keep(config.tripIds) : config.tripIds,
      featuredTripIds: edition === "complete" ? keep(config.featuredTripIds) : config.featuredTripIds,
      excludedTripIds: keep(config.excludedTripIds),
      groupOverrides: Object.fromEntries(Object.entries(config.groupOverrides).filter(([id]) => byId.has(id))),
    };

    const current = await store.getCatalogueConfig();
    const next: CatalogueConfig = { ...current, [edition]: clean };
    const saved = await store.saveCatalogueConfig(next, actor, expectedUpdatedAt === undefined ? undefined : { expectedUpdatedAt });
    res.status(200).json({ ok: true, config: saved, dropped: [...new Set(dropped)] });
  },
});
