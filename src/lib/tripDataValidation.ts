/** Pure catalog audit. No normalization, persistence, or inferred passenger defaults. */
export type TripFactInput = {
  id?: unknown;
  route_name?: unknown;
  hotel?: unknown;
  currency?: unknown;
  adult_price?: unknown;
  child_price?: unknown;
  infant_price?: unknown;
  duration_text?: unknown;
  departure_dates?: unknown;
  seats_total?: unknown;
  seats_left?: unknown;
  status?: unknown;
  extra?: unknown;
};

export type TripFactIssue = {
  code: string;
  severity: "error" | "warning";
  paths: string[];
  message: string;
  /** Stable factual identity, independent of array order and unrelated metadata. */
  key: string;
};

export type TripFactAudit = {
  valid: boolean;
  issues: TripFactIssue[];
  errors: TripFactIssue[];
  warnings: TripFactIssue[];
};

type Row = Record<string, unknown>;
type CalendarDate = { year: number | null; month: number; day: number };
type AgeBand = { min: number; max: number; basis: "months" | "birth_year"; step?: number };
type Fare = { scope: string; band: AgeBand | null; price: number; max: number; currency: string; path: string };
type Group = { path: string; hotel: string; packageId: string; dates: CalendarDate[]; fares: Fare[] };

const TRIP_STATUSES = new Set(["active", "paused", "cancelled", "sold_out", "draft", "archived"]);
const DEPARTURE_STATUSES = new Set(["OPEN", "SOLD_OUT", "PAUSED", "CANCELLED", "DEPARTED"]);
const record = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(record) : [];
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const norm = (value: unknown): string => text(value).normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
const amount = (value: unknown): number | null => {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/,/g, "")) : NaN;
  return Number.isFinite(n) ? n : null;
};

function ageBand(value: unknown): AgeBand | null {
  const valueText = norm(value).replace(/[\u2013\u2014]/g, "-");
  if (!valueText) return null;
  const birth = valueText.match(/^(\d{4})\s*-\s*(\d{4})\s*(?:он|born|birth years?)?$/);
  if (birth) return { min: Number(birth[1]), max: Number(birth[2]), basis: "birth_year" };
  const range = valueText.match(/^(\d{1,3}(?:\.\d+)?)\s*-\s*(\d{1,3}(?:\.\d+)?)\s*(нас|сар|years?|months?|age)?$/);
  const plus = valueText.match(/^(\d{1,3})\s*\+\s*(нас|сар|years?|months?|age)?$/);
  const under = valueText.match(/^(?:under|less than)\s*(\d{1,3})\s*(years?|months?)?$/)
    || valueText.match(/^(\d{1,3})\s*(нас|сар)?\s*(?:хүртэл|доош)$/);
  const single = valueText.match(/^(\d{1,3})\s*(нас|сар|years?|months?|age)$/);
  const match = range || plus || under || single;
  if (!match) return null;
  const unit = range ? range[3] : match[2];
  const factor = /сар|month/.test(unit || "") ? 1 : 12;
  const min = under ? 0 : Number(match[1]) * factor;
  // Inclusive completed years/months become half-open month intervals.
  const max = plus ? Infinity : under ? Number(match[1]) * factor : (Number(range ? range[2] : match[1]) + 1) * factor;
  return { min, max, basis: "months", step: factor };
}

const bandKey = (band: AgeBand): string => `${band.basis}:${band.min}:${band.max}`;
const overlap = (a: AgeBand, b: AgeBand): boolean => a.basis === b.basis && (a.basis === "birth_year"
  ? Math.max(a.min, b.min) <= Math.min(a.max, b.max)
  : Math.max(a.min, b.min) < Math.min(a.max, b.max));
const sharedAgeBoundary = (a: AgeBand, b: AgeBand): boolean => a.basis === "months" && b.basis === "months" &&
  (a.max - (a.step || 1) === b.min || b.max - (b.step || 1) === a.min);
const sameDate = (a: CalendarDate, b: CalendarDate): boolean => a.month === b.month && a.day === b.day &&
  (a.year === null || b.year === null || a.year === b.year);
const dateKey = (d: CalendarDate): string => `${d.year ?? "*"}-${d.month}-${d.day}`;

