/**
 * What the new-trip review shows, and what it folds into small «+ …» chips (UI only; the data lives
 * in src/lib/tripReview*.ts).
 *
 * The owner, 2026-11-11: the review showed every box whether it mattered or not (per price row
 * «Буудал», «Багц», «Ганц өрөөний нэмэлт», «Үнийн нэр», «Тэмдэглэл»; the five booking terms; the
 * optional infant boxes …), mostly empty, and he scrolled 40 boxes to find the 2 that mattered.
 * Now a field with a value always shows; an empty optional field is a chip at the bottom of its
 * section, and a click on the chip opens it. «Бүх талбар» shows every field again.
 *
 * Pure.
 */
import type { PriceCard } from "@/lib/tripReviewPrices";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? value as Row : {});
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const filled = (value: unknown) => Array.isArray(value) && value.some((item) => String(item ?? "").trim());

export type Chip<K extends string = string> = { key: K; label: string };

/** «Бүх талбар» on, and the fields opened from a chip during this review. */
export type ShowOptions = { all?: boolean; revealed?: ReadonlySet<string> };

/* ------------------------------------------------------------------ trip fields */

export const BOOKING_TERMS = [
  { key: "deposit", label: "Урьдчилгаа", placeholder: "ж: 500,000₮ бүртгүүлэхдээ" },
  { key: "payment", label: "Төлбөр", placeholder: "ж: Үлдэгдлийг гарахаас 14 хоногийн өмнө" },
  { key: "documents", label: "Бичиг баримт", placeholder: "ж: Гадаад паспорт, 2 зураг" },
  { key: "visa", label: "Виз", placeholder: "ж: Визгүй / Виз шаардлагатай" },
  { key: "cancellation", label: "Цуцлалт", placeholder: "ж: Цуцалбал хураамж авна" },
] as const;

export type TermKey = (typeof BOOKING_TERMS)[number]["key"];

export type OptionalKey =
  | "summary" | "notes" | "hotel" | "profiles" | "ages"
  | "list:included" | "list:excluded" | "list:important"
  | `terms:${TermKey}`;

export const OPTIONAL_LABELS: Record<OptionalKey, string> = {
  summary: "Товч танилцуулга",
  notes: "Хуудасны тайлбар",
  hotel: "Зочид буудал",
  profiles: "Буудлын холбоос, зураг",
  ages: "Насны ангилал",
  "list:included": "Үнэд багтсан",
  "list:excluded": "Үнэд багтаагүй",
  "list:important": "Анхаарах зүйл",
  "terms:deposit": "Урьдчилгаа",
  "terms:payment": "Төлбөр",
  "terms:documents": "Бичиг баримт",
  "terms:visa": "Виз",
  "terms:cancellation": "Цуцлалт",
};

/** The optional fields of each part of the review, in the order they are shown. */
export const HERO_OPTIONAL: OptionalKey[] = ["summary", "notes", "hotel", "profiles"];
export const LIST_OPTIONAL: OptionalKey[] = ["list:included", "list:excluded"];
export const CONDITION_OPTIONAL: OptionalKey[] = ["list:important", ...BOOKING_TERMS.map((term) => `terms:${term.key}` as OptionalKey)];

/** Whether the trip holds a value for an optional field. */
export function hasOptionalValue(fields: Row, key: OptionalKey): boolean {
  const extra = record(fields.extra);
  if (key === "summary") return Boolean(text(extra.website_summary));
  if (key === "notes") return Boolean(text(fields.notes));
  if (key === "hotel") return Boolean(text(fields.hotel));
  if (key === "profiles") return Array.isArray(extra.hotel_profiles) && extra.hotel_profiles.length > 0;
  if (key === "ages") return Object.values(record(extra.age_rules)).some((value) => Boolean(text(value)));
  if (key === "list:included") return filled(extra.included_items);
  if (key === "list:excluded") return filled(extra.excluded_items);
  if (key === "list:important") return filled(extra.important_notes);
  return Boolean(text(record(extra.booking_terms)[key.slice("terms:".length)]));
}

/** The fields of one part that show (a value, opened from its chip, or «Бүх талбар»), and the chips for the rest. */
export function splitOptional(fields: Row, keys: OptionalKey[], options: ShowOptions = {}): { shown: OptionalKey[]; chips: Array<Chip<OptionalKey>> } {
  const shown: OptionalKey[] = [];
  const chips: Array<Chip<OptionalKey>> = [];
  for (const key of keys) {
    if (options.all || options.revealed?.has(key) || hasOptionalValue(fields, key)) shown.push(key);
    else chips.push({ key, label: OPTIONAL_LABELS[key] });
  }
  return { shown, chips };
}

