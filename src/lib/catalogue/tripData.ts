/**
 * Live trips -> CatalogueSnapshot: the data stage of the corporate catalogue.
 *
 *   buildCatalogueSnapshot(input)   PURE and deterministic: no clock, no database, no network.
 *   loadSnapshotInput(edition)      the one impure step: trips from the chatbot's canonical store
 *                                   (listTrips), poster photos, stable trip codes, saved config,
 *                                   configured contact phones.
 *
 * Nothing here keeps a second price or date table. Prices and dates come from the same resolver
 * the bot quotes from (see pricing.ts); photos, copy and links come from the trip and its poster.
 * Everything a trip is missing becomes a warning for the admin, never an invented value.
 */
import { createHash } from "node:crypto";
import type { TravelTrip } from "../travelTypes";
import { BOOKING_WEBSITE_URL, storedWebsiteTripSlug } from "../bookingWebsite";
import { tripTransport } from "../tripFacts";
import { isTransportType } from "../tripTransitDays";
import {
  CATALOGUE_QUICK_MAX_TRIPS,
  CATALOGUE_QUICK_MIN_TRIPS,
  type CatalogueEdition,
  type CatalogueEditionConfig,
  type CataloguePhoto,
  type CatalogueSnapshot,
  type CatalogueTripCard,
  type CatalogueWarning,
  type IsoDay,
  type SnapshotInput,
} from "./types";
import { buildContact, parsePhones } from "./contact";
import { PROVISIONAL_CODE_PREFIX, customerText, dedupeWarnings, row, rows, strList, text, warn } from "./diagnostics";
import { buildGroups, classifyTrips } from "./groups";
import { deriveHighlights } from "./highlights";
import { deriveKicker } from "./kicker";
import { deriveDateInfo, deriveStartingPrice, dotDay, findOverviewPriceConflicts, isTripEligible, ubDay } from "./pricing";

export { deriveStartingPrice, findOverviewPriceConflicts, isTripEligible } from "./pricing";
export { liveDrift } from "./diagnostics";

/* ------------------------------------------------------------------ small derivations */

const TRANSPORT_SHORT: Record<string, string> = {
  direct_flight: "Шууд нислэг",
  land: "Газрын аялал",
  land_flight: "Газар + нислэг",
  cruise: "Усан онгоцны аялал",
};

export function transportLabelOf(trip: TravelTrip): string {
  const structured = row(trip.extra).transport_type;
  if (isTransportType(structured)) return TRANSPORT_SHORT[structured];
  const guessed = tripTransport(trip);
  return guessed ? TRANSPORT_SHORT[guessed] : "";
}

function durationTextOf(trip: TravelTrip): string {
  const written = customerText(trip.duration_text);
  if (written) return written;
  const extra = row(trip.extra);
  const days = Number(extra.duration_days);
  const nights = Number(extra.duration_nights);
  if (Number.isInteger(days) && days > 0) return Number.isInteger(nights) && nights >= 0 ? `${days} өдөр ${nights} шөнө` : `${days} өдөр`;
  return "";
}

/** The line above the headline: a staff-written region / country, else places the title itself names (see kicker.ts). */
function kickerOf(trip: TravelTrip): string {
  const extra = row(trip.extra);
  const website = row(extra.website_details);
  return deriveKicker({
    title: text(trip.route_name),
    country: customerText(website.country),
    region: customerText(website.region) || customerText(website.city),
    destinations: [...strList(extra.destinations), ...strList(website.destinations)].map(customerText).filter(Boolean),
  });
}

function detailUrlOf(trip: TravelTrip, siteUrl: string): string | null {
  const slug = storedWebsiteTripSlug(trip);
  return slug && row(trip.extra).website_published === true ? `${siteUrl}/mn/trips/${encodeURIComponent(slug)}` : null;
}

/* ------------------------------------------------------------------ photos */

