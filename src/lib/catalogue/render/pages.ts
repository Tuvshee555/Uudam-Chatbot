/**
 * The pages around the trips: cover, chapter openers, the chapter navigation guide (contents), the
 * schedule and index appendices and the closing page. Same system as the trip pages: ivory paper,
 * deep navy, one teal, serif display type, generous space, the approved UUDAM logo flush in a corner
 * (never inside a tile or container).
 */
import { transportLegendHtml } from "./transport";
import type { CatalogueSnapshot } from "../types";
import {
  DISCLAIMER,
  GROUP_PRICE_NOTE,
  INDEX_ANCHOR,
  SCHEDULE_ANCHOR,
  anchorId,
  cardTitle,
  chapterAnchorId,
  pad2,
  scheduleBlockId,
  ulaanbaatarStamp,
  type ChapterPlan,
  type GuideEntry,
  type OrderedTrip,
  type PagePlan,
  type SchedBlock,
} from "./layout";
import { moneyMnt, type MonthLine } from "./dates";
import { escapeHtml, footHtml, imageTag, logoCorner, px, safeHref, safeImageSrc } from "./htmlParts";
import type { RenderAssets } from "./renderTypes";
import { displayTitle } from "./titleCase";

export const CATALOGUE_TITLE = "ХАМТ ОЛНЫ АЯЛЛЫН СОНГОЛТ";
const COVER_TITLE_LINES = ["ХАМТ ОЛНЫ", "АЯЛЛЫН СОНГОЛТ"] as const;
const RUNNING_TITLE = "Байгууллагын аяллын сонголт";
const SAMPLE_SIZE_AND_MONTH = "25 хүн, 1-р сар";
const MAX_PHONES = 3;
const MAX_CORPORATE_NOTES = 3;
const MAX_NOTE_CHARS = 150;
/** The cover's one warm line: addressed to the team, an invitation rather than a slogan. */
export const COVER_INVITE = "Баг хамт олныхоо дараагийн мартагдашгүй аяллыг эндээс эхлүүлээрэй.";

const dispTitle = (t: OrderedTrip) => displayTitle(cardTitle(t.card));

// --- cover -------------------------------------------------------------------------------------

export function coverPage(snapshot: CatalogueSnapshot, plan: PagePlan, assets: RenderAssets): string {
  const cover = assets.cover;
  const count = snapshot.trips.length;
  const issue = [snapshot.seasonLabel, count > 0 ? `${count} аяллын санал` : "", snapshot.issueLabel].filter(Boolean).map(escapeHtml).join(" · ");
  // Credit on the left, the way into the book on the right (a small link, not a button).
  const caption = `<div class="caption"><span>${cover?.credit ? `Фото: ${escapeHtml(cover.credit)}` : ""}</span><a class="go" href="#contents">Агуулга</a></div>`;
  const block = `<div class="block">
    <div class="eyebrow">UUDAM Travel · Байгууллагын аялал</div>
    <h1 data-fit-min="${px(26)}" data-fit-maxh="${px(37 * 1.14 * 2 + 2)}">${COVER_TITLE_LINES.map(escapeHtml).join("<br>")}</h1>
    <div class="rule"></div>
    <p class="invite">${escapeHtml(COVER_INVITE)}</p>
    <div class="issue">${issue}</div>
  </div>`;
  const logo = logoCorner(assets, "cover");
  if (!cover) {
    return `<section class="page cover bare dark" id="cover" data-page="1">${logo}${block}${caption}</section>`;
  }
  if (cover.mode === "plate") {
    return `<section class="page cover coverplate dark" id="cover" data-page="1">
  <div class="panelbg" style="top:700pt"></div>
  <div class="photo">${imageTag(cover.image, "")}</div>
  ${logo}${block}${caption}
</section>`;
  }
  return `<section class="page cover dark" id="cover" data-page="1">
  ${imageTag(cover.image, "", "bg")}
  ${logo}${block}${caption}
</section>`;
}

// --- chapter openers -------------------------------------------------------------------------------

/** The chapter's destinations as one editorial line: "Бали · Данан · Египет". */
export function chapterLine(chapter: ChapterPlan, maxChars = 64): string {
  const titles: string[] = [];
  let used = 0;
  for (const t of chapter.trips) {
    const title = dispTitle(t);
    const next = used + (titles.length ? 3 : 0) + title.length;
    if (titles.length > 0 && next > maxChars) break;
    titles.push(title);
    used = next;
  }
  return titles.join(" · ");
}

