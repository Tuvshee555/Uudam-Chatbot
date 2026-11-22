/**
 * A catalogue request that met an out-of-date file is HELD, and the fresh PDF is sent the moment the refresh
 * publishes it.
 *
 * Live 2026-11-22: a company asked «байгууллагын аялал» two minutes before the rebuild finished. Trips had been
 * edited that day, so the published PDF counted as stale; the customer got «Каталогийг одоо шинэчилж байна …» and a
 * website link, the bot asked for a rebuild (it published 90 s later), and the file never followed. A person had to
 * notice the lead and send it by hand.
 *
 * The hold lasts two hours and only inside Messenger's 24-hour window; the send itself goes through deliverCatalogue,
 * so a consultant who took the chat over meanwhile, a paused bot, a stale file or the kill switch still stop it.
 */
import { queryNeon } from "../neonDb";
import { getEnv } from "../env";

/** How long a held request waits for a fresh file. Later, the staff lead written with the hold is the follow-up. */
export const HOLD_MS = 2 * 60 * 60_000;
/** Messenger lets the Page answer within 24 hours of the customer's last message; keep a margin. */
const WINDOW_MS = 23 * 60 * 60_000;

export type HeldRequest = { senderId: string; pageId: string; edition: string; platform: string; lastInboundAt: string; heldAt: string };

let schemaReady: Promise<boolean> | null = null;
function ensureSchema(): Promise<boolean> {
  schemaReady ??= queryNeon(`CREATE TABLE IF NOT EXISTS catalogue_held_requests (
      sender_id TEXT NOT NULL, edition TEXT NOT NULL, page_id TEXT NOT NULL, platform TEXT NOT NULL DEFAULT 'facebook',
      last_inbound_at TIMESTAMPTZ NOT NULL, held_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (sender_id, edition))`)
    .then((result) => Boolean(result)).catch(() => { schemaReady = null; return false; });
  return schemaReady;
}

/** Holds one request (the newest wins). True only when the database confirmed it, so the reply may promise the file. */
export async function holdCatalogueRequest(input: { senderId: string; pageId: string; edition: string; platform: string; lastInboundAt: Date }): Promise<boolean> {
  if (!(await ensureSchema())) return false;
  const result = await queryNeon<{ sender_id: string }>(`INSERT INTO catalogue_held_requests (sender_id, edition, page_id, platform, last_inbound_at, held_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (sender_id, edition) DO UPDATE SET page_id = EXCLUDED.page_id, platform = EXCLUDED.platform,
        last_inbound_at = EXCLUDED.last_inbound_at, held_at = NOW()
      RETURNING sender_id`, [input.senderId, input.edition, input.pageId, input.platform, input.lastInboundAt.toISOString()]).catch(() => null);
  return Boolean(result?.rows?.length);
}

async function loadHeld(edition: string, now: Date): Promise<HeldRequest[]> {
  if (!(await ensureSchema())) return [];
  // Expired holds go first: past two hours the staff lead is the follow-up, never a surprise file.
  await queryNeon(`DELETE FROM catalogue_held_requests WHERE held_at < $1 OR last_inbound_at < $2`,
    [new Date(now.getTime() - HOLD_MS).toISOString(), new Date(now.getTime() - WINDOW_MS).toISOString()]).catch(() => null);
  // Only this deployment's pages: each brand's bot (brand.ts) sends its own customers' held files, and a
  // request for another brand's page is neither sent nor dropped here.
  let pages: string[] = [];
  try { pages = getEnv().facebookPages.map((page) => page.pageId); } catch { pages = []; }
  const result = await queryNeon<{ sender_id: string; page_id: string; edition: string; platform: string; last_inbound_at: string | Date; held_at: string | Date }>(
    `SELECT sender_id, page_id, edition, platform, last_inbound_at, held_at FROM catalogue_held_requests
      WHERE edition = $1 AND page_id = ANY($2::text[]) ORDER BY held_at LIMIT 50`, [edition, pages]).catch(() => null);
  const iso = (value: string | Date) => new Date(value).toISOString();
  return (result?.rows || []).map((row) => ({ senderId: row.sender_id, pageId: row.page_id, edition: row.edition, platform: row.platform,
    lastInboundAt: iso(row.last_inbound_at), heldAt: iso(row.held_at) }));
}

async function release(request: HeldRequest): Promise<void> {
  await queryNeon(`DELETE FROM catalogue_held_requests WHERE sender_id = $1 AND edition = $2 AND held_at = $3`,
    [request.senderId, request.edition, request.heldAt]).catch(() => null);
}

/** What a held request became: sent (or answered), kept for the next fresh file, or dropped for good. */
export type HeldVerdict = "sent" | "keep" | "drop";

/**
 * Sends every held request of this edition through `send` (the normal delivery). Kept ones wait for the next fresh
 * file; sent and dropped ones are released. The deps are injectable for tests.
 */
export async function deliverHeldCatalogues(edition: string, send: (request: HeldRequest) => Promise<HeldVerdict>,
  deps: { now?: Date; load?: typeof loadHeld; release?: typeof release } = {}): Promise<{ sent: number; kept: number; dropped: number }> {
  const now = deps.now ?? new Date();
  const held = await (deps.load ?? loadHeld)(edition, now);
  const counts = { sent: 0, kept: 0, dropped: 0 };
  for (const request of held) {
    const verdict = await send(request).catch((): HeldVerdict => "keep");
    if (verdict === "keep") { counts.kept++; continue; }
    counts[verdict === "sent" ? "sent" : "dropped"]++;
    await (deps.release ?? release)(request);
  }
  return counts;
}