export const MIN_GOOD_PHOTO_WIDTH = 1000;
const HTTPS_IMAGE = /^https:\/\/[^\s]+$/i;
const NOT_A_PHOTO = /\.(svg|gif|mp4|mov|webm|pdf)(\?|#|$)|\/video\/upload\//i;

/** Pixel size only when the URL states it unambiguously (an exact Cloudinary crop, a Commons thumb, "-1200x800"). */
export function photoSizeFromUrl(url: string): { width: number | null; height: number | null } {
  const exactCrop = /\/image\/upload\/([^/]*,)?c_(?:fill|scale|thumb|crop|pad)(?:,[^/]*)?\//.test(url);
  if (exactCrop) {
    const w = /(?:^|[,/])w_(\d{2,5})(?=[,/])/.exec(url);
    const h = /(?:^|[,/])h_(\d{2,5})(?=[,/])/.exec(url);
    if (w) return { width: Number(w[1]), height: h ? Number(h[1]) : null };
  }
  const commons = /\/(\d{2,5})px-[^/]+$/.exec(url);
  if (commons) return { width: Number(commons[1]), height: null };
  const named = /[-_](\d{3,5})x(\d{3,5})\.(?:jpe?g|png|webp)(?:\?|#|$)/i.exec(url);
  if (named) return { width: Number(named[1]), height: Number(named[2]) };
  const query = /[?&](?:w|width)=(\d{2,5})(?:&|$)/.exec(url);
  return { width: query ? Number(query[1]) : null, height: null };
}

function creditOf(trip: TravelTrip, url: string): string | null {
  const credit = row(row(row(trip.extra).photo_credits)[url]);
  const author = text(credit.author);
  const license = text(credit.license);
  const line = [author, license].filter(Boolean).join(", ") || text(credit.provider) || text(credit.title);
  return line ? line.slice(0, 160) : null;
}

/**
 * The best approved photo already stored for the trip: the poster hero, then the trip's own photos,
 * then the poster's day photos. A photo whose URL states a small size is used only when nothing
 * bigger exists. None at all gives a null photo and a warning (a controlled placeholder, never a
 * stand-in picture).
 */
export function pickPhoto(trip: TravelTrip, poster: unknown): { photo: CataloguePhoto | null; warnings: CatalogueWarning[] } {
  const posterRow = row(poster);
  const sources: Array<{ url: unknown; source: CataloguePhoto["source"] }> = [
    { url: posterRow.hero_image, source: "poster_hero" },
    ...(trip.photo_urls || []).map((url) => ({ url, source: "trip_photo" as const })),
    ...rows(posterRow.days).map((day) => ({ url: day.photo, source: "poster_day" as const })),
  ];
  const seen = new Set<string>();
  const candidates: Array<CataloguePhoto & { order: number }> = [];
  for (const { url, source } of sources) {
    const clean = typeof url === "string" ? url.trim() : "";
    if (!clean || !HTTPS_IMAGE.test(clean) || NOT_A_PHOTO.test(clean) || seen.has(clean)) continue;
    seen.add(clean);
    const size = photoSizeFromUrl(clean);
    candidates.push({ url: clean, width: size.width, height: size.height, credit: creditOf(trip, clean), source, order: candidates.length });
  }
  if (!candidates.length) {
    return { photo: null, warnings: [warn("photo_missing", "warning", "Тохирох зураг олдсонгүй — хуудас хиймэл зургийн оронд хоосон байрлал (placeholder) хэрэглэнэ. Зураг нэмнэ үү.", trip.id)] };
  }
  const small = (c: CataloguePhoto) => c.width !== null && c.width < MIN_GOOD_PHOTO_WIDTH;
  const good = candidates.filter((c) => !small(c));
  const best = good.length ? good[0] : [...candidates].sort((a, b) => (b.width ?? 0) - (a.width ?? 0) || a.order - b.order)[0];
  const { order: _order, ...photo } = best;
  const warnings: CatalogueWarning[] = [];
  if (small(photo)) {
    warnings.push(warn("photo_low_resolution", "warning", `Хамгийн том зураг ч жижиг (${photo.width}px өргөн) — утсан дээр бүдэг харагдана. Илүү том зураг нэмнэ үү.`, trip.id, { width: photo.width }));
  }
  return { photo, warnings };
}

/* ------------------------------------------------------------------ selection */

export type EditionPlan = { trips: TravelTrip[]; warnings: CatalogueWarning[] };

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

/**
 * Which trips an edition prints, in print order.
 *  - quick / preview: the admin's list in the admin's order (an ineligible or missing trip is
 *    reported and skipped), at most CATALOGUE_QUICK_MAX_TRIPS;
 *  - complete: every eligible trip, the admin's order first, then by trip code.
 * Staff exclusions apply to every edition; featured trips come first.
 */
export function planEdition(
  input: { edition: CatalogueEdition; trips: readonly TravelTrip[]; config: CatalogueEditionConfig; codeMap?: Record<string, string> },
  today: IsoDay,
): EditionPlan {
  const { edition, config } = input;
  const codeMap = input.codeMap ?? {};
  const byId = new Map(input.trips.map((trip) => [trip.id, trip]));
  const excluded = new Set(config.excludedTripIds ?? []);
  const warnings: CatalogueWarning[] = [];
  const label = (trip: TravelTrip) => `«${text(trip.route_name) || trip.id}»`;
  let picked: TravelTrip[] = [];

  if (edition === "complete") {
    const eligible = input.trips.filter((trip) => !excluded.has(trip.id) && isTripEligible(trip, today).eligible);
    const order = new Map(unique(config.tripIds ?? []).map((id, index) => [id, index]));
    picked = [...eligible].sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity)
      || (codeMap[a.id] ?? "~").localeCompare(codeMap[b.id] ?? "~") || text(a.route_name).localeCompare(text(b.route_name)) || a.id.localeCompare(b.id));
  } else {
    for (const id of unique(config.tripIds ?? [])) {
      if (excluded.has(id)) continue;
      const trip = byId.get(id);
      if (!trip) {
        warnings.push(warn("other", "warning", `Сонгосон аялал олдсонгүй (устсан эсвэл идэвхгүй болсон): ${id}`, id));
        continue;
      }
      const verdict = isTripEligible(trip, today);
      if (!verdict.eligible) {
        warnings.push(warn("no_future_departure", "warning", `${label(trip)} — каталогт оруулсангүй: ${verdict.reason}`, id));
        continue;
      }
      picked.push(trip);
    }
    if (picked.length > CATALOGUE_QUICK_MAX_TRIPS) {
      warnings.push(warn("other", "info", `Каталогт ${CATALOGUE_QUICK_MAX_TRIPS} хүртэл аялал багтана; ${picked.length - CATALOGUE_QUICK_MAX_TRIPS} аялал хасагдлаа.`));
      picked = picked.slice(0, CATALOGUE_QUICK_MAX_TRIPS);
    }
  }
  const featured = (config.featuredTripIds ?? []).map((id) => picked.find((trip) => trip.id === id)).filter((trip): trip is TravelTrip => Boolean(trip));
  const rest = picked.filter((trip) => !featured.includes(trip));
  return { trips: [...unique(featured), ...rest], warnings };
}

