/**
 * The pages around the trips: the cover, the dark category section pages that list each section's
 * trips, and the closing page. The approved UUDAM logo sits flush in a corner (never inside a tile).
 */
import type { CatalogueSnapshot } from "../types";
import {
  DISCLAIMER,
  GROUP_PRICE_NOTE,
  anchorId,
  cardTitle,
  chapterAnchorId,
  pad2,
  ulaanbaatarStamp,
  type ChapterPlan,
  type OrderedTrip,
  type PagePlan,
} from "./layout";
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
  <div class="panelbg" style="top:400pt"></div>
  <div class="photo">${imageTag(cover.image, "")}</div>
  ${logo}${block}${caption}
</section>`;
  }
  return `<section class="page cover dark" id="cover" data-page="1">
  ${imageTag(cover.image, "", "bg")}
  ${logo}${block}${caption}
</section>`;
}

// --- sections: one dark category page (or two) listing its trips ---------------------------------

const GUIDE_ID = "contents";

/** The categories as a row of links, the current one marked: every section page is also the contents. */
function sectionNav(plan: PagePlan, current: number): string {
  if (plan.chapters.length < 2) return "";
  const items = plan.chapters
    .map(c => `<a class="sn t-${c.kind}${c.index === current ? " on" : ""}" href="#${chapterAnchorId(c.index)}"><i class="tdot"></i>${escapeHtml(c.label)}<b>${c.trips.length}</b></a>`)
    .join("");
  return `<nav class="snav" aria-label="Ангилал">${items}</nav>`;
}

/** Characters a card title may take before it is shortened at a word (the full title is on the trip page). */
const CARD_TITLE_MAX: Record<ChapterPlan["density"], number> = { large: 50, roomy: 32, compact: 40 };

/** The title as one or two lines of a list card: cut at the last word that fits, never mid-word unless it must. */
export function cardTitleShort(title: string, max: number): string {
  const chars = [...title];
  if (chars.length <= max) return title;
  const cut = chars.slice(0, max - 1).join("");
  const at = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("–"), cut.lastIndexOf("("));
  return `${(at >= max * 0.55 ? cut.slice(0, at) : cut).replace(/[\s,–—(-]+$/u, "")}…`;
}

function sectionCard(t: OrderedTrip, assets: RenderAssets, density: ChapterPlan["density"]): string {
  const { card } = t;
  const art = assets.trips[card.tripId];
  const thumb = art?.thumb && safeImageSrc(art.thumb.dataUri) ? art.thumb : null;
  const photo = thumb ? `<span class="sth">${imageTag(thumb, "")}</span>` : `<span class="sth mono">${escapeHtml(card.code)}</span>`;
  const inq = card.price.kind === "inquire";
  const dur = card.durationText.trim();
  const title = escapeHtml(cardTitleShort(dispTitle(t), CARD_TITLE_MAX[density]));
  const code = `<span class="sc">${escapeHtml(card.code)}</span>`;
  const price = `<span class="spr${inq ? " inq" : ""}">${escapeHtml(card.price.display)}</span>`;
  // A compact card has no room for the duration line: the code moves next to the price.
  const top = density === "compact" ? "" : `<span class="stop">${code}${dur ? `<span class="sdur">${escapeHtml(dur)}</span>` : ""}</span>`;
  const bottom = density === "compact" ? `<span class="sbot"><span class="sleft">${code}${price}</span><span class="spg">${pad2(t.page)}</span></span>` : `<span class="sbot">${price}<span class="spg">${pad2(t.page)}</span></span>`;
  return `<a class="scard" href="#${anchorId(card.code)}">${photo}<span class="sbody">${top}<span class="stt">${title}</span>${bottom}</span></a>`;
}

export function sectionPage(snapshot: CatalogueSnapshot, plan: PagePlan, assets: RenderAssets, chapter: ChapterPlan, part: number): string {
  const trips = chapter.listPages[part] ?? [];
  const pageNo = chapter.sectionPage + part;
  const first = part === 0;
  const contents = first && chapter.index === 0;
  const band = first ? assets.chapters[chapter.index] : undefined;
  const num = `${pad2(chapter.index + 1)} / ${pad2(plan.chapters.length)}`;
  const count = chapter.trips.length;
  const head = first
    ? `<div class="shead"><div class="snum">${num}</div><h2 data-fit-min="${px(26)}" data-fit-maxh="${px(40 * 1.08 * 2)}">${escapeHtml(chapter.label)}</h2><div class="srule"></div><p class="sline">${count} аялал${chapter.line ? `<i>·</i>${escapeHtml(chapter.line)}` : ""}</p></div>`
    : `<div class="shead small"><div class="snum">${num} · үргэлжлэл</div><h2>${escapeHtml(chapter.label)}</h2><div class="srule"></div></div>`;
  const ids = [contents ? GUIDE_ID : "", first ? chapterAnchorId(chapter.index) : ""].filter(Boolean);
  // Two anchors on one page: the outer wrapper carries the chapter anchor.
  const idAttr = ids[0] ? ` id="${ids[0]}"` : "";
  const inner = ids[1] ? `<span class="anchor" id="${ids[1]}"></span>` : "";
  const cls = ["page", "section", "dark", chapter.density, band ? "photo" : "bare", first ? "" : "cont"].filter(Boolean).join(" ");
  return `<section class="${cls}"${idAttr} data-page="${pageNo}" data-transport="${chapter.kind}">
  ${inner}
  ${band ? `<div class="sband">${imageTag(band.image, "")}</div>` : ""}
  ${first ? sectionNav(plan, chapter.index) : ""}
  ${head}
  <nav class="slist" aria-label="${escapeHtml(chapter.label)}">${trips.map(t => sectionCard(t, assets, chapter.density)).join("")}</nav>
  ${footHtml({ page: pageNo, total: plan.totalPages, back: !contents, brand: contents, credit: band?.credit ?? "" })}
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
  // A book with no trips has no section page: the cover's contents link lands here, with a plain notice.
  const empty = plan.chapters.length === 0;
  return `<section class="page closing${notes.length || !band ? " compact" : ""}" id="closing" data-page="${plan.closingPage}">
  ${empty ? `<span class="anchor" id="${GUIDE_ID}"></span>` : ""}
  <div class="band${band ? "" : " plain"}">${band ? imageTag(assets.closing, "") : `<span class="bk">UUDAM Travel · Байгууллагын аялал</span>`}</div>
  ${logoCorner(assets, "closing")}
  <div class="body">
    <span class="kick">Хамт олондоо зориулсан санал</span>
    <h2 data-fit-min="${px(28)}" data-fit-maxh="${px(40 * 1.08 * 2)}">Үнийн санал авах</h2>
    ${empty ? `<p class="intro">Одоогоор санал болгох аялал алга. Манай ажилтнаас лавлана уу.</p>` : ""}
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
