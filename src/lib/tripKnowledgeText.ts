/**
 * One trip as the AI reply model reads it: the "Modules:" line of the knowledge
 * base (businessData.ts formats it; aiTripContext.ts keeps the full text only for
 * the trips a message is about). Moved out of travelDb.ts readKnowledgeDataFromTrips
 * so it can be tested without a database, and so travelDb.ts stays under the cap.
 *
 * Fields are joined by " | " and each starts with its own label: aiTripContext's
 * summary line keeps fields by that label, so no field may contain " | " itself
 * unless it is the last thing on the trip (notes, important notes).
 */
import type { TravelTrip } from "./travelTypes";
import type { Program, ProgramPrice } from "./businessData";
import { departureAvailability, departureIsClosed } from "./departureAvailability";
import { filterFutureDepartureDates, type ResolvedDepartureDate } from "./travelDates";
import { formatPriceRange } from "./priceRange";
import { isGenericConfirmationText, sanitizeTripForCustomers } from "./travelFastPathsSearch";
import { hotelProfileId, linkHotelOption } from "./partnerSync/hotelProfiles";
import { statedDayMeals } from "./tripExtraSchema";

type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] => Array.isArray(value)
  ? value.filter((item): item is Row => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [];
const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const squash = (value: string): string => value.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "");

const TRANSPORT_WORDS: Record<string, string> = {
  direct_flight: "шууд нислэгтэй аялал",
  land: "газрын аялал",
  land_flight: "газар + нислэг хосолсон аялал",
  cruise: "усан онгоцны аялал",
};
const MEALS = [["breakfast", "өглөөний"], ["lunch", "өдрийн"], ["dinner", "оройн"]] as const;

/**
 * [1, 2, 3, 5] → "1–3, 5". An en dash, like the hotel reply: the reply checker reads "1-3" as a
 * date (January 3), so a model that copied a hyphen range into its answer was refused.
 */
function dayNumbers(days: number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    while (i + 1 < sorted.length && sorted[i + 1] === sorted[i] + 1) i++;
    parts.push(start === sorted[i] ? String(start) : `${start}–${sorted[i]}`);
  }
  return parts.join(", ");
}

/**
 * "1-р өдөр — өглөөний хоол багтсан; 2–4-р өдөр — өглөөний, оройн хоол багтсан, өдрийн
 * хоол багтаагүй". Only meals the program states: a meal it does not mention (null)
 * is left out, never read as "not included", and so is a day saved before "not
 * stated" existed (all three false, no meal note: statedDayMeals). Consecutive days
 * that say the same are one entry. Null when no day states a meal.
 */
export function itineraryMealsText(itineraryDays: unknown): string | null {
  const days = rows(itineraryDays).flatMap((day, index) => {
    const meals = statedDayMeals(day.meals, day.meal_note);
    const included = MEALS.filter(([key]) => meals[key] === true).map(([, word]) => word);
    const excluded = MEALS.filter(([key]) => meals[key] === false).map(([, word]) => word);
    const note = text(day.meal_note).replace(/\s*\|\s*/g, ", ");
    const said = [
      included.length === MEALS.length ? "бүх хоол багтсан" : included.length ? `${included.join(", ")} хоол багтсан` : "",
      excluded.length === MEALS.length ? "хоол багтаагүй" : excluded.length ? `${excluded.join(", ")} хоол багтаагүй` : "",
    ].filter(Boolean).join(", ");
    const entry = [said, note ? `(${note})` : ""].filter(Boolean).join(" ");
    return entry ? [{ day: typeof day.day === "number" ? day.day : index + 1, entry }] : [];
  });
  if (!days.length) return null;
  const runs: Array<{ days: number[]; entry: string }> = [];
  for (const day of days) {
    const last = runs[runs.length - 1];
    if (last && last.entry === day.entry && last.days[last.days.length - 1] === day.day - 1) last.days.push(day.day);
    else runs.push({ days: [day.day], entry: day.entry });
  }
  return runs.map((run) => `${dayNumbers(run.days)}-р өдөр — ${run.entry}`).join("; ");
}

/**
 * Whether the trip still stays at this hotel: a price row sells it (by profile id or name) or
 * a program day names it. A trip whose rows name no hotel keeps every hotel. The website's
 * hotel cards follow the same rule, so the bot never links a hotel the trip no longer sells.
 */
