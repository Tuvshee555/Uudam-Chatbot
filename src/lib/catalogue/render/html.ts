/**
 * CatalogueSnapshot -> one self-contained HTML document (cover, contents, one page per trip,
 * closing page). Pure and browser-free, so it is unit-testable; the browser only prints it.
 *
 * Everything dynamic is HTML-escaped, every URL is checked, and the document carries a CSP that
 * forbids scripts and any non-data: resource.
 */
import type { CatalogueSnapshot, CatalogueTripCard } from "../types";
import {
  DISCLAIMER,
  GROUP_PRICE_NOTE,
  HEADLINE_MIN_PT,
  PRICE_LABEL,
  anchorId,
  departureLabel,
  dotDay,
  headlineSizePt,
  pad2,
  planPages,
  ulaanbaatarStamp,
  type OrderedTrip,
  type PagePlan,
} from "./layout";
import type { RenderAssets, RenderImage } from "./renderTypes";
import { displayTitle } from "./titleCase";
import { buildCss } from "./theme";

export const CATALOGUE_TITLE = "ХАМТ ОЛНЫ АЯЛЛЫН СОНГОЛТ";
const RUNNING_TITLE = "Байгууллагын аяллын сонголт";
const SAMPLE_SIZE_AND_MONTH = "25 хүн, 1-р сар";
const MAX_PHONES = 3;

