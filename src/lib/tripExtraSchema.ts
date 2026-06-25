/**
 * Canonical shape for the `extra` JSONB column on travel_trip_entries.
 *
 * Every write path (upsertTrip, patchTrip, trips-bulk) runs the incoming
 * extra blob through `normalizeExtra()` before it hits the database.  This
 * catches Gemini key-name drift (e.g. "departureGroups" instead of
 * "departure_date_groups"), coerces types, and auto-regenerates date_keys so
 * the bot's lookup never silently reads an empty array.
 */

import { generateDateKeys } from "./travelDates";

// ─── known keys ──────────────────────────────────────────────────────────────

const KNOWN_EXTRA_KEYS = new Set([
  "aliases",
  "price_groups",
  "discounts",
  "departure_date_groups", // legacy: Gemini still writes this sometimes
  "child_rules",
  "extra_fees",
  "departure_rule",
  "recurring_schedule",
  "included_items",
  "excluded_items",
  "room_prices",
  "important_notes",
  "brochure_pdf_url",
  "source_file_name",
  "source_file_attachment_id",
  "original_title_text",
  "customer_visible",
  "source_provenance",
  "answer_hints",
  "needs_human_review",
  "review_reasons",
]);

// ─── helpers ─────────────────────────────────────────────────────────────────

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim() !== "");
}

function asNumberOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string") {
    const n = Number(v.replace(/,/g, ""));
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function enrichDateKeys<T extends Record<string, unknown>>(group: T): T {
  const dates = asStringArray(group.dates);
  const existing = asStringArray(group.date_keys);
  const all = new Set<string>(existing);
  for (const d of dates) {
    for (const k of generateDateKeys(d)) all.add(k);
  }
  const displayDates = asStringArray(group.display_dates).length > 0
    ? asStringArray(group.display_dates)
    : dates;
  return { ...group, date_keys: Array.from(all), display_dates: displayDates };
}

function normalizePriceGroups(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((g): g is Record<string, unknown> => !!g && typeof g === "object")
    .map((g) =>
      enrichDateKeys({
        label: asString(g.label),
        dates: asStringArray(g.dates),
        display_dates: asStringArray(g.display_dates),
        date_keys: asStringArray(g.date_keys),
        adult_price: asNumberOrNull(g.adult_price),
        child_price: asNumberOrNull(g.child_price),
        infant_price: asNumberOrNull(g.infant_price),
        child_age: asString(g.child_age),
        infant_age: asString(g.infant_age),
        passenger_prices: normalizePassengerPrices(g.passenger_prices),
        note: asString(g.note || g.notes),
      }),
    );
}

function normalizeDiscountGroups(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((g): g is Record<string, unknown> => !!g && typeof g === "object")
    .map((g) =>
      enrichDateKeys({
        label: asString(g.label),
        dates: asStringArray(g.dates),
        display_dates: asStringArray(g.display_dates),
        date_keys: asStringArray(g.date_keys),
        adult_price: asNumberOrNull(g.adult_price),
        child_price: asNumberOrNull(g.child_price),
        infant_price: asNumberOrNull(g.infant_price),
        condition: asString(g.condition),
        note: asString(g.note || g.notes),
      }),
    );
}

function normalizeDepartureDateGroups(raw: unknown): Record<string, unknown>[] {
  // Legacy format written by Gemini: same shape as price_groups but stored
  // under "departure_date_groups".  Normalise the same way.
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((g): g is Record<string, unknown> => !!g && typeof g === "object")
    .map((g) =>
      enrichDateKeys({
        label: asString(g.label),
        dates: asStringArray(g.dates),
        display_dates: asStringArray(g.display_dates),
        date_keys: asStringArray(g.date_keys),
        adult_price: asNumberOrNull(g.adult_price),
        child_price: asNumberOrNull(g.child_price),
        infant_price: asNumberOrNull(g.infant_price),
        child_age: asString(g.child_age),
        infant_age: asString(g.infant_age),
        note: asString(g.note || g.notes),
      }),
    );
}

function normalizePassengerPrices(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    .map((p) => ({
      label: asString(p.label),
      age_range: asString(p.age_range),
      price: asNumberOrNull(p.price),
      currency: asString(p.currency, "MNT"),
    }));
}

function normalizeChildRules(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => ({
      label: asString(r.label),
      age_range: asString(r.age_range),
      price: asNumberOrNull(r.price),
      currency: asString(r.currency, "MNT"),
      note: asString(r.note || r.notes),
    }));
}

