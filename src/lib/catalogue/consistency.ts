/**
 * Does a trip contradict itself? The structured fields (extra.transport_type, duration_days /
 * duration_nights, duration_text) are what the catalogue prints; the title, the program and the
 * notes are what the customer reads next to it. When the two disagree, the catalogue prints NOTHING
 * for the contradicted fact (an empty transport label) and tells staff which side to fix. It never
 * decides which side is right: it only reports both, with the wording as evidence.
 *
 * PURE: no clock, no database. Mongolian cues only; no trip or place is named here.
 */
import type { TravelTrip } from "../travelTypes";
import type { CatalogueWarning } from "./types";
import { isTransportType, type TransportType } from "../tripTransitDays";
import { row, rows, text, warn } from "./diagnostics";

export type TransportClass = "direct" | "connecting" | "land" | "train";

/** A flight that changes planes on the way, written as such. ("дамжин нислэг", "дамжин нислэгтэй", "transit flight", "нислэг дамжин"). */
const CONNECTING_RE = /дамжин\s*[-–]?\s*нисл|дамжин\s*нис|дамжих\s*нисл|дамжуулан\s*нис|нислэг(?:ээр|ийг)?\s+дамжин|transit\s*flight|connecting\s*flight/iu;
/** A word that alone in a TITLE marks a connecting itinerary ("… ДАМЖИН НИСЛЭГТЭЙ …" is covered above; this is the bare word). */
const TITLE_TRANSIT_RE = /(?:^|[\s\-–—(])дамжин(?=$|[\s\-–—),.])/iu;
const DIRECT_RE = /шууд\s*[-–]?\s*нисл/iu;
const LAND_RE = /газрын\s+аялал|газраар\s+аялал|нислэггүй/iu;
const TITLE_BUS_RE = /автобус/iu;
const TRAIN_RE = /галт\s*тэрэг/iu;
/** A title that openly mixes land and air ("газар нислэг хосолсон"): "нислэгтэй" there is no claim of a direct flight. */
const COMBO_RE = /хосолсон|газар\s*[-–+]?\s*нисл|нисл\S*\s*[-–+]?\s*газар/iu;

export const TRANSPORT_CLASS_LABEL: Record<TransportClass, string> = {
  direct: "Шууд нислэг",
  connecting: "Дамжин нислэг",
  land: "Газрын аялал",
  train: "Галт тэрэг",
};

const STRUCTURED_LABEL: Record<TransportType, string> = {
  direct_flight: "Шууд нислэг",
  land: "Газрын аялал",
  land_flight: "Газар + нислэг",
  cruise: "Усан онгоцны аялал",
};

export type ConsistencyFinding = {
  field: "transport" | "duration";
  /** What the structured field says, in words ("Шууд нислэг", "8 өдөр 7 шөнө"). */
  structured: string;
  /** What the wording says. */
  wording: string;
  /** Where the wording was found: "гарчиг", "хөтөлбөр (3-р өдөр)", "тэмдэглэл". */
  where: string;
  /** The sentence (shortened) the cue was found in. */
  evidence: string;
  /** The value the wording implies, for staff ("Дамжин нислэг"). */
  likely: string;
  /** Mongolian, for staff. */
  message: string;
  warning: CatalogueWarning;
};

export type TripConsistency = {
  transport: ConsistencyFinding[];
  duration: ConsistencyFinding[];
  warnings: CatalogueWarning[];
  /** True when the printed transport label must be blanked. */
  transportConflict: boolean;
  durationConflict: boolean;
};

/* ------------------------------------------------------------------ text sources */

type Source = { where: string; text: string; isTitle: boolean };

function dayText(day: Record<string, unknown>): string {
  return `${text(day.title)} ${text(day.description)}`.trim();
}

