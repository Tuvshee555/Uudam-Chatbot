import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

test("Messenger image receipt keeps every attachment and original position", async () => {
  applyTestEnv();
  const { imageAttachmentReceipts } = await import("../src/lib/customerImageIngest");
  for (const count of [1, 5, 13]) {
    const attachments = Array.from({ length: count }, (_, index) => ({
      type: "image", payload: { url: `https://example.test/photo-${index}`, attachment_id: `attachment-${index}` },
    }));
    const receipts = imageAttachmentReceipts(attachments);
    assert.equal(receipts.length, count);
    assert.deepEqual(receipts.map((item) => item.index), attachments.map((_, index) => index));
    assert.equal(receipts[count - 1].attachmentId, `attachment-${count - 1}`);
  }
  const mixed = imageAttachmentReceipts([
    { type: "image", payload: { url: "https://example.test/photo" } },
    { type: "file", payload: { url: "https://example.test/file" } },
    { type: "image", payload: { url: "https://example.test/photo" } },
    { type: "file", mime_type: "image/png", payload: { url: "https://example.test/image-file" } },
  ]);
  assert.deepEqual(mixed.map((item) => item.index), [0, 2, 3]);
});

test("admin image links hide storage and Facebook source URLs", async () => {
  applyTestEnv();
  const { adminCustomerDocument, verifyCustomerImagePreview } = await import("../src/lib/customerImageAccess");
  const original = {
    id: 42, mime_type: "image/jpeg", source_url: "https://facebook.example.test/temporary",
    stored_url: "https://private.blob.vercel-storage.com/customer-documents/42",
  };
  const visible = adminCustomerDocument(original as Parameters<typeof adminCustomerDocument>[0]);
  assert.equal(visible.source_url, "");
  assert.match(visible.stored_url, /^\/api\/admin\/customer-image\?/);
  assert.doesNotMatch(JSON.stringify(visible), /facebook\.example|blob\.vercel-storage/);
  const link = new URL(visible.stored_url, "https://admin.example.test");
  assert.equal(verifyCustomerImagePreview(42, Number(link.searchParams.get("expires")),
    link.searchParams.get("signature") || ""), true);
  assert.equal(verifyCustomerImagePreview(43, Number(link.searchParams.get("expires")),
    link.searchParams.get("signature") || ""), false);
});

test("image events without a Messenger mid have distinct stable retry keys", async () => {
  applyTestEnv();
  const { buildEventKey } = await import("../src/lib/webhookDedup");
  const first = { timestamp: 1000, message: { text: "photo", attachments: [{ payload: { attachment_id: "a" } }] } };
  const second = { timestamp: 2000, message: { text: "photo", attachments: [{ payload: { attachment_id: "b" } }] } };
  assert.equal(buildEventKey("facebook", "customer-a", first), buildEventKey("facebook", "customer-a", first));
  assert.notEqual(buildEventKey("facebook", "customer-a", first), buildEventKey("facebook", "customer-a", second));
  assert.notEqual(buildEventKey("facebook", "customer-a", first), buildEventKey("facebook", "customer-b", first));
});
