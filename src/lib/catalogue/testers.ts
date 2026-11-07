/**
 * Verified catalogue test recipients ("Тестер холбох").
 *
 * The problem this solves: a real test send needs the recipient's page-scoped id (PSID), and the
 * owner must not have to hunt for it, edit a Vercel variable, or guess which customer in the
 * inbox is "me". Identity is PROVEN instead:
 *
 *   1. A signed-in staff member presses "Тестер холбох" in the admin. The server mints a one-time
 *      pairing code (UUDAM-TEST-7K3Q9X), keeps only its SHA-256, and shows the code once. It is
 *      valid for 30 minutes.
 *   2. The staff member sends EXACTLY that code, as the whole message, to the Page from their own
 *      Messenger account. The webhook (webhookCatalogue.ts, after the paused-page, paused-sender
 *      and staff-takeover checks) recognises it, registers THAT sender as a verified tester and
 *      consumes the code in one atomic UPDATE, so a replay or a second account gets nothing.
 *   3. From then on the admin sends test PDFs to the tester by an opaque id. Sending needs the raw
 *      PSID, so it is stored here and nowhere near the browser: every view returned to the admin
 *      holds a label, a masked tail and timestamps only.
 *
 * What a real test send checks (evaluateTesterSend): the tester is verified and not revoked, and
 * Messenger's 24 h window is open. The window is the later of the tester's own last message and
 * the webhook's `travel_senders.last_seen` (kept fresh by trackSender on every inbound message),
 * so a tester who just wrote to the Page is always inside it. send.ts adds the Meta kill switch,
 * the Vercel-preview rule and the page-level pause on top.
 *
 * Decision (documented in docs/corporate-catalogue.md): a sender-level pause or staff takeover on
 * the TESTER'S OWN conversation does not block a test. That conversation is the staff member's own
 * account, verified by a code only a signed-in admin could mint; staff "owning" it is exactly what
 * they are doing. The page-level pause, photo-only mode and the kill switch still block.
 *
 * Own tables (catalogue_tester_codes, catalogue_testers), created lazily and idempotently here so
 * this feature adds nothing to the shared schema statements. Invented ids only in tests.
 */
import { createHash, randomInt, randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import { queryNeon, withNeonClient } from "../neonDb";

// ── Constants ────────────────────────────────────────────────────────────────────────────────────

export const TESTER_CODE_PREFIX = "UUDAM-TEST-";
export const TESTER_CODE_TTL_MS = 30 * 60_000;
/** No 0/O/1/I/L: a code is read off a screen and typed on a phone. 31 symbols, 6 places. */
export const TESTER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const TESTER_CODE_LENGTH = 6;
/** Same margin as send.ts MESSAGING_WINDOW_MS (24 h minus 5 min); a test asserts they agree. */
export const TESTER_WINDOW_MS = 24 * 3_600_000 - 5 * 60_000;
export const TESTER_LABEL_MAX = 40;
export const TESTER_MAX_ACTIVE = 10;
/** Code-shaped messages one sender may try within the window below (a guess limiter). */
export const TESTER_ATTEMPT_LIMIT = 5;
export const TESTER_ATTEMPT_WINDOW_MS = 10 * 60_000;

/** The one short acknowledgement the tester gets. */
export const TESTER_PAIRED_TEXT = "Тестийн бүртгэл амжилттай. Админ дээрээс каталогийг илгээж болно.";

// ── Pure helpers ─────────────────────────────────────────────────────────────────────────────────

const CODE_SHAPE = new RegExp(`^${TESTER_CODE_PREFIX}[${TESTER_CODE_ALPHABET}]{${TESTER_CODE_LENGTH}}$`);
const DASHES = /[‐-―−]/g;

/**
 * The canonical code when the WHOLE message is a pairing code (surrounding spaces and letter case
 * are forgiven because phones autocorrect; nothing else is), otherwise null. A sentence that
 * merely contains a code is not a pairing attempt.
 */
export function readTesterCode(text: unknown): string | null {
  if (typeof text !== "string" || text.length > 64) return null;
  const candidate = text.replace(DASHES, "-").trim().toUpperCase();
  return CODE_SHAPE.test(candidate) ? candidate : null;
}

export function generateTesterCode(pick: (max: number) => number = (max) => randomInt(max)): string {
  let tail = "";
  for (let index = 0; index < TESTER_CODE_LENGTH; index += 1) tail += TESTER_CODE_ALPHABET[pick(TESTER_CODE_ALPHABET.length)];
  return `${TESTER_CODE_PREFIX}${tail}`;
}

export function hashTesterCode(code: string): string {
  return createHash("sha256").update(`catalogue-tester-code:${code}`).digest("hex");
}

export function hashTesterPsid(psid: string): string {
  return createHash("sha256").update(`catalogue-tester-psid:${psid}`).digest("hex");
}

/** "…4567": all the browser ever sees of a PSID. */
export function maskTesterPsid(psid: string): string {
  return psid.length <= 4 ? "…" : `…${psid.slice(-4)}`;
}

export function cleanTesterLabel(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f<>]+/g, " ").replace(/\s+/g, " ").trim().slice(0, TESTER_LABEL_MAX);
}

