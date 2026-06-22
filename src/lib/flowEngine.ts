export type FlowRule = {
  id: string;
  keywords: string; // comma-separated trigger words
  reply: string;    // bot reply text
  buttons: string[]; // quick-reply button labels
};

/**
 * Checks if the user's message matches any flow rule.
 * Returns the first matching rule, or null if none match.
 * Matching is substring-based (case-insensitive).
 */
export function matchFlow(userText: string, rules: FlowRule[]): FlowRule | null {
  const norm = userText.toLowerCase();
  for (const rule of rules) {
    const keywords = rule.keywords
      .split(",")
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);
    if (keywords.some((k) => k.length > 0 && norm.includes(k))) {
      return rule;
    }
  }
  return null;
}
