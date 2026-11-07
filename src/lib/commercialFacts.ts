import type { TravelTrip } from "./travelTypes";
import type { KnowledgeData } from "./businessData";
import { getStructuredDiscounts } from "./travelFastPathsSearch";
import { getImportantNotes } from "./travelFastPathsPricing";

const values = (record: unknown): string[] =>
  record && typeof record === "object" ? Object.values(record as Record<string, unknown>).filter((value): value is string => typeof value === "string") : [];

/**
 * The text a reply may rely on for commercial terms (reply.ts guardInventedCommercialClaims): what
 * the candidate trips themselves say about discounts and special terms, and what the owner entered
 * as special offers, discount policies and FAQ. Section headings are not included, only the rows, so
 * an empty "Discount policies:" list never counts as a policy.
 */
export function commercialFactsText(
  trips: TravelTrip[],
  settings: Partial<Pick<KnowledgeData, "special_offers" | "discount_policies" | "faq">> = {},
): string {
  const parts: string[] = [];
  for (const trip of trips) {
    const extra = (trip.extra || {}) as Record<string, unknown>;
    parts.push(trip.route_name, trip.notes || "", trip.source_description || "", ...getImportantNotes(trip));
    // A structured discount row names no discount word of its own; its presence is the fact.
    if (getStructuredDiscounts(trip).length > 0 || (Array.isArray(extra.discount_groups) && extra.discount_groups.length > 0)) parts.push("хямдрал");
    const badge = extra.marketing_badge as Record<string, unknown> | undefined;
    if (badge?.sale_enabled === true && typeof badge.sale_label === "string") parts.push(badge.sale_label);
  }
  for (const row of settings.special_offers || []) {
    const texts = values(row).filter((value) => value.trim());
    // An entered offer is a promotion by definition, whatever words its fields use.
    if (texts.length) parts.push(...texts, "урамшуулал");
  }
  for (const row of settings.discount_policies || []) {
    const texts = values(row).filter((value) => value.trim());
    // An entered discount policy is a discount by definition, whatever words its fields use.
    if (texts.length) parts.push(...texts, "хямдрал");
  }
  for (const item of settings.faq || []) parts.push(item.question || "", item.answer || "");
  return parts.filter(Boolean).join("\n");
}
