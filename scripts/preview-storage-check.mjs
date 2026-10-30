/**
 * One-time, Preview-only check of the private customer-image Blob store (owner's Option A,
 * 2026-10-30). Runs at build time of the `integrate/customer-image-storage` Preview and
 * nowhere else; this commit is reverted before the branch is merged.
 *
 * Uses only @vercel/blob: no application code, no database, no app logging. Uploads one
 * uniquely named private test object, checks that an anonymous read is refused and a
 * token read returns it, then deletes exactly that object. Prints pass/fail per step and
 * safe error codes only — never the token, a URL, or file contents. Never fails the build.
 */
import { randomUUID } from "node:crypto";

const BRANCH = "integrate/customer-image-storage";
const env = process.env.VERCEL_ENV || "";
const branch = process.env.VERCEL_GIT_COMMIT_REF || "";

if (env !== "preview" || branch !== BRANCH) {
  console.log(`STORAGE_CHECK skipped (env=${env || "local"}, branch matches=${branch === BRANCH})`);
  process.exit(0);
}

// Nothing here may reach the application database.
for (const key of Object.keys(process.env)) if (/DATABASE_URL|^NEON_|^PG/i.test(key)) delete process.env[key];

const safe = (error) => (error instanceof Error ? (error.name && error.name !== "Error" ? error.name : "error") : "error");
const result = { tokenPresent: Boolean(process.env.BLOB_READ_WRITE_TOKEN), upload: "not_run", anonymousReadRefused: "not_run",
  privateRead: "not_run", removed: "not_run", errors: [] };
const body = "uudam-private-storage-check";
let url = "";

try {
  if (!result.tokenPresent) throw Object.assign(new Error(), { name: "private_blob_not_configured" });
  const { put, get, del } = await import("@vercel/blob");
  try {
    const blob = await put(`customer-documents/_storage-check/preview-${randomUUID()}.txt`, body, {
      access: "private", addRandomSuffix: false, allowOverwrite: false, contentType: "text/plain",
    });
    url = blob.url;
    result.upload = "pass";
  } catch (error) { result.upload = "fail"; result.errors.push(`upload:${safe(error)}`); }

  if (url) {
    try {
      const anonymous = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      await anonymous.body?.cancel();
      result.anonymousReadRefused = anonymous.ok ? "fail" : "pass";
      result.anonymousStatus = anonymous.status;
      if (anonymous.ok) result.errors.push("anonymous_read:allowed");
    } catch (error) { result.anonymousReadRefused = "fail"; result.errors.push(`anonymous_read:${safe(error)}`); }

    try {
      const read = await get(url, { access: "private" });
      const text = read && read.statusCode === 200 ? await new Response(read.stream).text() : "";
      result.privateRead = text === body ? "pass" : "fail";
      if (text !== body) result.errors.push(`private_read_status:${read?.statusCode ?? "none"}`);
    } catch (error) { result.privateRead = "fail"; result.errors.push(`private_read:${safe(error)}`); }

    try { await del(url); result.removed = "pass"; }
    catch (error) { result.removed = "fail"; result.errors.push(`remove:${safe(error)}`); }
  }
} catch (error) {
  result.errors.push(safe(error));
}

console.log(`STORAGE_CHECK ${JSON.stringify(result)}`);
