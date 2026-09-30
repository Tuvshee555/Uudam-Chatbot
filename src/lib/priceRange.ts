export type PriceRange = {
  min: number;
  max: number;
};

function parsePriceToken(value: string): number | null {
  const digits = value.replace(/[,\.\s]/g, "");
  const parsed = Number(digits);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Accepts the poster's human-friendly range forms: "2,000,000 - 2,300,000₮". */
export function parsePriceRangeText(value: unknown): PriceRange | null {
  if (typeof value !== "string") return null;
  const match = value.match(/(?<!\d)(\d[\d,.\s]*\d|\d)\s*(?:[-–—]|\bto\b|хооронд)\s*(\d[\d,.\s]*\d|\d)(?!\d)/i);
  if (!match) return null;
  const min = parsePriceToken(match[1]);
  const max = parsePriceToken(match[2]);
  if (min == null || max == null || min === max) return null;
  return { min: Math.min(min, max), max: Math.max(min, max) };
}

/** Coerces a stored JSON range without trusting arbitrary objects. */
export function normalizePriceRange(value: unknown): PriceRange | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const min = typeof raw.min === "number" ? raw.min : Number(raw.min);
  const max = typeof raw.max === "number" ? raw.max : Number(raw.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0 || min === max) return null;
  return { min: Math.min(Math.trunc(min), Math.trunc(max)), max: Math.max(Math.trunc(min), Math.trunc(max)) };
}

export function formatPriceRange(value: unknown, currency = "MNT"): string | null {
  const range = normalizePriceRange(value);
  if (!range) return null;
  const suffix = currency === "MNT" ? "₮" : ` ${currency}`;
  return `${range.min.toLocaleString("en-US")}–${range.max.toLocaleString("en-US")}${suffix}`;
}
