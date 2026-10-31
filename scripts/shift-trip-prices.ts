/**
 * Raise (or lower) every passenger fare of every non-archived trip by one fixed amount: adult,
 * child and infant fares, per-date price rows, age-band fares, child fare rules and the poster's
 * fare cells (src/lib/priceShift.ts). A fare of 0 stays 0 (a free infant stays free). Single-room
 * supplements, room prices and extra fees are not passenger fares and stay. Trips copied from a
 * partner (extra.partner_sync) are skipped: the next sync would overwrite them, so their markup
 * lives in src/lib/partnerSync/globalTravel.ts.
 *
 * Each trip is written with patchTrip (the admin's save, so the website follows) together with its
 * poster edited in place: rebuilding the poster from the trip dropped its age bands, "Үнэгүй" cells
 * and date wording.
 *
 *   node --env-file=.env.local --import tsx scripts/shift-trip-prices.ts --amount=100000            # dry run
 *   node --env-file=.env.local --import tsx scripts/shift-trip-prices.ts --amount=100000 --apply --backup=<file.json>
 *   ... --only=<trip id>     one trip;   ... --skip=<id,id>   trips already done
 * Undo: run again with the opposite amount, or restore the rows from the backup file.
 */
import { writeFileSync } from "node:fs";
import { closeNeonPool, queryNeon } from "../src/lib/neonDb";
import { patchTrip } from "../src/lib/travelDb";
import { shiftPosterFares, shiftTripFares } from "../src/lib/priceShift";

type Row = Record<string, unknown>;
const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const amount = Number(arg("amount"));
const apply = process.argv.includes("--apply");
const only = arg("only");
const skip = new Set((arg("skip") || "").split(",").filter(Boolean));
const backup = arg("backup");
if (!Number.isSafeInteger(amount) || amount === 0) throw new Error("--amount=<whole MNT, not 0> is required");
if (apply && !backup) throw new Error("--apply needs --backup=<file.json>");

const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? value as Row : {});
const fares = (value: unknown): number[] => {
  const found: number[] = [];
  const walk = (node: unknown, key = "") => {
    if (Array.isArray(node)) node.forEach((item) => walk(item, key));
    else if (node && typeof node === "object") Object.entries(node).forEach(([k, v]) => walk(v, k));
    else if (typeof node === "number" && /price$/.test(key) && key !== "single_price") found.push(node);
  };
  walk(value);
  return found;
};

async function main() {
  const result = await queryNeon<Row>(`SELECT * FROM travel_trip_entries WHERE status <> 'archived' ${only ? "AND id = $1" : ""} ORDER BY route_name`, only ? [only] : []);
  const all = result?.rows || [];
  const trips = all.filter((trip) => !record(trip.extra).partner_sync && !skip.has(String(trip.id)));
  const posterIds = trips.map((trip) => String(record(trip.extra).poster_trip_id || "")).filter(Boolean);
  const posters = new Map(((await queryNeon<Row>("SELECT id, title, source_file, data FROM poster_trips WHERE id = ANY($1::text[])", [posterIds]))?.rows || [])
    .map((poster) => [String(poster.id), poster]));
  if (backup) {
    writeFileSync(backup, JSON.stringify({ takenAt: new Date().toISOString(), amount, trips, posters: [...posters.values()] }, null, 1));
    console.log(`Backup: ${trips.length} trips, ${posters.size} posters -> ${backup}`);
  }
  console.log(`${apply ? "APPLY" : "DRY RUN"}: ${trips.length} trips, ${amount > 0 ? "+" : ""}${amount}₮ per fare; skipped ${all.length - trips.length} (partner-synced or --skip).`);
  let failures = 0;
  for (const trip of trips) {
    const fields = shiftTripFares(trip, amount);
    const moved = fares(fields).filter((value) => value > 0).length;
    const poster = posters.get(String(record(trip.extra).poster_trip_id || ""));
    const posterData = poster ? shiftPosterFares(poster.data, amount) : null;
    const posterCells = poster ? JSON.stringify(posterData) !== JSON.stringify(poster.data) : false;
    const line = `${String(trip.status).padEnd(7)} ${String(trip.route_name).slice(0, 55)}: ${moved} fares${poster ? `, poster ${posterCells ? "updated" : "no fare cells"}` : ", no poster"}, adult ${trip.adult_price ?? "-"} -> ${fields.adult_price ?? "-"}`;
    if (!apply) { console.log(line); continue; }
    try {
      await patchTrip(String(trip.id), fields as never, false,
        poster ? { id: String(poster.id), title: String(poster.title), data: posterData, source_file: (poster.source_file as string | null) ?? null, note: `Fares ${amount > 0 ? "+" : ""}${amount}₮` } : undefined,
        undefined, { flush: "inline" });
      console.log(`ok  ${line}`);
    } catch (error) {
      failures++;
      console.log(`ERR ${line} -> ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 2; }).finally(() => closeNeonPool().catch(() => {}));
