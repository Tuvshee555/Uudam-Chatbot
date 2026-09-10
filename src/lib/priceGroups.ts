import type { ChildRule, PassengerPrice, PriceGroup } from "./adminTypes";
import { isInfantShapedAge } from "./travelFastPathsSearch";

/**
 * child_rules used to be a THIRD place staff could type in a child/infant
 * price — alongside price_groups[].{child,infant}_price and each group's own
 * passenger_prices — and it silently drifted from the other two on real
 * trips (confirmed against live data: every non-empty child_rules list was
 * meant to be exactly the deduped union of every group's passenger_prices,
 * but several had gone stale — extra or missing entries). Deriving it here
 * removes the drift entirely: whoever prices a date group is the only edit
 * that matters, and this mirrors the same dedup poster/tripMapper.ts already
 * does when mapping a POSTER's price table onto a trip.
 */
export function deriveChildRules(
  groups: readonly PriceGroup[],
  // Trip-level "this passenger type is free" — declared on the base price
  // (no date-specific groups needed yet), independent of any price group.
  // Only synthesized when nothing in the groups themselves already prices
  // that type, so a real per-date band always wins over the blanket flag.
  baseFree: { child?: boolean; infant?: boolean } = {},
): ChildRule[] {
  const passengerPrices: PassengerPrice[] = groups.flatMap((group) => group.passenger_prices ?? []);
  const seen = new Set<string>();
  const rules: ChildRule[] = [];
  for (const price of passengerPrices) {
    if (price.price == null) continue;
    const key = `${price.label}|${price.age_range}|${price.price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push({ label: price.label, age_range: price.age_range, price: price.price, currency: price.currency, note: price.note || "" });
  }
  const hasBand = (target: "child" | "infant") =>
    passengerPrices.some((p) => p.price != null && isInfantShapedAge(p.label.toLowerCase(), p.age_range) === (target === "infant"));
  if (baseFree.infant && !hasBand("infant")) {
    rules.push({ label: "Нярай", age_range: "", price: 0, currency: "MNT", note: "Үнэгүй" });
  }
  if (baseFree.child && !hasBand("child")) {
    rules.push({ label: "Хүүхэд", age_range: "", price: 0, currency: "MNT", note: "Үнэгүй" });
  }
  return rules;
}

/**
 * travelFastPathsPricing.ts reads a group's child/infant price straight off
 * group.child_price / group.infant_price (plus the matching *_age) — flat
 * fields, not the passenger_prices list. Those flat fields are legacy from
 * before passenger_prices existed and are no longer editable directly (see
 * the editor: passenger_prices is now the only place a child/infant band is
 * entered), so backfill them here from the first child-shaped and first
 * infant-shaped band before saving, keeping every reader fed without
 * resurrecting the duplicate-editing UI that caused them to drift.
 */
export function withDerivedSummaryFields(group: PriceGroup): PriceGroup {
  const bands = group.passenger_prices ?? [];
  const infant = bands.find((p) => p.price != null && isInfantShapedAge(p.label.toLowerCase(), p.age_range));
  const child = bands.find((p) => p !== infant && p.price != null && !isInfantShapedAge(p.label.toLowerCase(), p.age_range));
  return {
    ...group,
    child_price: child?.price ?? null,
    child_age: child?.age_range || "",
    infant_price: infant?.price ?? null,
    infant_age: infant?.age_range || "",
  };
}
