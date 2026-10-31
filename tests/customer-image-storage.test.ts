import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

/**
 * Customer passports and payment slips are kept only in the private Blob store (never public
 * Cloudinary). These checks prove what the store's variables cannot: an upload is private, an
 * anonymous read is refused, a broken store is reported (not silently skipped), and signed
 * admin preview links are tied to one document and expire.
 */
const PROBE = "uudam-private-storage-check";
const fakeDeps = (overrides: Record<string, unknown> = {}) => {
  const calls: string[] = [];
  return { calls, deps: {
    token: "fixture-token-not-a-secret",
    put: (async () => { calls.push("put"); return { url: "https://store.private.blob.vercel-storage.com/customer-documents/_storage-check/x.txt" }; }) as never,
    fetch: async () => { calls.push("anonymous-fetch"); return { ok: false, status: 403 }; },
    get: (async () => { calls.push("get"); return { statusCode: 200, stream: new Blob([PROBE]).stream() }; }) as never,
    del: (async () => { calls.push("del"); }) as never,
    ...overrides,
  } };
};

test("the private store check passes only when the upload is private and readable with the token", async () => {
  applyTestEnv();
  const { checkCustomerImageStorage, customerImageStorageIssues } = await import("../src/lib/customerImageStorage");
  const good = fakeDeps();
  const ok = await checkCustomerImageStorage({ deps: good.deps });
  assert.deepEqual({ ok: ok.ok, error: ok.error, steps: ok.steps }, { ok: true, error: null,
    steps: { upload: true, anonymousReadRefused: true, privateRead: true, removed: true } });
  assert.deepEqual(good.calls, ["put", "anonymous-fetch", "get", "del"], "the test file is always removed");
  assert.deepEqual(await customerImageStorageIssues(ok), []);

  const open = fakeDeps({ fetch: async () => ({ ok: true, status: 200 }) });
  const publicStore = await checkCustomerImageStorage({ deps: open.deps });
  assert.equal(publicStore.error, "storage_not_private", "a store anyone can read is a failure, not a pass");
  assert.ok(open.calls.includes("del"));

  const missing = await checkCustomerImageStorage({ deps: { ...fakeDeps().deps, token: undefined } });
  assert.deepEqual({ ok: missing.ok, configured: missing.configured, error: missing.error },
    { ok: false, configured: false, error: "private_blob_not_configured" });
  const [issue] = await customerImageStorageIssues(missing);
  assert.equal(issue.severity, "critical");
  assert.match(issue.message, /BLOB_READ_WRITE_TOKEN тохируулаагүй/);
});

test("a storage error is reported by its class, never its message, URL or token", async () => {
  applyTestEnv();
  const { checkCustomerImageStorage } = await import("../src/lib/customerImageStorage");
  const denied = fakeDeps({ put: (async () => {
    const error = new Error("Access denied for token vercel_blob_rw_SECRETVALUE at https://x.blob.vercel-storage.com/a");
    error.name = "BlobAccessError";
    throw error;
  }) as never });
  const result = await checkCustomerImageStorage({ deps: denied.deps });
  assert.equal(result.ok, false);
  assert.equal(result.error, "BlobAccessError");
  assert.doesNotMatch(JSON.stringify(result), /SECRETVALUE|vercel-storage|fixture-token/, "nothing secret or locating in the result");
});

