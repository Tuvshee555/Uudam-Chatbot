/**
 * Photo audit for the corporate catalogue. READ-ONLY: reads trips and posters from the database,
 * downloads the candidate photos through the guarded image fetcher, measures them, ranks them with
 * the same code the catalogue uses (src/lib/catalogue/photos.ts) and writes CONTACT SHEETS for a
 * human photo editor to look at. Stores nothing in the database, publishes nothing, sends nothing.
 *
 *   node --env-file=.env.local --import tsx scripts/catalogue-photo-audit.ts [outDir] [--trips-per-sheet 6] [--cands 5] [--refresh]
 *   node --env-file=.env.local --import tsx scripts/catalogue-photo-audit.ts [outDir] --apply-picks picks.src.json
 *
 * Output (default outputs/catalogue-qa/photo-audit/):
 *   sheet-01.jpg ...   one JPEG per N trips; each row = one trip, its top candidates as thumbnails
 *                      labelled "#rank score WxH source" (the trip row is labelled T<index>)
 *   index.json         T<index> -> trip id, title, group and every candidate (url, size, score, issues)
 *   cache/             measurements + 640px thumbnails, so a re-run does not download again
 *   picks.json + REPORT.md   written by --apply-picks from the editor's hand-written picks.src.json:
 *                      { "<T index>": { "pick": <candidate rank, 1-based> | "REPLACE", "focal": [x, y], "zoom": 1.2,
 *                        "quality": "excellent|good|weak|missing", "note": "why" } }
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import { queryNeon } from "../src/lib/neonDb";
import { mapTripRow } from "../src/lib/travelDb";
import { loadPosterRows, planEdition } from "../src/lib/catalogue/tripData";
import { classifyTrips } from "../src/lib/catalogue/groups";
import { deriveStartingPrice, ubDay } from "../src/lib/catalogue/pricing";
import { editorialTitle } from "../src/lib/catalogue/editorial";
import { measurePhotoDetails, rankPhotoCandidates, type PhotoSizes } from "../src/lib/catalogue/photos";
import type { CataloguePhotoCandidate } from "../src/lib/catalogue/types";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--") && args[i - 1] !== "--refresh"));
const outDir = path.resolve(positional[0] || "outputs/catalogue-qa/photo-audit");
const perSheet = Number(option("--trips-per-sheet", "6"));
const candsPerTrip = Number(option("--cands", "5"));
const applyPicks = option("--apply-picks", "");
/** First candidate rank shown on the sheets (1 = the best; 6 shows the ones the first pass cut off). */
const fromRank = Number(option("--from", "1"));
const sheetPrefix = fromRank > 1 ? `more-from${fromRank}-` : "sheet-";

const THUMB = { w: 300, h: 200 };
const LABEL_W = 70;
const ROW_GAP = 8;

type Stat = { width: number; height: number; sharpness?: number; flat?: number; colorful?: number; byteLength?: number };
type CacheFile = Record<string, Stat | null>;

const hash = (url: string) => createHash("sha1").update(url).digest("hex").slice(0, 16);
const esc = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function loadCache(dir: string): Promise<CacheFile> {
  try {
    return JSON.parse(await readFile(path.join(dir, "measurements.json"), "utf8")) as CacheFile;
  } catch {
    return {};
  }
}

type IndexTrip = {
  index: string;
  tripId: string;
  title: string;
  editorial: string;
  group: string;
  price: string;
  candidates: Array<CataloguePhotoCandidate & { rank: number; sharpness?: number; flat?: number; colorful?: number }>;
};

async function loadTrips() {
  const result = await queryNeon<Record<string, unknown>>("SELECT * FROM travel_trip_entries WHERE status = 'active'");
  const trips = (result?.rows || []).map(mapTripRow);
  const today = ubDay(new Date().toISOString());
  const empty = { tripIds: [], groupOverrides: {}, featuredTripIds: [], excludedTripIds: [] };
  const eligible = planEdition({ edition: "complete", trips, config: empty }, today).trips
    .sort((a, b) => a.route_name.localeCompare(b.route_name) || a.id.localeCompare(b.id));
  const posters = await loadPosterRows(eligible);
  return { eligible, posters, today };
}