const PX_PER_PT = 4 / 3;
const px = (pt: number) => Math.round(pt * PX_PER_PT * 100) / 100;

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only absolute http(s) URLs may become links; anything else is dropped. */
export function safeHref(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Image sources are produced by our own pipeline; refuse anything that is not a plain data URI. */
function safeImageSrc(dataUri: string): string {
  return /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(dataUri) ? dataUri : "";
}

const EDITION_LABEL: Record<CatalogueSnapshot["edition"], string> = {
  quick: "Хурдан сонголт",
  complete: "Бүрэн каталог",
  preview: "Танилцуулга",
};

// --- pieces ------------------------------------------------------------------------------------

function logoTile(assets: RenderAssets): string {
  const src = safeImageSrc(assets.logoDataUri);
  return `<div class="logo-tile">${src ? `<img class="logo" src="${src}" alt="UUDAM Travel Agency">` : ""}</div>`;
}

type FootOptions = { page: number; total: number; sub: string; logo: boolean; back: boolean };

function footHtml(assets: RenderAssets, o: FootOptions): string {
  return `<footer class="foot">${o.logo ? logoTile(assets) : ""}
  <div class="foot-text"><span class="foot-title">UUDAM Travel</span><span class="foot-sub">${escapeHtml(o.sub)}</span></div>
  <div class="foot-nav">${o.back ? `<a class="back" href="#contents">Агуулга</a>` : ""}<span class="pn">${pad2(o.page)} <small>/ ${pad2(o.total)}</small></span></div>
</footer>`;
}

function imageTag(img: RenderImage, alt: string, cls: string): string {
  const src = safeImageSrc(img.dataUri);
  return src ? `<img class="${cls}" src="${src}" width="${img.width}" height="${img.height}" alt="${escapeHtml(alt)}">` : "";
}

function pickCover(snapshot: CatalogueSnapshot, plan: PagePlan, assets: RenderAssets): { tripId: string; image: RenderImage; card: CatalogueTripCard } | null {
  if (assets.cover) {
    const card = snapshot.trips.find(t => t.tripId === assets.cover!.tripId);
    if (card) return { tripId: card.tripId, image: assets.cover.image, card };
  }
  // No dedicated cover crop: reuse the first trip hero that exists.
  for (const t of plan.trips) {
    const img = assets.heroes[t.card.tripId];
    if (img) return { tripId: t.card.tripId, image: img, card: t.card };
  }
  return null;
}

/** Highest-resolution trip among the first few, so the cover hero is the sharpest one on offer. */
export function pickCoverTripId(snapshot: CatalogueSnapshot, heroes: Record<string, RenderImage | null>): string | null {
  const plan = planPages(snapshot);
  let best: { id: string; w: number } | null = null;
  for (const t of plan.trips.slice(0, 8)) {
    const img = heroes[t.card.tripId];
    if (!img) continue;
    if (!best || img.sourceCropWidth > best.w) best = { id: t.card.tripId, w: img.sourceCropWidth };
  }
  return best?.id ?? null;
}

// --- pages -------------------------------------------------------------------------------------

function coverPage(snapshot: CatalogueSnapshot, plan: PagePlan, assets: RenderAssets): string {
  const cover = pickCover(snapshot, plan, assets);
  const exampleCount = snapshot.trips.length;
  const lede = exampleCount > 0
    ? `Байгууллага, хамт олны аяллын ${exampleCount} сонголт. Сонирхсон аяллынхаа кодыг бидэнд бичээрэй.`
    : "Байгууллага, хамт олны аяллын сонголтууд. Сонирхсон аяллынхаа кодыг бидэнд бичээрэй.";
  const heroInner = cover
    ? imageTag(cover.image, displayTitle(cover.card.title), "photo")
    : `<div class="ph"><div class="ph-kicker">Аяллын сонголт</div><div class="ph-line"></div></div>`;
  const captionText = cover ? cover.card.kicker.trim() || displayTitle(cover.card.title) : "";
  const credit = cover?.card.photo?.credit?.trim();
  const caption = cover
    ? `<div class="caption"><em>${escapeHtml(captionText)}</em><span>${credit ? `Фото: ${escapeHtml(credit)}` : ""}</span></div>`
    : "";
  return `<section class="page cover" id="cover" data-page="1">
  <header class="masthead">${logoTile(assets)}<div class="mast-r"><span class="season">${escapeHtml(snapshot.seasonLabel)}</span><span class="issue">Гарсан огноо: ${escapeHtml(snapshot.issueLabel)}</span></div></header>
  <div class="hero">${heroInner}</div>
  ${caption}
  <div class="titleblock">
    <div class="kicker label">UUDAM Travel · ${escapeHtml(EDITION_LABEL[snapshot.edition])}</div>
    <h1 data-fit-min="${px(30)}" data-fit-maxh="${px(50 * 1.04 * 3)}">${CATALOGUE_TITLE}</h1>
    <div class="accent-rule"></div>
    <p class="lede">${escapeHtml(lede)}</p>
  </div>
  ${footHtml(assets, { page: 1, total: plan.totalPages, sub: snapshot.contact.siteLabel || RUNNING_TITLE, logo: false, back: false })}
</section>`;
}

function contentsRow(t: OrderedTrip): string {
  const { card } = t;
  const meta = [card.durationText, card.transportLabel].filter(s => s && s.trim()).join(" · ");
  const inq = card.price.kind === "inquire";
  return `<a class="crow" href="#${anchorId(card.code)}"><span class="crow-code">${escapeHtml(card.code)}</span><span class="crow-main"><span class="crow-title">${escapeHtml(displayTitle(card.title))}</span><span class="crow-meta">${escapeHtml(meta)}</span></span><span class="crow-price${inq ? " inq" : ""}">${escapeHtml(card.price.display)}</span><span class="crow-page">${pad2(t.page)}</span></a>`;
}

function contentsPage(snapshot: CatalogueSnapshot, plan: PagePlan, assets: RenderAssets, index: number): string {
  const items = plan.contentsPages[index] ?? [];
  const pageNo = plan.firstContentsPage + index;
  const first = index === 0;
  const exampleCode = plan.trips[0]?.card.code ?? "A01";
  const head = first
    ? `<div class="chead" id="contents"><div class="label">Аяллын жагсаалт</div><h2>Агуулга</h2><p class="csub">Сонирхсон аяллынхаа кодыг бичээрэй, жишээ нь <span style="white-space:nowrap">“${escapeHtml(exampleCode)}, ${SAMPLE_SIZE_AND_MONTH}”</span>. Үнэ нь нэг том хүнд ногдох эхлэх үнэ.</p></div>`
    : `<div class="chead small"><div class="label">Агуулга · үргэлжлэл</div><h2>Аяллын жагсаалт</h2></div>`;
  const body = items.length === 0
    ? `<p class="csub">Одоогоор санал болгох аялал алга. Манай ажилтнаас лавлана уу.</p>`
    : items
        .map(item =>
          item.kind === "group"
            ? `<div class="cgroup"><span class="label">${escapeHtml(item.label)}${item.continued ? " · үргэлжлэл" : ""}</span></div>`
            : contentsRow(item.trip),
        )
        .join("\n");
  return `<section class="page contents" data-page="${pageNo}">
  ${head}
  <nav class="clist dens-${plan.contentsDensity}" aria-label="Агуулга">${body}</nav>
  ${footHtml(assets, { page: pageNo, total: plan.totalPages, sub: RUNNING_TITLE, logo: true, back: false })}
</section>`;
}

function tripPage(snapshot: CatalogueSnapshot, plan: PagePlan, assets: RenderAssets, t: OrderedTrip): string {
  const { card } = t;
  const hero = assets.heroes[card.tripId] ?? null;
  const title = displayTitle(card.title);
  const size = headlineSizePt(title);
  const lines = size >= 36 ? 2 : 3;
  const credit = hero ? card.photo?.credit?.trim() : undefined; // a credit only goes with a photo that is printed
  const heroInner = hero
    ? imageTag(hero, title, "photo")
    : `<div class="ph"><div class="ph-kicker">${escapeHtml(card.kicker.trim() || title)}</div><div class="ph-line"></div></div>`;
  const facts = [
    card.durationText.trim() ? ["Хугацаа", card.durationText] : null,
    card.transportLabel.trim() ? ["Тээвэр", card.transportLabel] : null,
    t.groupLabel.trim() ? ["Төрөл", t.groupLabel] : null,
  ].filter((f): f is string[] => f !== null);
  const factsHtml = facts.length
    ? `<dl class="facts" style="grid-template-columns:${facts.map((_, i) => (i === facts.length - 1 ? "minmax(0,1fr)" : "auto")).join(" ")}">${facts
        .map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`)
        .join("")}</dl>`
    : "";
  const highlights = card.highlights.map(h => h.trim()).filter(Boolean).slice(0, 3);
  const highlightsHtml = highlights.length
    ? `<ul class="highlights" data-fit-min="${px(11)}" data-fit-maxh="${px(150)}">${highlights.map(h => `<li>${escapeHtml(h)}</li>`).join("")}</ul>`
    : "";
  const inq = card.price.kind === "inquire";
  const href = safeHref(card.detailUrl);
  return `<section class="page trip" id="${anchorId(card.code)}" data-page="${t.page}" data-code="${escapeHtml(card.code)}">
  <div class="hero">${heroInner}<div class="tab"><span class="label">Код</span><span class="tab-code">${escapeHtml(card.code)}</span></div></div>
  <div class="body">
    <div class="eyebrow"><span class="label">${escapeHtml(card.kicker)}</span><span class="credit">${credit ? `Фото: ${escapeHtml(credit)}` : ""}</span></div>
    <h2 class="headline" style="font-size:${size}pt" data-fit-min="${px(HEADLINE_MIN_PT)}" data-fit-maxh="${px(size * 1.07 * lines)}">${escapeHtml(title)}</h2>
    ${factsHtml}
    ${highlightsHtml}
    <div class="pricerow">
      <div class="pl"><span class="label muted">${escapeHtml(PRICE_LABEL)}</span><span class="price${inq ? " inq" : ""}">${escapeHtml(card.price.display)}</span></div>
      <div class="pr"><span class="label muted">Явах огноо</span><span class="dateline">${escapeHtml(departureLabel(card))}</span></div>
    </div>
    <div class="groupnote">${GROUP_PRICE_NOTE}${href ? `<a href="${escapeHtml(href)}">Сайт дээрх дэлгэрэнгүй</a>` : ""}</div>
  </div>
  ${footHtml(assets, { page: t.page, total: plan.totalPages, sub: t.groupLabel || RUNNING_TITLE, logo: true, back: true })}
