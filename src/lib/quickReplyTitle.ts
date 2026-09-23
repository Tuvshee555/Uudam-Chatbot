/**
 * Messenger shows at most 20 characters of a quick-reply title. The PAYLOAD
 * (up to 1000) carries the full label and is what the webhook reads back, so a
 * tapped "1. <long trip name>" arrives intact instead of as its first 20
 * characters plus "..." — which two different trips can share.
 */
export function quickReplyTitle(label: string): string {
  return label.length <= 20 ? label : `${label.slice(0, 19).trimEnd()}…`;
}
