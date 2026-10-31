import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { queryNeon, withNeonClient } from "./neonDb";
import { ensureConnectedTripSchema } from "./connectedTripStore";
import { duration, posterPhotos, record, records, strings, websiteDepartureSchedule, websiteExtraDetails, websiteMarketingBadge } from "./connectedTripMapping";
import { websiteAvailabilityForResync, websiteTripPayload } from "./websiteTripPayload";
import { getEnv } from "./env";
import { getPosterPdfPublicUrl } from "./poster/pdfUrl";
import { classifyTripCategory } from "./tripCategorization";
import type { TravelTrip } from "./travelTypes";
import { sameDatabase, websiteProjectionTransaction } from "./websiteSyncTransaction";
import { applyWebsiteDetailsPatch, mergeWebsiteContent, websiteDetailsSnapshot } from "./websiteTripDetails";
import { sameParityValue } from "./tripWebsiteParityValue";
import { departureSeatsAfterTripEdit } from "./departureSeats";
import type { WebsiteSyncRow } from "./websiteSyncStatus";
import { websiteDepartureDateKey } from "./websiteDepartureDate";
import { currentWebsiteDepartureRows } from "./websiteDepartureRows";
import { BOOKING_WEBSITE_URL } from "./bookingWebsite";
import { logWarn } from "./observability";

let pool: Pool | undefined;
function bookingPool() {
  if (!process.env.BOOKING_DATABASE_URL) throw new Error("BOOKING_DATABASE_URL is not configured");
  if (!pool) {
    const url = new URL(process.env.BOOKING_DATABASE_URL);
    if (url.searchParams.has("sslmode")) url.searchParams.set("sslmode", "verify-full");
    pool = new Pool({ connectionString: url.toString(), max: 3, connectionTimeoutMillis: 10000,
      statement_timeout: 20000, idleTimeoutMillis: 10000, allowExitOnIdle: true });
    pool.on("error", () => console.error("Booking database connection interrupted"));
  }
  return pool;
}

export async function withWebsiteDepartureAvailability(trips: TravelTrip[]): Promise<TravelTrip[]> {
  if (!process.env.BOOKING_DATABASE_URL || !trips.length) return trips;
  try {
    const [departureResult, slugResult] = await Promise.all([
      // No sourceMetadata here: it is ~15 KB per trip and the join repeats it on
      // every departure row (35 MB for 343 departures, 90 s). The trip rows
      // fetched below carry it once.
      bookingPool().query<{ sourceTripId: string; startDate: string; status: string; seatsLeft: number | null }>(`SELECT t."sourceTripId", d."startDate"::text AS "startDate", d.status, d."seatsLeft"
        FROM "Trip" t JOIN "Departure" d ON d."tripId"=t.id
        WHERE t."sourceTripId"=ANY($1::text[])`, [trips.map((trip) => trip.id)]),
      // The bot sends the live website page instead of the PDF; the slug is
      // whatever the website currently has (staff can rename it there), never
      // guessed here, so a changed slug on the website never 404s for a customer.
      //
      // Do not SELECT t.* here. sourceMetadata contains a complete connected
      // source/poster snapshot and accounted for most of a multi-megabyte row
      // transfer on every catalogue read. Availability only needs its canonical
      // offers, while the admin detail snapshot needs contentConflicts plus the
      // explicit editorial fields below.
      bookingPool().query(`SELECT
          t."sourceTripId", t.slug, t.title, t.summary, t.description,
          t.country, t.city, t.region, t.destinations, t.transport, t.languages,
          t."meetingPoint", t."mapUrl", t.season, t.difficulty,
          t."minTravelers", t."maxTravelers", t."oldPrice", t.discount,
          t."singleSupplement", t."brochurePdfUrl", t."isFeatured", t.highlights,
          t.requirements, t."cancellationPolicy", t."extraFees", t."roomPrices",
          t."childPriceNotes", t.video, t.videos, t."hotelMedia", t."travelerMedia",
          t.weather, t."updatedAt", t."isPublished", t.price, t."childPrice",
          t."infantPrice", t.currency,
          jsonb_build_object(
            'canonicalOffers', COALESCE(t."sourceMetadata"->'canonicalOffers', '[]'::jsonb),
            'contentConflicts', COALESCE(t."sourceMetadata"->'contentConflicts', '[]'::jsonb)
          ) AS "sourceMetadata",
          (SELECT jsonb_agg(i ORDER BY i."dayNumber")
             FROM "ItineraryDay" i
            WHERE i."tripId"=t.id AND i."dayNumber">0) AS itinerary
        FROM "Trip" t
        WHERE t."sourceTripId"=ANY($1::text[])`, [trips.map((trip) => trip.id)]),
    ]);
    const canonicalOffersByTrip = new Map<string, unknown>(
      slugResult.rows.map((row) => [row.sourceTripId as string, record(row.sourceMetadata).canonicalOffers]),
    );
    const rowsByTrip = new Map<string, typeof departureResult.rows>();
    for (const row of departureResult.rows) {
      const entries = rowsByTrip.get(row.sourceTripId) || [];
      entries.push(row);
      rowsByTrip.set(row.sourceTripId, entries);
    }
    const byTrip = new Map(Array.from(rowsByTrip, ([sourceTripId, rows]) => [sourceTripId,
      currentWebsiteDepartureRows(rows).map(row => websiteAvailabilityForResync({
        date: websiteDepartureDateKey(row.startDate),
        status: row.status, seatsLeft: row.seatsLeft,
      }, canonicalOffersByTrip.get(sourceTripId))),
    ]));
    const slugByTrip = new Map<string, { slug: string; isPublished: boolean; details: Record<string, unknown> }>();
    for (const row of slugResult.rows) {
      if (typeof row.slug === "string" && row.slug.trim()) {
        slugByTrip.set(row.sourceTripId, { slug: row.slug.trim(), isPublished: Boolean(row.isPublished), details: websiteDetailsSnapshot(row) });
      }
    }
    return trips.map((trip) => {
      const slugRow = slugByTrip.get(trip.id);
      const extra = {
        ...trip.extra,
        ...(byTrip.has(trip.id) ? { website_departure_availability: byTrip.get(trip.id) } : {}),
        ...(slugRow ? { website_slug: slugRow.slug, website_published: slugRow.isPublished, website_details: slugRow.details } : {}),
      };
      return (byTrip.has(trip.id) || slugRow) ? { ...trip, extra } : trip;
    });
  } catch {
    console.error("Could not read website departure availability");
    return trips;
  }
}

