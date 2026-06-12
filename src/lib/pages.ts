/**
 * Display names for the Facebook pages this bot serves. Tokens never live here —
 * those come from env (FACEBOOK_PAGES / TOKEN_PAGE). This is purely the
 * human-readable label shown in the admin UI for each page id.
 */
export const PAGE_DISPLAY_NAMES: Record<string, string> = {
  "1010493442437235": "Uudam Travel Agency",
  "596733917653582": "Uudam travel - AI",
};

/** Returns the configured display name for a page id, or the raw id as a fallback. */
export function getPageDisplayName(pageId: string): string {
  return PAGE_DISPLAY_NAMES[pageId] || pageId;
}