function normalizeExtraFees(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
    .map((f) => ({
      label: asString(f.label),
      amount: asNumberOrNull(f.amount),
      currency: asString(f.currency, "MNT"),
      applies_to: asString(f.applies_to),
      note: asString(f.note || f.notes),
    }));
}

function normalizeRoomPrices(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => ({
      room_type: asString(r.room_type),
      price: asNumberOrNull(r.price),
      currency: asString(r.currency, "MNT"),
      note: asString(r.note || r.notes),
    }));
}

function normalizeSourceProvenance(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    .map((p) => ({
      file_name: asString(p.file_name),
      page: asNumberOrNull(p.page),
      source_text: asString(p.source_text),
      confidence: ["high", "medium", "low"].includes(asString(p.confidence))
        ? asString(p.confidence)
        : "medium",
    }));
}

function normalizeAnswerHints(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((h): h is Record<string, unknown> => !!h && typeof h === "object")
    .map((h) => ({
      intent: ["price", "discount", "comparison", "child_price", "included", "schedule"].includes(
        asString(h.intent),
      )
        ? asString(h.intent)
        : "price",
      question_pattern: asString(h.question_pattern),
      expected_answer_summary: asString(h.expected_answer_summary),
    }));
}

// ─── public API ──────────────────────────────────────────────────────────────

export type NormalizeExtraResult = {
  extra: Record<string, unknown>;
  /** Human-readable warnings about keys or values that were coerced / dropped. */
  warnings: string[];
};

/**
 * Normalise a raw `extra` object before writing it to the database.
 *
 * - Canonicalises every known key (type coercion, array enforcement)
 * - Auto-generates date_keys for every price_group / discount / departure_date_group
 * - Collects unknown keys into warnings so the admin can be alerted
 * - Preserves unknown top-level keys that were already in the DB (pass-through)
 *   so existing data is never silently dropped — just warned about
 */
export function normalizeExtra(
  raw: Record<string, unknown>,
): NormalizeExtraResult {
  const warnings: string[] = [];

  // Detect unknown keys from AI output
  const unknownKeys = Object.keys(raw).filter((k) => !KNOWN_EXTRA_KEYS.has(k));
  if (unknownKeys.length > 0) {
    warnings.push(`Үл мэдэгдэх extra талбарууд (хадгалагдах боловч шалгана уу): ${unknownKeys.join(", ")}`);
  }

  const priceGroups = normalizePriceGroups(raw.price_groups);
  const discounts = normalizeDiscountGroups(raw.discounts);
  const departureDateGroups = normalizeDepartureDateGroups(raw.departure_date_groups);

  // Warn if Gemini wrote departure_date_groups but not price_groups
  if (departureDateGroups.length > 0 && priceGroups.length === 0) {
    warnings.push(
      `departure_date_groups-ийг price_groups болгон хөрвүүлсэн (${departureDateGroups.length} бүлэг) — шалгана уу`,
    );
  }

  // Use price_groups as canonical; merge departure_date_groups in if price_groups is empty
  const canonicalPriceGroups =
    priceGroups.length > 0 ? priceGroups : departureDateGroups;

  // Warn about price groups missing dates
  const groupsMissingDates = canonicalPriceGroups.filter(
    (g) => (g.date_keys as string[]).length === 0,
  );
  if (groupsMissingDates.length > 0) {
    warnings.push(
      `${groupsMissingDates.length} үнийн бүлэгт огноо байхгүй — хайлтаар олдохгүй байж болно`,
    );
  }

  const extra: Record<string, unknown> = {
    // Pass through unknown keys so existing DB data isn't lost
    ...Object.fromEntries(
      Object.entries(raw).filter(([k]) => !KNOWN_EXTRA_KEYS.has(k)),
    ),
    // Canonical known fields
    aliases: asStringArray(raw.aliases),
    price_groups: canonicalPriceGroups,
    discounts,
    departure_date_groups: departureDateGroups,
    child_rules: normalizeChildRules(raw.child_rules),
    extra_fees: normalizeExtraFees(raw.extra_fees),
    departure_rule: asString(raw.departure_rule),
    recurring_schedule: asString(raw.recurring_schedule),
    included_items: asStringArray(raw.included_items),
    excluded_items: asStringArray(raw.excluded_items),
    room_prices: normalizeRoomPrices(raw.room_prices),
    important_notes: asStringArray(raw.important_notes),
    brochure_pdf_url: asString(raw.brochure_pdf_url) || null,
    source_file_name: asString(raw.source_file_name),
    source_file_attachment_id: asString(raw.source_file_attachment_id) || null,
    original_title_text: asString(raw.original_title_text),
    customer_visible:
      typeof raw.customer_visible === "boolean" ? raw.customer_visible : true,
    source_provenance: normalizeSourceProvenance(raw.source_provenance),
    answer_hints: normalizeAnswerHints(raw.answer_hints),
    needs_human_review:
      typeof raw.needs_human_review === "boolean" ? raw.needs_human_review : false,
    review_reasons: asStringArray(raw.review_reasons),
  };

  return { extra, warnings };
}

