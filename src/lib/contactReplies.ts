/**
 * The Facebook page's own buttons — "Холбоо барих дугаар 😊" and "Манай хаяг 😊"
 * — are the most common first message. Left to the model they got a different
 * answer every time, often without the number, and an office address the
 * model made up (2026-10-06..09). Both now come straight from the admin's
 * contact settings (`extra.contact_phones`, `extra.office_address`).
 *
 * The same questions typed by hand ("Оффис хаана байдаг вэ", "utasnii dugaar
 * ugch uu", "ta nar haana bairladag ve") went to the model, which has no
 * address in its context and said REFER: the customer heard nothing (dev
 * evaluation 2026-11-02). They are read here too, in both scripts. A message
 * with a digit is never one of these: it is a customer leaving THEIR number.
 */

export type ContactSettings = { phones: string; address: string };

const WHO = String.raw`(?:(?:та\s*нар(?:ын)?|танай|манай|оффис(?:ын)?|офис(?:ын)?|компани(?:йн)?|ta\s*nar(?:iin)?|tanai|manai|of+is(?:iin)?|kompani(?:in)?)\s+)*`;
const TAIL = String.raw`(?:\s+(?:нь|ni|хаана|haana|хэд\s*вэ|хэд|вэ|бэ|уу|юу|бий\s*юу|байна\s*уу|бна\s*уу|бну|өгөөч|өгч\s*уу|өгнө\s*үү|өгөөрэй|явуулаач|явуулна\s*уу|хэлээч|хэлээрэй|hed\s*ve|hed|ve|be|uu|yu|bii\s*yu|bna\s*uu|bnu|ugch\s*uu|ugooch|uguuch|ugnu|ugooroi|yavuulaach|yavuulna\s*uu|heleech|heleerei|please))*`;
const PHONE_REQUEST = new RegExp(
  `^${WHO}(?:холбоо\\s+барих(?:\\s+дугаар(?:аа|ыг)?)?|утас(?:ны)?(?:\\s+дугаар(?:аа|ыг)?)?|дугаар(?:аа|ыг)?\\s+(?:өгөөч|өгч\\s*уу|явуулаач|хэд\\s*вэ|хэлээч)|holboo\\s+barih(?:\\s+dugaar(?:aa|iig)?)?|utas(?:nii|ni)?(?:\\s+dugaar(?:aa|iig)?)?|dugaar(?:aa|iig)?\\s+(?:ugch\\s*uu|ugooch|uguuch|yavuulaach|hed\\s*ve|heleech)|phone(?:\\s+number)?|contact\\s+number)${TAIL}$`,
  "iu",
);
const WHERE = String.raw`(?:хаана\s+(?:байрладаг|байдаг|байгаа|байна|бна|бн)|haana\s+(?:bairladag|baidag|baigaa|baina|bna|bn))`;
const ADDRESS_REQUEST = new RegExp(
  `^${WHO}(?:хаяг(?:аа|ыг)?|hayag(?:aa|iig)?|оффис|офис|of+is|office(?:\\s+address)?|байршил|bairshil|${WHERE}|where\\s+are\\s+you(?:\\s+located)?|(?:your\\s+)?address)(?:\\s+${WHERE})?${TAIL}$`,
  "iu",
);

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
  const plain = bare(text);
  return !/\d/.test(plain) && PHONE_REQUEST.test(plain);
}

export function isAddressRequest(text: string): boolean {
  const plain = bare(text);
  return !/\d/.test(plain) && ADDRESS_REQUEST.test(plain);
}

/** The reply for a contact or address button, or null when it is neither or nothing is set. */
export function buildContactReply(text: string, contact: ContactSettings): string | null {
  const phoneLine = contact.phones ? `📞 ${contact.phones}` : "";
  if (isPhoneRequest(text)) {
    return phoneLine ? `Манай утасны дугаарууд:\n${phoneLine}` : null;
  }
  if (isAddressRequest(text)) {
    if (contact.address) return [`📍 Манай оффис: ${contact.address}`, phoneLine].filter(Boolean).join("\n");
    return null;
  }
  return null;
}

/** The same reply was sent moments ago (a button tapped twice): don't send it again. */
export function isRepeatOfLastReply(previous: { text: string; timestamp: number } | null | undefined, reply: string, now = Date.now()): boolean {
  return Boolean(previous && previous.text === reply && now - previous.timestamp < 120_000);
}
