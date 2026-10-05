function normalized(value: unknown): unknown {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value.trim().replace(/\r\n/g, "\n");
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalized(item)]));
  return value;
}
export function sameParityValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalized(a)) === JSON.stringify(normalized(b));
}