/* ------------------------------------------------------------------ snapshot */

/** JSON with sorted keys: the same value always serialises to the same bytes. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((k) => record[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function seasonLabelOf(today: IsoDay, cards: readonly CatalogueTripCard[]): string {
  const years = unique([today.slice(0, 4), ...cards.map((card) => card.dates.nextDeparture?.slice(0, 4) ?? "")].filter(Boolean)).sort();
  return years.length <= 1 ? (years[0] ?? today.slice(0, 4)) : `${years[0]} / ${years[years.length - 1]}`;
}

/**
 * Builds everything the PDF prints, from live trips and curation. Same input -> same output,
 * including contentHash. Price, dates and warnings are derived by the pricing / highlights /
 * groups modules; this function only selects, orders and assembles.
 */
export function buildCatalogueSnapshot(input: SnapshotInput): CatalogueSnapshot {
  const today = ubDay(input.nowIso);
  const config: CatalogueEditionConfig = {
    tripIds: input.config?.tripIds ?? [],
    groupOverrides: input.config?.groupOverrides ?? {},
    featuredTripIds: input.config?.featuredTripIds ?? [],
    excludedTripIds: input.config?.excludedTripIds ?? [],
  };
  const contact = buildContact(input.contactPhones, input.siteBaseUrl || BOOKING_WEBSITE_URL);
  const plan = planEdition({ edition: input.edition, trips: input.trips, config, codeMap: input.codeMap }, today);
  const collection: CatalogueWarning[] = [...plan.warnings];

  // A card without its own stable code is never printed: staff could not be asked for "A04".
  const usedCodes = new Map<string, string>();
  const printable: Array<{ trip: TravelTrip; code: string }> = [];
  for (const trip of plan.trips) {
    const code = text(input.codeMap?.[trip.id]);
    if (!code) {
      collection.push(warn("code_collision", "blocking", `«${text(trip.route_name)}» аялалд код олгогдоогүй тул каталогт оруулсангүй.`, trip.id));
      continue;
    }
    const owner = usedCodes.get(code);
    if (owner) {
      collection.push(warn("code_collision", "blocking", `${code} код хоёр аялалд давхцаж байна (${owner}, ${trip.id}) — сүүлийнхийг оруулсангүй.`, trip.id, { code }));
      continue;
    }
    usedCodes.set(code, trip.id);
    printable.push({ trip, code });
  }

  const partial = printable.map(({ trip, code }) => {
    const poster = input.posterByTripId?.[trip.id];
    const { price, warnings: priceWarnings } = deriveStartingPrice(trip, today);
    const { highlights, warnings: highlightWarnings } = deriveHighlights(trip);
    const { photo, warnings: photoWarnings } = pickPhoto(trip, poster);
    const dates = deriveDateInfo(trip, today);
    const transportLabel = transportLabelOf(trip);
    const durationText = durationTextOf(trip);
    const extraWarnings: CatalogueWarning[] = [];
    if (!transportLabel) extraWarnings.push(warn("other", "info", "Тээврийн төрөл тодорхойгүй тул хуудсан дээр харуулахгүй.", trip.id));
    if (!durationText) extraWarnings.push(warn("other", "info", "Аяллын хугацаа бөглөгдөөгүй тул хуудсан дээр харуулахгүй.", trip.id));
    return {
      trip, code, price, dates, highlights, photo, transportLabel, durationText,
      warnings: [...priceWarnings, ...findOverviewPriceConflicts(trip, today, poster), ...highlightWarnings, ...photoWarnings, ...extraWarnings],
    };
  });

  const decisions = classifyTrips(partial.map((p) => ({ trip: p.trip, priceMnt: p.price.kind === "from" ? p.price.amountMnt : null })), config.groupOverrides);
  const cards: CatalogueTripCard[] = partial.map((p) => {
    const decision = decisions.get(p.trip.id)!;
    return {
      tripId: p.trip.id,
      code: p.code,
      title: text(p.trip.route_name),
      kicker: kickerOf(p.trip),
      groupKey: decision.groupKey,
      durationText: p.durationText,
      transportLabel: p.transportLabel,
      highlights: p.highlights,
      price: p.price,
      dates: p.dates,
      detailUrl: detailUrlOf(p.trip, contact.siteUrl),
      photo: p.photo,
      warnings: dedupeWarnings([...p.warnings, ...decision.warnings]),
    };
  });

  if (!cards.length) {
    collection.push(warn("other", "blocking", input.edition === "complete" ? "Каталогт оруулах боломжтой идэвхтэй аялал алга." : "Каталогт оруулах аялал сонгогдоогүй эсвэл сонгосон аялал бүгд хаалттай байна."));
  } else if (input.edition === "quick" && cards.length < CATALOGUE_QUICK_MIN_TRIPS) {
    collection.push(warn("other", "warning", `Хурдан каталогт ${cards.length} аялал байна; ${CATALOGUE_QUICK_MIN_TRIPS}-${CATALOGUE_QUICK_MAX_TRIPS} аялал байх нь зөв.`, undefined, { count: cards.length }));
  }
  if (!contact.phones.length) {
    collection.push(warn("other", "blocking", "Холбоо барих утас тохируулаагүй тул хаалтын хуудас утасгүй гарна. Админы «Холбоо барих мэдээлэл»-д утсаа оруулна уу."));
  }

  const groups = buildGroups(cards);
  const issueLabel = dotDay(today);
  const seasonLabel = seasonLabelOf(today, cards);
  const printed = {
    edition: input.edition,
    issueLabel,
    seasonLabel,
    trips: cards.map(({ warnings: _warnings, ...printedCard }) => printedCard),
    groups,
    contact,
  };
  return {
    edition: input.edition,
    generatedAt: input.nowIso,
    asOfDay: today,
    issueLabel,
    seasonLabel,
    trips: cards,
    groups,
    contact,
    warnings: dedupeWarnings([...collection, ...cards.flatMap((card) => card.warnings)]),
    contentHash: createHash("sha256").update(stableStringify(printed)).digest("hex"),
  };
}

