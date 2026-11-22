/**
 * A post or page of ours shared into the chat: the long copy of a trip advertisement around the trip's website
 * link, not a question the customer typed beside a link.
 *
 * Live 2026-11-22: a customer shared the page's own post. Its selling words were read as the customer's questions
 * ("ЗАХИАЛГА" as booking terms, "11-р сарын 19" as a month listing) and its three company phone numbers as the
 * customer's phone: a booking lead was written, the reply was held back, and the customer got silence.
 *
 * Light on purpose (the router imports it): the phone rule that uses it lives in webhookMedia.ts (customerPhoneIn).
 */
import { websiteTripLinksInText } from "./bookingWebsite";

export function isSharedTripPost(text: string): boolean {
  const { slugs, textWithoutUrls } = websiteTripLinksInText(text);
  if (!slugs.length) return false;
  const copy = textWithoutUrls.trim();
  return copy.length >= 280 || copy.split(/\n+/).filter((line) => line.trim()).length >= 6;
}
