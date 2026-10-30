import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

/**
 * Historical customer documents move from public Cloudinary to the private store
 * (documentMigration.ts). Proven here against an in-memory database, Cloudinary, Blob store
 * and admin preview: the document row switches only after the private copy is uploaded,
 * re-read with the right checksum and refused to an anonymous reader; a failed preview undoes
 * the switch; a file that is not the one the customer sent is never migrated; re-runs make no
 * second copy; and an original is deleted only after every check, exactly that asset.
 */
applyTestEnv({
  NEON_DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/document-migration",
  CLOUDINARY_CLOUD_NAME: "fixture-cloud", CLOUDINARY_API_KEY: "fixture-key", CLOUDINARY_API_SECRET: "fixture-secret",
});

const ORIGIN = "https://admin.example.test";
const sha = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("fixture jpeg body")]);
const PDF = Buffer.from("%PDF-1.4 fixture pdf body");
const cloudUrl = (id: number, ext: string, version = 1700000000 + id) =>
  `https://res.cloudinary.com/fixture-cloud/image/upload/v${version}/customer-documents/doc-${id}.${ext}`;

type Doc = { id: number; stored_url: string; mime_type: string; content_sha256: string; image_sha256: string; hidden: boolean };
type Ledger = Record<string, string | number | null>;

