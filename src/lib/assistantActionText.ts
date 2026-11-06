/**
 * What one proposed change does, in plain Mongolian, for the proposal card: a title (the trip)
 * and before → after lines ("12/2: насанд хүрэгч 2,590,000₮ → 2,690,000₮", "3-р өдрийн зураг
 * солигдоно" with both thumbnails, "Сайт, ботоос нууна"). Built from the same planners apply
 * uses, so the card says exactly what saving will write. Pure and browser-safe (no database).
 */
import { DATE_STATE_WORDS, WEBSITE_STATUS_WORDS, fareChangeOf, isDepartureDateState, planTripEdit } from "./tripActionPlan";
import { FARE_WORDS, formatMnt } from "./tripFareChange";
import { shortDay } from "./tripDatePrice";
import type { AITripAction, TravelTrip } from "./travelTypes";

export type ChangeDescription = { title: string; lines: string[]; thumbs?: { before?: string; after?: string } };

type Row = Record<string, unknown>;
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const STATUS_WORDS: Record<string, string> = {
  active: "Идэвхтэй", paused: "Түр зогссон", sold_out: "Дүүрсэн", cancelled: "Цуцлагдсан", draft: "Ноорог", archived: "Архивласан",
};
const FIELD_WORDS: Record<string, string> = {
  route_name: "Нэр", duration_text: "Хугацаа", hotel: "Буудал", has_food: "Хоол", seats_total: "Нийт суудал",
  seats_left: "Үлдсэн суудал", status: "Төлөв", notes: "Тэмдэглэл", operator_name: "Оператор", category: "Ангилал",
  currency: "Валют", source_description: "Эх сурвалж",
};
const EXTRA_WORDS: Record<string, string> = {
  price_groups: "Огноогоор үнэ", itinerary_days: "Өдрийн хөтөлбөр", age_rules: "Насны ангилал", customer_visible: "Сайт, ботод харагдах",
  included_items: "Багтсан зүйлс", excluded_items: "Багтаагүй зүйлс", aliases: "Өөр нэрс", photo_credits: "Зургийн эх сурвалж",
};

function shown(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "тийм" : "үгүй";
  if (typeof value === "number") return value >= 1000 ? value.toLocaleString("en-US") : String(value);
  const out = String(value).replace(/\s+/g, " ").trim();
  return out.length > 60 ? `${out.slice(0, 59)}…` : out;
}

function tripName(action: AITripAction, trip?: TravelTrip | null): string {
  const name = trip?.route_name || text(action.fields?.route_name) || text(action.match?.route_name);
  return name ? `«${name}»` : "Аялал";
}

/** A plain patch: each field it changes, before → after. */
function patchLines(action: AITripAction, trip?: TravelTrip | null): string[] {
  const fields = record(action.fields);
  const lines: string[] = [];
  for (const kind of ["adult", "child", "infant"] as const) {
    const key = `${kind}_price`;
    if (!(key in fields)) continue;
    const before = trip ? (trip as unknown as Row)[key] : undefined;
    lines.push(`${FARE_WORDS[kind]} ${trip ? formatMnt(before as number | null) : "—"} → ${formatMnt(fields[key] as number | null)}`);
  }
  for (const [key, value] of Object.entries(fields)) {
    if (key.endsWith("_price") || key === "extra" || key === "photo_urls" || key === "departure_dates") continue;
    const before = trip ? (trip as unknown as Row)[key] : undefined;
    const word = FIELD_WORDS[key] || key;
    const after = key === "status" ? STATUS_WORDS[String(value)] || shown(value) : shown(value);
    const was = key === "status" ? STATUS_WORDS[String(before)] || shown(before) : shown(before);
    lines.push(trip ? `${word}: ${was} → ${after}` : `${word}: ${after}`);
  }
  if (Array.isArray(fields.departure_dates)) {
    const before = trip?.departure_dates || [];
    const added = fields.departure_dates.filter((date) => !before.includes(String(date)));
    const removed = before.filter((date) => !(fields.departure_dates as unknown[]).includes(date));
    if (added.length) lines.push(`Гаралт нэмнэ: ${added.map((date) => shortDay(String(date))).join(", ")}`);
    if (removed.length) lines.push(`Гаралт хасна: ${removed.map((date) => shortDay(String(date))).join(", ")}`);
    if (!added.length && !removed.length) lines.push(`Гаралтын огноо: ${fields.departure_dates.length}`);
  }
  if (Array.isArray(fields.photo_urls)) lines.push(`Зургийн тоо: ${trip ? trip.photo_urls.length : "—"} → ${fields.photo_urls.length}`);
  for (const key of Object.keys(record(fields.extra))) {
    if (key === "child_rules" || key === "departure_dates_resolved") continue;
    if (key === "customer_visible") lines.push(record(fields.extra).customer_visible === false ? "Сайт, ботоос нууна" : "Сайт, ботод харуулна");
    else if (key === "price_groups") lines.push(`${EXTRA_WORDS[key]} шинэчлэгдэнэ (${(record(fields.extra).price_groups as unknown[] | undefined)?.length ?? 0} мөр)`);
    else lines.push(`${EXTRA_WORDS[key] || key} шинэчлэгдэнэ`);
  }
  return lines;
}

