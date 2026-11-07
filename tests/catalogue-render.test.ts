import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import type { CatalogueSnapshot, CatalogueTripCard, RenderedCatalogue } from "../src/lib/catalogue/types";
import {
  buildCatalogueHtml,
  CatalogueRenderError,
  defaultVersionLabel,
  escapeHtml,
  isRenderBrowserAvailable,
  planPages,
  renderCatalogue,
  type RenderAssets,
} from "../src/lib/catalogue/render";
import { defaultImageFetcher } from "../src/lib/catalogue/render/images";
import { ASPECT, cropImage, cropWindow, encodeProfileFor, loadWork, prepareArt, scrimStrength } from "../src/lib/catalogue/render/art";
import type { TripArt } from "../src/lib/catalogue/render";
import { outlineFor } from "../src/lib/catalogue/render/pdfMeta";
import { assignCompositions, clipHighlight, departureLine, headlineSizePt, orderTrips, priceParts, UNGROUPED_LABEL } from "../src/lib/catalogue/render/layout";
import { emptyArt } from "../src/lib/catalogue/render/renderTypes";
import { LOGO_FILE, loadStaticAssets } from "../src/lib/catalogue/render/assets";
import { displayTitle } from "../src/lib/catalogue/render/titleCase";
import { makeSyntheticPhoto, sampleImageFetcher, sampleSnapshot } from "../src/lib/catalogue/render/fixture";

const ROOT = process.cwd();
const TINY_LOGO = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

function tinyImage() {
  return { dataUri: TINY_LOGO, width: 10, height: 10, sourceCropWidth: 2000, bytes: 1 };
}

function assetsFor(snapshot: CatalogueSnapshot, extra: Partial<RenderAssets> = {}): RenderAssets {
  return { fonts: [], logoDataUri: TINY_LOGO, ...emptyArt(), versionLabel: "v-test", ...extra };
}

function card(over: Partial<CatalogueTripCard> & { n: number }): CatalogueTripCard {
  const base = sampleSnapshot({ trips: 1 }).trips[0]!;
  const code = `A${String(over.n).padStart(2, "0")}`;
  const { n: _n, ...rest } = over;
  return { ...base, tripId: `t-${over.n}`, code, title: `Жишиг аялал ${over.n}`, editorialTitle: rest.title ?? `Жишиг аялал ${over.n}`, ...rest };
}

function snapshotOf(trips: CatalogueTripCard[], groups?: CatalogueSnapshot["groups"]): CatalogueSnapshot {
  const base = sampleSnapshot({ trips: 1 });
  return { ...base, trips, groups: groups ?? [{ key: "g", label: "Жишиг бүлэг", codes: trips.map(t => t.code) }] };
}

// ---------------------------------------------------------------------------------------------
// Browser-free: html builder, plan, images, assets
// ---------------------------------------------------------------------------------------------

test("html builder escapes every dynamic string and refuses unsafe links", () => {
  const evil = `<script>alert(1)</script> & "q" 'x'`;
  const snap = snapshotOf([
    card({
      n: 1,
      title: evil,
      kicker: `<b>${evil}</b>`,
      durationText: evil,
      transportLabel: evil,
      highlights: [evil, `<img src=x onerror=alert(1)>`],
      detailUrl: "javascript:alert(1)",
      dates: { nextDeparture: null, departures: [], label: evil },
      price: { kind: "inquire", display: "Үнэ лавлах" },
      photo: { url: "https://x.test/a.jpg", width: null, height: null, credit: evil, source: "poster_hero" },
    }),
  ]);
  snap.contact = { phones: [evil, "7700 0001"], siteLabel: evil, siteUrl: "javascript:alert(2)" };
  snap.seasonLabel = evil;
  snap.issueLabel = evil;
  const html = buildCatalogueHtml(snap, assetsFor(snap, { versionLabel: evil }));

  assert.ok(!html.includes("<script"), "no raw script tag");
  assert.ok(!html.includes("<img src=x"), "injected markup stays text");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!/href="javascript:/i.test(html), "javascript: links are dropped");
  assert.ok(html.includes("default-src 'none'"), "CSP forbids everything but data: images and fonts");
  assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
});

