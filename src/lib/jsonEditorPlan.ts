/**
 * The JSON editor's save plan: what a pasted catalogue would actually change.
 *
 * Staff export every trip, run it through ChatGPT and paste the answer back,
 * often minutes or hours later. Only trips that differ from what was loaded are
 * sent, each with the version it was loaded at, so an untouched trip is never
 * rewritten and a trip someone else changed meanwhile is refused, not reverted.
 * Pure: shared by the admin tab, its tests and the bulk API's field lists.
 */

export const JSON_EDITOR_TEXT_FIELDS = ["operator_name", "category", "duration_text", "currency", "hotel", "notes", "source_description"] as const;
export const JSON_EDITOR_NUMBER_FIELDS = ["adult_price", "child_price", "infant_price", "seats_total", "seats_left"] as const;
export const JSON_EDITOR_EXTRA_FIELDS = [
  "aliases", "price_groups", "discounts", "departure_date_groups", "child_rules", "extra_fees",
  "departure_rule", "included_items", "excluded_items", "room_prices", "important_notes",
  "brochure_pdf_url", "customer_visible", "source_provenance", "answer_hints",
  "needs_human_review", "review_reasons",
] as const;

const ACCEPTED_FIELDS = new Set<string>([
  "route_name", ...JSON_EDITOR_TEXT_FIELDS, ...JSON_EDITOR_NUMBER_FIELDS,
  "departure_dates", "has_food", "status", ...JSON_EDITOR_EXTRA_FIELDS,
]);

export const JSON_EDITOR_FIELD_LABELS: Record<string, string> = {
  route_name: "Аяллын нэр", operator_name: "Оператор", category: "Ангилал", duration_text: "Хугацаа",
  currency: "Валют", hotel: "Буудал", notes: "Тэмдэглэл", source_description: "Эх сурвалж",
  adult_price: "Том хүний үнэ", child_price: "Хүүхдийн үнэ", infant_price: "Нярайн үнэ",
  seats_total: "Нийт суудал", seats_left: "Үлдсэн суудал", departure_dates: "Гарах өдөр",
  has_food: "Хоол", status: "Төлөв", aliases: "Өөр нэрс", price_groups: "Огнооны үнэ",
  discounts: "Хямдрал", departure_date_groups: "Огнооны бүлэг", child_rules: "Хүүхдийн үнийн дүрэм",
  extra_fees: "Нэмэлт төлбөр", departure_rule: "Гарах дүрэм", included_items: "Багтсан зүйл",
  excluded_items: "Багтаагүй зүйл", room_prices: "Өрөөний үнэ", important_notes: "Чухал тэмдэглэл",
  brochure_pdf_url: "PDF холбоос", customer_visible: "Харагдах эсэх", source_provenance: "Эх сурвалжийн тэмдэглэл",
  answer_hints: "Хариултын зөвлөмж", needs_human_review: "Шалгах шаардлага", review_reasons: "Шалгах шалтгаан",
};

export type JsonEditorTrip = Record<string, unknown>;
export type FieldChange = { field: string; label: string; before?: string; after?: string };
export type PlannedUpdate = { id: string; name: string; changes: FieldChange[]; patch: JsonEditorTrip };
export type PlannedCreate = { name: string; trip: JsonEditorTrip };
export type BlockedEntry = { name: string; reason: string };
export type JsonEditorPlan = {
  updates: PlannedUpdate[];
  creates: PlannedCreate[];
  unchanged: number;
  blocked: BlockedEntry[];
  /** Keys the pasted JSON carries that the catalogue does not store; they are not sent. */
  ignoredFields: string[];
};

/** JSON with object keys sorted, so a reordered but identical value compares equal. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Accepts the exported array or a `{ "trips": [...] }` wrapper. */
export function parseTripsJson(text: string): { trips: unknown[] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { error: `JSON алдаа: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (Array.isArray(parsed)) return { trips: parsed };
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).trips)) {
    return { trips: (parsed as { trips: unknown[] }).trips };
  }
  return { error: "JSON нь [ ] жагсаалт эсвэл { \"trips\": [ ] } хэлбэртэй байх ёстой." };
}

function scalarText(field: string, value: unknown): string | undefined {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return field.endsWith("_price") ? `${value.toLocaleString("mn-MN")}₮` : String(value);
  if (typeof value === "boolean") return value ? "тийм" : "үгүй";
  if (typeof value === "string") return value.length > 60 ? `${value.slice(0, 57)}…` : value || "—";
  if (Array.isArray(value) && field === "departure_dates") return `${value.length} огноо`;
  return undefined;
}

function tripName(trip: JsonEditorTrip, fallback?: JsonEditorTrip): string {
  const name = typeof trip.route_name === "string" && trip.route_name.trim() ? trip.route_name
    : typeof fallback?.route_name === "string" ? fallback.route_name : "";
  return name.trim() || "(нэргүй)";
}

export function planJsonEditorSave(pasted: readonly unknown[], baseline: ReadonlyMap<string, JsonEditorTrip>): JsonEditorPlan {
  const plan: JsonEditorPlan = { updates: [], creates: [], unchanged: 0, blocked: [], ignoredFields: [] };
  const ignored = new Set<string>();
  const seen = new Set<string>();
  for (const entry of pasted) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      plan.blocked.push({ name: "—", reason: "Аялал бүр { } объект байх ёстой." });
      continue;
    }
    const trip = entry as JsonEditorTrip;
    for (const key of Object.keys(trip)) if (key !== "id" && !ACCEPTED_FIELDS.has(key)) ignored.add(key);
    const id = typeof trip.id === "string" ? trip.id.trim() : "";
    if (!id) {
      if (typeof trip.route_name !== "string" || !trip.route_name.trim()) {
        plan.blocked.push({ name: "(нэргүй)", reason: "id болон route_name хоёулаа алга." });
      } else {
        plan.creates.push({ name: tripName(trip), trip });
      }
      continue;
    }
    const before = baseline.get(id);
    if (!before) {
      plan.blocked.push({ name: tripName(trip), reason: "Энэ id ачаалсан жагсаалтад алга (архивласан эсвэл хуучин файл). «Дахин татах» дарна уу." });
      continue;
    }
    if (seen.has(id)) {
      plan.blocked.push({ name: tripName(trip, before), reason: "Нэг id хоёр удаа орсон байна." });
      continue;
    }
    seen.add(id);
    const changes: FieldChange[] = [];
    const patch: JsonEditorTrip = { id };
    for (const [field, value] of Object.entries(trip)) {
      if (field === "id" || !ACCEPTED_FIELDS.has(field)) continue;
      if (stableStringify(value) === stableStringify(before[field])) continue;
      patch[field] = value;
      const beforeText = scalarText(field, before[field]);
      const afterText = scalarText(field, value);
      changes.push({
        field,
        label: JSON_EDITOR_FIELD_LABELS[field] || field,
        ...(beforeText !== undefined && afterText !== undefined ? { before: beforeText, after: afterText } : {}),
      });
    }
    if (changes.length === 0) plan.unchanged += 1;
    else plan.updates.push({ id, name: tripName(trip, before), changes, patch });
  }
  plan.ignoredFields = [...ignored].sort();
  return plan;
}
