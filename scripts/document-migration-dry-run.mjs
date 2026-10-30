// READ-ONLY dry run for the historical customer-document migration (docs/document-migration-plan.md).
// Writes nothing to the database or any store: a read-only DB session, each Cloudinary file
// downloaded into memory and hashed, Meta source links checked with HEAD. Prints aggregates only;
// per-document detail (ids, hosts, statuses, sizes, hash results - never URLs) goes to argv[2]
// (default tmp/document-migration-dry-run.json, which is gitignored).
//
//   node scripts/document-migration-dry-run.mjs [out.json]
//
// Uses NEON_DATABASE_URL from the environment or .env.local.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import pg from "pg";

const fileEnv = existsSync(".env.local")
  ? Object.fromEntries(readFileSync(".env.local", "utf8").split(/\r?\n/)
    .map((line) => line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]))
  : {};
const dbUrl = process.env.NEON_DATABASE_URL || fileEnv.NEON_DATABASE_URL;
if (!dbUrl) throw new Error("NEON_DATABASE_URL is not set");
const out = process.argv[2] || "tmp/document-migration-dry-run.json";

const client = new pg.Client({ connectionString: dbUrl });
await client.connect();
await client.query("SET default_transaction_read_only = on");
const { rows } = await client.query(`SELECT id, mime_type, category, ingest_status, stored_url, source_url,
  image_sha256, content_sha256, extracted_json::text AS extracted, retention_hidden_at IS NOT NULL AS hidden
  FROM travel_customer_documents ORDER BY id`);
const audit = await client.query(`SELECT count(*)::int AS rows, count(*) FILTER (WHERE
  before_json::text ~ 'cloudinary\\.com|fbcdn\\.net|fbsbx\\.com' OR after_json::text ~ 'cloudinary\\.com|fbcdn\\.net|fbsbx\\.com')::int AS with_urls
  FROM travel_customer_document_audit`);
const inbox = await client.query(`SELECT count(*)::int AS rows FROM travel_conversations
  WHERE role = 'user' AND sender_id NOT LIKE 'demo:%' AND attachments::text ~ 'fbcdn\\.net|fbsbx\\.com|res\\.cloudinary\\.com'`);
await client.end();

const host = (url) => { try { return new URL(url).hostname; } catch { return url ? "invalid" : ""; } };
const kind = (mime) => (mime.startsWith("image/") ? "image" : mime === "application/pdf" ? "pdf" : mime || "unknown");
const details = [];
const firstWithHash = new Map();
for (const row of rows) {
  const d = { id: Number(row.id), kind: kind(row.mime_type), mime: row.mime_type, category: row.category, ingest: row.ingest_status,
    hidden: row.hidden, stored_host: host(row.stored_url), source_host: host(row.source_url),
    extracted_public_urls: (row.extracted.match(/https?:\/\/[^\s"]*(cloudinary\.com|fbcdn\.net|fbsbx\.com|facebook\.com)[^\s"]*/g) || []).length };
  if (/cloudinary\.com$/.test(d.stored_host)) {
    try {
      const response = await fetch(row.stored_url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
      d.stored_status = response.status;
      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        const sha = createHash("sha256").update(buffer).digest("hex");
        const recorded = row.content_sha256 || row.image_sha256 || "";
        d.bytes = buffer.length;
        d.served_type = (response.headers.get("content-type") || "").split(";")[0];
        d.recorded_hash = recorded ? (recorded === sha ? "match" : "differs") : "none";
        d.content_dup_of = firstWithHash.get(sha) ?? null;
        if (!firstWithHash.has(sha)) firstWithHash.set(sha, d.id);
      }
    } catch (error) { d.stored_status = error?.name || "error"; }
  }
  if (/(?:fbcdn\.net|fbsbx\.com|facebook\.com)$/.test(d.source_host)) {
    try {
      const response = await fetch(row.source_url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(15_000) });
      d.source_status = response.status;
    } catch (error) { d.source_status = error?.name || "error"; }
  }
  details.push(d);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(details, null, 1));

const tally = (key, list = details) => list.reduce((m, d) => ((m[d[key]] = (m[d[key]] || 0) + 1), m), {});
const onCloudinary = details.filter((d) => /cloudinary/.test(d.stored_host));
const withSource = details.filter((d) => d.source_status !== undefined);
console.log(JSON.stringify({
  documents: details.length,
  by_kind: tally("kind"),
  by_stored_host: tally("stored_host"),
  retention_hidden: details.filter((d) => d.hidden).length,
  cloudinary: {
    total: onCloudinary.length,
    by_status: tally("stored_status", onCloudinary),
    unreachable_ids: onCloudinary.filter((d) => d.stored_status !== 200).map((d) => d.id),
    bytes_total: onCloudinary.reduce((sum, d) => sum + (d.bytes || 0), 0),
    recorded_hash: tally("recorded_hash", onCloudinary.filter((d) => d.bytes)),
    same_content_as_an_earlier_row: onCloudinary.filter((d) => d.content_dup_of).length,
  },
  meta_source_links: { total: withSource.length, by_status: tally("source_status", withSource) },
  docs_with_public_urls_in_extracted: details.filter((d) => d.extracted_public_urls > 0).length,
  audit_rows: audit.rows[0],
  real_inbox_rows_with_customer_file_urls: inbox.rows[0].rows,
  detail_file: out,
}, null, 1));
