// UUDAM's Instagram account is connected at the Ursgal Digital hub (www.ursgaldigital.com): its
// Meta app has the Instagram permissions the original UUDAM app never had. The hub forwards that
// account's Instagram webhook events to /api/webhook, signed with this route's own secret, and lends
// the Page token (with its appsecret_proof) for the replies. Messenger stays on FACEBOOK_PAGES: page
// events the hub forwards are acknowledged and dropped. See docs/ursgal-hub-instagram.md.
//
// Vercel (Production only): URSGAL_HUB_ROUTE_ID and URSGAL_HUB_SECRET (shown once when the route is
// created at /holboh/admin). Optional: URSGAL_HUB_PAGE_ID (default: the first FACEBOOK_PAGES page,
// the UUDAM Page) and URSGAL_HUB_URL (default https://www.ursgaldigital.com). Without the route id
// and secret, every hub delivery is refused and nothing else changes.
import { rememberLentToken } from "./lentPageTokens";
import { fetchPageToken, HubTokenError, hubRequestProblem, SIGNATURE_HEADER, type HubRequestProblem } from "./ursgalHubClient";

export const DEFAULT_URSGAL_HUB_URL = "https://www.ursgaldigital.com";

export type UrsgalHubConfig = { url: string; routeId: string; secret: string; pageId: string };

type HeaderSource = Record<string, string | string[] | undefined>;
type EnvSource = Record<string, string | undefined>;

const read = (source: EnvSource, name: string) => (source[name] ?? "").trim();

/** The hub settings, or null until both the route id and its secret are set. */
export function ursgalHubConfig(source: EnvSource = process.env, fallbackPageId = ""): UrsgalHubConfig | null {
  const routeId = read(source, "URSGAL_HUB_ROUTE_ID");
  const secret = read(source, "URSGAL_HUB_SECRET");
  const pageId = read(source, "URSGAL_HUB_PAGE_ID") || fallbackPageId.trim();
  if (!routeId || !secret || !pageId) return null;
  return { url: read(source, "URSGAL_HUB_URL") || DEFAULT_URSGAL_HUB_URL, routeId, secret, pageId };
}

/**
 * Settings that cannot work: the build preflight stops on them, because the running deployment
 * would only refuse every hub delivery (the hub then tells Meta to retry).
 */
export function ursgalHubSettingsIssues(source: EnvSource = process.env): string[] {
  const issues: string[] = [];
  const routeId = read(source, "URSGAL_HUB_ROUTE_ID");
  const secret = read(source, "URSGAL_HUB_SECRET");
  if (Boolean(routeId) !== Boolean(secret)) issues.push("URSGAL_HUB_ROUTE_ID and URSGAL_HUB_SECRET must be set together");
  if (routeId && !/^[0-9a-f]{16}$/.test(routeId)) issues.push("URSGAL_HUB_ROUTE_ID must be the 16-character route id shown at /holboh/admin");
  if (secret && secret.length < 32) issues.push("URSGAL_HUB_SECRET must be the whole secret shown when the route was created");
  const url = read(source, "URSGAL_HUB_URL");
  if (url && !/^https:\/\/[^/\s]+\/?$/.test(url)) issues.push("URSGAL_HUB_URL must be the hub's https origin, e.g. https://www.ursgaldigital.com");
  const pageId = read(source, "URSGAL_HUB_PAGE_ID");
  if (pageId && !/^\d{5,20}$/.test(pageId)) issues.push("URSGAL_HUB_PAGE_ID must be a numeric Facebook Page id");
  return issues;
}

/** A delivery that says it comes from the hub (it carries the hub's signature header, not Meta's). */
export function isUrsgalHubDelivery(headers: HeaderSource): boolean {
  const value = headers[SIGNATURE_HEADER];
  return Boolean(Array.isArray(value) ? value[0] : value);
}

/** Why a delivery that says it comes from the hub is refused, or null when it is genuine and fresh. */
export function ursgalHubDeliveryProblem(
  rawBody: Buffer,
  headers: HeaderSource,
  config: UrsgalHubConfig | null,
  now = Date.now(),
): HubRequestProblem | "not_configured" | null {
  if (!config) return "not_configured";
  return hubRequestProblem(rawBody, headers, config.secret, { routeId: config.routeId, now });
}

export type HubTokenOutcome = "ok" | "not_configured" | "other_account" | "no_proof" | "refused" | "unavailable" | "unreachable";

/**
 * Makes the hub's Page token answer for this Instagram account in this process (env.ts
 * pageTokenForRecipient / appsecretProofFor read it). The hub client caches it for 10 minutes;
 * "other_account" means the hub's Page is linked to a different Instagram account than the event.
 */
export async function primeUrsgalHubToken(
  instagramId: string,
  config: UrsgalHubConfig | null,
  options: { fetch?: typeof fetch; now?: number } = {},
): Promise<HubTokenOutcome> {
  if (!config) return "not_configured";
  try {
    const lent = await fetchPageToken(config.url, config.routeId, config.secret, config.pageId, options);
    if (lent.instagramId !== instagramId) return "other_account";
    if (!lent.appsecretProof) return "no_proof";
    rememberLentToken(instagramId, lent.token, lent.appsecretProof, options.now);
    return "ok";
  } catch (error) {
    if (error instanceof HubTokenError) return error.status === 401 ? "refused" : "unavailable";
    return "unreachable";
  }
}
