/**
 * Trip pages: one data model, five compositions (cinema, plate, panorama, diptych, type). Every
 * composition prints the same facts in the same order of importance: where (kicker + code),
 * what (editorial headline), how long and how (meta), why (one standfirst + a flowing line of
 * notes), how much and when (price + dates). Only the staging changes, so the book has rhythm
 * without losing its identity.
 */
import type { CatalogueSnapshot, CatalogueTripCard } from "../types";
import {
  HEADLINE_MIN_PT,
  PRICE_LABEL,
  anchorId,
  scheduleBlockId,
  cardTitle,
  clipHighlight,
  headlineSizePt,
  priceParts,
  type OrderedTrip,
  type PagePlan,
} from "./layout";
import { NEXT_DEPARTURE_LABEL, PRICE_VARIES_NOTE, TRIP_GRID_DENSE_DATES, TRIP_GRID_MAX_ROWS, tripDates, type MonthLine } from "./dates";
import { creditLine, escapeHtml, footHtml, imageTag, px } from "./htmlParts";
import type { RenderAssets, TripArt, TripComposition } from "./renderTypes";
import { displayTitle } from "./titleCase";

const SEP = `<i>·</i>`;

const HEAD_CAP_PT: Record<TripComposition, number> = { cinema: 48, plate: 44, panorama: 42, diptych: 31, type: 58 };
const HEAD_LINES: Record<TripComposition, number> = { cinema: 3, plate: 3, panorama: 3, diptych: 4, type: 4 };

function headline(title: string, composition: TripComposition): string {
  const size = Math.min(headlineSizePt(title), HEAD_CAP_PT[composition]);
  const lines = HEAD_LINES[composition];
  const minPt = composition === "diptych" ? 21 : HEADLINE_MIN_PT;
  return `<h2 class="headline" style="font-size:${size}pt" data-fit-min="${px(minPt)}" data-fit-maxh="${px(Math.round(size * 1.1 * lines * 10) / 10)}">${escapeHtml(title)}</h2>`;
}

function eyebrow(card: CatalogueTripCard, groupLabel: string, title: string): string {
  const kick = card.kicker.trim();
  // A kicker that only repeats the headline says nothing: the chapter name stands in for it.
  const kicker = !kick || kick.toLocaleLowerCase("mn") === title.trim().toLocaleLowerCase("mn") ? groupLabel : kick;
  return `<div class="eyebrow"><span class="kick">${escapeHtml(kicker)}</span><span class="code">${escapeHtml(card.code)}</span></div>`;
}

function metaLine(card: CatalogueTripCard): string {
  const parts = [card.durationText, card.transportLabel].map(s => s.trim()).filter(Boolean);
  return parts.length ? `<p class="meta">${parts.map(escapeHtml).join(SEP)}</p>` : "";
}

/** One standfirst in italic serif, the rest as one flowing line. Short, real, from the data. */
function highlightsHtml(card: CatalogueTripCard): { lede: string; notes: string } {
  const lines = card.highlights.map(h => clipHighlight(h)).filter(Boolean).slice(0, 3);
  const lede = lines[0] ? `<p class="lede">${escapeHtml(lines[0])}</p>` : "";
  const rest = lines.slice(1);
  const notes = rest.length ? `<p class="notes">${rest.map(escapeHtml).join(SEP)}</p>` : "";
  return { lede, notes };
}

function monthRowHtml(line: MonthLine, chips: boolean): string {
  const name = `<span class="mn">${escapeHtml(line.label)}:</span>`;
  if (!chips) return `<div class="ml">${name}<span class="md">${line.days.join(" · ")}</span></div>`;
  return `<div class="ml">${name}<span class="md chips">${line.days.map(d => `<span class="chip">${d}</span>`).join("")}</span></div>`;
}

