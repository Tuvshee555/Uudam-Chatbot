/**
 * The catalogue's visual system as one stylesheet: a travel book, not a report.
 *
 * Warm ivory paper, deep charcoal-navy type, ONE muted teal for labels, a sand-gold hairline on
 * dark surfaces. Noto Serif Light for display type, Noto Serif Regular/Italic for reading lines,
 * Noto Sans for facts. All sizes are in pt so the PDF page (540 x 960 pt) and the 810 x 1440 px
 * preview share one layout.
 *
 * Rules the stylesheet keeps on purpose:
 *  - no filters, blend modes, opacity or shadows (they would rasterise the page); every scrim is
 *    baked into the photo's JPEG, text over a photo stays vector
 *  - body copy is never under 12pt; the only small type is codes, credits and page numbers (8.5pt)
 *  - flexible regions absorb long copy; text is never clipped
 */
import type { RenderFontFace } from "./renderTypes";
import { transportCss } from "./transport";

export const COLORS = {
  paper: "#F5F0E6",
  paperDeep: "#ECE4D3",
  sand: "#E3D8C2",
  ink: "#14202E",
  inkDeep: "#0F1923",
  ink2: "#454F5C",
  ink3: "#68707A",
  teal: "#2C6664",
  gold: "#B79A6A",
  rule: "#D6CEBD",
  onDark: "#F5F0E6",
  onDark2: "#D9D3C5",
  onDark3: "#B3AEA3",
} as const;

export const SERIF = "UdSerif";
export const SANS = "UdSans";

export function fontFaceCss(fonts: RenderFontFace[]): string {
  return fonts
    .map(
      f => `@font-face{font-family:'${f.family}';font-weight:${f.weight};font-style:${f.style};font-display:block;src:url(${f.dataUri}) format('truetype');}`,
    )
    .join("\n");
}

