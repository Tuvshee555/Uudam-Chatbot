/**
 * Transport colour code: the reader sees how a trip travels at a glance.
 *   direct flight (Шууд нислэг)            red
 *   ground trip   (Газрын аялал)           blue
 *   cruise        (Усан онгоцны аялал)     teal
 *   land + flight (Газар + нислэг)         amber
 * Mapped from the card's printed transport label only (a label that contradicts the structured data is
 * already blanked upstream), so an unknown or empty label gets no colour rather than a guessed one.
 */

export type TransportKind = "direct" | "ground" | "cruise" | "combo" | "none";

export const TRANSPORT_NAMES: Record<Exclude<TransportKind, "none">, string> = {
  direct: "Шууд нислэг",
  ground: "Газрын аялал",
  cruise: "Усан онгоцны аялал",
  combo: "Газар + нислэг",
};

/** Muted tones that read on the dark trip panel (dark) and on ivory pages (light). */
export const TRANSPORT_TONES: Record<Exclude<TransportKind, "none">, { dark: string; light: string }> = {
  direct: { dark: "#E2705D", light: "#B2402F" },
  ground: { dark: "#79A9DC", light: "#2F6AA6" },
  cruise: { dark: "#62BBAA", light: "#2A8776" },
  combo: { dark: "#E3AB5E", light: "#A8741B" },
};

export function transportKindOf(label: string | null | undefined): TransportKind {
  const t = String(label ?? "").toLocaleLowerCase("mn").replace(/\s+/g, " ").trim();
  if (!t) return "none";
  if (/усан\s*онгоц|cruise|круиз/.test(t)) return "cruise";
  const flight = /нислэг|flight|онгоцон/.test(t);
  const land = /газар|газрын|автобус|галт\s*тэрэг|train|bus/.test(t);
  if (flight && /шууд|direct/.test(t) && !land) return "direct";
  if (flight && land) return "combo";
  if (flight) return "direct";
  if (land) return "ground";
  return "none";
}

/** CSS custom properties for the colour tones, used by theme.ts. */
export function transportCss(): string {
  return (Object.keys(TRANSPORT_TONES) as Array<keyof typeof TRANSPORT_TONES>)
    .map(kind => `.trip[data-transport=${kind}]{--tc:${TRANSPORT_TONES[kind].dark}}.tlegend[data-on=light] .t-${kind}{--tc:${TRANSPORT_TONES[kind].light}}.tlegend[data-on=dark] .t-${kind}{--tc:${TRANSPORT_TONES[kind].dark}}`)
    .join("\n");
}

/** A one-line legend: coloured dot + name, for the guide and the schedule appendix. */
export function transportLegendHtml(on: "light" | "dark"): string {
  const items = (Object.keys(TRANSPORT_NAMES) as Array<keyof typeof TRANSPORT_NAMES>)
    .map(kind => `<span class="tl t-${kind}"><i class="tdot"></i>${TRANSPORT_NAMES[kind]}</span>`)
    .join("");
  return `<p class="tlegend" data-on="${on}">${items}</p>`;
}
