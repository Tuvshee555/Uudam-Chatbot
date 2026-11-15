/**
 * Generates the Quick and Complete catalogues from the LIVE trip database exactly as the admin's
 * Generate button does (same snapshot loader, renderer and store), checks the result, and - with
 * --publish - publishes each edition through the store's own publish rule.
 *
 *   node --env-file=.env.local --import tsx scripts/catalogue-publish.ts                 generate drafts + report
 *   node --env-file=.env.local --import tsx scripts/catalogue-publish.ts --publish       ... and publish them
 *        [--only quick|complete]   [--actor <label>]   [--ack-warnings]
 *
 * Writes only catalogue_* tables (drafts, page images, publish pointer, audit). Sends nothing to
 * anybody. Blocking warnings stop a publish unless --ack-warnings is given after reading them.
 */
import { getDeps } from "../src/lib/catalogue/admin/deps";
import { selectionBoundsMessage } from "../src/lib/catalogue/admin/validation";
import type { CatalogueEdition, CatalogueVersionMeta } from "../src/lib/catalogue/types";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1]! : fallback; };
const publish = args.includes("--publish");
const acknowledge = args.includes("--ack-warnings");
const actor = option("--actor", "launch-2026-11-07");
const only = option("--only", "") as CatalogueEdition | "";

async function generate(edition: "quick" | "complete"): Promise<CatalogueVersionMeta> {
  const deps = getDeps();
  const [store, data, render] = await Promise.all([deps.store(), deps.data(), deps.render()]);
  await store.ensureCatalogueSchema();
  const nowIso = deps.now().toISOString();
  const input = await data.loadSnapshotInput(edition, { nowIso, measurePhotos: true });
  const snapshot = data.buildCatalogueSnapshot(input);
  if (edition === "complete" && snapshot.trips.length < 1) throw new Error("no eligible trips for the complete catalogue");
  if (edition === "quick") {
    const bounds = selectionBoundsMessage("quick", snapshot.trips.length);
    if (bounds) throw new Error(`quick selection out of bounds: ${bounds}`);
  }
  const nextNo = ((await store.listVersions(edition, 1))[0]?.versionNo ?? 0) + 1;
  const rendered = await render.renderCatalogue(snapshot, { pageImages: true, versionLabel: `v${nextNo}` });
  const head = rendered.pdf.subarray(0, 5).toString("latin1");
  if (!head.startsWith("%PDF")) throw new Error(`${edition}: rendered file is not a PDF`);
  const meta = await store.saveDraftVersion({ edition, snapshot, rendered, actor });
  console.log(`[${edition}] draft v${meta.versionNo} ${meta.fileName}: ${meta.tripCount} trips, ${meta.pageCount} pages, ${(meta.sizeBytes / 1048576).toFixed(2)} MB, id ${meta.id}`);
  for (const w of meta.warnings.filter((x) => x.severity !== "info")) console.log(`   ${w.severity.toUpperCase()} ${w.code}${w.tripId ? ` [${w.tripId.slice(0, 8)}]` : ""}: ${w.message}`);
  return meta;
}

async function main() {
  const editions = (only ? [only] : ["quick", "complete"]).filter((e): e is "quick" | "complete" => e === "quick" || e === "complete");
  const store = await getDeps().store();
  const drafts: CatalogueVersionMeta[] = [];
  for (const edition of editions) drafts.push(await generate(edition));
  if (!publish) { console.log("Drafts only. Re-run with --publish to publish them."); return; }
  for (const draft of drafts) {
    const blocking = draft.warnings.filter((w) => w.severity === "blocking");
    if (blocking.length && !acknowledge) {
      console.error(`[${draft.edition}] NOT published: ${blocking.length} blocking warning(s). Read them above; re-run with --ack-warnings only if they are acceptable.`);
      process.exitCode = 1;
      continue;
    }
    const live = await store.publishVersion(draft.id, actor, { acknowledgeWarnings: acknowledge });
    console.log(`[${live.edition}] PUBLISHED v${live.versionNo} token ${live.publicToken} at ${live.publishedAt}`);
  }
}

main().then(() => process.exit(process.exitCode ?? 0), (error) => { console.error(error); process.exit(1); });
