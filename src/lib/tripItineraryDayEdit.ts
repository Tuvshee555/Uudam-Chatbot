/**
 * "3-р өдрийн хөтөлбөрийг өөрчил": one program day changed, every other day untouched.
 *
 * patchTrip replaces `extra.itinerary_days` as a whole, so the action carries only the day and
 * the parts that change (title, description, hotel, meals, meal note) and this merges them into
 * the trip's current program. Meals are three-state: true included, false the traveller pays,
 * null the program does not say — a meal the action does not name keeps its state. An empty
 * hotel or meal note clears it. The poster day follows through patchTrip's poster sync
 * (tripToPoster maps title → route, description → summary, hotel, meals, meal note).
 *
 * Pure.
 */
import type { TravelTrip, TripMutationFields } from "./travelTypes";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const records = (value: unknown): Row[] => (Array.isArray(value) ? value.map(record) : []);
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

export type ItineraryDayInput = {
  day?: unknown; title?: unknown; description?: unknown; hotel?: unknown; meals?: unknown; meal_note?: unknown;
};

export type ItineraryDayPlan = { fields: TripMutationFields; posterKeys: string[]; lines: string[]; warnings: string[] };

const MEALS = ["breakfast", "lunch", "dinner"] as const;
const MEAL_WORDS: Record<(typeof MEALS)[number], string> = { breakfast: "өглөөний хоол", lunch: "өдрийн хоол", dinner: "оройн хоол" };
const mealState = (value: unknown) => (value === true ? "багтсан" : value === false ? "өөрийн зардлаар" : "тодорхойгүй");
const clip = (value: string, max = 60) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** Sanitized patch parts of one day; `undefined` for a part the action does not change. */
export function itineraryDayPatchOf(input: ItineraryDayInput): Row {
  const patch: Row = {};
  for (const key of ["title", "description"] as const) {
    if (typeof input[key] === "string" && text(input[key])) patch[key] = text(input[key]).slice(0, key === "title" ? 300 : 6000);
  }
  for (const key of ["hotel", "meal_note"] as const) {
    if (typeof input[key] === "string") patch[key] = text(input[key]).slice(0, 300);
  }
  const meals = record(input.meals);
  const mealPatch: Row = {};
  for (const key of MEALS) {
    if (key in meals && (meals[key] === true || meals[key] === false || meals[key] === null)) mealPatch[key] = meals[key];
  }
  if (Object.keys(mealPatch).length) patch.meals = mealPatch;
  return patch;
}

export function planItineraryDay(trip: TravelTrip, input: ItineraryDayInput): { ok: true; plan: ItineraryDayPlan } | { ok: false; reason: string } {
  const days = records(trip.extra?.itinerary_days);
  const dayNumber = typeof input.day === "number" ? input.day : Number(input.day);
  if (!days.length) return { ok: false, reason: `«${trip.route_name}» аялалд өдрийн хөтөлбөр алга.` };
  if (!Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > days.length) {
    return { ok: false, reason: `Хөтөлбөрт ${days.length} өдөр байна; ${Number.isFinite(dayNumber) ? `${dayNumber}-р` : "заасан"} өдөр алга.` };
  }
  const patch = itineraryDayPatchOf(input);
  if (!Object.keys(patch).length) return { ok: false, reason: `${dayNumber}-р өдрийн юуг өөрчлөхийг заагаагүй байна.` };
  const current = days[dayNumber - 1];
  const next: Row = { ...current };
  const lines: string[] = [];
  const prefix = `${dayNumber}-р өдөр`;
  if ("title" in patch && patch.title !== text(current.title)) {
    lines.push(`${prefix}: гарчиг «${clip(text(current.title)) || "—"}» → «${clip(String(patch.title))}»`);
    next.title = patch.title;
  }
  if ("description" in patch && patch.description !== text(current.description)) {
    lines.push(`${prefix}: тайлбар шинэчлэгдэнэ («${clip(String(patch.description), 80)}»)`);
    next.description = patch.description;
  }
  if ("hotel" in patch && patch.hotel !== text(current.hotel)) {
    lines.push(`${prefix}: буудал ${text(current.hotel) || "—"} → ${String(patch.hotel) || "—"}`);
    if (patch.hotel) next.hotel = patch.hotel;
    else delete next.hotel;
  }
  if (patch.meals) {
    const meals = { ...record(current.meals) };
    for (const [key, value] of Object.entries(record(patch.meals))) {
      const before = key in meals ? meals[key] : null;
      if (before === value) continue;
      lines.push(`${prefix}: ${MEAL_WORDS[key as (typeof MEALS)[number]]} ${mealState(before)} → ${mealState(value)}`);
      meals[key] = value;
    }
    next.meals = meals;
  }
  if ("meal_note" in patch && patch.meal_note !== text(current.meal_note)) {
    lines.push(`${prefix}: хоолны тэмдэглэл «${clip(text(current.meal_note)) || "—"}» → «${clip(String(patch.meal_note)) || "—"}»`);
    if (patch.meal_note) next.meal_note = patch.meal_note;
    else delete next.meal_note;
  }
  if (!lines.length) return { ok: false, reason: `${dayNumber}-р өдөр аль хэдийн ийм байна.` };
  const nextDays = days.map((day, index) => (index === dayNumber - 1 ? next : day));
  // The poster day follows through patchTrip's own poster sync; nothing is written to it here.
  return { ok: true, plan: { fields: { extra: { itinerary_days: nextDays } }, posterKeys: [], lines, warnings: [] } };
}
