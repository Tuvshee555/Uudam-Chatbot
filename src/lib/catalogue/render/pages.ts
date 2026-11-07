/**
 * The pages around the trips: cover, chapter openers, the destination guide (contents) and the
 * closing page. Same system as the trip pages: ivory paper, deep navy, one teal, serif display
 * type, generous space, the original UUDAM logo only on a clean paper tile.
 */
import type { CatalogueSnapshot } from "../types";
import {
  DISCLAIMER,
  GROUP_PRICE_NOTE,
  anchorId,
  cardTitle,
  chapterAnchorId,
  contentsRowLine,
  dotDay,
  pad2,
  ulaanbaatarStamp,
  type ChapterPlan,
  type ContentsItem,
  type OrderedTrip,
  type PagePlan,
} from "./layout";
import { escapeHtml, footHtml, imageTag, logoTile, px, safeHref, safeImageSrc } from "./htmlParts";
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
  const tile = logoTile(assets);
  if (!cover) {
    return `<section class="page cover bare dark" id="cover" data-page="1">${tile}${block}${caption}</section>`;
  }
  if (cover.mode === "plate") {
    return `<section class="page cover coverplate dark" id="cover" data-page="1">
  <div class="panelbg" style="top:700pt"></div>
  <div class="photo">${imageTag(cover.image, "")}</div>
  ${tile}${block}${caption}
</section>`;
  }
  return `<section class="page cover dark" id="cover" data-page="1">
  ${imageTag(cover.image, "", "bg")}
  ${tile}${block}${caption}
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

// --- contents: the destination guide ----------------------------------------------------------------

function contentsRow(assets: RenderAssets, t: OrderedTrip): string {
  const { card } = t;
  const title = dispTitle(t);
  const thumb = assets.trips[card.tripId]?.thumb;
  const thumbHtml = thumb && safeImageSrc(thumb.dataUri)
    ? `<span class="th">${imageTag(thumb, "")}</span>`
    : `<span class="th mono">${escapeHtml([...title][0] ?? "")}</span>`;
  const inq = card.price.kind === "inquire";
  return `<a class="crow" href="#${anchorId(card.code)}">${thumbHtml}<span class="main"><span class="ttl">${escapeHtml(title)}</span><span class="ln">${escapeHtml(contentsRowLine(t.card))}</span></span><span class="pr"><span class="amt${inq ? " inq" : ""}">${escapeHtml(card.price.display)}</span><span class="code">${escapeHtml(card.code)}</span></span><span class="pg">${pad2(t.page)}</span></a>`;
}

function groupHeader(plan: PagePlan, item: Extract<ContentsItem, { kind: "group" }>): string {
  const chapter = plan.chapters[item.chapter];
  const target = chapter?.openerPage != null ? `#${chapterAnchorId(item.chapter)}` : chapter?.trips[0] ? `#${anchorId(chapter.trips[0].card.code)}` : "#contents";
  return `<a class="cgroup" href="${target}"><span class="gnum">${pad2(item.chapter + 1)}</span><span class="gname">${escapeHtml(item.label)}${item.continued ? ` <small>· үргэлжлэл</small>` : ""}</span><span class="gpage">${pad2(item.page)}</span></a>`;
}

export function contentsPage(snapshot: CatalogueSnapshot, plan: PagePlan, assets: RenderAssets, index: number): string {
  const items = plan.contentsPages[index] ?? [];
  const pageNo = plan.firstContentsPage + index;
  const first = index === 0;
  const exampleCode = plan.trips[0]?.card.code ?? "A01";
  const head = first
    ? `<div class="chead"><div class="toprow"><span class="kick">Агуулга</span>${logoTile(assets)}</div><h2>Хаашаа аялах вэ?</h2><p class="csub">Сонирхсон аяллынхаа кодыг бидэнд бичээрэй, жишээ нь <b>“${escapeHtml(exampleCode)}, ${SAMPLE_SIZE_AND_MONTH}”</b>. Үнэ нь нэг том хүнд ногдох эхлэх үнэ.</p></div>`
    : `<div class="chead small"><span class="kick">Агуулга · үргэлжлэл</span><h2>Хаашаа аялах вэ?</h2></div>`;
  const body = items.length === 0
    ? `<p class="csub">Одоогоор санал болгох аялал алга. Манай ажилтнаас лавлана уу.</p>`
    : items.map(item => (item.kind === "group" ? groupHeader(plan, item) : contentsRow(assets, item.trip))).join("\n");
  return `<section class="page contents"${first ? ` id="contents"` : ""} data-page="${pageNo}">
  ${head}
  <nav class="clist dens-${plan.contentsDensity}" aria-label="Агуулга">${body}</nav>
  ${footHtml({ page: pageNo, total: plan.totalPages, back: false, brand: true })}
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
  const stamp = `Хувилбар: ${escapeHtml(assets.versionLabel)} · Үүсгэсэн: ${escapeHtml(ulaanbaatarStamp(snapshot.generatedAt))} (Улаанбаатар) · Огноо: ${escapeHtml(dotDay(snapshot.asOfDay))}`;
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
  ${logoTile(assets)}
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
