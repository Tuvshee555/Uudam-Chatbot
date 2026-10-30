import { randomUUID } from "node:crypto";
import { del, get, put } from "@vercel/blob";
import { logError, logInfo } from "./observability";
import type { ReadinessIssue } from "./readiness";

/** Customer documents use a private store; public trip-photo URLs are unsuitable here. */
export async function storeCustomerImage(buffer: Buffer, mimeType: string, key: string): Promise<string> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error("private_blob_not_configured");
  const blob = await put(`customer-documents/${key}`, buffer, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: mimeType,
  });
  return blob.url;
}

export async function readCustomerImage(url: string) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error("private_blob_not_configured");
  return get(url, { access: "private" });
}

/**
 * Is the private store really usable from this deployment? The variables existing proves
 * nothing, so a tiny test file is uploaded privately, an anonymous read must be refused, a
 * token read must return it, and it is deleted. Passports and payment slips are never sent
 * to a public store instead: when this fails, staff see a critical issue and images wait as
 * receipts until storage works. Results hold no URL, token or file content.
 */
export type StorageCheck = {
  ok: boolean;
  configured: boolean;
  checkedAt: string;
  steps: { upload: boolean; anonymousReadRefused: boolean; privateRead: boolean; removed: boolean };
  /** A safe code: our own reason or the storage error's class name, never its message. */
  error: string | null;
};

type StorageDeps = {
  put: typeof put; get: typeof get; del: typeof del;
  fetch: (url: string) => Promise<{ ok: boolean; status: number }>;
  token: string | undefined;
};

const CHECK_TTL_MS = 10 * 60_000;
const PROBE_BODY = "uudam-private-storage-check";
let cached: { at: number; result: StorageCheck } | null = null;

const safeCode = (error: unknown) => error instanceof Error
  ? (/^[a-z_]+$/.test(error.message) ? error.message : error.name || "storage_error")
  : "storage_error";

export async function checkCustomerImageStorage(options: { force?: boolean; deps?: Partial<StorageDeps>; now?: number } = {}): Promise<StorageCheck> {
  const now = options.now ?? Date.now();
  if (!options.force && !options.deps && cached && now - cached.at < CHECK_TTL_MS) return cached.result;
  const deps: StorageDeps = {
    put, get, del,
    fetch: async (url) => { const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8_000) }); await response.body?.cancel(); return response; },
    token: process.env.BLOB_READ_WRITE_TOKEN,
    ...options.deps,
  };
  const steps = { upload: false, anonymousReadRefused: false, privateRead: false, removed: false };
  const finish = (error: string | null): StorageCheck => {
    const result = { ok: !error, configured: Boolean(deps.token), checkedAt: new Date(now).toISOString(), steps, error };
    if (!options.deps) cached = { at: now, result };
    (error ? logError : logInfo)("customer_documents.storage_check", { ok: result.ok, configured: result.configured, ...steps, error });
    return result;
  };
  if (!deps.token) return finish("private_blob_not_configured");
  let url = "";
  try {
    url = (await deps.put(`customer-documents/_storage-check/${randomUUID()}.txt`, PROBE_BODY, {
      access: "private", addRandomSuffix: false, contentType: "text/plain",
    })).url;
    steps.upload = true;
    const anonymous = await deps.fetch(url);
    steps.anonymousReadRefused = !anonymous.ok;
    const read = await deps.get(url, { access: "private" });
    steps.privateRead = Boolean(read && read.statusCode === 200 && await new Response(read.stream as ReadableStream).text() === PROBE_BODY);
  } catch (error) {
    return finish(safeCode(error));
  } finally {
    if (url) await deps.del(url).then(() => { steps.removed = true; }, () => {});
  }
  if (!steps.anonymousReadRefused) return finish("storage_not_private");
  if (!steps.privateRead) return finish("private_read_failed");
  return finish(null);
}

/** For the admin system check and the daily health check. */
export async function customerImageStorageIssues(check?: StorageCheck): Promise<ReadinessIssue[]> {
  const result = check ?? await checkCustomerImageStorage();
  if (result.ok) return [];
  const reason = result.error === "private_blob_not_configured"
    ? "BLOB_READ_WRITE_TOKEN тохируулаагүй"
    : result.error === "storage_not_private" ? "сан нийтэд нээлттэй байна" : `алдаа: ${result.error}`;
  return [{
    severity: "critical",
    key: "customer_image_storage",
    message: `Хэрэглэгчийн зургийн хувийн сан ажиллахгүй байна (${reason}). Ирсэн зургууд хүлээгдэж байгаа; `
      + "Vercel → Storage → Blob холболт болон BLOB_READ_WRITE_TOKEN-г шалгаад, Бичиг баримт хэсгээс «Дахин татах» дарна уу.",
  }];
}
