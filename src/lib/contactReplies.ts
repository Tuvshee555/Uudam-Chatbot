/**
 * The Facebook page's own buttons — "Холбоо барих дугаар 😊" and "Манай хаяг 😊"
 * — are the most common first message. Left to the model they got a different
 * answer every time, often without the number, and an office address the
 * model made up (2026-10-06..09). Both now come straight from the admin's
 * contact settings (`extra.contact_phones`, `extra.office_address`).
 */

export type ContactSettings = { phones: string; address: string };

const PHONE_REQUEST = /^(?:холбоо\s+барих(?:\s+дугаар)?|утасны\s+дугаар(?:\s+(?:өгөөч|хэд\s+вэ))?|утас(?:ны)?\s+хэд\s+вэ|holboo\s+barih(?:\s+dugaar)?|utasnii\s+dugaar|utas\s+hed\s+ve)$/iu;
const ADDRESS_REQUEST = /^(?:манай\s+хаяг|(?:оффис(?:ын)?|та\s*нар(?:ын)?|танай)\s+хаяг(?:\s+хаана\s+вэ)?|хаяг\s+хаана\s+вэ|хаана\s+байрладаг\s+вэ|(?:manai|tanai|offisiin)\s+hayag|hayag\s+haana\s+ve)$/iu;

function bare(text: string): string {
  // Buttons end in an emoji, and some phones send it as a broken "�".
  return text.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

export function contactSettingsOf(extra: unknown): ContactSettings {
  const record = extra && typeof extra === "object" ? extra as Record<string, unknown> : {};
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  return { phones: text(record.contact_phones), address: text(record.office_address) };
}

export function isPhoneRequest(text: string): boolean {
  return PHONE_REQUEST.test(bare(text));
}

export function isAddressRequest(text: string): boolean {
  return ADDRESS_REQUEST.test(bare(text));
}

/** The reply for a contact or address button, or null when it is neither or nothing is set. */
export function buildContactReply(text: string, contact: ContactSettings): string | null {
  const phoneLine = contact.phones ? `📞 ${contact.phones}` : "";
  if (isPhoneRequest(text)) {
    return phoneLine ? `Манай утасны дугаарууд:\n${phoneLine}\n\nТа утасны дугаараа үлдээвэл манай зөвлөх тантай холбогдоно 😊` : null;
  }
  if (isAddressRequest(text)) {
    if (contact.address) return [`📍 Манай оффис: ${contact.address}`, phoneLine].filter(Boolean).join("\n");
    // No address on file: say where to ask instead of letting the model invent one.
    return phoneLine ? `Оффисын хаягийг манай зөвлөхөөс лавлана уу:\n${phoneLine}` : null;
  }
  return null;
}
