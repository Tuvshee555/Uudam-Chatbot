import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { auditFaqParity, auditTripPair, hasParityValue, parityRecord } from "../src/lib/tripWebsiteParity";
import { websiteDepartureSchedule } from "../src/lib/connectedTripMapping";
import { websiteAvailabilityForResync, websiteTripPayload } from "../src/lib/websiteTripPayload";
import type { TravelTrip } from "../src/lib/travelTypes";
import { auditTripCatalog } from "../src/lib/tripDataValidation";

async function main() {
  const output = resolve(process.argv[2] || "tmp/website-parity-audit.json");
  if (!output.startsWith(resolve("tmp") + sep) || !output.endsWith(".json")) throw new Error("Audit output must be a JSON file inside this project's ignored tmp directory");
  const envPath = process.argv[3] || ".env.local";
  const env = parseEnv(await readFile(envPath, "utf8"));
  const connectionString = env.NEON_DATABASE_URL || env.DATABASE_URL;
  if (!connectionString) throw new Error("Database connection is not configured");
  const url = new URL(connectionString);
  url.searchParams.set("sslmode", "verify-full");
  const pool = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 10000, statement_timeout: 30000 });
  const client = await pool.connect();
  let report;
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const website = (await client.query(`SELECT t.*,
      COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d."dayNumber") FROM "ItineraryDay" d WHERE d."tripId"=t.id),'[]'::jsonb) itinerary,
      COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d."startDate", d.id) FROM "Departure" d WHERE d."tripId"=t.id),'[]'::jsonb) departures,
      COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM "Category" c JOIN "_TripCategories" j ON j."A"=c.id WHERE j."B"=t.id),'[]'::jsonb) categories,
      COALESCE((SELECT jsonb_agg(to_jsonb(tag) ORDER BY tag.id) FROM "Tag" tag JOIN "_TripTags" j ON j."A"=tag.id WHERE j."B"=t.id),'[]'::jsonb) tags
      FROM "Trip" t ORDER BY t.id`)).rows;
    const canonical = (await client.query("SELECT * FROM travel_trip_entries ORDER BY id")).rows;
    const posters = (await client.query("SELECT id, title, data FROM poster_trips ORDER BY id")).rows;
    const sync = (await client.query(`SELECT trip_id,revision,synced_revision,attempts,last_error,content_conflict FROM trip_website_sync ORDER BY trip_id`)).rows;
    const columns = (await client.query(`SELECT table_name,column_name,data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name IN ('Trip','travel_trip_entries','SiteSettings','travel_bot_settings','ItineraryDay','Departure') ORDER BY table_name,ordinal_position`)).rows;
    const websiteSettings = (await client.query('SELECT * FROM "SiteSettings" WHERE id=$1', ['default'])).rows[0] || {};
    const chatbotSettings = (await client.query('SELECT faq,discount_policies,special_offers,verified_credentials FROM travel_bot_settings WHERE id=TRUE')).rows[0] || {};
    let defaults: Record<string, unknown> = {};
    // This optional local module only exports static website copy and parsers.
    // No app, API or schema initializer is called by the audit.
    {
      const defaultsPath = resolve('../uudam-booking-web/src/lib/siteContent.ts');
      try {
        await readFile(defaultsPath, 'utf8');
        const imported = await import(pathToFileURL(defaultsPath).href);
        defaults = imported.default ? parityRecord(imported.default) : imported;
      } catch { defaults = {}; }
    }
    const parsedFaqs = typeof defaults.parseFaqs === 'function' ? defaults.parseFaqs(websiteSettings.faqs) : websiteSettings.faqs;
    const parsedTerms = typeof defaults.parseTermsSections === 'function' ? defaults.parseTermsSections(websiteSettings.termsSections) : websiteSettings.termsSections;
    const useDefaultFaqs = !Array.isArray(parsedFaqs) || parsedFaqs.length === 0;
    const useDefaultTerms = !Array.isArray(parsedTerms) || parsedTerms.length === 0;
    const faq = auditFaqParity(useDefaultFaqs ? defaults.DEFAULT_FAQS : parsedFaqs, chatbotSettings.faq);
    const globalContent = { faq, websiteFaqUsesCodeDefaults: useDefaultFaqs,
      websiteFaqDefaultsAvailable: !useDefaultFaqs || Array.isArray(defaults.DEFAULT_FAQS),
      websiteTerms: (useDefaultTerms ? defaults.DEFAULT_TERMS_SECTIONS : parsedTerms) ?? null,
      websiteTripNotice: websiteSettings.tripNotice ?? null,
      websiteBankDetailsPresent: hasParityValue(websiteSettings.bankDetails),
      websitePopulatedFieldNames: Object.keys(websiteSettings).filter(key => !['id','updatedAt'].includes(key) && hasParityValue(websiteSettings[key])),
      chatbotDiscountPolicies: chatbotSettings.discount_policies, chatbotSpecialOffers: chatbotSettings.special_offers,
      note: 'Website FAQ/terms/notices and chatbot FAQ/policies are separate sources. Similar questions need individual review; no text was merged.' };
    const canonicalById = new Map(canonical.map(row => [row.id, row]));
    const posterById = new Map(posters.map(row => [row.id, parityRecord(row.data)]));
    const now = new Date();
    const factAudit = auditTripCatalog(canonical, now);
    const pairs = website.filter(row => canonicalById.has(row.sourceTripId)).map(row => {
      const source = canonicalById.get(row.sourceTripId)!;
      const liveSource = { ...source, extra: { ...parityRecord(source.extra), website_departure_availability: row.departures.map((departure: Record<string, unknown>) =>
        websiteAvailabilityForResync({ date: new Date(new Date(String(departure.startDate)).getTime() + 8 * 3600000).toISOString().slice(0, 10), status: String(departure.status), seatsLeft: departure.seatsLeft as number | null }, parityRecord(row.sourceMetadata).canonicalOffers)) } } as TravelTrip;
      const projected = websiteTripPayload(liveSource, websiteDepartureSchedule(liveSource, now), now);
      const projectionFareDifferences = ["price", "childPrice", "infantPrice"].filter(key =>
        (key === "price" ? projected.price ?? 0 : projected[key as "childPrice" | "infantPrice"]) !== row[key])
        .map(key => ({ field: key, websiteValue: row[key], expectedProjection: projected[key as "price" | "childPrice" | "infantPrice"] ?? (key === "price" ? 0 : null) }));
      return { ...auditTripPair(row, source, posterById.get(parityRecord(source.extra).poster_trip_id)),
        projectionFareDifferences,
        generatedDepartureCount: projected.departures.length, storedDepartureCount: row.departures.length,
        publishedCanonicalVisibilityMatches: row.isPublished === (["active", "sold_out", "paused"].includes(source.status) && parityRecord(source.extra).customer_visible !== false),
      };
    });
    const countKeys = (values: Record<string, unknown>[]) => {
      const counts: Record<string, number> = {};
      for (const value of values) for (const [key, item] of Object.entries(value)) if (hasParityValue(item)) counts[key] = (counts[key] || 0) + 1;
      return counts;
    };
    const summary = { websiteTrips: website.length, canonicalTrips: canonical.length, posters: posters.length, linkedPairs: pairs.length,
      unlinkedWebsiteTrips: website.filter(row => !canonicalById.has(row.sourceTripId)).map(row => ({ id: row.id, slug: row.slug })),
      canonicalWithoutWebsite: canonical.filter(row => !website.some(web => web.sourceTripId === row.id)).map(row => ({ id: row.id, title: row.route_name })),
      tripsWithContentDifferences: pairs.filter(pair => pair.differences.length).length,
      tripsWithWebsiteTextNotStoredInCanonical: pairs.filter(pair => pair.customerTextNotStoredInCanonical.length).length,
      differenceCounts: pairs.flatMap(pair => pair.differences).reduce<Record<string, number>>((counts, item) => { counts[item.websiteField] = (counts[item.websiteField] || 0) + 1; return counts; }, {}),
      tripsWithScalarFareDifferences: pairs.filter(pair => pair.fareDifferences.length).length,
      tripsWithCurrentProjectionFareDifferences: pairs.filter(pair => pair.projectionFareDifferences.length).length,
      tripsWithVisibilityDifferences: pairs.filter(pair => !pair.publishedCanonicalVisibilityMatches).length,
      canonicalFactAudit: { tripsWithErrors: factAudit.tripsWithErrors, tripsWithWarnings: factAudit.tripsWithWarnings,
        issueCounts: factAudit.results.flatMap(result => result.issues).reduce<Record<string, number>>((counts, issue) => { counts[issue.code] = (counts[issue.code] || 0) + 1; return counts; }, {}) },
      globalFaq: { websiteCount: faq.websiteCount, chatbotCount: faq.chatbotCount,
        conflictingExactQuestions: faq.conflictingExactQuestions.length,
        websiteQuestionsWithoutExactChatbotMatch: faq.websiteQuestionsWithoutExactChatbotMatch.length,
        chatbotQuestionsWithoutExactWebsiteMatch: faq.chatbotQuestionsWithoutExactWebsiteMatch.length },
      websiteSeparatePopulated: countKeys(pairs.map(pair => pair.websiteSeparateValues)),
      chatbotSeparatePopulated: countKeys(pairs.map(pair => pair.chatbotSeparateValues)),
      allCanonicalExtraPopulated: countKeys(canonical.map(row => parityRecord(row.extra))),
      tripsWithCanonicalSeatCounts: pairs.filter(pair => pair.canonicalSeatCountsPresent).length,
      tripsWithProjectedDescriptionDifferentFromImportSource: pairs.filter(pair => pair.projectedDescriptionDiffersFromImportSource).length,
      auditScope: 'Read-only data comparison, not a prediction of save side effects. Import provenance and canonical seat counts are preserved by the changed-field save path.',
      sync: { linkedPending: sync.filter(row => canonicalById.has(row.trip_id) && Number(row.revision) > Number(row.synced_revision)).length,
        linkedErrors: sync.filter(row => canonicalById.has(row.trip_id) && row.last_error).map(row => ({ tripId: row.trip_id, error: row.last_error })),
        contentConflictFlags: sync.filter(row => row.content_conflict).map(row => row.trip_id) },
    };
    report = { generatedAt: new Date().toISOString(), readOnly: true, databaseFingerprint: createHash("sha256").update(`${url.hostname}${url.pathname}`).digest("hex"),
      policy: "Keep both versions. Differences are review candidates, not automatic corrections. Website-only presentation and generated pricing are not assumed to be conflicts.",
      limitations: ["This audits trip rows, mappings and queue state, not real Messenger delivery or submitted bookings/payments.",
        "Current projection fare differences can depend on dates, availability, hotel and age selection; they are review candidates, not confirmed wrong quotes.",
        "Website-only fields and canonical-only fields are inventories, not a claim that every field must have an identical widget.",
        "Poster-derived descriptions can match the website without being present in the chatbot's canonical answer context."],
      summary, pairs, globalContent, factAudit, columns, sync,
      inputFingerprint: createHash("sha256").update(JSON.stringify({ website, canonical, posters })).digest("hex") };
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report.summary, output }, null, 2));
}

main().catch(error => { console.error(error instanceof Error ? error.message : "Audit failed"); process.exitCode = 1; });
