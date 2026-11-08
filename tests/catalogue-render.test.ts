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
import { ASPECT, coverModeFor, cropImage, cropWindow, encodeProfileFor, loadWork, prepareArt, scrimStrength } from "../src/lib/catalogue/render/art";
import type { TripArt } from "../src/lib/catalogue/render";
import { outlineFor } from "../src/lib/catalogue/render/pdfMeta";
import { auditNavigation, expectedDestinations, readPdfNavigation, type PdfNavigation } from "../src/lib/catalogue/render/pdfNav";
import { COVER_INVITE, corporateNotesOf } from "../src/lib/catalogue/render/pages";
import { assignCompositions, clipHighlight, compareCodes, headlineSizePt, orderTrips, planGuide, priceParts, scheduleBlockId, UNGROUPED_LABEL } from "../src/lib/catalogue/render/layout";
import { fullDate, groupDatesByMonth, tripDates } from "../src/lib/catalogue/render/dates";
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

test("page plan: cover + guide + openers + one page per trip + schedule + index + closing, numbers match the pages printed", () => {
  const snap = sampleSnapshot({ trips: 40, edition: "complete" });
  const plan = planPages(snap);
  assert.equal(plan.guidePages.length, 1, "the chapter guide is ONE page for a book of this size");
  const openers = plan.chapters.filter(c => c.openerPage != null).length;
  assert.equal(openers, plan.chapters.length, "the complete edition opens every chapter");
  const scheduleCount = plan.schedulePages.length;
  const indexCount = plan.indexPages.length;
  assert.ok(scheduleCount >= 1 && scheduleCount <= 4, `schedule appendix ${scheduleCount} pages`);
  assert.ok(indexCount >= 1 && indexCount <= 3, `index appendix ${indexCount} pages`);
  assert.equal(plan.totalPages, 1 + plan.guidePages.length + openers + 40 + scheduleCount + indexCount + 1);
  const html = buildCatalogueHtml(snap, assetsFor(snap));
  assert.equal((html.match(/<section class="page/g) ?? []).length, plan.totalPages);

  // order: cover, guide, [opener + trips]..., schedule, index, closing
  assert.equal(plan.firstGuidePage, 2);
  assert.equal(plan.firstTripPage, 2 + plan.guidePages.length);
  assert.equal(plan.firstSchedulePage, plan.trips.at(-1)!.page + 1);
  assert.equal(plan.firstIndexPage, plan.firstSchedulePage! + scheduleCount);
  assert.equal(plan.closingPage, plan.firstIndexPage! + indexCount);
  assert.equal(plan.closingPage, plan.totalPages);

  // every trip is printed exactly once, on the page the plan says, and listed once in the index
  for (const t of plan.trips) {
    assert.match(html, new RegExp(`id="trip-${t.card.code}" data-page="${t.page}"`), `${t.card.code} page ${t.page}`);
  }
  const indexRows = plan.indexPages.flat();
  assert.equal(indexRows.length, 40);
  assert.deepEqual(indexRows.map(r => r.card.code), [...indexRows.map(r => r.card.code)].sort(compareCodes), "index is in code order");
  const pages = plan.trips.map(t => t.page);
  assert.deepEqual(pages, [...pages].sort((a, b) => a - b));
  // each chapter's opener sits directly before its first trip
  for (const c of plan.chapters) assert.equal(c.openerPage! + 1, c.trips[0]!.page);
  // every guide block names real trips of its chapter, with the page they sit on
  for (const e of plan.guidePages.flat()) {
    assert.ok(e.names.length >= 1 && e.names.length <= 6);
    for (const n of e.names) assert.equal(n.page, plan.trips.find(t => t.card.code === n.code)!.page);
    assert.equal(e.count, plan.chapters[e.chapter]!.trips.length);
  }
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

test("groupDatesByMonth: month lines in Mongolian numeric style; the year shows only when it differs from the issue year; days are two digits", () => {
  const lines = groupDatesByMonth(["2026-11-24", "2026-11-10", "2026-11-17", "2027-01-05", "2027-01-12", "2026-11-10"], "2026");
  assert.deepEqual(lines.map(l => l.text), ["11-р сар: 10 · 17 · 24", "2027 оны 1-р сар: 05 · 12"], "sorted, de-duplicated, year only on 2027");
  assert.deepEqual(lines.map(l => l.label), ["11-р сар", "2027 оны 1-р сар"]);
  // the same month number in a later year is its own line with the year, never merged
  const wrap = groupDatesByMonth(["2026-12-05", "2027-12-04", "2028-01-08"], "2026");
  assert.deepEqual(wrap.map(l => l.text), ["12-р сар: 05", "2027 оны 12-р сар: 04", "2028 оны 1-р сар: 08"]);
  // a book issued in 2027 prints 2027 dates without the year
  assert.deepEqual(groupDatesByMonth(["2027-03-06"], "2027").map(l => l.text), ["3-р сар: 06"]);
  assert.deepEqual(groupDatesByMonth([], "2026"), []);
  assert.deepEqual(groupDatesByMonth(["not-a-date", "2026-13-40x", ""], "2026"), [], "junk is dropped, never printed");
  assert.equal(fullDate("2027-01-09"), "2027 оны 1-р сарын 09");
});

test("groupDatesByMonth with fares: one line per month and fare run, the fare after a dash; no fare on a plain schedule", () => {
  const dep = (date: string, adultMnt: number | null) => ({ date, adultMnt });
  const lines = groupDatesByMonth([dep("2026-11-10", 3990000), dep("2026-11-17", 3990000), dep("2026-11-24", 4190000), dep("2026-12-01", 4190000), dep("2027-01-05", null)], "2026", { fares: true });
  assert.deepEqual(lines.map(l => l.text), [
    "11-р сар: 10 · 17 — 3,990,000₮",
    "11-р сар: 24 — 4,190,000₮",
    "12-р сар: 01 — 4,190,000₮",
    "2027 оны 1-р сар: 05 — үнэ лавлах",
  ]);
  assert.deepEqual(groupDatesByMonth([dep("2026-11-10", 3990000), dep("2026-11-17", 4190000)], "2026").map(l => l.text), ["11-р сар: 10 · 17"], "no fares unless asked");
});

test("trip dates: window lines, compact grid beyond 12 dates or 3 months, nearest departure when the window is empty, safe labels; facts are never invented", () => {
  const base = sampleSnapshot({ trips: 1 }).trips[0]!;
  const withDates = (dates: Partial<CatalogueTripCard["dates"]>) => ({ ...base, dates: { nextDeparture: null, departures: [], label: "Явах огноог лавлана", ...dates } });
  const dep = (date: string, adultMnt: number | null = 1000000) => ({ date, adultMnt });
  const asOf = "2026-11-06";
  const few = tripDates(withDates({ departures: ["2026-11-14", "2027-01-09"], schedule: [dep("2026-11-14"), dep("2027-01-09"), dep("2027-03-06")], window: [dep("2026-11-14"), dep("2027-01-09")], label: "Ойрын огноо: 2026.11.14, 2027.01.09" }), asOf);
  assert.equal(few.kind, "lines");
  assert.deepEqual(few.lines.map(l => l.text), ["11-р сар: 14", "2027 оны 1-р сар: 09"]);
  assert.equal(few.scheduleCount, 3);
  assert.equal(few.recurring, null, "a generated date list is not a recurring rule");
  assert.equal(few.hasSchedule, true);

  const weekly = Array.from({ length: 13 }, (_, i) => dep(new Date(Date.UTC(2026, 10, 13 + i * 7)).toISOString().slice(0, 10)));
  const dense = tripDates(withDates({ schedule: weekly, window: weekly, departures: weekly.slice(0, 12).map(d => d.date), nextDeparture: "2026-11-13", label: "Долоо хоног бүрийн баасан гарагт" }), asOf);
  assert.equal(dense.kind, "grid", "more than 12 dates -> compact grid");
  assert.equal(dense.recurring, "Долоо хоног бүрийн баасан гарагт", "the safe label of a recurring trip is kept");
  const fourMonths = [dep("2026-11-20"), dep("2026-12-18"), dep("2027-01-15"), dep("2027-02-02")];
  assert.equal(tripDates(withDates({ schedule: fourMonths, window: fourMonths, departures: fourMonths.map(d => d.date) }), asOf).kind, "grid", "more than 3 month lines -> grid");

  const later = tripDates(withDates({ schedule: [dep("2027-03-06")], window: [], departures: ["2027-03-06"], nextDeparture: "2027-03-06", label: "2027.03.06-ний хөдлөлт" }), asOf);
  assert.equal(later.kind, "next");
  assert.equal(later.nextFull, "2027 оны 3-р сарын 06", "never made to look unavailable");
  const none = tripDates(withDates({}), asOf);
  assert.equal(none.kind, "plain");
  assert.equal(none.plain, "Явах огноог лавлана");
  assert.equal(none.hasSchedule, false);

  // old snapshots without schedule/window: the departures list (<= 12) stands in, filtered to the 90-day window
  const legacy = tripDates(withDates({ departures: ["2026-11-14", "2027-03-06"], nextDeparture: "2026-11-14" }), asOf);
  assert.deepEqual(legacy.lines.map(l => l.text), ["11-р сар: 14"]);
  assert.equal(legacy.scheduleCount, 2);
  // past days are never printed
  assert.equal(tripDates(withDates({ departures: ["2026-10-01"], schedule: [dep("2026-10-01")], window: [dep("2026-10-01")] }), asOf).kind, "plain");

  // fares: the data layer's flag wins; absent flag is derived from the dated fares
  assert.equal(tripDates(withDates({ schedule: [dep("2026-11-14", 1000000), dep("2026-11-21", 1200000)], priceVaries: undefined }), asOf).priceVaries, true);
  assert.equal(tripDates(withDates({ schedule: [dep("2026-11-14", 1000000), dep("2026-11-21", 1000000)], priceVaries: false }), asOf).priceVaries, false);
});

test("trip page prints the window by month, the starting price labelled as such, a fare note and the link to the schedule block", () => {
  const snap = sampleSnapshot({ trips: 12, edition: "complete" });
  const plan = planPages(snap);
  const html = buildCatalogueHtml(snap, assetsFor(snap));
  const sectionOf = (code: string) => html.slice(html.indexOf(`id="trip-${code}"`), html.indexOf("</section>", html.indexOf(`id="trip-${code}"`)));
  const lines = sectionOf("A07"); // four departures inside 90 days across two years
  // dates are boxed chips everywhere (owner, launch week 2), one chip per day
  assert.ok(lines.includes("<span class=\"mn\">11-р сар:</span>") && lines.includes('<span class="chip">14</span>') && lines.includes('<span class="chip">28</span>') && lines.includes("2027 оны 1-р сар:"), lines.slice(0, 100));
  assert.ok(lines.includes(`href="#${scheduleBlockId("A07")}"`) && lines.includes(`${plan.schedulePageByCode["A07"]}-р хуудас`), "link to the schedule block");
  assert.ok(lines.includes("Эхлэх үнэ / нэг том хүн") && !lines.includes("Үнэ огнооноос хамаарна"), "one fare: no 'varies' note");
  const grid = sectionOf("A12"); // many dates -> grid
  assert.ok(grid.includes('class="chip"'), "dense window -> day grid");
  const fares = sectionOf("A11");
  assert.ok(fares.includes("Үнэ огнооноос хамаарна") && fares.includes("Эхлэх үнэ / нэг том хүн"), "fares differ by date: the note and the starting-price label");
  const far = sectionOf("A10");
  assert.ok(far.includes("Хамгийн ойрын хөдөлгөөн") && far.includes("2027 оны 3-р сарын 06"), "empty window still shows the nearest departure");
  const weekly = sectionOf("A09");
  assert.ok(weekly.includes("Долоо хоног бүрийн баасан гарагт"), "recurring trips show their safe label");
  const empty = sectionOf("A05");
  assert.ok(empty.includes("Явах огноог лавлана") && !empty.includes("sched-"), "no dates, no schedule link");
});

test("schedule appendix: every future departure per trip (beyond 90 days too), month lines with the year, fares by date where they differ, links both ways", () => {
  const snap = sampleSnapshot({ trips: 12, edition: "complete" });
  const plan = planPages(snap);
  const html = buildCatalogueHtml(snap, assetsFor(snap));
  const blockOf = (code: string) => {
    const at = html.indexOf(`id="${scheduleBlockId(code)}"`);
    return html.slice(at, html.indexOf("</div></div>", at) + 12);
  };
  const dated = plan.trips.filter(t => (t.card.dates.schedule ?? []).length > 0);
  assert.equal(Object.keys(plan.schedulePageByCode).length, dated.length, "a block for every trip with a future departure, none for the others");
  for (const t of dated) {
    const block = blockOf(t.card.code);
    assert.ok(block.includes(`href="#trip-${t.card.code}"`), `${t.card.code}: block links back to its page`);
    assert.ok(block.includes(`<span class="sp">${t.page}</span>`), `${t.card.code}: block prints its page number`);
    assert.ok(block.includes(escapeHtml(t.card.editorialTitle)) || block.includes(t.card.editorialTitle.slice(0, 6)), `${t.card.code}: title`);
  }
  assert.ok(blockOf("A10").includes("2027 оны 3-р сар: 06 · 20") && blockOf("A10").includes("2027 оны 4-р сар: 03"), "dates beyond the 90-day window are all listed");
  const fares = blockOf("A11");
  assert.ok(fares.includes("11-р сар: 21 · 28") && fares.includes("3,990,000₮") && fares.includes("4,190,000₮") && fares.includes("4,590,000₮"), "date-specific fares");
  assert.ok(!blockOf("A01").includes("₮"), "one fare for every date: no per-date fares");
  assert.ok(blockOf("A09").includes("2027 оны 6-р сар: 04"), "a long weekly schedule is printed in full");
  assert.ok(html.includes('id="schedule"') && html.includes('id="index"'));
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
    "Хамгийн ойрын хөдөлгөөн",
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

test("an empty edition still renders a valid plan (cover, guide notice, closing; no appendices)", () => {
  const snap = snapshotOf([], []);
  const plan = planPages(snap);
  assert.equal(plan.totalPages, 3);
  assert.equal(plan.firstSchedulePage, null);
  assert.equal(plan.firstIndexPage, null);
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

test("outline: cover, guide, chapters with 'code · title' bookmarks, schedule and index appendices, quotation page", () => {
  const snap = sampleSnapshot({ trips: 6 });
  const plan = planPages(snap);
  const outline = outlineFor(plan);
  assert.deepEqual(outline.slice(0, 2).map(o => [o.title, o.page]), [["Нүүр", 1], ["Агуулга", 2]]);
  assert.equal(outline.at(-1)!.page, plan.closingPage);
  assert.deepEqual(outline.filter(o => o.title.startsWith("Хавсралт")).map(o => [o.title, o.page]), [
    ["Хавсралт · Хөдөлгөөний товлол", plan.firstSchedulePage],
    ["Хавсралт · Кодын жагсаалт", plan.firstIndexPage],
  ]);
  assert.deepEqual(outline.filter(o => o.children.length > 0).map(o => o.title), plan.chapters.map(c => c.label), "a bookmark per chapter");
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
  const centre = cropWindow(2000, 1000, ASPECT.thumb);
  assert.equal(centre.width, 1000);
  assert.equal(centre.height, 1000);
  assert.equal(centre.left, 500);
  const left = cropWindow(2000, 1000, ASPECT.thumb, { x: 0.1, y: 0.5 });
  assert.equal(left.left, 0, "clamped to the left edge");
  const zoomed = cropWindow(2000, 1000, ASPECT.thumb, { x: 0.9, y: 0.5 }, 2);
  assert.equal(zoomed.width, 500);
  assert.equal(zoomed.left + zoomed.width, 2000, "clamped to the right edge");
  for (const w of [centre, left, zoomed]) assert.ok(Math.abs(w.height / w.width - ASPECT.thumb) < 0.01);
});

test("cropImage: exact aspect, resampled, never upscaled, progressive JPEG; loadWork rejects junk", async () => {
  const work = (await loadWork(await makeSyntheticPhoto(1, 2400, 1200)))!;
  const a = (await cropImage(work, { aspect: ASPECT.thumb, outWidth: 1040, quality: 80 }))!;
  assert.ok(a.width <= 1040 && a.width >= 1000, `width ${a.width}`);
  assert.ok(Math.abs(a.height / a.width - ASPECT.thumb) < 0.01);
  assert.ok(a.bytes < 600_000, `bytes ${a.bytes}`);
  const jpeg = Buffer.from(a.dataUri.replace(/^data:image\/jpeg;base64,/, ""), "base64");
  assert.deepEqual([jpeg[0], jpeg[1]], [0xff, 0xd8]);
  const meta = await sharp(jpeg).metadata();
  assert.equal(meta.width, a.width);
  assert.equal(meta.isProgressive, true);

  const narrow = (await loadWork(await makeSyntheticPhoto(2, 900, 1800)))!;
  const p = (await cropImage(narrow, { aspect: ASPECT.thumb, outWidth: 1040, quality: 80 }))!;
  assert.equal(p.width, 900, "narrow source is not upscaled");

  const small = (await loadWork(await makeSyntheticPhoto(3, 500, 400)))!;
  const sm = (await cropImage(small, { aspect: ASPECT.thumb, outWidth: 1040, quality: 80 }))!;
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
  assert.deepEqual(duplicateUses(art.uses), [], "no photograph is printed on two pages (the closing band is then a photo nobody used, or a plain band)");
  // Owner, launch week 2: ONE trip-page design (near-square photo over the dark panel); only a trip whose
  // photo cannot print falls back to the typographic page.
  const compositions = new Set(Object.values(art.trips).filter(t => t.composition !== "type").map(t => t.composition));
  assert.deepEqual([...compositions], ["plate"], "every printable photo page is the one plate design");
});

// ---------------------------------------------------------------------------------------------
// Cover, closing, repeated photographs, navigation (V3)
// ---------------------------------------------------------------------------------------------

function duplicateUses(uses: { url: string; role: string }[]): string[] {
  const seen = new Map<string, string>();
  const dup: string[] = [];
  for (const u of uses) {
    const first = seen.get(u.url);
    if (first) dup.push(`${first} + ${u.role}`);
    else seen.set(u.url, u.role);
  }
  return dup;
}

test("coverModeFor: portrait with pixels carries the whole page, landscape gets the cinematic plate, small is refused", () => {
  assert.equal(coverModeFor({ width: 1500, height: 2400 }), "full");
  assert.equal(coverModeFor({ width: 2000, height: 2000 }), "full");
  assert.equal(coverModeFor({ width: 1920, height: 1440 }), "plate", "4:3 is not portrait");
  assert.equal(coverModeFor({ width: 2400, height: 1600 }), "plate");
  assert.equal(coverModeFor({ width: 500, height: 400 }), null);
  assert.equal(coverModeFor({ width: 1500, height: 2400 }, { zoom: 1.9 }), "plate", "a zoom leaves too few pixels for the full page but enough for the plate (page is 4:5 now, so the margin is narrower)");
  assert.equal(coverModeFor({ width: 1500, height: 2400 }, { zoom: 3 }), null, "a deep zoom leaves too few pixels for any cover");
});

test("cover: the dedicated cover photograph is used, no trip page repeats it, and nothing in the book prints one photograph twice", async () => {
  for (const shape of ["tall", "ok"] as const) {
    const snap = sampleSnapshot({ trips: 8, edition: "quick", coverPhoto: shape });
    const art = await prepareArt(snap, planPages(snap), sampleImageFetcher());
    assert.ok(art.cover, shape);
    assert.equal(art.cover!.source, "cover_photo");
    assert.equal(art.cover!.tripId, null);
    assert.equal(art.cover!.mode, shape === "tall" ? "full" : "plate");
    assert.equal(art.cover!.credit, "Жишиг нүүр зураг");
    assert.deepEqual(duplicateUses(art.uses), [], `${shape}: a photograph is printed on two pages`);
    assert.ok(art.uses.some(u => u.role === "cover") && art.uses.some(u => u.role.startsWith("trip-")));
  }
});

test("cover: the landscape plate fades into the panel colour, so the photo and the navy panel are one surface", async () => {
  const snap = sampleSnapshot({ trips: 3, edition: "quick", coverPhoto: "ok" });
  const art = await prepareArt(snap, planPages(snap), sampleImageFetcher());
  const bytes = Buffer.from(art.cover!.image.dataUri.split(",")[1]!, "base64");
  const { width, height } = await sharp(bytes).metadata();
  const edge = await sharp(bytes).extract({ left: 0, top: height! - 4, width: width!, height: 4 }).resize(1, 1).raw().toBuffer();
  const [r, g, b] = [edge[0]!, edge[1]!, edge[2]!];
  assert.ok(Math.abs(r - 0x14) <= 6 && Math.abs(g - 0x20) <= 6 && Math.abs(b - 0x2e) <= 6, `bottom edge ${r},${g},${b} should be the panel navy`);
  const html = buildCatalogueHtml(snap, assetsFor(snap, { cover: art.cover }));
  assert.ok(html.includes("coverplate") && html.includes('style="top:700pt"'));
});

test("cover: without a dedicated photograph the cover trip's other photograph is preferred over its hero; the hero is the last resort", async () => {
  const snap = sampleSnapshot({ trips: 8, edition: "quick" });
  const art = await prepareArt(snap, planPages(snap), sampleImageFetcher());
  assert.equal(art.cover!.source, "gallery");
  assert.equal(art.cover!.tripId, snap.coverTripId);
  assert.deepEqual(duplicateUses(art.uses), []);
  const noGallery = { ...snap, trips: snap.trips.map(t => ({ ...t, gallery: [] })) };
  const art2 = await prepareArt(noGallery, planPages(noGallery), sampleImageFetcher());
  assert.equal(art2.cover!.source, "hero");
  assert.equal(art2.cover!.tripId, snap.coverTripId);
});

test("cover: a cover photograph that is also a trip page hero is ignored; a missing or unreadable one falls back quietly", async () => {
  const base = sampleSnapshot({ trips: 8, edition: "quick" });
  const same = { ...base, coverPhoto: { ...base.trips[1]!.photo!, credit: null } };
  const art = await prepareArt(same, planPages(same), sampleImageFetcher());
  assert.notEqual(art.cover!.source, "cover_photo");
  assert.deepEqual(duplicateUses(art.uses), []);
  const broken = { ...base, coverPhoto: { url: "https://photos.example.test/fail/1.jpg", width: null, height: null, credit: null, source: "trip_photo" as const } };
  const art2 = await prepareArt(broken, planPages(broken), sampleImageFetcher());
  assert.ok(art2.cover, "falls back to a trip photograph");
  assert.notEqual(art2.cover!.source, "cover_photo");
});

test("closing band: only a photograph no page uses; none left means a plain brand band, never a repeat of the cover or a trip", async () => {
  const snap = sampleSnapshot({ trips: 8, edition: "quick", coverPhoto: "tall" });
  const noGallery = { ...snap, trips: snap.trips.map(t => ({ ...t, gallery: [] })) };
  const art = await prepareArt(noGallery, planPages(noGallery), sampleImageFetcher());
  assert.equal(art.closing, null);
  const html = buildCatalogueHtml(noGallery, assetsFor(noGallery, art));
  assert.ok(html.includes('class="band plain"'));
  assert.ok(html.includes("page closing compact"));
  assert.deepEqual(duplicateUses(art.uses), []);
});

test("cover copy: a warm line addressed to the team, issue line with season, count and date, link into the contents, original logo only", () => {
  const snap = snapshotOf([card({ n: 1 }), card({ n: 2 })]);
  const html = buildCatalogueHtml(snap, assetsFor(snap));
  const cover = html.slice(html.indexOf('id="cover"'), html.indexOf("</section>", html.indexOf('id="cover"')));
  assert.ok(cover.includes(escapeHtml(COVER_INVITE)) && /Баг хамт олныхоо/.test(COVER_INVITE));
  assert.ok(cover.includes("2026 / 2027 · 2 аяллын санал · 2026.11.06"), cover);
  assert.ok(cover.includes('href="#contents"'));
  assert.ok(cover.includes('class="logo cover"') && cover.includes("alt=\"UUDAM Travel Agency\"") && !cover.includes('class="tile"'), "the logo sits flush in the corner, never in a tile");
  assert.ok(!cover.includes("filter") && !cover.includes("box-shadow"));
});

test("closing: staff-approved company notes are printed (max 3, trimmed, unique, escaped, long ones dropped); absent notes print nothing extra", () => {
  const snap = snapshotOf([card({ n: 1 })]);
  const plain = buildCatalogueHtml(snap, assetsFor(snap));
  assert.ok(!plain.includes('class="corp"'));
  assert.ok(plain.includes("Эцсийн үнэ, суудал, огноо, нөхцөлийг ажилтан баталгаажуулна"));
  const long = "х".repeat(200);
  const withNotes = { ...snap, contact: { ...snap.contact, corporateNotes: ["  Жишиг <b>нэг</b>  мөр ", "Жишиг <b>нэг</b> мөр", long, "Хоёр", "Гурав", "Дөрөв"] } };
  assert.deepEqual(corporateNotesOf(withNotes), ["Жишиг <b>нэг</b> мөр", "Хоёр", "Гурав"]);
  const html = buildCatalogueHtml(withNotes, assetsFor(withNotes));
  assert.ok(html.includes("Жишиг &lt;b&gt;нэг&lt;/b&gt; мөр") && !html.includes("<b>нэг</b>"));
  assert.ok(html.includes("<li>Гурав</li>") && !html.includes("Дөрөв") && !html.includes(long));
  assert.ok(html.includes("Эцсийн үнэ, суудал, огноо, нөхцөлийг ажилтан баталгаажуулна"), "the disclaimer stays");
});

test("navigation audit: names a destination on the wrong page, a guide/index/schedule link that goes elsewhere, a missing back link and a missing bookmark", () => {
  const snap = sampleSnapshot({ trips: 4, edition: "complete" });
  const plan = planPages(snap);
  const rect: [number, number, number, number] = [0, 0, 1, 1];
  const guide = new Set(plan.guidePages.map((_, i) => plan.firstGuidePage + i));
  const sched = plan.schedulePages.map((_, i) => plan.firstSchedulePage! + i);
  const index = plan.indexPages.map((_, i) => plan.firstIndexPage! + i);
  const back = (page: number) => ({ page, rect, target: plan.firstGuidePage, dest: "contents", uri: null });
  const chapterDest = (c: (typeof plan.chapters)[number]) => (c.openerPage != null ? `chapter-${c.index + 1}` : `trip-${c.trips[0]!.card.code}`);
  const good: PdfNavigation = {
    pageCount: plan.totalPages,
    destinations: { ...expectedDestinations(plan) },
    links: [
      back(1),
      ...plan.chapters.map(c => ({ page: plan.firstGuidePage, rect, target: c.firstPage, dest: chapterDest(c), uri: null })),
      ...plan.guidePages.flat().flatMap(e => e.names.map(n => ({ page: plan.firstGuidePage, rect, target: n.page, dest: `trip-${n.code}`, uri: null }))),
      ...plan.trips.map(t => ({ page: index[0]!, rect, target: t.page, dest: `trip-${t.card.code}`, uri: null })),
      ...plan.trips.filter(t => plan.schedulePageByCode[t.card.code] != null).flatMap(t => [
        { page: t.page, rect, target: plan.schedulePageByCode[t.card.code]!, dest: scheduleBlockId(t.card.code), uri: null },
        { page: sched[0]!, rect, target: t.page, dest: `trip-${t.card.code}`, uri: null },
      ]),
      ...[...plan.trips.map(t => t.page), ...plan.chapters.flatMap(c => (c.openerPage != null ? [c.openerPage] : [])), ...sched, ...index, plan.closingPage].map(back),
    ],
    outline: [
      { title: "Агуулга", page: plan.firstGuidePage, depth: 0 },
      { title: "Хавсралт · Хөдөлгөөний товлол", page: plan.firstSchedulePage, depth: 0 },
      { title: "Хавсралт · Кодын жагсаалт", page: plan.firstIndexPage, depth: 0 },
      ...plan.chapters.map(c => ({ title: c.label, page: c.firstPage, depth: 0 })),
      ...plan.trips.map(t => ({ title: `${t.card.code} · ${t.card.editorialTitle}`, page: t.page, depth: 1 })),
    ],
  };
  assert.deepEqual(auditNavigation(good, snap, plan), []);
  assert.ok(guide.size >= 1);
  const wrongDest = { ...good, destinations: { ...good.destinations, "trip-A02": 2 } };
  assert.ok(auditNavigation(wrongDest, snap, plan).some(w => w.message.includes("зөв хуудас руу заахгүй")));
  const wrongIndex = { ...good, links: good.links.map(l => (l.dest === "trip-A01" && index.includes(l.page) ? { ...l, target: 99 } : l)) };
  assert.ok(auditNavigation(wrongIndex, snap, plan).some(w => w.message.startsWith("A01: жагсаалтын мөр")));
  const wrongGuide = { ...good, links: good.links.map(l => (l.page === plan.firstGuidePage && l.dest === `trip-${plan.guidePages[0]![0]!.names[0]!.code}` ? { ...l, target: 99 } : l)) };
  assert.ok(auditNavigation(wrongGuide, snap, plan).some(w => w.message.includes("агуулга дахь нэрийн холбоос")));
  const noChapter = { ...good, links: good.links.filter(l => !(l.page === plan.firstGuidePage && l.dest === chapterDest(plan.chapters[0]!))) };
  assert.ok(auditNavigation(noChapter, snap, plan).some(w => w.message.includes("бүлгийн холбоос")));
  const noSchedLink = { ...good, links: good.links.filter(l => !(l.dest === scheduleBlockId("A01"))) };
  assert.ok(auditNavigation(noSchedLink, snap, plan).some(w => w.message.startsWith("A01: аяллын хуудас огнооны товлол")));
  const noSchedBack = { ...good, links: good.links.filter(l => !(sched.includes(l.page) && l.dest === "trip-A01")) };
  assert.ok(auditNavigation(noSchedBack, snap, plan).some(w => w.message.startsWith("A01: товлолын блок")));
  const noBack = { ...good, links: good.links.filter(l => !(l.dest === "contents" && l.page === plan.closingPage)) };
  assert.ok(auditNavigation(noBack, snap, plan).some(w => w.message.includes("буцах холбоос")));
  const noMark = { ...good, outline: good.outline.filter(o => !o.title.startsWith("A01 ·")) };
  assert.ok(auditNavigation(noMark, snap, plan).some(w => w.message.startsWith("A01: хавчуургад")));
  const noIndexMark = { ...good, outline: good.outline.filter(o => o.title !== "Хавсралт · Кодын жагсаалт") };
  assert.ok(auditNavigation(noIndexMark, snap, plan).some(w => w.message.includes("Хавчуурга алга")));
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
    snapshot = sampleSnapshot({ trips: 8, edition: "quick", coverPhoto: "tall", corporateNotes: ["Жишиг мөр: байгууллагад зориулсан тусгай хөтөлбөрийг ажилтан бэлтгэнэ."] });
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

  test("one portrait PDF, every page 540 x 675 pt (4:5), page count matches the plan", async t => {
    const r = need(t);
    if (!r) return;
    assert.equal(r.pdf.subarray(0, 5).toString("latin1"), "%PDF-");
    const plan = planPages(snapshot);
    assert.equal(r.pageCount, plan.totalPages);
    assert.ok(r.pageSize.width === 540 && Math.abs(r.pageSize.height - 675) < 0.5, JSON.stringify(r.pageSize));
    const pdf = await PDFDocument.load(r.pdf);
    assert.equal(pdf.getPageCount(), plan.totalPages);
    for (const page of pdf.getPages()) {
      const { width, height } = page.getSize();
      assert.ok(Math.abs(width - 540) < 0.5 && Math.abs(height - 675) < 0.5, `${width}x${height}`);
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
    const planIdx = planPages(snapshot);
    const idxText = squash(pageText[planIdx.firstIndexPage! - 1]!);
    assert.ok(idxText.includes("A01") && idxText.includes("3,740,000₮-с"), "the index lists code and price");
    assert.ok(squash(pageText[1]!).includes("Хаашаа"), "the guide is page 2");
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
        assert.ok(y >= 12 && y + size <= 675 - 12, `p${i + 1} "${it.str.slice(0, 24)}" y=${y.toFixed(1)}`);
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
    assert.ok(titles.includes("Хавсралт · Хөдөлгөөний товлол") && titles.includes("Хавсралт · Кодын жагсаалт"), titles.join(" | "));
    // guide links are internal GoTo links (no network): the A01 row lands on A01's page
    const links = (await (await doc.getPage(2)).getAnnotations()).filter(a => a.subtype === "Link" && typeof a.dest === "string");
    assert.ok(links.length >= 4);
    const dest = await doc.getDestination("trip-A01");
    assert.ok(dest, "named destination exists");
    const pageIndex = await doc.getPageIndex(dest![0] as { num: number; gen: number });
    assert.equal(pageIndex + 1, planPages(snapshot).trips.find(x => x.card.code === "A01")!.page);
  });

  test("navigation: every guide link, index row and schedule block opens the page that shows that trip; every page leads back; bookmarks cover guide, chapters, trips and appendices", async t => {
    const r = need(t);
    if (!r) return;
    const plan = planPages(snapshot);
    // letter-spaced type reaches the text layer as "A 0 1" and "0 5 / 1 6", hence squash()
    const nav = await readPdfNavigation(r.pdf);
    assert.equal(nav.pageCount, plan.totalPages);
    assert.ok(nav.links.length >= snapshot.trips.length, `${nav.links.length} link annotations for ${snapshot.trips.length} trips`);
    const guidePages = new Set(plan.guidePages.map((_, i) => plan.firstGuidePage + i));
    const indexPages = new Set(plan.indexPages.map((_, i) => plan.firstIndexPage! + i));
    const schedPages = new Set(plan.schedulePages.map((_, i) => plan.firstSchedulePage! + i));
    assert.ok(plan.guidePages.length >= 1 && plan.guidePages.length <= 2 && plan.indexPages.length >= 1 && plan.schedulePages.length >= 1);
    const showsCode = (page: number, code: string) => squash(pageText[page - 1] ?? "").includes(code);
    for (const trip of plan.trips) {
      const code = trip.card.code;
      const row = nav.links.find(l => indexPages.has(l.page) && l.dest === `trip-${code}`);
      assert.ok(row, `${code}: index row has a link`);
      assert.equal(row!.target, trip.page, `${code}: link goes to the planned page`);
      assert.ok(showsCode(row!.target!, code), `${code}: the page it opens shows that trip's code`);
      const bookmark = nav.outline.find(o => o.title.startsWith(`${code} ·`));
      assert.ok(bookmark, `${code}: bookmark`);
      assert.equal(bookmark!.page, trip.page);
      assert.ok(nav.links.some(l => l.page === trip.page && l.dest === "contents" && l.target === plan.firstGuidePage), `${code}: back to the guide`);
      const blockPage = plan.schedulePageByCode[code];
      if (blockPage != null) {
        const to = nav.links.find(l => l.page === trip.page && l.dest === scheduleBlockId(code));
        assert.ok(to && to.target === blockPage && schedPages.has(blockPage), `${code}: trip page links to its schedule block`);
        assert.ok(showsCode(blockPage, code), `${code}: the schedule page shows the code`);
        const back = nav.links.find(l => schedPages.has(l.page) && l.dest === `trip-${code}`);
        assert.ok(back && back.target === trip.page, `${code}: the schedule block links back`);
      }
    }
    for (const chapter of plan.chapters) {
      const dest = chapter.openerPage != null ? `chapter-${chapter.index + 1}` : `trip-${chapter.trips[0]!.card.code}`;
      const link = nav.links.find(l => guidePages.has(l.page) && l.dest === dest);
      assert.ok(link && link.target === chapter.firstPage, `${chapter.label}: guide link opens the chapter`);
      assert.ok(nav.outline.some(o => o.title === chapter.label && o.page === chapter.firstPage), `${chapter.label}: bookmark`);
    }
    for (const entry of plan.guidePages.flat()) {
      for (const n of entry.names) {
        const link = nav.links.find(l => guidePages.has(l.page) && l.dest === `trip-${n.code}`);
        assert.ok(link && link.target === n.page, `${n.code}: destination name in the guide opens its page`);
        assert.ok(showsCode(n.page, n.code));
      }
    }
    assert.equal(nav.outline.filter(o => o.depth === 1).length, snapshot.trips.length, "one bookmark per trip");
    assert.ok(nav.links.some(l => l.page === 1 && l.dest === "contents" && l.target === plan.firstGuidePage), "cover links into the guide");
    assert.ok(nav.links.some(l => guidePages.has(l.page) && l.dest === "schedule" && l.target === plan.firstSchedulePage), "guide links to the schedule appendix");
    assert.ok(nav.links.some(l => guidePages.has(l.page) && l.dest === "index" && l.target === plan.firstIndexPage), "guide links to the index");
    for (const page of [...schedPages, ...indexPages]) assert.ok(nav.links.some(l => l.page === page && l.dest === "contents"), `appendix page ${page} leads back`);
    assert.ok(nav.links.some(l => l.page === plan.closingPage && l.dest === "contents"), "closing leads back");
    assert.ok(nav.links.some(l => l.page === plan.closingPage && (l.uri ?? "").startsWith("https://")), "closing links to the site");
    // page numbers: every page after the cover prints "NN / total" with its own number
    const total = String(plan.totalPages).padStart(2, "0");
    for (let page = 2; page <= plan.totalPages; page++) {
      assert.ok(squash(pageText[page - 1]!).includes(`${String(page).padStart(2, "0")}/${total}`), `page ${page} label`);
    }
    assert.deepEqual(r.warnings.filter(w => /холбоос|хавчуур|агуулгын|жагсаалтын|товлол/.test(w.message)), [], "the render's own navigation audit is clean");
  });

  test("the closing page's version stamp fits: no overflow warning anywhere in the book, appendices included", async t => {
    const r = need(t);
    if (!r) return;
    assert.deepEqual(r.warnings.filter(w => w.code === "other" && /багтсангүй/.test(w.message)), []);
    assert.ok(pageText.at(-1)!.includes("v-test-1"));
  });

  test("the logo on the cover is the approved file, flush in the corner at its square ratio, with no container around it", async t => {
    const r = need(t);
    if (!r) return;
    const meta = await sharp(r.pageImages[0]!).metadata();
    // top-left 8px of the rendered cover are the logo's own navy field, not paper or photo
    const corner = await sharp(r.pageImages[0]!).extract({ left: 0, top: 0, width: 8, height: 8 }).resize(1, 1).raw().toBuffer();
    assert.ok(corner[2]! > corner[0]! + 20 && corner[0]! < 60, `corner pixel rgb(${corner[0]},${corner[1]},${corner[2]}) is the logo's navy`);
    assert.equal(meta.width, 810);
    const html = buildCatalogueHtml(snapshot, { fonts: [], logoDataUri: TINY_LOGO, ...emptyArt(), versionLabel: "v" });
    assert.ok(!html.includes('class="tile"') && html.includes('class="logo cover"'));
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
      assert.ok(Math.abs((meta.height ?? 0) - 1012.5) <= 1, `page image height ${meta.height}`);
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
  assert.ok(html.includes('<span class="it">Тест-Өвөрийн Аялал — Үзэмжит Ёзоор</span>'), "index row");
  assert.ok(html.includes('<span class="it">Тест-хотын аялал</span>'), "index row, lowercase source");
  assert.ok(/<h2 class="headline"[^>]*>Тест-Өвөрийн Аялал — Үзэмжит Ёзоор<\/h2>/.test(html), "trip page headline");
  assert.ok(!html.includes("ТЕСТ-ӨВӨРИЙН"), "the shouted form is never printed");
  const kids = outlineFor(planPages(snap)).flatMap(o => o.children).map(k => k.title);
  assert.deepEqual(kids, ["A01 · Тест-Өвөрийн Аялал — Үзэмжит Ёзоор", "A02 · Тест-хотын аялал"], "bookmarks");
});

/** `count` trips in `groups` contiguous groups; `long` titles wrap to two lines in a row. */
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

test("guide: one page for a short book, two for a longer one; blocks never overflow their budget", () => {
  // The page is 4:5 now (675pt), so a page carries fewer chapter blocks than the old 9:16 strip did.
  for (const chapters of [1, 3, 4]) {
    const g = planGuide(chapters);
    assert.equal(g.perPage.length, 1, `${chapters} chapters fit one page`);
    assert.equal(g.perPage[0], chapters);
    assert.ok(g.rowHeightPt >= 72 && g.rowHeightPt <= 104);
  }
  // Chapters are the trip groups (at most six exist), so two pages always suffice.
  for (const chapters of [5, 6, 8]) {
    const g = planGuide(chapters);
    assert.equal(g.perPage.length, 2, `${chapters} chapters take two pages`);
    assert.equal(g.perPage.reduce((a, b) => a + b, 0), chapters);
    assert.ok(Math.min(...g.perPage) >= 2, "no orphan page");
  }
  assert.equal(planGuide(0).perPage.length, 1);
  assert.equal(planPages(bookOf(30, { groups: 4 })).guidePages.length, 1);
  assert.equal(planPages(bookOf(60, { groups: 6 })).guidePages.length, 2);
});


test("guide: one photo per chapter taken from that chapter's own trips (strongest hero), a monogram when none; links to the chapter and to destination names", () => {
  const snap = bookOf(6, { groups: 3 });
  snap.trips[2] = { ...snap.trips[2]!, heroQuality: "excellent" };
  const trips: Record<string, TripArt> = {};
  snap.trips.forEach(t => { trips[t.tripId] = { composition: "plate", hero: tinyImage(), second: null, thumb: { ...tinyImage(), dataUri: TINY_LOGO } }; });
  delete (trips as Record<string, TripArt | undefined>)[snap.trips[4]!.tripId];
  delete (trips as Record<string, TripArt | undefined>)[snap.trips[5]!.tripId];
  const html = buildCatalogueHtml(snap, assetsFor(snap, { trips }));
  const guide = html.slice(html.indexOf('<section class="page guide"'), html.indexOf("</section>", html.indexOf('<section class="page guide"')));
  assert.equal((guide.match(/class="grow"/g) ?? []).length, 3, "one block per chapter");
  assert.equal((guide.match(/class="gth"/g) ?? []).length, 2, "two chapters have a photo");
  assert.equal((guide.match(/class="gth mono"/g) ?? []).length, 1, "the chapter without a photo gets a monogram tile");
  const plan = planPages(snap);
  for (const c of plan.chapters) {
    const dest = c.openerPage != null ? `#chapter-${c.index + 1}` : `#trip-${c.trips[0]!.card.code}`;
    assert.ok(guide.includes(`href="${dest}"`), `${c.label}: link`);
  }
  for (const n of plan.guidePages.flat().flatMap(e => e.names)) assert.ok(guide.includes(`href="#trip-${n.code}"`), n.code);
});

test("index appendix: code, title, starting price and page for every trip, each row a link; fares are never invented", () => {
  const snap = sampleSnapshot({ trips: 12, edition: "complete" });
  const plan = planPages(snap);
  const html = buildCatalogueHtml(snap, assetsFor(snap));
  const index = html.slice(html.indexOf('id="index"'));
  for (const t of plan.trips) {
    assert.ok(index.includes(`<a class="irow" href="#trip-${t.card.code}"><span class="ic">${t.card.code}</span>`), t.card.code);
    assert.ok(index.includes(`<span class="ip${t.card.price.kind === "inquire" ? " inq" : ""}">${escapeHtml(t.card.price.display)}</span><span class="ipg">${t.page}</span>`), `${t.card.code}: price and page`);
  }
  assert.ok(index.includes("Үнэ лавлах"));
});

test("the guide at the start is not the dense listing any more: no per-trip rows, prices or codes before the first trip page", () => {
  const snap = sampleSnapshot({ trips: 40, edition: "complete" });
  const plan = planPages(snap);
  const html = buildCatalogueHtml(snap, assetsFor(snap));
  const before = html.slice(0, html.indexOf(`id="trip-${plan.trips[0]!.card.code}"`));
  assert.ok(!before.includes('class="crow"') && !before.includes('class="irow"') && !before.includes("₮"), "no trip rows or prices ahead of the trips");
  assert.equal(plan.firstTripPage, 3, "cover, one guide page, then the book");
});
