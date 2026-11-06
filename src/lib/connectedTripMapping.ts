import type { TravelTrip } from "./travelTypes";
import { parseTripDepartureDateText } from "./travelDates";
import { formatPriceRange } from "./priceRange";
import { websiteTripPayload } from "./websiteTripPayload";
import { normalizeTripOffers } from "./tripOffers";
import { TRANSPORT_WEBSITE_TAGS, isTransportType } from "./tripTransitDays";
import { statedDayMeals } from "./tripExtraSchema";
import { getPosterPdfPublicUrl, isUsableStoredPdfUrl } from "./poster/pdfUrl";

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}
export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && Boolean(v.trim())) : [];
}
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
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
    data.days = records(trip.extra.itinerary_days).map((day, i) => {
      const posterDay: Record<string, unknown> = {
        ...oldDays.find(old => old.day === (day.day ?? i + 1)),
        day: day.day ?? i + 1, route: day.title || "", summary: day.description || "",
        hotel: day.hotel || null, meals: day.meals || {},
        ...(day.photo ? { photo: day.photo } : {}),
      };
      // The meal note ("буфет", a restaurant) belongs to the chatbot day: it
      // travels to the website through the poster day, and a note removed in
      // the chatbot must not survive from the old poster day.
      if (text(day.meal_note)) posterDay.meal_note = text(day.meal_note);
      else delete posterDay.meal_note;
      return posterDay;
    });
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

const SINGLE_ROOM_LABEL = "Ганцаараа явах (өрөөндөө ганцаараа)";

/**
 * One solo-room line per hotel and price. Hotels with the same price on the
 * same dates share a line; a hotel whose price differs by date lists them.
 */
function hotelSingleLines(
  priceGroups: Record<string, unknown>[],
  money: (amount: unknown, currency: unknown) => string,
  currency: unknown,
): string[] {
  const byHotel = new Map<string, Map<number, string[]>>();
  for (const group of priceGroups) {
    if (typeof group.single_price !== "number" || !money(group.single_price, currency)) continue;
    const hotel = text(group.hotel);
    const prices = byHotel.get(hotel) || new Map<number, string[]>();
    const dates = strings(group.display_dates).length ? strings(group.display_dates) : strings(group.dates);
    prices.set(group.single_price, [...(prices.get(group.single_price) || []), ...dates]);
    byHotel.set(hotel, prices);
  }
  const lines = new Map<string, { price: number; hotels: string[]; dates: string }>();
  for (const [hotel, prices] of byHotel) {
    for (const [price, dates] of prices) {
      const shownDates = prices.size > 1 ? [...new Set(dates)].join(", ") : "";
      const key = `${price}|${shownDates}`;
      const line = lines.get(key) || { price, hotels: [], dates: shownDates };
      if (hotel && !line.hotels.includes(hotel)) line.hotels.push(hotel);
      lines.set(key, line);
    }
  }
  return [...lines.values()]
    .sort((a, b) => a.price - b.price)
    .map(line => [SINGLE_ROOM_LABEL, line.hotels.join(", "), line.dates, money(line.price, currency)].filter(Boolean).join(" - "));
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
  // departures it applies to. On a trip sold per hotel the price is the
  // hotel's own (650,000₮ in one, 900,000₮ in the other), so each line names
  // its hotel; dates are listed only where one hotel's price changes by date.
  const singleLines = hasHotelChoices
    ? hotelSingleLines(priceGroups, money, fares?.currency)
    : (() => {
      const singleByPrice = new Map<number, string[]>();
      for (const group of priceGroups) {
        if (typeof group.single_price !== "number" || !money(group.single_price, fares?.currency)) continue;
        singleByPrice.set(group.single_price, [...(singleByPrice.get(group.single_price) || []), ...dateListOf(group)]);
      }
      return [...singleByPrice.entries()]
        .sort(([a], [b]) => a - b)
        .map(([price, dates]) => join([
          SINGLE_ROOM_LABEL,
          singleByPrice.size > 1 ? [...new Set(dates)].join(", ") : "",
          money(price, fares?.currency),
        ]));
    })();
  return {
    extraFees: records(extra.extra_fees).map(f => join([f.label,money(f.amount,f.currency),f.applies_to,f.note])),
    roomPrices: [
      ...records(extra.room_prices).map(r => join([r.room_type,money(r.price,r.currency),r.note])),
      ...singleLines,
    ].filter(Boolean),
    childPriceNotes: childNotes,
  };
}

