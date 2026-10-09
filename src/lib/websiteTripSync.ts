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
      bookingPool().query(`SELECT t."sourceTripId", d."startDate", d.status, d."seatsLeft"
        FROM "Trip" t JOIN "Departure" d ON d."tripId"=t.id
        WHERE t."sourceTripId"=ANY($1::text[])`, [trips.map((trip) => trip.id)]),
      // The bot sends the live website page instead of the PDF; the slug is
      // whatever the website currently has (staff can rename it there), never
      // guessed here, so a changed slug on the website never 404s for a customer.
      bookingPool().query(`SELECT t.*, (SELECT jsonb_agg(i ORDER BY i."dayNumber") FROM "ItineraryDay" i WHERE i."tripId"=t.id AND i."dayNumber">0) AS itinerary FROM "Trip" t
        WHERE "sourceTripId"=ANY($1::text[])`, [trips.map((trip) => trip.id)]),
    ]);
    const canonicalOffersByTrip = new Map<string, unknown>(
      slugResult.rows.map((row) => [row.sourceTripId as string, record(row.sourceMetadata).canonicalOffers]),
    );
    const byTrip = new Map<string, Array<{ date: string; status: string; seatsLeft: number | null }>>();
    for (const row of departureResult.rows) {
      const entries = byTrip.get(row.sourceTripId) || [];
      entries.push(websiteAvailabilityForResync({
        date: new Date(new Date(row.startDate).getTime() + 8 * 3600000).toISOString().slice(0, 10),
        status: row.status, seatsLeft: row.seatsLeft,
      }, canonicalOffersByTrip.get(row.sourceTripId)));
      byTrip.set(row.sourceTripId, entries);
    }
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
  const oldDepartures = (await client.query(`SELECT * FROM "Departure" WHERE "tripId"=$1`, [id])).rows;
  const seatsChanged = !prior || (Object.keys(previousSnapshot).length > 0 &&
    (previousSnapshot.seats_total !== source.seats_total || previousSnapshot.seats_left !== source.seats_left));
  // A draft source can already have a website departure. Publishing it must
  // reopen that departure just like resuming a paused or sold-out source.
  const reopened = Boolean(previousSnapshot.status)
    && previousSnapshot.status !== "active"
    && source.status === "active";
  const liveSource: TravelTrip = { ...source, extra: { ...source.extra,
    website_departure_availability: oldDepartures.map(departure => {
      const availability = websiteAvailabilityForResync({
        date: new Date(new Date(departure.startDate).getTime() + 8 * 3600000).toISOString().slice(0, 10),
        status: departure.status, seatsLeft: departure.seatsLeft,
      }, record(prior?.sourceMetadata).canonicalOffers);
      return { ...availability,
        status: reopened ? "OPEN" : availability.status,
        seatsLeft: seatsChanged ? source.seats_left : availability.seatsLeft,
      };
    }),
  } };
  const offering = websiteTripPayload(liveSource, websiteDepartureSchedule(source, now), now);
  const hadSourcePhotos = strings(previousSnapshot.photos).length > 0;
  const image = photos[0] || (hadSourcePhotos ? "" : prior?.image || "");
  const pdf = getPosterPdfPublicUrl(String(source.extra.poster_trip_id));
  if (!pdf) throw new Error("SITE_URL is required for the shared poster PDF");
  const marketingBadge = websiteMarketingBadge(source);
  const metadata = { ...record(prior?.sourceMetadata), ...source.extra,
    price_groups: offering.priceGroups, canonicalOffers: offering.canonicalOffers,
    marketingBadge, connectedSource: { ...source, photos, poster, marketingBadge } };
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
    description: source.notes || String(poster.subtitle || source.route_name),
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
  const mergedContent = prior ? mergeWebsiteContent(prior, { ...fallbackBaseline, ...baselineContent }, proposedContent, { preferIncoming: true }) : { data: proposedContent, conflicts: [] };
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
    lastSyncedAt: new Date(),
  };
  if (prior) {
    const entries = Object.entries(data);
    await client.query(`UPDATE "Trip" SET ${entries.map(([key], i) => `"${key}"=$${i + 2}${["sourceMetadata", "hotelMedia", "travelerMedia"].includes(key) ? "::jsonb" : ""}`).join(",")}, "updatedAt"=NOW() WHERE id=$1`,
      [id, ...entries.map(([key, value]) => ["hotelMedia", "travelerMedia"].includes(key) ? JSON.stringify(value) : value)]);
  } else {
    const entries = Object.entries({ id, slug, sourceTripId: source.id, ...data, isFeatured: false });
    await client.query(`INSERT INTO "Trip" (${entries.map(([key]) => `"${key}"`).join(",")})
      VALUES (${entries.map(([key], i) => `$${i + 1}${["sourceMetadata", "hotelMedia", "travelerMedia"].includes(key) ? "::jsonb" : ""}`).join(",")})`, entries.map(([key, value]) => ["hotelMedia", "travelerMedia"].includes(key) ? JSON.stringify(value) : value));
  }
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
  const keep: string[] = [];
  for (const dep of offering.departures) {
    const old = oldDepartures.find(row => new Date(new Date(row.startDate).getTime() + 8 * 3600000).toISOString().slice(0, 10) === dep.start.slice(0, 10));
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
  await client.query(`UPDATE "Trip" SET "sourceMetadata"=jsonb_set("sourceMetadata",'{contentConflicts}',$2::jsonb) WHERE id=$1`, [id, JSON.stringify(allConflicts)]);
  return { id, slug, contentConflict: newConflicts.length > 0 };
}

