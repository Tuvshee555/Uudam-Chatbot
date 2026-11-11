/**
 * Persists the photo editor's reviewed picks into the catalogue config (display only: which stored
 * photograph heads a trip's page, its crop, and the cover photograph). It never touches a trip, a
 * poster, a price, a date or a title.
 *
 *   node --env-file=.env.local --import tsx scripts/catalogue-apply-picks.ts                 dry run (default): validate + print the diff
 *   node --env-file=.env.local --import tsx scripts/catalogue-apply-picks.ts --apply         write the merged config through the store
 *        [--picks outputs/catalogue-qa/photo-audit/picks.json]
 *        [--cover outputs/catalogue-qa/v3/cover-pick.json]    {tripId, url, focal, zoom, note}; skipped when the file is absent
 *        [--overwrite]   replace a hero staff already chose (default: staff choices are kept)
 *
 * Rules:
 *  - every url must be one of that trip's stored candidates (rankPhotoCandidates on the live trip + poster);
 *  - focal x / y in 0..1, zoom in 1..3, otherwise the file is refused (nothing is written);
 *  - --apply writes ONLY the catalogue_config row (+ the store's own audit line), through
 *    saveCatalogueConfig(actor "editorial-audit") with the expectedUpdatedAt guard, so a concurrent
 *    staff save is refused instead of overwritten;
 *  - idempotent: a second run finds nothing to change and writes nothing.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadPosterRows } from "../src/lib/catalogue/tripData";
import { rankPhotoCandidates, photoKey } from "../src/lib/catalogue/photos";
import { MAX_HERO_ZOOM, MIN_HERO_ZOOM, sanitizeHeroChoice } from "../src/lib/catalogue/config";
import type { CatalogueConfig, CatalogueHeroChoice } from "../src/lib/catalogue/types";

export const PICKS_ACTOR = "editorial-audit";

/**
 * What UUDAM staff themselves have told company customers in real conversations (travel_conversations),
 * lightly punctuated. Nothing else about corporate services is supported by data, so nothing else is printed.
 * Staff can edit the lines in the catalogue config; the owner approves them before publishing.
 */
export const SUPPORTED_CORPORATE_NOTES = [
  "Албан байгууллагад тусгай аялал гаргах боломжтой.",
  "Хамт олонд зориулсан тусгай VIP хөтөлбөр, маршрутыг ажилтан бэлтгэнэ.",
];

export type PickIssue = { where: string; problem: string };
export type PickDiff = { tripId: string; title: string; before: CatalogueHeroChoice | null; after: CatalogueHeroChoice; action: "add" | "change" | "keep-staff" | "same" };
export type PicksPlan = {
  heroByTripId: Record<string, CatalogueHeroChoice>;
  coverPhoto: CatalogueHeroChoice | null;
  diffs: PickDiff[];
  cover: { before: CatalogueHeroChoice | null; after: CatalogueHeroChoice | null; action: "add" | "change" | "keep-staff" | "same" | "none"; tripId: string | null };
  skipped: string[];
  issues: PickIssue[];
  changed: boolean;
};

type RawPick = { url?: unknown; focal?: unknown; zoom?: unknown; quality?: unknown; note?: unknown };

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** One raw pick -> a clean hero choice, or the reasons it is refused. Pure. */
export function validatePick(raw: RawPick, candidateUrls: ReadonlySet<string>, where: string): { choice: CatalogueHeroChoice | null; issues: PickIssue[] } {
  const issues: PickIssue[] = [];
  const bad = (problem: string) => issues.push({ where, problem });
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (!url) return { choice: null, issues };
  if (!candidateUrls.has(photoKey(url))) bad("зураг энэ аяллын хадгалсан зургуудын нэг биш (url not among the trip's candidates)");
  let focal: { x: number; y: number } | undefined;
  if (raw.focal !== undefined && raw.focal !== null) {
    const f = Array.isArray(raw.focal) ? { x: raw.focal[0], y: raw.focal[1] } : (raw.focal as { x?: unknown; y?: unknown });
    if (!finite(f.x) || !finite(f.y) || f.x < 0 || f.x > 1 || f.y < 0 || f.y > 1) bad("focal x/y must be numbers in 0..1");
    else focal = { x: f.x, y: f.y };
  }
  let zoom: number | undefined;
  if (raw.zoom !== undefined && raw.zoom !== null) {
    if (!finite(raw.zoom) || raw.zoom < MIN_HERO_ZOOM || raw.zoom > MAX_HERO_ZOOM) bad(`zoom must be a number in ${MIN_HERO_ZOOM}..${MAX_HERO_ZOOM}`);
    else zoom = raw.zoom;
  }
  if (raw.quality !== undefined && raw.quality !== null && !["excellent", "good", "weak", "missing"].includes(String(raw.quality))) bad("quality must be excellent|good|weak|missing");
  if (issues.length) return { choice: null, issues };
  const choice = sanitizeHeroChoice({ url, focal, zoom, quality: raw.quality ?? undefined });
  return { choice, issues: choice ? [] : [{ where, problem: "not a usable https url" }] };
}