/* ------------------------------------------------------------------ loader (impure) */

const POSTER_SQL = `
  SELECT p.id,
    CASE WHEN p.data->>'hero_image' ~ '^https://' THEN p.data->>'hero_image' END AS hero_image,
    p.data->>'subtitle' AS subtitle,
    p.data->>'price_desc' AS price_desc,
    COALESCE((
      SELECT jsonb_agg(day->>'photo')
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.data->'days') = 'array' THEN p.data->'days' ELSE '[]'::jsonb END) AS day
      WHERE day->>'photo' ~ '^https://'
    ), '[]'::jsonb) AS day_photos
  FROM poster_trips p
  WHERE p.id = ANY($1::text[])`;

/**
 * Poster photos and copy for the given trips. Reads three small JSON paths per poster, never the
 * whole `data` column (it carries the full layout and costs seconds). A missing table or an
 * unreachable database gives no poster data and the trips fall back to their own photos.
 */
export async function loadPosterRows(trips: readonly TravelTrip[]): Promise<Record<string, unknown>> {
  if (!trips.length) return {};
  try {
    const { queryNeon } = await import("../neonDb");
    const posterIdOf = (trip: TravelTrip) => text(row(trip.extra).poster_trip_id) || `poster-for-${trip.id}`;
    const result = await queryNeon<{ id: string; hero_image: string | null; subtitle: string | null; price_desc: string | null; day_photos: unknown }>(
      POSTER_SQL, [trips.map(posterIdOf)],
    );
    const byPoster = new Map((result?.rows ?? []).map((r) => [r.id, r]));
    const out: Record<string, unknown> = {};
    for (const trip of trips) {
      const poster = byPoster.get(posterIdOf(trip));
      if (!poster) continue;
      out[trip.id] = {
        hero_image: poster.hero_image,
        subtitle: poster.subtitle,
        price_desc: poster.price_desc,
        days: (Array.isArray(poster.day_photos) ? poster.day_photos : []).map((photo) => ({ photo })),
      };
    }
    return out;
  } catch (error) {
    console.error("Catalogue: poster rows could not be read", error instanceof Error ? error.message : error);
    return {};
  }
}

