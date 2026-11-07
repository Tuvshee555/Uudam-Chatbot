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
  type CatalogueHeroChoice,
  type CataloguePhoto,
  type CataloguePhotoCandidate,
  type CataloguePhotoQuality,
  type CatalogueSnapshot,
  type CatalogueTripCard,
  type CatalogueWarning,
  type IsoDay,
  type SnapshotInput,
} from "./types";
import { buildContact, parsePhones } from "./contact";
import { PROVISIONAL_CODE_PREFIX, customerText, dedupeWarnings, row, strList, text, warn } from "./diagnostics";
import { buildGroups, classifyTrips } from "./groups";
import { deriveHighlights } from "./highlights";
import { deriveKicker } from "./kicker";
import { destinationKeys, editorialParts, editorialTitle } from "./editorial";
import { longEdgeOf, measurePhotoSizes, photoKey, photoSizeFromUrl, rankPhotoCandidates, selectHero, type HeroSelection, type PhotoSizes } from "./photos";
import { pickCoverTrip, recommendShortlist, type Shortlist } from "./curation";
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

export { photoSizeFromUrl };
/** A hero whose long edge is known and below this is soft on a phone (a low-resolution warning). */
export const MIN_GOOD_PHOTO_WIDTH = 1000;

const toCataloguePhoto = (candidate: CataloguePhotoCandidate, choice?: { focal?: CataloguePhoto["focal"]; zoom?: number | null }): CataloguePhoto => ({
  url: candidate.url,
  width: candidate.width,
  height: candidate.height,
  credit: candidate.credit,
  source: candidate.source,
  ...(choice?.focal ? { focal: choice.focal } : {}),
  ...(choice?.zoom ? { zoom: choice.zoom } : {}),
});

export type PickedPhoto = {
  photo: CataloguePhoto | null;
  warnings: CatalogueWarning[];
  quality: CataloguePhotoQuality;
  gallery: CataloguePhoto[];
  candidates: CataloguePhotoCandidate[];
  staffChosen: boolean;
};

/**
 * The hero of a trip: the staff's choice (config.heroByTripId) when there is one, else the best
 * ranked stored photo (see photos.ts: resolution, crop headroom, text-overlay risk, source). No
 * usable photo at all gives a null photo and a warning (a controlled placeholder, never a stand-in
 * picture). A hero that is only weak is kept but flagged for replacement.
 */
export function pickPhoto(
  trip: TravelTrip,
  poster: unknown,
  opts: { choice?: CatalogueHeroChoice | null; sizes?: PhotoSizes } = {},
): PickedPhoto {
  const candidates = rankPhotoCandidates(trip, poster, { sizes: opts.sizes });
  return pickFrom(trip, candidates, opts.choice, opts.sizes);
}

/** pickPhoto over an already ranked candidate list (also used to pick again when a hero is taken by another page). */
function pickFrom(trip: TravelTrip, candidates: CataloguePhotoCandidate[], choice: CatalogueHeroChoice | null | undefined, sizes: PhotoSizes | undefined): PickedPhoto {
  const selection: HeroSelection = selectHero(candidates, choice, sizes);
  const gallery = selection.gallery.map((candidate) => toCataloguePhoto(candidate));
  if (!selection.hero) {
    return {
      photo: null, quality: "missing", gallery: [], candidates, staffChosen: false,
      warnings: [warn("photo_missing", "warning", "Тохирох зураг олдсонгүй — хуудас хиймэл зургийн оронд хоосон байрлал (placeholder) хэрэглэнэ. Зураг нэмнэ үү.", trip.id)],
    };
  }
  const photo = toCataloguePhoto(selection.hero, { focal: selection.focal, zoom: selection.zoom });
  const warnings: CatalogueWarning[] = [];
  const long = longEdgeOf(selection.hero);
  if (long !== null && long < MIN_GOOD_PHOTO_WIDTH) {
    warnings.push(warn("photo_low_resolution", "warning", `Хамгийн сайн зураг ч жижиг (${long}px) — утсан дээр бүдэг харагдана. Илүү том зураг нэмнэ үү.`, trip.id, { width: long }));
  } else if (selection.quality === "weak") {
    warnings.push(warn("other", "info", `Нүүр зураг дунд зэрэг (${selection.hero.issues.slice(0, 2).join("; ") || "оноо бага"}) — өөр зураг сонгохыг зөвлөж байна.`, trip.id, { score: selection.hero.score }));
  }
  return { photo, warnings, quality: selection.quality, gallery, candidates, staffChosen: selection.staffChosen };
}

