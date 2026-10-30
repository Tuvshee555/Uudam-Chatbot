import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

/**
 * Production 2026-10-30: the admin inbox returned the Meta CDN links of 97 photos and files
 * from 76 real customer messages. Every inbox attachment now leaves the API as a signed,
 * expiring link bound to its message and position; the server resolves it to the private copy
 * (or, for an attachment never copied, fetches it itself) and never redirects. A document
 * hidden by deletion or retention is not shown through the inbox either.
 */
applyTestEnv({ NEON_DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/inbox-privacy" });

const CDN = "https://scontent.xx.fbcdn.net/v/t1.15752-9/fixture.jpg?oh=fixture&oe=FFFFFFFF";

test("inbox messages carry signed attachment links only; post links customers share stay readable", async () => {
  const { adminConversationMessages, verifyConversationAttachmentPreview, verifyCustomerImagePreview } = await import("../src/lib/customerImageAccess");
  const [customer, bot, customerFile] = adminConversationMessages([
    { id: 501, role: "user", created_at: "2098-01-01T00:00:00Z", text: `see https://www.facebook.com/share/p/fixture/ and ${CDN}`,
      attachments: [{ type: "image", url: CDN }, { type: "file", url: "https://cdn.fbsbx.com/v/t59/fixture.pdf?oe=1" }] },
    { id: 502, role: "assistant", created_at: "2098-01-01T00:00:01Z", text: "Аяллын зураг",
      attachments: [{ type: "image", url: "https://res.cloudinary.com/fixture/image/upload/v1/trip.jpg", caption: "Аялал" },
        { type: "file", url: "https://admin.example.test/api/poster-pdf?trip=fixture-trip" }] },
    // A customer's file is signed whatever host it came from.
    { id: 503, role: "user", created_at: "2098-01-01T00:00:02Z", text: "",
      attachments: [{ type: "file", url: "https://admin.example.test/api/poster-pdf?trip=fixture-trip" }] },
  ]);
  assert.doesNotMatch(JSON.stringify([customer, bot]), /fbcdn|fbsbx|cloudinary|blob\.vercel-storage/, "no raw file URL in the inbox payload");
  assert.match(customer.text, /facebook\.com\/share\/p\/fixture/, "a shared post link stays visible to staff");
  assert.equal(customer.attachments!.length, 2);
  assert.equal(bot.attachments![0].caption, "Аялал");
  assert.match(bot.attachments![0].url, /^\/api\/admin\/conversation-attachment\?row=502&index=0&/, "a trip photo on a file CDN is signed too");
  assert.equal(bot.attachments![1].url, "https://admin.example.test/api/poster-pdf?trip=fixture-trip",
    "the bot's link to this app's own public trip PDF stays openable");
  assert.match(customerFile.attachments![0].url, /^\/api\/admin\/conversation-attachment\?row=503&index=0&/);
  const link = new URL(customer.attachments![1].url, "https://admin.example.test");
  const [row, index, expires, signature] = ["row", "index", "expires", "signature"].map((key) => link.searchParams.get(key)!);
  assert.deepEqual([row, index], ["501", "1"]);
  assert.equal(verifyConversationAttachmentPreview(501, 1, Number(expires), signature), true);
  assert.equal(verifyConversationAttachmentPreview(501, 0, Number(expires), signature), false, "another attachment of the same message");
  assert.equal(verifyConversationAttachmentPreview(502, 1, Number(expires), signature), false, "another message");
  assert.equal(verifyCustomerImagePreview(501, Number(expires), signature), false, "an inbox link is not a document link");
});

test("an inbox attachment resolves to its private copy, its document, or (never copied) the server's own fetch", async (context) => {
  const conversations = new Map<number, { sender_id: string; attachments: Array<{ type: string; url: string }> }>([
    [1, { sender_id: "fixture-a", attachments: [{ type: "image", url: CDN }] }],
    [2, { sender_id: "fixture-a", attachments: [{ type: "image", url: `${CDN}&n=2` }] }],
    [3, { sender_id: "fixture-b", attachments: [{ type: "image", url: `${CDN}&n=3` }] }],
    [4, { sender_id: "fixture-b", attachments: [{ type: "file", url: `${CDN}&n=4` }] }],
  ]);
  const copies = new Map([["1:0", { status: "private", document_id: null, blob_url: "https://fixture.private.blob.vercel-storage.com/customer-documents/inbox/1-0-abc", mime_type: "image/jpeg" }]]);
  const documents = [
    { sender_id: "fixture-a", source_url: `${CDN}&n=2`, stored_url: "https://fixture.private.blob.vercel-storage.com/customer-documents/legacy/7-abc", mime_type: "image/jpeg", hidden: false },
    { sender_id: "fixture-b", source_url: `${CDN}&n=3`, stored_url: "https://fixture.private.blob.vercel-storage.com/customer-documents/legacy/8-abc", mime_type: "image/jpeg", hidden: true },
  ];
  const query = async (sql: string, params: unknown[] = []) => {
    const out = (list: unknown[]) => ({ rows: list, rowCount: list.length });
    if (/FROM travel_conversations WHERE id=\$1/.test(sql)) { const row = conversations.get(Number(params[0])); return out(row ? [row] : []); }
    if (/FROM travel_conversation_attachments WHERE conversation_id=\$1 AND idx=\$2/.test(sql)) { const copy = copies.get(`${params[0]}:${params[1]}`); return out(copy ? [copy] : []); }
    if (/WHERE sender_id=\$1 AND source_url=\$2/.test(sql)) return out(documents.filter((doc) => doc.sender_id === params[0] && doc.source_url === params[1]));
    return out([]);
  };
  const { Pool } = await import("pg");
  context.mock.method(Pool.prototype, "query", query as unknown as typeof Pool.prototype.query);
  context.mock.method(Pool.prototype, "connect", (async () => ({ query, release() {} })) as unknown as typeof Pool.prototype.connect);
  const { resolveConversationAttachment } = await import("../src/lib/conversationAttachments");
  assert.deepEqual(await resolveConversationAttachment(1, 0), { kind: "serve", url: copies.get("1:0")!.blob_url, mimeType: "image/jpeg" });
  assert.deepEqual(await resolveConversationAttachment(2, 0), { kind: "serve", url: documents[0].stored_url, mimeType: "image/jpeg" });
  assert.deepEqual(await resolveConversationAttachment(3, 0), { kind: "hidden" }, "a deleted or retention-hidden document stays hidden");
  assert.deepEqual(await resolveConversationAttachment(4, 0), { kind: "serve", url: `${CDN}&n=4` }, "never copied: the server fetches it");
  assert.deepEqual(await resolveConversationAttachment(4, 3), { kind: "missing" });
  assert.deepEqual(await resolveConversationAttachment(99, 0), { kind: "missing" });
  const { closeNeonPool } = await import("../src/lib/neonDb");
  await closeNeonPool();
});

function fakeResponse() {
  const headers: Record<string, string> = {};
  const chunks: Buffer[] = [];
  const res = Object.assign(new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } }), {
    setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; },
    get headersSent() { return chunks.length > 0; },
  });
  return { res, headers, body: () => Buffer.concat(chunks).toString() };
}

