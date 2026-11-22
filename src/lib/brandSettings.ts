/**
 * The bot settings as a secondary brand's customers read them (brand.ts). The settings row is shared
 * with the primary (same company, same answers), so only its words change: the primary's name,
 * website and phone numbers become the brand's own (brandText), and the brand's own phone/address
 * replace the shared contacts when it has them (BRAND_CONTACT_PHONES, BRAND_OFFICE_ADDRESS).
 * The primary, and the brand's own admin (which edits the shared row, brandAdminMode.ts), read the
 * settings unchanged.
 */
import { brandText, getBrand, registerPrimaryPhones } from "./brand";
import { inBrandAdminMode } from "./brandAdminMode";
import type { TravelBotSettings } from "./travelTypes";

function brandValue(value: unknown): unknown {
  if (typeof value === "string") return brandText(value);
  if (Array.isArray(value)) return value.map((item) => brandValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, brandValue(item)]));
  }
  return value;
}

export function applyBrandToSettings(settings: TravelBotSettings): TravelBotSettings {
  const brand = getBrand();
  if (brand.isPrimary || inBrandAdminMode()) return settings;
  // The shared list is the primary's numbers, whatever staff have typed there lately.
  const sharedPhones = typeof settings.extra?.contact_phones === "string" ? settings.extra.contact_phones : "";
  if (sharedPhones) registerPrimaryPhones(sharedPhones);
  const branded = brandValue(settings) as TravelBotSettings;
  const extra = { ...branded.extra };
  if (brand.contactPhones) extra.contact_phones = brand.contactPhones;
  if (brand.officeAddress) extra.office_address = brand.officeAddress;
  return { ...branded, business_name: branded.business_name || brand.nameLatin, extra };
}