// The website only draws photos from these hosts (next.config remotePatterns).
// Any other https photo is copied to Cloudinary first, or it shows as a broken image.
const SITE_PHOTO_HOSTS = /^https:\/\/(res\.cloudinary\.com|images\.unsplash\.com)\//;
export function isSitePhotoHost(photo: string): boolean {
  return SITE_PHOTO_HOSTS.test(photo);
}

const MAX_REMOTE_PHOTO_BYTES = 12 * 1024 * 1024;

async function uploadToCloudinary(file: string | Blob, hash: string): Promise<string | null> {
  const env = getEnv();
  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = `uudam-connected-trips/${hash}`;
  const signature = createHash("sha256")
    .update(`public_id=${publicId}&timestamp=${timestamp}${env.cloudinaryApiSecret}`).digest("hex");
  const form = new FormData();
  form.append("file", file);
  Object.entries({ public_id: publicId, timestamp: String(timestamp), api_key: env.cloudinaryApiKey, signature })
    .forEach(([key, value]) => form.append(key, String(value)));
  const response = await fetch(`https://api.cloudinary.com/v1_1/${env.cloudinaryCloudName}/image/upload`,
    { method: "POST", body: form, signal: AbortSignal.timeout(25000) });
  const body = await response.json().catch(() => ({}));
  return response.ok && typeof body.secure_url === "string" ? body.secure_url : null;
}

async function downloadRemotePhoto(url: string): Promise<Blob | null> {
  const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; UudamTravel/1.0)" }, redirect: "follow", signal: AbortSignal.timeout(15000) });
  const type = response.headers.get("content-type") || "";
  if (!response.ok || !type.startsWith("image/")) return null;
  const bytes = await response.arrayBuffer();
  return bytes.byteLength > 0 && bytes.byteLength <= MAX_REMOTE_PHOTO_BYTES ? new Blob([bytes], { type }) : null;
}

async function hostedPhoto(photo: string): Promise<string> {
  if (isSitePhotoHost(photo)) return photo;
  const remote = photo.startsWith("https://");
  const hash = createHash("sha256").update(photo).digest("hex");
  const cached = await queryNeon<{ url: string }>("SELECT url FROM connected_trip_assets WHERE hash=$1", [hash]);
  if (cached?.rows[0]) return cached.rows[0].url;
  const env = getEnv();
  if (!env.cloudinaryApiSecret || !env.cloudinaryCloudName || !env.cloudinaryApiKey) {
    if (remote) return photo;
    throw new Error("Photo hosting is not configured");
  }
  let url: string | null = null;
  try {
    // A web photo: let Cloudinary fetch it; if the source refuses that, download it here and upload the bytes.
    url = await uploadToCloudinary(photo, hash);
    if (!url && remote) {
      const blob = await downloadRemotePhoto(photo);
      if (blob) url = await uploadToCloudinary(blob, hash);
    }
  } catch (error) {
    if (!remote) throw error;
    console.warn("Could not copy an outside photo to Cloudinary:", error instanceof Error ? error.message : error);
  }
  // A dead or refused outside link must never block saving a trip: keep it as it was.
  if (!url) {
    if (remote) return photo;
    throw new Error("Photo upload failed");
  }
  await queryNeon("INSERT INTO connected_trip_assets(hash,url) VALUES ($1,$2) ON CONFLICT(hash) DO NOTHING", [hash, url]);
  return url;
}

