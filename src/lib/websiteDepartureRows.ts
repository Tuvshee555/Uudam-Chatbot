import { websiteDepartureDateKey } from "./websiteDepartureDate";

type DepartureRow = { startDate?: unknown; status?: unknown };

function terminal(row: DepartureRow): boolean {
  return ["CANCELLED", "DEPARTED"].includes(String(row.status ?? "").trim().toUpperCase());
}

/** Keep history only on days without a current departure; preserve conflicting facts. */
export function currentWebsiteDepartureRows<T extends DepartureRow>(rows: T[]): T[] {
  const currentDays = new Set(rows.filter(row => !terminal(row))
    .map(row => websiteDepartureDateKey(row.startDate)).filter(Boolean));
  return rows.filter(row => !terminal(row) || !currentDays.has(websiteDepartureDateKey(row.startDate)));
}