// ── Types ────────────────────────────────────────────────────────────────────────────────────────

/** What the admin browser may hold about a tester. No PSID, no hash of it. */
export type CatalogueTesterView = {
  /** Opaque id (UUID) the UI sends back to pick a recipient. */
  id: string;
  label: string;
  /** "…4567" */
  masked: string;
  verifiedAt: string;
  lastInboundAt: string | null;
  /** The 24 h Messenger window is open right now: a real send is possible. */
  windowOpen: boolean;
  /** When the window closes (ISO), or null when it is already closed / unknown. */
  windowClosesAt: string | null;
};

/** Server-only: everything a send needs, including the raw PSID. Never serialise this to a response. */
export type TesterSendTarget = {
  id: string;
  psid: string;
  pageId: string;
  label: string;
  masked: string;
  verifiedAt: string;
  lastInboundAt: string | null;
  revokedAt: string | null;
};

export type TesterLookup =
  | { status: "ok"; target: TesterSendTarget }
  | { status: "not_found" }
  | { status: "revoked" };

export type TesterGateVerdict =
  | { ok: true; windowClosesAt: string }
  | { ok: false; code: "tester_not_found" | "tester_revoked" | "tester_window_closed"; reason: string };

/** The storage the feature needs. Neon in production, an in-memory fake in tests. */
export type TesterStore = {
  createCode(input: { codeHash: string; label: string; actor: string | null; now: Date; expiresAt: Date }): Promise<void>;
  /** Atomically burns a live code. null = unknown, used or expired. */
  consumeCode(codeHash: string, consumedByHash: string, now: Date): Promise<{ label: string; actor: string | null } | null>;
  upsertTester(input: { psid: string; pageId: string; label: string; actor: string | null; now: Date }): Promise<{ id: string }>;
  /** Active (not revoked) testers, newest first, raw rows. */
  listActive(): Promise<TesterSendTarget[]>;
  get(id: string): Promise<TesterSendTarget | null>;
  revoke(id: string, actor: string | null, now: Date): Promise<boolean>;
  /** Latest inbound time the webhook recorded per PSID (travel_senders.last_seen). */
  lastSeenByPsid(psids: string[]): Promise<Record<string, string>>;
};

// ── Neon implementation ──────────────────────────────────────────────────────────────────────────