/* ------------------------------------------------------------------ the price table */

/** Optional columns of the dates-and-prices table. */
export type PriceColumn = "bands" | "infant" | "single" | "hotel";

export const PRICE_COLUMN_LABELS: Record<PriceColumn, string> = {
  bands: "Өөр насны ангилал",
  infant: "Нярай",
  single: "Ганц өрөө",
  hotel: "Буудал, багц",
};

const COLUMN_ORDER: PriceColumn[] = ["bands", "infant", "single", "hotel"];

const hasColumnValue = (card: PriceCard, column: PriceColumn): boolean =>
  column === "infant" ? card.infant !== null
    : column === "single" ? card.single !== null
      : column === "hotel" ? Boolean(card.hotel || card.packageId)
        : card.bands.some((band) => band.role === "other");

/**
 * The optional columns the table shows: those some row has a value in, those opened from a chip.
 * Only a price row of its own («own») holds a hotel, a single-room extra or an extra age band; the
 * trip's own fares («all») hold an infant fare at most, so the other chips need an own row.
 */
export function priceColumns(cards: PriceCard[], options: ShowOptions = {}): { shown: PriceColumn[]; chips: Array<Chip<PriceColumn>> } {
  const own = cards.some((card) => card.kind === "own");
  const shown: PriceColumn[] = [];
  const chips: Array<Chip<PriceColumn>> = [];
  for (const column of COLUMN_ORDER) {
    if (cards.some((card) => hasColumnValue(card, column))) shown.push(column);
    else if (column !== "infant" && !own) continue;
    else if (options.all || options.revealed?.has(`column:${column}`)) shown.push(column);
    else chips.push({ key: column, label: PRICE_COLUMN_LABELS[column] });
  }
  return { shown, chips };
}

/** The name of the child fare's column: the rows' own name when they all agree («Хүүхэд ортой»), else «Хүүхэд». */
export function childHeader(cards: PriceCard[]): string {
  const names = new Set(cards.flatMap((card) => card.bands.filter((band) => band.role === "child").map((band) => text(band.row.label))).filter(Boolean));
  return names.size === 1 ? Array.from(names)[0] : "Хүүхэд";
}

/** The extra age bands, by name: «Хүүхэд ор эзлэхгүй» … (a band with no name is called by its age). */
export function bandLabel(row: Row): string {
  return text(row.label) || text(row.age_range) || "Ангилал";
}

/* ------------------------------------------------------------------ one price row's editor */

export type CardField = "infant" | "hotel" | "package" | "single" | "label" | "note";

export const CARD_FIELD_LABELS: Record<CardField, string> = {
  infant: "Нярай",
  hotel: "Буудал",
  package: "Багц",
  single: "Ганц өрөө",
  label: "Үнийн нэр",
  note: "Тэмдэглэл",
};

const CARD_FIELD_ORDER: CardField[] = ["infant", "hotel", "package", "single", "label", "note"];

function cardFieldValue(card: PriceCard, field: CardField): boolean {
  if (field === "infant") return card.infant !== null;
  if (field === "hotel") return Boolean(card.hotel);
  if (field === "package") return Boolean(card.packageId);
  if (field === "single") return card.single !== null;
  return Boolean(text(card.group[field]));
}

/**
 * The boxes a price row's editor shows beside the adult and child fare: the ones with a value, the
 * ones whose table column is shown, the ones opened from a chip. The trip's own fares («all») have
 * no hotel, package, single-room extra, name or note: only the infant fare is offered there.
 */
export function cardFields(card: PriceCard, columns: readonly PriceColumn[], options: ShowOptions = {}): { shown: CardField[]; chips: Array<Chip<CardField>> } {
  const shown: CardField[] = [];
  const chips: Array<Chip<CardField>> = [];
  for (const field of CARD_FIELD_ORDER) {
    if (card.kind === "all" && field !== "infant") continue;
    // A shown column opens its box on every row (the package stays a chip: few rows have one).
    const column = field === "infant" ? "infant" : field === "single" ? "single" : field === "hotel" ? "hotel" : null;
    if (cardFieldValue(card, field) || options.all || options.revealed?.has(`${card.key}:${field}`) || (column && columns.includes(column))) shown.push(field);
    else chips.push({ key: field, label: CARD_FIELD_LABELS[field] });
  }
  return { shown, chips };
}