export function openerPage(snapshot: CatalogueSnapshot, plan: PagePlan, assets: RenderAssets, chapter: ChapterPlan): string {
  const art = assets.chapters[chapter.index];
  const num = `${pad2(chapter.index + 1)} / ${pad2(plan.chapters.length)}`;
  const count = chapter.trips.length;
  const body = `<div class="block">
    <div class="num">${num}</div>
    <h2 data-fit-min="${px(30)}" data-fit-maxh="${px(52 * 1.08 * 3)}">${escapeHtml(chapter.label)}</h2>
    <div class="rule"></div>
    <p class="line">${escapeHtml(chapterLine(chapter))}</p>
    <div class="count">${count} аяллын санал</div>
  </div>`;
  const foot = footHtml({ page: chapter.openerPage ?? chapter.firstPage, total: plan.totalPages, back: true, credit: art?.credit ?? "" });
  return `<section class="page opener on-dark dark${art ? "" : " bare"}" id="${chapterAnchorId(chapter.index)}" data-page="${chapter.openerPage ?? chapter.firstPage}">
  ${art ? imageTag(art.image, "", "bg") : ""}
  ${body}
  ${foot}
</section>`;
}

// --- contents: the chapter navigation guide ----------------------------------------------------------

/** Where a chapter link lands: its opener when it has one, else its first trip page. */
function chapterTarget(entry: GuideEntry): string {
  return entry.openerPage != null ? `#${chapterAnchorId(entry.chapter)}` : entry.codes[0] ? `#${anchorId(entry.codes[0])}` : `#${GUIDE_ID}`;
}

const GUIDE_ID = "contents";

const QUALITY_RANK: Record<string, number> = { excellent: 3, good: 2, weak: 0, missing: 0 };

/**
 * The one photograph that stands for a chapter in the guide: the strongest approved hero among the
 * chapter's own trips (a small square crop of it, so it never repeats a full page that follows).
 */
export function guidePhotoFor(plan: PagePlan, assets: RenderAssets, entry: GuideEntry) {
  const byCode = new Map(plan.trips.map(t => [t.card.code, t] as const));
  let best: { thumb: NonNullable<RenderAssets["trips"][string]["thumb"]>; rank: number; pos: number } | null = null;
  entry.codes.forEach((code, pos) => {
    const t = byCode.get(code);
    const art = t ? assets.trips[t.card.tripId] : undefined;
    const thumb = art?.thumb;
    if (!t || !thumb || !safeImageSrc(thumb.dataUri) || art?.composition === "type") return;
    const rank = QUALITY_RANK[t.card.heroQuality] ?? 1;
    if (!best || rank > best.rank) best = { thumb, rank, pos };
  });
  return (best as { thumb: NonNullable<RenderAssets["trips"][string]["thumb"]> } | null)?.thumb ?? null;
}

function guideRow(plan: PagePlan, assets: RenderAssets, entry: GuideEntry): string {
  const target = chapterTarget(entry);
  const thumb = guidePhotoFor(plan, assets, entry);
  const photo = thumb
    ? `<a class="gth" href="${target}">${imageTag(thumb, "")}</a>`
    : `<a class="gth mono" href="${target}">${pad2(entry.chapter + 1)}</a>`;
  const names = entry.names
    .map(n => `<a href="#${anchorId(n.code)}">${escapeHtml(n.title)}</a>`)
    .join(`<i>·</i>`);
  const more = entry.more > 0 ? `<span class="gmore">+ ${entry.more}</span>` : "";
  return `<div class="grow" style="height:${plan.guideRowHeightPt}pt;--rh:${plan.guideRowHeightPt}pt">${photo}<div class="gbody"><div class="gtitle"><a class="gname" href="${target}"><span class="gnum">${pad2(entry.chapter + 1)}</span>${escapeHtml(entry.label)}</a><span class="gmeta">${entry.count} аялал · ${pad2(entry.page)}-р хуудас</span></div><p class="gnames">${names}${more ? ` ${more}` : ""}</p></div></div>`;
}

