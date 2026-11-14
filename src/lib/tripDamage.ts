/**
 * The changes that hurt a saved trip, whatever proposed them (the agent, a file or page reading,
 * the brain, a partner check): its name replaced, the trip taken off the website (no departure
 * left ahead, or its status moved off), every price row or the adult price removed, its program
 * cut to less than half.
 *
 * Why (2026-11-14): a file reading renamed a live trip and emptied its dates and price rows inside
 * a NEW-trip review card. It was saved like any edit, the trip was archived for having no dates
 * and left the website, and nothing said so. Now such a change is marked on the card (`damage`)
 * and save refuses it until the admin ticks that he means it (`acknowledged_damage`), checked
 * again on the server against the trip as it is at save time. Pure.
 */
import type { AITripAction, TravelTrip } from "./travelTypes";

export const DAMAGE_KINDS = ["rename", "off_site", "prices_emptied", "program_cut"] as const;
export type DamageKind = (typeof DAMAGE_KINDS)[number];
export type TripDamage = { kind: DamageKind; text: string };

type Row = Record<string, unknown>;
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const ON_SITE = new Set(["active", "sold_out"]);

export function isDamageKind(value: unknown): value is DamageKind {
  return typeof value === "string" && (DAMAGE_KINDS as readonly string[]).includes(value);
}

/** Departures still ahead: ISO days from today on, and every written day ("Пүрэв гариг болгон") counted as ahead. */
function departuresAhead(dates: unknown, today: string): number {
  return list(dates).filter((value) => {
    const day = String(value ?? "").trim();
    if (!day) return false;
    return /^\d{4}-\d{2}-\d{2}/.test(day) ? day.slice(0, 10) >= today : true;
  }).length;
}

const sameName = (a: unknown, b: unknown) =>
  String(a ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase() === String(b ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

/** What writing `fields` over `before` would break. Only patch/upsert of a saved trip is judged here. */
export function tripDamage(before: TravelTrip, fields: Row, now = new Date()): TripDamage[] {
  const damage: TripDamage[] = [];
  const today = now.toISOString().slice(0, 10);
  const extra = record(fields.extra);
  const was = record(before.extra);

  const name = typeof fields.route_name === "string" ? fields.route_name.trim() : "";
  if (name && !sameName(name, before.route_name)) damage.push({ kind: "rename", text: `Нэр солигдоно: «${before.route_name}» → «${name}».` });

  const ahead = departuresAhead(before.departure_dates, today);
  if (Array.isArray(fields.departure_dates) && ahead > 0 && departuresAhead(fields.departure_dates, today) === 0) {
    damage.push({ kind: "off_site", text: `Ирэх ${ahead} гарах өдөр бүгд устаж, аялал вэбсайт болон ботоос буух болно.` });
  } else if (typeof fields.status === "string" && ON_SITE.has(before.status) && !ON_SITE.has(fields.status)) {
    damage.push({ kind: "off_site", text: `Төлөв «${fields.status}» болж, аялал вэбсайт болон ботоос буух болно.` });
  } else if (extra.customer_visible === false && was.customer_visible !== false && ON_SITE.has(before.status)) {
    damage.push({ kind: "off_site", text: "Аялал вэбсайт болон ботоос нуугдах болно." });
  }

  const emptied = (["price_groups", "departure_date_groups"] as const)
    .filter((key) => Array.isArray(extra[key]) && list(extra[key]).length === 0 && list(was[key]).length > 0)
    .reduce((sum, key) => sum + list(was[key]).length, 0);
  const adultGone = "adult_price" in fields && !(Number(fields.adult_price) > 0) && Number(before.adult_price) > 0;
  if (emptied > 0) damage.push({ kind: "prices_emptied", text: `Үнийн ${emptied} мөр бүгд устана.` });
  else if (adultGone) damage.push({ kind: "prices_emptied", text: `Том хүний үнэ (${Number(before.adult_price).toLocaleString("en-US")}₮) устана.` });

  const daysBefore = list(was.itinerary_days).length;
  if (Array.isArray(extra.itinerary_days) && daysBefore >= 2 && list(extra.itinerary_days).length * 2 < daysBefore) {
    damage.push({ kind: "program_cut", text: `Хөтөлбөрийн ${daysBefore} өдөр ${list(extra.itinerary_days).length} болно.` });
  }
  return damage;
}

/** Marks each patch/upsert of a saved trip with what it would break (`damage`); clears stale marks. Mutates. */
export function markTripDamage(actions: AITripAction[], trips: TravelTrip[], now = new Date()): void {
  const byId = new Map(trips.map((trip) => [trip.id, trip]));
  for (const action of actions) {
    const verb = String(action.action || "").toLowerCase();
    const before = action.trip_id ? byId.get(action.trip_id) : undefined;
    const damage = before && (verb === "patch" || verb === "upsert") ? tripDamage(before, record(action.fields), now) : [];
    if (damage.length) action.damage = damage;
    else delete action.damage;
  }
}

/** The marked damage the admin has not ticked, one line per trip («name»: …), or none. */
export function unacknowledgedDamage(actions: AITripAction[], trips: TravelTrip[]): string[] {
  const names = new Map(trips.map((trip) => [trip.id, trip.route_name]));
  return actions.flatMap((action) => {
    const ticked = new Set(list(action.acknowledged_damage).filter(isDamageKind));
    const open = list(action.damage).map(record).filter((item) => isDamageKind(item.kind) && !ticked.has(item.kind));
    if (!open.length) return [];
    return [`«${names.get(String(action.trip_id)) || "Аялал"}»: ${open.map((item) => String(item.text)).join(" ")}`];
  });
}