/* ------------------------------------------------------------------ selection */

export type EditionPlan = { trips: TravelTrip[]; warnings: CatalogueWarning[] };

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

/**
 * Which trips an edition prints, in print order.
 *  - quick / preview: the admin's list in the admin's order (an ineligible or missing trip is
 *    reported and skipped), at most CATALOGUE_QUICK_MAX_TRIPS. A QUICK edition whose list is empty
 *    prints the recommended shortlist (curation.ts: a diverse, premium-photo, bookable mix), so a
 *    fresh install never prints "the ten most recently edited trips";
 *  - complete: every eligible trip, the admin's order first, then by trip code.
 * Staff exclusions apply to every edition; featured trips come first.
 */
export function planEdition(
  input: {
    edition: CatalogueEdition;
    trips: readonly TravelTrip[];
    config: CatalogueEditionConfig;
    codeMap?: Record<string, string>;
    /** Only used to recommend a quick shortlist when staff picked none: poster photos, hero choices, measured sizes. */
    recommend?: RecommendContext;
  },
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
  } else if (edition === "quick" && !(config.tripIds ?? []).some((id) => !excluded.has(id))) {
    const eligible = input.trips.filter((trip) => !excluded.has(trip.id) && isTripEligible(trip, today).eligible);
    const recommended = recommendFor(eligible, today, input.recommend);
    const byEligibleId = new Map(eligible.map((trip) => [trip.id, trip]));
    picked = recommended.tripIds.map((id) => byEligibleId.get(id)).filter((trip): trip is TravelTrip => Boolean(trip));
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

export type RecommendContext = {
  /** One photo never opens two pages: a hero (or gallery picture) already used by an earlier card is replaced by the next best. Staff choices are kept. */
  uniquePhotos?: boolean;
  posterByTripId?: Record<string, unknown>;
  heroByTripId?: Record<string, CatalogueHeroChoice>;
  titleOverrides?: Record<string, string>;
  photoSizes?: PhotoSizes;
  groupOverrides?: Record<string, string>;
  siteBaseUrl?: string;
};

type CardParts = { trip: TravelTrip; code: string };

/** The destination names a trip states about itself (staff list + website list), customer-safe. */
function destinationsOf(trip: TravelTrip): string[] {
  const extra = row(trip.extra);
  const website = row(extra.website_details);
  return [...strList(extra.destinations), ...strList(website.destinations)].map(customerText).filter(Boolean);
}

const daysOf = (card: CatalogueTripCard) => /(\d{1,2})\s*өдөр/iu.exec(card.durationText)?.[1] ?? "";

/** Gives two trips that would print the same display title a short, true tell-apart (month, weekday, counter, days, else code). */
function disambiguateTitles(cards: CatalogueTripCard[], qualifiers: Map<string, string>, overridden: Set<string>): void {
  const groups = new Map<string, CatalogueTripCard[]>();
  for (const card of cards) {
    const key = card.editorialTitle.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), card]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const card of group) {
      if (overridden.has(card.tripId)) continue;
      const q = qualifiers.get(card.tripId) ?? "";
      const days = daysOf(card);
      const daysDiffer = group.filter((other) => daysOf(other) === days).length === 1;
      const tag = q ? (/^\d{1,2}$/.test(q) ? `${q}-р хувилбар` : q) : daysDiffer && days ? `${days} өдөр` : "";
      if (tag) card.editorialTitle = `${card.editorialTitle} · ${tag}`;
    }
    // Still equal (same qualifier or none): the stable code is the final, honest tell-apart.
    const seen = new Map<string, CatalogueTripCard[]>();
    for (const card of group) seen.set(card.editorialTitle.toLowerCase(), [...(seen.get(card.editorialTitle.toLowerCase()) ?? []), card]);
    for (const same of seen.values()) {
      if (same.length < 2) continue;
      for (const card of same) if (!overridden.has(card.tripId) && card.code) card.editorialTitle = `${card.editorialTitle} · ${card.code}`;
    }
  }
}