test("files are streamed by the server: private reads with the token, others fetched without redirects", async (context) => {
  const fetched: Array<{ url: string; redirect?: string }> = [];
  context.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    fetched.push({ url: String(input), redirect: init?.redirect });
    if (String(input).includes("expired")) return new Response("URL signature expired", { status: 403 });
    return new Response("cdn-bytes", { status: 200, headers: { "content-type": String(input).includes(".html") ? "text/html" : "image/jpeg" } });
  });
  const { serveAdminFile } = await import("../src/lib/adminFileProxy");
  const privateRead = async () => ({ statusCode: 200, stream: new Blob(["private-bytes"]).stream(), blob: { contentType: "application/pdf" } });
  const pdf = fakeResponse();
  assert.equal(await serveAdminFile(pdf.res as never, { url: "https://fixture.private.blob.vercel-storage.com/customer-documents/x" }, privateRead as never), "served");
  assert.deepEqual([pdf.headers["content-type"], pdf.headers["content-disposition"], pdf.headers["cache-control"], pdf.body()],
    ["application/pdf", undefined, "private, no-store", "private-bytes"]);
  const page = fakeResponse();
  assert.equal(await serveAdminFile(page.res as never, { url: "https://res.cloudinary.com/fixture/raw/upload/v1/page.html" }), "served");
  assert.deepEqual([page.headers["content-type"], page.headers["content-disposition"]], ["application/octet-stream", "attachment"], "HTML is never rendered");
  assert.equal(await serveAdminFile(fakeResponse().res as never, { url: `${CDN}&expired=1` }), "unavailable", "an expired Meta link");
  assert.equal(await serveAdminFile(fakeResponse().res as never, { url: "https://evil.example.test/a.jpg" }), "not_found");
  assert.equal(await serveAdminFile(fakeResponse().res as never, { url: "http://res.cloudinary.com/fixture/a.jpg" }), "not_found");
  assert.ok(fetched.length === 2 && fetched.every((entry) => entry.redirect === "error"), "only our stores and Meta's CDN, never following a redirect");
  assert.ok(!fetched.some((entry) => entry.url.includes("evil")));
});
