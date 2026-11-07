import type { CatalogueDeliveryStatus, CatalogueEdition, CatalogueVersionMeta } from "../../src/lib/catalogue/types";
import type { CatalogueSendStore, SendDeps } from "../../src/lib/catalogue/send";
import type { FbSendDetail, FbUploadDetail } from "../../src/lib/fbAttachmentUpload";

/**
 * The outside world of the catalogue send, in memory: the store (with the real claim rules), Meta's
 * upload and send calls, the live-data comparison. Invented values only.
 */
export const DAY = 86_400_000;

export function makeVersion(overrides: Partial<CatalogueVersionMeta> & { edition?: CatalogueEdition } = {}): CatalogueVersionMeta {
  const edition = overrides.edition ?? "quick";
  return {
    id: "00000000-0000-4000-8000-000000000001", edition, versionNo: 3, fileName: "UUDAM_Corporate_2098-01-30_v3.pdf", status: "published",
    sizeBytes: 2_400_000, pageCount: 14, sha256: "a".repeat(64), contentHash: "b".repeat(64), tripCount: 9, generatedAt: "2098-01-30T03:00:00.000Z",
    generatedBy: "staff", publishedAt: "2098-01-30T04:00:00.000Z", publishedBy: "staff", publicToken: "tok_fixture_0123456789", warnings: [], ...overrides,
  };
}

type Claim = { id: string; senderId: string; edition: CatalogueEdition; versionId: string | null; explicit: boolean; dedupeKey: string | null;
  status: string; at: number; reason: string | null; metaMessageId: string | null; retries: number };

export const WINDOW_MS = 6 * 3_600_000;
export const BURST_MS = 45_000;
export const IN_FLIGHT_MS = 5 * 60_000;

/** The store's claim rules (sendLog.ts), small enough to read: same message = one send; recent send = suppressed; failed = may retry. */
export function fakeSendStore(clock: () => number = Date.now) {
  const published = new Map<CatalogueEdition, CatalogueVersionMeta>();
  const versions = new Map<string, CatalogueVersionMeta>();
  const pdfs = new Map<string, Buffer>();
  const attachments = new Map<string, string>();
  const claims: Claim[] = [];
  const calls = { cleared: [] as string[] };
  let serial = 0;
  // A stale notice covers only the version it was about (sendLog.ts): a freshly published version is a new answer.
  const live = (row: Claim, forVersion: string | null, sameMessage = false) =>
    ["claimed", "sent", "sent_link_fallback", "stale_fallback"].includes(row.status)
    && (row.status !== "stale_fallback" || sameMessage || row.versionId === forVersion)
    && (row.status !== "claimed" || clock() - row.at < IN_FLIGHT_MS);
  const refused = (row: Claim, reason: string) => ({ claimed: false, reason, sendId: row.id, priorStatus: row.status, priorAgeMs: clock() - row.at });
  const store: CatalogueSendStore = {
    async getPublished(edition) { return published.get(edition) ?? null; },
    async getVersionMeta(id) { return versions.get(id) ?? null; },
    async getVersionPdf(id) { const meta = versions.get(id); return meta ? { bytes: pdfs.get(id) ?? Buffer.from("%PDF-1.7 fixture"), meta } : null; },
    async claimSend(input) {
      const dedupeKey = input.dedupeKey ?? null;
      const same = dedupeKey ? claims.find((row) => row.senderId === input.senderId && row.dedupeKey === dedupeKey) : undefined;
      if (same && live(same, input.versionId, true)) return refused(same, "duplicate_message");
      const recent = [...claims].reverse().find((row) => row !== same && row.senderId === input.senderId && row.edition === input.edition && clock() - row.at < (input.windowMs ?? WINDOW_MS) && live(row, input.versionId));
      if (recent) {
        if (!input.explicitResend) return refused(recent, recent.status === "claimed" ? "in_flight" : "recent_send");
        if (clock() - recent.at < BURST_MS) return refused(recent, "burst_guard");
      }
      if (same) { Object.assign(same, { status: "claimed", at: clock(), versionId: input.versionId, explicit: input.explicitResend, reason: null, metaMessageId: null }); return { claimed: true, sendId: same.id }; }
      const row: Claim = { id: `send-${++serial}`, senderId: input.senderId, edition: input.edition, versionId: input.versionId, explicit: input.explicitResend, dedupeKey,
        status: "claimed", at: clock(), reason: null, metaMessageId: null, retries: 0 };
      claims.push(row);
      return { claimed: true, sendId: row.id };
    },
    async finishSend(sendId, outcome) {
      const row = claims.find((claim) => claim.id === sendId);
      if (!row) return false;
      Object.assign(row, { status: outcome.status, reason: outcome.reason ?? null, metaMessageId: outcome.metaMessageId ?? null, retries: outcome.retries ?? 0 });
      return true;
    },
    async getCachedFbAttachment(versionId, pageId) { return attachments.get(`${versionId}:${pageId}`) ?? null; },
    async cacheFbAttachment(versionId, pageId, attachmentId) { attachments.set(`${versionId}:${pageId}`, attachmentId); },
    async clearCachedFbAttachment(versionId, pageId) { calls.cleared.push(`${versionId}:${pageId}`); attachments.delete(`${versionId}:${pageId}`); },
  };
  return {
    store, claims, calls,
    publish(version: CatalogueVersionMeta, pdf?: Buffer) { versions.set(version.id, version); published.set(version.edition, version); if (pdf) pdfs.set(version.id, pdf); return version; },
    addDraft(version: CatalogueVersionMeta) { versions.set(version.id, version); return version; },
    unpublish(edition: CatalogueEdition) { published.delete(edition); },
    cacheAttachment(versionId: string, pageId: string, attachmentId: string) { attachments.set(`${versionId}:${pageId}`, attachmentId); },
    cached(versionId: string, pageId: string) { return attachments.get(`${versionId}:${pageId}`) ?? null; },
    last(): Claim | undefined { return claims.at(-1); },
    statuses(): string[] { return claims.map((row) => row.status); },
  };
}

