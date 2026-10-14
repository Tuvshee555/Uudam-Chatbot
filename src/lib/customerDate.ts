/**
 * "2026-11-05" → "11 сарын 5", the way staff write a date. A date almost a year or
 * more away keeps its year ("2027 оны 10 сарын 8") so it cannot be read as the
 * nearer one — a copied next-year date once looked like a departure last week.
 * Anything that is not an ISO date is returned unchanged.
 */
export function customerDate(value: string, now = new Date()): string {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!iso) return value;
  const [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  const farAway = Date.UTC(year, month - 1, day) - now.getTime() > 330 * 24 * 60 * 60 * 1000;
  return `${farAway ? `${year} оны ` : ""}${month} сарын ${day}`;
}