/**
 * Booking terms staff enter in the chatbot (extra.booking_terms) as the
 * website's two condition boxes. The bot reads those boxes back as "documents"
 * and "cancellation" when its own term is empty (tripAnswerPlan.ts,
 * travelDb.ts), so each box is only written from the term it stands for:
 * "Шаардлага, бичиг баримт" exists only when documents are stated (visa joins
 * it), "Цуцлалт, буцаалт" only when cancellation is (deposit and payment join
 * it). A deposit alone never turns into a "documents" answer. Null = nothing
 * to say: a box staff typed on the website is kept, one this projection wrote
 * earlier is cleared (fillWebsiteFields).
 */
export function websiteBookingTerms(value: unknown): { requirements: string | null; cancellationPolicy: string | null } {
  const terms = record(value);
  // Labelled lines once a box holds more than its own term; its term alone reads as is.
  const box = (anchor: string, rows: Array<[string, string]>) => {
    if (!anchor) return null;
    const filled = rows.filter(([, item]) => item);
    return filled.length > 1 ? filled.map(([label, item]) => `${label}: ${item}`).join("\n") : anchor;
  };
  const documents = text(terms.documents), cancellation = text(terms.cancellation);
  return {
    requirements: box(documents, [["Бичиг баримт", documents], ["Виз", text(terms.visa)]]),
    cancellationPolicy: box(cancellation, [["Урьдчилгаа", text(terms.deposit)], ["Төлбөр", text(terms.payment)], ["Цуцлалт", cancellation]]),
  };
}

/** extra.transport_type ("direct_flight") as the website's transport tags (["Онгоц"]). */
export function websiteTransportTags(value: unknown): string[] {
  return isTransportType(value) ? [...TRANSPORT_WEBSITE_TAGS[value]] : [];
}

/**
 * The new-trip review and the AI assistant (2026-11-04/05) wrote a transport
 * type's tags into website_details_patch as if staff had typed them. That
 * pinned them: a later change of transport_type never reached the website.
 * Such a patch value is the projection's own when it is exactly the tags of
 * the trip's transport type now or at the last sync, or the value an earlier
 * sync already recognised (`recognised`, kept on the website because the
 * stored patch is not rewritten). Returns that value, or null when the patch
 * transport is a manual override (or absent) and stays the patch's.
 */
export function projectedPatchTransport(patchTransport: unknown, transportTypes: unknown[], recognised?: unknown): string[] | null {
  const list = (value: unknown) => Array.isArray(value) && value.length > 0 && value.every(item => typeof item === "string")
    ? value as string[] : null;
  const patch = list(patchTransport);
  if (!patch) return null;
  const same = (tags: string[] | null) => Boolean(tags) && tags!.length === patch.length && tags!.every((tag, index) => tag === patch[index]);
  return [...transportTypes.map(websiteTransportTags), list(recognised)].some(same) ? [...patch] : null;
}

/**
 * The website's single trip-level solo-room supplement: only when every
 * projected fare row states the same one. A trip whose hotels (or dates) have
 * different supplements has no single number to show; the per-hotel lines in
 * roomPrices carry them instead.
 */
export function websiteSingleSupplement(priceGroups: unknown): number | null {
  const groups = records(priceGroups);
  if (!groups.length) return null;
  // Same placeholder threshold as the fare lines: "1₮" typed past a required field is not a price.
  const real = (group: Record<string, unknown>) => {
    const amount = group.single_price, currency = text(group.currency).toUpperCase() || "MNT";
    return typeof amount === "number" && Number.isFinite(amount) && (currency === "MNT" ? amount >= 1000 : amount > 0) ? amount : null;
  };
  const prices = new Set(groups.map(real));
  const [only] = [...prices];
  return prices.size === 1 && typeof only === "number" ? only : null;
}

