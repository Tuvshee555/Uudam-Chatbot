import { sameParityValue } from "./tripWebsiteParityValue";

/**
 * Fares a consultant edits per departure date in the website's date-pricing editor.
 *
 * The website and the chatbot store the same price groups in different shapes (the
 * website adds ids, currency, availability and price ranges, and keeps date entries the
 * chatbot dropped), so comparing the two lists whole never matched: from 2026-11-02 every
 * fare saved on the website became an "open conflict" and the next projection showed the
 * old fare again. Fares are compared here one cell at a time — a departure date and its
 * hotel/package option — and only a fare both sides changed is a conflict.
 */
type Row = Record<string, unknown>;
export type FareCellConflict = { field: string; chatbot: unknown; website: unknown; base: unknown };
type Fares = { adult: number | null; child: number | null; infant: number | null };

const FARE_FIELDS = ["adult_price", "adult_price_range", "child_price", "child_age", "infant_price", "infant_age",
  "passenger_prices", "child_price_free", "infant_price_free"] as const;
const WEBSITE_FARE_NAME: Record<keyof Fares, string> = { adult: "price", child: "childPrice", infant: "infantPrice" };
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const record = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const amount = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const isInfantBand = (band: Row) => /нярай|infant|сар|month|\b0\s*[-–]\s*2\b/i.test(`${text(band.label)} ${text(band.age_range)}`);

function groupDates(group: Row): string[] {
  return Array.isArray(group.dates) ? group.dates.map(text).filter((date) => ISO_DATE.test(date)) : [];
}

function option(group: Row): string {
  return [text(group.hotel), text(group.package_id)].join("|");
}

function fares(group: Row): Fares {
  const bands = Array.isArray(group.passenger_prices) ? group.passenger_prices.map(record) : [];
  const child = bands.find((band) => !isInfantBand(band));
  const infant = bands.find(isInfantBand);
  return {
    adult: amount(group.adult_price),
    child: child ? amount(child.price) : amount(group.child_price),
    infant: infant ? amount(infant.price) : amount(group.infant_price),
  };
}

/** One entry per (date, option); a cell two groups both claim is ambiguous and never merged. */
function cells(groups: unknown): Map<string, { date: string; option: string; group: Row; index: number; ambiguous: boolean }> {
  const map = new Map<string, { date: string; option: string; group: Row; index: number; ambiguous: boolean }>();
  (Array.isArray(groups) ? groups : []).map(record).forEach((group, index) => {
    for (const date of groupDates(group)) {
      const key = `${date}#${option(group)}`;
      const existing = map.get(key);
      if (existing) existing.ambiguous = true;
      else map.set(key, { date, option: option(group), group, index, ambiguous: false });
    }
  });
  return map;
}

/** Date keys that name this date ("2026-11-17", "11 сарын 17", "11/17"). */
function keysForDate(keys: unknown, date: string): string[] {
  const [, month, day] = date.split("-").map(Number);
  const forms = new Set([date, `${month} сарын ${day}`, `${month}/${day}`]);
  return (Array.isArray(keys) ? keys.map(text) : []).filter((key) => forms.has(key));
}

function fareFields(group: Row): Row {
  return Object.fromEntries(FARE_FIELDS.filter((key) => Object.prototype.hasOwnProperty.call(group, key)).map((key) => [key, group[key]]));
}

export type DateFareMerge = {
  /** The canonical groups with the website's fares applied; null when no fare changed. */
  groups: Row[] | null;
  conflicts: FareCellConflict[];
  /** Dates whose fares this save edited, applied or not (departure rows need no second look). */
  dates: Set<string>;
};

/**
 * Three-way merge of the website's per-date fares into the canonical price groups.
 * `liveDates` are the trip's departures after this save: a fare for a date that is not
 * one (the website keeps old entries the chatbot removed) never creates a group.
 */
export function mergeWebsiteDateFares(canonicalGroups: unknown, baseGroups: unknown, websiteGroups: unknown, liveDates: ReadonlySet<string>): DateFareMerge {
  const canonical = cells(canonicalGroups);
  const base = cells(baseGroups);
  const website = cells(websiteGroups);
  const groups = (Array.isArray(canonicalGroups) ? canonicalGroups : []).map((group) => ({ ...record(group) }));
  const conflicts: FareCellConflict[] = [];
  const dates = new Set<string>();
  let changed = false;

  for (const [key, cell] of website) {
    const before = base.get(key);
    const typed = fares(cell.group);
    const saved = before ? fares(before.group) : null;
    if (saved && sameParityValue(typed, saved)) continue;
    dates.add(cell.date);
    const current = canonical.get(key);
    const kinds = (Object.keys(typed) as Array<keyof Fares>).filter((kind) => !saved || typed[kind] !== saved[kind]);
    if (current && !current.ambiguous && !cell.ambiguous) {
      const now = fares(current.group);
      if (kinds.every((kind) => now[kind] === typed[kind])) continue;
      const clash = kinds.filter((kind) => now[kind] !== typed[kind] && (!saved || now[kind] !== saved[kind]));
      if (clash.length) {
        // The cell stays as it is, so every fare of it this save changed is shown, not only the clash.
        for (const kind of kinds.filter((fare) => now[fare] !== typed[fare])) {
          conflicts.push({ field: `departure.${cell.date}.${WEBSITE_FARE_NAME[kind]}`, chatbot: now[kind], website: typed[kind], base: saved ? saved[kind] : null });
        }
        continue;
      }
      // Only this date takes the fare: a group shared with other dates is split first.
      const target = groups[current.index];
      if (groupDates(target).length > 1) {
        const dateKeys = keysForDate(target.date_keys, cell.date);
        groups[current.index] = { ...target, dates: groupDates(target).filter((date) => date !== cell.date),
          ...(Array.isArray(target.date_keys) ? { date_keys: (target.date_keys as unknown[]).filter((item) => !dateKeys.includes(text(item))) } : {}) };
        groups.push({ ...target, dates: [cell.date], ...(Array.isArray(target.date_keys) ? { date_keys: dateKeys.length ? dateKeys : [cell.date] } : {}),
          ...fareFields(cell.group) });
      } else {
        groups[current.index] = { ...target, ...fareFields(cell.group) };
      }
      changed = true;
      continue;
    }
    if (!current && !cell.ambiguous && liveDates.has(cell.date) && ![...canonical.values()].some((entry) => entry.date === cell.date)) {
      // A departure the chatbot has no per-date fare for: nothing on its side to overwrite.
      const { id: _id, availability: _availability, ...copy } = cell.group;
      groups.push({ ...copy, dates: [cell.date], date_keys: keysForDate(copy.date_keys, cell.date).length ? keysForDate(copy.date_keys, cell.date) : [cell.date] });
      changed = true;
      continue;
    }
    if (!liveDates.has(cell.date) && !current) continue;
    // Hotel/package options the two sides list differently: the owner decides.
    for (const kind of kinds) {
      conflicts.push({ field: `departure.${cell.date}.${WEBSITE_FARE_NAME[kind]}`,
        chatbot: [...canonical.values()].filter((entry) => entry.date === cell.date).map((entry) => ({ label: text(entry.group.label) || text(entry.group.hotel) || "Үнэ", [`${kind}_price`]: fares(entry.group)[kind] })),
        website: typed[kind], base: saved ? saved[kind] : null });
    }
  }
  return { groups: changed ? groups : null, conflicts, dates };
}
