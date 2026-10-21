const BUSINESS_DAY_OFFSET_MS = 8 * 60 * 60 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})?$/;

function validCalendarDay(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Match the website's business day for both SQL rows and serialized API dates. */
export function websiteDepartureDateKey(value: unknown): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return "";
    value = value.toISOString();
  }
  if (typeof value !== "string") return "";
  const raw = value.trim();
  if (DATE_ONLY.test(raw)) return validCalendarDay(raw) ? raw : "";
  const timestamp = TIMESTAMP.exec(raw);
  if (!timestamp || !validCalendarDay(timestamp[1]) || Number(timestamp[2]) > 23
    || Number(timestamp[3]) > 59 || Number(timestamp[4]) > 59) return "";
  // The database's zone-less timestamp is the same UTC instant Prisma sends
  // with Z. Never let the machine's timezone decide the departure day.
  const instant = Date.parse(raw.replace(" ", "T") + (timestamp[5] ? "" : "Z"));
  if (!Number.isFinite(instant)) return "";
  const date = new Date(instant + BUSINESS_DAY_OFFSET_MS).toISOString().slice(0, 10);
  return DATE_ONLY.test(date) ? date : "";
}