function world(docs: Array<Doc & { delivery?: Buffer | number; apiDownload?: Buffer }>, options: {
  previewStatus?: number; anonymousStatus?: number; otherRows?: Array<{ table: string; json: string }>;
  recordVersion?: Record<number, number>; lockFree?: boolean;
} = {}) {
  const state = {
    docs: new Map(docs.map((doc) => [doc.id, { ...doc }])),
    ledger: new Map<number, Ledger>(),
    audit: [] as Array<{ id: number; action: string }>,
    blobs: new Map<string, Buffer>(),
    destroyed: [] as string[],
    deletedAssets: new Set<string>(),
    events: [] as string[],
    stores: [] as string[],
  };
  const deliveries = new Map(docs.map((doc) => [doc.stored_url, doc]));
  const query = async (sql: string, params: unknown[] = []) => {
    const rows = (list: unknown[]) => ({ rows: list, rowCount: list.length });
    if (/^\s*(BEGIN|ROLLBACK|COMMIT)/i.test(sql)) return rows([]);
    if (/pg_try_advisory_xact_lock/.test(sql)) return rows([{ acquired: options.lockFree !== false }]);
    if (/FROM travel_customer_documents d\s+LEFT JOIN travel_document_migration m/.test(sql)) {
      const done = ["preview_verified", "original_deleted", "deletion_verified"];
      const picked = [...state.docs.values()].filter((doc) => {
        if (!doc.stored_url.startsWith("https://res.cloudinary.com/")) return false;
        const entry = state.ledger.get(doc.id);
        return !entry || (!done.includes(String(entry.status)) && Number(entry.attempts) < 3);
      }).sort((a, b) => Number(state.ledger.get(a.id)?.attempts ?? -1) - Number(state.ledger.get(b.id)?.attempts ?? -1) || a.id - b.id);
      return rows(picked.slice(0, Number(params[0])).map((doc) => ({ ...doc, id: String(doc.id) })));
    }
    if (/INSERT INTO travel_document_migration/.test(sql)) {
      const id = Number(params[0]);
      if (!state.ledger.has(id)) state.ledger.set(id, { document_id: String(id), status: "pending", old_url: String(params[1]), blob_url: "", sha256: "", attempts: 0, error: "", source: "" });
      return rows([]);
    }
    if (/SELECT \* FROM travel_document_migration WHERE document_id=\$1/.test(sql)) return rows([state.ledger.get(Number(params[0]))].filter(Boolean));
    if (/SET attempts=attempts\+1/.test(sql)) { const entry = state.ledger.get(Number(params[0]))!; entry.attempts = Number(entry.attempts) + 1; entry.error = ""; return rows([]); }
    if (/UPDATE travel_document_migration SET status=\$2/.test(sql)) {
      const entry = state.ledger.get(Number(params[0]))!;
      for (const [, name, position] of sql.matchAll(/(\w+)=\$(\d+)/g)) if (name !== "document_id") entry[name] = params[Number(position) - 1] as string;
      state.events.push(`${entry.status}:${params[0]}`);
      return rows([]);
    }
    if (/UPDATE travel_document_migration SET error=\$2/.test(sql)) { state.ledger.get(Number(params[0]))!.error = String(params[1]); return rows([]); }
    if (/UPDATE travel_customer_documents SET stored_url=\$2, updated_at=NOW\(\) WHERE id=\$1 AND stored_url IN/.test(sql)) {
      const doc = state.docs.get(Number(params[0]));
      if (!doc || (doc.stored_url !== params[2] && doc.stored_url !== params[1])) return rows([]);
      doc.stored_url = String(params[1]);
      state.events.push(`switch:${doc.id}`);
      return rows([{ id: doc.id }]);
    }
    if (/UPDATE travel_customer_documents SET stored_url=\$3, updated_at=NOW\(\) WHERE id=\$1 AND stored_url=\$2/.test(sql)) {
      const doc = state.docs.get(Number(params[0]));
      if (doc && doc.stored_url === params[1]) { doc.stored_url = String(params[2]); state.events.push(`undo:${doc.id}`); }
      return rows([]);
    }
    if (/INSERT INTO travel_customer_document_audit/.test(sql)) { state.audit.push({ id: Number(params[0]), action: /'(\w+)'/.exec(sql)![1] }); return rows([]); }
    if (/SELECT retention_hidden_at IS NOT NULL AS hidden FROM travel_customer_documents WHERE id=\$1/.test(sql)) return rows([{ hidden: state.docs.get(Number(params[0]))?.hidden ?? false }]);
    if (/FROM travel_document_migration m LEFT JOIN travel_customer_documents d/.test(sql)) {
      const picked = [...state.ledger.values()].filter((entry) => ["preview_verified", "original_deleted"].includes(String(entry.status)))
        .sort((a, b) => Number(a.document_id) - Number(b.document_id)).slice(0, Number(params[0]));
      return rows(picked.map((entry) => ({ ...entry, stored_url: state.docs.get(Number(entry.document_id))?.stored_url ?? null, hidden: state.docs.get(Number(entry.document_id))?.hidden ?? null })));
    }
    if (/information_schema\.tables/.test(sql)) return rows(["travel_customer_documents", "travel_document_migration", "poster_trips"].map((table_name) => ({ table_name })));
    if (/row_to_json\(t\)::text AS j/.test(sql)) {
      const table = /FROM "(\w+)" t/.exec(sql)![1];
      if (table === "travel_customer_documents") return rows([...state.docs.values()].map((doc) => ({ j: JSON.stringify(doc), doc_id: String(doc.id) })).filter((row) => row.j.includes("res.cloudinary.com")));
      return rows((options.otherRows ?? []).filter((row) => row.table === table).map((row) => ({ j: row.json, doc_id: null })));
    }
    return rows([]);
  };
  const fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://res.cloudinary.com/")) {
      const doc = deliveries.get(url);
      if (state.deletedAssets.has(url)) return new Response("gone", { status: 404 });
      if (!doc || typeof doc.delivery === "number") return new Response("denied", { status: typeof doc?.delivery === "number" ? doc.delivery : 404 });
      assert.equal(init?.redirect, "error", "delivery fetch refuses redirects");
      return new Response(new Uint8Array(doc.delivery ?? Buffer.alloc(0)), { status: 200 });
    }
    if (url.startsWith("https://api.cloudinary.com/v1_1/fixture-cloud/resources/")) {
      const original = [...state.docs.values()].map((doc) => state.ledger.get(doc.id)?.old_url as string | undefined ?? doc.stored_url)
        .find((candidate) => candidate && url.endsWith(new URL(candidate).pathname.split("/").slice(5).join("/").replace(/\.[^.]+$/, "")));
      if (!original || state.deletedAssets.has(original)) return new Response("{}", { status: 404 });
      const id = Number(/doc-(\d+)/.exec(original)![1]);
      const version = options.recordVersion?.[id];
      const secure = version ? original.replace(/\/v\d+\//, `/v${version}/`) : original;
      return Response.json({ secure_url: secure, bytes: (deliveries.get(original)?.delivery as Buffer | undefined)?.length ?? (deliveries.get(original)?.apiDownload?.length ?? null) });
    }
    if (url.startsWith("https://api.cloudinary.com/v1_1/fixture-cloud/image/download?")) {
      const publicId = new URL(url).searchParams.get("public_id")!;
      const doc = [...state.docs.values()].find((candidate) => (state.ledger.get(candidate.id)?.old_url as string ?? candidate.stored_url).includes(`/${publicId}.`));
      return doc && (deliveries.get(state.ledger.get(doc.id)?.old_url as string)?.apiDownload)
        ? new Response(new Uint8Array(deliveries.get(state.ledger.get(doc.id)!.old_url as string)!.apiDownload!), { status: 200 }) : new Response("no", { status: 404 });
    }
    if (url === "https://api.cloudinary.com/v1_1/fixture-cloud/image/destroy") {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get("invalidate"), "true", "the CDN copy is invalidated too");
      state.destroyed.push(String(body.get("public_id")));
      for (const doc of state.docs.values()) {
        const old = state.ledger.get(doc.id)?.old_url as string | undefined;
        if (old?.includes(`/${body.get("public_id")}.`)) state.deletedAssets.add(old);
      }
      return Response.json({ result: "ok" });
    }
    if (url.includes(".blob.vercel-storage.com/")) { state.events.push(`anonymous:${/legacy\/(\d+)-/.exec(url)?.[1]}`); return new Response("no", { status: options.anonymousStatus ?? 403 }); }
    if (url.startsWith(`${ORIGIN}/api/admin/customer-image?`)) {
      const id = Number(new URL(url).searchParams.get("id"));
      state.events.push(`preview:${id}`);
      if (options.previewStatus && options.previewStatus !== 200) return new Response("", { status: options.previewStatus });
      const bytes = state.blobs.get(state.docs.get(id)!.stored_url);
      return bytes ? new Response(new Uint8Array(bytes), { status: 200 }) : new Response("", { status: 404 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof globalThis.fetch;
  const deps = {
    fetch,
    store: async (buffer: Buffer, _type: string, key: string) => {
      const url = `https://fixture.private.blob.vercel-storage.com/customer-documents/${key}`;
      state.blobs.set(url, Buffer.from(buffer));
      state.stores.push(key);
      state.events.push(`stored:${/legacy\/(\d+)-/.exec(key)?.[1]}`);
      return url;
    },
    read: async (url: string) => {
      const bytes = state.blobs.get(url);
      state.events.push(`private_read:${/legacy\/(\d+)-/.exec(url)?.[1]}`);
      return bytes ? { statusCode: 200, stream: new Blob([new Uint8Array(bytes)]).stream() } : null;
    },
  };
  return { state, query, deps };
}

async function install(context: test.TestContext, query: (sql: string, params?: unknown[]) => Promise<unknown>) {
  const { Pool } = await import("pg");
  context.mock.method(Pool.prototype, "query", query as unknown as typeof Pool.prototype.query);
  context.mock.method(Pool.prototype, "connect", (async () => ({ query, release() {} })) as unknown as typeof Pool.prototype.connect);
}

const doc = (id: number, bytes: Buffer, ext: string, extra: Partial<Doc> & { delivery?: Buffer | number; apiDownload?: Buffer } = {}) => ({
  id, stored_url: cloudUrl(id, ext), mime_type: ext === "pdf" ? "application/pdf" : "image/jpeg",
  content_sha256: sha(bytes), image_sha256: "", hidden: false, delivery: bytes, ...extra,
});

test("each document is copied privately and verified before its row switches; re-runs make no second copy", async (context) => {
  const { state, query, deps } = world([
    doc(11, JPEG, "jpg"),
    // Cloudinary blocks delivery of PDFs on this account: the authenticated API is used.
    doc(12, PDF, "pdf", { delivery: 401, apiDownload: PDF }),
    // Not the file the customer sent: never migrated, never changed.
    doc(13, JPEG, "jpg", { delivery: Buffer.from("something else entirely") }),
  ]);
  await install(context, query);
  const { migrateHistoricalDocuments } = await import("../src/lib/documentMigration");
  const results = await migrateHistoricalDocuments({ limit: 10, origin: ORIGIN, deps });
  assert.deepEqual(results.map((r) => [r.id, r.status, r.error ?? ""]), [
    [11, "preview_verified", ""], [12, "preview_verified", ""], [13, "recovery_required", "checksum_differs_from_recorded"],
  ]);
  assert.doesNotMatch(JSON.stringify(results), /https?:/, "results carry ids and codes only");
  for (const id of [11, 12]) {
    const row = state.docs.get(id)!;
    assert.match(row.stored_url, new RegExp(`/customer-documents/legacy/${id}-[a-f0-9]{16}$`));
    const order = (event: string) => state.events.indexOf(`${event}:${id}`);
    assert.ok(order("stored") < order("private_read") && order("private_read") < order("anonymous")
      && order("anonymous") < order("switch") && order("switch") < order("preview"), `${id}: switch only after every private check`);
    assert.equal(state.ledger.get(id)!.status, "preview_verified");
  }
  assert.equal(state.ledger.get(12)!.source, "cloudinary_api");
  assert.equal(state.ledger.get(11)!.detected_type, "image/jpeg");
  assert.equal(state.docs.get(13)!.stored_url, cloudUrl(13, "jpg"), "a mismatching file leaves the document as it was");
  assert.equal(state.ledger.get(13)!.status, "recovery_required");
  assert.deepEqual(state.audit.map((entry) => [entry.id, entry.action]), [[11, "migrated_to_private_storage"], [12, "migrated_to_private_storage"]]);

  const storesBefore = state.stores.length;
  const again = await migrateHistoricalDocuments({ limit: 10, origin: ORIGIN, deps });
  assert.deepEqual(again.map((r) => r.id), [13], "migrated documents are not picked again");
  assert.equal(state.stores.length, storesBefore, "no second private copy");
  await migrateHistoricalDocuments({ limit: 10, origin: ORIGIN, deps });
  assert.deepEqual(await migrateHistoricalDocuments({ limit: 10, origin: ORIGIN, deps }), [], "a recovery case stops after three attempts");
});

test("a failed admin preview undoes the switch; a publicly readable copy never switches", async (context) => {
  const preview = world([doc(21, JPEG, "jpg")], { previewStatus: 500 });
  await install(context, preview.query);
  const { migrateHistoricalDocuments } = await import("../src/lib/documentMigration");
  const [failed] = await migrateHistoricalDocuments({ limit: 5, origin: ORIGIN, deps: preview.deps });
  assert.deepEqual([failed.status, failed.error], ["failed", "admin_preview_failed_switch_undone"]);
  assert.equal(preview.state.docs.get(21)!.stored_url, cloudUrl(21, "jpg"), "the document points at its original again");
  assert.ok(preview.state.events.includes("undo:21"));

  context.mock.restoreAll();
  const open = world([doc(22, JPEG, "jpg")], { anonymousStatus: 200 });
  await install(context, open.query);
  const [publicCopy] = await migrateHistoricalDocuments({ limit: 5, origin: ORIGIN, deps: open.deps });
  assert.deepEqual([publicCopy.status, publicCopy.error], ["failed", "private_copy_publicly_readable"]);
  assert.equal(open.state.docs.get(22)!.stored_url, cloudUrl(22, "jpg"));
  assert.ok(!open.state.events.includes("switch:22"));
});

test("an original is deleted only when verified, unreferenced and the exact same upload", async (context) => {
  const { state, query, deps } = world([doc(31, JPEG, "jpg"), doc(32, PDF, "pdf", { delivery: 401, apiDownload: PDF }), doc(33, JPEG, "jpg"), doc(34, JPEG, "jpg")], {
    // A poster still uses document 33's file; document 34's Cloudinary record is a later upload.
    otherRows: [{ table: "poster_trips", json: JSON.stringify({ cover: cloudUrl(33, "jpg") }) }],
    recordVersion: { 34: 1800000000 },
  });
  await install(context, query);
  const { deleteMigratedOriginals, migrateHistoricalDocuments } = await import("../src/lib/documentMigration");
  await migrateHistoricalDocuments({ limit: 10, origin: ORIGIN, deps });
  const results = await deleteMigratedOriginals({ limit: 10, origin: ORIGIN, deps });
  assert.deepEqual(results.map((r) => [r.id, r.status, r.error ?? ""]), [
    [31, "deletion_verified", ""], [32, "deletion_verified", ""],
    [33, "preview_verified", "referenced_elsewhere:poster_trips"],
    [34, "preview_verified", "cloudinary_record_differs_from_document_url"],
  ]);
  assert.deepEqual(state.destroyed, ["customer-documents/doc-31", "customer-documents/doc-32"], "exactly those two assets");
  assert.equal(state.ledger.get(31)!.cdn_status, 404);
  assert.match(state.docs.get(31)!.stored_url, /blob\.vercel-storage\.com/, "the document keeps its private copy");
  assert.deepEqual(await deleteMigratedOriginals({ limit: 10, origin: ORIGIN, deps }).then((r) => r.map((x) => x.id)), [33, 34],
    "deleted originals are not touched again");
});

test("only one run at a time", async (context) => {
  const { query, deps } = world([doc(41, JPEG, "jpg")], { lockFree: false });
  await install(context, query);
  const { migrateHistoricalDocuments, deleteMigratedOriginals } = await import("../src/lib/documentMigration");
  assert.deepEqual(await migrateHistoricalDocuments({ limit: 5, origin: ORIGIN, deps }), [{ id: 0, status: "busy" }]);
  assert.deepEqual(await deleteMigratedOriginals({ limit: 5, origin: ORIGIN, deps }), [{ id: 0, status: "busy" }]);
});

test("Cloudinary URLs are parsed to exactly one asset, or refused", async () => {
  const { parseCloudinaryUrl } = await import("../src/lib/cloudinaryAdmin");
  assert.deepEqual(parseCloudinaryUrl(cloudUrl(5, "jpg")), { cloudName: "fixture-cloud", resourceType: "image", type: "upload",
    version: "1700000005", publicId: "customer-documents/doc-5", format: "jpg" });
  assert.equal(parseCloudinaryUrl("https://res.cloudinary.com/fixture-cloud/raw/upload/v1/folder/sheet.xlsx")?.publicId, "folder/sheet.xlsx");
  assert.equal(parseCloudinaryUrl("https://res.cloudinary.com/fixture-cloud/image/upload/customer-documents/no-version.jpg"), null);
  assert.equal(parseCloudinaryUrl("https://res.cloudinary.com/fixture-cloud/image/upload/v1/a.jpg?x=1"), null);
  assert.equal(parseCloudinaryUrl("https://evil.example.test/fixture-cloud/image/upload/v1/a.jpg"), null);
  const { closeNeonPool } = await import("../src/lib/neonDb");
  await closeNeonPool();
});