const same = (a: CatalogueHeroChoice | null | undefined, b: CatalogueHeroChoice | null | undefined) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Merge the picks into the saved config. Pure: no database, no network. `candidatesByTrip` is
 * the set of photoKey()s each trip stores; `titleByTrip` is for the printout only.
 */
export function planPicks(input: {
  config: Pick<CatalogueConfig, "heroByTripId" | "coverPhoto">;
  picks: Record<string, RawPick>;
  cover: (RawPick & { tripId?: unknown }) | null;
  candidatesByTrip: Record<string, ReadonlySet<string>>;
  titleByTrip: Record<string, string>;
  overwrite: boolean;
}): PicksPlan {
  const issues: PickIssue[] = [];
  const skipped: string[] = [];
  const diffs: PickDiff[] = [];
  const heroByTripId = { ...(input.config.heroByTripId ?? {}) };
  for (const [tripId, raw] of Object.entries(input.picks)) {
    const title = input.titleByTrip[tripId] ?? tripId;
    const candidates = input.candidatesByTrip[tripId];
    if (!candidates) { issues.push({ where: tripId, problem: "trip is not an active trip (or has no stored photos)" }); continue; }
    const { choice, issues: pickIssues } = validatePick(raw, candidates, `${title} [${tripId}]`);
    issues.push(...pickIssues);
    if (!choice) { if (!pickIssues.length) skipped.push(`${title}: no url (needs a replacement photo, nothing to store)`); continue; }
    const before = heroByTripId[tripId] ?? null;
    let action: PickDiff["action"];
    if (!before) action = "add";
    else if (same(before, choice)) action = "same";
    else if (input.overwrite) action = "change";
    else action = "keep-staff";
    if (action === "add" || action === "change") heroByTripId[tripId] = choice;
    diffs.push({ tripId, title, before, after: choice, action });
  }

  let coverPhoto = input.config.coverPhoto ?? null;
  const cover: PicksPlan["cover"] = { before: coverPhoto, after: null, action: "none", tripId: null };
  if (input.cover) {
    const tripId = typeof input.cover.tripId === "string" ? input.cover.tripId : "";
    cover.tripId = tripId || null;
    const candidates = input.candidatesByTrip[tripId];
    if (!candidates) issues.push({ where: "cover", problem: `cover trip ${tripId || "(missing tripId)"} is not an active trip with stored photos` });
    else {
      const { choice, issues: coverIssues } = validatePick(input.cover, candidates, `cover [${tripId}]`);
      issues.push(...coverIssues);
      if (choice) {
        cover.after = choice;
        cover.action = !coverPhoto ? "add" : same(coverPhoto, choice) ? "same" : input.overwrite ? "change" : "keep-staff";
        if (cover.action === "add" || cover.action === "change") coverPhoto = choice;
      }
    }
  }
  const changed = diffs.some((d) => d.action === "add" || d.action === "change") || cover.action === "add" || cover.action === "change";
  return { heroByTripId, coverPhoto, diffs, cover, skipped, issues, changed };
}

const fmt = (c: CatalogueHeroChoice | null) => (c ? `${c.url.split("/").slice(-1)[0]} focal=${c.focal ? `${c.focal.x},${c.focal.y}` : "—"} zoom=${c.zoom ?? "—"} q=${c.quality ?? "—"}` : "—");