test("html never references a non-data resource (the browser may only load data: URLs)", () => {
  const snap = sampleSnapshot({ trips: 4 });
  const trips = Object.fromEntries(snap.trips.map(t => [t.tripId, { composition: "plate", hero: tinyImage(), second: null, thumb: tinyImage() } satisfies TripArt]));
  const html = buildCatalogueHtml(snap, assetsFor(snap, { trips }));
  for (const m of html.matchAll(/\bsrc="([^"]*)"/g)) assert.ok(m[1]!.startsWith("data:"), `img src ${m[1]!.slice(0, 40)}`);
  assert.ok(!/url\((?!data:)/i.test(html), "no external url() in css");
  assert.ok(!/<link\b|@import/i.test(html), "no stylesheet links or imports");
});

test("page plan: cover + contents + openers + one page per trip + closing, numbers match the pages printed", () => {
  const snap = sampleSnapshot({ trips: 40, edition: "complete" });
  const plan = planPages(snap);
  assert.ok(plan.contentsPages.length >= 3, "40 trips need several contents pages");
  const openers = plan.chapters.filter(c => c.openerPage != null).length;
  assert.equal(openers, plan.chapters.length, "the complete edition opens every chapter");
  assert.equal(plan.totalPages, 1 + plan.contentsPages.length + openers + 40 + 1);
  const html = buildCatalogueHtml(snap, assetsFor(snap));
  assert.equal((html.match(/<section class="page/g) ?? []).length, plan.totalPages);

  // every trip listed exactly once in the contents, pointing at the page its section carries
  const rows = plan.contentsPages.flat().filter(i => i.kind === "row");
  assert.equal(rows.length, 40);
  for (const item of rows) {
    if (item.kind !== "row") continue;
    const re = new RegExp(`id="trip-${item.trip.card.code}" data-page="${item.trip.page}"`);
    assert.match(html, re, `${item.trip.card.code} page ${item.trip.page}`);
  }
  const pages = plan.trips.map(t => t.page);
  assert.deepEqual(pages, [...pages].sort((a, b) => a - b));
  assert.equal(plan.closingPage, plan.totalPages);
  // each chapter's opener sits directly before its first trip
  for (const c of plan.chapters) assert.equal(c.openerPage! + 1, c.trips[0]!.page);
  // a group split across contents pages is announced again
  assert.ok(plan.contentsPages.slice(1).every(p => p[0]?.kind === "group"), "each continued page starts with its group label");
});

test("book order follows the groups; trips no group lists are kept, never dropped", () => {
  const a = card({ n: 1 });
  const b = card({ n: 2 });
  const c = card({ n: 3 });
  const snap = snapshotOf([a, b, c], [
    { key: "x", label: "Эхний", codes: [c.code] },
    { key: "y", label: "Хоёр дахь", codes: [a.code, "Z99"] },
  ]);
  const ordered = orderTrips(snap);
  assert.deepEqual(ordered.map(o => o.card.code), ["A03", "A01", "A02"]);
  assert.equal(ordered[2]!.groupLabel, UNGROUPED_LABEL);
});

test("chapter openers: quick books open chapters of two or more trips; one-trip chapters and one-chapter books do not", () => {
  const quick = sampleSnapshot({ trips: 8, edition: "quick" });
  const plan = planPages(quick);
  assert.equal(plan.hasOpeners, true);
  for (const c of plan.chapters) assert.equal(c.openerPage != null, c.trips.length >= 2, c.label);
  const lone = bookOf(4, { groups: 1 });
  assert.equal(planPages({ ...lone, edition: "quick" }).hasOpeners, false);
  assert.equal(planPages({ ...lone, edition: "complete" }).hasOpeners, true);
});

test("compositions: deterministic rhythm, never the same twice in a row when another fits, type page without a photo", () => {
  const all = { hasHero: true, cinema: true, plate: true, panorama: true, diptych: true };
  const run = assignCompositions(Array.from({ length: 8 }, () => all));
  assert.deepEqual(run, ["cinema", "plate", "panorama", "diptych", "cinema", "plate", "panorama", "diptych"]);
  assert.deepEqual(assignCompositions(Array.from({ length: 8 }, () => all)), run, "deterministic");
  const plateOnly = { hasHero: true, cinema: false, plate: true, panorama: false, diptych: false };
  assert.deepEqual(assignCompositions([plateOnly, plateOnly]), ["plate", "plate"], "falls back rather than inventing a fit");
  const mixed = assignCompositions([all, { ...all, hasHero: false }, { ...plateOnly, panorama: true }]);
  assert.equal(mixed[1], "type");
  assert.notEqual(mixed[2], "type");
  for (let i = 1; i < run.length; i++) assert.notEqual(run[i], run[i - 1]);
});

test("date line: first three departures as month.day, year only where it changes, '+ N' for the rest; facts are never invented", () => {
  const base = sampleSnapshot({ trips: 1 }).trips[0]!;
  const withDays = (departures: string[], label = "") => ({ ...base, dates: { nextDeparture: departures[0] ?? null, departures, label } });
  const a = departureLine(withDays(["2026-11-14", "2026-11-28", "2026-12-12", "2027-01-09"]), "2026-11-06");
  assert.deepEqual(a.dates, ["11.14", "11.28", "12.12"]);
  assert.equal(a.more, 1);
  const b = departureLine(withDays(["2027-01-09", "2027-01-23"]), "2026-11-06");
  assert.deepEqual(b.dates, ["2027.01.09", "01.23"]);
  assert.equal(b.more, 0);
  const c = departureLine(withDays(["2026-11-14", "2026-11-21", "2026-11-28"], "Ойрын огноо: 2026.11.14, 2026.11.21, 2026.11.28 болон өөр 9 огноо"), "2026-11-06");
  assert.equal(c.more, 9, "the data layer's count beyond the list is kept");
  const none = departureLine(withDays([], "Явах огноог лавлана"), "2026-11-06");
  assert.deepEqual(none.dates, []);
  assert.equal(none.plain, "Явах огноог лавлана");
});

test("copy shaping: highlights are clipped at a natural break, never paraphrased; price splits at the tugrik sign", () => {
  assert.equal(clipHighlight("Богино онцлог"), "Богино онцлог");
  const long = "Эхний хэсэг нь энд байна, хоёр дахь хэсэг нь үүнийг үргэлжлүүлж, гурав дахь хэсэг нь маш урт мөр болгоно";
  const clipped = clipHighlight(long, 60);
  assert.ok(long.startsWith(clipped.split(",")[0]!), clipped);
  assert.ok(clipped.length <= 60, clipped);
  const noBreak = "Нэг ч зогсоолгүй маш урт үгсийн дараалал тасралтгүй үргэлжилсээр байх мөр тул хэвээр үлдэнэ";
  assert.equal(clipHighlight(noBreak), noBreak);
  assert.deepEqual(priceParts("3,980,000₮-с"), { amount: "3,980,000₮", suffix: "-с" });
  assert.deepEqual(priceParts("Үнэ лавлах"), { amount: "Үнэ лавлах", suffix: "" });
});

test("copy limits: at most 3 highlights and 3 phones; price/date/group-note/disclaimer wording is present", () => {
  const snap = snapshotOf([card({ n: 1, highlights: ["a1 нэг", "b2 хоёр", "c3 гурав", "d4 дөрөв", "e5 тав"] })]);
  snap.contact = { phones: ["1111 1111", "2222 2222", "3333 3333", "4444 4444"], siteLabel: "example.test", siteUrl: "https://example.test" };
  const html = buildCatalogueHtml(snap, assetsFor(snap));
  assert.ok(html.includes("a1 нэг") && html.includes("b2 хоёр") && html.includes("c3 гурав"));
  assert.ok(!html.includes("d4") && !html.includes("e5"));
  assert.ok(html.includes("1111 1111") && html.includes("3333 3333") && !html.includes("4444 4444"));
  for (const phrase of [
    "Эхлэх үнэ / нэг том хүн",
    "Бүлгийн үнийг ажилтнаас лавлана",
    "Эцсийн үнэ, суудал, огноо, нөхцөлийг ажилтан баталгаажуулна",
    "ХАМТ ОЛНЫ",
    "АЯЛЛЫН СОНГОЛТ",
    "25 хүн, 1-р сар",
    "Ойрын огноо",
  ]) {
    assert.ok(html.toLowerCase().includes(phrase.toLowerCase()), phrase);
  }
});

test("a trip without a usable photo gets the typographic page: no picture, fully described, credit never printed", () => {
  const withPhoto = card({ n: 1 });
  const noPhoto = card({ n: 2, photo: null });
  const snap = snapshotOf([withPhoto, noPhoto]);
  const trips: Record<string, TripArt> = { [withPhoto.tripId]: { composition: "plate", hero: tinyImage(), second: null, thumb: tinyImage() } };
  const html = buildCatalogueHtml(snap, assetsFor(snap, { trips }));
  const section = (code: string) => html.slice(html.indexOf(`id="trip-${code}"`), html.indexOf("</section>", html.indexOf(`id="trip-${code}"`)));
  assert.ok(section("A02").includes('data-composition="type"') && !section("A02").includes("<img"));
  assert.ok(section("A01").includes('data-composition="plate"') && section("A01").includes("<img"));
  assert.ok(section("A02").includes("Жишиг аялал 2"));
  // a credit only goes with a photo that is actually printed
  const credited = card({ n: 3, photo: { url: "https://x.test/p.jpg", width: null, height: null, credit: "Жишиг зураглаач", source: "poster_hero" } });
  const s2 = snapshotOf([credited]);
  assert.ok(!buildCatalogueHtml(s2, assetsFor(s2)).includes("Жишиг зураглаач"));
  const printed: Record<string, TripArt> = { [credited.tripId]: { composition: "cinema", hero: tinyImage(), second: null, thumb: null } };
  assert.ok(buildCatalogueHtml(s2, assetsFor(s2, { trips: printed })).includes("Жишиг зураглаач"));
});

test("every composition renders its own structure and the same facts", () => {
  const snap = snapshotOf([card({ n: 1 }), card({ n: 2 }), card({ n: 3 }), card({ n: 4 })]);
  const kinds = ["cinema", "plate", "panorama", "diptych"] as const;
  const trips: Record<string, TripArt> = {};
  snap.trips.forEach((t, i) => { trips[t.tripId] = { composition: kinds[i]!, hero: tinyImage(), second: kinds[i] === "diptych" ? tinyImage() : null, thumb: tinyImage() }; });
  const html = buildCatalogueHtml(snap, assetsFor(snap, { trips }));
  for (const [i, kind] of kinds.entries()) {
    const code = `A0${i + 1}`;
    const section = html.slice(html.indexOf(`id="trip-${code}"`), html.indexOf("</section>", html.indexOf(`id="trip-${code}"`)));
    assert.ok(section.includes(`data-composition="${kind}"`), kind);
    assert.ok(section.includes("3,740,000₮") && section.includes("Эхлэх үнэ / нэг том хүн") && section.includes('href="#contents"'), `${kind}: facts + link back`);
    assert.ok(section.includes(`>${code}<`), `${kind}: code`);
  }
  assert.ok(html.includes('class="inset"'), "diptych inset");
  assert.ok(html.includes('class="bg"'), "cinema background");
});

test("an empty edition still renders a valid plan (cover, contents notice, closing)", () => {
  const snap = snapshotOf([], []);
  const plan = planPages(snap);
  assert.equal(plan.totalPages, 3);
  const html = buildCatalogueHtml(snap, assetsFor(snap));
  assert.ok(html.includes("Одоогоор санал болгох аялал алга"));
});
test("headline size only ever shrinks as titles get longer and never reaches microtype", () => {
  let previous = Infinity;
  for (const n of [1, 10, 16, 17, 26, 27, 38, 39, 54, 55, 80, 81, 200]) {
    const size = headlineSizePt("я".repeat(n));
    assert.ok(size <= previous, `${n} chars`);
    assert.ok(size >= 20, "never below 20pt");
    previous = size;
  }
});

test("outline: cover, contents, grouped 'code · title' bookmarks, quotation page", () => {
  const snap = sampleSnapshot({ trips: 6 });
  const plan = planPages(snap);
  const outline = outlineFor(plan);
  assert.deepEqual(outline.slice(0, 2).map(o => [o.title, o.page]), [["Нүүр", 1], ["Агуулга", 2]]);
  assert.equal(outline.at(-1)!.page, plan.closingPage);
  const kids = outline.flatMap(o => o.children);
  assert.equal(kids.length, 6);
  assert.ok(kids.some(k => k.title === "A01 · Тест-Далай"));
});

test("the logo embedded is the repo's original file, byte for byte", async () => {
  const assets = await loadStaticAssets();
  const original = readFileSync(path.join(ROOT, LOGO_FILE));
  assert.ok(assets.logoBytes.equals(original));
  const embedded = Buffer.from(assets.logoDataUri.replace(/^data:image\/jpeg;base64,/, ""), "base64");
  assert.ok(embedded.equals(original));
  const snap = sampleSnapshot({ trips: 2 });
  assert.ok(buildCatalogueHtml(snap, assetsFor(snap, { logoDataUri: assets.logoDataUri })).includes(assets.logoDataUri));
});

test("bundled fonts cover Cyrillic incl. Ө ө Ү ү and the tugrik sign ₮", async () => {
  const assets = await loadStaticAssets();
  assert.ok(assets.fonts.length >= 4);
  for (const f of assets.fonts) {
    const bytes = Buffer.from(f.dataUri.replace(/^data:font\/ttf;base64,/, ""), "base64");
    const covered = cmapCodepoints(bytes);
    for (const ch of "ӨөҮү₮ЁёЙй") assert.ok(covered.has(ch.codePointAt(0)!), `${f.family} ${f.weight} lacks ${ch}`);
  }
});

function squash(text: string): string {
  return text.replace(/\s+/g, "");
}

function cmapCodepoints(b: Buffer): Set<number> {
  const set = new Set<number>();
  const tables = b.readUInt16BE(4);
  let cmap = 0;
  for (let i = 0; i < tables; i++) {
    const o = 12 + i * 16;
    if (b.toString("ascii", o, o + 4) === "cmap") cmap = b.readUInt32BE(o + 8);
  }
  const n = b.readUInt16BE(cmap + 2);
  for (let i = 0; i < n; i++) {
    const sub = cmap + b.readUInt32BE(cmap + 8 + i * 8);
    const format = b.readUInt16BE(sub);
    if (format === 4) {
      const segs = b.readUInt16BE(sub + 6) / 2;
      const endO = sub + 14;
      const startO = endO + segs * 2 + 2;
      for (let s = 0; s < segs; s++) {
        const end = b.readUInt16BE(endO + s * 2);
        const start = b.readUInt16BE(startO + s * 2);
        for (let c = start; c <= end && c < 0xffff; c++) set.add(c);
      }
    } else if (format === 12) {
      const groups = b.readUInt32BE(sub + 12);
      for (let g = 0; g < groups; g++) {
        const start = b.readUInt32BE(sub + 16 + g * 12);
        const end = b.readUInt32BE(sub + 20 + g * 12);
        for (let c = start; c <= end; c++) set.add(c);
      }
    }
  }
  return set;
}

test("crop windows follow the focal point and zoom, stay inside the source, and never change the aspect", () => {
  const centre = cropWindow(2000, 1000, ASPECT.plate);
  assert.equal(centre.width, 1000);
  assert.equal(centre.height, 1000);
  assert.equal(centre.left, 500);
  const left = cropWindow(2000, 1000, ASPECT.plate, { x: 0.1, y: 0.5 });
  assert.equal(left.left, 0, "clamped to the left edge");
  const zoomed = cropWindow(2000, 1000, ASPECT.plate, { x: 0.9, y: 0.5 }, 2);
  assert.equal(zoomed.width, 500);
  assert.equal(zoomed.left + zoomed.width, 2000, "clamped to the right edge");
  for (const w of [centre, left, zoomed]) assert.ok(Math.abs(w.height / w.width - ASPECT.plate) < 0.01);
});

test("cropImage: exact aspect, resampled, never upscaled, progressive JPEG; loadWork rejects junk", async () => {
  const work = (await loadWork(await makeSyntheticPhoto(1, 2400, 1200)))!;
  const a = (await cropImage(work, { aspect: ASPECT.plate, outWidth: 1040, quality: 80 }))!;
  assert.ok(a.width <= 1040 && a.width >= 1000, `width ${a.width}`);
  assert.ok(Math.abs(a.height / a.width - ASPECT.plate) < 0.01);
  assert.ok(a.bytes < 600_000, `bytes ${a.bytes}`);
  const jpeg = Buffer.from(a.dataUri.replace(/^data:image\/jpeg;base64,/, ""), "base64");
  assert.deepEqual([jpeg[0], jpeg[1]], [0xff, 0xd8]);
  const meta = await sharp(jpeg).metadata();
  assert.equal(meta.width, a.width);
  assert.equal(meta.isProgressive, true);

  const narrow = (await loadWork(await makeSyntheticPhoto(2, 900, 1800)))!;
  const p = (await cropImage(narrow, { aspect: ASPECT.plate, outWidth: 1040, quality: 80 }))!;
  assert.equal(p.width, 900, "narrow source is not upscaled");

  const small = (await loadWork(await makeSyntheticPhoto(3, 500, 400)))!;
  const sm = (await cropImage(small, { aspect: ASPECT.plate, outWidth: 1040, quality: 80 }))!;
  assert.ok(sm.width <= 400 && sm.sourceCropWidth <= 400);

  assert.equal(await loadWork(Buffer.from("not an image")), null);
  assert.equal(await loadWork(await makeSyntheticPhoto(4, 40, 40)), null);
});

test("a baked scrim darkens the lower part of the photo and leaves the top alone; brighter photos get a stronger scrim", async () => {
  const bright = await sharp({ create: { width: 1200, height: 1800, channels: 3, background: "#E8E8E0" } }).jpeg({ quality: 90 }).toBuffer();
  const work = (await loadWork(bright))!;
  const plain = (await cropImage(work, { aspect: ASPECT.page, outWidth: 600, quality: 80 }))!;
  const scrimmed = (await cropImage(work, { aspect: ASPECT.page, outWidth: 600, quality: 80, scrim: { from: 0.42 } }))!;
  const mean = async (img: { dataUri: string }, top: number) => {
    const buf = Buffer.from(img.dataUri.replace(/^data:image\/jpeg;base64,/, ""), "base64");
    const m = await sharp(buf).metadata();
    const { data } = await sharp(buf).extract({ left: 0, top: Math.round((m.height ?? 0) * top), width: m.width ?? 1, height: Math.round((m.height ?? 0) * 0.1) }).greyscale().raw().toBuffer({ resolveWithObject: true });
    return data.reduce((x, y) => x + y, 0) / data.length;
  };
  assert.ok(Math.abs((await mean(plain, 0.02)) - (await mean(scrimmed, 0.02))) < 6, "top untouched");
  assert.ok((await mean(scrimmed, 0.88)) < (await mean(plain, 0.88)) - 70, "bottom darkened");
  assert.ok(scrimStrength(0.9) > scrimStrength(0.1));
  assert.ok(scrimStrength(0) >= 0.5 && scrimStrength(1) <= 0.9);
});

test("big editions get a smaller encode profile", () => {
  assert.ok(encodeProfileFor(40).width < encodeProfileFor(20).width);
  assert.ok(encodeProfileFor(20).width < encodeProfileFor(8).width);
});

test("art pipeline: weak, missing and failed photos become typographic pages plus warnings, not errors; one fetch per URL", async () => {
  const snap = sampleSnapshot({ trips: 8, edition: "quick" });
  const seen: string[] = [];
  const base = sampleImageFetcher();
  const art = await prepareArt(snap, planPages(snap), async url => {
    seen.push(url);
    if (url.includes("/ok/3.jpg")) throw new Error("network down");
    return base(url);
  });
  assert.equal(new Set(seen).size, seen.length, "no URL fetched twice");
  const byCode = (code: string) => art.warnings.filter(w => w.message.startsWith(code));
  assert.ok(byCode("A04").some(w => w.code === "photo_low_resolution"), "flagged weak");
  assert.ok(byCode("A05").some(w => w.code === "photo_missing"));
  assert.ok(byCode("A06").some(w => w.code === "photo_fetch_failed"), "fetcher returned null");
  assert.ok(byCode("A03").some(w => w.code === "photo_fetch_failed"), "fetcher threw");
  for (const id of ["fx-trip-3", "fx-trip-4", "fx-trip-5", "fx-trip-6"]) assert.equal(art.trips[id]!.composition, "type", id);
  for (const id of ["fx-trip-1", "fx-trip-2", "fx-trip-7", "fx-trip-8"]) {
    const t = art.trips[id]!;
    assert.ok(t.hero && t.thumb && t.composition !== "type", id);
    assert.ok(Math.abs(t.thumb!.height / t.thumb!.width - 1) < 0.01, "square thumbnail");
  }
  assert.ok(art.warnings.every(w => w.severity === "warning" && w.tripId));
  const bookOrder = orderTrips(snap).map(o => o.card.tripId);
  const got = art.warnings.map(w => w.tripId!);
  assert.deepEqual(got, [...got].sort((a, b) => bookOrder.indexOf(a) - bookOrder.indexOf(b)), "warnings come in book order");
  assert.ok(art.cover && art.cover.tripId === snap.coverTripId, "the cover is the data layer's pick when it prints well");
  assert.ok(art.closing);
  const compositions = new Set(Object.values(art.trips).filter(t => t.composition !== "type").map(t => t.composition));
  assert.ok(compositions.size >= 3, `at least three compositions, got ${[...compositions].join(",")}`);
  assert.ok(Object.values(art.trips).some(t => t.composition === "diptych" && t.second), "a diptych carries its second photo");
});

test("default fetcher refuses non-https, private and credentialed URLs without touching the network", async () => {
  for (const url of ["http://images.example.com/a.jpg", "https://127.0.0.1/a.jpg", "https://localhost/a.jpg", "https://192.168.0.4/a.jpg", "https://u:p@images.example.com/a.jpg", "file:///etc/passwd", "not a url",
    // Spellings a plain string deny-list let through (full matrix in catalogue-image-policy.test.ts).
    "https://[::1]/a.jpg", "https://[fd00::1]/a.jpg", "https://[::ffff:127.0.0.1]/a.jpg", "https://0.0.0.0/a.jpg", "https://localhost./a.jpg", "https://100.64.0.1/a.jpg", "https://printer.local/a.jpg"]) {
    assert.equal(await defaultImageFetcher(url), null, url);
  }
});

test("invalid snapshots are rejected with a typed error before any browser work", async () => {
  await assert.rejects(() => renderCatalogue({} as CatalogueSnapshot), (e: unknown) => e instanceof CatalogueRenderError && e.code === "invalid_snapshot");
  assert.equal(defaultVersionLabel(sampleSnapshot({ trips: 1 })), "preview 01234567");
});

// ---------------------------------------------------------------------------------------------
// Browser-backed: one real render shared by every assertion below
// ---------------------------------------------------------------------------------------------

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type TextItem = { str: string; transform: number[]; width: number; height: number };

const LONG_TITLE = "Туршилт-Уртхан нэртэй, гарчиг нь хэт урт байсан ч хуудаснаас хэзээ ч халихгүй, таслагдахгүй байх ёстой Ө Ү ₮ тэмдэгт бүхий туршилтын маш урт аяллын нэр дахин нэг хоёр гурван үг";

describe("browser render", () => {
  let snapshot: CatalogueSnapshot;
  let rendered: RenderedCatalogue | null = null;
  let skipReason: string | null = null;
  let pdfjs: Pdfjs;
  let doc: Awaited<ReturnType<Pdfjs["getDocument"]>["promise"]>;
  const pageText: string[] = [];
  const pageItems: TextItem[][] = [];

  before(async () => {
    snapshot = sampleSnapshot({ trips: 8, edition: "quick" });
    // one extreme title, in its own group, to prove "never clip"
    const long = { ...snapshot.trips[0]!, tripId: "fx-long", code: "A09", title: LONG_TITLE, editorialTitle: LONG_TITLE, kicker: "Урт жишиг муж / Урт жишиг улс" };
    snapshot = { ...snapshot, trips: [...snapshot.trips, long], groups: [...snapshot.groups, { key: "long", label: "Урт нэрийн туршилт", codes: ["A09"] }] };
    try {
      rendered = await renderCatalogue(snapshot, { pageImages: true, imageFetcher: sampleImageFetcher(), versionLabel: "v-test-1" });
    } catch (error) {
      if (error instanceof CatalogueRenderError && error.code === "browser_unavailable") {
        skipReason = `no headless browser here (${error.message})`;
        return;
      }
      throw error;
    }
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    doc = await pdfjs.getDocument({ data: new Uint8Array(rendered.pdf), verbosity: 0 }).promise;
    for (let i = 1; i <= doc.numPages; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      const items = content.items.filter(it => "str" in it && typeof it.str === "string") as unknown as TextItem[];
      pageItems.push(items);
      pageText.push(items.map(it => it.str).join(" ").replace(/\s+/g, " "));
    }
  }, { timeout: 280_000 });

  after(() => {
    rendered = null;
  });

  const need = (t: { skip: (reason?: string) => void }) => {
    if (!rendered) {
      t.skip(skipReason ?? "render did not run");
      return null;
    }
    return rendered;
  };

  test("isRenderBrowserAvailable agrees with what the render found", async t => {
    const available = await isRenderBrowserAvailable();
    assert.equal(typeof available, "boolean");
    if (!rendered) return t.skip(skipReason ?? "no browser");
    assert.equal(available, true);
  });

  test("one portrait PDF, every page 540 x 960 pt, page count matches the plan", async t => {
    const r = need(t);
    if (!r) return;
    assert.equal(r.pdf.subarray(0, 5).toString("latin1"), "%PDF-");
    const plan = planPages(snapshot);
    assert.equal(r.pageCount, plan.totalPages);
    assert.deepEqual(r.pageSize, { width: 540, height: 960 });
    const pdf = await PDFDocument.load(r.pdf);
    assert.equal(pdf.getPageCount(), plan.totalPages);
    for (const page of pdf.getPages()) {
      const { width, height } = page.getSize();
      assert.ok(Math.abs(width - 540) < 0.5 && Math.abs(height - 960) < 0.5, `${width}x${height}`);
    }
  });

  test("Noto fonts are embedded and no fallback face leaked in", async t => {
    const r = need(t);
    if (!r) return;
    for (const name of ["NotoSans-Regular", "NotoSans-Medium", "NotoSerif-Light", "NotoSerif-Regular"]) assert.ok(r.fonts.includes(name), `${name} in ${r.fonts.join(",")}`);
    assert.ok(!r.fonts.some(f => /helvetica|arial|times|dejavu|liberation/i.test(f)), r.fonts.join(","));
  });

  test("text is selectable and searchable: Ө Ү ₮, prices, codes, copy", async t => {
    const r = need(t);
    if (!r) return;
    const all = pageText.join(" ");
    assert.ok(all.includes("Ө") && all.includes("Ү") && all.includes("₮"), "Ө Ү ₮ survive extraction");
    assert.ok(pageText[0]!.includes("ХАМТ ОЛНЫ") && pageText[0]!.includes("СОНГОЛТ"), "cover title");
    const plan = planPages(snapshot);
    const a01 = plan.trips.find(x => x.card.code === "A01")!;
    assert.ok(squash(pageText[a01.page - 1]!).includes("3,740,000₮-с"), "price string on A01's page");
    assert.ok(squash(pageText[a01.page - 1]!).includes("Тест-Далай") && squash(pageText[a01.page - 1]!).includes("A01"));
    const inquire = plan.trips.find(x => x.card.price.kind === "inquire")!;
    assert.ok(pageText[inquire.page - 1]!.includes("Үнэ лавлах"));
    const last = pageText.at(-1)!;
    assert.ok(last.includes("Эцсийн үнэ, суудал, огноо, нөхцөлийг ажилтан баталгаажуулна"));
    assert.ok(last.includes("7700 0001") && last.includes("9900 0002") && last.includes("v-test-1"), "contact + version stamp on closing page");
    assert.ok(squash(pageText[1]!).includes("A01") && squash(pageText[1]!).includes("3,740,000₮-с"), "contents lists code and price");
  });

  test("no text outside the page margins and no microtype", async t => {
    const r = need(t);
    if (!r) return;
    let smallest = Infinity;
    pageItems.forEach((items, i) => {
      for (const it of items) {
        if (!it.str.trim()) continue;
        const x = it.transform[4]!;
        const y = it.transform[5]!;
        const size = Math.hypot(it.transform[0]!, it.transform[1]!);
        smallest = Math.min(smallest, size);
        assert.ok(x >= 30, `p${i + 1} "${it.str.slice(0, 24)}" starts at x=${x.toFixed(1)}`);
        assert.ok(x + it.width <= 540 - 30, `p${i + 1} "${it.str.slice(0, 24)}" ends at x=${(x + it.width).toFixed(1)}`);
        assert.ok(y >= 12 && y + size <= 960 - 12, `p${i + 1} "${it.str.slice(0, 24)}" y=${y.toFixed(1)}`);
      }
    });
    assert.ok(smallest >= 8, `smallest glyph run ${smallest.toFixed(1)}pt`);
  });

  test("long title shrinks and wraps: nothing clipped, no overflow warning", async t => {
    const r = need(t);
    if (!r) return;
    const page = planPages(snapshot).trips.find(x => x.card.code === "A09")!.page;
    const text = pageText[page - 1]!;
    for (const word of LONG_TITLE.split(" ")) assert.ok(text.includes(word), `"${word}" missing from the long-title page`);
    assert.deepEqual(r.warnings.filter(w => w.code === "other"), [], JSON.stringify(r.warnings.filter(w => w.code === "other")));
    // the headline run sits at the length tier (22pt) or shrinks to the floor (20pt), never microtype
    const run = pageItems[page - 1]!.find(it => it.str.includes("Туршилт-Уртхан"));
    assert.ok(run, "headline run found");
    const size = Math.hypot(run!.transform[0]!, run!.transform[1]!);
    assert.ok(size <= 22.1 && size >= 19.9, `headline ${size.toFixed(1)}pt`);
  });

  test("missing / failed / low-resolution photos: placeholder pages plus warnings", async t => {
    const r = need(t);
    if (!r) return;
    const codes = new Set(r.warnings.map(w => `${w.code}:${w.tripId}`));
    assert.ok(codes.has("photo_missing:fx-trip-5"));
    assert.ok(codes.has("photo_fetch_failed:fx-trip-6"));
    assert.ok(codes.has("photo_low_resolution:fx-trip-4"));
    const placeholderPage = planPages(snapshot).trips.find(x => x.card.code === "A05")!.page;
    assert.ok(pageText[placeholderPage - 1]!.includes("Хөдөө-Хуурай"), "the trip is still fully described");
  });

  test("document info: title, author, creation date, version label, language", async t => {
    const r = need(t);
    if (!r) return;
    const meta = await doc.getMetadata();
    const info = meta.info as Record<string, string>;
    assert.match(info.Title!, /ХАМТ ОЛНЫ АЯЛЛЫН СОНГОЛТ/);
    assert.equal(info.Author, "UUDAM Travel");
    assert.match(info.Subject!, /v-test-1/);
    assert.equal(info.CreationDate, "D:20261106060300Z");
    assert.equal(info.Language, "mn-MN");
  });

  test("bookmarks and linked contents work offline", async t => {
    const r = need(t);
    if (!r) return;
    const outline = (await doc.getOutline()) ?? [];
    const titles = outline.flatMap(o => [o.title, ...(o.items ?? []).map(i => i.title)]);
    assert.ok(titles.includes("Агуулга") && titles.includes("A01 · Тест-Далай") && titles.includes("Үнийн санал авах"), titles.join(" | "));
    // contents rows are internal GoTo links (no network): the A01 row lands on A01's page
    const links = (await (await doc.getPage(2)).getAnnotations()).filter(a => a.subtype === "Link" && typeof a.dest === "string");
    assert.ok(links.length >= 4);
    const dest = await doc.getDestination("trip-A01");
    assert.ok(dest, "named destination exists");
    const pageIndex = await doc.getPageIndex(dest![0] as { num: number; gen: number });
    assert.equal(pageIndex + 1, planPages(snapshot).trips.find(x => x.card.code === "A01")!.page);
  });

  test("size budget: the quick book stays under 6 MB", async t => {
    const r = need(t);
    if (!r) return;
    assert.ok(r.pdf.length < 6 * 1024 * 1024, `${r.pdf.length} bytes`);
    assert.ok(r.renderMs > 0);
  });

  test("page thumbnails: one JPEG per page at phone size", async t => {
    const r = need(t);
    if (!r) return;
    assert.equal(r.pageImages.length, r.pageCount);
    for (const img of r.pageImages) {
      assert.deepEqual([img[0], img[1]], [0xff, 0xd8]);
      const meta = await sharp(img).metadata();
      assert.equal(meta.width, 810);
      assert.equal(meta.height, 1440);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Polish: display casing of titles, contents pagination (browser-free)
// ---------------------------------------------------------------------------------------------

test("displayTitle: ALL-CAPS gets per-word Title Case with connectors, numbers, suffixes and acronyms handled", () => {
  const cases: [string, string][] = [
    ["ТЕСТ-ӨВӨРИЙН АЯЛАЛ — ҮЗЭМЖИТ ЁЗООР", "Тест-Өвөрийн Аялал — Үзэмжит Ёзоор"],
    ["ЖИШИГ БА ТУРШИЛТ ЭСВЭЛ ЗАГВАР БУЮУ ТЭСТ", "Жишиг ба Туршилт эсвэл Загвар буюу Тэст"],
    ["УБ-ТЕСТ ХОТЫН 12-Р САРЫН АЯЛАЛ", "УБ-Тест Хотын 12-р сарын Аялал"],
    ["ТЕСТ ХОТ 8 ШӨНӨ 9 ӨДӨР (ЖИШИГ)", "Тест Хот 8 шөнө 9 өдөр (Жишиг)"],
    ["ХХК-ИЙН ЖИШИГ ХОТ-ООС ТЕСТ", "ХХК-ийн Жишиг Хот-оос Тест"],
    ["UB-TEST TRIP № 5, ₮ 1,2,3-Р САР", "UB-Test Trip № 5, ₮ 1,2,3-р сар"],
    ["ЭЭ-ЖИШИГ", "ЭЭ-Жишиг"],
  ];
  for (const [input, expected] of cases) assert.equal(displayTitle(input), expected, input);
});

test("displayTitle: all-lowercase gets a capital first letter only; mixed case stays, apart from caps-lock slips and a lowercase start", () => {
  assert.equal(displayTitle("тест-хотын аялал — өвөр"), "Тест-хотын аялал — өвөр");
  assert.equal(displayTitle("өвөр жишиг"), "Өвөр жишиг");
  assert.equal(displayTitle("Тест-Далай"), "Тест-Далай");
  assert.equal(displayTitle("Жишиг ХОТ аялал (УБ)"), "Жишиг ХОТ аялал (УБ)", "2-3 letter capitals are acronyms");
  assert.equal(displayTitle("ТЕСТЭЭР шууд нислэгтэй аялал"), "Тестээр шууд нислэгтэй аялал");
  assert.equal(displayTitle("тест-жишиг нислэгтэй - Мягмар гариг"), "Тест-жишиг нислэгтэй - Мягмар гариг");
  assert.equal(displayTitle("5 өдрийн аялал"), "5 өдрийн аялал", "nothing is capitalised after a leading digit");
  assert.equal(displayTitle("  Ө  "), "Ө", "a lone capital is not a shouted title");
  assert.equal(displayTitle(""), "");
});

test("displayTitle only changes letter case: same characters, same length, same order", () => {
  for (const input of ["ТЕСТ-ӨВӨРИЙН АЯЛАЛ — ҮЗЭМЖИТ ЁЗООР (8 ШӨНӨ)", "тест өвөр", "Тест ТЕСТЭЭР", "A-B/C, 12-Р"]) {
    const out = displayTitle(input);
    assert.equal(out.length, input.length, input);
    assert.equal(out.toLowerCase(), input.toLowerCase(), input);
  }
});

test("the book prints the display title everywhere a trip title appears, and stored data keeps its casing", () => {
  const shouted = card({ n: 1, title: "ТЕСТ-ӨВӨРИЙН АЯЛАЛ — ҮЗЭМЖИТ ЁЗООР", kicker: "" });
  const quiet = card({ n: 2, title: "тест-хотын аялал", kicker: "" });
  const snap = snapshotOf([shouted, quiet]);
  const html = buildCatalogueHtml(snap, assetsFor(snap));
  assert.equal(shouted.title, "ТЕСТ-ӨВӨРИЙН АЯЛАЛ — ҮЗЭМЖИТ ЁЗООР", "the card is not mutated");
  assert.ok(html.includes('<span class="ttl">Тест-Өвөрийн Аялал — Үзэмжит Ёзоор</span>'), "contents row");
  assert.ok(html.includes('<span class="ttl">Тест-хотын аялал</span>'), "contents row, lowercase source");
  assert.ok(/<h2 class="headline"[^>]*>Тест-Өвөрийн Аялал — Үзэмжит Ёзоор<\/h2>/.test(html), "trip page headline");
  assert.ok(!html.includes("ТЕСТ-ӨВӨРИЙН"), "the shouted form is never printed");
  const kids = outlineFor(planPages(snap)).flatMap(o => o.children).map(k => k.title);
  assert.deepEqual(kids, ["A01 · Тест-Өвөрийн Аялал — Үзэмжит Ёзоор", "A02 · Тест-хотын аялал"], "bookmarks");
});

/** `count` trips in `groups` contiguous groups; `long` titles wrap to two lines in a contents row. */
function bookOf(count: number, opts: { groups?: number; long?: boolean } = {}): CatalogueSnapshot {
  const groupCount = opts.groups ?? 3;
  const trips = Array.from({ length: count }, (_, i) =>
    card({ n: i + 1, title: opts.long ? `Жишиг-Хотын урт нэртэй аялал ${i + 1} — Тест-Далайн эрэг` : `Жишиг аялал ${i + 1}` }));
  const per = Math.ceil(count / groupCount);
  const groups = Array.from({ length: groupCount }, (_, g) => ({
    key: `g${g}`,
    label: `Жишиг бүлэг ${g + 1}`,
    codes: trips.slice(g * per, (g + 1) * per).map(t => t.code),
  })).filter(g => g.codes.length > 0);
  return snapshotOf(trips, groups);
}

const rowsOf = (items: ReturnType<typeof planPages>["contentsPages"][number]) => items.filter(i => i.kind === "row").length;

test("contents: a destination guide of 10 trips in 3 chapters needs at most two airy pages; short lists stay comfortable", () => {
  for (const [count, groups] of [[8, 3], [10, 3], [12, 3]] as const) {
    const plan = planPages(bookOf(count, { groups }));
    assert.ok(plan.contentsPages.length <= 2, `${count} trips / ${groups} groups: ${plan.contentsPages.length} pages`);
  }
  assert.equal(planPages(bookOf(3, { groups: 1 })).contentsPages.length, 1);
  assert.equal(planPages(bookOf(3, { groups: 1 })).contentsDensity, "comfortable", "a short list stays airy");
});

test("contents: when a break is unavoidable the pages are balanced, never one orphan row or a header on its own", () => {
  for (const long of [false, true]) {
    for (let count = 1; count <= 60; count++) {
      const plan = planPages(bookOf(count, { groups: count > 30 ? 5 : 3, long }));
      const pages = plan.contentsPages;
      const label = `${count} trips${long ? " (long titles)" : ""}`;
      const sizes = pages.map(rowsOf);
      assert.equal(sizes.reduce((a, b) => a + b, 0), count, `${label}: every trip listed once`);
      for (const [i, items] of pages.entries()) {
        assert.equal(items[0]?.kind, "group", `${label}: page ${i + 1} starts with a group label`);
        assert.equal(items.at(-1)?.kind, "row", `${label}: page ${i + 1} does not end on a header`);
      }
      if (pages.length > 1) {
        assert.ok(Math.min(...sizes) >= 3, `${label}: no orphan page (${sizes.join("/")})`);
        assert.ok(Math.min(...sizes) >= Math.max(...sizes) * 0.55, `${label}: balanced (${sizes.join("/")})`);
      }
      // numbers: trips follow the contents pages in order, and every row points at its own page
      assert.equal(plan.firstTripPage, 2 + pages.length);
      assert.ok(plan.trips[0]!.page >= plan.firstTripPage);
      plan.trips.forEach((t, i) => i > 0 && assert.ok(t.page > plan.trips[i - 1]!.page));
      for (const item of pages.flat()) if (item.kind === "row") assert.equal(item.trip.page, plan.trips.find(t => t.card.code === item.trip.card.code)!.page);
      assert.equal(plan.closingPage, plan.trips.at(-1)!.page + 1);
    }
  }
});

test("contents: the density class reaches the HTML and the printed page numbers match the plan", () => {
  const snap = bookOf(12, { groups: 4 });
  const plan = planPages(snap);
  const html = buildCatalogueHtml(snap, assetsFor(snap));
  assert.ok(html.includes(`class="clist dens-${plan.contentsDensity}"`));
  assert.equal((html.match(/<section class="page contents"/g) ?? []).length, plan.contentsPages.length);
  for (const t of plan.trips) assert.ok(html.includes(`href="#trip-${t.card.code}"`) && html.includes(`<span class="pg">${String(t.page).padStart(2, "0")}</span>`), t.card.code);
});