/**
 * Website fields the projection fills from chatbot facts without ever
 * overwriting a website edit (fillWebsiteFields in websiteTripDetails.ts).
 * Transport and destinations are display tags there: a website-only
 * difference is kept quietly instead of being reported as a conflict.
 */
export const WEBSITE_FILLED_QUIET: ReadonlySet<string> = new Set(["transport", "destinations"]);
export const WEBSITE_FILLED_CLEARED: Record<string, unknown> = { transport: [], destinations: [] };
export function websiteFilledFields(trip: TravelTrip, priceGroups: unknown) {
  const terms = websiteBookingTerms(trip.extra.booking_terms);
  return {
    requirements: terms.requirements,
    cancellationPolicy: terms.cancellationPolicy,
    transport: websiteTransportTags(trip.extra.transport_type),
    destinations: [...new Set(strings(trip.extra.destinations).map(item => item.trim()))],
    // The website prints this number in tugrik.
    singleSupplement: (text(trip.currency) || "MNT").toUpperCase() === "MNT" ? websiteSingleSupplement(priceGroups) : null,
  };
}

export type MealState = boolean | null;
/** true = included in the price, false = the traveller pays, anything else = the program does not say. */
export function mealState(value: unknown): MealState {
  return value === true ? true : value === false ? false : null;
}

const WEBSITE_MEAL_NAMES = [["breakfast", "Өглөө"], ["lunch", "Өдөр"], ["dinner", "Орой"]] as const;

/**
 * A day's meals as the website's ItineraryDay.meals list: only meals the
 * program says are included. A meal it does not mention (null) is not listed,
 * and it is not "excluded" either — that distinction travels in
 * websiteItineraryMeals, because the list itself can only say "included".
 */
export function websiteDayMeals(meals: unknown): string[] {
  const day = record(meals);
  return WEBSITE_MEAL_NAMES.filter(([key]) => mealState(day[key]) === true).map(([, name]) => name);
}

export type WebsiteItineraryMeal = { dayNumber: number; breakfast: MealState; lunch: MealState; dinner: MealState; note?: string };

/**
 * Per website itinerary day (same dayNumber as the ItineraryDay rows the
 * projection writes): each meal's three states and the day's meal note. The
 * website draws ✓ for a meal in ItineraryDay.meals, and should draw ✗ only
 * for a meal stated here as false — null means the program does not say.
 * The note comes from the poster day, or the chatbot day of the same number
 * while the poster has not been re-saved since notes started travelling.
 * A day saved before "not stated" existed (all three false, no note) is sent
 * as not stated (statedDayMeals), or the website drew ✗ on every meal.
 */
export function websiteItineraryMeals(posterDays: unknown, chatbotDays?: unknown): WebsiteItineraryMeal[] {
  const sourceDays = records(chatbotDays);
  const notes = new Map(sourceDays.map((day, index) => [Number(day.day) || index + 1, text(day.meal_note)]));
  return records(posterDays).flatMap((day, index) => {
    if (!day.route && !day.summary && !day.hotel) return [];
    const dayNumber = Number(day.day) || index + 1;
    const note = text(day.meal_note) || notes.get(dayNumber) || "";
    const meals = statedDayMeals(day.meals, note);
    return [{ dayNumber, breakfast: meals.breakfast, lunch: meals.lunch, dinner: meals.dinner, ...(note ? { note } : {}) }];
  });
}

/**
 * The brochure the website offers. The rendered poster is the live source of
 * truth (getPosterBrochureHref says the same for the bot); a PDF staff
 * uploaded is used only when there is no poster PDF to link to. "" = none.
 */
export function websiteBrochurePdfUrl(extra: Record<string, unknown>): string {
  const posterId = text(extra.poster_trip_id);
  const poster = posterId ? getPosterPdfPublicUrl(posterId) : "";
  if (poster) return poster;
  const uploaded = text(extra.brochure_pdf_url);
  return isUsableStoredPdfUrl(uploaded) ? uploaded : "";
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
    saleEndsAt: typeof raw.sale_ends_at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.sale_ends_at) ? raw.sale_ends_at : null,
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
