/**
 * One price change, applied everywhere the trip quotes that fare.
 *
 * A trip's fares live in three places that must agree: the base columns
 * (adult/child/infant), every dated price row in extra.price_groups (the website's
 * per-date fares and the bot's quotes come from these), and each row's passenger
 * tiers. "Том хүн 4,290,000" typed into the assistant used to patch only the base
 * column, so the website kept selling every date at the old price. This helper
 * writes all three, and says plainly when it could not decide (two child age tiers
 * on one row cannot share one new child price).
 *
 * Owner's rules kept here: a free (0) fare stays free when every fare is shifted
 * ("+100k" never prices an infant), and a relative child price ("300k low") is the
 * adult fare after the change minus that amount.
 */
import type { PassengerPrice, PriceGroup } from "./adminTypes";
import { deriveChildRules, withDerivedSummaryFields } from "./priceGroups";
import { isInfantShapedAge } from "./travelFastPathsSearch";
import type { TravelTrip, TripMutationFields } from "./travelTypes";

export type FareKind = "adult" | "child" | "infant";

/** What one fare should become: an exact amount, a shift, or a gap below the adult fare. */
export type FareIntent = { set?: number; delta?: number; belowAdult?: number };

export type FareChange = {
  adult?: FareIntent;
  child?: FareIntent;
  infant?: FareIntent;
  /** Shift every priced fare (base and dated rows) by this amount; free fares stay free. */
  everyone?: number;
};

export type FareChangeResult = {
  fields: TripMutationFields;
  /** "том хүн 4,190,000₮ → 4,290,000₮", one per fare that changes. */
  lines: string[];
  /** Things the admin should know (a row with several child tiers left for the editor). */
  notes: string[];
  /** Fares the change needs a current value for but the trip does not have one. */
  missing: FareKind[];
  changed: boolean;
};

export const FARE_WORDS: Record<FareKind, string> = { adult: "том хүн", child: "хүүхэд", infant: "нярай" };

