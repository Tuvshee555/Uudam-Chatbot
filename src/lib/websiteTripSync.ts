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
      bookingPool().query(`SELECT t."sourceTripId", t."sourceMetadata", d."startDate", d.status, d."seatsLeft"
        FROM "Trip" t JOIN "Departure" d ON d."tripId"=t.id
        WHERE t."sourceTripId"=ANY($1::text[])`, [trips.map((trip) => trip.id)]),
      // The bot sends the live website page instead of the PDF; the slug is
      // whatever the website currently has (staff can rename it there), never
      // guessed here, so a changed slug on the website never 404s for a customer.
      bookingPool().query(`SELECT "sourceTripId", slug, "isPublished" FROM "Trip"
        WHERE "sourceTripId"=ANY($1::text[])`, [trips.map((trip) => trip.id)]),
    ]);
    const byTrip = new Map<string, Array<{ date: string; status: string; seatsLeft: number | null }>>();
    for (const row of departureResult.rows) {
      const entries = byTrip.get(row.sourceTripId) || [];
      entries.push(websiteAvailabilityForResync({
        date: new Date(new Date(row.startDate).getTime() + 8 * 3600000).toISOString().slice(0, 10),
        status: row.status, seatsLeft: row.seatsLeft,
      }, record(row.sourceMetadata).canonicalOffers));
      byTrip.set(row.sourceTripId, entries);
    }
    const slugByTrip = new Map<string, { slug: string; isPublished: boolean }>();
    for (const row of slugResult.rows) {
      if (typeof row.slug === "string" && row.slug.trim()) {
        slugByTrip.set(row.sourceTripId, { slug: row.slug.trim(), isPublished: Boolean(row.isPublished) });
      }
    }
    return trips.map((trip) => {
      const slugRow = slugByTrip.get(trip.id);
      const extra = {
        ...trip.extra,
        ...(byTrip.has(trip.id) ? { website_departure_availability: byTrip.get(trip.id) } : {}),
        ...(slugRow ? { website_slug: slugRow.slug, website_published: slugRow.isPublished } : {}),
      };
      return (byTrip.has(trip.id) || slugRow) ? { ...trip, extra } : trip;
    });
  } catch {
    console.error("Could not read website departure availability");
    return trips;
  }
}

async function hostedPhoto(photo: string): Promise<string> {
  if (photo.startsWith("https://")) return photo;
  const hash = createHash("sha256").update(photo).digest("hex");
  const cached = await queryNeon<{ url: string }>("SELECT url FROM connected_trip_assets WHERE hash=$1", [hash]);
  if (cached?.rows[0]) return cached.rows[0].url;
  const env = getEnv();
  if (!env.cloudinaryApiSecret || !env.cloudinaryCloudName || !env.cloudinaryApiKey) throw new Error("Photo hosting is not configured");
  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = `uudam-connected-trips/${hash}`;
  const signature = createHash("sha256")
    .update(`public_id=${publicId}&timestamp=${timestamp}${env.cloudinaryApiSecret}`).digest("hex");
  const form = new FormData();
  Object.entries({ file: photo, public_id: publicId, timestamp: String(timestamp),
    api_key: env.cloudinaryApiKey, signature }).forEach(([key, value]) => form.append(key, value));
  const response = await fetch(`https://api.cloudinary.com/v1_1/${env.cloudinaryCloudName}/image/upload`,
    { method: "POST", body: form, signal: AbortSignal.timeout(20000) });
  const body = await response.json();
  if (!response.ok || typeof body.secure_url !== "string") throw new Error(`Photo upload failed (${response.status})`);
  await queryNeon("INSERT INTO connected_trip_assets(hash,url) VALUES ($1,$2) ON CONFLICT(hash) DO NOTHING", [hash, body.secure_url]);
  return body.secure_url;
}

