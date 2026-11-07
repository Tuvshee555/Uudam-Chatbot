import { getDeps } from "../../../../lib/catalogue/admin/deps";
import { CatalogueHttpError, catalogueRoute, ulaanbaatarDay } from "../../../../lib/catalogue/admin/route";
import type { CatalogueCoverCandidatesResponse, CataloguePhotosResponse } from "../../../../lib/catalogue/admin/types";
import { loadCoverPools, rankCoverCandidates } from "../../../../lib/catalogue/admin/cover";
import { firstQuery, isValidTripId } from "../../../../lib/catalogue/admin/validation";
import { parsePhotoUpdate } from "../../../../lib/catalogue/admin/validationPhotos";
import type { CatalogueConfig, CatalogueHeroChoice } from "../../../../lib/catalogue/types";
import { logInfo, recordCounter } from "../../../../lib/observability";

/**
 * The hero photo picker and the printed display title of ONE trip.
 *   GET  ?tripId=...  every selectable photo with its measured size, score and issues, plus the staff choice.
 *   GET  ?cover=1  the best approved photos no trip page uses (bounded search) for the cover chooser; the choice is
 *        saved through PUT /config { coverPhoto }.
 *   PUT  { tripId, hero?, titleOverride? }  stores heroByTripId[tripId] = {url, focal, zoom} and/or
 *        titleOverrides[tripId] in the catalogue config. `hero.url` MUST be one of that trip's own photo
 *        candidates; null clears the choice. The trip's price, dates and title of record are never touched.
 */
export default catalogueRoute({
  route: "api.admin.catalogue.photos",
  methods: ["GET", "PUT"],
  rateLimit: { limit: 60, windowMs: 60_000 },
  async handle({ req, res, actor, trace }) {
    const deps = getDeps();

    if (req.method === "GET" && firstQuery(req.query.cover) === "1") {
      const [store, data, trips] = await Promise.all([deps.store(), deps.data(), deps.listActiveTrips()]);
      await store.ensureCatalogueSchema();
      const config = await store.getCatalogueConfig();
      const codes = store.getTripCodeMap ? await store.getTripCodeMap().catch(() => ({})) : {};
      const { pools, truncated, searched } = await loadCoverPools({
        data,
        activeTrips: trips,
        config,
        today: ulaanbaatarDay(deps.now()),
        codes,
        now: () => Date.now(),
      });
      const body: CatalogueCoverCandidatesResponse = {
        ok: true,
        current: config.coverPhoto ?? null,
        candidates: rankCoverCandidates(pools, config),
        truncated,
        searchedTrips: searched,
      };
      return void res.status(200).json(body);
    }

    if (req.method === "GET") {
      const tripId = firstQuery(req.query.tripId);
      if (!isValidTripId(tripId)) throw new CatalogueHttpError(400, "invalid_request", "Аяллын код буруу байна.");
      const [store, data, trips] = await Promise.all([deps.store(), deps.data(), deps.listActiveTrips()]);
      await store.ensureCatalogueSchema();
      const trip = trips.find((candidate) => candidate.id === tripId);
      if (!trip) throw new CatalogueHttpError(404, "trip_not_found", "Идэвхтэй аялал олдсонгүй.");
      const [found, config] = await Promise.all([data.listPhotoCandidates(tripId), store.getCatalogueConfig()]);
      const body: CataloguePhotosResponse = {
        ok: true,
        tripId,
        title: trip.route_name,
        candidates: found.candidates,
        chosen: config.heroByTripId?.[tripId] ?? found.chosen ?? null,
        titleOverride: config.titleOverrides?.[tripId] ?? null,
      };
      return void res.status(200).json(body);
    }

    const parsed = parsePhotoUpdate(req.body);
    if (!parsed.ok) throw new CatalogueHttpError(400, "invalid_request", parsed.message);
    const { tripId, hero, titleOverride, expectedUpdatedAt } = parsed.value;
    const [store, data, trips] = await Promise.all([deps.store(), deps.data(), deps.listActiveTrips()]);
    await store.ensureCatalogueSchema();
    if (!trips.some((candidate) => candidate.id === tripId)) {
      throw new CatalogueHttpError(404, "trip_not_found", "Идэвхтэй аялал олдсонгүй.");
    }
    if (hero) {
      const found = await data.listPhotoCandidates(tripId);
      if (!found.candidates.some((candidate) => candidate.url === hero.url)) {
        recordCounter("catalogue.hero_refused_total", 1, { reason: "not_a_candidate" });
        throw new CatalogueHttpError(422, "photo_not_a_candidate", "Энэ зураг уг аяллын зургийн жагсаалтад байхгүй тул сонгож болохгүй.");
      }
    }

    const current = await store.getCatalogueConfig();
    const heroByTripId: Record<string, CatalogueHeroChoice> = { ...(current.heroByTripId ?? {}) };
    const titleOverrides: Record<string, string> = { ...(current.titleOverrides ?? {}) };
    if (hero === null) delete heroByTripId[tripId];
    else if (hero) heroByTripId[tripId] = { url: hero.url, focal: hero.focal, zoom: hero.zoom };
    if (titleOverride === null) delete titleOverrides[tripId];
    else if (titleOverride !== undefined) titleOverrides[tripId] = titleOverride;

    const next: CatalogueConfig = { ...current, heroByTripId, titleOverrides };
    const saved = await store.saveCatalogueConfig(next, actor, expectedUpdatedAt === undefined ? undefined : { expectedUpdatedAt });
    recordCounter("catalogue.hero_saved_total", 1, { hero: hero === undefined ? "unchanged" : hero === null ? "cleared" : "chosen" });
    logInfo("catalogue.admin.photo_saved", { requestId: trace.requestId, actor: actor ? "admin" : "token", tripId });
    res.status(200).json({
      ok: true,
      tripId,
      config: saved,
      chosen: saved.heroByTripId?.[tripId] ?? null,
      titleOverride: saved.titleOverrides?.[tripId] ?? null,
    });
  },
});
