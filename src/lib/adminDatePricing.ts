import { nearestOccurrenceOfYearless } from "./travelDates";

export type PricingGroup = Record<string, unknown>;
export type PricingDateRow = { groupIndex: number; date: string };

// Older rows embed the age in their name as well as in age_range.
export function passengerName(group: PricingGroup): string {
  const label = String(group.label || "").trim();
  const age = String(group.age_range || "").trim();
  return age && label.endsWith(` ${age}`) ? label.slice(0, -age.length).trimEnd() : label;
}

export function passengerPricingRows(group: PricingGroup): PricingGroup[] {
  if (Array.isArray(group.passenger_prices) && group.passenger_prices.length) {
    return group.passenger_prices.map((value) => value && typeof value === "object" ? { ...value } : {});
  }
  return [
    ...(typeof group.child_price === "number" ? [{ label: "Хүүхэд", age_range: group.child_age || "", price: group.child_price, currency: group.currency || "MNT" }] : []),
    ...(typeof group.infant_price === "number" ? [{ label: "Нярай", age_range: group.infant_age || "", price: group.infant_price, currency: group.currency || "MNT" }] : []),
  ];
}


export function pricingDates(group: PricingGroup, at?: Date | number): string[] {
  // Also used as an array callback (`groups.map(pricingDates)`), where the 2nd argument is an index.
  const now = at instanceof Date ? at : new Date();
  // Yearless rows ("7 сарын 20") carry ISO search keys padded a year ahead; those are
  // aliases, not departures. The row's own day is read at its nearest occurrence, so the
  // editor never shows — or writes back into the trip's dates — a made-up next year.
  const primary = [group.dates, group.display_dates].flatMap((value) => Array.isArray(value) ? value.map(String).filter(Boolean) : []);
  if (primary.length && !primary.some((value) => /(?:^|[^\d])20\d{2}(?:[^\d]|$)/.test(value))) {
    return [...new Set(primary.flatMap((text) => {
      const dates = nearestOccurrenceOfYearless(text, now);
      return dates.length ? dates : [text];
    }))];
  }
  const values = [group.date_keys, group.dates, group.display_dates].flatMap((value) => Array.isArray(value) ? value : []);
  const iso = [...new Set(values.map((value) => String(value).match(/^\d{4}-\d{2}-\d{2}/)?.[0] || "").filter(Boolean))];
  return iso.length ? iso : [...new Set((Array.isArray(group.dates) ? group.dates : []).map(String).filter(Boolean))];
}

export function pricingDateRows(groups: readonly PricingGroup[]): PricingDateRow[] {
  return groups.flatMap((group, groupIndex) => {
    const dates = pricingDates(group);
    return (dates.length ? dates : [""]).map((date) => ({ groupIndex, date }));
  });
}

// Editing one date must not change the other departures that shared its old fare.
export function patchPricingDate<T extends PricingGroup>(groups: readonly T[], row: PricingDateRow, patch: Partial<T>): T[] {
  const group = groups[row.groupIndex];
  if (!group) return [...groups];
  const dates = pricingDates(group);
  if (dates.length < 2 || !row.date) {
    return groups.map((value, index) => index === row.groupIndex ? { ...value, ...patch } : value);
  }
  const remainingDates = dates.filter((date) => date !== row.date);
  const selected = { ...group, dates: [row.date], date_keys: [row.date], display_dates: [row.date], ...patch };
  delete selected.id;
  return groups.flatMap((value, index) => index !== row.groupIndex ? [value] : [
    { ...group, dates: remainingDates, date_keys: remainingDates, display_dates: remainingDates },
    selected,
  ]);
}

/** The calendar day a departure entry stands for ("10 сарын 8" and "2026-10-08" are one day); other text stays itself. */
function departureDay(text: string): string {
  return nearestOccurrenceOfYearless(text)[0] || text;
}

// The trip's own departure list follows the price rows, compared by calendar day so one
// departure is never listed twice in two spellings and removing a row removes its date.
export function reconcilePricingDates(current: readonly string[], before: readonly PricingGroup[], after: readonly PricingGroup[]): string[] {
  const oldDays = new Set(before.flatMap((group) => pricingDates(group)).map(departureDay));
  const newDates = [...new Set(after.flatMap((group) => pricingDates(group)))];
  const newDays = new Set(newDates.map(departureDay));
  const kept = current.filter((date) => !oldDays.has(departureDay(date)) || newDays.has(departureDay(date)));
  const keptDays = new Set(kept.map(departureDay));
  return [...new Set([...kept, ...newDates.filter((date) => !keptDays.has(departureDay(date)))])];
}

export function renamePricingDate(groups: readonly PricingGroup[], from: string, to: string): PricingGroup[] {
  return groups.flatMap((group) => {
    if (!pricingDates(group).includes(from)) return [group];
    return patchPricingDate([group], { groupIndex: 0, date: from }, { dates: [to], date_keys: [to], display_dates: [to] });
  });
}
