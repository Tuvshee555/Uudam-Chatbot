/**
 * Catalogue diagnostics: the leaf module every other catalogue data file builds on.
 *
 * Holds the warning factory, the small text helpers, the customer-copy filter (extracted from
 * tripCatalogPdf.ts so that file stays untouched), the prose price reader that finds an amount
 * quoted in an overview paragraph, and liveDrift (is a published snapshot still true?).
 *
 * Imports only types. No clock, no database, no network. Mongolian wording is for staff; the
 * invented-names rule of AGENTS.md applies to every example in this folder.
 */
import type {
  CatalogueSnapshot,
  CatalogueTripCard,
  CatalogueWarning,
  CatalogueWarningCode,
  CatalogueWarningSeverity,
} from "./types";

export type Row = Record<string, unknown>;

export const row = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
export const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.filter((v) => v && typeof v === "object" && !Array.isArray(v)) as Row[] : []);
export const text = (value: unknown): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
export const strList = (value: unknown): string[] => (Array.isArray(value) ? value.map(text).filter(Boolean) : []);
export const finiteNumber = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** "3,980,000₮" — the only way a tugrik amount is printed in this feature. */
export function formatMnt(amount: number): string {
  return `${Math.round(amount).toLocaleString("en-US")}₮`;
}

export function warn(
  code: CatalogueWarningCode,
  severity: CatalogueWarningSeverity,
  message: string,
  tripId?: string,
  detail?: CatalogueWarning["detail"],
): CatalogueWarning {
  return { code, severity, message, ...(tripId ? { tripId } : {}), ...(detail ? { detail } : {}) };
}

const SEVERITY_RANK: Record<CatalogueWarningSeverity, number> = { blocking: 0, warning: 1, info: 2 };

