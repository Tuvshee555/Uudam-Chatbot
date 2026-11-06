/**
 * Nightly read-only check: do the admin (chatbot record), the poster, the website and the bot
 * agree about every active, customer-visible trip? Comparisons live in src/lib/parityAudit.ts.
 *
 *   npm run audit:parity [-- --out <folder>] [-- --no-partner]
 *
 * Both databases are read inside BEGIN READ ONLY … ROLLBACK; nothing is ever written to them.
 * The partner trip is compared against the partner's public API (GET only). No AI calls.
 * Writes <out>/latest.md and <out>/YYYY-MM-DD.md (Ulaanbaatar date). <out> = --out, else
 * PARITY_AUDIT_DIR, else the Obsidian vault's Business/Uudam-Parity when the vault exists,
 * else tmp/parity-audit. Exit 0 even with differences; 1 only when the check could not run
 * (then <out>/YYYY-MM-DD-FAILED.md and latest.md say why, including an app module that failed to load).
 * Daily task and how to register it: docs/parity-audit.md.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "pg";
import type { ParityDifference, TripParityResult, WebsiteRows } from "../src/lib/parityAudit";
import type { TravelTrip } from "../src/lib/travelTypes";

// Read-only end to end. A warn/error log from any app module (env.ts logs at load) is otherwise
// copied into travel_error_logs over its own pool, outside the read-only transaction
// (observability.ts persistToDatabase → errorLogStore.ts). observability reads the flag once, when
// it loads; no static import above loads it, and every app module is imported in appModules()
// below, after this line. Forced, whatever .env/.env.local say.
process.env.ERROR_LOG_DB_ENABLED = "false";

/**
 * The app's modules, imported inside main() so that a module failing to load (the app's env
 * check in neonDb/env.ts, a broken import) reaches main()'s catch and its FAILED note.
 */
async function appModules() {
  const { mapTripRow } = await import("../src/lib/travelDb");
  const { sanitizeTripScheduleForCurrentDate } = await import("../src/lib/tripScheduleMaintenance");
  const { sanitizeTripForCustomers } = await import("../src/lib/travelFastPathsSearch");
  const { checkSelfConsistency } = await import("../src/lib/selfConsistency");
  const { sameDatabase } = await import("../src/lib/websiteSyncTransaction");
  const { TOURS } = await import("../src/lib/partnerSync/run");
  const { fetchGlobalTravelTour } = await import("../src/lib/partnerSync/globalTravel");
  const { partnerTripFields } = await import("../src/lib/partnerSync/tripPayload");
  const { normalizeExtraPatch } = await import("../src/lib/tripExtraSchema");
  const parity = await import("../src/lib/parityAudit");
  return {
    mapTripRow, sanitizeTripScheduleForCurrentDate, sanitizeTripForCustomers, checkSelfConsistency, sameDatabase,
    TOURS, fetchGlobalTravelTour, partnerTripFields, normalizeExtraPatch, ...parity,
  };
}

type Row = Record<string, unknown>;
const args = process.argv.slice(2);
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const now = new Date();
const ub = new Date(now.getTime() + 8 * 3600e3).toISOString();
const ubDate = ub.slice(0, 10);

function outputDir(): string {
  const explicit = flag("--out") || process.env.PARITY_AUDIT_DIR;
  if (explicit) return resolve(explicit);
  const business = join(homedir(), "OneDrive", "ドキュメント", "Obsidian-Vaults", "Personal-Knowledge-Base", "Business");
  return existsSync(business) ? join(business, "Uudam-Parity") : resolve("tmp/parity-audit");
}

/** A database error must never carry the connection string into the report. */
const clean = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/postgres(?:ql)?:\/\/\S+/g, "[database]").slice(0, 300);