/**
 * Cards (without a collection-level view) for the given trips, in the given order. Shared by the
 * snapshot builder and by the shortlist recommendation, so what is recommended is exactly what
 * would be printed. Pure.
 */
export function buildCards(parts: readonly CardParts[], today: IsoDay, ctx: RecommendContext & { siteUrl: string }): CatalogueTripCard[] {
  const partial = parts.map(({ trip, code }) => {
    const poster = ctx.posterByTripId?.[trip.id];
    const { price, warnings: priceWarnings } = deriveStartingPrice(trip, today);
    const { highlights, warnings: highlightWarnings } = deriveHighlights(trip);
    const picked = pickPhoto(trip, poster, { choice: ctx.heroByTripId?.[trip.id], sizes: ctx.photoSizes });
    const dates = deriveDateInfo(trip, today);
    const transportLabel = transportLabelOf(trip);
    const durationText = durationTextOf(trip);
    const extraWarnings: CatalogueWarning[] = [];
    if (!transportLabel) extraWarnings.push(warn("other", "info", "Тээврийн төрөл тодорхойгүй тул хуудсан дээр харуулахгүй.", trip.id));
    if (!durationText) extraWarnings.push(warn("other", "info", "Аяллын хугацаа бөглөгдөөгүй тул хуудсан дээр харуулахгүй.", trip.id));
    return {
      trip, code, price, dates, highlights, picked, transportLabel, durationText,
      warnings: [...priceWarnings, ...findOverviewPriceConflicts(trip, today, poster), ...highlightWarnings, ...picked.warnings, ...extraWarnings],
    };
  });

  if (ctx.uniquePhotos) {
    const usedHeroes = new Set<string>();
    for (const p of partial) {
      const key = p.picked.photo ? photoKey(p.picked.photo.url) : null;
      if (key && usedHeroes.has(key) && !p.picked.staffChosen) {
        const free = p.picked.candidates.filter((candidate) => !usedHeroes.has(photoKey(candidate.url)));
        const again = pickFrom(p.trip, free, null, ctx.photoSizes);
        const old = p.picked.warnings;
        p.warnings = [...p.warnings.filter((w) => !old.includes(w)), ...again.warnings];
        p.picked = { ...again, candidates: p.picked.candidates };
      }
      if (p.picked.photo) usedHeroes.add(photoKey(p.picked.photo.url));
    }
    const usedGallery = new Set<string>();
    for (const p of partial) {
      p.picked = {
        ...p.picked,
        gallery: p.picked.gallery.filter((photo) => {
          const key = photoKey(photo.url);
          const clash = usedHeroes.has(key) || usedGallery.has(key);
          if (!clash) usedGallery.add(key);
          return !clash;
        }),
      };
    }
  }

  const decisions = classifyTrips(partial.map((p) => ({ trip: p.trip, priceMnt: p.price.kind === "from" ? p.price.amountMnt : null })), ctx.groupOverrides ?? {});
  const qualifiers = new Map<string, string>();
  const overridden = new Set<string>();
  const cards: CatalogueTripCard[] = partial.map((p) => {
    const decision = decisions.get(p.trip.id)!;
    const title = text(p.trip.route_name);
    const destinations = destinationsOf(p.trip);
    const website = row(row(p.trip.extra).website_details);
    const keys = destinationKeys(title, destinations, customerText(website.region) || customerText(website.city));
    const override = text(ctx.titleOverrides?.[p.trip.id]);
    if (override) overridden.add(p.trip.id);
    qualifiers.set(p.trip.id, editorialParts(title).qualifier);
    return {
      tripId: p.trip.id,
      code: p.code,
      title,
      editorialTitle: editorialTitle(title, { destinations }, override),
      destinationKey: keys[0] ?? "",
      destinationKeys: keys,
      heroQuality: p.picked.quality,
      // Secondary pictures are used only when staff have vetted them: the automatic pick put a mall billboard
      // beside a beach hero. Until a staff-chosen gallery exists, every trip page is the hero alone.
      gallery: AUTO_GALLERY ? p.picked.gallery : [],
      kicker: kickerOf(p.trip),
      groupKey: decision.groupKey,
      durationText: p.durationText,
      transportLabel: p.transportLabel,
      highlights: p.highlights,
      price: p.price,
      dates: p.dates,
      detailUrl: detailUrlOf(p.trip, ctx.siteUrl),
      photo: p.picked.photo,
      warnings: dedupeWarnings([...p.warnings, ...decision.warnings]),
    };
  });
  disambiguateTitles(cards, qualifiers, overridden);
  return cards;
}