/** Every customer-facing text of the trip that can state the transport or the length of the trip. */
export function consistencySources(trip: TravelTrip): Source[] {
  const extra = row(trip.extra);
  const out: Source[] = [{ where: "гарчиг", text: text(trip.route_name), isTitle: true }];
  const original = text(extra.original_title_text);
  if (original && original !== text(trip.route_name)) out.push({ where: "анхны гарчиг", text: original, isTitle: true });
  rows(extra.itinerary_days).forEach((day, index) => {
    const t = dayText(day);
    if (t) out.push({ where: `хөтөлбөр (${Number(day.day) || index + 1}-р өдөр)`, text: t, isTitle: false });
  });
  const notes = [text(trip.notes), ...(Array.isArray(extra.important_notes) ? (extra.important_notes as unknown[]).map(text) : [])].filter(Boolean);
  for (const note of notes) out.push({ where: "тэмдэглэл", text: note, isTitle: false });
  const summary = text(extra.website_summary);
  if (summary) out.push({ where: "вэб тайлбар", text: summary, isTitle: false });
  return out.filter((s) => s.text);
}

const sentenceAround = (value: string, index: number, length: number): string => {
  const start = Math.max(0, value.lastIndexOf(".", index) + 1, index - 70);
  const end = Math.min(value.length, index + length + 70);
  return value.slice(start, end).trim();
};

/* ------------------------------------------------------------------ transport */

type Cue = { cls: TransportClass; where: string; evidence: string; isTitle: boolean };

function transportCues(sources: readonly Source[]): Cue[] {
  const cues: Cue[] = [];
  const add = (cls: TransportClass, source: Source, match: RegExpExecArray) =>
    cues.push({ cls, where: source.where, evidence: sentenceAround(source.text, match.index, match[0].length), isTitle: source.isTitle });
  for (const source of sources) {
    let m: RegExpExecArray | null;
    if ((m = CONNECTING_RE.exec(source.text))) add("connecting", source, m);
    else if (source.isTitle && (m = TITLE_TRANSIT_RE.exec(source.text))) add("connecting", source, m);
    if ((m = DIRECT_RE.exec(source.text)) && source.isTitle) add("direct", source, m);
    if ((m = LAND_RE.exec(source.text)) && (source.isTitle || source.where === "тэмдэглэл")) add("land", source, m);
    // A bus is a local transfer in almost every program: only a TITLE that sells the trip as a bus / train trip counts.
    if (source.isTitle && (m = TITLE_BUS_RE.exec(source.text))) add("land", source, m);
    if (source.isTitle && (m = TRAIN_RE.exec(source.text))) add("train", source, m);
  }
  return cues;
}

function structuredTransportOf(trip: TravelTrip, guessed: string | null): { type: TransportType | null; label: string; derived: boolean } {
  const structured = row(trip.extra).transport_type;
  if (isTransportType(structured)) return { type: structured, label: STRUCTURED_LABEL[structured], derived: false };
  const g = isTransportType(guessed) ? guessed : null;
  return g ? { type: g, label: STRUCTURED_LABEL[g], derived: true } : { type: null, label: "", derived: true };
}

/** Which wording classes contradict the structured transport (nothing is contradicted when the type is unknown). */
function contradicts(type: TransportType, cue: Cue, titleHasCombo: boolean): boolean {
  switch (type) {
    case "direct_flight":
      return cue.cls === "connecting" || cue.cls === "land" || cue.cls === "train";
    case "land":
      return (cue.cls === "direct" && cue.isTitle) || cue.cls === "connecting";
    case "land_flight":
      return cue.cls === "direct" && cue.isTitle && !titleHasCombo;
    case "cruise":
      return false;
  }
}

/* ------------------------------------------------------------------ duration */

type Count = { days: number | null; nights: number | null };

const DAYS_RE = /(\d{1,2})\s*(?:өдөр|өдрийн|өдрөөр|өдрөөс)(?![а-яөүёa-z])/iu;
const NIGHTS_RE = /(\d{1,2})\s*шөнө(?![а-яөүёa-z])/iu;
const NIGHTS_DAYS_RE = /(\d{1,2})\s*шөнө[\s,/()\-–]{0,4}(\d{1,2})\s*(?:өдөр|өдрийн|өдрөөр)/iu;
const DAYS_NIGHTS_RE = /(\d{1,2})\s*(?:өдөр|өдрийн|өдрөөр)[\s,/()\-–]{0,4}(\d{1,2})\s*шөнө/iu;

