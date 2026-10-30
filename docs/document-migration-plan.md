# Historical customer documents: migration to private storage

Status (2026-10-30): **done and verified.** All 102 historical documents are in the private Blob
store, their rows point there, and every Cloudinary original was deleted after verification.

## Result

| | |
|---|---|
| Historical documents | 102 (images 69, HTML link snapshots 15, audio 10, video 6, spreadsheet 1, PDF 1), 34.2 MB |
| Migrated to private Blob | 102. 101 were downloaded from their Cloudinary delivery URL; doc 91 (a PDF whose delivery Cloudinary blocks) came through Cloudinary's authenticated download API |
| Checksum | 102 of 102 match the SHA-256 recorded when the customer sent the file, before upload and again when read back privately |
| Private access | 102 refuse anonymous reads; 102 return the same bytes through the signed admin preview |
| Database | 102 rows switched by compare-and-swap; an audit row each (`migrated_to_private_storage`) |
| Cloudinary originals | 102 deleted, one exact asset at a time (`invalidate=true`): the asset's own record matched the document's URL (same upload version) and no other table referenced it. Afterwards Cloudinary reports each asset not found, and each old URL answers 404 |
| Unrecoverable | none |
| Private store audit | 122 objects (105 documents incl. 3 new ones, 17 inbox copies), all referenced, 0 orphaned, 0 missing |

An earlier version of this plan said the Cloudinary key in `.env.local` was rejected. That was
wrong: `.env.local` (local development values only) has no Cloudinary credentials at all. The
check had sent empty credentials. The migration runs on the server with the production
credentials.

## Inbox attachments (`travel_conversations.attachments`)

100 customer attachments: 76 linked to their (now private) document, 17 copied privately while
their Meta link still worked, 7 already expired at Meta (images from 2026-09-16..10-05 that were
never stored as documents). The inbox shows a note in their place. Conversation rows are not
changed; the links live in `travel_conversation_attachments`.

## Meta CDN links

Meta's attachment URLs (`*.fbcdn.net`, `cdn.fbsbx.com`) are signed by Meta and expire on their
own (`oe=` parameter). There is no API to revoke one, and the app never returns them anymore (the
documents API, inbox API and message text carry only signed admin links). Whoever already holds
such a link can open it until Meta's expiry.

## How it runs (`src/lib/documentMigration.ts`, `/api/admin/document-migration`)

An admin calls it in small batches (`{ action: "migrate" | "delete_originals" | "attachments" |
"storage_audit", limit }`); `GET` returns counts only.

1. Download from the delivery URL (no redirects), else Cloudinary's authenticated download.
2. The SHA-256 must equal the recorded one, and the size the asset's Cloudinary record. Images and
   PDFs are also checked by their file signature.
3. Upload privately under a fixed key, `customer-documents/legacy/<id>-<sha256 prefix>`.
4. Read back with the token (same SHA-256); an anonymous read must be refused.
5. Switch the row with a compare-and-swap, then the signed admin preview must return the same
   bytes, or the switch is undone.
6. Separately, delete the original only after re-running checks 4–5, confirming the asset's own
   Cloudinary record is the same upload, and finding no reference in any other table.

Every step is recorded in `travel_document_migration` (pending, downloaded, uploaded,
checksum_verified, private_verified, db_updated, preview_verified, original_deleted,
deletion_verified, recovery_required, failed). Re-runs continue where a document stopped and never
make a second copy. One run at a time (advisory lock); a recovery case stops after three attempts.
Tests: `tests/document-migration.test.ts`.

`scripts/document-migration-dry-run.mjs` is kept as a read-only check. After the migration it
reports 0 documents on Cloudinary.

## Deleting documents (`src/lib/customerDocumentPurge.ts`)

An admin's delete hides a document (restorable). "Delete permanently" on a hidden document that is
not payment evidence removes the stored file when no other document or inbox copy uses it, keeps
a tombstone without the file or extracted data, and records a failure for the daily retry (shown
in the admin issues). The storage audit lists unreferenced private files and deletes nothing.
