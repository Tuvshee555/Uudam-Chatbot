/**
 * The catalogue's visual system as one stylesheet. Warm ivory paper, natural photo colour, deep
 * navy type, one muted teal and one earthy accent used sparingly. All sizes are in pt so the
 * PDF page (540 x 960 pt) and the 720 x 1280 px screenshot share a single layout.
 *
 * Rules the stylesheet keeps on purpose:
 *  - no filters, blend modes, opacity or shadows on photos (they would rasterise the page)
 *  - no body text under 11pt; the smallest labels are 9pt tracked capitals
 *  - flexible regions (the hero photo) absorb long copy; text is never clipped
 */
import type { RenderFontFace } from "./renderTypes";

export const COLORS = {
  paper: "#F6F1E7",
  paperDeep: "#EEE7D8",
  sand: "#E4D9C3",
  ink: "#152333",
  ink2: "#4C5766",
  ink3: "#6F7782",
  teal: "#2B6968",
  accent: "#9E6338",
  rule: "#D5CEBF",
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
:root{--paper:${COLORS.paper};--paper-deep:${COLORS.paperDeep};--sand:${COLORS.sand};--ink:${COLORS.ink};--ink-2:${COLORS.ink2};--ink-3:${COLORS.ink3};--teal:${COLORS.teal};--accent:${COLORS.accent};--rule:${COLORS.rule};--m:36pt}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:var(--paper);color:var(--ink);-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:'${SANS}','Noto Sans',Arial,sans-serif;font-weight:400;font-size:13pt;line-height:1.45;font-synthesis:none;font-kerning:normal;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
img{display:block}
h1,h2,h3{font-family:'${SERIF}','Noto Serif',Georgia,serif;font-weight:600;font-synthesis:none;letter-spacing:-0.005em;text-wrap:balance;overflow-wrap:anywhere}
ul{list-style:none}

.page{position:relative;width:540pt;height:960pt;overflow:hidden;background:var(--paper);display:flex;flex-direction:column;break-after:page;page-break-after:always}
.page:last-of-type{break-after:auto;page-break-after:auto}

/* shared small parts -------------------------------------------------------------------- */
.label{font-weight:500;font-size:10.5pt;line-height:1.25;letter-spacing:0.08em;text-transform:uppercase;color:var(--teal)}
.label.muted{color:var(--ink-3)}
.rule{height:0;border-top:0.6pt solid var(--rule)}
.logo{width:100%;height:100%;object-fit:contain}
.foot{flex:none;margin:0 var(--m);height:58pt;display:flex;align-items:center;gap:12pt;border-top:0.6pt solid var(--rule)}
.foot .logo-tile{flex:none;width:30pt;height:30pt}
.foot-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:1pt}
.foot-title{font-weight:500;font-size:10pt;letter-spacing:0.08em;text-transform:uppercase;color:var(--ink)}
.foot-sub{font-size:10pt;color:var(--ink-3)}
.foot-nav{flex:none;display:flex;align-items:baseline;gap:14pt;font-size:10pt;color:var(--ink-2)}
.foot-nav .pn{font-family:'${SERIF}',serif;font-weight:600;font-size:13pt;color:var(--ink);font-variant-numeric:tabular-nums}
.foot-nav .pn small{font-family:'${SANS}',sans-serif;font-weight:400;font-size:10pt;color:var(--ink-3)}
.foot-nav a.back{color:var(--teal);font-weight:500;letter-spacing:0.04em}

/* cover ------------------------------------------------------------------------------------ */
.cover .masthead{flex:none;height:112pt;margin:0 var(--m);display:flex;align-items:center;justify-content:space-between}
.cover .masthead .logo-tile{width:82pt;height:82pt}
.cover .mast-r{text-align:right;display:flex;flex-direction:column;gap:3pt}
.cover .mast-r .season{font-family:'${SERIF}',serif;font-weight:600;font-size:19pt;line-height:1.1;color:var(--ink);letter-spacing:0.01em}
.cover .mast-r .issue{font-size:10.5pt;color:var(--ink-3);letter-spacing:0.04em}
.cover .hero{position:relative;flex:1 1 0;min-height:300pt;background:var(--sand);overflow:hidden}
.cover .hero img{width:100%;height:100%;object-fit:cover}
.cover .caption{flex:none;margin:9pt var(--m) 0;display:flex;justify-content:space-between;gap:16pt;font-size:10pt;color:var(--ink-3)}
.cover .caption em{font-family:'${SERIF}',serif;font-style:italic;font-weight:400;font-size:11.5pt;color:var(--ink-2)}
.cover .titleblock{flex:none;margin:22pt var(--m) 0}
.cover .kicker{display:flex;align-items:center;gap:12pt}
.cover .kicker:after{content:'';flex:1;border-top:0.6pt solid var(--rule)}
.cover h1{margin-top:12pt;font-size:50pt;line-height:1.04;letter-spacing:0.004em;color:var(--ink)}
.cover .accent-rule{width:46pt;margin:16pt 0 13pt;border-top:1.6pt solid var(--accent)}
.cover .lede{font-size:13.5pt;line-height:1.5;color:var(--ink-2);max-width:420pt;text-wrap:pretty}
.cover .foot{margin-top:20pt}