/** "9 өдөр 8 шөнө" / "5 шөнө / 6 өдөр" / "8 өдөр" -> {days, nights}; nulls for what is not written. */
export function parseDuration(value: string): Count {
  const nd = NIGHTS_DAYS_RE.exec(value);
  if (nd) return { nights: Number(nd[1]), days: Number(nd[2]) };
  const dn = DAYS_NIGHTS_RE.exec(value);
  if (dn) return { days: Number(dn[1]), nights: Number(dn[2]) };
  const d = DAYS_RE.exec(value);
  const n = NIGHTS_RE.exec(value);
  return { days: d ? Number(d[1]) : null, nights: n ? Number(n[1]) : null };
}

const positiveInt = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
};

const durationWords = (c: Count): string =>
  c.days !== null && c.nights !== null ? `${c.days} өдөр ${c.nights} шөнө` : c.days !== null ? `${c.days} өдөр` : c.nights !== null ? `${c.nights} шөнө` : "";

/** The structured length: extra.duration_days / duration_nights, else what duration_text says. */
export function structuredDuration(trip: TravelTrip): Count {
  const extra = row(trip.extra);
  const written = parseDuration(text(trip.duration_text));
  return { days: positiveInt(extra.duration_days) ?? written.days, nights: positiveInt(extra.duration_nights) ?? written.nights };
}

/* ------------------------------------------------------------------ public */

const short = (value: string, max = 140) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

