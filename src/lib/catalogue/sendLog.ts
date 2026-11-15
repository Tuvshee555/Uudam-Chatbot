/**
 * The catalogue send log: idempotent claims, outcomes, aggregate stats and the cache of Meta
 * attachment ids.
 *
 * Privacy: the sender id is stored only as hashIdentifier(...) (truncated sha256); no message
 * text, name or profile data is ever written here. The stats the admin reads are counts.
 *
 * Idempotency, in the order the checks run inside ONE transaction that holds an advisory lock for
 * (sender, edition), so two webhook deliveries racing each other are strictly serialised:
 *
 *   1. dedupeKey (the inbound Messenger message id): the same message can never own two sends,
 *      explicit resend or not. A claim whose previous attempt FAILED is re-opened instead, so
 *      Meta's redelivery after a failure still retries.
 *   2. a live claim / successful send for the same sender+edition inside `windowMs` suppresses
 *      the new claim ("recent_send" / "in_flight").
 *   3. `explicitResend` skips (2) but not a short burst guard, so a redelivery of the "resend"
 *      message itself (when the caller passed no dedupeKey) or a double click cannot double-send.
 *
 * Rows that delivered nothing (failed, blocked_*, no_published_version, dry_run) never block a
 * later claim. An in-flight claim that never finished (process died) stops blocking after
 * CLAIM_IN_FLIGHT_MS. A stale_fallback row (the customer got the website text because the file was
 * out of date) blocks only a claim for the SAME version: a freshly published version is a new answer.
 *
 * A refused claim says what refused it (`priorStatus`, `priorAgeMs`), so the sender can tell a double
 * tap (seconds) from a customer asking again and answer the second without sending a second file.
 */
import type { CatalogueDeliveryStatus, CatalogueEdition } from "./types";
import { hashIdentifier } from "../observability";
import {
  CatalogueStoreError,
  catalogueNow,
  catalogueNowIso,
  catalogueQuery,
  catalogueTransaction,
  isCatalogueEdition,
  isUuid,
  newCatalogueId,
  toIso,
} from "./schema";

export const DEFAULT_SEND_WINDOW_MS = 6 * 3_600_000;
/** A claim with no recorded outcome stops blocking after this long. */
export const CLAIM_IN_FLIGHT_MS = 5 * 60_000;
/** Even an explicit resend waits this long after the previous claim (double click / redelivery). */
export const EXPLICIT_RESEND_BURST_MS = 45_000;

const DELIVERY_STATUSES: readonly CatalogueDeliveryStatus[] = [
  "sent",
  "sent_link_fallback",
  "duplicate_suppressed",
  "blocked_staff_owned",
  "blocked_paused",
  "blocked_window",
  "blocked_killswitch",
  "no_published_version",
  "stale_fallback",
  "dry_run",
  "failed",
];

/** Statuses that mean "the customer was given (or is being given) something". They block repeats. */
const BLOCKING_STATUSES = ["claimed", "sent", "sent_link_fallback", "stale_fallback"] as const;

export function hashCatalogueSender(senderId: string): string {
  return hashIdentifier(`catalogue_send:${senderId}`);
}

export type ClaimSendInput = {
  senderId: string;
  edition: CatalogueEdition;
  versionId: string | null;
  explicitResend: boolean;
  /** Suppression window. Defaults to DEFAULT_SEND_WINDOW_MS (6 h). */
  windowMs?: number;
  /** The inbound Messenger message id (mid). Strongly recommended: makes redelivery exact. */
  dedupeKey?: string | null;
};

export type ClaimSendResult = {
  claimed: boolean;
  /** Set when not claimed: "duplicate_message" | "recent_send" | "in_flight" | "burst_guard". */
  reason?: string;
  /** The new row when claimed, else the row that blocked this claim. */
  sendId: string;
  /** Set when not claimed: the status of the row that blocked this claim ("sent", "stale_fallback", "claimed" …). */
  priorStatus?: string;
  /** Set when not claimed: how long ago that row was written, so a double tap can be told from a customer asking again. */
  priorAgeMs?: number;
};