export type CodeStorePort = {
  assignTripCodes(tripIds: string[]): Promise<Record<string, string>>;
  getTripCodeMap(): Promise<Record<string, string>>;
};

/**
 * trip id -> code for the planned trips.
 *   allocate  -> permanent codes are allocated for any trip without one (oldest trip first);
 *   otherwise -> the stored map is only READ. With `provisional`, a trip without a stored code gets
 *                an in-memory placeholder (never stored) so a read-only review can still show it.
 */
export async function resolveCodeMap(
  planned: readonly TravelTrip[],
  store: CodeStorePort,
  mode: { allocate: boolean; provisional?: boolean },
): Promise<Record<string, string>> {
  if (!planned.length) return {};
  const order = [...planned].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  if (mode.allocate) return store.assignTripCodes(order.map((trip) => trip.id));
  const stored = await store.getTripCodeMap();
  if (!mode.provisional) return stored;
  const out = { ...stored };
  let next = 0;
  for (const trip of order) {
    if (!text(out[trip.id])) out[trip.id] = `${PROVISIONAL_CODE_PREFIX}${String(++next).padStart(3, "0")}`;
  }
  return out;
}

/**
 * Everything buildCatalogueSnapshot needs for one edition, read from the live system:
 * active trips (listTrips, the canonical store), the saved curation, stable trip codes
 * (allocated here for any selected trip that has none), poster photos and the contact phones.
 * `tripIdsOverride` replaces the curated list (the admin's 2-trip preview of live trips).
 * `readOnlyCodes` forbids ANY code allocation: used by the review table, which the read-only API
 * token may call. Unallocated trips then carry a provisional in-memory code (see diagnostics.ts).
 */
export async function loadSnapshotInput(
  edition: CatalogueEdition,
  opts: { nowIso?: string; tripIdsOverride?: string[]; readOnlyCodes?: boolean } = {},
): Promise<SnapshotInput> {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const today = ubDay(nowIso);
  const [{ listTrips, getTravelBotSettings }, { contactSettingsOf }, store] = await Promise.all([
    import("../travelDb"), import("../contactReplies"), import("./store"),
  ]);
  const [live, settings, saved] = await Promise.all([
    listTrips({ status: "active", limit: 2000 }),
    getTravelBotSettings(),
    store.getCatalogueConfig(),
  ]);
  const override = opts.tripIdsOverride?.length ? unique(opts.tripIdsOverride) : null;
  const trips = override ? live.filter((trip) => override.includes(trip.id)) : live;
  const config: CatalogueEditionConfig = override ? { ...saved[edition], tripIds: override } : saved[edition];

  // Codes are allocated once per trip, oldest trip first, so the first catalogue reads A01, A02, ...
  // A check of an already published file (an override on quick / complete) only READS the codes:
  // freshness checks run on customer paths and must never write. The review table (readOnlyCodes)
  // reads too: the read-only API token may call it, and a GET must not fix the code numbering.
  // The preview and a deliberate Generate allocate, as they print trips that may not have a code yet.
  const planned = planEdition({ edition, trips, config }, today).trips;
  const readOnly = opts.readOnlyCodes === true;
  const mayAllocate = !readOnly && (!override || edition === "preview");
  const codeMap = await resolveCodeMap(planned, store, { allocate: mayAllocate, provisional: readOnly });
  const posterByTripId = await loadPosterRows(planned);
  return {
    edition,
    nowIso,
    trips,
    posterByTripId,
    config,
    codeMap,
    contactPhones: parsePhones(contactSettingsOf(settings.extra).phones),
    siteBaseUrl: BOOKING_WEBSITE_URL,
  };
}
