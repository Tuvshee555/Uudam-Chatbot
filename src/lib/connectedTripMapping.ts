import type { TravelTrip } from "./travelTypes";
import { generateDateKeys, parseTripDepartureDateText } from "./travelDates";

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}
export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && Boolean(v.trim())) : [];
}
export function duration(text: string) {
  const days = Number(text.match(/(\d+)\s*(?:өдөр|хоног)/i)?.[1] || 0);
  const nights = Number(text.match(/(\d+)\s*шөнө/i)?.[1] || Math.max(0, days - 1));
  return { days: days || nights + 1, nights };
}

/** Update only facts that changed; preserve the editor's layout and detailed price table. */
export function tripToPoster(trip: TravelTrip, prior: unknown, before?: TravelTrip | null) {
  const data = { ...record(prior) };
  const changed = (key: keyof TravelTrip) => !before || JSON.stringify(trip[key]) !== JSON.stringify(before[key]);
  const extraChanged = (key: string) => !before || JSON.stringify(trip.extra[key]) !== JSON.stringify(before.extra[key]);
  data.title = trip.route_name;
  data.agency = trip.operator_name || "UUDAM TRAVEL AGENCY";
  if (changed("duration_text")) {
    const d = duration(trip.duration_text);
    data.duration_days = d.days;
    data.duration_nights = d.nights;
  }
  if (changed("departure_dates")) data.departures = trip.departure_dates.map(date => ({ date }));
  if (changed("adult_price") || changed("child_price")) {
    const table = record(data.price_table);
    const columns = strings(table.columns);
    const rows = records(table.rows);
    if (rows.length <= 1) {
      data.price_table = { columns: ["Том хүн", "Хүүхэд"], rows: [{
        dates: trip.departure_dates.join(", "),
        cells: [trip.adult_price, trip.child_price].map(n => n == null ? "Үнэ лавлах" : `${n.toLocaleString("en-US")}₮`),
      }] };
    } else {
      // A base-fare edit must not replace departure-specific fares.
      data.price_table = { ...table, columns, rows };
      data.price_note = `Том хүн: ${trip.adult_price ?? "Үнэ лавлах"}₮; Хүүхэд: ${trip.child_price ?? "Үнэ лавлах"}₮`;
    }
  }
  if (extraChanged("included_items")) data.includes = strings(trip.extra.included_items);
  if (extraChanged("excluded_items")) data.excludes = strings(trip.extra.excluded_items);
  if (extraChanged("itinerary_days")) {
    const oldDays = records(data.days);
    data.days = records(trip.extra.itinerary_days).map((day, i) => ({
      ...oldDays.find(old => old.day === (day.day ?? i + 1)),
      day: day.day ?? i + 1, route: day.title || "", summary: day.description || "",
      hotel: day.hotel || null, meals: day.meals || {},
      ...(day.photo ? { photo: day.photo } : {}),
    }));
  }
  if (changed("photo_urls")) {
    const days = records(data.days);
    const count = Math.max(days.length, trip.photo_urls.length);
    data.days = Array.from({ length: count }, (_, i) => ({
      ...(days[i] || { day: i + 1, route: "", summary: "" }), photo: trip.photo_urls[i] || null,
    }));
    data.hero_image = trip.photo_urls[0] || null;
  }
  if (changed("notes")) data.price_desc = trip.notes;
  return data;
}

export function posterPhotos(data: unknown): string[] {
  const p = record(data);
  return [...new Set([p.hero_image, ...records(p.days).map(d => d.photo)]
    .filter((v): v is string => typeof v === "string" && /^(https:\/\/|data:image\/)/.test(v)))];
}

export function websiteExtraDetails(
  extra: Record<string, unknown>,
  fares?: { adult: number | null; child: number | null; infant: number | null; currency: string },
) {
  const money = (amount: unknown, currency: unknown) => typeof amount === "number" && Number.isFinite(amount)
    ? `${amount.toLocaleString("en-US")}${!currency || currency === "MNT" ? "₮" : ` ${currency}`}` : "";
  const join = (items: unknown[]) => items.filter(v => typeof v === "string" && v.trim()).join(" - ");
  // The trip's own passenger tiers with their age bands come first, so the
  // website says exactly who is an infant/child/adult on THIS trip.
  const bands = record(extra.age_rules);
  const band = (key: string) => (typeof bands[key] === "string" ? String(bands[key]).trim() : "");
  const tierLine = (label: string, ageBand: string, amount: number | null) => {
    if (!ageBand && amount == null) return "";
    const fare = amount != null && amount > 0 ? money(amount, fares?.currency) : "";
    return join([`${label}${ageBand ? ` (${ageBand})` : ""}`, fare]);
  };
  const tierLines = fares
    ? [
        tierLine("Том хүн", band("adult"), fares.adult),
        tierLine("Хүүхэд", band("child"), fares.child),
        tierLine("Нярай", band("infant"), fares.infant),
      ].filter(Boolean)
    : [];
  const childNotes = [
    ...tierLines,
    ...records(extra.child_rules).map(r => join([r.label,r.age_range,money(r.price,r.currency),r.note])),
    ...records(extra.price_groups).flatMap(group => {
      const dates = strings(group.display_dates).length ? strings(group.display_dates) : strings(group.dates);
      const dateLabel = dates.join(", ");
      return records(group.passenger_prices).map(price =>
        join([dateLabel, price.label, price.age_range, money(price.price, price.currency)]));
    }),
  ].filter((value, index, all) => value && all.indexOf(value) === index);
  return {
    extraFees: records(extra.extra_fees).map(f => join([f.label,money(f.amount,f.currency),f.applies_to,f.note])),
    roomPrices: records(extra.room_prices).map(r => join([r.room_type,money(r.price,r.currency),r.note])),
    childPriceNotes: childNotes,
  };
}