async function readJson(file: string, optional = false): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path.resolve(file), "utf8"));
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`cannot read ${file}: ${error instanceof Error ? error.message : error}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name: string, fallback: string) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1]! : fallback; };
  const apply = args.includes("--apply");
  const overwrite = args.includes("--overwrite");
  const picksFile = option("--picks", "outputs/catalogue-qa/photo-audit/picks.json");
  const coverFile = option("--cover", "outputs/catalogue-qa/v3/cover-pick.json");

  // Database modules load only when the script runs, so the pure planner above can be imported by tests.
  const [{ listTrips }, { ensureCatalogueSchema, getCatalogueConfig, saveCatalogueConfig }] = await Promise.all([import("../src/lib/travelDb"), import("../src/lib/catalogue/store")]);
  const picks = (await readJson(picksFile)) as Record<string, RawPick>;
  const cover = await readJson(coverFile, true);
  await ensureCatalogueSchema();
  const config = await getCatalogueConfig();
  const trips = await listTrips({ status: "active", limit: 2000 });
  const posters = await loadPosterRows(trips);
  const candidatesByTrip: Record<string, ReadonlySet<string>> = {};
  const titleByTrip: Record<string, string> = {};
  for (const trip of trips) {
    candidatesByTrip[trip.id] = new Set(rankPhotoCandidates(trip, posters[trip.id]).map((c) => photoKey(c.url)));
    titleByTrip[trip.id] = trip.route_name;
  }

  const plan = planPicks({ config, picks, cover: cover as Parameters<typeof planPicks>[0]["cover"], candidatesByTrip, titleByTrip, overwrite });
  console.log(`${apply ? "APPLY" : "DRY RUN"}  picks=${Object.keys(picks).length} (${picksFile})  cover=${cover ? coverFile : "none"}  overwrite=${overwrite}`);
  for (const d of plan.diffs) {
    console.log(`  ${d.action.padEnd(10)} ${d.title}\n             before: ${fmt(d.before)}\n             after:  ${fmt(d.after)}`);
  }
  if (plan.cover.action !== "none") console.log(`  cover ${plan.cover.action.padEnd(10)} trip ${plan.cover.tripId}\n             before: ${fmt(plan.cover.before)}\n             after:  ${fmt(plan.cover.after)}`);
  for (const s of plan.skipped) console.log(`  skipped    ${s}`);
  const count = (a: string) => plan.diffs.filter((d) => d.action === a).length;
  console.log(`summary: add ${count("add")}, change ${count("change")}, same ${count("same")}, kept-staff ${count("keep-staff")}, skipped ${plan.skipped.length}, cover ${plan.cover.action}`);

  if (plan.issues.length) {
    for (const i of plan.issues) console.error(`  REFUSED ${i.where}: ${i.problem}`);
    console.error("Nothing written: fix the picks file first.");
    process.exitCode = 1;
    return;
  }
  const notes = config.corporateNotes?.length && !overwrite ? config.corporateNotes : SUPPORTED_CORPORATE_NOTES;
  const notesChanged = JSON.stringify(notes) !== JSON.stringify(config.corporateNotes ?? []);
  if (notesChanged) console.log(`  closing-page notes -> ${notes.map((n) => `«${n}»`).join(" · ")}`);
  if (!plan.changed && !notesChanged) { console.log("Nothing to change (already applied)."); return; }
  if (!apply) { console.log("Dry run only. Re-run with --apply to write catalogue_config."); return; }

  const saved = await saveCatalogueConfig(
    { ...config, heroByTripId: plan.heroByTripId, coverPhoto: plan.coverPhoto, corporateNotes: notes },
    PICKS_ACTOR,
    { expectedUpdatedAt: config.updatedAt },
  );
  console.log(`Saved catalogue_config at ${saved.updatedAt} by ${saved.updatedBy}: ${Object.keys(saved.heroByTripId).length} hero choices, cover ${saved.coverPhoto ? "set" : "unset"}.`);
}

// Importable for tests; runs only when invoked as a script.
if (process.argv[1] && /catalogue-apply-picks\.[cm]?[jt]s$/.test(process.argv[1].replace(/\\/g, "/"))) {
  main().then(() => process.exit(process.exitCode ?? 0), (error) => { console.error(error); process.exit(1); });
}