export function buildCss(fonts: RenderFontFace[]): string {
  return `${fontFaceCss(fonts)}
@page{size:540pt 960pt;margin:0}
:root{--paper:${COLORS.paper};--paper-deep:${COLORS.paperDeep};--sand:${COLORS.sand};--ink:${COLORS.ink};--ink-deep:${COLORS.inkDeep};--ink-2:${COLORS.ink2};--ink-3:${COLORS.ink3};--teal:${COLORS.teal};--gold:${COLORS.gold};--rule:${COLORS.rule};--on:${COLORS.onDark};--on-2:${COLORS.onDark2};--on-3:${COLORS.onDark3};--m:40pt}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:var(--paper);color:var(--ink);-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:'${SANS}','Noto Sans',Arial,sans-serif;font-weight:400;font-size:13pt;line-height:1.5;font-synthesis:none;font-kerning:normal;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
img{display:block}
h1,h2,h3{font-family:'${SERIF}','Noto Serif',Georgia,serif;font-weight:300;font-synthesis:none;text-wrap:balance;overflow-wrap:anywhere}
ul{list-style:none}
${transportCss()}

.page{position:relative;width:540pt;height:960pt;overflow:hidden;background:var(--paper);break-after:page;page-break-after:always}
.page:last-of-type{break-after:auto;page-break-after:auto}
.page > img.bg,.page .bg{position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover}
.dark{background:var(--ink);color:var(--on)}

/* shared small parts -------------------------------------------------------------------------- */
.kick{font-weight:500;font-size:10.5pt;line-height:1.3;letter-spacing:0.16em;text-transform:uppercase;color:var(--teal)}
.on-dark .kick,.dark .kick{color:var(--on)}
.code{font-weight:500;font-size:9pt;line-height:1.3;letter-spacing:0.12em;color:var(--ink-3)}
.on-dark .code,.dark .code{color:var(--on-2)}
.logo{position:absolute;left:0;top:0;z-index:3}
.logo img{display:block;width:100%;height:100%}
.logo.cover{width:112pt;height:112pt}
.logo.closing{width:100pt;height:100pt}
.logo.guide{width:64pt;height:64pt}
.foot{position:absolute;left:var(--m);right:var(--m);bottom:26pt;min-height:14pt;display:flex;align-items:flex-end;justify-content:space-between;gap:16pt;font-size:8.5pt;line-height:1.2;letter-spacing:0.1em;color:var(--ink-3)}
.foot a.back{font-weight:500;text-transform:uppercase;letter-spacing:0.16em;color:var(--teal)}
.foot .credit{flex:1;text-align:center;letter-spacing:0.03em;line-height:1.35;min-width:0;padding:0 8pt}
.foot .pn{font-variant-numeric:tabular-nums;color:var(--ink-2);letter-spacing:0.14em}
.foot .brand{text-transform:uppercase;letter-spacing:0.2em}
.on-dark .foot,.dark .foot{color:var(--on-3)}
.on-dark .foot a.back,.dark .foot a.back{color:var(--on)}
.on-dark .foot .pn,.dark .foot .pn{color:var(--on-2)}

/* cover -------------------------------------------------------------------------------------- */
.coverplate .panelbg{position:absolute;left:0;right:0;bottom:0;background:var(--ink)}
.cover .photo{position:absolute;left:0;top:0;width:100%;height:700pt;overflow:hidden}
.cover .photo img{width:100%;height:100%;object-fit:cover}
.cover .block{position:absolute;left:var(--m);right:var(--m);bottom:58pt;color:var(--on)}
.cover .eyebrow{font-weight:500;font-size:10.5pt;letter-spacing:0.2em;text-transform:uppercase;color:var(--on-2)}
.cover h1{margin-top:16pt;font-size:37pt;line-height:1.14;letter-spacing:0.09em;text-transform:none;color:var(--on)}
.cover .rule{width:44pt;margin:20pt 0 16pt;border-top:1pt solid var(--gold)}
.cover .invite{font-family:'${SERIF}',serif;font-style:italic;font-weight:300;font-size:17pt;line-height:1.4;color:var(--on);max-width:420pt;text-wrap:pretty}
.cover .issue{margin-top:20pt;font-weight:500;font-size:9.5pt;letter-spacing:0.18em;text-transform:uppercase;color:var(--on-3)}
.cover .caption{position:absolute;left:var(--m);right:var(--m);bottom:26pt;display:flex;justify-content:space-between;align-items:baseline;gap:16pt;font-size:8.5pt;letter-spacing:0.06em;color:var(--on-3)}
.cover .caption .go{font-weight:500;letter-spacing:0.18em;text-transform:uppercase;color:var(--on-2)}
.cover.bare .block{bottom:auto;top:200pt}

/* chapter opener ----------------------------------------------------------------------------- */
.opener .block{position:absolute;left:var(--m);right:var(--m);bottom:66pt;color:var(--on)}
.opener .num{font-family:'${SERIF}',serif;font-weight:300;font-size:15pt;letter-spacing:0.22em;color:var(--on)}
.opener h2{margin-top:14pt;font-size:52pt;line-height:1.08;color:var(--on)}
.opener .rule{width:44pt;margin:20pt 0 16pt;border-top:1pt solid var(--gold)}
.opener .line{font-family:'${SERIF}',serif;font-style:italic;font-weight:300;font-size:17pt;line-height:1.45;color:var(--on);max-width:430pt;text-wrap:pretty}
.opener .count{margin-top:14pt;font-weight:500;font-size:9.5pt;letter-spacing:0.18em;text-transform:uppercase;color:var(--on-3)}
.opener.bare .block{bottom:auto;top:330pt}

/* contents: the chapter navigation guide ------------------------------------------------------------ */
.guide .gtop{position:relative;height:64pt;display:flex;align-items:center;padding-left:84pt}
.guide .ghead{margin:30pt var(--m) 0}
.guide h2{font-size:42pt;line-height:1.08;color:var(--ink)}
.guide .ghead.small{margin-top:22pt}
.guide .ghead.small h2{font-size:30pt}
.guide .csub{margin-top:12pt;font-size:12.5pt;line-height:1.5;color:var(--ink-2);max-width:430pt;text-wrap:pretty}
.guide .csub b{font-weight:500;color:var(--ink);white-space:nowrap}
.guide .glinks{margin-top:8pt;font-size:12pt;line-height:1.4;font-weight:500;color:var(--teal)}
.guide .glinks i{font-style:normal;color:var(--gold);padding:0 8pt}
.guide .glist{margin:16pt var(--m) 0}
.grow{display:flex;gap:16pt;padding:7pt 0;border-top:0.6pt solid var(--rule);align-items:stretch}
.guide .gth{flex:none;width:calc(var(--rh) - 14pt);height:calc(var(--rh) - 14pt);background:var(--sand);overflow:hidden;display:block}
.guide .gth img{width:100%;height:100%;object-fit:cover}
.guide .gth.mono{display:flex;align-items:center;justify-content:center;font-family:'${SERIF}',serif;font-style:italic;font-weight:300;font-size:28pt;color:var(--ink-3);background:var(--paper-deep)}
.guide .gbody{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:5pt}
.guide .gtitle{display:flex;justify-content:space-between;align-items:baseline;gap:12pt}
.guide .gname{display:flex;align-items:baseline;gap:10pt;min-width:0;font-family:'${SERIF}',serif;font-weight:400;font-size:18pt;line-height:1.15;color:var(--ink);overflow-wrap:anywhere}
.guide .gnum{flex:none;font-weight:300;font-size:11pt;letter-spacing:0.2em;color:var(--teal)}
.guide .gmeta{flex:none;font-size:10pt;line-height:1.3;color:var(--ink-3);white-space:nowrap}
.guide .gnames{font-family:'${SERIF}',serif;font-style:italic;font-weight:400;font-size:12pt;line-height:1.4;color:var(--ink-2)}
.guide .gnames i{font-style:normal;color:var(--gold);padding:0 5pt}
.guide .gmore{font-family:'${SANS}',sans-serif;font-style:normal;font-size:10.5pt;color:var(--ink-3)}
.guide .gnone{margin:30pt var(--m) 0}

/* appendices: schedule and index ----------------------------------------------------------------------- */
.appendix .ahead{margin:54pt var(--m) 0}
.appendix .ahead.small{margin-top:50pt}
.appendix .ahead h2{margin-top:10pt;font-size:38pt;line-height:1.08;color:var(--ink)}
.appendix .asub{margin-top:10pt;font-size:11.5pt;line-height:1.5;color:var(--ink-2);max-width:440pt;text-wrap:pretty}
.schedule .acols{display:flex;gap:18pt;margin:16pt var(--m) 0;align-items:flex-start}
.schedule .acol{flex:1 1 0;min-width:0}
.sblock{padding-top:7pt;margin-bottom:10pt;border-top:0.6pt solid var(--rule)}
.sblock .sh{display:flex;align-items:baseline;gap:7pt;margin-bottom:4pt}
.sblock .sc{flex:none;font-weight:500;font-size:9pt;line-height:1.5;letter-spacing:0.1em;color:var(--teal)}
.sblock .st{flex:1;min-width:0;font-family:'${SERIF}',serif;font-weight:400;font-size:10.5pt;line-height:1.28;color:var(--ink)}
.sblock .sp{flex:none;font-size:9pt;color:var(--ink-3);font-variant-numeric:tabular-nums}
.sblock .sl{font-size:9pt;line-height:12.5pt;color:var(--ink-2);font-variant-numeric:tabular-nums}
.sblock .sf{font-weight:500;color:var(--ink)}
.index .ilist{margin:16pt var(--m) 0}
.index .ihead,.index .irow{display:grid;grid-template-columns:40pt minmax(0,1fr) 96pt 34pt;column-gap:10pt;align-items:baseline}
.index .ihead{padding-bottom:5pt;border-bottom:0.6pt solid var(--ink-3);font-size:8.5pt;line-height:1.4;letter-spacing:0.14em;text-transform:uppercase;color:var(--ink-3)}
.index .irow{padding:3.5pt 0;border-bottom:0.6pt solid var(--rule)}
.index .irow .ic{font-weight:500;font-size:10pt;line-height:1.4;letter-spacing:0.1em;color:var(--teal)}
.index .irow .it{font-family:'${SERIF}',serif;font-weight:400;font-size:11pt;line-height:1.3;color:var(--ink);overflow-wrap:anywhere}
.index .irow .ip{font-family:'${SERIF}',serif;font-size:10.5pt;line-height:1.4;text-align:right;color:var(--ink);white-space:nowrap}
.index .irow .ip.inq{font-style:italic;color:var(--ink-2)}
.index .ihead .ip,.index .ihead .ipg{text-align:right;margin-right:-0.14em}
.index .irow .ipg{font-size:10pt;line-height:1.4;text-align:right;color:var(--ink-3);font-variant-numeric:tabular-nums}

/* trip pages: shared type -------------------------------------------------------------------- */
.trip .eyebrow{display:flex;justify-content:space-between;align-items:baseline;gap:16pt}
.trip h2.headline{color:var(--ink);line-height:1.1;letter-spacing:-0.004em}
.trip .meta{font-size:12.5pt;line-height:1.4;color:var(--ink-2)}
.trip .meta i{font-style:normal;color:var(--gold);padding:0 5pt}
.trip .lede{font-family:'${SERIF}',serif;font-style:italic;font-weight:400;font-size:16pt;line-height:1.42;color:var(--ink);text-wrap:pretty}
.trip .notes{font-size:13pt;line-height:1.55;color:var(--ink-2);text-wrap:pretty}
.trip .notes i{font-style:normal;color:var(--gold);padding:0 4pt}
.trip .pricerow{display:flex;justify-content:space-between;align-items:flex-end;gap:24pt;border-top:0.6pt solid var(--rule);padding-top:14pt}
.trip .pl{display:flex;flex-direction:column;gap:7pt;min-width:0}
.trip .plab{font-size:11.5pt;line-height:1.3;color:var(--ink-3)}
.trip .price{font-family:'${SERIF}',serif;font-weight:300;font-size:38pt;line-height:1;color:var(--ink);letter-spacing:-0.01em;white-space:nowrap}
.trip .price small{font-size:17pt;font-weight:300;letter-spacing:0;color:var(--ink-2)}
.trip .price.inq{font-style:italic;font-size:30pt;color:var(--ink-2)}
.trip .pnote{font-family:'${SERIF}',serif;font-style:italic;font-size:12pt;line-height:1.35;color:var(--ink-2);text-align:right;max-width:160pt;padding-bottom:3pt}
.trip .dates{margin-top:12pt;padding-top:9pt;border-top:0.6pt solid var(--rule)}
.trip .dhead{display:flex;justify-content:space-between;align-items:baseline;gap:14pt;margin-bottom:4pt}
.trip .dlab{font-size:11.5pt;line-height:1.3;color:var(--ink-3)}
.trip .dall{font-size:11pt;line-height:1.3;font-weight:500;color:var(--teal);white-space:nowrap}
.trip .ml{display:flex;align-items:baseline;gap:10pt;font-family:'${SERIF}',serif;font-weight:400;font-size:13pt;line-height:1.5;color:var(--ink)}
.trip .mn{flex:none;width:122pt;color:var(--ink-2)}
.trip .md{flex:1;min-width:0}
.trip .md.chips{display:flex;flex-wrap:wrap;gap:3pt 5pt;padding:1.5pt 0}
.trip .chip{min-width:27pt;padding:0 5pt;text-align:center;font-family:'${SANS}',sans-serif;font-size:11.5pt;line-height:19pt;border:0.6pt solid var(--rule);color:var(--ink);font-variant-numeric:tabular-nums}
.trip .ml.next .md,.trip .ml.plain .md{font-size:15pt}
.trip .ml.plain .md{font-size:13.5pt}
.trip .ml.more .md{font-style:italic;color:var(--ink-3)}
.trip .drec{margin-top:3pt;font-family:'${SERIF}',serif;font-style:italic;font-size:12pt;line-height:1.4;color:var(--ink-2)}

/* on dark (cinema, typographic page) */
.on-dark h2.headline,.dark h2.headline{color:var(--on)}
.on-dark .meta,.dark .meta{color:var(--on-2)}
.on-dark .lede,.dark .lede{color:var(--on)}
.on-dark .notes,.dark .notes{color:var(--on-2)}
.on-dark .pricerow,.dark .pricerow{border-top-color:#8E887B}
.on-dark .plab,.on-dark .dlab,.dark .plab,.dark .dlab{color:var(--on-2)}
.on-dark .price,.dark .price{color:var(--on)}
.on-dark .price small,.dark .price small{color:var(--on-2)}
.on-dark .price.inq,.dark .price.inq{color:var(--on-2)}
.on-dark .dates,.dark .dates{border-top-color:#6F6A60}
.on-dark .ml,.dark .ml{color:var(--on)}
.on-dark .mn,.dark .mn,.on-dark .pnote,.dark .pnote,.on-dark .drec,.dark .drec{color:var(--on-2)}
.on-dark .dall,.dark .dall{color:var(--on)}
.on-dark .chip,.dark .chip{border-color:#8E887B;color:var(--on)}
.on-dark .ml.more .md,.dark .ml.more .md{color:var(--on-3)}

/* composition: cinema ------------------------------------------------------------------------- */
.cinema .over{position:absolute;left:var(--m);right:var(--m);bottom:62pt;display:flex;flex-direction:column;gap:0}
.cinema h2.headline{margin-top:12pt}
.cinema .meta{margin-top:14pt}
.cinema .lede{margin-top:16pt;max-width:440pt}
.cinema .notes{margin-top:8pt;max-width:440pt}
.cinema .pd{margin-top:22pt}

/* composition: plate (the one trip page) --------------------------------------------------------
   A near-square photo at the top; the dark panel rises over its lower edge in a soft fade, so the
   headline sits on the picture like a cinema page without making the photo a tall strip. */
.plate{display:flex;flex-direction:column}
.plate .photo{position:relative;flex:0 1 500pt;min-height:340pt;background:var(--sand)}
.plate .photo img{position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover}
.plate .text{position:relative;z-index:2;flex:1 0 auto;margin-top:-96pt;padding:96pt var(--m) 62pt;display:flex;flex-direction:column;background:linear-gradient(to bottom,color-mix(in srgb,var(--ink) 0%,transparent) 0,color-mix(in srgb,var(--ink) 78%,transparent) 44pt,var(--ink) 96pt)}
.plate h2.headline{margin-top:10pt}
.plate .meta{margin-top:11pt}
.plate .lede{margin-top:13pt}
.plate .notes{margin-top:5pt}
.plate .pd{margin-top:auto;padding-top:16pt}

/* transport colour code ------------------------------------------------------------------------ */
.tdot{display:inline-block;width:7pt;height:7pt;margin-right:6pt;border-radius:50%;background:var(--tc,transparent);vertical-align:0.5pt}
.trip .meta .tport{color:inherit;white-space:nowrap}
.trip .meta .tport .tdot{background:var(--tc)}
.trip[data-transport] .chip{border-color:var(--tc,#8E887B);background:color-mix(in srgb,var(--tc,transparent) 20%,transparent)}
.tlegend{display:flex;flex-wrap:wrap;gap:3pt 14pt;margin-top:14pt;font-size:10.5pt;line-height:1.4;color:var(--ink-2)}
.tlegend[data-on=dark]{color:var(--on-2)}
.tlegend .tl{white-space:nowrap}
.tlegend .tdot{background:var(--tc)}

/* composition: panorama ----------------------------------------------------------------------- */
.panorama{padding-top:58pt}
.panorama .head{flex:none;margin:auto var(--m) 0}
.panorama h2.headline{margin-top:12pt}
.panorama .photo{position:relative;flex:1 1 0;min-height:300pt;max-height:560pt;margin-top:26pt;background:var(--sand)}
.panorama .text{flex:none;padding:24pt var(--m) 62pt;display:flex;flex-direction:column}
.panorama .meta{margin-bottom:12pt}
.panorama .notes{margin-top:6pt}
.panorama .pd{margin-top:22pt}

/* composition: diptych ------------------------------------------------------------------------ */
.diptych .photo{position:relative;flex:1 1 0;min-height:340pt;background:var(--sand)}
.diptych .inset{position:absolute;right:var(--m);bottom:-134pt;z-index:2;width:200pt;height:270pt;border:6pt solid var(--paper);background:var(--paper)}
.diptych .inset img{position:static;width:100%;height:100%;object-fit:cover}
.diptych .panel{flex:none;padding:28pt var(--m) 62pt;display:flex;flex-direction:column}
.diptych .col{width:236pt;min-height:158pt}
.diptych h2.headline{margin-top:10pt}
.diptych .meta{margin-top:11pt}
.diptych .lede{margin-top:0}
.diptych .notes{margin-top:6pt}
.diptych .pd{margin-top:22pt}

/* composition: typographic -------------------------------------------------------------------- */
.type .over{position:absolute;left:var(--m);right:var(--m);top:70pt;bottom:62pt;display:flex;flex-direction:column}
.type .mid{margin:auto 0;border-left:1pt solid var(--gold);padding-left:24pt}
.type h2.headline{margin-top:0}
.type .rule{display:none}
.type .meta{margin-top:20pt}
.type .lede{margin-top:22pt;max-width:440pt}
.type .notes{margin-top:8pt;max-width:440pt}

/* closing ------------------------------------------------------------------------------------ */
.closing .band{position:absolute;left:0;top:0;width:100%;height:230pt;overflow:hidden;background:var(--ink)}
.closing .band img{width:100%;height:100%;object-fit:cover}
.closing .band.plain{background:var(--ink)}
.closing .band.plain .bk{position:absolute;left:124pt;top:40pt;font-weight:500;font-size:10.5pt;letter-spacing:0.2em;text-transform:uppercase;color:var(--on-2)}
.closing .band.plain::after{content:"";position:absolute;left:var(--m);right:var(--m);bottom:0;border-top:1pt solid var(--gold)}
.closing .body{position:absolute;left:var(--m);right:var(--m);top:270pt;bottom:62pt;display:flex;flex-direction:column}
.closing.compact .band{height:176pt}
.closing.compact .body{top:212pt}
.closing.compact .step{padding:6pt 0}
.closing.compact .reply{margin-top:14pt}
.closing .corp{margin-top:16pt;padding-top:12pt;border-top:0.6pt solid var(--rule)}
.closing .corp li{position:relative;padding-left:14pt;margin-top:5pt;font-size:12.5pt;line-height:1.45;color:var(--ink-2);text-wrap:pretty}
.closing .corp li::before{content:"";position:absolute;left:0;top:0.62em;width:7pt;border-top:1pt solid var(--teal)}
.closing h2{margin-top:10pt;font-size:40pt;line-height:1.08;color:var(--ink)}
.closing .intro{margin-top:12pt;font-size:13.5pt;line-height:1.55;color:var(--ink-2);max-width:440pt;text-wrap:pretty}
.closing .steps{margin-top:18pt;border-top:0.6pt solid var(--rule)}
.closing .step{display:flex;align-items:baseline;gap:18pt;padding:8pt 0;border-bottom:0.6pt solid var(--rule)}
.closing .step .n{flex:none;width:34pt;font-family:'${SERIF}',serif;font-weight:300;font-size:26pt;line-height:1;color:var(--teal)}
.closing .step .t{font-size:14.5pt;line-height:1.35;color:var(--ink);font-weight:500}
.closing .step .t span{display:block;margin-top:1pt;font-weight:400;font-size:12pt;color:var(--ink-3)}
.closing .reply{margin-top:20pt;display:flex;align-items:baseline;gap:14pt}
.closing .reply .rl{font-size:11.5pt;color:var(--ink-3)}
.closing .reply .sample{font-family:'${SERIF}',serif;font-style:italic;font-weight:300;font-size:23pt;line-height:1.2;color:var(--teal)}
.closing .contact{margin-top:auto;padding-top:20pt;display:flex;justify-content:space-between;align-items:flex-end;gap:20pt}
.closing .phones{display:flex;flex-wrap:wrap;gap:0 26pt;margin-top:6pt}
.closing .phones span{font-family:'${SERIF}',serif;font-weight:400;font-size:21pt;line-height:1.25;color:var(--ink);letter-spacing:0.01em;font-variant-numeric:lining-nums}
.closing .site{font-weight:500;font-size:13pt;color:var(--teal);text-align:right;padding-bottom:3pt}
.closing .fine{margin-top:14pt;padding-top:11pt;border-top:0.6pt solid var(--rule);font-size:12pt;line-height:1.5;color:var(--ink-2);text-wrap:pretty}
.closing .fine p + p{margin-top:4pt}
.closing .fine .stamp{margin-top:7pt;font-size:8.5pt;line-height:1.4;color:var(--ink-3);letter-spacing:0.04em}
`;
}