async function readOnly(url: string): Promise<Client> {
  const parsed = new URL(url);
  parsed.searchParams.set("sslmode", "verify-full");
  const client = new Client({ connectionString: parsed.toString(), connectionTimeoutMillis: 15000, statement_timeout: 60000 });
  await client.connect();
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  return client;
}

const TRIP_COLUMNS = `id, category, operator_name, route_name, duration_text, adult_price, child_price, infant_price, currency,
  departure_dates, seats_total, seats_left, has_food, status, notes, hotel, source_description, photo_urls, extra, created_at, updated_at`;

async function load(sameDatabase: (a: string, b: string) => boolean) {
  const sourceUrl = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;
  const websiteUrl = process.env.BOOKING_DATABASE_URL || sourceUrl;
  if (!sourceUrl || !websiteUrl) throw new Error("NEON_DATABASE_URL / BOOKING_DATABASE_URL are not configured (.env.local)");
  const source = await readOnly(sourceUrl);
  const shared = sameDatabase(sourceUrl, websiteUrl);
  let website: Client = source;
  try {
    if (!shared) website = await readOnly(websiteUrl);
    // Live = what the bot answers from (selfConsistency needs all of them); checked = active + visible.
    const tripRows = (await source.query(`SELECT ${TRIP_COLUMNS} FROM travel_trip_entries WHERE status IN ('active','sold_out','paused') ORDER BY id`)).rows;
    const ids = tripRows.map((row) => String(row.id));
    const posterIds = tripRows.map((row) => String((row.extra as Row | null)?.poster_trip_id || "")).filter(Boolean);
    const posters = (await source.query("SELECT id, data FROM poster_trips WHERE id = ANY($1::text[])", [posterIds])).rows;
    const queue = (await source.query("SELECT trip_id, revision > synced_revision AS queued FROM trip_website_sync WHERE trip_id = ANY($1::text[])", [ids])).rows;
    // Only the sourceMetadata keys the comparison reads: the whole object repeats a full source/poster snapshot.
    const sites = (await website.query(`SELECT id, slug, title, hotel, "durationDays", "durationNights", "isPublished", price, "childPrice", "infantPrice",
        currency, "sourceTripId",
        jsonb_build_object(
          'canonicalOffers', "sourceMetadata"->'canonicalOffers', 'contentConflicts', "sourceMetadata"->'contentConflicts',
          'price_groups', "sourceMetadata"->'price_groups', 'websiteSyncPending', "sourceMetadata"->'websiteSyncPending',
          'connectedSource', CASE WHEN "sourceMetadata" ? 'connectedSource' THEN jsonb_build_object(
            'status', "sourceMetadata"->'connectedSource'->'status', 'seats_total', "sourceMetadata"->'connectedSource'->'seats_total',
            'seats_left', "sourceMetadata"->'connectedSource'->'seats_left') END
        ) AS "sourceMetadata"
      FROM "Trip" WHERE "sourceTripId" = ANY($1::text[])`, [ids])).rows;
    const departures = (await website.query(`SELECT t."sourceTripId", d."startDate"::text AS "startDate", d.status::text AS status, d."seatsLeft",
        d.price, d."childPrice", d."infantPrice"
      FROM "Departure" d JOIN "Trip" t ON t.id = d."tripId" WHERE t."sourceTripId" = ANY($1::text[])`, [ids])).rows;
    const days = (await website.query(`SELECT t."sourceTripId", i."dayNumber", i.title, i.meals
      FROM "ItineraryDay" i JOIN "Trip" t ON t.id = i."tripId" WHERE t."sourceTripId" = ANY($1::text[]) AND i."dayNumber" > 0`, [ids])).rows;
    // Published-state sweep: every published website page, and the chatbot trips those pages name.
    const published = (await website.query(`SELECT slug, title, "sourceTripId", "isPublished" FROM "Trip" WHERE "isPublished" = true`)).rows;
    const pageTripIds = [...new Set(published.map((row) => String(row.sourceTripId || "")).filter(Boolean))];
    const pageTrips = (await source.query(`SELECT id, route_name, status, jsonb_build_object('customer_visible', extra->'customer_visible') AS extra
      FROM travel_trip_entries WHERE id = ANY($1::text[])`, [pageTripIds])).rows;
    return { tripRows, posters, queue, sites, departures, days, published, pageTrips };
  } finally {
    await source.query("ROLLBACK").catch(() => {});
    await source.end().catch(() => {});
    if (website !== source) {
      await website.query("ROLLBACK").catch(() => {});
      await website.end().catch(() => {});
    }
  }
}