/** The recommended quick shortlist for eligible trips (cover first), from exactly the cards that would be printed. */
function recommendFor(eligible: readonly TravelTrip[], today: IsoDay, ctx: RecommendContext = {}): Shortlist {
  if (!eligible.length) return { tripIds: [], reasons: {}, cover: null };
  const ordered = [...eligible].sort((a, b) => a.id.localeCompare(b.id));
  const cards = buildCards(ordered.map((trip) => ({ trip, code: "" })), today, { ...ctx, siteUrl: ctx.siteBaseUrl || BOOKING_WEBSITE_URL });
  return recommendShortlist(cards);
}

/** Public: the recommended quick shortlist for live trips (the admin's "Санал болгох" button, scripts). */
export function recommendedShortlistFor(trips: readonly TravelTrip[], today: IsoDay, ctx: RecommendContext = {}): Shortlist {
  return recommendFor(trips.filter((trip) => isTripEligible(trip, today).eligible), today, ctx);
}

/**
 * Builds everything the PDF prints, from live trips and curation. Same input -> same output,
 * including contentHash. Price, dates and warnings are derived by the pricing / highlights /
 * groups modules; this function only selects, orders and assembles.
 */
/** Automatic secondary photos are off: a subject-blind ranking cannot tell a beach from a billboard. */
const AUTO_GALLERY = false;

