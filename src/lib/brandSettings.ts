/**
 * The bot settings as a secondary brand uses them (brand.ts). The settings row is shared with the
 * primary (same company, same answers), so only its words change: the business name, the primary's
 * name and website in every text, and the contacts when this brand has its own (BRAND_CONTACT_PHONES,
 * BRAND_OFFICE_ADDRESS). The primary's settings pass unchanged.
 */
import { brandText, getBrand } from "./brand";
import type { TravelBotSettings } from "./travelTypes";

function brandValue(value: unknown, replacePhones: (text: string) => string): unknown {
  if (typeof value === "string") return replacePhones(brandText(value));
  if (Array.isArray(value)) return value.map((item) => brandValue(item, replacePhones));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, brandValue(item, replacePhones)]));
  }
  return value;
}

export function applyBrandToSettings(settings: TravelBotSettings): TravelBotSettings {
  const brand = getBrand();
  if (brand.isPrimary) return settings;
  const sharedPhones = typeof settings.extra?.contact_phones === "string" ? settings.extra.contact_phones.trim() : "";
  // This brand's own numbers replace the shared list wherever it is written out in full.
  const replacePhones = (text: string) =>
    brand.contactPhones && sharedPhones && text.includes(sharedPhones) ? text.split(sharedPhones).join(brand.contactPhones) : text;
  const branded = brandValue(settings, replacePhones) as TravelBotSettings;
  const extra = { ...branded.extra };
  if (brand.contactPhones) extra.contact_phones = brand.contactPhones;
  if (brand.officeAddress) extra.office_address = brand.officeAddress;
  return { ...branded, business_name: branded.business_name || brand.nameLatin, extra };
}
