/**
 * An infant fare the trip does not give is said as «тодруулж мэдээлэл аваарай», with a
 * «Нярайн үнэ тодруулах» button that reaches staff (the owner, 2026-11-18: infant prices are
 * often unknown — they depend on the day or the seller — so say it plainly beside the other
 * fares instead of leaving the infant out or going silent).
 *
 * - Fare lists (adult and/or child shown) get «• Нярай: тодруулж мэдээлэл аваарай».
 * - "Нярайн үнэ хэд?" with no infant fare gets that line too, not silence.
 * - A documented free infant fare stays «Үнэгүй»; a real price is printed as before.
 * - The button's text is a staff hand-off request (handoffDetection.ts): staff get the lead and
 *   tell the customer. The website shows the same words as a contact button. Pure.
 */

export const INFANT_FARE_ASK = "тодруулж мэдээлэл аваарай";
/** A Messenger quick reply holds at most 20 characters; this is exactly 20. */
export const INFANT_ASK_BUTTON = "Нярайн үнэ тодруулах";

const ASK_LINE = /нярай[^\n]{0,40}?тодруулж мэдээлэл аваарай/iu;

/** The reply carries an infant fare to be asked about. */
export function hasInfantFareAsk(reply: string): boolean {
  return ASK_LINE.test(reply || "");
}

/** The buttons for a reply: the infant button first (the reply's own question), never twice. */
export function withInfantAskButton(reply: string, buttons: readonly string[] = []): string[] {
  const list = buttons.filter(Boolean);
  if (!hasInfantFareAsk(reply) || list.some((button) => button.trim() === INFANT_ASK_BUTTON)) return [...list];
  return [INFANT_ASK_BUTTON, ...list];
}
