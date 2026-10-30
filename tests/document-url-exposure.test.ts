import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

/**
 * Production 2026-10-30: the admin documents API still returned the public Cloudinary URL of
 * 33 historical non-image files, 17 Facebook CDN links and Cloudinary URLs nested in the
 * extracted data of 9 documents. Every document now leaves the API with signed admin links
 * only, and its extracted data keeps everything except public file URLs. (This hides the URLs;
 * the historical Cloudinary files are not private until they are migrated.)
 */
// neonDb reads the environment once, so both tests share one.
const ENV = { NEON_DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/document-exposure" };
const PUBLIC = /res\.cloudinary\.com|fbcdn\.net|fbsbx\.com|facebook\.com|blob\.vercel-storage\.com|cdninstagram\.com/;
const kinds: Array<[string, string]> = [
  ["image/jpeg", "https://res.cloudinary.com/demo/image/upload/v1/customer-1.jpg"],
  ["application/pdf", "https://res.cloudinary.com/demo/raw/upload/v1/customer-2.pdf"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "https://res.cloudinary.com/demo/raw/upload/v1/customer-3.xlsx"],
  ["audio/ogg", "https://res.cloudinary.com/demo/video/upload/v1/customer-4.ogg"],
  ["video/mp4", "https://res.cloudinary.com/demo/video/upload/v1/customer-5.mp4"],
  ["text/html", "https://res.cloudinary.com/demo/raw/upload/v1/customer-6.html"],
  ["application/pdf", "https://store.private.blob.vercel-storage.com/customer-documents/files/x"],
];

test("every document type leaves the admin API with signed links only and no public file URL", async () => {
  applyTestEnv(ENV);
  const { adminCustomerDocument } = await import("../src/lib/customerImageAccess");
  kinds.forEach(([mime, stored], index) => {
    const doc = adminCustomerDocument({
      id: 100 + index, mime_type: mime, stored_url: stored, category: "passport",
      source_url: "https://scontent.xx.fbcdn.net/v/t1.15752-9/temporary.jpg?oh=fixture",
      attachment_id: "fixture-attachment", event_key: "facebook:mid:fixture",
      extracted_json: {
        full_name: "FIXTURE PERSON", passport_number: "AB0000000", confidence: 0.9,
        file: { name: "invoice.pdf", size: 1234, link_url: "https://www.facebook.com/share/p/fixture/", link_title: "Аялал",
          preview_url: "https://res.cloudinary.com/demo/image/upload/v1/preview.jpg", website: "https://example.test/trip" },
        pages: [{ url: "https://res.cloudinary.com/demo/image/upload/v1/page-1.jpg", text: "Нүүр хуудас" },
          { note: "see https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1 for the scan", amount: 1_500_000 }],
        trip_match: { id: "fixture-trip", route_name: "ФИКСТУР АЯЛАЛ" },
      },
    } as never);
    assert.match(doc.stored_url, new RegExp(`^/api/admin/customer-image\\?id=${100 + index}&expires=\\d+&signature=[a-f0-9]{64}$`), mime);
    assert.equal(doc.source_url, "", `${mime}: no source URL`);
    assert.equal(doc.attachment_id, "");
    assert.equal(doc.event_key, "");
    assert.doesNotMatch(JSON.stringify(doc), PUBLIC, `${mime}: no public file URL anywhere, nested data included`);
    const extracted = doc.extracted_json as {
      full_name: string; passport_number: string; trip_match: unknown;
      file: Record<string, unknown>; pages: Array<Record<string, unknown>>;
    };
    assert.equal(extracted.full_name, "FIXTURE PERSON", "document data is kept");
    assert.equal(extracted.passport_number, "AB0000000");
    assert.equal(extracted.file.name, "invoice.pdf");
    assert.equal(extracted.file.link_title, "Аялал");
    assert.equal(extracted.file.website, "https://example.test/trip", "an ordinary web link is kept");
    assert.equal(extracted.pages[0].text, "Нүүр хуудас");
    assert.equal(extracted.pages[1].amount, 1_500_000);
    assert.match(String(extracted.pages[1].note),/^see\s+for the scan$/, "a URL inside text is removed, the text kept");
    assert.deepEqual(extracted.trip_match, { id: "fixture-trip", route_name: "ФИКСТУР АЯЛАЛ" });
  });
});

test("a historical file is streamed by the server through the signed link, never redirected", async (context) => {
  applyTestEnv(ENV);
  const rows = new Map<number, { stored_url: string; mime_type: string }>([
    [1, { stored_url: "https://res.cloudinary.com/demo/raw/upload/v1/customer.pdf", mime_type: "application/pdf" }],
    [2, { stored_url: "https://res.cloudinary.com/demo/raw/upload/v1/customer.html", mime_type: "text/html" }],
    [3, { stored_url: "https://res.cloudinary.com/demo/video/upload/v1/customer.mp4", mime_type: "video/mp4" }],
    [4, { stored_url: "https://evil.example.test/file.pdf", mime_type: "application/pdf" }],
  ]);
  const query = async (_sql: string, params: unknown[] = []) => {
    const row = rows.get(Number(params[0]));
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  };
  const { Pool } = await import("pg");
  context.mock.method(Pool.prototype, "query", query as unknown as typeof Pool.prototype.query);
  context.mock.method(Pool.prototype, "connect", (async () => ({ query, release() {} })) as unknown as typeof Pool.prototype.connect);
  const fetched: Array<{ url: string; redirect?: string }> = [];
  context.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    fetched.push({ url: String(input), redirect: init?.redirect });
    const type = String(input).endsWith(".pdf") ? "application/pdf" : String(input).endsWith(".html") ? "text/html" : "video/mp4";
    return new Response("fixture-bytes", { status: 200, headers: { "content-type": type } });
  });
  const { customerImagePreviewUrl } = await import("../src/lib/customerImageAccess");
  const { default: handler } = await import("../src/pages/api/admin/customer-image");
  const call = async (id: number) => {
    const link = new URL(customerImagePreviewUrl(id), "https://admin.example.test");
    const headers: Record<string, string> = {};
    let status = 200;
    const chunks: Buffer[] = [];
    const { Writable } = await import("node:stream");
    const res = Object.assign(new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } }), {
      status(code: number) { status = code; return res; }, setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; },
      get headersSent() { return chunks.length > 0; },
    });
    await handler({ method: "GET", query: Object.fromEntries(link.searchParams) } as never, res as never);
    return { status, headers, body: Buffer.concat(chunks).toString() };
  };
  const pdf = await call(1);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers["content-type"], "application/pdf", "a PDF opens in the browser");
  assert.equal(pdf.headers["content-disposition"], undefined);
  assert.equal(pdf.body, "fixture-bytes", "the bytes come from the server, not a redirect");
  assert.equal(pdf.headers.location, undefined, "never redirected to the public URL");
  const html = await call(2);
  assert.equal(html.headers["content-type"], "application/octet-stream", "HTML is never rendered");
  assert.equal(html.headers["content-disposition"], "attachment");
  const video = await call(3);
  assert.equal(video.headers["content-disposition"], "attachment");
  assert.ok(fetched.every((entry) => entry.redirect === "error"), "the upstream fetch refuses redirects");
  assert.equal((await call(4)).status, 404, "only our own stores are proxied");
  assert.ok(!fetched.some((entry) => entry.url.includes("evil.example.test")));
  const { closeNeonPool } = await import("../src/lib/neonDb");
  await closeNeonPool();
});
