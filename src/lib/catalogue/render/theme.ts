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
@page{size:540pt 675pt;margin:0}
:root{--paper:${COLORS.paper};--paper-deep:${COLORS.paperDeep};--sand:${COLORS.sand};--ink:${COLORS.ink};--ink-deep:${COLORS.inkDeep};--ink-2:${COLORS.ink2};--ink-3:${COLORS.ink3};--teal:${COLORS.teal};--gold:${COLORS.gold};--rule:${COLORS.rule};--on:${COLORS.onDark};--on-2:${COLORS.onDark2};--on-3:${COLORS.onDark3};--m:40pt}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:var(--paper);color:var(--ink);-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:'${SANS}','Noto Sans',Arial,sans-serif;font-weight:400;font-size:13pt;line-height:1.5;font-synthesis:none;font-kerning:normal;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
img{display:block}
h1,h2,h3{font-family:'${SERIF}','Noto Serif',Georgia,serif;font-weight:300;font-synthesis:none;text-wrap:balance;overflow-wrap:anywhere}
ul{list-style:none}
${transportCss()}

.page{position:relative;width:540pt;height:675pt;overflow:hidden;background:var(--paper);break-after:page;page-break-after:always}
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
.logo.closing{width:80pt;height:80pt}
.foot{position:absolute;left:var(--m);right:var(--m);bottom:26pt;min-height:14pt;display:flex;align-items:flex-end;justify-content:space-between;gap:16pt;font-size:8.5pt;line-height:1.2;letter-spacing:0.1em;color:var(--ink-3)}
.foot a.back{font-weight:500;text-transform:uppercase;letter-spacing:0.16em;color:var(--teal)}
.foot .credit{flex:1;text-align:center;letter-spacing:0.03em;line-height:1.35;min-width:0;padding:0 8pt}
.foot .pn{font-variant-numeric:tabular-nums;color:var(--ink-2);letter-spacing:0.14em}
.foot .brand{text-transform:uppercase;letter-spacing:0.2em}
.on-dark .foot,.dark .foot{color:var(--on-3)}
.on-dark .foot a.back,.dark .foot a.back{color:var(--on)}
.on-dark .foot .pn,.dark .foot .pn{color:var(--on-2)}