export function guidePage(snapshot: CatalogueSnapshot, plan: PagePlan, assets: RenderAssets, index: number): string {
  const entries = plan.guidePages[index] ?? [];
  const pageNo = plan.firstGuidePage + index;
  const first = index === 0;
  const exampleCode = plan.trips[0]?.card.code ?? "A01";
  const appendix: string[] = [];
  if (plan.firstSchedulePage != null) appendix.push(`<a href="#${SCHEDULE_ANCHOR}">Бүх огноо · ${pad2(plan.firstSchedulePage)}-р хуудас</a>`);
  if (plan.firstIndexPage != null) appendix.push(`<a href="#${INDEX_ANCHOR}">Кодын жагсаалт · ${pad2(plan.firstIndexPage)}-р хуудас</a>`);
  const head = first
    ? `<div class="gtop">${logoCorner(assets, "guide")}<span class="kick">Агуулга</span></div>
  <div class="ghead"><h2>Хаашаа аялах вэ?</h2><p class="csub">Бүлэг эсвэл аяллын нэр дээр дарж хуудас руу очоорой. Сонирхсон аяллынхаа кодыг бидэнд бичээрэй, жишээ нь <b>“${escapeHtml(exampleCode)}, ${SAMPLE_SIZE_AND_MONTH}”</b>.</p>${transportLegendHtml("light")}${
        appendix.length ? `<p class="glinks">${appendix.join("<i>·</i>")}</p>` : ""
      }</div>`
    : `<div class="gtop"><span class="kick">Агуулга · үргэлжлэл</span></div><div class="ghead small"><h2>Хаашаа аялах вэ?</h2></div>`;
  const body = entries.length === 0
    ? `<p class="csub gnone">Одоогоор санал болгох аялал алга. Манай ажилтнаас лавлана уу.</p>`
    : entries.map(entry => guideRow(plan, assets, entry)).join("\n");
  return `<section class="page guide"${first ? ` id="${GUIDE_ID}"` : ""} data-page="${pageNo}">
  ${head}
  <nav class="glist" aria-label="Агуулга">${body}</nav>
  ${footHtml({ page: pageNo, total: plan.totalPages, back: false, brand: true })}
</section>`;
}

// --- appendix: schedule ----------------------------------------------------------------------------

function monthLineHtml(line: MonthLine, fares: boolean): string {
  const text = `${line.label}: ${line.days.join(" · ")}`;
  const fare = fares ? ` <span class="sf">— ${line.fare != null ? escapeHtml(moneyMnt(line.fare)) : "үнэ лавлах"}</span>` : "";
  return `<div class="sl">${escapeHtml(text)}${fare}</div>`;
}

function scheduleBlockHtml(block: SchedBlock): string {
  const { card } = block.trip;
  return `<div class="sblock" id="${scheduleBlockId(card.code)}"><a class="sh" href="#${anchorId(card.code)}"><span class="sc">${escapeHtml(card.code)}</span><span class="st">${escapeHtml(dispTitle(block.trip))}</span><span class="sp">${block.trip.page}</span></a>${block.lines.map(l => monthLineHtml(l, block.priceVaries)).join("")}</div>`;
}

export function schedulePage(snapshot: CatalogueSnapshot, plan: PagePlan, assets: RenderAssets, index: number): string {
  const sp = plan.schedulePages[index];
  const pageNo = (plan.firstSchedulePage ?? 0) + index;
  const first = index === 0;
  const head = first
    ? `<div class="ahead"><span class="kick">Хавсралт · Хөдөлгөөний товлол</span><h2>Бүх огноо</h2><p class="asub">Одооноос хойших бүх хөдөлгөөн, 90 хоногоос цаашхи огноо ч орно. Аяллын нэр дээр дарж хуудас руу очно. Үнэ нь нэг том хүнд ногдох хэмжээ бөгөөд огнооноос хамаарах үнийг огноо бүрийн хажууд бичсэн.</p>${transportLegendHtml("light")}</div>`
    : `<div class="ahead small"><span class="kick">Хавсралт · Хөдөлгөөний товлол · үргэлжлэл</span></div>`;
  const cols = (sp?.columns ?? [[], []]).map(col => `<div class="acol">${col.map(scheduleBlockHtml).join("")}</div>`).join("");
  return `<section class="page appendix schedule"${first ? ` id="${SCHEDULE_ANCHOR}"` : ""} data-page="${pageNo}">
  ${head}
  <div class="acols">${cols}</div>
  ${footHtml({ page: pageNo, total: plan.totalPages, back: true })}
</section>`;
}

// --- appendix: index -------------------------------------------------------------------------------

function indexRowHtml(t: OrderedTrip): string {
  const { card } = t;
  const inq = card.price.kind === "inquire";
  return `<a class="irow" href="#${anchorId(card.code)}"><span class="ic">${escapeHtml(card.code)}</span><span class="it">${escapeHtml(dispTitle(t))}</span><span class="ip${inq ? " inq" : ""}">${escapeHtml(card.price.display)}</span><span class="ipg">${t.page}</span></a>`;
}