function staysAt(extra: Row): (hotel: Row) => boolean {
  const priceRows = rows(extra.price_groups);
  const profiles = rows(extra.hotel_profiles).map((profile) => ({ ...profile, name: text(profile.name), id: text(profile.id) || undefined }));
  // The sync's own matcher: by profile id first, then a name only one profile can mean. Never a guess.
  const sold = new Set(priceRows.flatMap((row) => {
    const ids = [...strings(row.hotel_profile_ids), ...text(row.hotel_id).split("+")].filter(Boolean);
    return ids.length ? ids : text(row.hotel) ? linkHotelOption(text(row.hotel), profiles).profileIds : [];
  }));
  if (!sold.size && !priceRows.some((row) => text(row.hotel))) return () => true;
  const stayText = rows(extra.itinerary_days).map((day) => squash(text(day.hotel))).filter(Boolean);
  return (hotel) => {
    const key = squash(text(hotel.name));
    if (!key) return false;
    if (sold.has(hotelProfileId(hotel))) return true;
    // A program day that names the hotel's whole name (a stop-over night the price rows do not vary).
    return stayText.some((day) => day.includes(key));
  };
}

/** "Vestar Bay — https://…": only hotels the trip stays at with an https link (the website shows the same ones). */
function hotelLinksText(extra: Row): string | null {
  const seen = new Set<string>();
  const sells = staysAt(extra);
  const links = [...rows(extra.hotel_profiles), ...rows(extra.hotel_links)].flatMap((hotel) => {
    const name = text(hotel.name);
    const url = text(hotel.url);
    let https = false;
    try { https = new URL(url).protocol === "https:"; } catch { https = false; }
    if (!name || !https || seen.has(squash(name)) || !sells(hotel)) return [];
    seen.add(squash(name));
    return [`${name} — ${url}`];
  });
  return links.length ? links.join("; ") : null;
}