function byTrip(rows: Row[]): Map<string, Row[]> {
  const map = new Map<string, Row[]>();
  for (const row of rows) map.set(String(row.sourceTripId), [...(map.get(String(row.sourceTripId)) || []), row]);
  return map;
}

async function main() {
  const {
    mapTripRow, sanitizeTripScheduleForCurrentDate, sanitizeTripForCustomers, checkSelfConsistency, sameDatabase,
    TOURS, fetchGlobalTravelTour, partnerTripFields, normalizeExtraPatch,
    botDifferences, differenceLine, fareCardKind, isCheckedTrip, partnerDifferences, posterDifferences, renderParityReport,
    summaryLine, topDifferences, unsoldWebsitePages, websiteDifferences, withWebsiteOverlay,
  } = await appModules();
  const data = await load(sameDatabase);
  const posterById = new Map(data.posters.map((row) => [String(row.id), (row.data || {}) as Row]));
  const sitesByTrip = byTrip(data.sites);
  const departuresByTrip = byTrip(data.departures);
  const daysByTrip = byTrip(data.days);
  const queued = new Set(data.queue.filter((row) => row.queued).map((row) => String(row.trip_id)));
  const websiteOf = (id: string): WebsiteRows => ({
    trip: sitesByTrip.get(id)?.[0] || null, departures: departuresByTrip.get(id) || [],
    days: daysByTrip.get(id) || [], syncQueued: queued.has(id),
  });

  const stored: TravelTrip[] = data.tripRows.map(mapTripRow);
  // verify-partner-sync and the partner sync itself compare the row as stored, not as mapped.
  const rawById = new Map(data.tripRows.map((row) => [String(row.id), row as unknown as TravelTrip]));
  // The bot reads trips the way listTrips serves them: schedule-sanitized, with the website overlay.
  const bot = stored.map((trip) => withWebsiteOverlay(sanitizeTripScheduleForCurrentDate(trip, now).trip, websiteOf(trip.id)));
  const botById = new Map(bot.map((trip) => [trip.id, trip]));
  const refused = new Map<string, string[]>();
  const consistency = checkSelfConsistency(bot, now);
  for (const failure of consistency.failures) refused.set(failure.tripId, [...(refused.get(failure.tripId) || []), failure.question]);
  const cardKinds = new Map<string, number>();
  let partnersCompared = 0;

  const notChecked: string[] = [];
  const results: TripParityResult[] = [];
  for (const trip of stored) {
    const served = botById.get(trip.id)!;
    // A trip whose last date has passed is archived on the next read; it is no longer on sale.
    if (!isCheckedTrip(trip) || !isCheckedTrip(served)) continue;
    const poster = posterById.get(String(trip.extra.poster_trip_id || "")) || null;
    const website = websiteOf(trip.id);
    const differences: ParityDifference[] = [];
    const guard = (area: string, run: () => ParityDifference[]) => {
      try { differences.push(...run()); } catch (error) { notChecked.push(`«${trip.route_name}» ${area}: ${clean(error)}`); }
    };
    if ((sitesByTrip.get(trip.id) || []).length > 1) {
      differences.push({ area: "website", severity: 2, code: "web_duplicate_trip", mn: "Вэбсайтад нэг аялал хоёр мөртэй", en: "the website has two rows for one chatbot trip", items: [] });
    }
    guard("website", () => websiteDifferences(trip, poster, website, now));
    guard("poster", () => posterDifferences(trip, poster, now));
    guard("bot", () => {
      const customerTrip = sanitizeTripForCustomers(served);
      const kind = fareCardKind(customerTrip, now);
      cardKinds.set(kind, (cardKinds.get(kind) || 0) + 1);
      return botDifferences(customerTrip, now, refused.get(trip.id));
    });
    const partnerUrl = (trip.extra.partner_sync as Row | undefined)?.source_url;
    if (partnerUrl) {
      const config = TOURS.find((tour) => tour.tripId === trip.id);
      if (!config) {
        differences.push({ area: "partner", severity: 2, code: "partner_not_listed", mn: "Түншийн аялал синкийн жагсаалтад алга", en: "a partner trip that the partner sync does not update", items: [String(partnerUrl)] });
      } else if (args.includes("--no-partner")) {
        notChecked.push(`«${trip.route_name}» partner: skipped (--no-partner)`);
      } else {
        try {
          const tour = await fetchGlobalTravelTour(config.slug, { timeoutMs: 30000 });
          const fields = partnerTripFields(tour, posterById.get(config.posterId) || poster || {}, trip.extra) as unknown as Row;
          const extra = normalizeExtraPatch((fields.extra as Row | undefined) ?? {});
          differences.push(...partnerDifferences(rawById.get(trip.id) || trip, posterById.get(config.posterId) || poster, { fields, extra, contentHash: tour.contentHash }));
          partnersCompared++;
        } catch (error) {
          notChecked.push(`«${trip.route_name}» partner: could not read the partner's data (${clean(error)})`);
        }
      }
    }
    results.push({ tripId: trip.id, name: trip.route_name, differences });
  }

  const checkedCount = results.length;
  const pageTrips = new Map(data.pageTrips.map((row) => { const trip = mapTripRow(row); return [trip.id, trip] as const; }));
  results.push(...unsoldWebsitePages(data.published, pageTrips));
  const coverage = [
    `Website: ${checkedCount} trips against their "Trip"/"Departure"/"ItineraryDay" rows; ${data.published.length} published website pages swept for trips the chatbot does not sell.`,
    `Bot: fare cards — ${[...cardKinds].map(([kind, count]) => `${count} ${kind}`).join(", ") || "none"}; ${consistency.answers} bot answers run through the reply checker, ${consistency.failures.length} refused.`,
    `Partner: ${partnersCompared} of ${TOURS.length} partner trip(s) compared with the partner's public API (GET only).`,
  ];
  const report = renderParityReport(results, { generatedAt: `${ubDate} ${ub.slice(11, 16)} (UB)`, notChecked, coverage });
  const dir = outputDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${ubDate}.md`), report);
  writeFileSync(join(dir, "latest.md"), report);
  console.log(summaryLine(results));
  for (const [index, { result, diff }] of topDifferences(results, 5).entries()) {
    console.log(`${index + 1}. «${result.name}» ${differenceLine(diff)}${diff.items[0] ? ` — ${diff.items[0]}` : ""}`);
  }
  if (notChecked.length) console.log(`Not checked: ${notChecked.length}`);
  console.log(`Saved ${join(dir, "latest.md")}`);
}

main().then(() => process.exit(0)).catch((error) => {
  const message = clean(error);
  console.error(`Parity check could not run: ${message}`);
  try {
    const dir = outputDir();
    mkdirSync(dir, { recursive: true });
    const note = `# Uudam parity check — ${ubDate} ${ub.slice(11, 16)} (UB)\n\n❌ Шалгалт ажиллаж чадсангүй / The check could not run: ${message}\n`;
    writeFileSync(join(dir, `${ubDate}-FAILED.md`), note);
    writeFileSync(join(dir, "latest.md"), note);
  } catch { /* the console line above is the record */ }
  process.exit(1);
});