/* cover -------------------------------------------------------------------------------------- */
.coverplate .panelbg{position:absolute;left:0;right:0;bottom:0;background:#111}
.cover .photo{position:absolute;left:0;top:0;width:100%;height:400pt;overflow:hidden}
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

/* sections: dark category pages that list their trips ----------------------------------------------
   Near-black page, the section's transport colour as a soft glow and as every accent; the strongest
   photograph of the section across the top, fading into the page. */
.section{background:radial-gradient(120% 55% at 0% 100%,color-mix(in srgb,var(--tc,#888) 24%,transparent) 0,transparent 70%),radial-gradient(90% 40% at 100% 0%,color-mix(in srgb,var(--tc,#888) 16%,transparent) 0,transparent 70%),#111;color:var(--on)}
.anchor{position:absolute;left:0;top:0;width:1pt;height:1pt}
.section .sband{position:absolute;left:0;top:0;width:100%;height:250pt;overflow:hidden}
.section.compact .sband{height:180pt}
.section .sband img{width:100%;height:100%;object-fit:cover}
.section .snav{position:absolute;z-index:2;left:var(--m);right:var(--m);top:26pt;display:flex;flex-wrap:wrap;gap:6pt 6pt}
.section .sn{display:inline-flex;align-items:center;gap:0;padding:0 9pt;height:21pt;border:0.6pt solid #5E5A53;background:#111;font-size:9.5pt;line-height:1;letter-spacing:0.04em;color:var(--on-2);white-space:nowrap}
.section .sn .tdot{width:6pt;height:6pt;margin-right:6pt;background:var(--tc)}
.section .sn b{font-weight:500;margin-left:7pt;color:var(--on-3)}
.section .sn.on{border-color:var(--tc);background:color-mix(in srgb,var(--tc) 30%,#111);color:var(--on)}
.section .sn.on b{color:var(--on)}
.section .shead{position:relative;z-index:2;margin:150pt var(--m) 0}
.section.compact .shead{margin-top:96pt}
.section.bare .shead{margin-top:118pt}
.section.compact.bare .shead{margin-top:84pt}
.section.cont .shead{margin-top:44pt}
.section .snum{font-family:'${SERIF}',serif;font-weight:300;font-size:12pt;letter-spacing:0.22em;color:var(--tc)}
.section h2{margin-top:6pt;font-size:40pt;line-height:1.08;color:var(--on)}
.section.compact h2{font-size:34pt}
.section.cont h2{font-size:28pt}
.section .srule{width:56pt;margin:12pt 0 0;border-top:2pt solid var(--tc)}
.section .sline{margin-top:10pt;font-size:11pt;line-height:1.4;letter-spacing:0.06em;color:var(--on-2)}
.section .sline i{font-style:normal;color:var(--tc);padding:0 7pt}
.section .slist{position:relative;z-index:2;margin:18pt var(--m) 0;display:grid;grid-template-columns:1fr 1fr;gap:7pt 14pt}
.section.compact .slist{gap:5pt 14pt;margin-top:14pt}
.section.cont .slist{margin-top:18pt}
.scard{display:flex;gap:10pt;height:52pt;min-width:0;background:color-mix(in srgb,#FFFFFF 5%,#111);border-left:2pt solid var(--tc);overflow:hidden}
.compact .scard{height:40pt;gap:8pt}
.scard .sth{flex:none;width:52pt;height:52pt;overflow:hidden;background:#222}
.compact .scard .sth{width:40pt;height:40pt}
.section.large .slist{grid-template-columns:1fr;gap:10pt}
.large .scard{height:80pt;gap:16pt}
.large .scard .sth{width:106pt;height:80pt}
.large .scard .sbody{gap:3pt;padding-right:14pt}
.large .scard .stop{font-size:9.5pt}
.large .scard .stt{font-size:17pt;line-height:1.15}
.large .scard .spr{font-size:13pt}
.large .scard .spg{font-size:10pt}
.scard .sth img{width:100%;height:100%;object-fit:cover}
.scard .sth.mono{display:flex;align-items:center;justify-content:center;font-weight:500;font-size:10pt;letter-spacing:0.08em;color:var(--tc);background:color-mix(in srgb,var(--tc) 18%,#111)}
.scard .sbody{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:1.5pt;padding-right:8pt}
.scard .stop{display:flex;justify-content:space-between;gap:6pt;font-size:8.5pt;line-height:1.2;letter-spacing:0.1em}
.scard .sc{font-weight:500;color:var(--tc)}
.scard .sdur{color:var(--on-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.scard .stt{font-family:'${SERIF}',serif;font-weight:400;font-size:11.5pt;line-height:1.18;max-height:2.36em;overflow:hidden;color:var(--on)}
.compact .scard .stt{font-size:10pt;line-height:1.12;max-height:2.24em}
.scard .sleft{display:flex;gap:7pt;align-items:baseline}
.scard .sbot{display:flex;justify-content:space-between;align-items:baseline;gap:6pt}
.scard .spr{font-family:'${SERIF}',serif;font-size:10.5pt;line-height:1.2;color:var(--on-2);white-space:nowrap}
.compact .scard .spr{font-size:9.5pt}
.scard .spr.inq{font-style:italic}
.scard .spg{font-size:8.5pt;line-height:1.2;color:var(--on-3);font-variant-numeric:tabular-nums;letter-spacing:0.08em}

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
.cinema .over{position:absolute;left:var(--m);right:var(--m);bottom:50pt;display:flex;flex-direction:column;gap:0}
.cinema h2.headline{margin-top:8pt}
.cinema .meta{margin-top:9pt}
.cinema .lede{margin-top:10pt;max-width:440pt;font-size:14pt}
.cinema .notes{margin-top:4pt;max-width:440pt;font-size:11.5pt}
.cinema .pd{margin-top:14pt}

/* composition: plate (the one trip page) --------------------------------------------------------
   A near-square photo at the top; the dark panel rises over its lower edge in a soft fade, so the
   headline sits on the picture like a cinema page without making the photo a tall strip. */
.plate{display:flex;flex-direction:column}
.plate.dark{background:var(--panel,var(--ink))}
.plate .photo{position:relative;flex:0 1 360pt;min-height:170pt;background:var(--sand)}
.plate .photo img{position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover}
.plate .text{position:relative;z-index:2;flex:1 0 auto;margin-top:-70pt;padding:70pt var(--m) 54pt;display:flex;flex-direction:column;background:linear-gradient(to bottom,color-mix(in srgb,var(--panel,var(--ink)) 0%,transparent) 0,color-mix(in srgb,var(--panel,var(--ink)) 70%,transparent) 30pt,var(--panel,var(--ink)) 70pt)}
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

/* composition: typographic (no usable photo) ------------------------------------------------------
   Dark like every other trip page: the transport colour as a glow and the trip's code set huge and
   quiet in the corner, so the page reads as designed, never as a missing picture. */
.trip.type{background:radial-gradient(110% 60% at 100% 0%,color-mix(in srgb,var(--tc,#888) 30%,transparent) 0,transparent 72%),radial-gradient(80% 45% at 0% 100%,color-mix(in srgb,var(--tc,#888) 14%,transparent) 0,transparent 70%),#111}
.type .wmbox{position:absolute;left:0;top:0;width:100%;height:100%;overflow:hidden}
.type .wm{position:absolute;right:var(--m);top:34pt;font-family:'${SERIF}',serif;font-weight:300;font-size:150pt;line-height:1;letter-spacing:-0.02em;color:color-mix(in srgb,var(--tc,#888) 30%,#111);white-space:nowrap}
.type .over{position:absolute;left:var(--m);right:var(--m);top:70pt;bottom:50pt;display:flex;flex-direction:column}
.type .mid{margin:auto 0 0;border-left:2pt solid var(--tc,var(--gold));padding-left:22pt}
.type h2.headline{margin-top:0}
.type .rule{display:none}
.type .meta{margin-top:14pt}
.type .lede{margin-top:14pt;max-width:440pt;font-size:14pt}
.type .notes{margin-top:6pt;max-width:440pt;font-size:11.5pt}
.type .pd{margin-top:18pt}

/* closing ------------------------------------------------------------------------------------ */
.closing .band{position:absolute;left:0;top:0;width:100%;height:80pt;overflow:hidden;background:var(--paper-deep)}
.closing .band img{width:100%;height:100%;object-fit:cover}
.closing .band.plain{background:var(--paper-deep)}
.closing .band.plain .bk{position:absolute;left:124pt;top:32pt;font-weight:500;font-size:10.5pt;letter-spacing:0.2em;text-transform:uppercase;color:var(--ink-2)}
.closing .band.plain::after{content:"";position:absolute;left:var(--m);right:var(--m);bottom:0;border-top:1pt solid var(--gold)}
.closing .body{position:absolute;left:var(--m);right:var(--m);top:100pt;bottom:50pt;display:flex;flex-direction:column}
.closing.compact .band{height:80pt}
.closing.compact .body{top:100pt}
.closing.compact .step{padding:6pt 0}
.closing.compact .reply{margin-top:14pt}
.closing .corp{margin-top:12pt;padding-top:9pt;border-top:0.6pt solid var(--rule)}
.closing .corp li{position:relative;padding-left:14pt;margin-top:5pt;font-size:12.5pt;line-height:1.45;color:var(--ink-2);text-wrap:pretty}
.closing .corp li::before{content:"";position:absolute;left:0;top:0.62em;width:7pt;border-top:1pt solid var(--teal)}
.closing h2{margin-top:6pt;font-size:32pt;line-height:1.08;color:var(--ink)}
.closing .intro{margin-top:8pt;font-size:12.5pt;line-height:1.45;color:var(--ink-2);max-width:440pt;text-wrap:pretty}
.closing .steps{margin-top:12pt;display:grid;grid-template-columns:repeat(3,1fr);column-gap:16pt;border-top:0.6pt solid var(--rule);padding-top:10pt}
.closing .step{display:block;padding:0;border:0}
.closing .step .n{display:block;width:auto;margin-bottom:3pt;font-family:'${SERIF}',serif;font-weight:300;font-size:22pt;line-height:1;color:var(--teal)}
.closing .step .t{font-size:14.5pt;line-height:1.35;color:var(--ink);font-weight:500}
.closing .step .t span{display:block;margin-top:1pt;font-weight:400;font-size:12pt;color:var(--ink-3)}
.closing .reply{margin-top:12pt;display:flex;align-items:baseline;gap:14pt}
.closing .reply .rl{font-size:11.5pt;color:var(--ink-3)}
.closing .reply .sample{font-family:'${SERIF}',serif;font-style:italic;font-weight:300;font-size:23pt;line-height:1.2;color:var(--teal)}
.closing .contact{margin-top:auto;padding-top:12pt;display:flex;justify-content:space-between;align-items:flex-end;gap:20pt}
.closing .phones{display:flex;flex-wrap:wrap;gap:0 26pt;margin-top:6pt}
.closing .phones span{font-family:'${SERIF}',serif;font-weight:400;font-size:19pt;line-height:1.25;color:var(--ink);letter-spacing:0.01em;font-variant-numeric:lining-nums}
.closing .site{font-weight:500;font-size:13pt;color:var(--teal);text-align:right;padding-bottom:3pt}
.closing .fine{margin-top:10pt;padding-top:8pt;border-top:0.6pt solid var(--rule);font-size:11pt;line-height:1.5;color:var(--ink-2);text-wrap:pretty}
.closing .fine p + p{margin-top:4pt}
.closing .fine .stamp{margin-top:7pt;font-size:8.5pt;line-height:1.4;color:var(--ink-3);letter-spacing:0.04em}
`;
}