type Scripted = Partial<FbSendDetail>;

/** Meta's attachment API and message API: records every call; failures are scripted per call. */
export function fakeMeta() {
  const uploads: Array<{ bytes: number; fileName: string; token: string }> = [];
  const files: Array<{ recipientId: string; attachmentId: string; token: string }> = [];
  const failUploads: Array<Partial<FbUploadDetail>> = [];
  const failFiles: Scripted[] = [];
  let serial = 0;
  const deps: Pick<SendDeps, "upload" | "sendFile"> = {
    async upload(bytes, fileName, token) {
      uploads.push({ bytes: bytes.length, fileName, token });
      const scripted = failUploads.shift();
      if (scripted) return { ok: false, attachmentId: null, status: 400, errorCode: null, errorSubcode: null, errorMessage: "scripted", ...scripted };
      return { ok: true, attachmentId: `att-${++serial}`, status: 200, errorCode: null, errorSubcode: null, errorMessage: null };
    },
    async sendFile(recipientId, attachmentId, token) {
      files.push({ recipientId, attachmentId, token });
      const scripted = failFiles.shift();
      if (scripted) return { ok: false, status: 400, errorCode: null, errorSubcode: null, errorMessage: "scripted", messageId: null, recipientId: null, ...scripted };
      return { ok: true, status: 200, errorCode: null, errorSubcode: null, errorMessage: null, messageId: `m_file_${++serial}`, recipientId };
    },
  };
  return {
    deps, uploads, files,
    failUploadOnce(detail: Partial<FbUploadDetail> = {}) { failUploads.push(detail); },
    failFileOnce(detail: Scripted = {}) { failFiles.push(detail); },
    /** Meta no longer accepts the attachment id (code 100 "invalid attachment"). */
    rejectAttachmentOnce() { failFiles.push({ status: 400, errorCode: 100, errorMessage: "Invalid attachment id" }); },
  };
}

export const SITE = "https://catalogue.example.test";
export const publicUrlOf = (token: string) => `${SITE}/api/catalogue/file/${token}`;

export const noDrift = async () => ({ drifted: false, reasons: [] as string[] });

export type OutcomeStatus = CatalogueDeliveryStatus;
