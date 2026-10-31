/**
 * Customer-facing labels for reaching a human.
 *
 * A dependency-free leaf module on purpose: both webhookMedia.ts (which
 * detects a tap on this label) and travelFastPaths.ts (which offers it on
 * every quick-reply set) need the exact same string, and neither may import
 * the other without creating a cycle.
 */
export const CONTACT_OPERATOR_LABEL = "Зөвлөхтэй холбогдох";

/**
 * The always-visible Messenger menu item (persistent menu, scripts/messenger-menu.ts): a tap
 * arrives as a postback whose title is this text, and is a hand-off request like the label above.
 */
export const HUMAN_REQUEST_LABEL = "Хүнтэй холбогдох";
export const HUMAN_REQUEST_PAYLOAD = "HUMAN_HANDOFF";

/** A tap on either "reach a person" control (quick reply or menu). */
export function isContactOperatorTap(text: string): boolean {
  const tapped = text.trim();
  return tapped === CONTACT_OPERATOR_LABEL || tapped === HUMAN_REQUEST_LABEL || tapped === HUMAN_REQUEST_PAYLOAD;
}