test("an image arriving while the private store is not configured is kept for retry and reported, never sent elsewhere", async (context) => {
  applyTestEnv({ NEON_DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/image-storage", BLOB_READ_WRITE_TOKEN: undefined });
  const row = { id: 7, platform: "facebook", sender_id: "fixture-customer", page_id: "fixture-page", source_url: "https://cdn.example.test/passport.jpg",
    mime_type: "image/unknown", ingest_status: "pending", ingest_attempts: 0, ingest_error: "" };
  const errors: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const uploads: string[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    if (/SET ingest_status='processing'/i.test(sql)) { row.ingest_status = "processing"; row.ingest_attempts += 1; return { rows: [row], rowCount: 1 }; }
    if (/SET ingest_status=CASE WHEN ingest_attempts/i.test(sql)) { row.ingest_status = "retry"; row.ingest_error = String(params[2]); return { rows: [], rowCount: 0 }; }
    if (/INSERT INTO travel_error_logs/i.test(sql)) { errors.push({ event: String(params[1]), fields: JSON.parse(String(params[6] || "{}")) }); return { rows: [], rowCount: 0 }; }
    return { rows: [], rowCount: 0 };
  };
  const { Pool } = await import("pg");
  context.mock.method(Pool.prototype, "query", query as unknown as typeof Pool.prototype.query);
  context.mock.method(Pool.prototype, "connect", (async () => ({ query, release() {} })) as unknown as typeof Pool.prototype.connect);
  context.mock.method(globalThis, "fetch", async (input: unknown) => {
    const url = String(input);
    if (url === row.source_url) return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200, headers: { "content-type": "image/jpeg" } });
    uploads.push(new URL(url).hostname);
    throw new Error("no other network in this test");
  });
  try {
    const { processReservedCustomerImages } = await import("../src/lib/customerImageIngest");
    assert.deepEqual(await processReservedCustomerImages([{ id: 7 }]), []);
    assert.equal(row.ingest_status, "retry", "the receipt is kept and retried, not dropped");
    assert.equal(row.ingest_error, "private_blob_not_configured", "the reason is recorded on the document");
    assert.deepEqual(uploads.filter((host) => /cloudinary/.test(host)), [], "never uploaded to a public store instead");
    // The error row is written fire-and-forget; wait for that write itself, not for a guessed delay.
    const { flushPersistedLogs } = await import("../src/lib/observability");
    await flushPersistedLogs();
    assert.ok(errors.some((entry) => entry.event === "customer_documents.private_storage_failed" && entry.fields.error === "private_blob_not_configured"),
      "an error the admin issues list counts");
  } finally {
    const { closeNeonPool } = await import("../src/lib/neonDb");
    await closeNeonPool();
  }
});

test("signed admin preview links are bound to one document and expire within an hour", async (context) => {
  applyTestEnv();
  const { customerImagePreviewUrl, verifyCustomerImagePreview } = await import("../src/lib/customerImageAccess");
  const now = Date.parse("2098-02-01T04:00:00Z");
  context.mock.timers.enable({ apis: ["Date"], now });
  const link = new URL(customerImagePreviewUrl(42, now), "https://admin.example.test");
  const expires = Number(link.searchParams.get("expires"));
  const signature = link.searchParams.get("signature") || "";
  assert.equal(expires - Math.floor(now / 1000), 3600);
  assert.equal(verifyCustomerImagePreview(42, expires, signature), true);
  assert.equal(verifyCustomerImagePreview(43, expires, signature), false, "another document");
  assert.equal(verifyCustomerImagePreview(42, expires + 1, signature), false, "a changed expiry");
  assert.equal(verifyCustomerImagePreview(42, expires, signature.replace(/.$/, (c) => (c === "0" ? "1" : "0"))), false, "a tampered signature");
  context.mock.timers.tick(3601 * 1000);
  assert.equal(verifyCustomerImagePreview(42, expires, signature), false, "expired after an hour");

  // A private PDF is reached through the signed link too; the store's URL never reaches the page.
  const { adminCustomerDocument } = await import("../src/lib/customerImageAccess");
  const pdf = adminCustomerDocument({ id: 9, mime_type: "application/pdf", source_url: "https://cdn.example.test/temp",
    stored_url: "https://store.private.blob.vercel-storage.com/customer-documents/files/x" } as never);
  assert.match(pdf.stored_url, /^\/api\/admin\/customer-image\?id=9&/);
  assert.equal(pdf.source_url, "");
  // 2026-10-30 (owner): historical files are no longer returned with their public Cloudinary URL;
  // they too go through the signed link (the files themselves stay public until migrated).
  const legacy = adminCustomerDocument({ id: 10, mime_type: "application/pdf", source_url: "", stored_url: "https://res.cloudinary.com/x/raw/upload/old.pdf" } as never);
  assert.match(legacy.stored_url, /^\/api\/admin\/customer-image\?id=10&/);

  // The preview endpoint refuses a bad or expired link before it reads anything.
  const { default: handler } = await import("../src/pages/api/admin/customer-image");
  let status = 0;
  const res = { status(code: number) { status = code; return res; }, end() { return res; }, setHeader() {} };
  await handler({ method: "GET", query: { id: "42", expires: String(expires), signature } } as never, res as never);
  assert.equal(status, 403, "expired link");
  await handler({ method: "GET", query: { id: "42", expires: String(expires + 7200), signature: "0".repeat(64) } } as never, res as never);
  assert.equal(status, 403, "forged link");
});
