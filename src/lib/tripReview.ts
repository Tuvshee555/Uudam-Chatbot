/**
 * The facts a new-trip review works with, shared by the admin page, the server
 * pipeline and the tests: departure dates as calendar days, each day's meals as
 * "included / own cost / not stated", the standard days for a transport type,
 * the photos with their credits, and what is still missing before the trip can
 * be published. Pure: no database, no model.
 *
 * Until 2026-11-05 the review was a flat form: dates typed as comma-separated
 * text, the duration typed by hand, every day's meals collapsed into one
 * "Хоол: Багтсан", and whatever the admin corrected was dropped at save.
 */
import { resolveDepartureDatesAtWrite } from "./travelDates";
import { itineraryEndsInUlaanbaatar, itineraryStartsInUlaanbaatar } from "./tripItineraryBoundaries";
import {
  TRANSPORT_WEBSITE_TAGS, durationForDays, isTransitDay, isTransportType, withStandardTransitDays,
  type ItineraryDay, type TransportType,
} from "./tripTransitDays";

type Row = Record<string, unknown>;

/** Proposal notes the review states itself, beside the field they are about (tripProposalFinalize.ts writes them). */
export const DEPARTURE_SHIFT = "departure_shift";
export const DEPARTURE_CONFLICT = "departure_conflict";
export const REVIEW_INLINE_ITEMS: ReadonlySet<string> = new Set([
  "transport_choice", "price_missing", DEPARTURE_SHIFT, DEPARTURE_CONFLICT, "dates_missing", "dates_check", "photos_found",
]);
export const TRANSPORT_SHORT_LABELS: Record<TransportType, string> = {
  land: "Газраар", land_flight: "Газар + нислэг", direct_flight: "Шууд нислэг", cruise: "Усан онгоц",
};

const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? value as Row : {});
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/* ------------------------------------------------------------------ meals */

/** true = included in the price, false = the traveller pays, null = the source does not say. */
export type MealState = boolean | null;
export type MealKey = "breakfast" | "lunch" | "dinner";
export const MEAL_KEYS: readonly MealKey[] = ["breakfast", "lunch", "dinner"];
export const MEAL_LABELS: Record<MealKey, string> = { breakfast: "Өглөөний цай", lunch: "Өдрийн хоол", dinner: "Оройн хоол" };
export const MEAL_STATE_LABELS = { included: "багтсан", own: "өөрийн зардлаар", unknown: "тодорхойгүй" } as const;

export function mealState(value: unknown): MealState {
  return value === true ? true : value === false ? false : null;
}

export function dayMeals(day: { meals?: unknown } | undefined): Record<MealKey, MealState> {
  const meals = record(day?.meals);
  return { breakfast: mealState(meals.breakfast), lunch: mealState(meals.lunch), dinner: mealState(meals.dinner) };
}

/** One click moves a meal on: included → own cost → not stated → included. */
export function nextMealState(state: MealState): MealState {
  return state === true ? false : state === false ? null : true;
}

/**
 * The trip-level "meals included" flag from its days: true when any meal is
 * included, false when the program states meals and none is included, null when
 * it says nothing about meals at all.
 */
export function deriveHasFood(days: Array<{ meals?: unknown }>): boolean | null {
  let stated = false;
  for (const day of days) {
    const meals = dayMeals(day);
    for (const key of MEAL_KEYS) {
      if (meals[key] === true) return true;
      if (meals[key] === false) stated = true;
    }
  }
  return stated ? false : null;
}

/* ------------------------------------------------------------------ dates */

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS = ["Ням", "Даваа", "Мягмар", "Лхагва", "Пүрэв", "Баасан", "Бямба"];

export function isYmd(value: unknown): value is string {
  return typeof value === "string" && YMD.test(value);
}