type SendRow = {
  id: string;
  status: string;
  created_at: unknown;
  version_id?: string | null;
  explicit_resend?: boolean;
};

export async function claimSend(input: ClaimSendInput): Promise<ClaimSendResult> {
  if (!input || typeof input.senderId !== "string" || !input.senderId.trim()) {
    throw new CatalogueStoreError("invalid_input", "claimSend needs a sender id");
  }
  if (!isCatalogueEdition(input.edition)) throw new CatalogueStoreError("invalid_input", "Unknown catalogue edition");
  const versionId = input.versionId && isUuid(input.versionId) ? input.versionId : null;
  const senderHash = hashCatalogueSender(input.senderId.trim());
  const windowMs = Number.isFinite(input.windowMs) && (input.windowMs as number) > 0 ? (input.windowMs as number) : DEFAULT_SEND_WINDOW_MS;
  const dedupeKey = input.dedupeKey ? hashIdentifier(`catalogue_mid:${input.dedupeKey}`) : null;
  const explicit = Boolean(input.explicitResend);
  const nowMs = catalogueNow().getTime();
  const nowIso = new Date(nowMs).toISOString();
  const windowStart = new Date(nowMs - windowMs).toISOString();

  return catalogueTransaction(async (query): Promise<ClaimSendResult> => {
    await query(`/* cat:send_lock */ SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `catalogue_send:${senderHash}:${input.edition}`,
    ]);

    const sameVersion = (row: SendRow): boolean => (row.version_id ?? "").toString().toLowerCase() === (versionId ?? "").toLowerCase();
    // `sameMessage`: the row belongs to this very inbound message (a redelivery), so the rule is strict.
    const isLive = (row: SendRow, sameMessage = false): boolean => {
      if (!(BLOCKING_STATUSES as readonly string[]).includes(row.status)) return false;
      // A "the file is out of date" notice covers the version it was about. Staff publishing a fresh
      // version afterwards makes the next request a different answer: it must not wait out the window.
      if (row.status === "stale_fallback" && !sameMessage && !sameVersion(row)) return false;
      if (row.status !== "claimed") return true;
      const createdMs = new Date(toIso(row.created_at) ?? 0).getTime();
      return nowMs - createdMs < CLAIM_IN_FLIGHT_MS;
    };
    const suppress = async (row: SendRow, reason: string): Promise<ClaimSendResult> => {
      await query(
        `/* cat:send_suppressed */ UPDATE catalogue_sends SET suppressed_count = suppressed_count + 1 WHERE id = $1`,
        [row.id],
      );
      const createdMs = new Date(toIso(row.created_at) ?? 0).getTime();
      return { claimed: false, reason, sendId: row.id, priorStatus: row.status, priorAgeMs: Math.max(0, nowMs - createdMs) };
    };

    // 1. The same inbound message never gets a second send.
    let reopen: SendRow | null = null;
    if (dedupeKey) {
      const same = await query<SendRow>(
        `/* cat:send_by_dedupe */ SELECT id, status, created_at FROM catalogue_sends
         WHERE sender_hash = $1 AND dedupe_key = $2 LIMIT 1`,
        [senderHash, dedupeKey],
      );
      const row = same.rows[0];
      if (row) {
        if (isLive(row, true)) return suppress(row, "duplicate_message");
        // The earlier attempt delivered nothing (failed / blocked / abandoned): it may retry on
        // the same row, provided nothing else was delivered to this person in the meantime.
        reopen = row;
      }
    }

    // 2./3. Anything live for this sender + edition inside the window?
    const recent = await query<SendRow>(
      `/* cat:send_recent */ SELECT id, status, created_at, version_id FROM catalogue_sends
       WHERE sender_hash = $1 AND edition = $2 AND created_at > $3::timestamptz
         AND status IN ('claimed','sent','sent_link_fallback','stale_fallback')
       ORDER BY created_at DESC LIMIT 10`,
      [senderHash, input.edition, windowStart],
    );
    const live = recent.rows.find((row) => isLive(row) && row.id !== reopen?.id);
    if (live) {
      if (!explicit) return suppress(live, live.status === "claimed" ? "in_flight" : "recent_send");
      const liveMs = new Date(toIso(live.created_at) ?? 0).getTime();
      if (nowMs - liveMs < EXPLICIT_RESEND_BURST_MS) return suppress(live, "burst_guard");
    }

    if (reopen) {
      await query(
        `/* cat:send_reopen */ UPDATE catalogue_sends SET status = 'claimed', version_id = $2, explicit_resend = $3,
           created_at = $4::timestamptz, finished_at = NULL, meta_message_id = NULL, reason = NULL
         WHERE id = $1`,
        [reopen.id, versionId, explicit, nowIso],
      );
      return { claimed: true, sendId: reopen.id };
    }

    const sendId = newCatalogueId();
    await query(
      `/* cat:send_insert */ INSERT INTO catalogue_sends
         (id, sender_hash, edition, version_id, status, explicit_resend, dedupe_key, created_at)
       VALUES ($1,$2,$3,$4,'claimed',$5,$6,$7::timestamptz)`,
      [sendId, senderHash, input.edition, versionId, explicit, dedupeKey, nowIso],
    );
    return { claimed: true, sendId };
  });
}

/**
 * Did this person receive a catalogue (any edition, as a file or as the link) since `sinceIso`? A read only:
 * the webhook uses it to know a "<trip name>, 25 хүн, 1-р сар" reply answers a catalogue we sent (webhookCatalogue.ts).
 * A stale-site notice or a blocked/failed attempt is not a catalogue the customer holds.
 */
export async function hasDeliveredCatalogueSince(senderId: string, sinceIso: string): Promise<boolean> {
  if (typeof senderId !== "string" || !senderId.trim() || !Number.isFinite(new Date(sinceIso).getTime())) return false;
  const result = await catalogueQuery<{ id: string }>(
    `/* cat:send_delivered_since */ SELECT id FROM catalogue_sends
     WHERE sender_hash = $1 AND status IN ('sent','sent_link_fallback') AND created_at > $2::timestamptz LIMIT 1`,
    [hashCatalogueSender(senderId.trim()), new Date(sinceIso).toISOString()],
  );
  return result.rows.length > 0;
}

/** Phone-number-sized and longer digit runs (a PSID, a phone) never belong in a reason. */
function cleanReason(reason: string | null | undefined): string | null {
  if (typeof reason !== "string") return null;
  const cleaned = reason
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\d{8,}/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return cleaned || null;
}

function cleanMessageId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, 200);
  return trimmed || null;
}

/** Record how a claimed send ended. Returns false when no such send exists. */
export async function finishSend(
  sendId: string,
  outcome: {
    status: CatalogueDeliveryStatus;
    metaMessageId?: string | null;
    reason?: string | null;
    retries?: number;
  },
): Promise<boolean> {
  if (!isUuid(sendId)) return false;
  if (!outcome || !DELIVERY_STATUSES.includes(outcome.status)) {
    throw new CatalogueStoreError("invalid_input", "Unknown delivery status");
  }
  const retries = Math.min(Math.max(Math.trunc(Number(outcome.retries)) || 0, 0), 100);
  const result = await catalogueQuery(
    `/* cat:send_finish */ UPDATE catalogue_sends
     SET status = $2, meta_message_id = $3, reason = $4, retries = $5, finished_at = $6::timestamptz
     WHERE id = $1`,
    [sendId, outcome.status, cleanMessageId(outcome.metaMessageId), cleanReason(outcome.reason), retries, catalogueNowIso()],
  );
  return result.rowCount > 0;
}

// ---------------------------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------------------------

export type CatalogueDeliveryStats = {
  days: number;
  since: string;
  until: string;
  totals: {
    attempts: number;
    sent: number;
    linkFallback: number;
    staleFallback: number;
    failed: number;
    blocked: number;
    noPublishedVersion: number;
    dryRun: number;
    inFlight: number;
    /** Repeat requests that were answered by NOT sending again. */
    suppressedDuplicates: number;
  };
  byStatus: Record<string, number>;
  byEdition: Record<string, { attempts: number; delivered: number; failed: number }>;
  byVersion: Array<{
    versionId: string | null;
    edition: string;
    versionNo: number | null;
    fileName: string | null;
    attempts: number;
    delivered: number;
    failed: number;
  }>;
  /** Asia/Ulaanbaatar calendar days, ascending. */
  byDay: Array<{ day: string; attempts: number; delivered: number; failed: number }>;
  uniqueRecipients: number;
  /** delivered / (delivered + failed); null while there is nothing to judge. */
  successRate: number | null;
  lastSentAt: string | null;
};

type StatsRow = {
  status: string;
  edition: string;
  version_id: string | null;
  version_no: number | string | null;
  file_name: string | null;
  day: string;
  n: number | string;
  suppressed: number | string;
  last_at: unknown;
};

const DELIVERED = new Set(["sent", "sent_link_fallback"]);

export async function deliveryStats(days = 30): Promise<CatalogueDeliveryStats> {
  const span = Math.min(Math.max(Math.trunc(Number(days)) || 30, 1), 365);
  const until = catalogueNow();
  const since = new Date(until.getTime() - span * 86_400_000);
  const rows = await catalogueQuery<StatsRow>(
    `/* cat:stats_groups */ SELECT s.status, s.edition, s.version_id, v.version_no, v.file_name,
       to_char((s.created_at AT TIME ZONE 'Asia/Ulaanbaatar')::date, 'YYYY-MM-DD') AS day,
       COUNT(*)::int AS n, COALESCE(SUM(s.suppressed_count), 0)::int AS suppressed, MAX(s.created_at) AS last_at
     FROM catalogue_sends s LEFT JOIN catalogue_versions v ON v.id = s.version_id
     WHERE s.created_at >= $1::timestamptz AND s.created_at <= $2::timestamptz
     GROUP BY s.status, s.edition, s.version_id, v.version_no, v.file_name, day`,
    [since.toISOString(), until.toISOString()],
  );
  const unique = await catalogueQuery<{ n: number | string }>(
    `/* cat:stats_unique */ SELECT COUNT(DISTINCT sender_hash)::int AS n FROM catalogue_sends
     WHERE created_at >= $1::timestamptz AND created_at <= $2::timestamptz
       AND status IN ('sent','sent_link_fallback','stale_fallback')`,
    [since.toISOString(), until.toISOString()],
  );

  const totals = {
    attempts: 0,
    sent: 0,
    linkFallback: 0,
    staleFallback: 0,
    failed: 0,
    blocked: 0,
    noPublishedVersion: 0,
    dryRun: 0,
    inFlight: 0,
    suppressedDuplicates: 0,
  };
  const byStatus: Record<string, number> = {};
  const byEdition: CatalogueDeliveryStats["byEdition"] = {};
  const byVersionMap = new Map<string, CatalogueDeliveryStats["byVersion"][number]>();
  const byDayMap = new Map<string, { day: string; attempts: number; delivered: number; failed: number }>();
  let lastSentMs = 0;

  for (const row of rows.rows) {
    const n = Number(row.n);
    const delivered = DELIVERED.has(row.status) ? n : 0;
    const failed = row.status === "failed" ? n : 0;
    totals.attempts += n;
    totals.suppressedDuplicates += Number(row.suppressed);
    byStatus[row.status] = (byStatus[row.status] ?? 0) + n;
    switch (row.status) {
      case "sent":
        totals.sent += n;
        break;
      case "sent_link_fallback":
        totals.linkFallback += n;
        break;
      case "stale_fallback":
        totals.staleFallback += n;
        break;
      case "failed":
        totals.failed += n;
        break;
      case "no_published_version":
        totals.noPublishedVersion += n;
        break;
      case "dry_run":
        totals.dryRun += n;
        break;
      case "claimed":
        totals.inFlight += n;
        break;
      default:
        if (row.status.startsWith("blocked_")) totals.blocked += n;
    }
    const edition = (byEdition[row.edition] ??= { attempts: 0, delivered: 0, failed: 0 });
    edition.attempts += n;
    edition.delivered += delivered;
    edition.failed += failed;

    const versionKey = `${row.edition}|${row.version_id ?? ""}`;
    const version = byVersionMap.get(versionKey) ?? {
      versionId: row.version_id,
      edition: row.edition,
      versionNo: row.version_no === null || row.version_no === undefined ? null : Number(row.version_no),
      fileName: row.file_name,
      attempts: 0,
      delivered: 0,
      failed: 0,
    };
    version.attempts += n;
    version.delivered += delivered;
    version.failed += failed;
    byVersionMap.set(versionKey, version);

    const day = byDayMap.get(row.day) ?? { day: row.day, attempts: 0, delivered: 0, failed: 0 };
    day.attempts += n;
    day.delivered += delivered;
    day.failed += failed;
    byDayMap.set(row.day, day);

    if (delivered > 0) {
      const lastMs = new Date(toIso(row.last_at) ?? 0).getTime();
      if (lastMs > lastSentMs) lastSentMs = lastMs;
    }
  }

  const delivered = totals.sent + totals.linkFallback;
  return {
    days: span,
    since: since.toISOString(),
    until: until.toISOString(),
    totals,
    byStatus,
    byEdition,
    byVersion: [...byVersionMap.values()].sort(
      (a, b) => (b.versionNo ?? -1) - (a.versionNo ?? -1) || a.edition.localeCompare(b.edition),
    ),
    byDay: [...byDayMap.values()].sort((a, b) => a.day.localeCompare(b.day)),
    uniqueRecipients: Number(unique.rows[0]?.n ?? 0),
    successRate: delivered + totals.failed > 0 ? delivered / (delivered + totals.failed) : null,
    lastSentAt: lastSentMs > 0 ? new Date(lastSentMs).toISOString() : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Meta attachment id cache
// ---------------------------------------------------------------------------------------------

function cleanPageId(pageId: string): string | null {
  if (typeof pageId !== "string") return null;
  const trimmed = pageId.trim();
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(trimmed) ? trimmed : null;
}

/** The reusable Meta attachment id for this version on this Facebook page, if one was uploaded. */
export async function getCachedFbAttachment(versionId: string, pageId: string): Promise<string | null> {
  const page = cleanPageId(pageId);
  if (!isUuid(versionId) || !page) return null;
  const result = await catalogueQuery<{ attachment_id: string }>(
    `/* cat:fb_get */ SELECT attachment_id FROM catalogue_fb_attachments WHERE version_id = $1 AND page_id = $2`,
    [versionId, page],
  );
  return result.rows[0]?.attachment_id ?? null;
}

export async function cacheFbAttachment(versionId: string, pageId: string, attachmentId: string): Promise<void> {
  const page = cleanPageId(pageId);
  const attachment = typeof attachmentId === "string" ? attachmentId.trim().slice(0, 200) : "";
  if (!isUuid(versionId) || !page || !attachment) {
    throw new CatalogueStoreError("invalid_input", "cacheFbAttachment needs a version, a page and an attachment id");
  }
  await catalogueQuery(
    `/* cat:fb_put */ INSERT INTO catalogue_fb_attachments (version_id, page_id, attachment_id, created_at)
     VALUES ($1,$2,$3,$4::timestamptz)
     ON CONFLICT (version_id, page_id) DO UPDATE SET attachment_id = EXCLUDED.attachment_id,
       created_at = EXCLUDED.created_at`,
    [versionId, page, attachment, catalogueNowIso()],
  );
}

/** Forget a cached attachment id Meta no longer accepts, so the next send uploads the bytes again. */
export async function clearCachedFbAttachment(versionId: string, pageId: string): Promise<void> {
  const page = cleanPageId(pageId);
  if (!isUuid(versionId) || !page) return;
  await catalogueQuery(
    `/* cat:fb_clear */ DELETE FROM catalogue_fb_attachments WHERE version_id = $1 AND page_id = $2`,
    [versionId, page],
  );
}