export function indexPage(snapshot: CatalogueSnapshot, plan: PagePlan, assets: RenderAssets, index: number): string {
  const rows = plan.indexPages[index] ?? [];
  const pageNo = (plan.firstIndexPage ?? 0) + index;
  const first = index === 0;
  const head = first
    ? `<div class="ahead"><span class="kick">Хавсралт · Кодын жагсаалт</span><h2>Бүх аялал</h2><p class="asub">Аяллын код, нэр, нэг том хүнд ногдох эхлэх үнэ, хуудас. Мөр дээр дарж аяллын хуудас руу очно.</p></div>`
    : `<div class="ahead small"><span class="kick">Хавсралт · Кодын жагсаалт · үргэлжлэл</span></div>`;
  return `<section class="page appendix index"${first ? ` id="${INDEX_ANCHOR}"` : ""} data-page="${pageNo}">
  ${head}
  <nav class="ilist" aria-label="Кодын жагсаалт">
    <div class="ihead"><span class="ic">Код</span><span class="it">Аялал</span><span class="ip">Эхлэх үнэ</span><span class="ipg">Хуудас</span></div>
    ${rows.map(indexRowHtml).join("\n")}
  </nav>
  ${footHtml({ page: pageNo, total: plan.totalPages, back: true })}
</section>`;
}

// --- closing ------------------------------------------------------------------------------------------

/** Staff-approved company-group statements: trimmed, de-duplicated, at most three short lines. */
export function corporateNotesOf(snapshot: CatalogueSnapshot): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of snapshot.contact.corporateNotes ?? []) {
    const line = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (!line || line.length > MAX_NOTE_CHARS || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
    if (out.length >= MAX_CORPORATE_NOTES) break;
  }
  return out;
}

export function closingPage(snapshot: CatalogueSnapshot, plan: PagePlan, assets: RenderAssets): string {
  const exampleCode = plan.trips[0]?.card.code ?? "A01";
  const phones = snapshot.contact.phones.map(p => p.trim()).filter(Boolean).slice(0, MAX_PHONES);
  const siteHref = safeHref(snapshot.contact.siteUrl);
  const siteLabel = snapshot.contact.siteLabel || snapshot.contact.siteUrl;
  const stamp = `Хувилбар ${escapeHtml(assets.versionLabel)} · ${escapeHtml(ulaanbaatarStamp(snapshot.generatedAt))}`;
  const steps: [string, string, string][] = [
    ["01", "Аяллын код", `Жишээ нь ${exampleCode}`],
    ["02", "Аялах хүний тоо", "Нийт хэдэн хүн явах вэ"],
    ["03", "Хүссэн сар", "Ойролцоо сар ч хангалттай"],
  ];
  const band = assets.closing && safeImageSrc(assets.closing.dataUri);
  const notes = corporateNotesOf(snapshot);
  const notesHtml = notes.length
    ? `<div class="corp"><span class="kick">Байгууллага, хамт олонд</span><ul>${notes.map(n => `<li>${escapeHtml(n)}</li>`).join("")}</ul></div>`
    : "";
  return `<section class="page closing${notes.length || !band ? " compact" : ""}" id="closing" data-page="${plan.closingPage}">
  <div class="band${band ? "" : " plain"}">${band ? imageTag(assets.closing, "") : `<span class="bk">UUDAM Travel · Байгууллагын аялал</span>`}</div>
  ${logoCorner(assets, "closing")}
  <div class="body">
    <span class="kick">Хамт олондоо зориулсан санал</span>
    <h2 data-fit-min="${px(28)}" data-fit-maxh="${px(40 * 1.08 * 2)}">Үнийн санал авах</h2>
    <p class="intro">Сонирхсон аяллынхаа код, хүний тоо, хүссэн сараа бидэнд бичээрэй. Манай ажилтан таны багийн хэмжээ, сард тохирсон үнийн санал бэлтгэж хариулна.</p>
    <div class="steps">${steps.map(([n, t, s]) => `<div class="step"><span class="n">${n}</span><div class="t">${escapeHtml(t)}<span>${escapeHtml(s)}</span></div></div>`).join("")}</div>
    <div class="reply"><span class="rl">Мессежийн жишээ</span><span class="sample">${escapeHtml(exampleCode)}, ${SAMPLE_SIZE_AND_MONTH}</span></div>
    ${notesHtml}
    <div class="contact"><div><span class="kick">Холбоо барих</span><div class="phones">${phones.map(p => `<span>${escapeHtml(p)}</span>`).join("")}</div></div>${
      siteLabel ? `<div class="site">${siteHref ? `<a href="${escapeHtml(siteHref)}">${escapeHtml(siteLabel)}</a>` : escapeHtml(siteLabel)}</div>` : ""
    }</div>
    <div class="fine"><p>${DISCLAIMER}</p><p>Каталог дахь үнэ нь нэг том хүнд ногдох эхлэх үнэ. ${GROUP_PRICE_NOTE}.</p><p class="stamp">${stamp}</p></div>
  </div>
  ${footHtml({ page: plan.closingPage, total: plan.totalPages, back: true })}
</section>`;
}

export { RUNNING_TITLE };