export function auditTripFacts(trip: TripFactInput, now = new Date()): TripFactAudit {
  const issues: TripFactIssue[] = [];
  const extra = record(trip.extra);
  const add = (code: string, severity: TripFactIssue["severity"], paths: string[], message: string, facts: unknown) => {
    const key = JSON.stringify([code, facts]);
    if (!issues.some(issue => issue.key === key)) issues.push({ code, severity, paths, message, key });
  };

  for (const key of ["adult_price", "child_price", "infant_price"] as const) {
    const value = trip[key];
    if (value != null && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) {
      add("invalid_base_price", "error", [key], `${key}: enter a non-negative whole-number fare or null. Correct the base passenger price.`, [key, value]);
    }
  }
  if (trip.duration_text != null && typeof trip.duration_text !== "string") {
    add("invalid_duration_text", "error", ["duration_text"], "duration_text must be a string. Use extra.duration_days for a typed duration.", trip.duration_text);
  }
  // Only audit explicit legacy day/night counts when no typed duration is present.
  // Opaque/freeform descriptions stay untouched, and structured values remain authoritative.
  if (extra.duration_days == null && typeof trip.duration_text === "string") {
    for (const match of trip.duration_text.matchAll(/(-?\d+(?:\.\d+)?)\s*(өдөр|хоног|шөнө|days?|nights?)(?!\p{L})/giu)) {
      const value = Number(match[1]);
      const isNight = /шөнө|night/i.test(match[2]);
      if (!Number.isSafeInteger(value) || value < (isNight ? 0 : 1)) {
        add("invalid_legacy_duration", "error", ["duration_text"], `duration_text: "${trip.duration_text}" contains an invalid ${isNight ? "night" : "day"} count. Correct the duration or save a typed duration.`, trip.duration_text);
      }
    }
  }

  for (const key of ["duration_days", "duration_nights"]) {
    const value = extra[key];
    if (value != null && (typeof value !== "number" || !Number.isSafeInteger(value) || value < (key === "duration_days" ? 1 : 0))) {
      add("invalid_structured_duration", "error", [`extra.${key}`], `extra.${key}: enter a ${key === "duration_days" ? "positive" : "non-negative"} whole number or null.`, [key, value]);
    }
  }
  if (typeof extra.duration_days === "number" && typeof extra.duration_nights === "number" && extra.duration_nights >= extra.duration_days) {
    add("conflicting_structured_duration", "error", ["extra.duration_days", "extra.duration_nights"], "Duration nights must be fewer than duration days. Correct the structured duration.", [extra.duration_days, extra.duration_nights]);
  }
  if (extra.transport_type != null && !["direct_flight", "land", "land_flight", "cruise"].includes(String(extra.transport_type))) {
    add("invalid_structured_transport", "error", ["extra.transport_type"], "extra.transport_type: choose direct_flight, land, land_flight, cruise, or null.", extra.transport_type);
  }
  if (extra.destinations != null && (!Array.isArray(extra.destinations) || extra.destinations.some(d => typeof d !== "string" || !d.trim()))) {
    add("invalid_structured_destinations", "error", ["extra.destinations"], "extra.destinations: enter an array of non-empty destination names, or null.", extra.destinations);
  }
  if (trip.departure_dates != null && !Array.isArray(trip.departure_dates)) {
    add("invalid_date_list", "error", ["departure_dates"], "departure_dates must be an array of dates or recurring schedules.", trip.departure_dates);
  }

  function dates(value: unknown, path: string): CalendarDate[] {
    if (typeof value !== "string" || !value.trim()) {
      add("invalid_date", "error", [path], `${path}: enter a date or a recurring schedule.`, value);
      return [];
    }
    const s = value.trim();
    const found: CalendarDate[] = [];
    const push = (year: number | null, month: number, day: number) => {
      if (year !== null && (year < 1900 || year > 2199)) {
        add("invalid_year", "error", [path], `${path}: year ${year} must be a four-digit travel year (1900-2199).`, s);
        return;
      }
      const check = new Date(Date.UTC(year ?? 2000, month - 1, day));
      if (month < 1 || month > 12 || day < 1 || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) {
        add("invalid_date", "error", [path], `${path}: "${s}" contains an impossible calendar date. Correct the month/day.`, s);
        return;
      }
      const date = { year, month, day };
      if (!found.some(d => dateKey(d) === dateKey(date))) found.push(date);
      if (year !== null && check.getTime() < Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) {
        add("past_departure", "warning", [path], `${path}: "${s}" is historical. Confirm its year before publishing.`, s);
      }
    };
    const full = [...s.matchAll(/(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g)];
    if (full.length) {
      for (const m of full) push(Number(m[1]), Number(m[2]), Number(m[3]));
      return found;
    }
    if (/^\d{3,5}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(s)) {
      add("invalid_year", "error", [path], `${path}: "${s}" needs a four-digit year.`, s);
      return found;
    }
    const mn = [...s.matchAll(/(\d{1,2})\s*(?:-?р\s*)?сарын\s*/gi)];
    if (mn.length) {
      const explicitYear = s.match(/(?<!\d)(\d{4})\s*(?:он(?:ы)?|year)/i);
      for (let i = 0; i < mn.length; i++) {
        const tail = s.slice((mn[i].index || 0) + mn[i][0].length, mn[i + 1]?.index ?? s.length).trim();
        const range = tail.match(/^(\d{1,2})\s*[-\u2013\u2014]\s*(\d{1,2})(?!\d)/);
        const dayList = tail.match(/^\d{1,2}(?:\s*[,\u060c]\s*\d{1,2})*/)?.[0];
        if (!dayList) {
          add("unrecognized_date", "warning", [path], `${path}: "${s}" could not be fully audited. Confirm the schedule.`, s);
          continue;
        }
        const days = range ? Array.from({ length: Math.max(0, Number(range[2]) - Number(range[1]) + 1) }, (_, n) => n + Number(range[1])) : dayList.split(/[,\u060c]/).map(Number);
        if (!days.length) add("invalid_date", "error", [path], `${path}: "${s}" has a reversed date range.`, s);
        for (const day of days) push(explicitYear ? Number(explicitYear[1]) : null, Number(mn[i][1]), day);
      }
      return found;
    }
    const bare = s.match(/^(\d{1,2})\s*[-/.]\s*(\d{1,2})$/);
    if (bare) push(null, Number(bare[1]), Number(bare[2]));
    else if (/^\d+(?:[-/.]\d+){1,2}$/.test(s)) {
      add("invalid_date", "error", [path], `${path}: "${s}" is not a valid calendar date. Use YYYY-MM-DD or month/day.`, s);
    } else if (!/гар(?:а|и)г|даваа|мягмар|лхагва|пүрэв|баасан|бямба|ням|бүр|болгон|тутам|every|daily|weekly|flexible|групп.*бүрд/i.test(s)) {
      add("unrecognized_date", "warning", [path], `${path}: "${s}" could not be audited. Confirm the date or schedule.`, s);
    }
    return found;
  }

  function checkAges(entries: Array<{ band: AgeBand | null; path: string; label: string }>, scope: unknown) {
    for (const entry of entries) {
      if (entry.band && (entry.band.basis === "months" ? entry.band.min >= entry.band.max : entry.band.min > entry.band.max)) {
        add("invalid_age_range", "error", [entry.path], `${entry.path}: age range is reversed. Correct its lower and upper bounds.`, [scope, entry.label, entry.band]);
      }
    }
    for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i], b = entries[j];
      if (!a.band || !b.band || !overlap(a.band, b.band)) continue;
      // Repeated compatibility tiers represent one category, not two categories.
      if (bandKey(a.band) === bandKey(b.band) && a.label === b.label) continue;
      const boundary = sharedAgeBoundary(a.band, b.band);
      add("overlapping_age_categories", boundary ? "warning" : "error", [a.path, b.path], boundary
        ? `${a.path} and ${b.path}: age categories share an endpoint. Staff must confirm whether the upper age is inclusive; no boundary was guessed.`
        : `${a.path} and ${b.path}: passenger age categories overlap. Use non-overlapping age bands.`,
        [scope, [JSON.stringify([a.label, a.band]), JSON.stringify([b.label, b.band])].sort()]);
    }
  }

  list(trip.departure_dates).forEach((d, i) => dates(d, `departure_dates[${i}]`));
  rows(extra.departure_dates_resolved).forEach((row, i) => {
    if (row.ymd == null) return;
    const frozen = dates(row.ymd, `extra.departure_dates_resolved[${i}].ymd`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text(row.ymd))) {
      add("invalid_resolved_date", "error", [`extra.departure_dates_resolved[${i}].ymd`], "Resolved dates must use YYYY-MM-DD or null.", row.ymd);
    }
    const original = text(row.text) ? dates(row.text, `extra.departure_dates_resolved[${i}].text`) : [];
    if (frozen.length && original.length && !original.some(d => sameDate(d, frozen[0]))) {
      add("resolved_date_mismatch", "error", [`extra.departure_dates_resolved[${i}]`], `Resolved date ${String(row.ymd)} disagrees with "${text(row.text)}". Correct the frozen date or departure text.`, [row.text, row.ymd]);
    }
  });

  function seats(row: Row, path: string, totalKey: string, leftKey: string, statusKey: string, statuses: Set<string>, soldOut: string, identity = path) {
    for (const key of [totalKey, leftKey]) {
      const value = row[key];
      if (value != null && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) {
        add("invalid_seat_count", "error", [`${path}${key}`], `${path}${key}: enter a non-negative whole number or null.`, [identity, key, value]);
      }
    }
    const total = row[totalKey], left = row[leftKey], status = row[statusKey];
    if (typeof total === "number" && typeof left === "number" && left > total) {
      add("seats_exceed_total", "error", [`${path}${leftKey}`, `${path}${totalKey}`], `${path}${leftKey} (${left}) exceeds ${totalKey} (${total}). Correct the seat counts.`, [identity, total, left]);
    }
    if (status != null && !statuses.has(String(status))) {
      add("invalid_seat_status", "error", [`${path}${statusKey}`], `${path}${statusKey}: choose ${[...statuses].join(", ")}.`, [identity, status]);
    }
    if (status === soldOut && typeof left === "number" && left > 0) {
      add("sold_out_with_seats", "error", [`${path}${statusKey}`, `${path}${leftKey}`], `${path}${statusKey} is sold out but ${left} seats remain. Correct the status or seats.`, [identity, status, left]);
    }
    if ((status === "active" || status === "OPEN") && left === 0) {
      add("open_without_seats", "warning", [`${path}${statusKey}`, `${path}${leftKey}`], `${path}${statusKey} has zero seats remaining. Confirm availability.`, [identity, status]);
    }
  }
  seats(trip as Row, "", "seats_total", "seats_left", "status", TRIP_STATUSES, "sold_out");
  rows(extra.website_departure_availability).forEach((row, i) => {
    const path = `extra.website_departure_availability[${i}].`;
    dates(row.date, `${path}date`);
    seats(row, path, "seatsTotal", "seatsLeft", "status", DEPARTURE_STATUSES, "SOLD_OUT", `departure:${text(row.date)}`);
  });

  const ageRules = record(extra.age_rules);
  checkAges(["infant", "child", "adult"].map(label => ({ label, band: ageBand(ageRules[label]), path: `extra.age_rules.${label}` })), "age_rules");

  // price_groups is authoritative; departure_date_groups is its legacy mirror.
  const groupKey = list(extra.price_groups).length ? "price_groups" : "departure_date_groups";
  const groups: Group[] = rows(extra[groupKey]).map((row, i) => {
    const path = `extra.${groupKey}[${i}]`;
    // Generated date_keys are aliases. Never let a yearless alias erase an explicit year.
    const rawDates = list(row.dates).length ? list(row.dates) : list(row.display_dates).length ? list(row.display_dates) : list(row.date_keys);
    const parsedDates = rawDates.flatMap((d, j) => {
      const parsed = dates(d, `${path}.dates[${j}]`);
      if (row.year != null) {
        if (typeof row.year !== "number" || !Number.isInteger(row.year) || row.year < 1900 || row.year > 2199) {
          add("invalid_year", "error", [`${path}.year`], `${path}.year must be a whole year between 1900 and 2199.`, row.year);
        } else return parsed.flatMap(date => {
          if (date.year !== null && date.year !== row.year) {
            add("conflicting_departure_year", "error", [`${path}.year`, `${path}.dates[${j}]`], `${path}: explicit departure year disagrees with year ${row.year}. Correct the year or date.`, [row.year, dateKey(date)]);
          }
          return dates(`${row.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`, `${path}.dates[${j}]`);
        });
      }
      const frozen = rows(extra.departure_dates_resolved).find(r => text(r.text) === text(d) && r.ymd != null);
      return frozen && parsed.every(date => date.year === null) ? dates(frozen.ymd, `${path}.dates[${j}]`) : parsed;
    });
    const groupDates = parsedDates.filter(d => d.year !== null || !parsedDates.some(other => other.year !== null && sameDate(d, other)));
    const hotel = text(row.hotel_id) ? `id:${text(row.hotel_id)}` : norm(row.hotel || trip.hotel);
    const packageId = text(row.package_id);
    const scope = [hotel, packageId, [...new Set(groupDates.map(dateKey))].sort()];
    const currency = text(row.currency || trip.currency).toUpperCase() || "MNT";
    const fares: Fare[] = [];
    const passengers = rows(row.passenger_prices);
    const addFare = (key: string, price: unknown, band: AgeBand | null, path: string, fareCurrency = currency, maxPrice?: unknown) => {
      const n = amount(price);
      if (n !== null) fares.push({ scope: key, band, price: n, max: amount(maxPrice) ?? n, path, currency: fareCurrency });
    };
    const adultRange = record(row.adult_price_range);
    addFare("adult", adultRange.min ?? row.adult_price, null, `${path}.adult_price`, currency, adultRange.max);
    addFare("single", row.single_price, null, `${path}.single_price`);
    for (const category of ["child", "infant"]) {
      const band = ageBand(row[`${category}_age`]);
      // The scalar child/infant price is a compatibility summary of passenger_prices.
      const represented = passengers.some(p => band ? ageBand(p.age_range) && ageBand(p.age_range)!.basis === band.basis && ageBand(p.age_range)!.min >= band.min && ageBand(p.age_range)!.max <= band.max
        : new RegExp(category === "infant" ? "infant|нярай|сар|month" : "child|хүүхэд", "i").test(text(p.label)));
      if (!represented) addFare(category, row[`${category}_price`], band, `${path}.${category}_price`);
    }
    passengers.forEach((p, j) => {
      const band = ageBand(p.age_range);
      addFare(band ? `age:${bandKey(band)}` : norm(p.label), p.price, band, `${path}.passenger_prices[${j}].price`, text(p.currency).toUpperCase() || currency);
    });
    const ageEntries = passengers.length ? passengers.map((p, j) => ({ band: ageBand(p.age_range), label: norm(p.label), path: `${path}.passenger_prices[${j}].age_range` }))
      : ["child", "infant"].map(label => ({ band: ageBand(row[`${label}_age`]), label, path: `${path}.${label}_age` }));
    checkAges(ageEntries, scope);
    return { path, hotel, packageId, dates: groupDates, fares };
  });

  function compareFares(a: Fare, b: Fare, scope: unknown, checkOverlap = false) {
    if (checkOverlap && a.band && b.band && bandKey(a.band) !== bandKey(b.band) && overlap(a.band, b.band)) {
      const boundary = sharedAgeBoundary(a.band, b.band);
      add("overlapping_age_categories", boundary ? "warning" : "error", [a.path, b.path], boundary
        ? `${a.path} and ${b.path}: age categories share an endpoint for the same offer. Staff must confirm inclusive/exclusive boundaries.`
        : `${a.path} and ${b.path}: passenger age bands overlap for the same hotel and departure. Correct the category boundaries.`, [scope, [bandKey(a.band), bandKey(b.band)].sort()]);
      return;
    }
    const matchingPassenger = a.band && b.band ? bandKey(a.band) === bandKey(b.band) : a.scope === b.scope;
    if (!matchingPassenger || a.currency !== b.currency || a.price === b.price && a.max === b.max) return;
    const intersects = Math.max(a.price, b.price) <= Math.min(a.max, b.max);
    add("conflicting_price_groups", intersects ? "warning" : "error", [a.path, b.path],
      `${a.path} and ${b.path}: different fares (${a.price}${a.max !== a.price ? `-${a.max}` : ""} / ${b.price}${b.max !== b.price ? `-${b.max}` : ""} ${a.currency}) for the same hotel, departure and passenger category. Correct the fare or distinguish the offer.`,
      [scope, a.band ? bandKey(a.band) : a.scope, a.currency, [`${a.price}:${a.max}`, `${b.price}:${b.max}`].sort()]);
  }
  for (const group of groups) {
    for (let i = 0; i < group.fares.length; i++) for (let j = i + 1; j < group.fares.length; j++) compareFares(group.fares[i], group.fares[j], [group.hotel, group.packageId, group.dates.map(dateKey).sort()]);
  }
  for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
    const a = groups[i], b = groups[j];
    if (a.hotel !== b.hotel || a.packageId !== b.packageId) continue;
    const shared = a.dates.flatMap(d => b.dates.filter(other => sameDate(d, other)).map(other => d.year === null ? other : d));
    if (!shared.length) {
      if (!a.dates.length || !b.dates.length) add("ambiguous_price_scope", "warning", [a.path, b.path], `${a.path} / ${b.path}: missing concrete departure scope. Confirm which dates each fare applies to.`, [a.hotel, a.fares.map(f => [f.scope, f.price]), b.fares.map(f => [f.scope, f.price])]);
      continue;
    }
    for (const date of shared) for (const af of a.fares) for (const bf of b.fares) compareFares(af, bf, [a.hotel, a.packageId, dateKey(date)], true);
  }
  // Trip-wide child_rules often repeat date-specific fares; do not compare their prices.
  for (const key of ["child_rules", "child_price_rules"]) {
    const children = rows(extra[key]);
    const groupPassengers = rows(extra[groupKey]).flatMap(row => rows(row.passenger_prices));
    const ageEntries = children.flatMap((row, i) => {
      const band = ageBand(row.age_range);
      const mirrored = band && groupPassengers.some(p => {
        const other = ageBand(p.age_range);
        return other && bandKey(other) === bandKey(band) && amount(p.price) === amount(row.price);
      });
      return mirrored ? [] : [{ band, label: norm(row.label), path: `extra.${key}[${i}].age_range` }];
    });
    checkAges(ageEntries, key);
    if (!groups.length) {
      for (let i = 0; i < children.length; i++) for (let j = i + 1; j < children.length; j++) {
        const a = children[i], b = children[j], ap = amount(a.price), bp = amount(b.price);
        if (ap === null || bp === null || norm(a.label) !== norm(b.label)) continue;
        compareFares({ scope: norm(a.label), band: ageBand(a.age_range), price: ap, max: ap, currency: text(a.currency || trip.currency).toUpperCase() || "MNT", path: `extra.${key}[${i}].price` },
          { scope: norm(b.label), band: ageBand(b.age_range), price: bp, max: bp, currency: text(b.currency || trip.currency).toUpperCase() || "MNT", path: `extra.${key}[${j}].price` }, key);
      }
    }
  }
  const errors = issues.filter(issue => issue.severity === "error");
  const warnings = issues.filter(issue => issue.severity === "warning");
  return { valid: errors.length === 0, issues, errors, warnings };
}