async function audit() {
  const cacheDir = path.join(outDir, "cache");
  await mkdir(cacheDir, { recursive: true });
  const { eligible, posters, today } = await loadTrips();
  const cache = flag("--refresh") ? {} : await loadCache(cacheDir);

  const urls = [...new Set(eligible.flatMap((trip) => rankPhotoCandidates(trip, posters[trip.id]).map((c) => c.url)))];
  const missing = urls.filter((url) => !(url in cache));
  console.log(`${eligible.length} eligible trips, ${urls.length} distinct candidate photos, ${missing.length} to download`);
  let done = 0;
  const details = await measurePhotoDetails(missing, {
    concurrency: 6,
    thumbWidth: 640,
    onResult: (url, m) => {
      done++;
      if (done % 25 === 0) console.log(`  ${done}/${missing.length}`);
      if (m?.thumb) void writeFile(path.join(cacheDir, `${hash(url)}.jpg`), m.thumb);
    },
  });
  for (const url of missing) {
    const d = details[url];
    cache[url] = d ? { width: d.width, height: d.height, sharpness: d.sharpness, flat: d.flat, colorful: d.colorful, byteLength: d.byteLength } : null;
  }
  await writeFile(path.join(cacheDir, "measurements.json"), JSON.stringify(cache, null, 1));

  const sizes: PhotoSizes = {};
  for (const [url, stat] of Object.entries(cache)) if (stat) sizes[url] = stat;

  const priceOf = (trip: (typeof eligible)[number]) => {
    const price = deriveStartingPrice(trip, today).price;
    return { text: price.display, mnt: price.kind === "from" ? price.amountMnt : null };
  };
  const decisions = classifyTrips(eligible.map((trip) => ({ trip, priceMnt: priceOf(trip).mnt })));
  const index: IndexTrip[] = eligible.map((trip, i) => ({
    index: `T${String(i + 1).padStart(2, "0")}`,
    tripId: trip.id,
    title: trip.route_name,
    editorial: editorialTitle(trip.route_name),
    group: decisions.get(trip.id)!.groupKey,
    price: priceOf(trip).text,
    candidates: rankPhotoCandidates(trip, posters[trip.id], { sizes }).map((c, rank) => ({ ...c, rank: rank + 1, sharpness: sizes[c.url]?.sharpness, flat: sizes[c.url]?.flat, colorful: sizes[c.url]?.colorful })),
  }));
  await writeFile(path.join(outDir, "index.json"), JSON.stringify(index, null, 1));

  // Contact sheets.
  const cols = candsPerTrip;
  const rowH = THUMB.h + ROW_GAP;
  const sheetW = LABEL_W + cols * (THUMB.w + ROW_GAP);
  let sheetNo = 0;
  const shown = fromRank > 1 ? index.filter((t) => t.candidates.length >= fromRank) : index;
  for (let start = 0; start < shown.length; start += perSheet) {
    const rowsOfSheet = shown.slice(start, start + perSheet);
    const composites: OverlayOptions[] = [];
    for (let r = 0; r < rowsOfSheet.length; r++) {
      const item = rowsOfSheet[r]!;
      const top = r * rowH;
      const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${LABEL_W}" height="${THUMB.h}"><rect width="100%" height="100%" fill="#1d1d1d"/><text x="8" y="34" font-family="Arial,sans-serif" font-size="26" font-weight="700" fill="#ffffff">${item.index}</text><text x="8" y="60" font-family="Arial,sans-serif" font-size="13" fill="#bbbbbb">${esc(item.group)}</text><text x="8" y="80" font-family="Arial,sans-serif" font-size="12" fill="#999999">${item.candidates.length} pics</text></svg>`);
      composites.push({ input: label, left: 0, top });
      for (let c = 0; c < Math.min(cols, item.candidates.length - (fromRank - 1)); c++) {
        const cand = item.candidates[fromRank - 1 + c]!;
        let thumb: Buffer;
        try {
          const raw = await readFile(path.join(cacheDir, `${hash(cand.url)}.jpg`));
          thumb = await sharp(raw).resize({ width: THUMB.w, height: THUMB.h, fit: "contain", background: "#2a2a2a" }).jpeg({ quality: 82 }).toBuffer();
        } catch {
          thumb = await sharp({ create: { width: THUMB.w, height: THUMB.h, channels: 3, background: "#5a1d1d" } }).jpeg().toBuffer();
        }
        const caption = `#${cand.rank} s${cand.score} ${cand.width ?? "?"}x${cand.height ?? "?"} ${cand.source.replace("poster_", "p_").replace("trip_photo", "trip")}${cand.sharpness !== undefined ? ` sh${Math.round(cand.sharpness)}` : ""}${cand.flat !== undefined ? ` fl${cand.flat}` : ""}`;
        const badge = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${THUMB.w}" height="22"><rect width="100%" height="100%" fill="#000000" fill-opacity="0.72"/><text x="6" y="16" font-family="Arial,sans-serif" font-size="13" fill="#ffffff">${esc(caption)}</text></svg>`);
        const left = LABEL_W + c * (THUMB.w + ROW_GAP);
        composites.push({ input: thumb, left, top });
        composites.push({ input: badge, left, top });
      }
    }
    sheetNo++;
    const file = path.join(outDir, `${sheetPrefix}${String(sheetNo).padStart(2, "0")}.jpg`);
    await sharp({ create: { width: sheetW, height: rowsOfSheet.length * rowH, channels: 3, background: "#0e0e0e" } })
      .composite(composites).jpeg({ quality: 85 }).toFile(file);
    console.log(`wrote ${file} (${rowsOfSheet.map((t) => t.index).join(" ")})`);
  }
  if (fromRank > 1) return;
  const failed = Object.values(cache).filter((v) => v === null).length;
  console.log(`done: ${index.length} trips, ${sheetNo} sheets, ${failed} photos could not be fetched/decoded`);
}

