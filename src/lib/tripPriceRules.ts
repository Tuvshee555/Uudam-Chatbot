/**
 * Owner's rule (2026-11-04): a trip's price is only the tugrug amount the customer pays.
 * A partner's price in yuan, any "ланд / лант / газрын үнэ" (land price, even when it is
 * written in tugrug) and a "тооцоо нийлэх үнэ" (the price settled between agencies) is
 * the partner's cost — never a price on a trip, and never copied
 * into its notes, summary or price table. When a file has no tugrug selling price, the
 * admin is asked for it instead. Browser-safe (the admin page builds the price question).
 */

/** The text of the clarification that asks for the price; the server finds the answer by it. */
export const PRICE_QUESTION_MARK = "төгрөгийн үнийг бичнэ үү";
/** conflict_items type for a new trip that has no tugrug price yet. */
export const PRICE_MISSING = "price_missing";
/** Under this no Uudam trip is priced: a smaller "MNT" figure is a yuan amount misread. */
export const MIN_TRIP_PRICE_MNT = 100_000;

/**
 * A partner's cost: a yuan amount, a "ланд / лант / газрын үнэ" (land price) or a
 * "тооцоо нийлэх үнэ" (the net price two agencies settle at). "ланд" counts only as
 * a word of its own — until 2026-11-05 it also matched inside a place name that ends
 * in "-ланд", so a sentence naming such a country was cut out of a new trip's notes.
 */
export const PARTNER_PRICE = /(?<!\p{L})лан[дт](?:ын|ийн)?(?!\p{L})|land\s*price|газрын\s+үнэ|тооцоо\s+нийлэх|юан|¥|\bCNY\b|\byuan\b|\bRMB\b/iu;
// A cancellation fee is a booking term the customer must know, not a trip price.
const BOOKING_TERM = /цуцал|буцаан\s+олгол|хураамж|торгууль|cancel/i;

/** The text without the sentences or lines that quote a partner's yuan or land price. */
export function withoutPartnerPrices(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return typeof value === "string" ? value : "";
  return value
    .split(/\n/)
    .map((line) => line
      .split(/(?<=[.!?])\s+/)
      .filter((sentence) => !PARTNER_PRICE.test(sentence) || BOOKING_TERM.test(sentence))
      .join(" "))
    .filter((line, index, all) => line.trim() || (index > 0 && all[index - 1].trim()))
    .join("\n")
    .trim();
}

/** True for text that quotes a partner's yuan or land price. */
export function mentionsPartnerPrice(value: unknown): boolean {
  return typeof value === "string" && PARTNER_PRICE.test(value) && !BOOKING_TERM.test(value);
}

/**
 * Tugrug amounts in an admin's answer, in order: "3,290,000 / 2,590,000", "3290000",
 * "3.29 сая". Anything under MIN_TRIP_PRICE_MNT is not a trip price and is skipped.
 */
export function parseMntPrices(answer: string): number[] {
  const out: number[] = [];
  for (const match of answer.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:сая|sая|mln|million)|(\d{1,3}(?:[ ,.'’]\d{3})+|\d{5,})/gi)) {
    if (match[1]) out.push(Math.round(Number.parseFloat(match[1].replace(",", ".")) * 1_000_000));
    else if (match[2]) out.push(Number(match[2].replace(/[ ,.'’]/g, "")));
  }
  return out.filter((amount) => Number.isFinite(amount) && amount >= MIN_TRIP_PRICE_MNT && amount <= 200_000_000);
}