/** The trip's AI catalogue entry. `now` decides which dates and price rows are past. */
export function tripKnowledgeModule(rawTrip: TravelTrip, now = new Date()): Program {
  // Keep-if-unsure staleness gate for date-keyed price/discount groups: a
  // group whose every parseable date already passed must not be quoted to
  // customers; groups with no parseable dates (labels, recurring text) stay.
  const groupIsCurrent = (dates: unknown): boolean => {
    const list = Array.isArray(dates)
      ? dates.map((d) => String(d ?? "")).filter(Boolean)
      : [];
    if (list.length === 0) return true;
    return filterFutureDepartureDates(list, now).length > 0;
  };
  // Customer-facing view: fixes data-entry slips (infant band "0-23 нас",
  // price-group dates that are not real departures) before the model sees them.
  const trip = sanitizeTripForCustomers(rawTrip);
  const details: string[] = [];
  const closedDates = departureAvailability(trip).filter(departureIsClosed);
  if (closedDates.length) details.push(`Unavailable departures (do not offer booking): ${closedDates.map((row) => `${row.date}: ${row.status === "SOLD_OUT" || row.seatsLeft === 0 ? "суудал дүүрсэн" : row.status}`).join(", ")}. Other dates retain their own availability.`);
  // Category is the transport differentiator (газрын / шууд нислэгтэй /
  // хосолсон) — without it the bot cannot distinguish the three "<хот>"
  // trips when a customer names only the destination.
  if (trip.category) {
    details.push(`Ангилал: ${trip.category}`);
  }
  // Past departure dates are stripped so the bot can never quote a date
  // that already happened. If nothing remains, the schedule is emitted as
  // unknown and the REFER policy sends the customer to a consultant. The
  // write-time resolved map (when present) freezes each date's year so a
  // genuine next-season departure is not mistaken for a past one.
  const resolvedDepartureDates = ((trip.extra || {}) as Record<string, unknown>)
    .departure_dates_resolved as ResolvedDepartureDate[] | undefined;
  const futureDepartureDates = filterFutureDepartureDates(
    trip.departure_dates,
    now,
    resolvedDepartureDates,
  );
  if (futureDepartureDates.length) {
    // Annotate each date with its frozen ISO year (when known) so the model
    // is not left guessing whether "1 сарын 15" means this January or next.
    const resolvedMap = new Map<string, string | null>();
    for (const entry of resolvedDepartureDates || []) {
      if (entry && typeof entry.text === "string") resolvedMap.set(entry.text, entry.ymd ?? null);
    }
    const annotated = futureDepartureDates.map((dateText) => {
      const ymd = resolvedMap.get(dateText);
      return ymd ? `${dateText} (${ymd})` : dateText;
    });
    details.push(`Departure dates: ${annotated.join(", ")}`);
  }
  if (typeof trip.child_price === "number") {
    details.push(`Child price: ${trip.child_price}`);
  }
  if (typeof trip.infant_price === "number") {
    details.push(`Infant price: ${trip.infant_price}`);
  }
  // Emit structured price groups so the bot can answer per-date pricing questions
  const extra = (trip.extra || {}) as Record<string, unknown>;
  // Who counts as infant/child/adult on THIS trip — bands differ per trip.
  {
    const bands = (extra.age_rules && typeof extra.age_rules === "object"
      ? extra.age_rules
      : {}) as Record<string, unknown>;
    const band = (key: string) => (typeof bands[key] === "string" ? (bands[key] as string).trim() : "");
    const parts = [
      band("infant") ? `infant ${band("infant")}` : "",
      band("child") ? `child ${band("child")}` : "",
      band("adult") ? `adult ${band("adult")}` : "",
    ].filter(Boolean);
    if (parts.length > 0) details.push(`Age bands: ${parts.join(" / ")}`);
  }
  const priceGroups = (Array.isArray(extra.departure_date_groups) ? extra.departure_date_groups : [])
    .filter((g) => groupIsCurrent((g as Record<string, unknown>)?.dates));
  if (priceGroups.length > 0) {
    const groupText = (priceGroups as Array<Record<string, unknown>>)
      .map((g) => {
        const dates = Array.isArray(g.dates) ? (g.dates as string[]).join(", ") : String(g.dates ?? "");
        const ap = typeof g.adult_price === "number" ? `adult ${g.adult_price}` : "";
        const cp = typeof g.child_price === "number" ? `child ${g.child_price}` : "";
        const ip = typeof g.infant_price === "number" ? `infant ${g.infant_price}` : "";
        const notes = typeof g.notes === "string" && g.notes.trim() ? ` (${g.notes.trim()})` : "";
        return `[${dates}: ${[ap, cp, ip].filter(Boolean).join(" / ")}${notes}]`;
      })
      .join("; ");
    details.push(`Price groups: ${groupText}`);
  }
  // Emit discount groups if present
  const discountGroups = (Array.isArray(extra.discount_groups) ? extra.discount_groups : [])
    .filter((g) => groupIsCurrent((g as Record<string, unknown>)?.dates));
  if (discountGroups.length > 0) {
    const discountText = (discountGroups as Array<Record<string, unknown>>)
      .map((g) => {
        const dates = Array.isArray(g.dates) ? (g.dates as string[]).join(", ") : String(g.dates ?? "");
        const ap = typeof g.adult_price === "number" ? `adult ${g.adult_price}` : "";
        const cp = typeof g.child_price === "number" ? `child ${g.child_price}` : "";
        const ip = typeof g.infant_price === "number" ? `infant ${g.infant_price}` : "";
        return `[${dates}: ${[ap, cp, ip].filter(Boolean).join(" / ")}]`;
      })
      .join("; ");
    details.push(`Discount groups: ${discountText}`);
  }
  // Emit child age range and infant age range if stored
  if (typeof extra.child_age_range === "string" && extra.child_age_range) {
    details.push(`Child age range: ${extra.child_age_range}`);
  }
  if (typeof extra.infant_age_range === "string" && extra.infant_age_range) {
    details.push(`Infant age range: ${extra.infant_age_range}`);
  }
  // Emit admin-entered structured fields
  const aliases = Array.isArray(extra.aliases) ? (extra.aliases as string[]).filter(Boolean) : [];
  if (aliases.length > 0) details.push(`Өөр нэршил: ${aliases.join(", ")}`);
  // The packages a row can be sold as ("Хөтөлбөртэй" / "Хөтөлбөргүй"): coded answers
  // already offered them by name while the model never saw one (2026-11-05).
  const packageOptions = rows(extra.package_options).flatMap((option) => {
    const name = text(option.label) || text(option.id);
    const note = text(option.note);
    return name ? [note ? `${name} (${note})` : name] : [];
  });
  if (packageOptions.length > 0) details.push(`Багцын сонголт: ${packageOptions.join("; ")}`);
  const pgNew = (Array.isArray(extra.price_groups) ? extra.price_groups as Array<Record<string, unknown>> : [])
    .filter((g) => groupIsCurrent(g?.dates));
  if (pgNew.length > 0) {
    const pgText = pgNew.map((g) => {
      const displayDates = Array.isArray(g.display_dates) && (g.display_dates as string[]).length > 0
        ? (g.display_dates as string[]).join(", ")
        : Array.isArray(g.dates) ? (g.dates as string[]).join(", ") : String(g.dates ?? "");
      // A label that only repeats the row's dates (the partner sync writes the date) adds nothing.
      const rowLabel = typeof g.label === "string" ? g.label.trim() : "";
      const label = rowLabel && rowLabel !== displayDates && !strings(g.dates).includes(rowLabel) ? `${rowLabel}: ` : "";
      const hotel = typeof g.hotel === "string" && g.hotel.trim() ? `Буудал ${g.hotel.trim()}: ` : "";
      const packageName = text(g.package_id) || text(g.package);
      const packageText = packageName ? `Багц ${packageName}: ` : "";
      // Use passenger_prices if present (more detailed), otherwise fallback to flat fields
      const ppArr = Array.isArray(g.passenger_prices) ? g.passenger_prices as Array<Record<string, unknown>> : [];
      let priceParts: string[];
      if (ppArr.length > 0) {
        priceParts = [
          formatPriceRange(g.adult_price_range, "MNT")
            ? `Том ${formatPriceRange(g.adult_price_range, "MNT")}`
            : typeof g.adult_price === "number" ? `Том ${g.adult_price}₮` : "",
          ...ppArr.map((pp) => {
            // The label is printed whole: "Хүүхэд 1,2-1,4 м өндөр" is a different
            // fare from "Хүүхэд 1,2 м доош" even with no age_range on either.
            const ppLabel = typeof pp.label === "string" && pp.label ? pp.label : "Зорчигч";
            const age = typeof pp.age_range === "string" ? pp.age_range.trim() : "";
            const ppAge = age && !squash(ppLabel).includes(squash(age)) ? ` (${age})` : "";
            const ppPrice = typeof pp.price === "number" ? ` ${pp.price}₮` : "";
            return `${ppLabel}${ppAge}${ppPrice}`;
          }),
        ].filter(Boolean);
      } else {
        priceParts = [
          formatPriceRange(g.adult_price_range, "MNT")
            ? `Том ${formatPriceRange(g.adult_price_range, "MNT")}`
            : typeof g.adult_price === "number" ? `Том ${g.adult_price}₮` : "",
          typeof g.child_price === "number" ? `Хүүхэд${g.child_age ? ` (${g.child_age})` : ""} ${g.child_price}₮` : "",
          typeof g.infant_price === "number" ? `Нярай${g.infant_age ? ` (${g.infant_age})` : ""} ${g.infant_price}₮` : "",
        ].filter(Boolean);
      }
      if (typeof g.single_price === "number" && g.single_price >= 1000) {
        priceParts.push(`Ганцаараа явах (өрөөндөө ганцаараа) ${g.single_price}₮`);
      }
      const note = typeof g.note === "string" && g.note ? ` — ${g.note}` : "";
      // One hotel/package full on a date while the date still sells another: the model must not
      // offer it (the fare card and the website leave it out; "Unavailable departures" covers whole dates only).
      const rowStatus = text(g.status).toLowerCase();
      const closed = rowStatus === "sold_out" || g.seats_left === 0 ? " — суудал дүүрсэн, санал болгохгүй"
        : ["paused", "cancelled"].includes(rowStatus) ? " — захиалга хаалттай, санал болгохгүй" : "";
      return `[${label}${displayDates}: ${hotel}${packageText}${priceParts.filter(Boolean).join(" / ")}${note}${closed}]`;
    }).join("; ");
    details.push(`Огноо тус бүрийн үнэ: ${pgText}`);
  }
  const discNew = (Array.isArray(extra.discounts) ? extra.discounts as Array<Record<string, unknown>> : [])
    .filter((g) => groupIsCurrent(g?.dates));
  if (discNew.length > 0) {
    const discText = discNew.map((g) => {
      const dates = Array.isArray(g.dates) && (g.dates as string[]).length > 0 ? ` (${(g.dates as string[]).join(", ")})` : "";
      const label = typeof g.label === "string" && g.label ? g.label : "Хямдрал";
      const ap = typeof g.adult_price === "number" ? `Том ${g.adult_price}₮` : "";
      const cp = typeof g.child_price === "number" ? `Хүүхэд ${g.child_price}₮` : "";
      const ip = typeof g.infant_price === "number" ? `Нярай ${g.infant_price}₮` : "";
      const cond = typeof g.condition === "string" && g.condition ? ` Нөхцөл: ${g.condition}` : "";
      const note = typeof g.note === "string" && g.note ? ` — ${g.note}` : "";
      return `[${label}${dates}: ${[ap, cp, ip].filter(Boolean).join(" / ")}${cond}${note}]`;
    }).join("; ");
    details.push(`Хямдрал: ${discText}`);
  }
  const childRules = Array.isArray(extra.child_rules) ? extra.child_rules as Array<Record<string, unknown>> : [];
  if (childRules.length > 0) {
    const crText = childRules.map((r) => {
      const label = typeof r.label === "string" && r.label ? r.label : "";
      const age = typeof r.age_range === "string" && r.age_range ? r.age_range : "";
      const price = typeof r.price === "number" ? `${r.price}₮` : "";
      return [label, age, price].filter(Boolean).join(" ");
    }).join("; ");
    details.push(`Хүүхдийн насны ангилал: ${crText}`);
  }
  const extraFees = Array.isArray(extra.extra_fees) ? extra.extra_fees as Array<Record<string, unknown>> : [];
  if (extraFees.length > 0) {
    const efText = extraFees.map((f) => {
      const label = typeof f.label === "string" && f.label ? f.label : "Нэмэлт";
      const amount = typeof f.amount === "number" ? `${f.amount}${typeof f.currency === "string" ? f.currency : ""}` : "";
      return `${label}${amount ? `: ${amount}` : ""}`;
    }).join("; ");
    details.push(`Нэмэлт төлбөр: ${efText}`);
  }
  if (typeof extra.departure_rule === "string" && extra.departure_rule.trim()) {
    details.push(`Гарах өдрийн дүрэм: ${extra.departure_rule.trim()}`);
  }
  // Transport and destinations as staff set them. They used to only hide the
  // website's own lines below, so the model saw neither (2026-11-05).
  const transport = TRANSPORT_WORDS[text(extra.transport_type)];
  if (transport) details.push(`Тээврийн төрөл: ${transport}`);
  const destinations = strings(extra.destinations);
  if (destinations.length > 0) details.push(`Очих газрууд: ${destinations.join(", ")}`);
  const included = Array.isArray(extra.included_items) ? (extra.included_items as string[]).filter(Boolean) : [];
  if (included.length > 0) details.push(`Багтсан: ${included.join(", ")}`);
  const excluded = Array.isArray(extra.excluded_items) ? (extra.excluded_items as string[]).filter(Boolean) : [];
  if (excluded.length > 0) details.push(`Багтаагүй: ${excluded.join(", ")}`);
  // Which meals each program day includes; the model could not tell a customer before.
  const meals = itineraryMealsText(extra.itinerary_days);
  if (meals) details.push(`Өдөр бүрийн хоол: ${meals}`);
  const hotelLinks = hotelLinksText(extra);
  if (hotelLinks) details.push(`Буудлын холбоос: ${hotelLinks}`);
  const roomPrices = Array.isArray(extra.room_prices) ? extra.room_prices as Array<Record<string, unknown>> : [];
  if (roomPrices.length > 0) {
    const rpText = roomPrices.map((r) => {
      const type = typeof r.room_type === "string" && r.room_type ? r.room_type : "Өрөө";
      const price = typeof r.price === "number" ? `${r.price}${typeof r.currency === "string" ? r.currency : ""}` : "";
      return `${type}${price ? `: ${price}` : ""}`;
    }).join("; ");
    details.push(`Өрөөний үнэ: ${rpText}`);
  }
  const impNotes = Array.isArray(extra.important_notes)
    ? (extra.important_notes as string[]).filter(Boolean).filter((note) => !isGenericConfirmationText(note))
    : [];
  if (impNotes.length > 0) details.push(`Чухал тэмдэглэл: ${impNotes.join(" | ")}`);
  // Booking terms — lets the bot answer deposit/payment/documents/visa/
  // cancellation questions from stored data instead of REFER. Empty fields
  // are omitted, so a field the trip lacks stays "unknown" → REFER.
  const bookingTerms = (extra.booking_terms || {}) as Record<string, unknown>;
  const website = extra.website_details && typeof extra.website_details === "object" ? extra.website_details as Record<string, unknown> : {};
  const btParts: string[] = [];
  if (typeof bookingTerms.deposit === "string" && bookingTerms.deposit.trim()) btParts.push(`Урьдчилгаа: ${bookingTerms.deposit.trim()}`);
  if (typeof bookingTerms.payment === "string" && bookingTerms.payment.trim()) btParts.push(`Төлбөрийн нөхцөл: ${bookingTerms.payment.trim()}`);
  if (typeof bookingTerms.documents === "string" && bookingTerms.documents.trim()) btParts.push(`Бүрдүүлэх бичиг баримт: ${bookingTerms.documents.trim()}`);
  if (typeof bookingTerms.visa === "string" && bookingTerms.visa.trim()) btParts.push(`Виз: ${bookingTerms.visa.trim()}`);
  if (typeof bookingTerms.cancellation === "string" && bookingTerms.cancellation.trim()) btParts.push(`Цуцлалт/буцаалт: ${bookingTerms.cancellation.trim()}`);
  if (btParts.length > 0) details.push(`Захиалгын нөхцөл: ${btParts.join(" | ")}`);
  if (!trip.notes && typeof website.description === "string" && website.description.trim()) details.push(`Вебсайтын аяллын тайлбар: ${website.description}`);
  if (!bookingTerms.documents && typeof website.requirements === "string" && website.requirements.trim()) details.push(`Аяллын шаардлага: ${website.requirements}`);
  if (!bookingTerms.cancellation && typeof website.cancellationPolicy === "string" && website.cancellationPolicy.trim()) details.push(`Аяллын цуцлалтын нөхцөл: ${website.cancellationPolicy}`);
  // The website's own destination and transport lines are kept beside the trip's;
  // only a destination list identical to the trip's is not repeated.
  const websiteDestinations = strings(website.destinations);
  const sameDestinations = websiteDestinations.length === destinations.length
    && websiteDestinations.every((place) => destinations.some((own) => squash(own) === squash(place)));
  if (websiteDestinations.length && !sameDestinations) details.push(`Веб аяллын очих газрууд: ${websiteDestinations.join(", ")}`);
  if (Array.isArray(website.highlights) && website.highlights.length) details.push(`Веб аяллын онцлох зүйлс: ${website.highlights.join(" | ")}`);
  if (typeof website.meetingPoint === "string" && website.meetingPoint.trim()) details.push(`Цугларах газар: ${website.meetingPoint}`);
  const websiteTransport = strings(website.transport);
  if (websiteTransport.length) details.push(`Веб аяллын тээвэр: ${websiteTransport.join(", ")}`);
  if (Array.isArray(website.languages) && website.languages.length) details.push(`Хөтчийн хэл: ${website.languages.join(", ")}`);
  // Emit answer_hints so the bot gets explicit expected answers per intent
  const answerHints = Array.isArray(extra.answer_hints) ? extra.answer_hints as Array<Record<string, unknown>> : [];
  if (answerHints.length > 0) {
    const hintText = answerHints.map((h) => {
      const intent = typeof h.intent === "string" ? h.intent : "";
      const qp = typeof h.question_pattern === "string" ? h.question_pattern : "";
      const expected = typeof h.expected_answer_summary === "string" ? h.expected_answer_summary : "";
      return `[${intent}: "${qp}" → ${expected}]`;
    }).join("; ");
    details.push(`Хариултын заавар: ${hintText}`);
  }
  // seats: only emit if actually known (null = unknown, 0 = sold out)
  if (trip.seats_left != null) {
    details.push(`Seats left: ${trip.seats_left}`);
  }
  if (trip.seats_total != null) {
    details.push(`Seats total: ${trip.seats_total}`);
  }
  if (trip.has_food != null) {
    details.push(`Food: ${trip.has_food ? "yes" : "no"}`);
  }
  if (trip.status !== "active") {
    details.push(`Status: ${trip.status}`);
  }
  if (trip.hotel) details.push(`Hotel: ${trip.hotel}`);
  if (trip.notes && !isGenericConfirmationText(trip.notes)) details.push(`Notes: ${trip.notes}`);

  return {
    name: trip.route_name,
    duration: isGenericConfirmationText(trip.duration_text) ? "" : trip.duration_text || "",
    price:
      typeof trip.adult_price === "number"
        ? trip.adult_price
        : ("NEEDS_MANUAL_FIX" as ProgramPrice),
    target: trip.operator_name,
    description: [trip.source_description, ...details]
      .filter(Boolean)
      .filter((value) => !isGenericConfirmationText(value))
      .join(" | "),
  };
}