type PickSrc = { pick: number | "REPLACE"; focal?: [number, number]; zoom?: number; quality?: string; note?: string };

async function applyPickFile(file: string) {
  const index = JSON.parse(await readFile(path.join(outDir, "index.json"), "utf8")) as IndexTrip[];
  const src = JSON.parse(await readFile(path.resolve(file), "utf8")) as Record<string, PickSrc>;
  const picks: Record<string, { url: string | null; focal: { x: number; y: number } | null; zoom?: number; quality: string; note: string; replace?: true }> = {};
  const lines: string[] = ["# Catalogue photo audit: editorial picks", "", `Eligible trips: ${index.length}. Picks by a human photo editor looking at the contact sheets; scores come from src/lib/catalogue/photos.ts.`, ""];
  const replace: string[] = [];
  const counts: Record<string, number> = { excellent: 0, good: 0, weak: 0, missing: 0 };
  for (const item of index) {
    const entry = src[item.index];
    lines.push(`## ${item.index} ${item.title}`);
    lines.push(`Display title: ${item.editorial} · group ${item.group} · price ${item.price} · ${item.candidates.length} candidate photos`);
    if (!entry) {
      lines.push("- NO PICK RECORDED", "");
      continue;
    }
    const quality = entry.quality || (entry.pick === "REPLACE" ? "missing" : "good");
    counts[quality] = (counts[quality] ?? 0) + 1;
    if (entry.pick === "REPLACE") {
      replace.push(`${item.index} ${item.title}`);
      // Kept in picks.json so nothing is silently missing; a null url is ignored by the config sanitiser.
      picks[item.tripId] = { url: null, focal: null, quality: "missing", note: entry.note ?? "", replace: true };
      lines.push(`- **REPLACE**: ${entry.note ?? "nothing premium-worthy"}`, "");
      continue;
    }
    const cand = item.candidates.find((c) => c.rank === entry.pick);
    if (!cand) {
      lines.push(`- pick #${entry.pick} not found`, "");
      continue;
    }
    const [x, y] = entry.focal ?? [0.5, 0.5];
    picks[item.tripId] = { url: cand.url, focal: { x, y }, ...(entry.zoom ? { zoom: entry.zoom } : {}), quality, note: entry.note ?? "" };
    lines.push(`- Chosen: #${cand.rank} (${cand.width}x${cand.height}, score ${cand.score}, ${cand.source}) focal ${x},${y}${entry.zoom ? ` zoom ${entry.zoom}` : ""} · **${quality}**`);
    lines.push(`- Why: ${entry.note ?? ""}`);
    if (cand.rank !== 1) lines.push(`- Note: the automatic ranking put #1 first (score ${item.candidates[0]?.score}); the editor overrode it.`);
    if (quality === "weak") lines.push("- FLAGGED: weak hero, replace the photo when a better one is available.");
    lines.push("");
  }
  lines.splice(4, 0, `Summary: excellent ${counts.excellent}, good ${counts.good}, weak ${counts.weak}, missing/replace ${counts.missing}.`, replace.length ? `Replace: ${replace.join("; ")}` : "Replace: none", "");
  await writeFile(path.join(outDir, "picks.json"), JSON.stringify(picks, null, 1));
  await writeFile(path.join(outDir, "REPORT.md"), lines.join("\n"));
  console.log(`wrote picks.json (${Object.keys(picks).length} picks) and REPORT.md`);
}

(applyPicks ? applyPickFile(applyPicks) : audit()).then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