export async function flushWebsiteSync(tripId?: string, limit = 5) {
  await ensureConnectedTripSchema();
  let processed = 0;
  const deadline = Date.now() + 40000;
  for (let i = 0; i < limit; i++) {
    if (Date.now() >= deadline) break;
    const attempted = await withNeonClient(async sourceDb => {
      await sourceDb.query("BEGIN");
      let job: { trip_id: string; revision: string } | undefined;
      try {
        const candidate = (await sourceDb.query(`SELECT trip_id FROM trip_website_sync
          WHERE revision > synced_revision AND ($1::text IS NULL OR trip_id=$1)
          ORDER BY updated_at LIMIT 1`, [tripId || null])).rows[0];
        if (!candidate) { await sourceDb.query("COMMIT"); return null; }
        // Match the canonical save lock order before locking the delivery row.
        const locked = (await sourceDb.query("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked", [candidate.trip_id])).rows[0]?.locked;
        if (!locked) { await sourceDb.query("ROLLBACK"); return null; }
        job = (await sourceDb.query(`SELECT * FROM trip_website_sync
          WHERE trip_id=$1 AND revision>synced_revision FOR UPDATE SKIP LOCKED`, [candidate.trip_id])).rows[0];
        if (!job) { await sourceDb.query("COMMIT"); return null; }
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
        return true;
      } catch (error) {
        await sourceDb.query("ROLLBACK");
        if (job) await queryNeon(`UPDATE trip_website_sync SET attempts=attempts+1,last_error=$2,updated_at=NOW() WHERE trip_id=$1`,
          [job.trip_id, error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/\S+/g, "[database]").slice(0, 300) : "Website sync failed"]);
        return false;
      }
    });
    if (attempted === null) break;
    if (attempted) processed++;
  }
  return { processed };
}

export async function websiteSyncStatus() {
  return (await queryNeon(`SELECT s.trip_id,s.revision=s.synced_revision AS synced,s.last_error,
      s.website_trip_id,s.website_slug,s.synced_at,s.content_conflict
    FROM trip_website_sync s
    LEFT JOIN travel_trip_entries t ON t.id=s.trip_id
    WHERE t.id IS NOT NULL OR s.last_error IS NOT NULL OR s.revision > s.synced_revision OR s.content_conflict
    ORDER BY s.updated_at DESC`))?.rows || [];
}
export async function closeBookingPool() { await pool?.end(); pool = undefined; }
