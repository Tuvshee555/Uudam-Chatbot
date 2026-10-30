# Historical customer documents: migration to private storage

Status (2026-10-30): **planned, dry run done, nothing migrated or deleted.** Running the migration
and deleting the Cloudinary originals each need the owner's separate approval.

Since `8eb84b4` the admin API never returns a public file URL: every document is served through a
signed, expiring admin link that the server proxies. That only hides the URLs. The 102 historical
files are still public on Cloudinary to anyone who already has a link, until this migration and
the later deletion are done.

## Dry run (read-only): `node scripts/document-migration-dry-run.mjs`

Results on 2026-10-30:

| | |
|---|---|
| Documents | 102, all on Cloudinary, none on private Blob yet, none retention-hidden |
| Types | 69 images, 15 HTML link snapshots, 10 audio, 6 video, 1 spreadsheet, 1 PDF |
| Total size | 34.2 MB (largest file 5.5 MB) |
| Cloudinary reachable | 101 of 102. Every one matches its recorded SHA-256 |
| Unreachable | **doc 91 (PDF)**: Cloudinary returns 401 (its PDF-delivery restriction) and the Meta source has expired (403) |
| Same content | 14 image rows are byte-identical to doc 17 (category `other`, likely a sticker) |
| Meta source links | 96 rows: 57 expired (403), **32 still open (200)**, 7 link-shim redirects (302) |
| Public URLs in extracted data | 10 documents |
| Audit table | 129 of 137 rows hold Cloudinary/Meta URLs in `before_json`/`after_json` (not exposed by any API) |
| Admin inbox | 76 real customer messages keep Meta CDN file links in `travel_conversations.attachments` |

Cloudinary serves the HTML snapshots as `application/octet-stream`. The proxy already downloads
every type other than images and PDFs as an attachment.

## Migration (one script, dry run by default)

For each row whose `stored_url` is on `res.cloudinary.com`, in id order, under a Postgres advisory
lock (one run at a time) and capped per run:

1. **Download** server-side from Cloudinary (`redirect: "error"`, timeout). If that fails, use
   Cloudinary's authenticated download API. This needs a valid `CLOUDINARY_API_KEY`/`SECRET`; the
   key in `.env.local` is rejected ("unknown api_key"), so use the production one.
2. **Verify integrity**: the SHA-256 must equal `content_sha256`/`image_sha256`. On a mismatch, stop
   for that row and report it.
3. **Upload** with `storeCustomerImage` to a deterministic private key,
   `customer-documents/legacy/<id>-<sha256 prefix>`, with the recorded `mime_type`. Each row gets its
   own object (no sharing between the 14 identical rows), so deleting one document never affects
   another.
4. **Verify the private copy**: a private `get` returns the same SHA-256, and an anonymous fetch of
   the Blob URL is refused.
5. **Switch the row** with a compare-and-swap:
   `UPDATE ... SET stored_url=<blob> WHERE id=$1 AND stored_url=<old cloudinary url>`, plus an audit
   row `migrated_to_private_storage` that keeps the old URL. Blank `source_url` for Meta CDN hosts;
   the old value stays in the audit row.

**Safe retries without duplicates:** the key is deterministic, and a row already on Blob is
skipped. If the object exists but the row was not switched (a crash between steps 3 and 5), the
script re-verifies the hash and only then switches. A second or concurrent run can't apply twice
(advisory lock plus compare-and-swap). Failures are recorded per row; nothing is retried in a loop.

**Missing or expired sources:** these are not migrated and are listed for staff. Doc 91 needs the
authenticated API (step 1). If that fails too, the row stays as it is and is marked unrecoverable.
Meta source links are never used as a source: they expire, and the Cloudinary copies are verified.

**After the run:** re-run the dry run. It must show 0 rows on Cloudinary, except listed
unrecoverables. Open a signed admin link for one document of each type, and check the system page's
private-storage self-test.

## Deleting the Cloudinary originals (separate approval, irreversible)

Only after the migration is verified and the owner approves:

- Write a manifest (id, Cloudinary public_id and resource type, SHA-256, Blob key) in private storage.
- Re-verify each Blob copy's hash, then delete via the Cloudinary Admin API with CDN invalidation,
  using the production key.
- Re-run: every old URL must return 404, and every admin link still 200.

## Related exposure, not covered by this migration

- **Admin inbox:** 76 real customer messages return Meta CDN links (32 of the matching document
  sources still open). Fix: in the inbox API, replace each customer file link with the matching
  document's signed link, or drop it.
- **Meta links can't be revoked by us.** They expire on Meta's schedule.
- **Deleting a document** (`deleteCustomerDocument`) doesn't remove its stored file from Blob or
  Cloudinary. Retention should delete the object too.
- **Audit rows** keep old URLs. After the originals are deleted those URLs are dead. Scrub them only
  if the owner wants it.