export function buildCatalogueSnapshot(input: SnapshotInput): CatalogueSnapshot {
  const today = ubDay(input.nowIso);
  const config: CatalogueEditionConfig = {
    tripIds: input.config?.tripIds ?? [],
    groupOverrides: input.config?.groupOverrides ?? {},
    featuredTripIds: input.config?.featuredTripIds ?? [],
    excludedTripIds: input.config?.excludedTripIds ?? [],
  };
  const contact = buildContact(input.contactPhones, input.siteBaseUrl || BOOKING_WEBSITE_URL);
  const recommend: RecommendContext = {
    posterByTripId: input.posterByTripId, heroByTripId: input.heroByTripId, titleOverrides: input.titleOverrides,
    photoSizes: input.photoSizes, groupOverrides: config.groupOverrides, siteBaseUrl: input.siteBaseUrl,
  };
  const plan = planEdition({ edition: input.edition, trips: input.trips, config, codeMap: input.codeMap, recommend }, today);
  const collection: CatalogueWarning[] = [...plan.warnings];

  // A card without its own stable code is never printed: staff could not be asked for "A04".
  const usedCodes = new Map<string, string>();
  const printable: CardParts[] = [];
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

  const cards = buildCards(printable, today, { ...recommend, uniquePhotos: true, siteUrl: contact.siteUrl });
  // Cover: staff's first featured trip when it has a hero; otherwise the best hero + most inviting subject.
  const featuredCover = (config.featuredTripIds ?? []).map((id) => cards.find((card) => card.tripId === id)).find((card) => card && card.photo && card.heroQuality !== "missing");
  const coverTripId = featuredCover?.tripId ?? pickCoverTrip(cards);

  if (!cards.length) {
    collection.push(warn("other", "blocking", input.edition === "complete" ? "Каталогт оруулах боломжтой идэвхтэй аялал алга." : "Каталогт оруулах аялал сонгогдоогүй эсвэл сонгосон аялал бүгд хаалттай байна."));
  } else if (input.edition === "quick" && cards.length < CATALOGUE_QUICK_MIN_TRIPS) {
    collection.push(warn("other", "warning", `Хурдан каталогт ${cards.length} аялал байна; ${CATALOGUE_QUICK_MIN_TRIPS}-${CATALOGUE_QUICK_MAX_TRIPS} аялал байх нь зөв.`, undefined, { count: cards.length }));
  }
  if (!contact.phones.length) {
    collection.push(warn("other", "blocking", "Холбоо барих утас тохируулаагүй тул хаалтын хуудас утасгүй гарна. Админы «Холбоо барих мэдээлэл»-д утсаа оруулна уу."));
  }
  const weakHeroes = cards.filter((card) => card.photo && card.heroQuality === "weak");
  if (weakHeroes.length) {
    collection.push(warn("other", "info", `${weakHeroes.length} аялалд нүүр зураг дунд зэрэг (${weakHeroes.map((card) => card.code).join(", ")}) — зургийг солихыг зөвлөж байна.`, undefined, { count: weakHeroes.length }));
  }

  const groups = buildGroups(cards);
  const issueLabel = dotDay(today);
  const seasonLabel = seasonLabelOf(today, cards);
  const printed = {
    edition: input.edition,
    issueLabel,
    seasonLabel,
    coverTripId,
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
    coverTripId,
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

/** URLs worth measuring for a set of trips: the `perTrip` best candidates by their URL-only score (hints first). */
function candidateUrlsToMeasure(trips: readonly TravelTrip[], posters: Record<string, unknown>, perTrip: number): string[] {
  const urls: string[] = [];
  for (const trip of trips) {
    for (const candidate of rankPhotoCandidates(trip, posters[trip.id]).slice(0, perTrip)) urls.push(candidate.url);
  }
  return unique(urls);
}

/**
 * Everything buildCatalogueSnapshot needs for one edition, read from the live system:
 * active trips (listTrips, the canonical store), the saved curation, stable trip codes
 * (allocated here for any selected trip that has none), poster photos and the contact phones.
 * `tripIdsOverride` replaces the curated list (the admin's 2-trip preview of live trips).
 * `readOnlyCodes` forbids ANY code allocation: used by the review table, which the read-only API
 * token may call. Unallocated trips then carry a provisional in-memory code (see diagnostics.ts).
 * `measurePhotos` reads the real pixel size of the candidate photos (generate, preview and the
 * photo audit only: it downloads images and is never used on a customer path). A QUICK edition
 * with no staff list recommends a diverse shortlist from ALL eligible trips (curation.ts).
 */
export async function loadSnapshotInput(
  edition: CatalogueEdition,
  opts: { nowIso?: string; tripIdsOverride?: string[]; readOnlyCodes?: boolean; measurePhotos?: boolean } = {},
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
  const heroByTripId = saved.heroByTripId ?? {};
  const titleOverrides = saved.titleOverrides ?? {};

  // A quick edition without a staff list recommends from every eligible trip, so their photos are needed up front.
  const recommending = edition === "quick" && !(config.tripIds ?? []).some((id) => !(config.excludedTripIds ?? []).includes(id));
  let posterByTripId: Record<string, unknown> = {};
  let photoSizes: PhotoSizes = {};
  let recommend: RecommendContext | undefined;
  if (recommending) {
    const eligible = trips.filter((trip) => isTripEligible(trip, today).eligible);
    posterByTripId = await loadPosterRows(eligible);
    if (opts.measurePhotos) photoSizes = await measurePhotoSizes(candidateUrlsToMeasure(eligible, posterByTripId, 5));
    recommend = { posterByTripId, heroByTripId, titleOverrides, photoSizes, groupOverrides: config.groupOverrides };
  }

  // Codes are allocated once per trip, oldest trip first, so the first catalogue reads A01, A02, ...
  // A check of an already published file (an override on quick / complete) only READS the codes:
  // freshness checks run on customer paths and must never write. The review table (readOnlyCodes)
  // reads too: the read-only API token may call it, and a GET must not fix the code numbering.
  // The preview and a deliberate Generate allocate, as they print trips that may not have a code yet.
  const planned = planEdition({ edition, trips, config, recommend }, today).trips;
  const readOnly = opts.readOnlyCodes === true;
  const mayAllocate = !readOnly && (!override || edition === "preview");
  const codeMap = await resolveCodeMap(planned, store, { allocate: mayAllocate, provisional: readOnly });
  if (!recommending) posterByTripId = await loadPosterRows(planned);
  if (opts.measurePhotos) {
    const wanted = candidateUrlsToMeasure(planned, posterByTripId, 8).filter((url) => !photoSizes[url]);
    photoSizes = { ...photoSizes, ...(await measurePhotoSizes(wanted)) };
  }
  return {
    edition,
    nowIso,
    trips,
    posterByTripId,
    config,
    heroByTripId,
    titleOverrides,
    ...(opts.measurePhotos ? { photoSizes } : {}),
    codeMap,
    contactPhones: parsePhones(contactSettingsOf(settings.extra).phones),
    siteBaseUrl: BOOKING_WEBSITE_URL,
  };
}

/**
 * Every selectable hero photo of one trip with its real measured size, score and issues, plus the
 * staff choice (config.heroByTripId). For the admin's photo picker. Reads only.
 */
export async function listPhotoCandidates(tripId: string): Promise<{
  trip: { id: string; title: string; editorialTitle: string } | null;
  candidates: CataloguePhotoCandidate[];
  chosen: CatalogueHeroChoice | null;
}> {
  const [{ getTripById }, store] = await Promise.all([import("../travelDb"), import("./store")]);
  const [trip, saved] = await Promise.all([getTripById(tripId), store.getCatalogueConfig()]);
  if (!trip) return { trip: null, candidates: [], chosen: null };
  const posters = await loadPosterRows([trip]);
  const urls = rankPhotoCandidates(trip, posters[trip.id]).map((candidate) => candidate.url);
  const sizes = await measurePhotoSizes(urls);
  const title = text(trip.route_name);
  return {
    trip: { id: trip.id, title, editorialTitle: editorialTitle(title, { destinations: destinationsOf(trip) }, saved.titleOverrides?.[trip.id]) },
    candidates: rankPhotoCandidates(trip, posters[trip.id], { sizes }),
    chosen: saved.heroByTripId?.[trip.id] ?? null,
  };
}

/**
 * The diverse corporate shortlist for the "Санал болгох" button: a balanced mix of themes, one slot
 * per destination, premium photos first (measured), bookable departures only. Reads only.
 */
export async function recommendedQuick(opts: { nowIso?: string; measurePhotos?: boolean } = {}): Promise<Shortlist> {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const today = ubDay(nowIso);
  const [{ listTrips }, store] = await Promise.all([import("../travelDb"), import("./store")]);
  const [live, saved] = await Promise.all([listTrips({ status: "active", limit: 2000 }), store.getCatalogueConfig()]);
  const excluded = new Set(saved.quick.excludedTripIds ?? []);
  const eligible = live.filter((trip) => !excluded.has(trip.id) && isTripEligible(trip, today).eligible);
  const posterByTripId = await loadPosterRows(eligible);
  const photoSizes = opts.measurePhotos === false ? {} : await measurePhotoSizes(candidateUrlsToMeasure(eligible, posterByTripId, 5));
  return recommendFor(eligible, today, {
    posterByTripId, heroByTripId: saved.heroByTripId, titleOverrides: saved.titleOverrides, photoSizes, groupOverrides: saved.quick.groupOverrides,
  });
}
