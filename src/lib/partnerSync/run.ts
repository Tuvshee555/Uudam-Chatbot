// One sync pass over every mirrored partner tour. Shared by the CLI script and the cron endpoint,
// so a scheduled run and a manual run do exactly the same thing.
import { fetchGlobalTravelTour, type PartnerTour } from "./globalTravel";
import { buildPosterData, describeChanges, lowestAdultPrice } from "./posterPayload";

export type TourConfig = { posterId: string; url: string; agency: string };

/** The partner tours mirrored on every run. */
export const TOURS: TourConfig[] = [
  {
    posterId: "poster-global-hainan-sanya-2026",
    url: "https://global-travel.mn/tours/hainan-aylal",
    agency: "Global Travel Corporation",
  },
];

/** A single run must never move a fare by more than this, or rewrite most of the table. */
const MAX_PRICE_JUMP = 1_500_000;
const MAX_CHANGED_SHARE = 0.6;

const money = (amount: number) => `${amount.toLocaleString("en-US")}₮`;
const offerKey = (offer: { date: string; packageLabel: string; hotelLabel: string }) =>
  `${offer.date}|${offer.packageLabel}|${offer.hotelLabel}`;

function readStoredTour(data: unknown): PartnerTour | null {
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  const snapshot = record?.partner_snapshot;
  return snapshot && typeof snapshot === "object" ? (snapshot as PartnerTour) : null;
}

/**
 * Refuses a run whose numbers look like a parsing failure rather than a real price change:
 * a partner redesigning their page must never quietly overwrite live fares with garbage.
 */
export function tripwire(before: PartnerTour | null, after: PartnerTour): string | null {
  if (!before) return null;
  const previous = new Map(before.offers.map((offer) => [offerKey(offer), offer.adultPrice]));
  let compared = 0;
  let changed = 0;
  for (const offer of after.offers) {
    const was = previous.get(offerKey(offer));
    if (was == null) continue;
    compared += 1;
    if (was !== offer.adultPrice) changed += 1;
    if (Math.abs(offer.adultPrice - was) > MAX_PRICE_JUMP) {
      return `${offer.date} ${offer.packageLabel} · ${offer.hotelLabel}: ${money(was)} → ${money(offer.adultPrice)} (хэт том өөрчлөлт)`;
    }
  }
  if (compared >= 8 && changed / compared > MAX_CHANGED_SHARE) {
    return `${changed}/${compared} үнэ нэг дор өөрчлөгдсөн (хуудас өөрчлөгдсөн байж магадгүй)`;
  }
  if (after.offers.length < Math.ceil(before.offers.length / 2)) {
    return `Үнийн тоо ${before.offers.length} → ${after.offers.length} болж буурсан`;
  }
  return null;
}

export type SyncResult =
  | { posterId: string; status: "unchanged"; lines: string[] }
  | { posterId: string; status: "dry-run"; lines: string[] }
  | { posterId: string; status: "blocked"; reason: string; lines: string[] }
  | { posterId: string; status: "synced"; lines: string[]; price: number | null }
  | { posterId: string; status: "failed"; reason: string; lines: string[] };

export async function syncTour(config: TourConfig, flags: { dryRun?: boolean; force?: boolean } = {}): Promise<SyncResult> {
  const { getPosterTrip, savePosterTrip } = await import("../poster/db");
  const tour = await fetchGlobalTravelTour(config.url);
  const existing = await getPosterTrip(config.posterId);
  const before = readStoredTour(existing?.data);

  if (before && before.contentHash === tour.contentHash && !flags.force) {
    return { posterId: config.posterId, status: "unchanged", lines: [] };
  }
  const blocked = tripwire(before, tour);
  if (blocked) return { posterId: config.posterId, status: "blocked", reason: blocked, lines: [] };

  const lines = describeChanges(before, tour);
  if (flags.dryRun) return { posterId: config.posterId, status: "dry-run", lines };

  const saved = await savePosterTrip({
    id: config.posterId,
    title: tour.title,
    data: { ...buildPosterData(tour, config.agency), partner_snapshot: tour },
    source_file: config.url,
    note: `Partner sync ${new Date().toISOString()}`,
  });
  if (!saved) throw new Error("savePosterTrip returned null");

  // savePosterTrip stamps every trip as UUDAM TRAVEL AGENCY and re-derives departures from the
  // poster text, so the real owner and the exact ISO dates are set here. syncPoster = false: the
  // poster was just written, and writing back to it would undo these fields.
  const { patchTrip } = await import("../travelDb");
  const patched = await patchTrip(`trip-${config.posterId}`, {
    operator_name: config.agency,
    departure_dates: tour.dates,
    source_description: config.url,
  }, false);
  if (!patched) throw new Error("patchTrip did not find the synced trip");

  return { posterId: config.posterId, status: "synced", lines, price: lowestAdultPrice(tour) };
}

async function notify(message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    // A failed notification must not fail the sync; the run's return value is the record.
  }
}

/** Syncs every configured tour and reports anything that changed or broke. */
export async function runPartnerSync(flags: { dryRun?: boolean; force?: boolean } = {}): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  const messages: string[] = [];

  for (const config of TOURS) {
    try {
      const result = await syncTour(config, flags);
      results.push(result);
      if (result.status === "blocked") {
        messages.push(`⛔️ ${config.posterId}: синк зогслоо — ${result.reason}\n${config.url}`);
      } else if (result.status === "synced" && result.lines.length) {
        const shown = result.lines.slice(0, 20);
        const rest = result.lines.length - shown.length;
        messages.push(`🔄 ${config.agency} — ${config.posterId}\n${shown.join("\n")}${rest > 0 ? `\n…бас ${rest} өөрчлөлт` : ""}`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      results.push({ posterId: config.posterId, status: "failed", reason, lines: [] });
      messages.push(`⚠️ ${config.posterId}: синк амжилтгүй — ${reason}`);
    }
  }
  if (messages.length && !flags.dryRun) await notify(messages.join("\n\n"));
  return results;
}