/** Validate the effective (already merged) record, grandfathering unchanged legacy facts. */
export function validateTripDataChange(effective: TripFactInput, previous?: TripFactInput | null, now = new Date()) {
  const audit = auditTripFacts(effective, now);
  const priorKeys = new Set(previous ? auditTripFacts(previous, now).errors.map(issue => issue.key) : []);
  const introducedErrors = audit.errors.filter(issue => !priorKeys.has(issue.key));
  return { ...audit, valid: introducedErrors.length === 0, introducedErrors };
}

export class TripDataValidationError extends Error {
  readonly code = "trip_data_conflict";
  readonly statusCode = 422;
  constructor(readonly issues: TripFactIssue[]) {
    super(issues.map(issue => issue.message).join(" "));
    this.name = "TripDataValidationError";
  }
  toResponse() {
    return { error: this.message, code: this.code, message: this.message, issues: this.issues };
  }
}

export function assertValidTripDataChange(effective: TripFactInput, previous?: TripFactInput | null) {
  const result = validateTripDataChange(effective, previous);
  if (!result.valid) throw new TripDataValidationError(result.introducedErrors);
  return result;
}

export function auditTripCatalog(trips: TripFactInput[], now = new Date()) {
  const results = trips.map(trip => ({ id: text(trip.id), route_name: text(trip.route_name), ...auditTripFacts(trip, now) }));
  return {
    total: results.length,
    tripsWithErrors: results.filter(result => result.errors.length).length,
    tripsWithWarnings: results.filter(result => result.warnings.length).length,
    results,
  };
}