const WEEKDAY_NAMES = ["ням", "даваа", "мягмар", "лхагва", "пүрэв", "баасан", "бямба"];

/** "Пүрэв гараг бүр" -> 4 (Thursday), or -1 when the text isn't a recurring-weekday rule. */
export function recurringWeekdayIndex(text: string): number {
  const lower = text.toLowerCase().trim();
  if (!lower) return -1;
  const day = WEEKDAY_NAMES.findIndex(name => lower.includes(name));
  if (day < 0) return -1;
  return /бүр|болгон/.test(lower) || /^[а-яөүё\s-]+гариг$/.test(lower) || WEEKDAY_NAMES.includes(lower)
    ? day
    : -1;
}

/** "Пүрэв гараг бүр" -> the next N occurrences (YYYY-MM-DD, UTC, Ulaanbaatar-local
 * "today"), or [] when the text isn't a recurring-weekday rule. Shared by the
 * website departure sync and the admin calendar — both need the exact same
 * "what does this rule actually mean, starting from now" answer. */
export function expandRecurringWeekday(text: string, now = new Date(), occurrences = 12): string[] {
  const day = recurringWeekdayIndex(text);
  if (day < 0) return [];
  const localToday = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  const start = new Date(`${localToday}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() + (day - start.getUTCDay() + 7) % 7);
  const dates: string[] = [];
  for (let i = 0; i < occurrences; i++) {
    dates.push(start.toISOString().slice(0, 10));
    start.setUTCDate(start.getUTCDate() + 7);
  }
  return dates;
}

export function websiteDepartures(trip: TravelTrip, now = new Date()) {
  const resolved = records(trip.extra.departure_dates_resolved);
  const dates = new Map<string, {
    start: string;
    end: string;
    label: string;
    price?: number | null;
    childPrice?: number | null;
    infantPrice?: number | null;
  }>();
  const days = duration(trip.duration_text).days;
  const add = (ymd: string, label: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return;
    const start = new Date(`${ymd}T00:00:00Z`);
    if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== ymd) return;
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + Math.max(days - 1, 0));
    dates.set(ymd, { start: start.toISOString(), end: end.toISOString(), label });
  };
  if (resolved.length > 0) {
    for (const d of resolved) if (typeof d.ymd === "string") add(d.ymd, String(d.text || d.ymd));
  } else {
    for (const text of trip.departure_dates) {
      for (const ymd of parseTripDepartureDateText(text, now)) add(ymd, text);
    }
  }
  const ruleTexts = [...trip.departure_dates, String(trip.extra.departure_rule || "")];
  for (const text of ruleTexts) {
    for (const ymd of expandRecurringWeekday(text, now)) add(ymd, text);
  }

  for (const group of records(trip.extra.price_groups)) {
    const groupKeys = new Set([
      ...strings(group.date_keys),
      ...strings(group.dates).flatMap((date) => generateDateKeys(date, now)),
      ...strings(group.display_dates).flatMap((date) => generateDateKeys(date, now)),
    ]);
    if (groupKeys.size === 0) continue;
    const adultPrice = typeof group.adult_price === "number" ? group.adult_price : null;
    const childPrice = typeof group.child_price === "number" ? group.child_price : null;
    const infantPrice = typeof group.infant_price === "number" ? group.infant_price : null;
    for (const dep of dates.values()) {
      const depYmd = dep.start.slice(0, 10);
      const depKeys = new Set([depYmd, ...generateDateKeys(dep.label, now), ...generateDateKeys(depYmd, now)]);
      if (![...depKeys].some((key) => groupKeys.has(key))) continue;
      dep.price = adultPrice;
      dep.childPrice = childPrice;
      dep.infantPrice = infantPrice;
    }
  }
  return [...dates.values()].sort((a, b) => a.start.localeCompare(b.start));
}