export const TESTER_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS catalogue_tester_codes (
    id UUID PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL DEFAULT '',
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    consumed_by_hash TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS catalogue_testers (
    id UUID PRIMARY KEY,
    psid TEXT NOT NULL,
    psid_hash TEXT NOT NULL,
    page_id TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    masked TEXT NOT NULL,
    verified_at TIMESTAMPTZ NOT NULL,
    last_inbound_at TIMESTAMPTZ,
    created_by TEXT,
    revoked_at TIMESTAMPTZ,
    revoked_by TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS catalogue_testers_one_active
    ON catalogue_testers (psid, page_id) WHERE revoked_at IS NULL`,
];

let schemaReady: Promise<void> | undefined;

export function resetTesterSchemaForTests(): void {
  schemaReady = undefined;
}

function ensureTesterSchema(): Promise<void> {
  return (schemaReady ??= (async () => {
    const outcome = await withNeonClient(async (client) => {
      await client.query("BEGIN");
      try {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["catalogue_testers_schema"]);
        for (const statement of TESTER_SCHEMA_STATEMENTS) await client.query(`/* cat:tester_ddl */ ${statement}`);
        await client.query("COMMIT");
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // The original error is the useful one.
        }
        throw error;
      }
      return true;
    });
    if (!outcome) throw new Error("db_not_configured");
  })().catch((error) => {
    schemaReady = undefined;
    throw error;
  }));
}

async function run<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
  await ensureTesterSchema();
  const result = await queryNeon<T>(sql, params);
  if (!result) throw new Error("db_not_configured");
  return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
}

const iso = (value: unknown): string | null => {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

type TesterRow = {
  id: string; psid: string; page_id: string; label: string; masked: string;
  verified_at: unknown; last_inbound_at: unknown; revoked_at: unknown;
};
const rowToTarget = (row: TesterRow): TesterSendTarget => ({
  id: String(row.id), psid: String(row.psid), pageId: String(row.page_id), label: String(row.label || ""), masked: String(row.masked || ""),
  verifiedAt: iso(row.verified_at) ?? new Date(0).toISOString(), lastInboundAt: iso(row.last_inbound_at), revokedAt: iso(row.revoked_at),
});
const COLUMNS = "id, psid, page_id, label, masked, verified_at, last_inbound_at, revoked_at";

export const neonTesterStore: TesterStore = {
  async createCode({ codeHash, label, actor, now, expiresAt }) {
    // One live code per staff member: a new press retires the previous unused one.
    await run(
      `/* cat:tester_code_retire */ UPDATE catalogue_tester_codes SET expires_at = $2::timestamptz
       WHERE consumed_at IS NULL AND expires_at > $2::timestamptz AND created_by IS NOT DISTINCT FROM $1`,
      [actor, now.toISOString()],
    );
    await run(
      `/* cat:tester_code_insert */ INSERT INTO catalogue_tester_codes (id, code_hash, label, created_by, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5::timestamptz,$6::timestamptz)`,
      [randomUUID(), codeHash, label, actor, now.toISOString(), expiresAt.toISOString()],
    );
  },
  async consumeCode(codeHash, consumedByHash, now) {
    const result = await run<{ label: string; created_by: string | null }>(
      `/* cat:tester_code_consume */ UPDATE catalogue_tester_codes SET consumed_at = $2::timestamptz, consumed_by_hash = $3
       WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > $2::timestamptz
       RETURNING label, created_by`,
      [codeHash, now.toISOString(), consumedByHash],
    );
    const row = result.rows[0];
    return row ? { label: String(row.label || ""), actor: row.created_by } : null;
  },
  async upsertTester({ psid, pageId, label, actor, now }) {
    const result = await run<{ id: string }>(
      `/* cat:tester_upsert */ INSERT INTO catalogue_testers (id, psid, psid_hash, page_id, label, masked, verified_at, last_inbound_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$7::timestamptz,$8)
       ON CONFLICT (psid, page_id) WHERE revoked_at IS NULL DO UPDATE
         SET last_inbound_at = EXCLUDED.last_inbound_at,
             label = CASE WHEN EXCLUDED.label <> '' THEN EXCLUDED.label ELSE catalogue_testers.label END
       RETURNING id`,
      [randomUUID(), psid, hashTesterPsid(psid), pageId, label, maskTesterPsid(psid), now.toISOString(), actor],
    );
    return { id: String(result.rows[0].id) };
  },
  async listActive() {
    const result = await run<TesterRow>(
      `/* cat:tester_list */ SELECT ${COLUMNS} FROM catalogue_testers WHERE revoked_at IS NULL ORDER BY verified_at DESC LIMIT ${TESTER_MAX_ACTIVE * 4}`,
    );
    return result.rows.map(rowToTarget);
  },
  async get(id) {
    const result = await run<TesterRow>(`/* cat:tester_get */ SELECT ${COLUMNS} FROM catalogue_testers WHERE id = $1::uuid`, [id]);
    return result.rows[0] ? rowToTarget(result.rows[0]) : null;
  },
  async revoke(id, actor, now) {
    const result = await run(
      `/* cat:tester_revoke */ UPDATE catalogue_testers SET revoked_at = $2::timestamptz, revoked_by = $3
       WHERE id = $1::uuid AND revoked_at IS NULL`,
      [id, now.toISOString(), actor],
    );
    return result.rowCount > 0;
  },
  async lastSeenByPsid(psids) {
    if (psids.length === 0) return {};
    try {
      const result = await run<{ sender_id: string; last_seen: unknown }>(
        `/* cat:tester_last_seen */ SELECT sender_id, last_seen FROM travel_senders WHERE sender_id = ANY($1::text[])`,
        [psids],
      );
      const out: Record<string, string> = {};
      for (const row of result.rows) {
        const at = iso(row.last_seen);
        if (at) out[String(row.sender_id)] = at;
      }
      return out;
    } catch {
      // The webhook's table may not exist yet on a brand-new database: the tester's own stamp still works.
      return {};
    }
  },
};

// ── Injection (tests) ────────────────────────────────────────────────────────────────────────────

let storeOverride: TesterStore | null = null;
let clockOverride: (() => Date) | null = null;
let codeOverride: (() => string) | null = null;
const attempts = new Map<string, number[]>();

/** Tests only. Pass null to restore the real store, clock and code generator. */
export function setTesterRuntimeForTests(
  runtime: { store?: TesterStore | null; now?: (() => Date) | null; code?: (() => string) | null } | null,
): void {
  storeOverride = runtime?.store ?? null;
  clockOverride = runtime?.now ?? null;
  codeOverride = runtime?.code ?? null;
  attempts.clear();
}

const store = (): TesterStore => storeOverride ?? neonTesterStore;
const now = (): Date => (clockOverride ? clockOverride() : new Date());

// ── Public API ───────────────────────────────────────────────────────────────────────────────────

export type PairingCodeIssued = { code: string; expiresAt: string; ttlMinutes: number };

/** Admin: mint a one-time pairing code. The code is returned once; only its hash is kept. */
export async function createPairingCode(input: { actor: string | null; label?: unknown }): Promise<PairingCodeIssued> {
  const current = now();
  if ((await store().listActive()).length >= TESTER_MAX_ACTIVE) throw new TesterError("too_many_testers");
  const code = codeOverride ? codeOverride() : generateTesterCode();
  const expiresAt = new Date(current.getTime() + TESTER_CODE_TTL_MS);
  await store().createCode({ codeHash: hashTesterCode(code), label: cleanTesterLabel(input.label), actor: input.actor, now: current, expiresAt });
  return { code, expiresAt: expiresAt.toISOString(), ttlMinutes: TESTER_CODE_TTL_MS / 60_000 };
}

export class TesterError extends Error {
  constructor(readonly code: "too_many_testers") {
    super(code);
    this.name = "TesterError";
  }
}

function lastInboundOf(target: TesterSendTarget, seen: Record<string, string>): string | null {
  const own = target.lastInboundAt ? Date.parse(target.lastInboundAt) : NaN;
  const webhook = seen[target.psid] ? Date.parse(seen[target.psid]) : NaN;
  const best = Math.max(Number.isFinite(own) ? own : -Infinity, Number.isFinite(webhook) ? webhook : -Infinity);
  return Number.isFinite(best) ? new Date(best).toISOString() : null;
}

function toView(target: TesterSendTarget, lastInboundAt: string | null, at: Date): CatalogueTesterView {
  const closes = lastInboundAt ? Date.parse(lastInboundAt) + TESTER_WINDOW_MS : NaN;
  const open = Number.isFinite(closes) && closes > at.getTime();
  return {
    id: target.id, label: target.label, masked: target.masked, verifiedAt: target.verifiedAt, lastInboundAt,
    windowOpen: open, windowClosesAt: open ? new Date(closes).toISOString() : null,
  };
}

/** Admin: the verified testers, masked, with the live state of their Messenger window. */
export async function listTesters(): Promise<CatalogueTesterView[]> {
  const at = now();
  const active = await store().listActive();
  const seen = await store().lastSeenByPsid(active.map((target) => target.psid));
  return active.map((target) => toView(target, lastInboundOf(target, seen), at));
}

/** Server-only lookup for a send: raw PSID included, last inbound already merged with the webhook's. */
export async function getTesterForSend(id: string): Promise<TesterLookup> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return { status: "not_found" };
  const found = await store().get(id);
  if (!found) return { status: "not_found" };
  if (found.revokedAt) return { status: "revoked" };
  const seen = await store().lastSeenByPsid([found.psid]);
  return { status: "ok", target: { ...found, lastInboundAt: lastInboundOf(found, seen) } };
}

/** The tester as the admin may see it (for the dry-run answer). */
export function viewOfTarget(target: TesterSendTarget, at: Date = now()): CatalogueTesterView {
  return toView(target, target.lastInboundAt, at);
}

export async function revokeTester(id: string, actor: string | null): Promise<boolean> {
  return store().revoke(id, actor, now());
}

/**
 * May a REAL test go to this tester right now? Verified, not revoked, window open. The Meta kill
 * switch, the Vercel-preview rule and the page-level pause are checked by the caller / send.ts.
 */
export function evaluateTesterSend(lookup: TesterLookup, at: Date): TesterGateVerdict {
  if (lookup.status === "not_found") {
    return { ok: false, code: "tester_not_found", reason: "Баталгаажсан туршигч олдсонгүй. «Тестер холбох» дарж дахин бүртгүүлнэ үү." };
  }
  if (lookup.status === "revoked") {
    return { ok: false, code: "tester_revoked", reason: "Энэ туршигчийн эрхийг цуцалсан байна. Шинээр холбоно уу." };
  }
  const last = lookup.target.lastInboundAt ? Date.parse(lookup.target.lastInboundAt) : NaN;
  if (!Number.isFinite(last) || at.getTime() - last > TESTER_WINDOW_MS) {
    return {
      ok: false,
      code: "tester_window_closed",
      reason: "Messenger-ийн 24 цагийн цонх хаагдсан байна. Туршигч өөрийн Messenger-ээс манай Page руу дурын мессеж бичээд дахин оролдоно уу.",
    };
  }
  return { ok: true, windowClosesAt: new Date(last + TESTER_WINDOW_MS).toISOString() };
}

export type PairingResult =
  | { status: "registered"; testerId: string; label: string }
  | { status: "not_a_code" }
  | { status: "rejected" }
  | { status: "rate_limited" };

/**
 * Webhook side. Called with the sender's text only after the paused-page / paused-sender /
 * staff-takeover checks. Anything that is not exactly a pairing code returns "not_a_code" without
 * touching storage, so a normal customer message costs nothing here. A code-shaped message that
 * does not match a live code is "rejected" and consumes nothing; the caller then lets the normal
 * flow answer, so a stranger learns nothing about codes.
 */
export async function tryRegisterTester(input: { text: unknown; senderId: string; pageId: string }): Promise<PairingResult> {
  const code = readTesterCode(input.text);
  if (!code) return { status: "not_a_code" };
  const at = now();
  const senderKey = hashTesterPsid(input.senderId);
  const recent = (attempts.get(senderKey) ?? []).filter((time) => at.getTime() - time < TESTER_ATTEMPT_WINDOW_MS);
  if (recent.length >= TESTER_ATTEMPT_LIMIT) {
    attempts.set(senderKey, recent);
    return { status: "rate_limited" };
  }
  attempts.set(senderKey, [...recent, at.getTime()]);
  if (attempts.size > 500) attempts.clear();

  const consumed = await store().consumeCode(hashTesterCode(code), senderKey, at);
  if (!consumed) return { status: "rejected" };
  const registered = await store().upsertTester({ psid: input.senderId, pageId: input.pageId, label: consumed.label, actor: consumed.actor, now: at });
  return { status: "registered", testerId: registered.id, label: consumed.label };
}