/** Price (starting fare, never implied for every date) and the departures of the next 90 days. */
function priceAndDates(card: CatalogueTripCard, asOfDay: string, plan: PagePlan): string {
  const inq = card.price.kind === "inquire";
  const parts = priceParts(card.price.display);
  const priceHtml = inq ? `<span class="price inq">${escapeHtml(card.price.display)}</span>` : `<span class="price">${escapeHtml(parts.amount)}${parts.suffix ? `<small>${escapeHtml(parts.suffix)}</small>` : ""}</span>`;
  const d = tripDates(card, asOfDay);
  const note = d.priceVaries && !inq ? `<span class="pnote">${escapeHtml(PRICE_VARIES_NOTE)}</span>` : "";
  const pricerow = `<div class="pricerow"><div class="pl"><span class="plab">${escapeHtml(PRICE_LABEL)}</span>${priceHtml}</div>${note}</div>`;

  const blockPage = plan.schedulePageByCode[card.code];
  const all = blockPage != null ? `<a class="dall" href="#${scheduleBlockId(card.code)}">Бүх огноо · ${blockPage}-р хуудас</a>` : "";
  let label: string;
  let body: string;
  if (d.kind === "lines" || d.kind === "grid") {
    const chips = d.kind === "grid";
    const dense = d.windowCount > TRIP_GRID_DENSE_DATES;
    const rows = dense ? d.lines.slice(0, TRIP_GRID_MAX_ROWS - 1) : d.lines;
    label = d.windowCount === 1 && !all ? "Хөдлөх огноо" : "Ойрын 90 хоногийн огноо";
    body = rows.map(l => monthRowHtml(l, chips)).join("");
    if (dense) body += `<div class="ml more"><span class="mn">Цаашид:</span><span class="md">${all ? "бүх огноог товлолоос харна уу" : "огноог ажилтнаас лавлана"}</span></div>`;
  } else if (d.kind === "next") {
    label = `${NEXT_DEPARTURE_LABEL}:`;
    body = `<div class="ml next"><span class="md">${escapeHtml(d.nextFull ?? "")}</span></div>`;
  } else {
    label = "Явах огноо";
    body = `<div class="ml plain"><span class="md">${escapeHtml(d.plain)}</span></div>`;
  }
  const rec = d.recurring ? `<p class="drec">${escapeHtml(d.recurring)}</p>` : "";
  const dates = `<div class="dates"><div class="dhead"><span class="dlab">${escapeHtml(label)}</span>${all}</div>${body}${rec}</div>`;
  return `<div class="pd">${pricerow}${dates}</div>`;
}

function credits(card: CatalogueTripCard, art: TripArt): string {
  if (!art.hero) return "";
  return creditLine([card.photo?.credit, art.second ? card.gallery?.[0]?.credit : null]);
}

export function tripPage(snapshot: CatalogueSnapshot, plan: PagePlan, assets: RenderAssets, t: OrderedTrip): string {
  const { card } = t;
  const art: TripArt = assets.trips[card.tripId] ?? { composition: "type", hero: null, second: null, thumb: null };
  const composition: TripComposition = art.hero ? art.composition : "type";
  const title = displayTitle(cardTitle(card));
  const head = headline(title, composition);
  const eye = eyebrow(card, t.groupLabel, title);
  const meta = metaLine(card);
  const { lede, notes } = highlightsHtml(card);
  const price = priceAndDates(card, snapshot.asOfDay, plan);
  const foot = footHtml({ page: t.page, total: plan.totalPages, back: true, credit: credits(card, art) });
  const open = `<section class="page trip ${composition}${composition === "cinema" || composition === "type" ? " on-dark" : ""}${composition === "type" ? " dark" : ""}" id="${anchorId(card.code)}" data-page="${t.page}" data-code="${escapeHtml(card.code)}" data-composition="${composition}">`;

  switch (composition) {
    case "cinema":
      return `${open}
  ${imageTag(art.hero, title, "bg")}
  <div class="over">${eye}${head}${meta}${lede}${notes}${price}</div>
  ${foot}
</section>`;
    case "panorama":
      return `${open}
  <div class="head">${eye}${head}</div>
  <div class="photo">${imageTag(art.hero, title)}</div>
  <div class="text">${meta}${lede}${notes}${price}</div>
  ${foot}
</section>`;
    case "diptych":
      return `${open}
  <div class="photo">${imageTag(art.hero, title)}<div class="inset">${imageTag(art.second, `${title} · 2`)}</div></div>
  <div class="panel"><div class="col">${eye}${head}${meta}</div><div class="below">${lede}${notes}${price}</div></div>
  ${foot}
</section>`;
    case "plate":
      return `${open}
  <div class="photo">${imageTag(art.hero, title)}</div>
  <div class="text">${eye}${head}${meta}${lede}${notes}${price}</div>
  ${foot}
</section>`;
    default:
      return `${open}
  <div class="over">${eye}<div class="mid">${head}<div class="rule"></div>${meta}${lede}${notes}</div>${price}</div>
  ${foot}
</section>`;
  }
}