export type ContentSnapshot = {
  title: string; description: string; hotel: string | null;
  included: string[]; excluded: string[]; importantNotes: string[];
};
export function contentSnapshotHash(snapshot: ContentSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}
/**
 * Decides whether a sync may overwrite this trip's website sell-copy fields.
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
  const oldDepartures = (await client.query(`SELECT * FROM "Departure" WHERE "tripId"=$1`, [id])).rows;
  const seatsChanged = !prior || (Object.keys(previousSnapshot).length > 0 &&
    (previousSnapshot.seats_total !== source.seats_total || previousSnapshot.seats_left !== source.seats_left));
  const reopened = ["cancelled", "sold_out", "paused"].includes(String(previousSnapshot.status)) && source.status === "active";
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

  // Staff can edit this trip's sell copy directly in the website admin
  // (title/description/hotel/included/excluded/notes/images). Overwriting
  // those fields on every sync — including a sync triggered by an unrelated
  // price or seat-count change on the chatbot side — would silently discard
  // that edit. Detect it by hashing what THIS sync would have written last
  // time: if the chatbot's own content is unchanged since the trip was last
  // synced AND the website side was edited more recently than that sync,
  // hold the content fields back. A genuine content edit on the chatbot
  // side (the hash changes) always wins and clears the hold — the chatbot
  // stays the source of truth, this only stops a NO-OP resync from
  // clobbering a same-day website edit.
  const contentSnapshot: ContentSnapshot = {
    title: source.route_name, description: source.notes || String(poster.subtitle || source.route_name),
    hotel: source.hotel || null,
    included: strings(source.extra.included_items), excluded: strings(source.extra.excluded_items),
    importantNotes: strings(source.extra.important_notes),
  };
  const contentHash = contentSnapshotHash(contentSnapshot);
  const priorContentHash = typeof record(prior?.sourceMetadata).contentHash === "string"
    ? String(record(prior?.sourceMetadata).contentHash) : null;
  const staffEditedSinceLastSync = staffEditHoldsContent({
    hasPriorTrip: Boolean(prior), freshHash: contentHash, priorHash: priorContentHash,
    priorUpdatedAt: prior?.updatedAt, priorLastSyncedAt: prior?.lastSyncedAt,
  });
  const sourcePriceFields = websiteExtraDetails({ ...source.extra, age_rules: offering.ageRules, price_groups: offering.priceGroups }, {
    adult: offering.price, child: offering.childPrice, infant: offering.infantPrice,
    currency: source.currency || "MNT",
  });
  const contentFields: Record<string, unknown> = staffEditedSinceLastSync
    ? {}
    : {
        ...contentSnapshot, image,
        extraImages: photos.length || hadSourcePhotos ? photos.filter(p => p !== image) : prior?.extraImages || [],
      };
  const data: Record<string, unknown> = {
    ...contentFields,
    // Price tiers are transactional data from the poster, not editable sell
    // copy. Keep them current even when a website editor's copy is protected.
    ...sourcePriceFields,
    durationDays: source.extra.duration_days ?? d.days, durationNights: source.extra.duration_nights ?? d.nights,
    price: offering.price ?? 0,
    childPrice: offering.childPrice, infantPrice: offering.infantPrice,
    currency: source.currency || "MNT",
    foodIncluded: source.has_food,
    departureRule: source.extra.departure_rule || null,
    ...(categoryId !== undefined ? { categoryId } : {}),
    brochurePdfUrl: pdf,
    sourceMetadata: JSON.stringify({ ...metadata, contentHash }),
    // "paused" behaves exactly like sold_out here: visible, just not
    // bookable — the trip stays on the site so customers can still ask
    // about it, but every departure below reads as closed, not open.
    isPublished: (source.status === "active" || source.status === "sold_out" || source.status === "paused")
      && source.extra.customer_visible !== false,
    ...(staffEditedSinceLastSync ? {} : { lastSyncedAt: new Date() }),
  };
  if (prior) {
    const entries = Object.entries(data);
    await client.query(`UPDATE "Trip" SET ${entries.map(([key], i) => `"${key}"=$${i + 2}${key === "sourceMetadata" ? "::jsonb" : ""}`).join(",")}, "updatedAt"=NOW() WHERE id=$1`,
      [id, ...entries.map(([, value]) => value)]);
  } else {
    const entries = Object.entries({ id, slug, sourceTripId: source.id, ...data, isFeatured: false });
    await client.query(`INSERT INTO "Trip" (${entries.map(([key]) => `"${key}"`).join(",")})
      VALUES (${entries.map(([key], i) => `$${i + 1}${key === "sourceMetadata" ? "::jsonb" : ""}`).join(",")})`, entries.map(([, value]) => value));
  }
  const days = records(poster.days);
  const dayNumbers: number[] = [];
  for (const [i, day] of days.entries()) {
    // Photos are an independent gallery; photo-only slots are not itinerary days.
    if (!day.route && !day.summary && !day.hotel) continue;
    const number = Number(day.day) || i + 1;
    if (dayNumbers.includes(number)) throw new Error("Duplicate itinerary day numbers require review");
    dayNumbers.push(number);
    const meals = record(day.meals);
    await client.query(`INSERT INTO "ItineraryDay" (id,"tripId","dayNumber",title,description,accommodation,meals,image)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT ("tripId","dayNumber") DO UPDATE SET
      title=EXCLUDED.title,description=EXCLUDED.description,accommodation=EXCLUDED.accommodation,
      meals=EXCLUDED.meals,image=EXCLUDED.image`, [randomUUID(), id, number, String(day.route || `${number}-р өдөр`),
      day.summary || null, day.hotel || null,
      [meals.breakfast ? "Өглөө" : "", meals.lunch ? "Өдөр" : "", meals.dinner ? "Орой" : ""].filter(Boolean), day.photo || null]);
  }
  await client.query(`DELETE FROM "ItineraryDay" WHERE "tripId"=$1 AND NOT ("dayNumber"=ANY($2::int[]))`, [id, dayNumbers]);
  const keep: string[] = [];
  for (const dep of offering.departures) {
    const old = oldDepartures.find(row => new Date(new Date(row.startDate).getTime() + 8 * 3600000).toISOString().slice(0, 10) === dep.start.slice(0, 10));
    const depId = old?.id || randomUUID();
    keep.push(depId);
    const status = dep.status;
    if (old) {
      await client.query(`UPDATE "Departure" SET label=$2,"endDate"=$3,status=$4::"DepartureStatus",
        "seatsTotal"=$5,"seatsLeft"=$6,price=$7,"childPrice"=$8,"infantPrice"=$9 WHERE id=$1`,
        [depId, dep.label, dep.end, status,
        seatsChanged ? source.seats_total : old.seatsTotal, dep.seatsLeft,
        dep.price ?? null, dep.childPrice ?? null, dep.infantPrice ?? null]);
    } else {
      await client.query(`INSERT INTO "Departure" (id,"tripId",label,"startDate","endDate","seatsTotal","seatsLeft",price,"childPrice","infantPrice",status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::"DepartureStatus")`,
        [depId,id,dep.label,dep.start,dep.end,source.seats_total,dep.seatsLeft,
        dep.price ?? null, dep.childPrice ?? null, dep.infantPrice ?? null,status]);
    }
  }
  // Keep records referenced by bookings, but close removed dates to new bookings.
  await client.query(`UPDATE "Departure" SET status='CANCELLED' WHERE "tripId"=$1 AND NOT(id=ANY($2::text[]))`, [id, keep]);
  await client.query(`DELETE FROM "Departure" d WHERE d."tripId"=$1 AND NOT(d.id=ANY($2::text[]))
    AND NOT EXISTS(SELECT 1 FROM "Booking" b WHERE b."departureId"=d.id)`, [id, keep]);
  return { id, slug, contentConflict: staffEditedSinceLastSync };
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
        job = (await sourceDb.query(`SELECT * FROM trip_website_sync
          WHERE revision > synced_revision AND ($1::text IS NULL OR trip_id=$1)
          ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT 1`, [tripId || null])).rows[0];
        if (!job) { await sourceDb.query("COMMIT"); return null; }
        const source = (await sourceDb.query(`SELECT * FROM travel_trip_entries WHERE id=$1`, [job.trip_id])).rows[0] as TravelTrip | undefined;
        const target = await bookingPool().connect();
        let linked: { id: string; slug: string; contentConflict: boolean } | undefined;
        try {
          await target.query("BEGIN");
          if (source) {
            const p = (await sourceDb.query(`SELECT data FROM poster_trips WHERE id=$1`, [source.extra.poster_trip_id])).rows[0];
            if (!p) throw new Error("Connected poster is missing");
            linked = await upsertWebsiteTrip(target, source, await materializePoster(p.data));
          } else {
            await target.query(`UPDATE "Trip" SET "isPublished"=false,"updatedAt"=NOW() WHERE "sourceTripId"=$1`, [job.trip_id]);
            await target.query(`DELETE FROM "Trip" t WHERE "sourceTripId"=$1
              AND NOT EXISTS(SELECT 1 FROM "Booking" b WHERE b."tripId"=t.id)`, [job.trip_id]);
          }
          await target.query("COMMIT");
        } catch (error) { await target.query("ROLLBACK"); throw error; }
        finally { target.release(); }
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
