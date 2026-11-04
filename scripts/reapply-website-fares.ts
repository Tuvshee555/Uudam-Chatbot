/**
 * Re-applies per-date fares a consultant saved on the website that the chatbot stored as
 * open conflicts instead (2026-11-02/03, before src/lib/websiteDateFares.ts). The website
 * has since been overwritten with the old fares, so the only record of what staff typed is
 * the latest "extra.price_groups" conflict: its `website` value is the website's whole
 * price list at that save.
 *
 * Each trip's fares are merged with that list as a website save on an unchanged chatbot
 * copy would be (mergeWebsiteDateFares, base = the chatbot's own groups), so only cells the
 * website changed move and dates that are no departure create nothing. The settled fare
 * conflicts move to resolved_conflicts; any other conflict stays open. Written with
 * patchTrip like a website save, so the website and poster follow.
 *
 *   node --env-file=.env.local --import tsx scripts/reapply-website-fares.ts                     # dry run
 *   node --env-file=.env.local --import tsx scripts/reapply-website-fares.ts --apply --backup=<file.json>
 *   ... --only=<trip id>
 * Undo: restore extra.price_groups / shared_conflicts / resolved_conflicts from the backup file.
 */
import { writeFileSync } from "node:fs";
import { closeNeonPool, queryNeon } from "../src/lib/neonDb";
import { patchTrip } from "../src/lib/travelDb";
import { mergeWebsiteDateFares } from "../src/lib/websiteDateFares";
import { websiteDepartureDateKey } from "../src/lib/websiteDepartureDate";

type Row = Record<string, unknown>;
const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const apply = process.argv.includes("--apply");
const only = arg("only");
const backup = arg("backup");
if (apply && !backup) throw new Error("--apply needs --backup=<file.json>");

const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? value as Row : {});
const list = (value: unknown): Row[] => (Array.isArray(value) ? value.map(record) : []);
const isFareConflict = (entry: Row) => entry.field === "extra.price_groups" || /^departure\.\d{4}-\d{2}-\d{2}\./.test(String(entry.field));
const isInfant = (band: Row) => /нярай|infant|сар|month/i.test(`${band.label || ""} ${band.age_range || ""}`);
const fares = (group: Row) => {
  const bands = list(group.passenger_prices);
  const child = bands.find((band) => !isInfant(band)), infant = bands.find(isInfant);
  return `${group.adult_price ?? "-"}/${child ? child.price : group.child_price ?? "-"}/${infant ? infant.price : group.infant_price ?? "-"}`;
};
const byDate = (groups: Row[]) => new Map(groups.flatMap((group) => (Array.isArray(group.dates) ? group.dates : []).map((date) => [String(date), fares(group)] as const)));

async function main() {
  const result = await queryNeon<Row>(`SELECT * FROM travel_trip_entries
    WHERE jsonb_array_length(COALESCE(extra->'shared_conflicts','[]'::jsonb)) > 0 AND status <> 'archived' ${only ? "AND id = $1" : ""}
    ORDER BY route_name`, only ? [only] : []);
  const trips = (result?.rows || []).filter((trip) => list(record(trip.extra).shared_conflicts).some(isFareConflict));
  if (backup) {
    writeFileSync(backup, JSON.stringify({ takenAt: new Date().toISOString(), trips }, null, 1));
    console.log(`Backup: ${trips.length} trips -> ${backup}`);
  }
  console.log(`${apply ? "APPLY" : "DRY RUN"}: ${trips.length} trips with open fare conflicts`);
  let failures = 0;
  for (const trip of trips) {
    const extra = record(trip.extra);
    const open = list(extra.shared_conflicts);
    const latest = open.filter((entry) => entry.field === "extra.price_groups").sort((a, b) => String(a.at).localeCompare(String(b.at))).at(-1);
    console.log(`\n${trip.route_name} (${trip.id}): ${open.length} open conflicts`);
    if (!latest) { console.log("   no whole-list save recorded; left for the trip editor"); continue; }
    const canonical = list(extra.price_groups);
    const live = new Set((Array.isArray(trip.departure_dates) ? trip.departure_dates : []).map(websiteDepartureDateKey).filter(Boolean));
    const merge = mergeWebsiteDateFares(canonical, canonical, latest.website, live);
    if (!merge.groups) { console.log("   nothing to apply"); continue; }
    const before = byDate(canonical), after = byDate(merge.groups);
    for (const [date, value] of after) if (before.get(date) !== value) console.log(`   ${date}: ${before.get(date) ?? "(trip fare)"} -> ${value}`);
    if (merge.conflicts.length) console.log(`   still conflicting: ${merge.conflicts.map((entry) => entry.field).join(", ")}`);
    // A departure conflict is settled once that date's merged fares are the website's; whole-list ones always are.
    const settled = open.filter((entry) => {
      if (!isFareConflict(entry)) return false;
      if (entry.field === "extra.price_groups") return true;
      const date = String(entry.field).split(".")[1];
      return merge.dates.has(date) && !merge.conflicts.some((conflict) => conflict.field.startsWith(`departure.${date}.`));
    });
    const kept = open.filter((entry) => !settled.includes(entry));
    console.log(`   conflicts: ${settled.length} settled, ${kept.length} stay open${kept.length ? ` (${[...new Set(kept.map((entry) => entry.field))].join(", ")})` : ""}`);
    if (!apply) continue;
    const resolvedAt = new Date().toISOString();
    try {
      await patchTrip(String(trip.id), { extra: {
        price_groups: merge.groups,
        shared_conflicts: kept,
        resolved_conflicts: [...list(extra.resolved_conflicts),
          ...settled.map((entry) => ({ ...entry, resolution: "website", resolvedAt, resolvedBy: "reapply-website-fares 2026-11-04" }))].slice(-200),
      } } as never, true, undefined, String(trip.updated_at instanceof Date ? trip.updated_at.toISOString() : trip.updated_at), { flush: "inline" });
      console.log("   applied");
    } catch (error) {
      failures++;
      console.log(`   ERR ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 2; }).finally(() => closeNeonPool().catch(() => {}));