export function checkTripConsistency(trip: TravelTrip, opts: { guessedTransport?: string | null } = {}): TripConsistency {
  const sources = consistencySources(trip);
  const transport: ConsistencyFinding[] = [];
  const duration: ConsistencyFinding[] = [];
  const label = `«${short(text(trip.route_name) || trip.id, 60)}»`;

  /* transport */
  const structured = structuredTransportOf(trip, opts.guessedTransport ?? null);
  const cues = transportCues(sources);
  const titleHasCombo = sources.some((s) => s.isTitle && COMBO_RE.test(s.text));
  const reported = new Set<TransportClass>();
  if (structured.type) {
    for (const cue of cues) {
      if (reported.has(cue.cls) || !contradicts(structured.type, cue, titleHasCombo)) continue;
      reported.add(cue.cls);
      const likely = TRANSPORT_CLASS_LABEL[cue.cls];
      const message = `${label} — ${cue.where}-д «${short(cue.evidence, 90)}» гэж байхад бүртгэлд тээвэр «${structured.label}»${structured.derived ? " (автоматаар таасан)" : ""} байна. Зөрүүтэй тул каталогт тээврийг хэвлэхгүй. Аяллын тээврийн төрлийг засна уу (хөтөлбөрөөс харахад «${likely}»).`;
      transport.push({
        field: "transport", structured: structured.label, wording: likely, where: cue.where, evidence: cue.evidence, likely, message,
        warning: warn("transport_conflict", "warning", message, trip.id, { structured: structured.label, wording: likely }),
      });
    }
  }
  // The wording contradicting itself: sold as a direct flight in the title, a connecting flight in the program.
  const titleDirect = cues.find((c) => c.cls === "direct" && c.isTitle);
  const connecting = cues.find((c) => c.cls === "connecting");
  if (titleDirect && connecting && !reported.has("connecting") && !reported.has("direct")) {
    const message = `${label} — гарчигт «шууд нислэг», харин ${connecting.where}-д «${short(connecting.evidence, 90)}» гэж байна. Зөрүүтэй тул каталогт тээврийг хэвлэхгүй.`;
    transport.push({
      field: "transport", structured: structured.label || "—", wording: TRANSPORT_CLASS_LABEL.connecting, where: connecting.where, evidence: connecting.evidence,
      likely: TRANSPORT_CLASS_LABEL.connecting, message,
      warning: warn("transport_conflict", "warning", message, trip.id, { structured: structured.label || "—", wording: TRANSPORT_CLASS_LABEL.connecting }),
    });
  }

  /* duration */
  const have = structuredDuration(trip);
  const extra = row(trip.extra);
  const stored = { days: positiveInt(extra.duration_days), nights: positiveInt(extra.duration_nights) };
  const written = parseDuration(text(trip.duration_text));
  const durationWhere = (c: Count) => durationWords(c);
  const pushDuration = (where: string, evidence: string, wording: Count, why: string) => {
    const structuredText = durationWhere(have) || text(trip.duration_text) || "—";
    const wordingText = durationWhere(wording);
    const message = `${label} — ${where}-д «${short(evidence, 90)}» (${wordingText}) гэж байхад бүртгэлийн хугацаа «${structuredText}» байна (${why}). Алийг нь засахаа шалгана уу.`;
    duration.push({
      field: "duration", structured: structuredText, wording: wordingText, where, evidence, likely: wordingText, message,
      warning: warn("duration_conflict", "warning", message, trip.id, { structured: structuredText, wording: wordingText }),
    });
  };
  // 1) the structured fields against each other (duration_text vs duration_days / duration_nights)
  if ((stored.days !== null && written.days !== null && stored.days !== written.days) || (stored.nights !== null && written.nights !== null && stored.nights !== written.nights)) {
    pushDuration("«Хугацаа» талбар", text(trip.duration_text), written, `duration_days ${stored.days ?? "—"} / duration_nights ${stored.nights ?? "—"} талбартай зөрнө`);
  }
  // 2) the title and the notes against the structured length
  for (const source of sources) {
    if (/^хөтөлбөр/.test(source.where)) continue; // day descriptions talk about hours and neighbouring days, not the trip length
    const pair = NIGHTS_DAYS_RE.test(source.text) || DAYS_NIGHTS_RE.test(source.text);
    const count = source.isTitle ? parseDuration(source.text) : pair ? parseDuration(source.text) : { days: null, nights: null };
    const dayDiff = count.days !== null && have.days !== null && count.days !== have.days;
    const nightDiff = count.nights !== null && have.nights !== null && count.nights !== have.nights;
    if (dayDiff || nightDiff) pushDuration(source.where, source.text, count, dayDiff ? `${have.days} өдөртэй зөрнө` : `${have.nights} шөнөтэй зөрнө`);
  }
  // 3) the program: a day-by-day program longer or shorter than the stated length (flexible-start notes are not days)
  const days = rows(extra.itinerary_days).filter((d) => positiveInt(d.day) !== null || text(d.title));
  if (days.length >= 3 && have.days !== null && days.length !== have.days) {
    pushDuration("хөтөлбөр", `${days.length} өдрийн хөтөлбөр`, { days: days.length, nights: null }, `хөтөлбөрт ${days.length} өдөр, бүртгэлд ${have.days} өдөр`);
  }

  const seen = new Set<string>();
  const unique = (list: ConsistencyFinding[]) => list.filter((f) => (seen.has(f.message) ? false : (seen.add(f.message), true)));
  const t = unique(transport);
  const d = unique(duration);
  return {
    transport: t, duration: d, warnings: [...t, ...d].map((f) => f.warning),
    transportConflict: t.length > 0, durationConflict: d.length > 0,
  };
}

/* ------------------------------------------------------------------ flight legs (audit evidence) */

const FLIGHT_WORD = /хөөр|газардана|газардаж|нисэх буудал|нислэг|нисч/iu;

/** Day titles of a program that contain a flight ("УЛААНБААТАР – X"), for the audit's evidence column. */
export function flightLegEvidence(trip: TravelTrip): string[] {
  return rows(row(trip.extra).itinerary_days)
    .filter((d) => FLIGHT_WORD.test(dayText(d)))
    .map((d) => `${Number(d.day) || "?"}-р өдөр: ${text(d.title)}`);
}