export type ContentSnapshot = {
  title: string; summary: string | null; description: string; hotel: string | null;
  included: string[]; excluded: string[]; importantNotes: string[];
};
export function contentSnapshotHash(snapshot: ContentSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}
/**
 * A description staff cleared on the website stays cleared. This projection
 * otherwise always fills it, and the chatbot stores both "never written" and
 * "cleared" as "", so falling back to the poster subtitle used to refill every
 * cleared description on the very next sync. No website row yet = fill it.
 */
export function websiteDescription(
  websiteDescriptionNow: unknown, notes: string | null | undefined, subtitle: unknown, routeName: string,
): string {
  if (websiteDescriptionNow !== undefined && websiteDescriptionNow !== null && !String(websiteDescriptionNow).trim()) return "";
  return notes || String(subtitle || routeName);
}
/**
 * Legacy hash-policy helper, retained for compatibility with older callers.
 * The active projection uses mergeWebsiteContent's per-field three-way check.
 * A staff edit on the website only wins when the chatbot side truly has not
 * changed since the last sync (same content hash) — any real chatbot/poster
 * edit (a differing hash) always takes precedence and clears the hold, so a
 * conflict can never lock a trip out of future genuine updates.
 */
export function staffEditHoldsContent(args: {
  hasPriorTrip: boolean; freshHash: string; priorHash: string | null;
  priorUpdatedAt: string | Date | null | undefined; priorLastSyncedAt: string | Date | null | undefined;
}): boolean {
  const { hasPriorTrip, freshHash, priorHash, priorUpdatedAt, priorLastSyncedAt } = args;
  const chatbotContentChanged = !hasPriorTrip || priorHash !== freshHash;
  if (chatbotContentChanged || !priorLastSyncedAt || !priorUpdatedAt) return false;
  return new Date(priorUpdatedAt) > new Date(priorLastSyncedAt);
}

export async function materializePoster(input: unknown) {
  const data = { ...record(input) };
  const photos = posterPhotos(data);
  const urls = new Map<string, string>();
  for (let i = 0; i < photos.length; i += 4) {
    await Promise.all(photos.slice(i, i + 4).map(async photo => urls.set(photo, await hostedPhoto(photo))));
  }
  data.days = records(data.days).map(day => ({ ...day, photo: urls.get(String(day.photo)) || day.photo || null }));
  if (typeof data.hero_image === "string") data.hero_image = urls.get(data.hero_image) || data.hero_image;
  return data;
}

const NOT_HELD = new Set(["id", "createdAt", "updatedAt", "lastSyncedAt", "avgRating", "reviewCount", "salesCount", "weather", "sourceTripId", "slug", "sourceMetadata"]);

/**
 * Website fields with a staff edit the chatbot has not received yet (the
 * website's delivery queue, src/server/tripSyncQueue.ts there). A projection
 * keeps them as they are: preferring the chatbot's value used to wipe such an
 * edit from the website while it waited for delivery. Queue entries from
 * before 2026-10-31 carry a whole-trip baseline instead of named edits.
 */
export function heldWebsiteFields(sourceMetadata: unknown): Set<string> {
  const pending = record(record(sourceMetadata).websiteSyncPending);
  if (typeof pending.id !== "string" || pending.archive === true) return new Set();
  const edits = record(pending.edits);
  if (pending.edits && typeof pending.edits === "object") return new Set(Object.keys(edits));
  const trip = record(pending.trip), previous = record(pending.previousTrip);
  if (!Object.keys(previous).length) return new Set();
  const held = new Set(Object.keys(trip).filter((key) => !NOT_HELD.has(key) && !sameParityValue(trip[key], previous[key])));
  for (const key of ["price_groups", "age_rules", "hotel_profiles", "hotel_links", "canonicalExtraPatch"]) {
    if (!sameParityValue(record(trip.sourceMetadata)[key], record(previous.sourceMetadata)[key])) held.add(`sourceMetadata.${key}`);
  }
  return held;
}

