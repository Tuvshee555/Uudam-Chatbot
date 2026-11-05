/**
 * Adding or removing one departure day of an existing trip, the way the owner does it
 * by hand: the date joins the trip's list AND the price row of its nearest existing
 * date (so the website opens it at a real fare instead of "Үнэ лавлах"); a removed
 * date leaves both, and a price row with no date left is dropped rather than being
 * read as a trip-wide fare.
 */
import { nearestOccurrenceOfYearless } from "./travelDates";
import type { TravelTrip, TripMutationFields } from "./travelTypes";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** The calendar day a stored departure text stands for, frozen at write time when known. */
export function departureDayOf(trip: TravelTrip, text: string, now = new Date()): string | null {
  const resolved = Array.isArray(trip.extra?.departure_dates_resolved) ? trip.extra.departure_dates_resolved : [];
  for (const raw of resolved) {
    const entry = record(raw);
    if (entry.text === text && typeof entry.ymd === "string" && ISO.test(entry.ymd)) return entry.ymd;
  }
  if (ISO.test(text)) return text;
  return nearestOccurrenceOfYearless(text, now)[0] || null;
}

function groupDates(group: Row): string[] {
  const values = [group.dates, group.date_keys, group.display_dates].flatMap((value) => (Array.isArray(value) ? value.map(String) : []));
  return [...new Set(values.map((value) => value.match(/^\d{4}-\d{2}-\d{2}/)?.[0] || "").filter(Boolean))];
}

function withGroupDates(group: Row, dates: string[]): Row {
  return { ...group, dates, date_keys: dates, display_dates: dates };
}

function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

export type ScheduleChangeResult = { fields: TripMutationFields; added: string[]; removed: string[]; notes: string[] };

/** The patch that adds `dates` (YYYY-MM-DD) to the trip; days it already has are reported, not duplicated. */
export function addDepartureDates(trip: TravelTrip, dates: string[], now = new Date()): ScheduleChangeResult {
  const existingDays = new Set(trip.departure_dates.map((text) => departureDayOf(trip, text, now)).filter(Boolean) as string[]);
  const added = [...new Set(dates.filter((date) => ISO.test(date) && !existingDays.has(date)))].sort();
  const notes: string[] = [];
  const already = dates.filter((date) => existingDays.has(date));
  if (already.length) notes.push(`${already.join(", ")} аль хэдийн бүртгэлтэй.`);
  if (!added.length) return { fields: {}, added, removed: [], notes };

  const fields: TripMutationFields = { departure_dates: [...trip.departure_dates, ...added] };
  const groups = Array.isArray(trip.extra?.price_groups) ? (trip.extra.price_groups as unknown[]).map(record) : [];
  if (groups.length) {
    const dated = groups.map((group, index) => ({ group, index, dates: groupDates(group) })).filter((entry) => entry.dates.length);
    let changed = false;
    const next = groups.map((group) => ({ ...group }));
    for (const date of added) {
      let best: { index: number; distance: number } | null = null;
      for (const entry of dated) {
        for (const existing of entry.dates) {
          const distance = daysBetween(existing, date);
          if (!best || distance < best.distance) best = { index: entry.index, distance };
        }
      }
      if (!best) continue;
      const target = next[best.index];
      const current = groupDates(target);
      if (!current.includes(date)) {
        next[best.index] = withGroupDates(target, [...current, date].sort());
        changed = true;
      }
    }
    if (changed) {
      fields.extra = { price_groups: next };
      notes.push("Шинэ огноо хамгийн ойрын гаралтын үнээр нээгдэнэ.");
    }
  }
  return { fields, added, removed: [], notes };
}

/** The patch that removes `dates` from the trip's list and its price rows. */
export function removeDepartureDates(trip: TravelTrip, dates: string[], now = new Date()): ScheduleChangeResult {
  const wanted = new Set(dates.filter((date) => ISO.test(date)));
  const kept: string[] = [];
  const removed = new Set<string>();
  for (const text of trip.departure_dates) {
    const day = departureDayOf(trip, text, now);
    if (day && wanted.has(day)) removed.add(day);
    else kept.push(text);
  }
  const notes: string[] = [];
  const missing = [...wanted].filter((date) => !removed.has(date));
  if (missing.length) notes.push(`${missing.join(", ")} энэ аяллын гаралтад байхгүй.`);
  if (!removed.size) return { fields: {}, added: [], removed: [], notes };

  const fields: TripMutationFields = { departure_dates: kept };
  const groups = Array.isArray(trip.extra?.price_groups) ? (trip.extra.price_groups as unknown[]).map(record) : [];
  if (groups.length) {
    let changed = false;
    const next: Row[] = [];
    for (const group of groups) {
      const current = groupDates(group);
      if (!current.length) { next.push(group); continue; }
      const remaining = current.filter((date) => !removed.has(date));
      if (remaining.length === current.length) { next.push(group); continue; }
      changed = true;
      if (remaining.length) next.push(withGroupDates(group, remaining));
    }
    if (changed) fields.extra = { price_groups: next };
  }
  return { fields, added: [], removed: [...removed].sort(), notes };
}
