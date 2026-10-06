export type PricingGroup = Record<string, unknown>;
export type PricingDateRow = { groupIndex: number; date: string };

export function passengerPricingRows(group: PricingGroup): PricingGroup[] {
  if (Array.isArray(group.passenger_prices) && group.passenger_prices.length) {
    return group.passenger_prices.map((value) => value && typeof value === "object" ? { ...value } : {});
  }
  return [
    ...(typeof group.child_price === "number" ? [{ label: "Хүүхэд", age_range: group.child_age || "", price: group.child_price, currency: group.currency || "MNT" }] : []),
    ...(typeof group.infant_price === "number" ? [{ label: "Нярай", age_range: group.infant_age || "", price: group.infant_price, currency: group.currency || "MNT" }] : []),
  ];
}


export function pricingDates(group: PricingGroup): string[] {
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

export function reconcilePricingDates(current: readonly string[], before: readonly PricingGroup[], after: readonly PricingGroup[]): string[] {
  const oldDates = new Set(before.flatMap(pricingDates));
  const newDates = new Set(after.flatMap(pricingDates));
  return [...new Set([...current.filter((date) => !oldDates.has(date) || newDates.has(date)), ...newDates])];
}

export function renamePricingDate(groups: readonly PricingGroup[], from: string, to: string): PricingGroup[] {
  return groups.flatMap((group) => {
    if (!pricingDates(group).includes(from)) return [group];
    return patchPricingDate([group], { groupIndex: 0, date: from }, { dates: [to], date_keys: [to], display_dates: [to] });
  });
}
