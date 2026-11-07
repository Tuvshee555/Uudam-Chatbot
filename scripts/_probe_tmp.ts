import { writeFile } from "node:fs/promises";
import { queryNeon } from "../src/lib/neonDb";
import { mapTripRow } from "../src/lib/travelDb";
import { planEdition, loadPosterRows, buildCatalogueSnapshot } from "../src/lib/catalogue/tripData";
import { classifyTrips } from "../src/lib/catalogue/groups";
import { deriveStartingPrice } from "../src/lib/catalogue/pricing";
async function main() {
  const r = await queryNeon<Record<string, unknown>>("SELECT * FROM travel_trip_entries WHERE status = 'active'");
  const trips = (r?.rows || []).map(mapTripRow);
  const today = new Date().toISOString().slice(0,10);
  const el = planEdition({ edition: "complete", trips, config: { tripIds: [], groupOverrides: {}, featuredTripIds: [], excludedTripIds: [] } }, today).trips;
  const dec = classifyTrips(el.map(t=>({trip:t, priceMnt: (()=>{const p=deriveStartingPrice(t,today).price; return p.kind==="from"?p.amountMnt:null})()})));
  const out = el.map(t=>({id:t.id,title:t.route_name,group:dec.get(t.id)!.groupKey, warn:dec.get(t.id)!.warnings.map(w=>w.message.slice(0,60))}));
  await writeFile(process.argv[2], JSON.stringify(out,null,1));
  // dump raw text fields for one trip containing 'ДАНАНГ'
  const dn = el.find(t=>/данан/i.test(t.route_name));
  await writeFile(process.argv[3], JSON.stringify(dn,null,1));
  console.log(out.map(o=>`${o.group.padEnd(7)} ${o.title}`).join("\n"));
}
main().then(()=>process.exit(0), e=>{console.error(e);process.exit(1)});
