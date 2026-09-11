/**
 * Customer-facing labels for reaching a human.
 *
 * A dependency-free leaf module on purpose: both webhookMedia.ts (which
 * detects a tap on this label) and travelFastPaths.ts (which offers it on
 * every quick-reply set) need the exact same string, and neither may import
 * the other without creating a cycle.
 */
export const CONTACT_OPERATOR_LABEL = "Зөвлөхтэй холбогдох";
