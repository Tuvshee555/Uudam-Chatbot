/**
 * Data audit for the corporate catalogue. READ-ONLY: reads the live trips, posters, saved catalogue
 * config and the STORED trip codes; allocates nothing, writes nothing, changes no trip data.
 *
 *   node --env-file=.env.local --import tsx scripts/catalogue-data-audit.ts [outFile] [--saved-only]
 *
 * Default output: outputs/catalogue-qa/v3/DATA_AUDIT.md. For EVERY eligible trip one row (persistent
 * code or "--", canonical title, editorial title, minimum adult price + its date + prose
 * contradictions, departures, duration, transport label vs the structured value, group, hero
 * quality, whether each edition prints it), then every contradiction found with the evidence and
 * the fix staff should make. What the Quick and the Complete editions would print is cross-checked
 * against the canonical data (an independent fare scan, the stored title/duration/transport) and
 * against each other (one trip must read the same in both).
 *
 * By default the reviewed photo picks (photo-audit/picks.json, v3/cover-pick.json) are applied
 * IN MEMORY, as `catalogue-apply-picks --apply` will persist them; --saved-only audits the saved
 * config as it is now.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { listTrips } from "../src/lib/travelDb";
import * as store from "../src/lib/catalogue/store";
import { buildCatalogueSnapshot, loadPosterRows, transportLabelOf } from "../src/lib/catalogue/tripData";
import { findOverviewPriceConflicts, isTripEligible, scanTripFares, ubDay } from "../src/lib/catalogue/pricing";
import { checkTripConsistency, flightLegEvidence, structuredDuration } from "../src/lib/catalogue/consistency";
import { isProvisionalCode, PROVISIONAL_CODE_PREFIX, row, text } from "../src/lib/catalogue/diagnostics";
import { GROUP_DEFS } from "../src/lib/catalogue/groups";
import { sanitizeHeroByTripId, sanitizeHeroChoice } from "../src/lib/catalogue/config";
import { tripTransport } from "../src/lib/tripFacts";
import type { PhotoSizes } from "../src/lib/catalogue/photos";
import type { CatalogueConfig, CatalogueEdition, CatalogueSnapshot } from "../src/lib/catalogue/types";
import type { TravelTrip } from "../src/lib/travelTypes";

const args = process.argv.slice(2);
const savedOnly = args.includes("--saved-only");
const outFile = path.resolve(args.find((a) => !a.startsWith("--")) || "outputs/catalogue-qa/v3/DATA_AUDIT.md");

type Issue = { tripId: string; severity: "contradiction" | "info"; kind: string; edition: string; summary: string; evidence: string[]; fix: string };

const cell = (value: unknown) => String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim() || "—";
const mnt = (n: number) => `${Math.round(n).toLocaleString("en-US")}₮`;
const groupLabel = (key: string) => GROUP_DEFS.find((g) => g.key === key)?.label ?? key;

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path.resolve(file), "utf8")) as T;
  } catch {
    return null;
  }
}

async function main() {
  const nowIso = new Date().toISOString();
  const today = ubDay(nowIso);
  const trips = await listTrips({ status: "active", limit: 2000 });
  const eligibleTrips = trips.filter((t) => isTripEligible(t, today).eligible);
  const posterByTripId = await loadPosterRows(eligibleTrips);
  const saved: CatalogueConfig = await store.getCatalogueConfig();
  const stored = await store.getTripCodeMap();

  let heroByTripId = { ...saved.heroByTripId };
  let coverPhoto = saved.coverPhoto ?? null;
  const picks = savedOnly ? null : await readJson<Record<string, unknown>>("outputs/catalogue-qa/photo-audit/picks.json");
  if (picks) heroByTripId = { ...sanitizeHeroByTripId(picks), ...heroByTripId };
  const coverPick = savedOnly ? null : await readJson<Record<string, unknown>>("outputs/catalogue-qa/v3/cover-pick.json");
  if (coverPick && !coverPhoto) coverPhoto = sanitizeHeroChoice(coverPick);
  const measured = (await readJson<Record<string, { width: number; height: number; sharpness?: number; flat?: number; colorful?: number } | null>>("outputs/catalogue-qa/photo-audit/cache/measurements.json")) ?? {};
  const photoSizes: PhotoSizes = Object.fromEntries(Object.entries(measured).filter((e): e is [string, NonNullable<typeof e[1]>] => Boolean(e[1])));

  // Read-only codes: the stored ones; a trip without one shows "--" (nothing is allocated here).
  const codeMap: Record<string, string> = { ...stored };
  let provisional = 0;
  for (const trip of [...eligibleTrips].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))) {
    if (!codeMap[trip.id]) codeMap[trip.id] = `${PROVISIONAL_CODE_PREFIX}${String(++provisional).padStart(3, "0")}`;
  }

  const build = (edition: CatalogueEdition): CatalogueSnapshot =>
    buildCatalogueSnapshot({
      edition, nowIso, trips, posterByTripId, config: saved[edition], heroByTripId, titleOverrides: saved.titleOverrides, coverPhoto,
      photoSizes, codeMap, contactPhones: ["00000000"], siteBaseUrl: "https://uudamtravel.mn",
    });
  const snapshots = { quick: build("quick"), complete: build("complete") };
  const cards = {
    quick: new Map(snapshots.quick.trips.map((c) => [c.tripId, c])),
    complete: new Map(snapshots.complete.trips.map((c) => [c.tripId, c])),
  };
  const codeOf = (c: { code: string } | undefined, tripId: string) => {
    const code = c?.code ?? codeMap[tripId];
    return !code || isProvisionalCode(code) ? "--" : code;
  };

  const issues: Issue[] = [];
  const rowsOut: string[] = [];
  const add = (i: Issue) => issues.push(i);

  for (const trip of [...eligibleTrips].sort((a, b) => (codeOf(cards.complete.get(a.id), a.id)).localeCompare(codeOf(cards.complete.get(b.id), b.id)) || a.route_name.localeCompare(b.route_name))) {
    const ed = cards.complete.get(trip.id) ?? cards.quick.get(trip.id);
    const label = `«${trip.route_name}»`;
    const scan = scanTripFares(trip, today);
    const min = scan.fares[0] ?? null;
    const poster = posterByTripId[trip.id];
    const prose = findOverviewPriceConflicts(trip, today, poster);
    const extra = row(trip.extra);
    const structuredTransport = text(extra.transport_type);
    const consistency = checkTripConsistency(trip, { guessedTransport: tripTransport(trip) });
    const dur = structuredDuration(trip);

    /* ---- what each edition prints vs canonical */
    for (const edition of ["quick", "complete"] as const) {
      const card = cards[edition].get(trip.id);
      if (!card) continue;
      if (card.title !== trip.route_name) add({ tripId: trip.id, severity: "contradiction", kind: "title_mismatch", edition, summary: `${label}: ${edition} prints a different canonical title`, evidence: [`stored: ${trip.route_name}`, `catalogue: ${card.title}`], fix: "Report to engineering (catalogue must print the stored title)." });
      const priceOk = min ? card.price.kind === "from" && card.price.amountMnt === min.mnt && card.price.date === min.date : card.price.kind === "inquire";
      if (!priceOk) add({ tripId: trip.id, severity: "contradiction", kind: "price_mismatch", edition, summary: `${label}: ${edition} price differs from the dated fare table`, evidence: [`dated fare table minimum: ${min ? `${mnt(min.mnt)} on ${min.date ?? "weekly"}` : "none"}`, `catalogue: ${card.price.display}${card.price.kind === "from" ? ` (${card.price.date ?? "no date"})` : ""}`], fix: "Report to engineering (catalogue price must be the minimum adult dated fare)." });
      const expectDeps = scan.dates.slice(0, 12);
      if (JSON.stringify(card.dates.departures) !== JSON.stringify(expectDeps)) add({ tripId: trip.id, severity: "contradiction", kind: "dates_mismatch", edition, summary: `${label}: ${edition} departures differ from the on-sale dates`, evidence: [`on sale: ${expectDeps.join(", ") || "—"}`, `catalogue: ${card.dates.departures.join(", ") || "—"}`], fix: "Report to engineering." });
      const wantDuration = text(trip.duration_text) || (dur.days ? `${dur.days} өдөр${dur.nights !== null ? ` ${dur.nights} шөнө` : ""}` : "");
      if (card.durationText !== wantDuration) add({ tripId: trip.id, severity: "contradiction", kind: "duration_mismatch", edition, summary: `${label}: ${edition} prints another duration than the stored one`, evidence: [`stored: ${wantDuration || "—"}`, `catalogue: ${card.durationText || "—"}`], fix: "Report to engineering." });
      const wantTransport = consistency.transportConflict ? "" : transportLabelOf(trip);
      if (card.transportLabel !== wantTransport) add({ tripId: trip.id, severity: "contradiction", kind: "transport_mismatch", edition, summary: `${label}: ${edition} prints another transport than the structured value`, evidence: [`structured: ${structuredTransport || "(none)"} -> ${wantTransport || "(blank)"}`, `catalogue: ${card.transportLabel || "(blank)"}`], fix: "Report to engineering." });
    }
    const q = cards.quick.get(trip.id);
    const c = cards.complete.get(trip.id);
    if (q && c) {
      const diffs = (["price", "durationText", "transportLabel", "editorialTitle", "heroQuality", "code"] as const)
        .filter((k) => JSON.stringify(q[k]) !== JSON.stringify(c[k]))
        .map((k) => `${k}: quick=${JSON.stringify(q[k])} complete=${JSON.stringify(c[k])}`);
      if (diffs.length) add({ tripId: trip.id, severity: "contradiction", kind: "editions_disagree", edition: "both", summary: `${label}: the two editions print different facts for one trip`, evidence: diffs, fix: "Report to engineering." });
    }

    /* ---- contradictions inside the stored data */
    for (const w of prose) {
      const d = w.detail ?? {};
      add({
        tripId: trip.id, severity: "contradiction", kind: "price_prose_conflict", edition: "both",
        summary: `${label}: prose quotes ${mnt(Number(d.overviewMnt))}, the dated fare table says ${mnt(Number(d.datedMnt))}`,
        evidence: [w.message],
        fix: `Edit the ${text(d.field)} text so it quotes ${mnt(Number(d.datedMnt))} (or drop the price from the prose). The catalogue already prints the dated fare, so the PDF is right; the website / bot copy is stale.`,
      });
    }
    if (min && trip.adult_price && trip.adult_price !== min.mnt) {
      add({ tripId: trip.id, severity: "info", kind: "base_price_differs", edition: "both", summary: `${label}: base adult price ${mnt(trip.adult_price)} differs from the cheapest dated fare ${mnt(min.mnt)}`, evidence: [`adult_price=${trip.adult_price}, dated minimum=${min.mnt} on ${min.date ?? "weekly"}`], fix: "Informational: the catalogue prints the dated minimum. Update the base price if it should match." });
    }
    if (!structuredTransport) {
      add({ tripId: trip.id, severity: "info", kind: "transport_missing", edition: "both", summary: `${label}: no structured transport type (${ed?.transportLabel ? `the catalogue guesses «${ed.transportLabel}» from the program` : "the catalogue prints no transport"})`, evidence: [`extra.transport_type is empty`], fix: "Set the transport type in the trip editor so the catalogue, website and bot agree." });
    }
    for (const f of consistency.transport) {
      add({
        tripId: trip.id, severity: "contradiction", kind: "transport_conflict", edition: "both",
        summary: `${label}: structured transport «${f.structured}» but ${f.where} says «${f.wording}»`,
        evidence: [`${f.where}: …${f.evidence}…`, ...flightLegEvidence(trip).slice(0, 6).map((l) => `program flight leg — ${l}`)],
        fix: `Decide the truth and make title, program and structured transport agree (the app has no «connecting flight» transport type; if the trip changes planes, rename the title or add the type). Until then both PDFs print NO transport label for this trip.`,
      });
    }
    for (const f of consistency.duration) {
      add({
        tripId: trip.id, severity: "contradiction", kind: "duration_conflict", edition: "both",
        summary: `${label}: ${f.where} says ${f.wording}, stored duration is ${f.structured}`,
        evidence: [`${f.where}: …${f.evidence}…`], fix: "Correct whichever side is wrong (title / program / duration fields); the PDF prints the stored duration text.",
      });
    }
    for (const w of ed?.warnings ?? []) {
      if (["price_zero", "price_missing", "dates_missing", "no_future_departure"].includes(w.code) && w.severity !== "info") {
        add({ tripId: trip.id, severity: "contradiction", kind: w.code, edition: "both", summary: `${label}: ${w.message}`, evidence: [w.message], fix: "Fill in the missing / zero adult fare or the departure dates in the admin." });
      }
    }

    const printedIn = [q ? "Quick" : null, c ? "Complete" : null].filter(Boolean).join(" + ") || "—";
    const own = issues.filter((i) => i.tripId === trip.id && i.severity === "contradiction").length;
    rowsOut.push([
      codeOf(c ?? q, trip.id), cell(trip.route_name), cell(ed?.editorialTitle),
      min ? `${mnt(min.mnt)} (${min.date ?? "weekly"})${prose.length ? " ⚠ prose differs" : ""}` : "Үнэ лавлах",
      scan.dates.length ? `${scan.dates.length}: ${scan.dates[0]}${scan.dates.length > 1 ? ` … ${scan.dates[scan.dates.length - 1]}` : ""}` : cell(scan.recurringLabel),
      cell(ed?.durationText || text(trip.duration_text)),
      `${cell(ed?.transportLabel || "(blank)")} / ${structuredTransport || "(none)"}`,
      cell(ed ? groupLabel(ed.groupKey) : ""), cell(ed?.heroQuality), printedIn, String(own),
    ].join(" | "));
  }

  const byKind = new Map<string, number>();
  for (const i of issues.filter((x) => x.severity === "contradiction")) byKind.set(i.kind, (byKind.get(i.kind) ?? 0) + 1);
  const lines: string[] = [];
  lines.push(`# Catalogue data audit (${today})`, "");
  lines.push(`Read-only. ${eligibleTrips.length} eligible trips of ${trips.length} active. Quick prints ${snapshots.quick.trips.length}, Complete prints ${snapshots.complete.trips.length}.`);
  lines.push(`Codes: ${Object.keys(stored).length} allocated in the store; "--" = not allocated yet (allocation happens on the first Generate, in one order for both editions). Photos: ${savedOnly ? "saved config only" : "reviewed picks applied in memory as apply-picks --apply will persist them"}; sizes from the photo-audit measurements.`);
  lines.push("", "## Contradictions by kind", "");
  if (!byKind.size) lines.push("None.");
  for (const [kind, n] of [...byKind].sort((a, b) => b[1] - a[1])) lines.push(`- ${kind}: ${n}`);
  lines.push("", "## Contradictions and what staff should fix", "");
  const byTrip = new Map<string, Issue[]>();
  for (const i of issues) byTrip.set(i.tripId, [...(byTrip.get(i.tripId) ?? []), i]);
  const titleOf = (id: string) => trips.find((t: TravelTrip) => t.id === id)?.route_name ?? id;
  for (const [tripId, list] of byTrip) {
    lines.push(`### ${cell(titleOf(tripId))}  (${codeOf(cards.complete.get(tripId) ?? cards.quick.get(tripId), tripId)}, \`${tripId}\`)`, "");
    for (const i of list) {
      lines.push(`- **${i.kind}** (${i.severity}, ${i.edition}): ${i.summary}`);
      for (const e of i.evidence) lines.push(`  - evidence: ${e}`);
      lines.push(`  - staff fix: ${i.fix}`);
    }
    lines.push("");
  }
  lines.push("## Every eligible trip", "");
  lines.push("| Code | Canonical title | Editorial title | Min adult price (date) | Departures (future, on sale) | Duration | Transport printed / structured | Group | Hero | Printed in | Contradictions |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rowsOut) lines.push(`| ${r} |`);
  lines.push("");
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, lines.join("\n"), "utf8");
  console.log(`wrote ${outFile}: ${eligibleTrips.length} trips, ${[...byKind.values()].reduce((a, b) => a + b, 0)} contradictions`, Object.fromEntries(byKind));
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });

