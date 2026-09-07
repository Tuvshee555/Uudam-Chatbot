import type { TravelTrip } from "./travelTypes";

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

export function websiteExtraDetails(extra: Record<string, unknown>) {
  const money = (amount: unknown, currency: unknown) => typeof amount === "number" && Number.isFinite(amount)
    ? `${amount.toLocaleString("en-US")}${!currency || currency === "MNT" ? "₮" : ` ${currency}`}` : "";
  const join = (items: unknown[]) => items.filter(v => typeof v === "string" && v.trim()).join(" - ");
  return {
    extraFees: records(extra.extra_fees).map(f => join([f.label,money(f.amount,f.currency),f.applies_to,f.note])),
    roomPrices: records(extra.room_prices).map(r => join([r.room_type,money(r.price,r.currency),r.note])),
    childPriceNotes: records(extra.child_rules).map(r => join([r.label,r.age_range,money(r.price,r.currency),r.note])),
  };
}

export function websiteDepartures(trip: TravelTrip, now = new Date()) {
  const resolved = records(trip.extra.departure_dates_resolved);
  const dates = new Map<string, { start: string; end: string; label: string }>();
  const days = duration(trip.duration_text).days;
  const add = (ymd: string, label: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return;
    const start = new Date(`${ymd}T00:00:00Z`);
    if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== ymd) return;
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + Math.max(days - 1, 0));
    dates.set(ymd, { start: start.toISOString(), end: end.toISOString(), label });
  };
  for (const d of resolved) if (typeof d.ymd === "string") add(d.ymd, String(d.text || d.ymd));
  const weekdayNames = ["ням", "даваа", "мягмар", "лхагва", "пүрэв", "баасан", "бямба"];
  const ruleTexts = [...trip.departure_dates, String(trip.extra.departure_rule || "")];
  for (const text of ruleTexts) {
    const lower = text.toLowerCase();
    if (!/бүр|болгон/.test(lower)) continue;
    const day = weekdayNames.findIndex(name => lower.includes(name));
    if (day < 0) continue;
    const localToday = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
    const start = new Date(`${localToday}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() + (day - start.getUTCDay() + 7) % 7);
    for (let i = 0; i < 12; i++) {
      add(start.toISOString().slice(0, 10), text);
      start.setUTCDate(start.getUTCDate() + 7);
    }
  }
  return [...dates.values()].sort((a, b) => a.start.localeCompare(b.start));
}
