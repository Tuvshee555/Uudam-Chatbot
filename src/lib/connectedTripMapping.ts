import type { TravelTrip } from "./travelTypes";
import { parseTripDepartureDateText } from "./travelDates";
import { formatPriceRange } from "./priceRange";
import { websiteTripPayload } from "./websiteTripPayload";
import { normalizeTripOffers } from "./tripOffers";

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
  if (changed("source_description")) data.subtitle = trip.source_description || "";
  if (changed("duration_text")) {
    const d = duration(trip.duration_text);
    data.duration_days = d.days;
    data.duration_nights = d.nights;
  }
  for (const key of ["destinations", "transport_type", "duration_days", "duration_nights"]) {
    if (extraChanged(key) && trip.extra[key] !== undefined) data[key] = trip.extra[key];
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
    data.days = photosOntoDays(records(data.days), trip.photo_urls);
    data.hero_image = trip.photo_urls[0] || null;
  }
  if (changed("notes")) data.price_desc = trip.notes;
  return data;
}

/**
 * A day's photo shows that day (the Universal shot on the Universal day), so a
 * change to the trip's photo list must not deal the photos out by position.
 * Days keep their own photo while it is still in the list; a removed photo
 * leaves its day empty; photos no day shows are kept as photo-only slots after
 * the itinerary so they stay in the gallery. Only a trip whose days have no
 * photos yet gets them in list order.
 */
function photosOntoDays(days: Record<string, unknown>[], urls: string[]) {
  const pinned = days.some(day => typeof day.photo === "string" && day.photo);
  if (!pinned) {
    return Array.from({ length: Math.max(days.length, urls.length) }, (_, i) => ({
      ...(days[i] || { day: i + 1, route: "", summary: "" }), photo: urls[i] || null,
    }));
  }
  const content: Record<string, unknown>[] = days.filter(day => day.route || day.summary || day.hotel)
    .map(day => ({ ...day, photo: urls.includes(String(day.photo)) ? day.photo : null }));
  const shown = new Set(content.map(day => day.photo));
  const lastDay = content.reduce((max, day, i) => Math.max(max, Number(day.day) || i + 1), 0);
  const loose = urls.filter(url => !shown.has(url));
  return [...content, ...loose.map((photo, i) => ({ day: lastDay + i + 1, route: "", summary: "", photo }))];
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
  // A sub-1,000₮ figure ("1₮") is a placeholder typed to get past a required
  // field, not a real fare — same threshold the chatbot's own
  // formatPassengerMoney uses. Without this the website printed "Нярай - 1₮"
  // verbatim from data that was never meant to be a real price.
  const money = (amount: unknown, currency: unknown, free = false) => amount === 0 && free ? "Үнэгүй"
    : typeof amount === "number" && Number.isFinite(amount) && (currency && currency !== "MNT" ? amount > 0 : amount >= 1000)
      ? `${amount.toLocaleString("en-US")}${!currency || currency === "MNT" ? "₮" : ` ${currency}`}` : "";
  const join = (items: unknown[]) => items.filter(v => typeof v === "string" && v.trim()).join(" - ");
  // The trip's own passenger tiers with their age bands come first, so the
  // website says exactly who is an infant/child/adult on THIS trip.
  const bands = record(extra.age_rules);
  const band = (key: string) => (typeof bands[key] === "string" ? String(bands[key]).trim() : "");
  const tierLine = (label: string, ageBand: string, amount: number | null) => {
    if (!ageBand && amount == null) return "";
    const free = records(extra.price_groups).some(group => records(group.passenger_prices)
      .some(price => price.price === 0 && /үнэгүй|free/i.test(String(price.note || ""))
        && (label === "Нярай" ? /нярай|infant/i.test(String(price.label)) : label === "Хүүхэд" && /хүүхэд|child/i.test(String(price.label)))));
    const fare = money(amount, fares?.currency, free);
    return join([`${label}${ageBand ? ` (${ageBand})` : ""}`, fare]);
  };
  const tierLines = fares
    ? [
        tierLine("Том хүн", band("adult"), fares.adult),
        tierLine("Хүүхэд", band("child"), fares.child),
        tierLine("Нярай", band("infant"), fares.infant),
      ].filter(Boolean)
    : [];
  const priceGroups = records(extra.price_groups);
  const hasHotelChoices = priceGroups.some(group => typeof group.hotel === "string" && group.hotel.trim());
  // Every fare fact this trip has ends up said at most ONCE. Base tiers,
  // child_rules and per-date price groups used to be concatenated raw, so the
  // same "Хүүхэд 2,590,000₮" appeared three times in three different phrasings
  // and a malformed imported row ("Нярай - 1₮", "24-20 нас") went out to
  // customers verbatim. A date picker on the site already shows each
  // departure's own price, so this block is a SUMMARY: the base price of every
  // passenger tier once, then one line per set of departures whose prices
  // differ from those base prices, naming only what differs.
  const currency = String(fares?.currency || "MNT");
  const dateListOf = (group: Record<string, unknown>) =>
    strings(group.display_dates).length ? strings(group.display_dates) : strings(group.dates);
  const tierKey = (price: Record<string, unknown>) => `${String(price.label ?? "").trim()}|${String(price.age_range ?? "").trim()}`;
  const tierName = (price: Record<string, unknown>) => String(price.label ?? "").trim() || String(price.age_range ?? "").trim();
  // The departure group that carries the base adult fare defines each tier's
  // base price; without one, the first group does.
  const baseGroup = priceGroups.find(group => group.adult_price === fares?.adult) ?? priceGroups[0];
  const baseTier = new Map<string, number>();
  for (const price of records(baseGroup?.passenger_prices)) {
    if (typeof price.price === "number") baseTier.set(tierKey(price), price.price);
  }
  // Extra passenger tiers the three headline lines do not cover (a second
  // child age band), each stated once at its base price.
  const infantBand = band("infant");
  const childBand = band("child");
  const extraTierLines = hasHotelChoices ? [] : records(baseGroup?.passenger_prices)
    .filter(price => typeof price.price === "number" && money(price.price, currency))
    .filter(price => {
      const ageRange = String(price.age_range ?? "").trim();
      const isInfant = /нярай|infant/i.test(String(price.label ?? "")) || (infantBand && ageRange === infantBand);
      if (isInfant) return price.price !== fares?.infant;
      return !(price.price === fares?.child && (!childBand || !ageRange || ageRange === childBand));
    })
    .map(price => join([tierName(price), money(price.price, currency)]));
  const bySignature = new Map<string, { dates: string[]; parts: string[] }>();
  if (!hasHotelChoices) {
    for (const group of priceGroups) {
      if (group === baseGroup) continue;
      const parts: string[] = [];
      const adultRange = formatPriceRange(group.adult_price_range, currency);
      if (adultRange) parts.push(`Том хүн ${adultRange}`);
      else if (typeof group.adult_price === "number" && group.adult_price !== fares?.adult && money(group.adult_price, currency)) {
        parts.push(`Том хүн ${money(group.adult_price, currency)}`);
      }
      for (const price of records(group.passenger_prices)) {
        if (typeof price.price !== "number" || !money(price.price, currency)) continue;
        const base = baseTier.get(tierKey(price));
        if (base === price.price) continue;
        parts.push(`${tierName(price)} ${money(price.price, currency)}`);
      }
      if (parts.length === 0) continue;
      const signature = parts.join("|");
      const entry = bySignature.get(signature) ?? { dates: [], parts };
      entry.dates.push(...dateListOf(group));
      bySignature.set(signature, entry);
    }
  }
  const groupLines = hasHotelChoices
    ? ["Үнэ нь гарах өдөр, буудлын сонголтоос хамаарна. Доорх хэсгээс сонгоно уу."]
    : [...bySignature.values()]
      .filter(entry => entry.dates.length > 0)
      .map(entry => join([[...new Set(entry.dates)].join(", "), entry.parts.join(" · ")]));
  const childNotes = [
    ...(hasHotelChoices ? [] : tierLines),
    ...extraTierLines,
    ...groupLines,
  ].filter((value, index, all) => value && all.indexOf(value) === index);
  // A solo traveller's own-room price, once per distinct price with the
  // departures it applies to.
  const singleByPrice = new Map<number, string[]>();
  for (const group of priceGroups) {
    if (typeof group.single_price !== "number" || !money(group.single_price, fares?.currency)) continue;
    const dates = strings(group.display_dates).length ? strings(group.display_dates) : strings(group.dates);
    singleByPrice.set(group.single_price, [...(singleByPrice.get(group.single_price) || []), ...dates]);
  }
  const singleLines = [...singleByPrice.entries()]
    .sort(([a], [b]) => a - b)
    .map(([price, dates]) => join([
      "Ганцаараа явах (өрөөндөө ганцаараа)",
      singleByPrice.size > 1 ? [...new Set(dates)].join(", ") : "",
      money(price, fares?.currency),
    ]));
  return {
    extraFees: records(extra.extra_fees).map(f => join([f.label,money(f.amount,f.currency),f.applies_to,f.note])),
    roomPrices: [
      ...records(extra.room_prices).map(r => join([r.room_type,money(r.price,r.currency),r.note])),
      ...singleLines,
    ].filter(Boolean),
    childPriceNotes: childNotes,
  };
}