export function addDaysYmd(ymd: string, days: number): string {
  const [year, month, day] = ymd.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function mongoliaToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ulaanbaatar", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function weekdayOf(ymd: string): string {
  const [year, month, day] = ymd.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

/** "11-р сарын 21" — with the year when it is not the current one. */
export function formatYmd(ymd: string, now = new Date()): string {
  if (!isYmd(ymd)) return ymd;
  const [year, month, day] = ymd.split("-").map(Number);
  const label = `${month}-р сарын ${day}`;
  return year === Number(mongoliaToday(now).slice(0, 4)) ? label : `${year} оны ${label}`;
}

/**
 * Departure texts as calendar days — a date written without a year becomes its
 * next occurrence — plus whatever is not one calendar day (a weekly rule such
 * as "Пүрэв гараг бүр"), kept as written.
 */
export function departureDays(dates: unknown, now = new Date()): { days: string[]; other: string[] } {
  const list = (Array.isArray(dates) ? dates : []).map((date) => String(date ?? "").trim()).filter(Boolean);
  const days: string[] = [];
  const other: string[] = [];
  for (const entry of resolveDepartureDatesAtWrite(list, now)) {
    if (entry.ymd) days.push(entry.ymd);
    else other.push(entry.text);
  }
  return { days: Array.from(new Set(days)).sort(), other: Array.from(new Set(other)) };
}

/**
 * The trip with exactly these departure days (plus its non-calendar rules).
 * A day taken off the calendar also leaves the per-date price groups, so a
 * removed departure cannot come back through its fare.
 */
export function setDepartureDays(fields: Row, days: string[], now = new Date()): Row {
  const { other } = departureDays(fields.departure_dates, now);
  const kept = new Set(days);
  const extra = { ...record(fields.extra) };
  for (const key of ["price_groups", "departure_date_groups"]) {
    if (!Array.isArray(extra[key])) continue;
    extra[key] = (extra[key] as unknown[]).flatMap((entry) => {
      const group = record(entry);
      const before = Array.isArray(group.dates) ? group.dates.map(String) : [];
      if (!before.length) return [group];
      const keep = (list: unknown) => (Array.isArray(list) ? list.map(String) : []).filter((date) => {
        const resolved = departureDays([date], now).days[0];
        return !resolved || kept.has(resolved);
      });
      const dates = keep(group.dates);
      if (!dates.length) return [];
      return [{ ...group, dates, ...(Array.isArray(group.date_keys) ? { date_keys: keep(group.date_keys) } : {}), ...(Array.isArray(group.display_dates) ? { display_dates: keep(group.display_dates) } : {}) }];
    });
  }
  return { ...fields, departure_dates: [...Array.from(kept).sort(), ...other], ...(fields.extra ? { extra } : {}) };
}

/** The calendar day written beside a program day ("11/22", "11 сарын 22"), read in the year of the departure it follows. */
export function programDayDate(written: unknown, departure: string): string | null {
  const source = text(written);
  if (!source || !isYmd(departure)) return null;
  const full = /(20\d{2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})/.exec(source);
  if (full) {
    const ymd = `${full[1]}-${full[2].padStart(2, "0")}-${full[3].padStart(2, "0")}`;
    return Number.isNaN(Date.parse(`${ymd}T00:00:00Z`)) ? null : ymd;
  }
  const short = /(\d{1,2})\s*(?:[./]|-?\s*р?\s*сарын?)\s*(\d{1,2})/i.exec(source);
  if (!short) return null;
  const month = Number(short[1]);
  const day = Number(short[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const year = Number(departure.slice(0, 4));
  // The occurrence nearest the departure: a New Year trip crosses into the next year, and a
  // date that disagrees is still read in the departure's own season, not a year away.
  const stamp = (ymd: string) => Date.parse(`${ymd}T00:00:00Z`);
  const candidates = [year - 1, year, year + 1].map((y) => `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`)
    .filter((candidate) => !Number.isNaN(stamp(candidate)));
  return candidates.sort((a, b) => Math.abs(stamp(a) - stamp(departure)) - Math.abs(stamp(b) - stamp(departure)))[0] || null;
}

/**
 * Whether a departure date agrees with the dates the source writes beside its
 * own program days. The standard train day leaves Ulaanbaatar the day before a
 * partner's first day at the border, so:
 *   consistent — the program's first day is the departure plus the added days;
 *   shift      — the "departure" is really the program's first day at the
 *                border: Ulaanbaatar is left a day earlier (the admin decides);
 *   conflict   — the dates disagree some other way;
 *   unknown    — the source writes no dates beside its days.
 */
export type DepartureCheck =
  | { kind: "consistent"; departure: string; programStart: string }
  | { kind: "shift"; departure: string; suggested: string; programStart: string }
  | { kind: "conflict"; departure: string; programStart: string; expected: string }
  | { kind: "unknown" };

export function checkDeparture(departures: string[], days: ItineraryDay[]): DepartureCheck {
  const front = days.findIndex((day) => !isTransitDay(day));
  const first = front >= 0 ? days[front] : undefined;
  const dates = departures.filter(isYmd).sort();
  if (!first || !text(first.date) || !dates.length) return { kind: "unknown" };
  for (const departure of dates) {
    const programStart = programDayDate(first.date, departure);
    if (programStart && programStart === addDaysYmd(departure, front)) return { kind: "consistent", departure, programStart };
  }
  if (front > 0) {
    for (const departure of dates) {
      const programStart = programDayDate(first.date, departure);
      if (programStart && programStart === departure) return { kind: "shift", departure, suggested: addDaysYmd(departure, -front), programStart };
    }
  }
  if (dates.length === 1) {
    const programStart = programDayDate(first.date, dates[0]);
    if (programStart) return { kind: "conflict", departure: dates[0], programStart, expected: addDaysYmd(dates[0], front) };
  }
  return { kind: "unknown" };
}

/* ------------------------------------------------------------- the trip */

export function itineraryOf(fields: Row): ItineraryDay[] {
  const days = record(fields.extra).itinerary_days;
  return (Array.isArray(days) ? days : []).map((day) => record(day) as ItineraryDay);
}

/**
 * The trip rebuilt for a transport type: the standard first and last days,
 * the door-to-door duration, the website's transport tags. `added` counts the
 * days put around the program; `programDays` is the program's own length.
 */
export function applyTransport(fields: Row, transport: TransportType): { fields: Row; added: number; programDays: number } {
  const extra = record(fields.extra);
  const input = itineraryOf(fields);
  const built = withStandardTransitDays(input, transport);
  const programDays = built.days.length - built.added;
  const patch = record(extra.website_details_patch);
  // The program's own length, kept so switching to a transport that adds no days restores it.
  // On a second pass `duration_text` already holds the door-to-door length: count the program's days instead.
  const generated = input.filter(isTransitDay).length;
  const written = text(fields.duration_text);
  const programDuration = text(extra.program_duration_text)
    || (generated > 0 && Number(/(\d+)\s*өдөр/i.exec(written)?.[1]) === input.length ? durationForDays(input.length - generated).duration_text : written);
  const duration = built.added > 0 ? durationForDays(built.days.length) : null;
  const next: Row = {
    ...fields,
    extra: {
      ...extra,
      itinerary_days: built.days,
      transport_type: transport,
      program_duration_text: programDuration,
      website_details_patch: { base: record(patch.base), values: { ...record(patch.values), transport: TRANSPORT_WEBSITE_TAGS[transport] } },
      ...(duration ? { duration_days: duration.duration_days, duration_nights: duration.duration_nights } : programDurationParts(programDuration, built.days.length)),
    },
    duration_text: duration ? duration.duration_text : programDuration || durationForDays(built.days.length).duration_text,
  };
  return { fields: next, added: built.added, programDays };
}

function programDurationParts(written: string, dayCount: number): { duration_days: number; duration_nights: number } {
  const days = /(\d+)\s*өдөр/i.exec(written);
  const nights = /(\d+)\s*шөнө/i.exec(written);
  const fallback = durationForDays(dayCount);
  const duration_days = days ? Number(days[1]) : fallback.duration_days;
  const duration_nights = nights ? Number(nights[1]) : Math.max(0, duration_days - 1);
  return { duration_days, duration_nights: Math.min(duration_nights, Math.max(0, duration_days - 1)) };
}

export function transportOf(fields: Row): TransportType | null {
  const value = record(fields.extra).transport_type;
  return isTransportType(value) ? value : null;
}

/**
 * The length the source states against the days its program really has. The
 * duration is never typed: it is the program's own, plus the standard days. When
 * the two disagree the review shows both and the admin picks.
 */
export type DurationCheck =
  | { kind: "consistent" | "unknown" }
  | { kind: "mismatch"; written: string; writtenDays: number; programDays: number; byProgram: string };

const DAY_COUNT = /(\d+)\s*өд(?:ө)?р/i;

export function checkDuration(fields: Row): DurationCheck {
  const extra = record(fields.extra);
  const days = itineraryOf(fields);
  const programDays = days.filter((day) => !isTransitDay(day)).length;
  const written = text(extra.program_duration_text) || text(record(extra.source_evidence).duration);
  const writtenDays = Number(DAY_COUNT.exec(written)?.[1]);
  if (!programDays || !writtenDays) return { kind: "unknown" };
  if (writtenDays === programDays) return { kind: "consistent" };
  return { kind: "mismatch", written, writtenDays, programDays, byProgram: durationForDays(days.length).duration_text };
}

/** The trip with its length taken from the days of its program (the answer to a duration mismatch). */
export function withProgramDuration(fields: Row): Row {
  const days = itineraryOf(fields);
  const programDays = days.filter((day) => !isTransitDay(day)).length;
  const duration = durationForDays(days.length);
  return {
    ...fields,
    duration_text: duration.duration_text,
    extra: { ...record(fields.extra), program_duration_text: durationForDays(programDays).duration_text, duration_days: duration.duration_days, duration_nights: duration.duration_nights },
  };
}

/* ---------------------------------------------------------------- prices */

export type PriceRow = {
  /** Calendar days this fare applies to; empty when the row is named instead (a hotel, a package). */
  dates: string[];
  label: string;
  adult: number | null;
  child: number | null;
  infant: number | null;
  /** Age or height bands the source prices separately ("1.2–1.4 м", "6–11 нас"). */
  bands: Array<{ label: string; price: number }>;
};

function priceGroups(fields: Row): Row[] {
  const extra = record(fields.extra);
  const groups = Array.isArray(extra.price_groups) && extra.price_groups.length ? extra.price_groups
    : Array.isArray(extra.departure_date_groups) ? extra.departure_date_groups : [];
  return groups.map(record);
}

/** The fares the source lists per departure date, hotel or package, as rows to read. */
export function priceRows(fields: Row, now = new Date()): PriceRow[] {
  return priceGroups(fields).map((group) => {
    const dates = departureDays(group.dates, now).days;
    const name = [text(group.hotel), text(group.package_id)].filter(Boolean).join(" · ");
    return {
      dates,
      label: name || (dates.length ? "" : text(group.label)),
      adult: hasPrice(group.adult_price) ? group.adult_price : null,
      child: hasPrice(group.child_price) ? group.child_price : null,
      infant: hasPrice(group.infant_price) || group.infant_price === 0 ? group.infant_price as number : null,
      bands: (Array.isArray(group.passenger_prices) ? group.passenger_prices : []).map(record)
        .filter((band) => hasPrice(band.price) || band.price === 0)
        .map((band) => ({ label: text(band.label) || text(band.age_range) || "Хүүхэд", price: band.price as number })),
    };
  }).filter((row) => row.adult !== null || row.bands.length > 0);
}

/* ---------------------------------------------------------------- photos */

export type ReviewPhoto = { url: string; day: number | null; title: string; author: string; license: string; page: string };

/** Every photo of the trip, the cover first, with the day it illustrates and its credit. */
export function tripPhotos(fields: Row): ReviewPhoto[] {
  const credits = record(record(fields.extra).photo_credits);
  const days = itineraryOf(fields);
  const urls = (Array.isArray(fields.photo_urls) ? fields.photo_urls : []).filter((url): url is string => typeof url === "string" && url.startsWith("https://"));
  for (const day of days) if (text(day.photo).startsWith("https://") && !urls.includes(text(day.photo))) urls.push(text(day.photo));
  return urls.map((url) => {
    const credit = record(credits[url]);
    const day = days.find((entry) => text(entry.photo) === url);
    return { url, day: typeof day?.day === "number" ? day.day : null, title: text(credit.title), author: text(credit.author), license: text(credit.license), page: text(credit.page) };
  });
}

/** The trip without one photo: off the gallery, off its day, its credit dropped. */
export function removePhoto(fields: Row, url: string): Row {
  const extra = record(fields.extra);
  const credits = { ...record(extra.photo_credits) };
  delete credits[url];
  return {
    ...fields,
    photo_urls: (Array.isArray(fields.photo_urls) ? fields.photo_urls : []).filter((entry) => entry !== url),
    extra: {
      ...extra,
      photo_credits: credits,
      itinerary_days: itineraryOf(fields).map((day) => (text(day.photo) === url ? { ...day, photo: "" } : day)),
    },
  };
}

/** The same photos with `url` first: the first photo is the trip's cover. */
export function makeCover(fields: Row, url: string): Row {
  const urls = (Array.isArray(fields.photo_urls) ? fields.photo_urls : []).filter((entry): entry is string => typeof entry === "string");
  if (!urls.includes(url)) return fields;
  return { ...fields, photo_urls: [url, ...urls.filter((entry) => entry !== url)] };
}

/* ---------------------------------------------------------------- issues */

export type ReviewIssue = {
  key: "name" | "dates" | "past_dates" | "price" | "program" | "boundary";
  text: string;
  /** "save": nothing can be saved; "publish": a draft can; null: only a note. */
  blocks: "save" | "publish" | null;
};

export function hasPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** What is still missing, in the order the admin would fix it. A missing price never blocks. */
export function reviewIssues(fields: Row, now = new Date()): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  if (!text(fields.route_name)) issues.push({ key: "name", text: "Аяллын нэр хоосон байна.", blocks: "save" });
  const { days, other } = departureDays(fields.departure_dates, now);
  const today = mongoliaToday(now);
  if (!days.length && !other.length) {
    issues.push({ key: "dates", text: "Гарах өдөр сонгоогүй. Нийтлэхийн тулд календариас дор хаяж нэг өдөр сонгоно уу.", blocks: "publish" });
  } else if (days.length && !other.length && days.every((day) => day < today)) {
    issues.push({ key: "past_dates", text: "Сонгосон гарах өдрүүд бүгд өнгөрсөн байна.", blocks: "publish" });
  }
  if (!hasPrice(fields.adult_price) && !priceRows(fields, now).length) issues.push({ key: "price", text: "Үнэ оруулаагүй — сайтад «Үнэ лавлах» гэж гарна.", blocks: null });
  const program = itineraryOf(fields);
  if (!program.length) issues.push({ key: "program", text: "Өдөр тутмын хөтөлбөр алга.", blocks: null });
  // The save check itself (tripDataValidation.ts): said here, before the save, not as an error after it.
  else if (!itineraryStartsInUlaanbaatar(program[0]) || !itineraryEndsInUlaanbaatar(program[program.length - 1])) {
    issues.push({ key: "boundary", text: "Хөтөлбөр Улаанбаатараас эхэлж, Улаанбаатарт дуусах ёстой. Тээврийн төрлөө дахин сонгох эсвэл эхний, сүүлийн өдрийн бичвэрийг засна уу.", blocks: "save" });
  }
  return issues;
}

/* ------------------------------------------------------------------ save */

/** Keys that exist only for the review and must never reach a saved trip. */
const REVIEW_ONLY_EXTRA = ["source_evidence", "program_duration_text"];

/**
 * The fields without what only the review needed: the source quotes, the
 * program's own length and the calendar day written beside each program day
 * (it belongs to one departure, and a trip has several).
 */
export function withoutReviewOnly(fields: Row): Row {
  if (!fields.extra || typeof fields.extra !== "object") return fields;
  const extra = { ...record(fields.extra) };
  for (const key of REVIEW_ONLY_EXTRA) delete extra[key];
  if (Array.isArray(extra.itinerary_days)) {
    extra.itinerary_days = itineraryOf(fields).map((day) => {
      const { date: _date, ...rest } = day;
      void _date;
      return rest;
    });
  }
  return { ...fields, extra };
}

/**
 * The reviewed trip as the fields to save. A draft stays off the website and
 * out of the bot's answers until it is published from the trip list.
 */
export function reviewedFields(fields: Row, mode: "draft" | "publish", now = new Date()): Row {
  const next: Row = { ...withoutReviewOnly(fields), status: mode === "draft" ? "draft" : "active" };
  for (const key of ["adult_price", "child_price", "infant_price"]) {
    const value = fields[key];
    // An infant travels free on some trips: 0 is a real infant fare, never an adult or child one.
    next[key] = hasPrice(value) || (key === "infant_price" && value === 0) ? value : null;
  }
  // Calendar days are saved with their year, so a date picked for next season is never re-guessed.
  const { days: departures, other } = departureDays(fields.departure_dates, now);
  next.departure_dates = [...departures, ...other];
  const days = itineraryOf(next).map((day) => ({ ...day, meals: dayMeals(day), ...(text(day.meal_note) ? { meal_note: text(day.meal_note) } : {}) }));
  if (days.length) {
    next.extra = { ...record(next.extra), itinerary_days: days };
    next.has_food = deriveHasFood(days);
  }
  // Per-date fares carry the same calendar days as the trip, so a fare never points at another year.
  const extra = record(next.extra);
  for (const key of ["price_groups", "departure_date_groups"]) {
    if (!Array.isArray(extra[key]) || !extra[key].length) continue;
    next.extra = {
      ...record(next.extra),
      [key]: (extra[key] as unknown[]).map((entry) => {
        const group = record(entry);
        const resolved = departureDays(group.dates, now);
        if (!resolved.days.length) return group;
        const { date_keys: _keys, display_dates: _shown, ...rest } = group;
        void _keys; void _shown;
        return { ...rest, dates: [...resolved.days, ...resolved.other] };
      }),
    };
  }
  // A trip priced only per date still needs its "from" price: the lowest adult fare and that row's child fare.
  if (!hasPrice(next.adult_price)) {
    const cheapest = priceRows(next, now).filter((row) => row.adult !== null).sort((a, b) => (a.adult as number) - (b.adult as number))[0];
    if (cheapest) {
      next.adult_price = cheapest.adult;
      if (!hasPrice(next.child_price) && cheapest.child !== null) next.child_price = cheapest.child;
    }
  }
  return next;
}

/** "9 өдөр 8 шөнө · Газар + нислэг · 3 гарах өдөр · 5 зураг" */
export function reviewFacts(fields: Row, now = new Date()): string[] {
  const transport = transportOf(fields);
  const { days, other } = departureDays(fields.departure_dates, now);
  const photos = tripPhotos(fields).length;
  return [
    text(fields.duration_text),
    transport ? TRANSPORT_SHORT_LABELS[transport] : "",
    days.length + other.length ? `${days.length + other.length} гарах өдөр` : "",
    photos ? `${photos} зураг` : "",
  ].filter(Boolean);
}
