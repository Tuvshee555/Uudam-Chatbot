/**
 * A customer who taps "Send message" on a boosted post starts a chat with no
 * words about the trip ("1", "vne"). Meta tells us which ad it was (a `referral`
 * on the first event); the trip is whatever the ad's own title or post text names.
 * Without this the bot had to guess — and once quoted Hainan to a Beijing-ad customer.
 */
import type { TravelTrip } from "./travelTypes";
import { resolveTripFromUserMessage } from "./travelFastPathsSearch";
import { setTripSelection } from "./tripSelectionState";
import { queryNeon } from "./neonDb";
import { logInfo, logWarn } from "./observability";

export type AdReferral = {
  source?: string;
  type?: string;
  ref?: string;
  ad_id?: string;
  ads_context_data?: { ad_title?: string; post_id?: string; photo_url?: string; video_url?: string; product_id?: string };
};

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** The referral Meta attaches to an event, wherever it put it (message, postback or the event itself). */
export function pickReferral(event: unknown): AdReferral | null {
  if (!isObject(event)) return null;
  const message = isObject(event.message) ? event.message : null;
  const postback = isObject(event.postback) ? event.postback : null;
  const found = [event.referral, message?.referral, postback?.referral].find(isObject);
  return found ? found as AdReferral : null;
}

/** Everything in the referral that can name a trip. */
function referralText(referral: AdReferral, postText: string): string {
  return [referral.ads_context_data?.ad_title, postText, typeof referral.ref === "string" ? referral.ref.replace(/[_-]+/g, " ") : ""]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0).join(" \n");
}

/**
 * The website's "chat with staff" button opens m.me/<page>?ref=<trip slug>, so the ref IS the
 * trip: its website slug (or id). Exact, unlike reading an ad's words.
 */
export function tripFromRef(ref: unknown, trips: TravelTrip[]): TravelTrip | null {
  const wanted = typeof ref === "string" ? ref.trim().toLowerCase() : "";
  if (!wanted) return null;
  const matches = trips.filter((trip) => trip.status !== "draft"
    && (trip.id.toLowerCase() === wanted || String(trip.extra?.website_slug ?? "").trim().toLowerCase() === wanted));
  return matches.length === 1 ? matches[0] : null;
}

/**
 * The one trip the ad is about, or null. Only a single clear match counts: a post that
 * could be several trips must not pick one for the customer.
 */
export function tripFromAdText(text: string, trips: TravelTrip[]): TravelTrip | null {
  const bookable = trips.filter((trip) => trip.status === "active");
  if (!text.trim() || !bookable.length) return null;
  const resolution = resolveTripFromUserMessage(text, bookable, { allowLooseFallback: false });
  return resolution.status === "verified" && resolution.trip ? resolution.trip : null;
}

async function fetchPostText(postId: string | undefined, token: string | null | undefined): Promise<string> {
  if (!postId || !token) return "";
  try {
    const response = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(postId)}?fields=message&access_token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return "";
    const body = await response.json() as { message?: unknown };
    return typeof body.message === "string" ? body.message.slice(0, 2000) : "";
  } catch {
    return "";
  }
}

let tableReady: Promise<unknown> | null = null;
function ensureTable() {
  tableReady ||= queryNeon(`CREATE TABLE IF NOT EXISTS travel_ad_referrals (
    id BIGSERIAL PRIMARY KEY, sender_id TEXT NOT NULL, platform TEXT NOT NULL, referral JSONB NOT NULL,
    post_text TEXT NOT NULL DEFAULT '', matched_trip_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`).catch(() => { tableReady = null; });
  return tableReady;
}

/**
 * Records the referral (so what Meta really sends can be read back) and, when the ad names
 * exactly one trip, makes it the customer's selected trip so a first "vne" is about it.
 * Opening a new post is fresh context: it replaces an older selection, and an
 * unresolvable post clears the older selection rather than letting (for example)
 * an old Hainan conversation answer a new Beijing-post customer.
 * Never throws: the message itself must still be answered.
 */
export async function rememberAdReferral(input: {
  senderId: string; platform: string; referral: AdReferral; trips: TravelTrip[]; pageToken?: string | null;
}): Promise<TravelTrip | null> {
  try {
    const postText = await fetchPostText(input.referral.ads_context_data?.post_id, input.pageToken);
    const trip = tripFromRef(input.referral.ref, input.trips) ?? tripFromAdText(referralText(input.referral, postText), input.trips);
    await setTripSelection(input.senderId, trip
      ? { tripId: trip.id, date: null, hotel: null, package: null, passengers: [] }
      : null);
    logInfo("webhook.ad_referral", {
      source: input.referral.source ?? null, type: input.referral.type ?? null, adId: input.referral.ad_id ?? null,
      postId: input.referral.ads_context_data?.post_id ?? null, titleLength: input.referral.ads_context_data?.ad_title?.length ?? 0,
      postTextLength: postText.length, matchedTripId: trip?.id ?? null,
    });
    await ensureTable();
    await queryNeon(`INSERT INTO travel_ad_referrals (sender_id, platform, referral, post_text, matched_trip_id) VALUES ($1,$2,$3::jsonb,$4,$5)`,
      [input.senderId, input.platform, JSON.stringify(input.referral).slice(0, 4000), postText, trip?.id ?? null]).catch(() => null);
    return trip;
  } catch (error) {
    logWarn("webhook.ad_referral_failed", { message: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