export function websiteMarketingBadge(trip: TravelTrip) {
  const raw = record(trip.extra.marketing_badge);
  const saleLabel = typeof raw.sale_label === "string" && raw.sale_label.trim()
    ? raw.sale_label.trim()
    : "ХЯМДРАЛ";
  const percent = typeof raw.seats_percent_left === "number" && Number.isFinite(raw.seats_percent_left)
    ? Math.max(0, Math.min(100, Math.trunc(raw.seats_percent_left)))
    : null;
  return {
    saleEnabled: raw.sale_enabled === true,
    saleLabel,
    seatsPercentLeft: percent,
    seatsLeft: trip.seats_left,
    seatsTotal: trip.seats_total,
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

export function websiteDepartureSchedule(trip: TravelTrip, now = new Date()) {
  const resolved = records(trip.extra.departure_dates_resolved);
  const dates = new Map<string, {
    start: string;
    end: string;
    label: string;
  }>();
  const days = typeof trip.extra.duration_days === "number" && Number.isInteger(trip.extra.duration_days) && trip.extra.duration_days > 0
    ? trip.extra.duration_days : duration(trip.duration_text).days;
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

  for (const offer of normalizeTripOffers(trip, now)) {
    if (offer.source === "price_group" || offer.source === "legacy") {
      for (const ymd of offer.dates) if (!dates.has(ymd)) add(ymd, ymd);
    }
  }

  return [...dates.values()].sort((a, b) => a.start.localeCompare(b.start));
}

export function websiteDepartures(trip: TravelTrip, now = new Date()) {
  return websiteTripPayload(trip, websiteDepartureSchedule(trip, now), now).departures;
}
