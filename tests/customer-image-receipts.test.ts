import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

test("image receipts survive retries, large albums and failed downloads", async (context) => {
  applyTestEnv({ NEON_DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/image-receipts" });
  const records = new Map<string, Record<string, unknown>>();
  let nextId = 1;
  const result = (rows: unknown[] = []) => ({ rows, rowCount: rows.length });
  const query = async (sql: string, params: unknown[] = []) => {
    if (/INSERT INTO travel_customer_documents/i.test(sql)) {
      const key = [params[0], params[1], params[2], params[3], params[4]].join(":");
      let row = records.get(key);
      if (!row) {
        row = { id: nextId++, platform: params[0], sender_id: params[1], page_id: params[2],
          event_key: params[3], attachment_index: params[4], source_url: params[6],
          mime_type: "image/unknown", ingest_status: "pending", ingest_attempts: 0 };
        records.set(key, row);
      }
      return result([row]);
    }
    if (/SET ingest_status='processing'/i.test(sql)) {
      const row = [...records.values()].find((item) => item.id === params[0]);
      if (!row || row.ingest_status === "stored") return result();
      row.ingest_status = "processing";
      row.ingest_attempts = Number(row.ingest_attempts) + 1;
      return result([row]);
    }
    if (/SET ingest_status=CASE WHEN ingest_attempts/i.test(sql)) {
      const row = [...records.values()].find((item) => item.id === params[0]);
      if (row) row.ingest_status = "retry";
      return result();
    }
    return result();
  };
  const { Pool } = await import("pg");
  context.mock.method(Pool.prototype, "query", query as unknown as typeof Pool.prototype.query);
  context.mock.method(Pool.prototype, "connect", (async () => ({ query, release() {} })) as unknown as typeof Pool.prototype.connect);
  try {
    const { reserveCustomerImages, processReservedCustomerImages } = await import("../src/lib/customerImageIngest");
    const album = Array.from({ length: 13 }, (_, index) => ({ type: "image",
      payload: { url: `https://example.test/image-${index}` } }));
    const input = { platform: "facebook" as const, senderId: "customer-a", pageId: "page-a",
      eventKey: "message-a", attachments: album };
    const first = await reserveCustomerImages(input);
    assert.equal(first.length, 13);
    assert.equal(records.size, 13);
    await reserveCustomerImages(input);
    assert.equal(records.size, 13, "Facebook redelivery reuses every attachment receipt");
    await reserveCustomerImages({ ...input, senderId: "customer-b", eventKey: "message-b",
      attachments: album.slice(0, 1) });
    assert.equal(records.size, 14, "customers remain separate");
    const [missing] = await reserveCustomerImages({ ...input, eventKey: "missing-source",
      attachments: [{ type: "image", payload: {} }] });
    assert.equal(records.size, 15, "missing URL still has a visible receipt");
    assert.deepEqual(await processReservedCustomerImages([missing]), []);
    assert.equal(records.get("facebook:customer-a:page-a:missing-source:0")?.ingest_status, "retry");
  } finally {
    const { closeNeonPool } = await import("../src/lib/neonDb");
    await closeNeonPool();
  }
});