/* photo placeholder (typographic, never fake imagery) ----------------------------------------- */
.ph{position:absolute;inset:0;background:var(--sand);display:flex;flex-direction:column;justify-content:flex-end;padding:0 var(--m) 96pt;overflow:hidden}
.ph .ph-kicker{font-family:'${SERIF}',serif;font-style:italic;font-weight:400;font-size:44pt;line-height:1.1;color:#BFAF8C;max-width:440pt;overflow-wrap:anywhere;text-wrap:balance}
.ph .ph-line{margin-top:18pt;width:46pt;border-top:1.6pt solid var(--accent)}

/* contents ----------------------------------------------------------------------------------- */
.contents .chead{flex:none;margin:44pt var(--m) 0}
.contents .chead.small{margin-top:40pt}
.contents h2{margin-top:8pt;font-size:40pt;line-height:1.05;color:var(--ink)}
.contents .chead.small h2{font-size:28pt}
.contents .csub{margin-top:12pt;font-size:12.5pt;line-height:1.5;color:var(--ink-2);max-width:430pt;text-wrap:pretty}
.contents .clist{flex:1;margin:16pt var(--m) 0;min-height:0}
.contents .cgroup{display:flex;align-items:center;gap:12pt;height:46pt;padding-top:16pt}
.contents .cgroup:after{content:'';flex:1;border-top:0.6pt solid var(--rule)}
.contents .cgroup .label{white-space:nowrap}
.crow{display:grid;grid-template-columns:52pt minmax(0,1fr) auto 26pt;column-gap:12pt;align-items:center;min-height:50pt;padding:6pt 0;border-bottom:0.6pt solid var(--rule)}
.cgroup + .crow{border-top:0}
.crow-code{font-family:'${SERIF}',serif;font-weight:600;font-size:19pt;line-height:1;color:var(--accent);letter-spacing:0.01em}
.crow-main{display:flex;flex-direction:column;gap:1.5pt;min-width:0}
.crow-title{font-weight:500;font-size:13pt;line-height:1.3;color:var(--ink);overflow-wrap:anywhere}
.crow-meta{font-size:11pt;line-height:1.35;color:var(--ink-3)}
.crow-price{font-family:'${SERIF}',serif;font-weight:600;font-size:14.5pt;color:var(--ink);text-align:right;white-space:nowrap}
.crow-price.inq{font-style:italic;font-weight:400;font-size:13.5pt;color:var(--ink-2)}
.crow-page{font-size:11pt;color:var(--ink-3);text-align:right;font-variant-numeric:tabular-nums}
.contents .clist.dens-compact .cgroup{height:36pt;padding-top:12pt}
.contents .clist.dens-compact .crow{min-height:41pt;padding:3pt 0}
.contents .clist.dens-tight .cgroup{height:30pt;padding-top:8pt}
.contents .clist.dens-tight .crow{min-height:38pt;padding:1.5pt 0}
.contents .foot{margin-top:auto}

/* trip page --------------------------------------------------------------------------------- */
.trip .hero{position:relative;flex:1 1 0;min-height:330pt;max-height:632pt;background:var(--sand)}
.trip .hero img.photo{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.trip .tab{position:absolute;left:0;bottom:0;background:var(--paper);padding:12pt 26pt 0 var(--m);display:flex;flex-direction:column;gap:3pt}
.trip .tab .label{color:var(--ink-3)}
.trip .tab .tab-code{font-family:'${SERIF}',serif;font-weight:600;font-size:36pt;line-height:0.95;color:var(--accent);letter-spacing:0.01em}
.trip .body{flex:none;padding:12pt var(--m) 0}
.trip .eyebrow{display:flex;justify-content:space-between;align-items:baseline;gap:16pt}
.trip .credit{font-size:9.5pt;color:var(--ink-3);text-align:right}
.trip h2.headline{margin-top:7pt;color:var(--ink);line-height:1.07}
.trip .facts{margin-top:14pt;display:grid;grid-template-columns:auto auto minmax(0,1fr);column-gap:26pt;padding:10pt 0;border-top:0.6pt solid var(--rule);border-bottom:0.6pt solid var(--rule)}
.trip .facts dt{font-weight:500;font-size:10pt;letter-spacing:0.08em;text-transform:uppercase;color:var(--ink-3)}
.trip .facts dd{margin-top:2pt;font-weight:500;font-size:12.5pt;line-height:1.3;color:var(--ink)}
.trip .highlights{margin-top:13pt;font-size:13pt;line-height:1.42;color:var(--ink-2)}
.trip .highlights li{position:relative;padding-left:15pt;margin-top:5pt;text-wrap:pretty;overflow-wrap:anywhere}
.trip .highlights li:first-child{margin-top:0}
.trip .highlights li:before{content:'';position:absolute;left:0;top:0.62em;width:7pt;border-top:1.4pt solid var(--accent)}
.trip .pricerow{margin-top:15pt;display:flex;justify-content:space-between;align-items:flex-end;gap:20pt}
.trip .pricerow .pl{display:flex;flex-direction:column;gap:3pt;min-width:0}
.trip .price{font-family:'${SERIF}',serif;font-weight:600;font-size:34pt;line-height:1.02;color:var(--ink);letter-spacing:-0.005em;white-space:nowrap}
.trip .price.inq{font-style:italic;font-weight:400;font-size:28pt;color:var(--ink-2)}
.trip .pricerow .pr{display:flex;flex-direction:column;gap:3pt;text-align:right;min-width:0;max-width:200pt}
.trip .dateline{font-weight:500;font-size:12.5pt;line-height:1.3;color:var(--ink);text-wrap:balance}
.trip .groupnote{margin-top:10pt;display:flex;justify-content:space-between;align-items:baseline;gap:14pt;font-size:11pt;line-height:1.35;color:var(--ink-3)}
.trip .groupnote a{flex:none;color:var(--teal);font-weight:500}
.trip .foot{margin-top:auto}
.trip .body + .foot{margin-top:16pt}

/* closing / quotation page ------------------------------------------------------------------- */
.closing .top{flex:none;margin:36pt var(--m) 0;display:flex;justify-content:space-between;align-items:flex-start;gap:20pt}
.closing .top .logo-tile{width:100pt;height:100pt}
.closing .top .aside{text-align:right;display:flex;flex-direction:column;gap:3pt;padding-top:4pt}
.closing .top .aside .season{font-family:'${SERIF}',serif;font-weight:600;font-size:19pt;color:var(--ink)}
.closing .top .aside .issue{font-size:10.5pt;color:var(--ink-3);letter-spacing:0.04em}
.closing h2{margin:28pt var(--m) 0;font-size:40pt;line-height:1.06;color:var(--ink)}
.closing .intro{margin:12pt var(--m) 0;font-size:13.5pt;line-height:1.5;color:var(--ink-2);max-width:440pt;text-wrap:pretty}
.closing .steps{margin:22pt var(--m) 0;border-top:0.6pt solid var(--rule)}
.closing .step{display:flex;align-items:baseline;gap:18pt;padding:9pt 0;border-bottom:0.6pt solid var(--rule)}
.closing .step .n{flex:none;width:34pt;font-family:'${SERIF}',serif;font-weight:600;font-size:23pt;line-height:1;color:var(--accent)}
.closing .step .t{font-size:14pt;line-height:1.35;color:var(--ink);font-weight:500}
.closing .step .t span{display:block;margin-top:1pt;font-weight:400;font-size:11.5pt;color:var(--ink-3)}
.closing .example{margin:16pt var(--m) 0;display:flex;align-items:baseline;gap:14pt}
.closing .example .sample{font-family:'${SERIF}',serif;font-style:italic;font-weight:400;font-size:22pt;line-height:1.2;color:var(--teal)}
.closing .choose{margin:20pt var(--m) 0}
.closing .choose ul{margin-top:8pt}
.closing .choose li{display:flex;gap:14pt;padding:5pt 0;font-size:12pt;line-height:1.4;color:var(--ink-2)}
.closing .choose li b{flex:none;width:158pt;font-weight:500;color:var(--ink)}
.closing .choose li span{min-width:0;overflow-wrap:anywhere}
.closing .contact{flex:none;margin:22pt 0 0;padding:18pt var(--m) 20pt;background:var(--paper-deep);display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:20pt;align-items:end}
.closing .phones{display:flex;flex-wrap:wrap;gap:2pt 28pt;margin-top:6pt}
.closing .phones span{font-family:'${SERIF}',serif;font-weight:600;font-size:24pt;line-height:1.15;color:var(--ink);letter-spacing:0.01em;font-variant-numeric:lining-nums}
.closing .site{font-weight:500;font-size:13pt;color:var(--teal);text-align:right}
.closing .fine{flex:none;margin:auto var(--m) 0;padding-top:16pt;font-size:11pt;line-height:1.5;color:var(--ink-2);text-wrap:pretty}
.closing .fine p + p{margin-top:5pt}
.closing .fine .stamp{margin-top:12pt;font-size:9.5pt;line-height:1.4;color:var(--ink-3);letter-spacing:0.02em}
.closing .foot{margin-top:16pt}
`;
}
