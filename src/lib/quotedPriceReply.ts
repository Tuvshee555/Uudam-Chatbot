/**
 * What the customer is told about a quoted price ("990k", "990 мянга", "1 саяын аялал", a pasted advert
 * price): the rows of the trips that sell an ADULT fare at it, and - when no trip does and the amount
 * was said in round words - the trips at or under it, said to be a budget list.
 *
 * Kept out of travelFastPaths.ts (over its size budget); the matching itself is tripFareBlock.ts
 * (tripsAtPrice / tripsUpToPrice), the parsing is travelFastPathsPricing.ts (extractNormalizedPrice).
 */

import { formatMoney, isGenericConfirmationText } from "./travelFastPathsSearch";
import { highestAdultFare, shortDate, tripsUpToPrice } from "./tripFareBlock";
import type { TravelTrip } from "./travelOps";

/**
 * duration_text is free text an admin/AI-extraction pass can leave as an internal QA sentinel
 * ("... тодорхойгүй, баталгаажуулах шаардлагатай") instead of an actual duration. Never echo that
 * straight to a customer.
 */
export function safeDurationText(durationText: string | null | undefined): string {
  if (!durationText || isGenericConfirmationText(durationText)) return "";
  return durationText;
}

/** "• <trip> — Том хүн — 7 өдөр — гарах: 12/3, 12/10" (a weekly schedule keeps the trip's own text). */
export function quotedPriceRows(matches: Array<{ trip: TravelTrip; label: string; dates: string[]; schedule: string | null }>): string[] {
  return matches.slice(0, 6).map(({ trip, label, dates, schedule }) => {
    const duration = safeDurationText(trip.duration_text);
    const parts = [`• ${trip.route_name}`, label];
    if (duration) parts.push(duration);
    if (dates.length) parts.push(`гарах: ${dates.slice(0, 6).map((date) => shortDate(date)).join(", ")}${dates.length > 6 ? " …" : ""}`);
    else if (schedule) parts.push(`гарах: ${schedule}`);
    return parts.join(" — ");
  });
}

/** Only an amount said in round words reads as a budget; a bare digit string typed like an advert's price does not. */
const ROUND_AMOUNT_RE = /сая|мянга|myanga|mynga|(?<=\d)\s*[кk](?![\p{L}\d])/iu;

/**
 * No trip sells `price` exactly. A round amount ("1 сая", "900k", "990 мянга") is a budget: the trips at
 * or under it, dearest first, with the line saying so. A full digit string typed like an advert's price
 * ("1234567 geed bga yum") is not guessed at, and a number far above any fare (a phone number) is no
 * price: null, and the conversation goes on as before (tests/forensic-regressions.test.ts).
 */
export function budgetReplyForQuotedPrice(text: string, price: number, trips: TravelTrip[], now: Date): string | null {
  if (!ROUND_AMOUNT_RE.test(text)) return null;
  const active = trips.filter((trip) => trip.status === "active");
  if (price > highestAdultFare(active, now) * 1.5) return null;
  const under = tripsUpToPrice(active, price, now);
  if (!under.length) return null;
  // The customer's amount is spoken in words, not as a fare ("1 сая"): it is no trip's price, and a figure
  // with ₮ that is none of the trips' fares is what the reply checker rejects.
  const spoken = price >= 1_000_000 ? `${Number((price / 1_000_000).toFixed(2))} сая` : `${Math.round(price / 1000)} мянга`;
  return [`Таны хэлсэн ${spoken} төгрөгтэй яг таарах аялал олдсонгүй. ${spoken} төгрөг хүртэлх аяллууд:`,
    ...quotedPriceRows(under.map((row) => ({ ...row, label: `${row.label} ${formatMoney(row.amount, "MNT") || row.amount}` }))),
    ...(under.length > 6 ? [`... нийт ${under.length} аялал байна.`] : []),
    "Аль аяллыг нь сонирхож байна вэ?"].join("\n");
}
