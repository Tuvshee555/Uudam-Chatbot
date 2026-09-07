import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { queryNeon, withNeonClient } from "./neonDb";
import { ensureConnectedTripSchema } from "./connectedTripStore";
import { duration, posterPhotos, record, records, strings, websiteDepartures, websiteExtraDetails } from "./connectedTripMapping";
import { getEnv } from "./env";
import { getPosterPdfPublicUrl } from "./poster/pdfUrl";
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
  const hadSourcePhotos = strings(previousSnapshot.photos).length > 0;
  const image = photos[0] || (hadSourcePhotos ? "" : prior?.image || "");
  const pdf = getPosterPdfPublicUrl(String(source.extra.poster_trip_id));
  if (!pdf) throw new Error("SITE_URL is required for the shared poster PDF");
  const metadata = { ...record(prior?.sourceMetadata), ...source.extra, connectedSource: { ...source, photos, poster } };
  const data: Record<string, unknown> = {
    title: source.route_name, description: source.notes || String(poster.subtitle || source.route_name),
    durationDays: d.days, durationNights: d.nights, price: source.adult_price ?? 0,
    childPrice: source.child_price, currency: source.currency || "MNT", hotel: source.hotel || null,
    foodIncluded: source.has_food, image,
    extraImages: photos.length || hadSourcePhotos ? photos.filter(p => p !== image) : prior?.extraImages || [],
    included: strings(source.extra.included_items), excluded: strings(source.extra.excluded_items),
    importantNotes: strings(source.extra.important_notes), departureRule: source.extra.departure_rule || null,
    ...websiteExtraDetails(source.extra),
    brochurePdfUrl: pdf, sourceMetadata: JSON.stringify(metadata),
    isPublished: (source.status === "active" || source.status === "sold_out") && source.extra.customer_visible !== false,
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
  const oldDepartures = (await client.query(`SELECT * FROM "Departure" WHERE "tripId"=$1`, [id])).rows;
  const keep: string[] = [];
  for (const dep of websiteDepartures(source)) {
    const old = oldDepartures.find(row => new Date(row.startDate).toISOString().slice(0, 10) === dep.start.slice(0, 10));
    const depId = old?.id || randomUUID();
    keep.push(depId);
    const seatsChanged = !prior || (Object.keys(previousSnapshot).length > 0 &&
      (previousSnapshot.seats_total !== source.seats_total || previousSnapshot.seats_left !== source.seats_left));
    const reopened = ["cancelled", "sold_out"].includes(String(previousSnapshot.status)) && source.status === "active";
    const status = source.status === "cancelled" ? "CANCELLED" : source.status === "sold_out" ? "SOLD_OUT" : reopened ? "OPEN" : old?.status || "OPEN";
    if (old) {
      await client.query(`UPDATE "Departure" SET label=$2,"endDate"=$3,status=$4::"DepartureStatus",
        "seatsTotal"=$5,"seatsLeft"=$6 WHERE id=$1`, [depId, dep.label, dep.end, status,
        seatsChanged ? source.seats_total : old.seatsTotal, seatsChanged ? source.seats_left : old.seatsLeft]);
    } else {
      await client.query(`INSERT INTO "Departure" (id,"tripId",label,"startDate","endDate","seatsTotal","seatsLeft",status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::"DepartureStatus")`, [depId,id,dep.label,dep.start,dep.end,source.seats_total,source.seats_left,status]);
    }
  }
  // Keep records referenced by bookings, but close removed dates to new bookings.
  await client.query(`UPDATE "Departure" SET status='CANCELLED' WHERE "tripId"=$1 AND NOT(id=ANY($2::text[]))`, [id, keep]);
  await client.query(`DELETE FROM "Departure" d WHERE d."tripId"=$1 AND NOT(d.id=ANY($2::text[]))
    AND NOT EXISTS(SELECT 1 FROM "Booking" b WHERE b."departureId"=d.id)`, [id, keep]);
  return { id, slug };
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
        let linked: { id: string; slug: string } | undefined;
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
          website_trip_id=$3,website_slug=$4 WHERE trip_id=$1`, [job.trip_id,job.revision,linked?.id || null,linked?.slug || null]);
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
  return (await queryNeon(`SELECT trip_id,revision=synced_revision AS synced,last_error,website_trip_id,website_slug,synced_at
    FROM trip_website_sync ORDER BY updated_at DESC`))?.rows || [];
}
export async function closeBookingPool() { await pool?.end(); pool = undefined; }
