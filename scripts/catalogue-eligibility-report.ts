/**
 * Eligibility report for the Complete corporate catalogue. READ-ONLY (SELECTs only, no writes, no code allocation).
 *
 *   node --env-file=.env.local --import tsx scripts/catalogue-eligibility-report.ts
 *
 * Reads EVERY trip (all statuses), applies the same isTripEligible / planEdition rules the Complete edition uses,
 * prints each trip that is NOT in the Complete catalogue with its exact reason, then asserts that every ELIGIBLE
 * trip is present in a freshly built Complete snapshot (a missing one exits 1). Exit 0 = nothing silently missing.
 */
import { listTrips } from "../src/lib/travelDb";
import * as store from "../src/lib/catalogue/store";
import { buildCatalogueSnapshot, planEdition } from "../src/lib/catalogue/tripData";
import { isTripEligible, ubDay } from "../src/lib/catalogue/pricing";
import { PROVISIONAL_CODE_PREFIX, text } from "../src/lib/catalogue/diagnostics";
import type { TravelTrip } from "../src/lib/travelTypes";

/** Short machine reason bucket for the counts table. */
function bucket(trip: TravelTrip, reason: string): string {
  const r = reason.toLowerCase();
  if (trip.status !== "active") return `status:${trip.status}`;
  if (r.includes("харагдахгүй")) return "customer_visible=false";
  if (r.includes("вэбсайтад нийтлээгүй")) return "website_published=false";
  if (r.includes("нэр хоосон")) return "empty_title";
  if (r.includes("захиалах боломжтой ирээдүйн огноо")) return "no_future_departure";
  if (r.includes("огноо тодорхой биш")) return "unrecognised_schedule";
  if (r.includes("явах огноо бүртгэгдээгүй")) return "no_dates";
  return "other";
}

async function main() {
  const nowIso = new Date().toISOString();
  const today = ubDay(nowIso);
  const all = await listTrips({ limit: 5000, includeArchived: true });
  const saved = await store.getCatalogueConfig();
  const stored = await store.getTripCodeMap();
  const config = saved.complete;
  const excluded = new Set(config.excludedTripIds ?? []);

  // Same codeMap treatment as the data audit: stored codes, provisional placeholder for the rest (nothing allocated).
  const codeMap: Record<string, string> = { ...stored };
  let provisional = 0;
  const verdicts = all.map((trip) => ({ trip, verdict: isTripEligible(trip, today) }));
  for (const { trip, verdict } of [...verdicts].sort((a, b) => a.trip.created_at.localeCompare(b.trip.created_at) || a.trip.id.localeCompare(b.trip.id))) {
    if (verdict.eligible && !codeMap[trip.id]) codeMap[trip.id] = `${PROVISIONAL_CODE_PREFIX}${String(++provisional).padStart(3, "0")}`;
  }

  const eligible = verdicts.filter((v) => v.verdict.eligible && !excluded.has(v.trip.id));
  const plan = planEdition({ edition: "complete", trips: all, config, codeMap }, today);
  const snapshot = buildCatalogueSnapshot({
    edition: "complete", nowIso, trips: all, posterByTripId: {}, config, heroByTripId: saved.heroByTripId, titleOverrides: saved.titleOverrides,
    coverPhoto: null, codeMap, contactPhones: ["00000000"], siteBaseUrl: "https://uudamtravel.mn",
  });
  const inComplete = new Set(snapshot.trips.map((card) => card.tripId));

  const rowsOut: Array<{ trip: TravelTrip; why: string; key: string }> = [];
  for (const { trip, verdict } of verdicts) {
    if (inComplete.has(trip.id)) continue;
    if (verdict.eligible && excluded.has(trip.id)) rowsOut.push({ trip, why: "staff excluded it from the Complete edition (config.excludedTripIds)", key: "staff_excluded" });
    else if (verdict.eligible) rowsOut.push({ trip, why: "ELIGIBLE but not in the Complete snapshot (code missing/collision?)", key: "MISSING_ELIGIBLE" });
    else rowsOut.push({ trip, why: verdict.reason ?? "?", key: bucket(trip, verdict.reason ?? "") });
  }

  const counts = new Map<string, number>();
  for (const r of rowsOut) counts.set(r.key, (counts.get(r.key) ?? 0) + 1);
  const active = all.filter((t) => t.status === "active");

  console.log(`# Complete-catalogue eligibility (${today})\n`);
  console.log(`total trips (all statuses): ${all.length}`);
  console.log(`active: ${active.length}`);
  console.log(`eligible (active + visible + bookable future date or weekly): ${verdicts.filter((v) => v.verdict.eligible).length}`);
  console.log(`planned by planEdition(complete): ${plan.trips.length}`);
  console.log(`in Complete snapshot: ${snapshot.trips.length}`);
  console.log(`not in Complete: ${rowsOut.length}`);
  console.log("excluded by reason:", Object.fromEntries([...counts].sort((a, b) => b[1] - a[1])));
  console.log("\n## Trips NOT in the Complete catalogue\n");
  for (const r of rowsOut.sort((a, b) => a.key.localeCompare(b.key) || text(a.trip.route_name).localeCompare(text(b.trip.route_name)))) {
    console.log(`- [${r.trip.status}] ${text(r.trip.route_name) || "(no title)"} (${r.trip.id}) — ${r.key}: ${r.why}`);
  }

  const missing = eligible.filter((v) => !inComplete.has(v.trip.id));
  const blocking = snapshot.warnings.filter((w) => w.severity === "blocking" && w.code === "code_collision");
  console.log("");
  if (missing.length) {
    console.log(`FAIL: ${missing.length} eligible trip(s) are silently missing from the Complete snapshot:`);
    for (const v of missing) console.log(`  - ${text(v.trip.route_name)} (${v.trip.id})`);
    if (blocking.length) for (const w of blocking) console.log(`  warning: ${w.message}`);
    process.exit(1);
  }
  console.log(`OK: all ${eligible.length} eligible trips are present in the Complete snapshot (none silently missing).`);
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
