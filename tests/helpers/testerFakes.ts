import { randomUUID } from "node:crypto";
import { hashTesterPsid, maskTesterPsid, type TesterSendTarget, type TesterStore } from "../../src/lib/catalogue/testers";

/**
 * The tester storage in memory, with the same rules the SQL has: a code is burnt by ONE atomic
 * consume (unknown, used and expired all answer null), one active tester per (psid, page), revoke
 * is permanent, and `travel_senders.last_seen` is a separate clock the webhook keeps fresh.
 */
export function memoryTesterStore(clock: () => number = Date.now) {
  const codes = new Map<string, { label: string; actor: string | null; createdAt: number; expiresAt: number; consumedAt: number | null; consumedBy: string | null }>();
  const testers = new Map<string, TesterSendTarget>();
  const lastSeen = new Map<string, number>();
  const store: TesterStore = {
    async createCode({ codeHash, label, actor, now, expiresAt }) {
      for (const row of codes.values()) {
        if (row.actor === actor && row.consumedAt === null && row.expiresAt > now.getTime()) row.expiresAt = now.getTime();
      }
      codes.set(codeHash, { label, actor, createdAt: now.getTime(), expiresAt: expiresAt.getTime(), consumedAt: null, consumedBy: null });
    },
    async consumeCode(codeHash, consumedByHash, now) {
      const row = codes.get(codeHash);
      if (!row || row.consumedAt !== null || row.expiresAt <= now.getTime()) return null;
      row.consumedAt = now.getTime();
      row.consumedBy = consumedByHash;
      return { label: row.label, actor: row.actor };
    },
    async upsertTester({ psid, pageId, label, actor, now }) {
      const existing = [...testers.values()].find((tester) => tester.psid === psid && tester.pageId === pageId && !tester.revokedAt);
      if (existing) {
        existing.lastInboundAt = now.toISOString();
        if (label) existing.label = label;
        return { id: existing.id };
      }
      const id = randomUUID();
      testers.set(id, { id, psid, pageId, label, masked: maskTesterPsid(psid), verifiedAt: now.toISOString(), lastInboundAt: now.toISOString(), revokedAt: null });
      void actor;
      return { id };
    },
    async listActive() {
      return [...testers.values()].filter((tester) => !tester.revokedAt).sort((a, b) => b.verifiedAt.localeCompare(a.verifiedAt)).map((tester) => ({ ...tester }));
    },
    async get(id) {
      const found = testers.get(id);
      return found ? { ...found } : null;
    },
    async revoke(id, _actor, now) {
      const found = testers.get(id);
      if (!found || found.revokedAt) return false;
      found.revokedAt = now.toISOString();
      return true;
    },
    async lastSeenByPsid(psids) {
      const out: Record<string, string> = {};
      for (const psid of psids) if (lastSeen.has(psid)) out[psid] = new Date(lastSeen.get(psid)!).toISOString();
      return out;
    },
  };
  return {
    store,
    testers,
    codes,
    /** The webhook's trackSender: the person wrote to the Page just now. */
    wroteToPage(psid: string, at: number = clock()) { lastSeen.set(psid, at); },
    hashOf: hashTesterPsid,
  };
}