// ─── diff helpers (used by the UI proposal view) ─────────────────────────────

export type TripExtraDiff = {
  field: string;
  label: string;
  before: string;
  after: string;
  kind: "added" | "removed" | "changed";
};

/** Returns human-readable field-level diffs between an incoming proposal action
 *  and the existing trip currently in the DB. */
export function diffTripFields(
  incoming: Record<string, unknown>,
  existing: {
    adult_price: number | null;
    child_price: number | null;
    departure_dates: string[];
    status: string;
    seats_total: number | null;
    seats_left: number | null;
    duration_text: string;
    currency: string;
  },
): TripExtraDiff[] {
  const diffs: TripExtraDiff[] = [];
  const currency = (typeof incoming.currency === "string" ? incoming.currency : existing.currency) || "MNT";
  const fmt = (n: number | null) =>
    n == null ? "—" : `${n.toLocaleString("mn-MN")}${currency === "MNT" ? "₮" : ` ${currency}`}`;

  function push(field: string, label: string, before: string, after: string) {
    if (before === after) return;
    const kind: TripExtraDiff["kind"] =
      before === "—" ? "added" : after === "—" ? "removed" : "changed";
    diffs.push({ field, label, before, after, kind });
  }

  if ("adult_price" in incoming) {
    push("adult_price", "Том хүн үнэ", fmt(existing.adult_price), fmt(asNumberOrNull(incoming.adult_price)));
  }
  if ("child_price" in incoming) {
    push("child_price", "Хүүхэд үнэ", fmt(existing.child_price), fmt(asNumberOrNull(incoming.child_price)));
  }
  if ("status" in incoming) {
    const statusLabel: Record<string, string> = {
      active: "Идэвхтэй", cancelled: "Цуцлагдсан", sold_out: "Суудал дүүрсэн", draft: "Ноорог",
    };
    const bef = statusLabel[existing.status] ?? existing.status;
    const aft = statusLabel[asString(incoming.status)] ?? asString(incoming.status);
    push("status", "Төлөв", bef, aft);
  }
  if ("seats_total" in incoming) {
    push("seats_total", "Нийт суудал", existing.seats_total == null ? "—" : String(existing.seats_total), asNumberOrNull(incoming.seats_total) == null ? "—" : String(asNumberOrNull(incoming.seats_total)));
  }
  if ("seats_left" in incoming) {
    push("seats_left", "Үлдсэн суудал", existing.seats_left == null ? "—" : String(existing.seats_left), asNumberOrNull(incoming.seats_left) == null ? "—" : String(asNumberOrNull(incoming.seats_left)));
  }
  if ("duration_text" in incoming) {
    push("duration_text", "Хугацаа", existing.duration_text || "—", asString(incoming.duration_text) || "—");
  }

  // Departure dates diff
  if (Array.isArray(incoming.departure_dates)) {
    const oldDates = new Set(existing.departure_dates);
    const newDates = new Set(incoming.departure_dates as string[]);
    const added = [...newDates].filter((d) => !oldDates.has(d));
    const removed = [...oldDates].filter((d) => !newDates.has(d));
    if (added.length > 0) {
      diffs.push({ field: "departure_dates_added", label: "Шинэ огноо нэмсэн", before: "", after: added.slice(0, 5).join(", ") + (added.length > 5 ? ` (+${added.length - 5})` : ""), kind: "added" });
    }
    if (removed.length > 0) {
      diffs.push({ field: "departure_dates_removed", label: "Огноо хасагдсан", before: removed.slice(0, 5).join(", ") + (removed.length > 5 ? ` (+${removed.length - 5})` : ""), after: "", kind: "removed" });
    }
  }

  return diffs;
}