export function formatMnt(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${value.toLocaleString("en-US")}₮`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isInfantTier(tier: Partial<PassengerPrice>): boolean {
  return isInfantShapedAge(String(tier.label || "").toLowerCase(), String(tier.age_range || ""));
}

function wanted(current: number | null, intent: FareIntent | undefined, everyone: number | undefined, adultAfter: number | null): number | null | "missing" {
  if (intent?.set != null) return intent.set;
  if (intent?.belowAdult != null) return adultAfter == null ? "missing" : Math.max(0, adultAfter - intent.belowAdult);
  const delta = (intent?.delta ?? 0) + (everyone ?? 0);
  if (!delta) return current;
  if (current == null) return intent?.delta != null ? "missing" : null;
  // A documented free fare stays free under a blanket shift (owner, 2026-10-31).
  if (current === 0 && intent?.delta == null) return 0;
  return Math.max(0, current + delta);
}

/**
 * The patch that brings every fare of `trip` to what `change` asks, with the sentences
 * the proposal shows. Nothing is written here; the caller saves `fields` through patchTrip.
 */
export function applyFareChange(trip: TravelTrip, change: FareChange): FareChangeResult {
  const lines: string[] = [];
  const notes: string[] = [];
  const missing: FareKind[] = [];
  const fields: TripMutationFields = {};

  const adultAfter = wanted(trip.adult_price, change.adult, change.everyone, null);
  const adultNext = adultAfter === "missing" ? null : adultAfter;
  if (adultAfter === "missing") missing.push("adult");
  const childAfter = wanted(trip.child_price, change.child, change.everyone, adultNext ?? trip.adult_price);
  if (childAfter === "missing") missing.push("child");
  const infantAfter = wanted(trip.infant_price, change.infant, change.everyone, adultNext ?? trip.adult_price);
  if (infantAfter === "missing") missing.push("infant");

  const targets: Partial<Record<FareKind, number | null>> = {};
  const consider = (kind: FareKind, current: number | null, next: number | null | "missing") => {
    if (next === "missing" || next === current) return;
    targets[kind] = next;
    lines.push(`${FARE_WORDS[kind]} ${formatMnt(current)} → ${formatMnt(next)}`);
  };
  consider("adult", trip.adult_price, adultAfter);
  consider("child", trip.child_price, childAfter);
  consider("infant", trip.infant_price, infantAfter);
  if ("adult" in targets) fields.adult_price = targets.adult ?? null;
  if ("child" in targets) fields.child_price = targets.child ?? null;
  if ("infant" in targets) fields.infant_price = targets.infant ?? null;

  // The dated rows: an exact amount applies to every date (the admin named one price for
  // the trip); a shift moves each row by the same amount, so seasonal differences stay.
  const groups = Array.isArray(trip.extra?.price_groups) ? (trip.extra.price_groups as unknown[]).map(record) : [];
  const rowDelta = (kind: FareKind): number => (change[kind]?.delta ?? 0) + (change.everyone ?? 0);
  const rowValue = (kind: FareKind, current: unknown, rowAdultAfter: number | null): number | null | undefined => {
    const intent = change[kind];
    if (intent?.set != null) return intent.set;
    if (intent?.belowAdult != null) return rowAdultAfter == null ? undefined : Math.max(0, rowAdultAfter - intent.belowAdult);
    const delta = rowDelta(kind);
    if (!delta || typeof current !== "number") return undefined;
    if (current === 0 && intent?.delta == null) return undefined;
    return Math.max(0, current + delta);
  };
  let groupsChanged = false;
  const nextGroups = groups.map((group) => {
    const next: Record<string, unknown> = { ...group };
    const adultValue = rowValue("adult", group.adult_price, null);
    const rowAdultAfter = adultValue ?? (typeof group.adult_price === "number" ? group.adult_price : adultNext);
    if (adultValue !== undefined && adultValue !== group.adult_price) {
      next.adult_price = adultValue;
      if (change.adult?.set != null) next.adult_price_range = null;
      groupsChanged = true;
    }
    const tiers = Array.isArray(group.passenger_prices) ? (group.passenger_prices as unknown[]).map((tier) => ({ ...record(tier) })) : [];
    const childTiers = tiers.filter((tier) => typeof tier.price === "number" && !isInfantTier(tier as Partial<PassengerPrice>));
    const infantTiers = tiers.filter((tier) => typeof tier.price === "number" && isInfantTier(tier as Partial<PassengerPrice>));
    const setTier = (tier: Record<string, unknown>, kind: FareKind) => {
      const value = rowValue(kind, tier.price, rowAdultAfter);
      if (value === undefined || value === tier.price) return;
      tier.price = value;
      if (value === 0) tier.note = "Үнэгүй"; else if (tier.note === "Үнэгүй") delete tier.note;
      groupsChanged = true;
    };
    if (change.child?.set != null || change.child?.belowAdult != null) {
      if (childTiers.length > 1) {
        const names = childTiers.map((tier) => `«${String(tier.label || "Хүүхэд")}${tier.age_range ? ` ${tier.age_range}` : ""}»`).join(", ");
        const note = `${String(group.label || "Үнийн мөр")}: хүүхдийн ${childTiers.length} насны ангилал (${names}) байгаа тул тус бүрийн үнийг «Аяллууд» хэсгээс засна.`;
        if (!notes.includes(note)) notes.push(note);
      } else {
        for (const tier of childTiers) setTier(tier, "child");
      }
    } else {
      for (const tier of childTiers) setTier(tier, "child");
    }
    for (const tier of infantTiers) setTier(tier, "infant");
    if (!tiers.length) {
      const childValue = rowValue("child", group.child_price, rowAdultAfter);
      if (childValue !== undefined && childValue !== group.child_price) { next.child_price = childValue; groupsChanged = true; }
      const infantValue = rowValue("infant", group.infant_price, rowAdultAfter);
      if (infantValue !== undefined && infantValue !== group.infant_price) { next.infant_price = infantValue; groupsChanged = true; }
      return next;
    }
    next.passenger_prices = tiers;
    return withDerivedSummaryFields(next as unknown as PriceGroup) as unknown as Record<string, unknown>;
  });
  if (groupsChanged) {
    fields.extra = {
      price_groups: nextGroups,
      child_rules: deriveChildRules(nextGroups as unknown as PriceGroup[], {
        child: (fields.child_price ?? trip.child_price) === 0,
        infant: (fields.infant_price ?? trip.infant_price) === 0,
      }),
    };
    if (groups.length > 1 && Object.values(change).some((intent) => intent && typeof intent === "object" && (intent as FareIntent).set != null)) {
      notes.push(`Шинэ үнэ ${groups.length} үнийн мөр (бүх огноо) дээр бүгдэд нь тавигдана.`);
    }
  }

  return { fields, lines, notes, missing, changed: Object.keys(fields).length > 0 };
}