async function upsertWebsiteTrip(client: PoolClient, source: TravelTrip, poster: Record<string, unknown>) {
  // Stable source IDs, not titles, are the identity across both databases.
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [source.id]);
  const prior = (await client.query(`SELECT * FROM "Trip" WHERE "sourceTripId"=$1 FOR UPDATE`, [source.id])).rows[0];
  const id = prior?.id || randomUUID();
  const slug = prior?.slug || `trip-${createHash("sha256").update(source.id).digest("hex").slice(0, 20)}`;
  const d = duration(source.duration_text);
  const photos = [...new Set([...posterPhotos(poster), ...source.photo_urls])];
  const previousSnapshot = record(record(prior?.sourceMetadata).connectedSource);
  const now = new Date();
  const previousSource = previousSnapshot.id ? { ...previousSnapshot, extra: record(previousSnapshot.extra), photo_urls: strings(previousSnapshot.photo_urls), departure_dates: strings(previousSnapshot.departure_dates) } as unknown as TravelTrip : null;
  const previousOffering = previousSource ? websiteTripPayload(previousSource, websiteDepartureSchedule(previousSource, now), now) : null;
  const oldDepartures = (await client.query(`SELECT *, "startDate"::text AS "startDate" FROM "Departure" WHERE "tripId"=$1`, [id])).rows;
  const currentDepartures = currentWebsiteDepartureRows(oldDepartures);
  const seatsChanged = !prior || (Object.keys(previousSnapshot).length > 0 &&
    (previousSnapshot.seats_total !== source.seats_total || previousSnapshot.seats_left !== source.seats_left));
  // A draft source can already have a website departure. Publishing it must
  // reopen that departure just like resuming a paused or sold-out source.
  const reopened = Boolean(previousSnapshot.status)
    && previousSnapshot.status !== "active"
    && source.status === "active";
  const liveSource: TravelTrip = { ...source, extra: { ...source.extra,
    website_departure_availability: record(source.extra.partner_sync).source_url
      ? records(source.extra.partner_departure_availability)
      : currentDepartures.map(departure => {
      const availability = websiteAvailabilityForResync({
        date: websiteDepartureDateKey(departure.startDate),
        status: departure.status, seatsLeft: departure.seatsLeft,
      }, record(prior?.sourceMetadata).canonicalOffers);
      return { ...availability,
        // Re-activating a trip reopens closed dates; a date flagged "few seats" stays flagged.
        status: reopened && availability.status !== "ALMOST_FULL" ? "OPEN" : availability.status,
        seatsLeft: departureSeatsAfterTripEdit({
          tripChanged: seatsChanged,
          previousTripSeatsLeft: typeof previousSnapshot.seats_left === "number" ? previousSnapshot.seats_left : null,
          tripSeatsLeft: source.seats_left,
          rowSeatsLeft: availability.seatsLeft,
        }),
      };
    }),
  } };
  const offering = websiteTripPayload(liveSource, websiteDepartureSchedule(source, now), now);
  const hadSourcePhotos = strings(previousSnapshot.photos).length > 0;
  const image = photos[0] || (hadSourcePhotos ? "" : prior?.image || "");
  const pdf = getPosterPdfPublicUrl(String(source.extra.poster_trip_id));
  if (!pdf) throw new Error("SITE_URL is required for the shared poster PDF");
  const marketingBadge = websiteMarketingBadge(source);
  const held = heldWebsiteFields(prior?.sourceMetadata);
  const metadata: Record<string, unknown> = { ...record(prior?.sourceMetadata), ...source.extra,
    price_groups: offering.priceGroups, canonicalOffers: offering.canonicalOffers,
    marketingBadge, connectedSource: { ...source, photos, poster, marketingBadge } };
  for (const field of held) {
    if (field.startsWith("sourceMetadata.")) metadata[field.slice("sourceMetadata.".length)] = record(prior?.sourceMetadata)[field.slice("sourceMetadata.".length)];
  }
  // Never override a category staff picked by hand — only classify a trip
  // that has none yet (a brand-new sync, or one that predates this feature).
  const categoryId = prior?.categoryId
    ? undefined
    : await classifyTripCategory(client, source).catch(() => null);

  // Website edits first update the canonical chatbot record through the private
  // bridge. This projection is therefore authoritative: a second, stale
  // website representation must not survive as a competing customer fact.
  const contentSnapshot: ContentSnapshot = {
    title: source.route_name,
    summary: typeof source.extra.website_summary === "string" && source.extra.website_summary.trim()
      ? source.extra.website_summary.trim()
      : null,
    description: websiteDescription(prior?.description, source.notes, poster.subtitle, source.route_name),
    hotel: source.hotel || null,
    included: strings(source.extra.included_items), excluded: strings(source.extra.excluded_items),
    importantNotes: strings(source.extra.important_notes),
  };
  const contentHash = contentSnapshotHash(contentSnapshot);
  const sourcePriceFields = websiteExtraDetails({ ...source.extra, age_rules: offering.ageRules, price_groups: offering.priceGroups }, {
    adult: offering.price, child: offering.childPrice, infant: offering.infantPrice,
    currency: source.currency || "MNT",
  });
  const previousExtra = record(previousSnapshot.extra);
  const previousPoster = record(previousSnapshot.poster);
  const baselineContent = record(record(prior?.sourceMetadata).contentSnapshot);
  const fallbackBaseline = {
    title: previousSnapshot.route_name,
    summary: previousExtra.website_summary || null,
    description: previousSnapshot.notes || previousPoster.subtitle || previousSnapshot.route_name,
    hotel: previousSnapshot.hotel || null,
    included: strings(previousExtra.included_items), excluded: strings(previousExtra.excluded_items),
    importantNotes: strings(previousExtra.important_notes),
    image: strings(previousSnapshot.photos)[0] || "",
    extraImages: strings(previousSnapshot.photos).slice(1),
    ...websiteExtraDetails(previousExtra, { adult: previousSnapshot.adult_price as number | null, child: previousSnapshot.child_price as number | null, infant: previousSnapshot.infant_price as number | null, currency: String(previousSnapshot.currency || "MNT") }),
    durationDays: previousExtra.duration_days ?? duration(String(previousSnapshot.duration_text || "")).days,
    durationNights: previousExtra.duration_nights ?? duration(String(previousSnapshot.duration_text || "")).nights,
    price: previousSnapshot.adult_price ?? 0, childPrice: previousSnapshot.child_price ?? null, infantPrice: previousSnapshot.infant_price ?? null,
    currency: previousSnapshot.currency || "MNT", foodIncluded: previousSnapshot.has_food ?? null, departureRule: previousExtra.departure_rule || null,
  };
  const proposedContent = { ...contentSnapshot, image,
    extraImages: photos.length || hadSourcePhotos ? photos.filter(p => p !== image) : prior?.extraImages || [],
    ...sourcePriceFields,
    durationDays: source.extra.duration_days ?? d.days, durationNights: source.extra.duration_nights ?? d.nights,
    price: offering.price ?? 0, childPrice: offering.childPrice, infantPrice: offering.infantPrice,
    currency: source.currency || "MNT", foodIncluded: source.has_food, departureRule: source.extra.departure_rule || null,
  };
  const mergedContent = prior ? mergeWebsiteContent(prior, { ...fallbackBaseline, ...baselineContent }, proposedContent, { preferIncoming: true, hold: held }) : { data: proposedContent, conflicts: [] };
  const details = applyWebsiteDetailsPatch(prior, source.extra.website_details_patch);
  const newConflicts = [...mergedContent.conflicts, ...details.conflicts];
  // Conflicts describe the current three-way merge only. Keeping historical
  // conflicts here made an already-resolved trip look permanently divergent.
  const allConflicts = newConflicts.filter((conflict, index, entries) =>
    entries.findIndex(entry => sameParityValue(entry, conflict)) === index,
  );
  const contentFields = mergedContent.data;
  const data: Record<string, unknown> = {
    ...contentFields,
    ...(categoryId !== undefined ? { categoryId } : {}),
    brochurePdfUrl: pdf,
    ...details.data,
    sourceMetadata: JSON.stringify({ ...metadata, contentHash, contentSnapshot: proposedContent, contentConflicts: allConflicts }),
    // "paused" behaves exactly like sold_out here: visible, just not
    // bookable — the trip stays on the site so customers can still ask
    // about it, but every departure below reads as closed, not open.
    isPublished: (source.status === "active" || source.status === "sold_out" || source.status === "paused")
      && source.extra.customer_visible !== false,
  };
  if (prior) for (const field of held) if (field in data && field !== "sourceMetadata" && field in prior) data[field] = prior[field];
  // Timestamps come from the database clock. A JS Date bound to these
  // timestamp-without-time-zone columns is written in the process's local
  // zone, which put lastSyncedAt 8 hours ahead whenever a sync ran from a
  // machine on Ulaanbaatar time.
  if (prior) {
    const entries = Object.entries(data);
    await client.query(`UPDATE "Trip" SET ${entries.map(([key], i) => `"${key}"=$${i + 2}${["sourceMetadata", "hotelMedia", "travelerMedia"].includes(key) ? "::jsonb" : ""}`).join(",")}, "lastSyncedAt"=NOW(), "updatedAt"=NOW() WHERE id=$1`,
      [id, ...entries.map(([key, value]) => ["hotelMedia", "travelerMedia"].includes(key) ? JSON.stringify(value) : value)]);
  } else {
    const entries = Object.entries({ id, slug, sourceTripId: source.id, ...data, isFeatured: false });
    await client.query(`INSERT INTO "Trip" (${entries.map(([key]) => `"${key}"`).join(",")},"lastSyncedAt")
      VALUES (${entries.map(([key], i) => `$${i + 1}${["sourceMetadata", "hotelMedia", "travelerMedia"].includes(key) ? "::jsonb" : ""}`).join(",")},NOW())`, entries.map(([key, value]) => ["hotelMedia", "travelerMedia"].includes(key) ? JSON.stringify(value) : value));
  }
  // A website itinerary edit still on its way to the chatbot keeps its days.
  if (!held.has("itinerary")) {
    const days = records(poster.days);
    const oldDays = (await client.query(`SELECT * FROM "ItineraryDay" WHERE "tripId"=$1 AND "dayNumber">0`, [id])).rows;
    const previousDays = records(previousPoster.days);
    const dayNumbers: number[] = [];
    for (const [i, day] of days.entries()) {
      // Photos are an independent gallery; photo-only slots are not itinerary days.
      if (!day.route && !day.summary && !day.hotel) continue;
      const number = Number(day.day) || i + 1;
      if (dayNumbers.includes(number)) throw new Error("Duplicate itinerary day numbers require review");
      dayNumbers.push(number);
      const previousDay = previousDays.find((entry, index) => (Number(entry.day) || index + 1) === number);
      if (prior && previousDay && sameParityValue(previousDay, day)) continue;
      const meals = record(day.meals);
      const dayFields = { title: String(day.route || `${number}-р өдөр`), description: day.summary || null, accommodation: day.hotel || null,
        meals: [meals.breakfast ? "Өглөө" : "", meals.lunch ? "Өдөр" : "", meals.dinner ? "Орой" : ""].filter(Boolean), image: day.photo || null };
      const oldDay = oldDays.find((entry) => entry.dayNumber === number);
      if (oldDay) {
        const oldMeals = record(previousDay?.meals);
        const baseline = { title: previousDay?.route, description: previousDay?.summary || null, accommodation: previousDay?.hotel || null,
          meals: [oldMeals.breakfast ? "Өглөө" : "", oldMeals.lunch ? "Өдөр" : "", oldMeals.dinner ? "Орой" : ""].filter(Boolean), image: previousDay?.photo || null };
        const result = mergeWebsiteContent(oldDay, baseline, dayFields, { preferIncoming: true });
        const entries = Object.entries(result.data);
        if (entries.length) await client.query(`UPDATE "ItineraryDay" SET ${entries.map(([key], index) => `"${key}"=$${index + 2}`).join(",")} WHERE id=$1`, [oldDay.id, ...entries.map(([, value]) => value)]);
        for (const conflict of result.conflicts) {
          const entry = { ...conflict, field: `itinerary.${number}.${conflict.field}` };
          newConflicts.push(entry);
          if (!allConflicts.some((saved) => sameParityValue(saved, entry))) allConflicts.push(entry);
        }
      } else await client.query(`INSERT INTO "ItineraryDay" (id,"tripId","dayNumber",title,description,accommodation,meals,image)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [randomUUID(), id, number, dayFields.title, dayFields.description, dayFields.accommodation, dayFields.meals, dayFields.image]);
    }
    // Only archive removed source days when the website has no independent edits.
    let archiveDayNumber = Math.min(0, Number((await client.query(`SELECT MIN("dayNumber") AS minimum FROM "ItineraryDay" WHERE "tripId"=$1`, [id])).rows[0]?.minimum) || 0) - 1;
    for (const [index, previousDay] of previousDays.entries()) {
      const number = Number(previousDay.day) || index + 1;
      if (dayNumbers.includes(number)) continue;
      const oldDay = oldDays.find((entry) => entry.dayNumber === number);
      if (!oldDay) continue;
      const meals = record(previousDay.meals);
      const baseline = { title: String(previousDay.route || `${number}-р өдөр`), description: previousDay.summary || null, accommodation: previousDay.hotel || null,
        meals: [meals.breakfast ? "Өглөө" : "", meals.lunch ? "Өдөр" : "", meals.dinner ? "Орой" : ""].filter(Boolean), image: previousDay.photo || null };
      if (!mergeWebsiteContent(oldDay, baseline, baseline).conflicts.length) {
        await client.query(`UPDATE "ItineraryDay" SET "dayNumber"=$2 WHERE id=$1`, [oldDay.id, archiveDayNumber--]);
      } else {
        const entry = { field: `itinerary.${number}.removed`, website: oldDay, chatbot: null, base: baseline };
        newConflicts.push(entry);
        if (!allConflicts.some((saved) => sameParityValue(saved, entry))) allConflicts.push(entry);
      }
    }
  }
  // Same for departures: a queued website date or fare edit is not undone here.
  if (!held.has("departures")) {
    const keep: string[] = [];
    for (const dep of offering.departures) {
      const old = currentDepartures.find(row => websiteDepartureDateKey(row.startDate) === dep.start.slice(0, 10));
      const depId = old?.id || randomUUID();
      keep.push(depId);
      const status = dep.status;
      if (old) {
        const previousDeparture = previousOffering?.departures.find((entry) => entry.start.slice(0, 10) === dep.start.slice(0, 10));
        const protectedFares = mergeWebsiteContent(old, {
          price: previousDeparture?.price ?? null, childPrice: previousDeparture?.childPrice ?? null, infantPrice: previousDeparture?.infantPrice ?? null,
          label: previousDeparture?.label ?? null, endDate: previousDeparture?.end ?? null,
        }, { price: dep.price ?? null, childPrice: dep.childPrice ?? null, infantPrice: dep.infantPrice ?? null, label: dep.label, endDate: dep.end }, { preferIncoming: true });
        for (const conflict of protectedFares.conflicts) {
          const entry = { ...conflict, field: `departure.${dep.start.slice(0, 10)}.${conflict.field}` };
          newConflicts.push(entry);
          if (!allConflicts.some((saved) => sameParityValue(saved, entry))) allConflicts.push(entry);
        }
        await client.query(`UPDATE "Departure" SET label=$2,"endDate"=$3,status=$4::"DepartureStatus",
          "seatsTotal"=$5,"seatsLeft"=$6,price=$7,"childPrice"=$8,"infantPrice"=$9 WHERE id=$1`,
          [depId, "label" in protectedFares.data ? protectedFares.data.label : old.label, "endDate" in protectedFares.data ? protectedFares.data.endDate : old.endDate, status,
          seatsChanged ? source.seats_total : old.seatsTotal, dep.seatsLeft,
          "price" in protectedFares.data ? protectedFares.data.price : old.price,
          "childPrice" in protectedFares.data ? protectedFares.data.childPrice : old.childPrice,
          "infantPrice" in protectedFares.data ? protectedFares.data.infantPrice : old.infantPrice]);
      } else {
        await client.query(`INSERT INTO "Departure" (id,"tripId",label,"startDate","endDate","seatsTotal","seatsLeft",price,"childPrice","infantPrice",status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::"DepartureStatus")`,
          [depId,id,dep.label,dep.start,dep.end,source.seats_total,dep.seatsLeft,
          dep.price ?? null, dep.childPrice ?? null, dep.infantPrice ?? null,status]);
      }
    }
    // Keep records referenced by bookings, but close removed dates to new bookings.
    await client.query(`UPDATE "Departure" SET status='CANCELLED' WHERE "tripId"=$1 AND NOT(id=ANY($2::text[]))`, [id, keep]);
  }
  await client.query(`UPDATE "Trip" SET "sourceMetadata"=jsonb_set("sourceMetadata",'{contentConflicts}',$2::jsonb) WHERE id=$1`, [id, JSON.stringify(allConflicts)]);
  return { id, slug, contentConflict: newConflicts.length > 0 };
}

export type DateSeatState = "open" | "low" | "full";

/**
 * Sets ONE departure date's seat state straight on the website's departure row
 * (the row both admins, the website and the bot read), so it is true everywhere
 * at once. "low" is the status ALMOST_FULL: still bookable, shown as few seats
 * on that date only. Returns false when the trip has no such live departure.
 */
export async function setDepartureSeatState(sourceTripId: string, date: string, state: DateSeatState): Promise<boolean> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const status = state === "low" ? "ALMOST_FULL" : state === "full" ? "SOLD_OUT" : "OPEN";
  const result = await bookingPool().query(
    `UPDATE "Departure" d SET status=$3::"DepartureStatus",
       -- a stale zero count would keep a reopened date sold out
       "seatsLeft"=CASE WHEN $3 <> 'SOLD_OUT' AND d."seatsLeft"=0 THEN NULL ELSE d."seatsLeft" END
     FROM "Trip" t
     WHERE d."tripId"=t.id AND t."sourceTripId"=$1
       AND (d."startDate" + interval '8 hours')::date = $2::date
       AND d.status NOT IN ('CANCELLED','DEPARTED')
     RETURNING d.id`,
    [sourceTripId, date, status],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function flushWebsiteSync(tripId?: string, limit = 5) {
  // A deployment without the optional website connection keeps its durable
  // events pending until configured; it must not turn them all into errors.
  if (!process.env.BOOKING_DATABASE_URL) return { processed: 0 };
  await ensureConnectedTripSchema();
  let processed = 0;
  const visited = new Set<string>();
  const changedSlugs: string[] = [];
  const deadline = Date.now() + 40000;
  for (let i = 0; i < limit; i++) {
    if (Date.now() >= deadline) break;
    const attempted = await withNeonClient(async sourceDb => {
      await sourceDb.query("BEGIN");
      let job: { trip_id: string; revision: string } | undefined;
      try {
        const candidate = (await sourceDb.query(`SELECT trip_id FROM trip_website_sync
          WHERE revision > synced_revision AND ($1::text IS NULL OR trip_id=$1)
            AND NOT(trip_id=ANY($2::text[]))
          ORDER BY updated_at,trip_id LIMIT 1`, [tripId || null, [...visited]])).rows[0];
        if (!candidate) { await sourceDb.query("COMMIT"); return null; }
        // One attempt per trip per batch: a busy or failing oldest trip must
        // leave the remaining budget available to unrelated queued changes.
        visited.add(candidate.trip_id);
        // Match the canonical save lock order before locking the delivery row.
        const locked = (await sourceDb.query("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked", [candidate.trip_id])).rows[0]?.locked;
        if (!locked) { await sourceDb.query("ROLLBACK"); return false; }
        job = (await sourceDb.query(`SELECT * FROM trip_website_sync
          WHERE trip_id=$1 AND revision>synced_revision FOR UPDATE SKIP LOCKED`, [candidate.trip_id])).rows[0];
        if (!job) { await sourceDb.query("COMMIT"); return false; }
        const sourceTripId = job.trip_id;
        const source = (await sourceDb.query(`SELECT * FROM travel_trip_entries WHERE id=$1`, [job.trip_id])).rows[0] as TravelTrip | undefined;
        const sharedDatabase = sameDatabase(getEnv().neonDatabaseUrl, process.env.BOOKING_DATABASE_URL);
        const target = sharedDatabase ? sourceDb : await bookingPool().connect();
        let linked: { id: string; slug: string; contentConflict: boolean } | undefined;
        try {
          await websiteProjectionTransaction(target, sharedDatabase, async client => {
            if (source) {
              const p = (await sourceDb.query(`SELECT data FROM poster_trips WHERE id=$1`, [source.extra.poster_trip_id])).rows[0];
              if (!p) throw new Error("Connected poster is missing");
              linked = await upsertWebsiteTrip(client, source, await materializePoster(p.data));
            } else {
              await client.query(`UPDATE "Trip" SET "isPublished"=false,"updatedAt"=NOW() WHERE "sourceTripId"=$1`, [sourceTripId]);
            }
          });
        } finally { if (!sharedDatabase) target.release(); }
        await sourceDb.query(`UPDATE trip_website_sync SET synced_revision=$2,synced_at=NOW(),last_error=NULL,
          website_trip_id=$3,website_slug=$4,content_conflict=$5 WHERE trip_id=$1`,
          [job.trip_id,job.revision,linked?.id || null,linked?.slug || null,linked?.contentConflict || false]);
        await sourceDb.query("COMMIT");
        if (linked?.slug) changedSlugs.push(linked.slug);
        return true;
      } catch (error) {
        await sourceDb.query("ROLLBACK");
        // Rollback releases the row/advisory locks. Another save or worker may
        // already have replaced or delivered this revision before we log its failure.
        if (job) await queryNeon(`UPDATE trip_website_sync SET attempts=attempts+1,last_error=$2,updated_at=NOW()
          WHERE trip_id=$1 AND revision=$3 AND revision>synced_revision`,
          [job.trip_id, error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/\S+/g, "[database]").slice(0, 300) : "Website sync failed", job.revision]);
        return false;
      }
    });
    if (attempted === null) break;
    if (attempted) processed++;
  }
  await notifyWebsiteTripsChanged(changedSlugs);
  return { processed };
}

/**
 * The website caches trip pages for up to five minutes and only its own saves
 * refresh them. After a projection writes its rows, ask it to refresh those
 * pages so a chatbot edit is public as soon as the bot starts quoting it.
 * Production only (or an explicit WEBSITE_REVALIDATE_URL): a local or test run
 * must never touch the live site. Failure is logged, never thrown — the rows
 * are already correct and the cache still expires on its own.
 */
export async function notifyWebsiteTripsChanged(slugs: string[]) {
  const unique = [...new Set(slugs.filter(Boolean))];
  const explicit = process.env.WEBSITE_REVALIDATE_URL?.trim();
  if (!unique.length || (!explicit && process.env.VERCEL_ENV !== "production")) return;
  const secret = process.env.WEBSITE_TRIP_SYNC_SECRET || getEnv().adminSecret;
  if (!secret) return;
  try {
    const response = await fetch(`${(explicit || BOOKING_WEBSITE_URL).replace(/\/$/, "")}/api/internal/trip-changed`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-trip-sync-secret": secret },
      body: JSON.stringify({ slugs: unique }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) logWarn("website_revalidate.failed", { status: response.status, slugs: unique.length });
  } catch (error) {
    logWarn("website_revalidate.failed", { message: error instanceof Error ? error.message.slice(0, 200) : String(error) });
  }
}

export async function websiteSyncStatus() {
  const result = await queryNeon<WebsiteSyncRow>(`SELECT s.trip_id,t.route_name AS trip_name,t.status AS trip_status,
      s.revision=s.synced_revision AS synced,s.last_error,s.attempts,s.updated_at,
      s.website_trip_id,s.website_slug,s.synced_at,s.content_conflict,
      CASE WHEN jsonb_typeof(t.extra->'shared_conflicts')='array'
        THEN jsonb_array_length(t.extra->'shared_conflicts') ELSE 0 END AS shared_conflict_count
    FROM trip_website_sync s
    LEFT JOIN travel_trip_entries t ON t.id=s.trip_id
    WHERE t.id IS NOT NULL OR s.last_error IS NOT NULL OR s.revision > s.synced_revision OR s.content_conflict
    ORDER BY (s.revision > s.synced_revision) DESC,s.content_conflict DESC,s.updated_at DESC`);
  if (!result) throw new Error("Website sync status unavailable");
  return result.rows;
}
export async function closeBookingPool() { await pool?.end(); pool = undefined; }