/** The card text for one action. `trip` is the trip as the admin sees it now (null for a new trip). */
export function describeChange(action: AITripAction, trip?: TravelTrip | null, now: Date = new Date()): ChangeDescription {
  const verb = String(action?.action || "").toLowerCase();
  const title = tripName(action, trip);
  const summary = text(action?.summary);
  const fallback = (lines: string[]): ChangeDescription => ({ title, lines: lines.length ? lines : summary ? [summary] : ["Өөрчлөлт"] });

  if (verb === "set_date_state") {
    const date = text(action.date);
    const state = isDepartureDateState(action.state) ? DATE_STATE_WORDS[action.state] : shown(action.state);
    const row = trip ? (Array.isArray(trip.extra?.website_departure_availability) ? trip.extra.website_departure_availability as unknown[] : []).map(record).find((entry) => entry.date === date) : undefined;
    const was = row ? WEBSITE_STATUS_WORDS[text(row.status).toUpperCase()] || text(row.status) : "";
    return { title, lines: [`${shortDay(date)}: ${was ? `${was} → ` : ""}${state}`] };
  }
  if (verb === "fare_change_all") {
    const change = fareChangeOf(action.change);
    const parts: string[] = [];
    if (change?.everyone) parts.push(`бүх үнэ ${change.everyone > 0 ? "+" : "−"}${formatMnt(Math.abs(change.everyone))}`);
    for (const kind of ["adult", "child", "infant"] as const) {
      const intent = change?.[kind];
      if (!intent) continue;
      if (intent.set != null) parts.push(`${FARE_WORDS[kind]} ${formatMnt(intent.set)}`);
      else if (intent.delta != null) parts.push(`${FARE_WORDS[kind]} ${intent.delta > 0 ? "+" : "−"}${formatMnt(Math.abs(intent.delta))}`);
      else if (intent.belowAdult != null) parts.push(`${FARE_WORDS[kind]} = том хүн − ${formatMnt(intent.belowAdult)}`);
    }
    const which = action.filter?.all_active ? "Бүх идэвхтэй аялал" : `${action.filter?.trip_ids?.length ?? 0} аялал`;
    return { title: "Олон аяллын үнэ", lines: [`${which}: ${parts.join(", ") || "үнийн өөрчлөлт"}`, "Аялал бүрт тусдаа өөрчлөлт болж хадгалагдана; хамтрагчийн аялал алгасагдана."] };
  }
  if (verb === "cancel") return fallback(["Аяллыг цуцална — сайт, ботод захиалга авахаа болино", ...patchLines({ ...action, fields: { ...record(action.fields) } }, trip).filter((line) => !line.startsWith("Төлөв"))]);
  if (verb === "delete") return { title, lines: ["Архивлана — сайт, ботоос харагдахаа болино (бичлэг, зураг, түүх хадгалагдана, буцааж болно)"] };
  if (verb === "upsert" && !trip) {
    const fields = record(action.fields);
    return { title: `Шинэ аялал: «${text(fields.route_name) || "нэргүй"}»`, lines: [
      ...(typeof fields.adult_price === "number" ? [`${FARE_WORDS.adult} ${formatMnt(fields.adult_price)}`] : []),
      ...(Array.isArray(fields.departure_dates) && fields.departure_dates.length ? [`Гаралт: ${fields.departure_dates.length} огноо`] : []),
      "Шинэ аялал болж нэмэгдэнэ",
    ] };
  }
  if (verb === "patch" || verb === "upsert") return fallback(patchLines(action, trip));

  if (!trip) return fallback([]);
  const planned = planTripEdit(trip, action, null, now);
  if (!planned.ok) return { title, lines: [planned.reason] };
  return {
    title,
    lines: [...planned.plan.lines, ...planned.plan.warnings.map((warning) => `Анхаар: ${warning}`)],
    ...(planned.plan.thumbs && (planned.plan.thumbs.before || planned.plan.thumbs.after) ? { thumbs: planned.plan.thumbs } : {}),
  };
}
