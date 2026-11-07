/**
 * The contact block of the catalogue (cover, closing page): the phone numbers staff configured in
 * the admin (settings.extra.contact_phones, read through contactSettingsOf) and the website.
 * At most three phones, always as "7713 6633" (eight digits, grouped 4+4). There is no address:
 * the office address is never printed. Pure; the loader reads the settings.
 */
import { BOOKING_WEBSITE_URL } from "../bookingWebsite";
import type { CatalogueContact } from "./types";

export const MAX_PHONES = 3;

/** Eight-digit Mongolian numbers in free text ("+976 7713-6633, 91172769 / 9911 0000"), formatted 4+4, in order, unique. */
export function parsePhones(source: string | readonly string[] | null | undefined): string[] {
  const input = Array.isArray(source) ? source.join("\n") : String(source ?? "");
  const found: string[] = [];
  for (const match of input.matchAll(/(?<!\d)(?:\+?976[\s-]?)?(\d{4})[\s-]?(\d{4})(?!\d)/g)) {
    const phone = `${match[1]} ${match[2]}`;
    if (!found.includes(phone)) found.push(phone);
  }
  return found.slice(0, MAX_PHONES);
}

/** "https://www.example.mn/x" -> { siteLabel: "example.mn", siteUrl: "https://www.example.mn" }; a bad value falls back to the booking site. */
export function buildContact(phones: string | readonly string[] | null | undefined, siteBaseUrl: string): CatalogueContact {
  let url: URL;
  try {
    url = new URL(siteBaseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("protocol");
  } catch {
    url = new URL(BOOKING_WEBSITE_URL);
  }
  return { phones: parsePhones(phones), siteLabel: url.host.replace(/^www\./, ""), siteUrl: url.origin };
}