/** Same warning twice (same code, trip, message) is one warning. Order: blocking first, then by trip and code. */
export function dedupeWarnings(list: readonly CatalogueWarning[]): CatalogueWarning[] {
  const seen = new Set<string>();
  const out: CatalogueWarning[] = [];
  for (const warning of list) {
    const key = `${warning.code}|${warning.tripId ?? ""}|${warning.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(warning);
  }
  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || (a.tripId ?? "").localeCompare(b.tripId ?? "") || a.code.localeCompare(b.code));
}

/* ------------------------------------------------------------ customer copy filter */

/**
 * Copy written for staff or for the bot, not for the reader.
 *
 * Extracted from tripCatalogPdf.ts (INTERNAL_COPY_RE). Two registers give it away: explicit
 * tooling vocabulary ("chatbot", "эх сурвалж") and the imperative instruction addressed to
 * whoever answers ("when asked X, always say Y"). A brochure addresses the reader as
 * "та"/"аялагч", so "хэрэглэгч" only ever appears in an internal note.
 *
 * One deliberate difference from the brochure's filter: "бот", "админ" and "дотоод" are matched
 * as WORDS, not as bare substrings. The substring form threw away real sights and routes
 * ("Ботаникийн цэцэрлэг", "Робот шоу", "Ботсвана сафари", "Дотоодын нислэг") and then blamed
 * staff for writing bot copy. "бот" still matches with its case endings (ботод, ботын, ботыг ...),
 * "дотоод" only in its staff-note uses ("дотоод хэрэгцээнд", "дотоод мэдээлэл").
 */
const WORD_START = String.raw`(?<![\p{L}])`;
const WORD_END = String.raw`(?![\p{L}])`;
export const INTERNAL_COPY_RE = new RegExp(
  [
    String.raw`\b(chatbot|admin|internal|source|review|staff)\b`,
    `${WORD_START}бот(?:ын|од|ыг|оос|оор|той|ынхоо|т)?${WORD_END}`,
    `${WORD_START}админ(?:ы|д|аас|тай|ыг)?${WORD_END}`,
    String.raw`${WORD_START}дотоод\s*[:：]`,
    String.raw`${WORD_START}дотоод\s+(?:хэрэгцээ|хэрэглээ|ашиглалт|мэдээлэл|тэмдэглэл|заавар|тооцоо|зориулалт)`,
    "эх сурвалж",
    "шалгах шаардлагатай",
    "хэрэглэгч",
    String.raw`заавал\s+хэлнэ`,
    "лавлуул",
    String.raw`асуу(вал|хад|бал)[^.!?]{0,80}(хэлнэ|хариулна|мэдэгдэнэ)`,
  ].join("|"),
  "iu",
);

export const isInternalCopy = (value: string): boolean => INTERNAL_COPY_RE.test(value);

/** The text if a customer may read it, else "". */
export function customerText(value: unknown): string {
  const t = text(value);
  return !t || INTERNAL_COPY_RE.test(t) ? "" : t;
}

/* ------------------------------------------------------------ prose price reader */

export type ProseAmount = {
  amountMnt: number;
  /** The words as written, e.g. "3,880,000₮". */
  raw: string;
  /** True when the clause around the number talks about a child / deposit / supplement, not the adult fare. */
  nonAdult: boolean;
};

const GROUPED = String.raw`\d{1,3}(?:[,.  ' ]\d{3})+`;
const PLAIN = String.raw`\d{4,9}`;
const CURRENCY = String.raw`(?:₮|төгрөг\p{L}*|төг(?!\p{L})|mnt(?!\p{L}))`;
const FOREIGN_AFTER = /^\s*(?:\$|usd|eur|€|юань|¥|cny|rmb|₩|krw|вон|доллар|ам\.?\s*доллар)/iu;
const FOREIGN_BEFORE = /(?:\$|€|¥|₩)\s*$/u;
const PRICE_WORD = /үнэ|үнийн|price|эхлэн|эхэлнэ|-?аас\b|-?с\s+эхл/iu;
// A clause about a child, a deposit, a supplement, an instalment plan, a saving or a promotion is not
// the adult fare. "өрөө" alone is NOT here: "2 хүний өрөөнд нэг хүнд 3,880,000₮" is the ordinary way an
// adult price is written. A room only makes an amount non-adult together with ганцаар / single /
// нэмэлт (already listed) or as an explicit one-person room.
const NON_ADULT = new RegExp([
  "хүүхд|хүүхэд|нярай|child|infant|ганцаар|single|нэмэлт|урьдчилгаа|deposit|хөнгөлөлт|хямдр|discount",
  "татвар|виз|хураамж|торгууль|буцаалт|шилжүүлэг|даатгал|экскурс|сонголтот|optional|төлбөр\\s+нэмэх",
  "хуваан|сар\\s+бүр|хэмнэ(?!лттэй)|урамшуул|купон|coupon|promo|бэлэг",
  "(?<![\\d])1\\s*хүний\\s*өрөө|нэг\\s+хүний\\s+өрөө",
].join("|"), "iu");
/** Something that reads like a price: a grouped number, 4+ digits, or a number with сая / мянга / ₮. */
const AMOUNT_HINT = /\d{1,3}(?:[,.  ' ]\d{3})+|\d{4,}|\d+\s*(?:сая|мянга|₮|төгрөг)/iu;
const MAX_LABEL_CHARS = 60;

function digitsToNumber(raw: string): number {
  return Number(raw.replace(/\D/g, ""));
}

/** A short passenger / price label ("Хүүхэд (2-11 нас)"): words, no amount of its own. */
function isLabel(segment: string): boolean {
  const trimmed = segment.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_LABEL_CHARS && /\p{L}/u.test(trimmed) && !AMOUNT_HINT.test(trimmed);
}

/**
 * The clause (sentence / comma-with-space part) around [start, end). A dash is a clause boundary
 * EXCEPT when the words on the far side of it are only a label for this amount
 * ("Хүүхэд (2-11 нас) - 3,200,000₮", "3,200,000₮ - хүүхэд"): then the label belongs to the clause.
 * A dash that separates two priced parts ("Хүүхэд 2,000,000₮ - Том хүн 3,880,000₮") still splits.
 */
function clauseAround(source: string, start: number, end: number): string {
  const before = source.slice(0, start);
  const after = source.slice(end);
  const hardLeft = Math.max(before.lastIndexOf("."), before.lastIndexOf(";"), before.lastIndexOf("\n"), before.lastIndexOf("!"), before.lastIndexOf("?"),
    before.lastIndexOf("|"), before.lastIndexOf("•"), before.lastIndexOf(", "));
  const dashLeft = Math.max(before.lastIndexOf(" - "), before.lastIndexOf(" – "));
  let left = Math.max(hardLeft, dashLeft);
  if (dashLeft > hardLeft && isLabel(source.slice(hardLeft + 1, dashLeft))) left = hardLeft;

  const hardRights = [after.search(/[.;\n!?|•]/), after.indexOf(", ")].filter((i) => i >= 0);
  const hardRight = hardRights.length ? Math.min(...hardRights) : after.length;
  const dashRights = [after.indexOf(" - "), after.indexOf(" – ")].filter((i) => i >= 0);
  const dashRight = dashRights.length ? Math.min(...dashRights) : -1;
  let reach = Math.min(dashRight >= 0 ? Math.min(dashRight, hardRight) : hardRight, 28);
  if (dashRight >= 0 && dashRight < hardRight && isLabel(after.slice(dashRight + 3, hardRight))) {
    reach = Math.min(hardRight, dashRight + 3 + MAX_LABEL_CHARS);
  }
  return source.slice(left + 1, end + reach);
}

/**
 * Every tugrik amount a paragraph quotes: "3,880,000₮", "3.88 сая", "880 мянган төгрөг", and a bare
 * "3 880 000" beside the word үнэ. Amounts in another currency ($, юань) are not read. A clause
 * about a child, deposit or supplement is marked nonAdult so the caller can leave it out.
 */
export function extractMntAmounts(source: string): ProseAmount[] {
  const input = String(source || "");
  const found: Array<{ start: number; end: number; amount: number; raw: string }> = [];
  const covered = (start: number, end: number) => found.some((f) => start < f.end && end > f.start);
  const push = (match: RegExpExecArray, amount: number) => {
    const start = match.index;
    const end = start + match[0].length;
    if (!Number.isFinite(amount) || amount < 1000 || covered(start, end)) return;
    found.push({ start, end, amount: Math.round(amount), raw: match[0].trim() });
  };

  // 1. a number followed by ₮ / төгрөг: "3,880,000₮", "3880000 төгрөг"
  for (const m of input.matchAll(new RegExp(String.raw`(?<![\d.,])(${GROUPED}|${PLAIN})\s*${CURRENCY}`, "giu"))) push(m as RegExpExecArray, digitsToNumber(m[1]));
  // 2. millions: "3.88 сая", "3,5 сая төгрөг"
  for (const m of input.matchAll(new RegExp(String.raw`(?<![\d.,])(\d+(?:[.,]\d{1,3})?)\s*сая(?!хан)\p{L}*(?:\s*${CURRENCY})?`, "giu"))) push(m as RegExpExecArray, Number(m[1].replace(",", ".")) * 1_000_000);
  // 3. thousands: "990 мянга", "880 мянган төгрөг" (a hundred thousand and more only)
  for (const m of input.matchAll(new RegExp(String.raw`(?<![\d.,])(\d{3,4})\s*мянга(?:н)?\p{L}*(?:\s*${CURRENCY})?`, "giu"))) push(m as RegExpExecArray, Number(m[1]) * 1000);
  // 4. a bare grouped number next to a price word: "үнэ 3 880 000"
  for (const m of input.matchAll(new RegExp(String.raw`(?<![\d.,$€¥])(${GROUPED})(?![\d])`, "gu"))) {
    const amount = digitsToNumber(m[1]);
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (amount < 100_000 || covered(start, end)) continue;
    if (FOREIGN_AFTER.test(input.slice(end)) || FOREIGN_BEFORE.test(input.slice(0, start))) continue;
    if (!PRICE_WORD.test(input.slice(Math.max(0, start - 24), end + 24))) continue;
    found.push({ start, end, amount, raw: m[0] });
  }

  return found
    .filter((f) => !FOREIGN_AFTER.test(input.slice(f.end)) && !FOREIGN_BEFORE.test(input.slice(0, f.start)))
    .sort((a, b) => a.start - b.start)
    .map((f) => ({ amountMnt: f.amount, raw: f.raw, nonAdult: NON_ADULT.test(clauseAround(input, f.start, f.end)) }));
}

/* ------------------------------------------------------------ provisional codes */

/**
 * A read-only review (the admin trips table, reachable with the read-only API token) must never
 * allocate permanent trip codes, yet the snapshot builder will not print a card that has no code.
 * Trips without a stored code therefore get an in-memory placeholder that starts with this prefix;
 * it is never stored, never printed, and the review shows such a trip with a null code.
 */
export const PROVISIONAL_CODE_PREFIX = "~";
export const isProvisionalCode = (code: string | null | undefined): boolean =>
  typeof code === "string" && code.startsWith(PROVISIONAL_CODE_PREFIX);

/* ------------------------------------------------------------ live drift */

const cardLabel = (card: CatalogueTripCard) => `${card.code} «${card.title}»`;

function priceSignature(card: CatalogueTripCard): string {
  return card.price.kind === "from" ? `${card.price.amountMnt}@${card.price.date ?? ""}` : "inquire";
}


const fareText = (mnt: number | null) => (mnt === null ? "үнэгүй/бүртгээгүй" : formatMnt(mnt));

/**
 * Compares the FUTURE SCHEDULE (every bookable departure with its own adult fare), never the rolling window:
 * the window moves with the calendar and is not drift. A date that left (sold out, closed, removed, or simply
 * passed), a new date, or a changed dated fare is drift. Old snapshots without `schedule` fall back to the
 * capped `departures` list.
 */
function scheduleDrift(card: CatalogueTripCard, now: CatalogueTripCard, reasons: string[], today: string, pending: string[]): void {
  const before = card.dates.schedule;
  const after = now.dates.schedule;
  if (!before || !after) {
    const missing = card.dates.departures.filter((d) => !now.dates.departures.includes(d));
    if (missing.length) reasons.push(`${cardLabel(card)} — ${missing.slice(0, 3).join(", ")} огноо захиалгаас хасагдсан`);
    else if (card.dates.nextDeparture !== now.dates.nextDeparture) {
      reasons.push(`${cardLabel(card)} — ойрын огноо өөрчлөгдсөн (${card.dates.nextDeparture ?? "—"} → ${now.dates.nextDeparture ?? "—"})`);
    }
    return;
  }
  const liveByDate = new Map(after.map((entry) => [entry.date, entry.adultMnt]));
  const publishedByDate = new Map(before.map((entry) => [entry.date, entry.adultMnt]));
  // Only a printed date that is still in the future and no longer bookable makes the file wrong. A date that
  // simply passed, or a new date that appeared (weekly trips roll new dates in every day), leaves everything
  // the file says true: those are "pending" changes the scheduled refresh picks up, never a reason to
  // withhold the PDF from a customer (owner, 2026-11-11: the bot sent the website text instead of the PDF).
  const gone = before.filter((entry) => !liveByDate.has(entry.date));
  const removed = gone.filter((entry) => entry.date > today).map((entry) => entry.date);
  const passed = gone.filter((entry) => entry.date <= today).map((entry) => entry.date);
  const added = after.filter((entry) => !publishedByDate.has(entry.date)).map((entry) => entry.date);
  if (passed.length) pending.push(`${cardLabel(card)} — ${passed.length} огноо өнгөрсөн`);
  if (removed.length) reasons.push(`${cardLabel(card)} — ${removed.slice(0, 3).join(", ")} огноо захиалгаас хасагдсан${removed.length > 3 ? ` (нийт ${removed.length})` : ""}`);
  if (card.dates.nextDeparture !== now.dates.nextDeparture && !removed.length && !passed.length && !added.length) {
    reasons.push(`${cardLabel(card)} — ойрын огноо өөрчлөгдсөн (${card.dates.nextDeparture ?? "—"} → ${now.dates.nextDeparture ?? "—"})`);
  }
  if (added.length) pending.push(`${cardLabel(card)} — шинэ огноо нэмэгдсэн (${added.slice(0, 3).join(", ")}${added.length > 3 ? ` +${added.length - 3}` : ""})`);
  const changed = before.filter((entry) => liveByDate.has(entry.date) && liveByDate.get(entry.date) !== entry.adultMnt);
  if (changed.length) {
    const first = changed[0];
    reasons.push(`${cardLabel(card)} — ${changed.length} огнооны үнэ өөрчлөгдсөн (${first.date}: ${fareText(first.adultMnt)} → ${fareText(liveByDate.get(first.date) ?? null)})`);
  }
}

/**
 * Is a published snapshot still what the live data would print? Compared per trip id:
 * - the trip is gone from the live edition (no longer active, no bookable future departure,
 *   hidden, archived, removed) -> drift;
 * - its dated starting price or the date that price belongs to changed -> drift;
 * - the future schedule changed (a date left, was sold out or added, or any date's adult fare changed) -> drift;
 *   the rolling 90-day window is NOT compared, so time passing alone is never drift;
 * - its title, duration or transport label changed -> drift;
 * - a weekly trip's schedule line ("Пүрэв гараг бүр") changed -> drift (it has no calendar dates to compare).
 * DISPLAY-ONLY differences are not drift: the chosen photo, its crop, the editorial display title,
 * the group and the highlights can change without the published file saying anything untrue; only
 * the title of record (card.title), prices, dates, status, duration and transport are compared.
 * A trip that only appears in the live snapshot is not drift: the published file is merely
 * older, nothing in it is false. Pure; the caller builds `live` with the same edition and config.
 */
export function liveDrift(published: CatalogueSnapshot, live: CatalogueSnapshot): { drifted: boolean; reasons: string[]; pending: string[] } {
  const liveById = new Map(live.trips.map((card) => [card.tripId, card]));
  const reasons: string[] = [];
  const pending: string[] = [];
  for (const card of published.trips) {
    const now = liveById.get(card.tripId);
    if (!now) {
      reasons.push(`${cardLabel(card)} — одоо захиалгад нээлттэй биш (идэвхгүй, огноогүй, нуугдсан эсвэл устсан)`);
      continue;
    }
    if (priceSignature(card) !== priceSignature(now)) {
      reasons.push(`${cardLabel(card)} — огноот үнэ өөрчлөгдсөн (${card.price.display} → ${now.price.display})`);
    }
    scheduleDrift(card, now, reasons, live.asOfDay, pending);
    // A weekly trip has no calendar dates (departures [] and nextDeparture null on both sides), so the
    // printed schedule line ("Пүрэв гараг бүр") is the only date fact the card carries.
    if (!card.dates.departures.length && !now.dates.departures.length && card.dates.label !== now.dates.label) {
      reasons.push(`${cardLabel(card)} — явах хуваарь өөрчлөгдсөн («${card.dates.label}» → «${now.dates.label}»)`);
    }
    if (card.title !== now.title) reasons.push(`${cardLabel(card)} — нэр өөрчлөгдсөн (${now.title})`);
    // Printed on every card, so a changed value makes the published file say something untrue.
    if ((card.durationText ?? "") !== (now.durationText ?? "")) {
      reasons.push(`${cardLabel(card)} — хугацаа өөрчлөгдсөн («${card.durationText || "—"}» → «${now.durationText || "—"}»)`);
    }
    if ((card.transportLabel ?? "") !== (now.transportLabel ?? "")) {
      reasons.push(`${cardLabel(card)} — тээврийн төрөл өөрчлөгдсөн («${card.transportLabel || "—"}» → «${now.transportLabel || "—"}»)`);
    }
  }
  return { drifted: reasons.length > 0, reasons, pending };
}