</section>`;
}

function chooseGuide(snapshot: CatalogueSnapshot): string {
  const groups = snapshot.groups.filter(g => g.codes.length > 0);
  const codeCount = groups.reduce((n, g) => n + g.codes.length, 0);
  if (groups.length < 2 || groups.length > 6 || codeCount > 16) return "";
  return `<div class="choose" data-optional><div class="label">Сонголтын чиглэл</div><ul>${groups
    .map(g => `<li><b>${escapeHtml(g.label)}</b><span>${escapeHtml(g.codes.join(", "))}</span></li>`)
    .join("")}</ul></div>`;
}

function closingPage(snapshot: CatalogueSnapshot, plan: PagePlan, assets: RenderAssets): string {
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
  return `<section class="page closing" id="closing" data-page="${plan.closingPage}">
  <div class="top">${logoTile(assets)}<div class="aside"><span class="season">${escapeHtml(snapshot.seasonLabel)}</span><span class="issue">Гарсан огноо: ${escapeHtml(snapshot.issueLabel)}</span></div></div>
  <h2 data-fit-min="${px(26)}" data-fit-maxh="${px(40 * 1.06 * 3)}">Үнийн санал авах</h2>
  <p class="intro">Сонирхсон аяллаа сонгоод доорх гурван зүйлийг бидэнд бичээрэй. Манай ажилтан таны хүсэлтэд тохирсон үнийн санал бэлтгэж хариулна.</p>
  <div class="steps">${steps
    .map(([n, t, s]) => `<div class="step"><span class="n">${n}</span><div class="t">${escapeHtml(t)}<span>${escapeHtml(s)}</span></div></div>`)
    .join("")}</div>
  <div class="example"><span class="label muted">Мессежийн жишээ</span><span class="sample">${escapeHtml(exampleCode)}, ${SAMPLE_SIZE_AND_MONTH}</span></div>
  ${chooseGuide(snapshot)}
  <div class="contact"><div><div class="label">Холбоо барих</div><div class="phones">${phones.map(p => `<span>${escapeHtml(p)}</span>`).join("")}</div></div>${
    siteLabel ? `<div class="site">${siteHref ? `<a href="${escapeHtml(siteHref)}">${escapeHtml(siteLabel)}</a>` : escapeHtml(siteLabel)}</div>` : ""
  }</div>
  <div class="fine"><p>${DISCLAIMER}</p><p>Каталог дахь үнэ нь нэг том хүнд ногдох эхлэх үнэ. ${GROUP_PRICE_NOTE}.</p><p class="stamp">${stamp}</p></div>
  ${footHtml(assets, { page: plan.closingPage, total: plan.totalPages, sub: RUNNING_TITLE, logo: false, back: true })}
</section>`;
}

// --- document ----------------------------------------------------------------------------------

export function catalogueDocumentTitle(snapshot: CatalogueSnapshot): string {
  return `UUDAM Travel · ${CATALOGUE_TITLE} · ${snapshot.issueLabel}`;
}

export function buildCatalogueHtml(snapshot: CatalogueSnapshot, assets: RenderAssets): string {
  const plan = planPages(snapshot);
  const pages = [
    coverPage(snapshot, plan, assets),
    ...plan.contentsPages.map((_, i) => contentsPage(snapshot, plan, assets, i)),
    ...plan.trips.map(t => tripPage(snapshot, plan, assets, t)),
    closingPage(snapshot, plan, assets),
  ];
  return `<!doctype html>
<html lang="mn">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'">
<meta name="viewport" content="width=720">
<meta name="author" content="UUDAM Travel">
<title>${escapeHtml(catalogueDocumentTitle(snapshot))}</title>
<style>${buildCss(assets.fonts)}</style>
</head>
<body>
${pages.join("\n")}
</body>
</html>`;
}
