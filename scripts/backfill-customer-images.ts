/** Recover images recorded in chat history before durable image receipts existed.
 * Run with --apply only after BLOB_READ_WRITE_TOKEN is configured. No customer
 * names, URLs, or document contents are printed.
 */
import { queryNeon, closeNeonPool } from "../src/lib/neonDb";
import { processReservedCustomerImages, reserveCustomerImages } from "../src/lib/customerImageIngest";
import type { Platform } from "../src/lib/webhookDedup";

type HistoricalImage = {
  conversation_id: number;
  sender_id: string;
  platform: Platform;
  created_at: string;
  attachment_index: number;
  url: string;
};

async function sourceIsReachable(url: string) {
  if (!url.startsWith("https://")) return false;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    const image = response.ok && (response.headers.get("content-type") || "").startsWith("image/");
    await response.body?.cancel();
    return image;
  } catch { return false; }
}

async function main() {
  const apply = process.argv.includes("--apply");
  if (apply && !process.env.BLOB_READ_WRITE_TOKEN) throw new Error("BLOB_READ_WRITE_TOKEN is required for --apply");
  const result = await queryNeon<HistoricalImage>(`
    WITH images AS (
      SELECT c.id AS conversation_id, c.sender_id, c.platform, c.created_at,
        (a.ordinality - 1)::integer AS attachment_index, a.value->>'url' AS url
      FROM travel_conversations c
      CROSS JOIN LATERAL jsonb_array_elements(c.attachments) WITH ORDINALITY a
      WHERE c.role='user' AND a.value->>'type'='image' AND COALESCE(a.value->>'url','')<>''
    )
    SELECT i.* FROM images i WHERE NOT EXISTS (
      SELECT 1 FROM travel_customer_documents d
      WHERE d.sender_id=i.sender_id AND (d.source_url=i.url OR d.stored_url=i.url)
    ) ORDER BY i.created_at ASC
  `);
  if (!result) throw new Error("NEON_DATABASE_URL is required for backfill");
  const candidates = result?.rows || [];
  let reachable = 0;
  let unavailable = 0;
  let restored = 0;
  for (const image of candidates) {
    const valid = await sourceIsReachable(image.url);
    if (valid) reachable++;
    else unavailable++;
    if (!apply) continue;
    const attachments = Array.from({ length: image.attachment_index + 1 }, () => ({ type: "other" }));
    attachments[image.attachment_index] = { type: "image", payload: { url: image.url } } as typeof attachments[number];
    const [receipt] = await reserveCustomerImages({
      platform: image.platform, senderId: image.sender_id, pageId: "historical",
      eventKey: `history:${image.conversation_id}`, timestamp: new Date(image.created_at).getTime(),
      attachments,
    });
    if (!valid) {
      await queryNeon(`UPDATE travel_customer_documents
        SET ingest_status='failed', ingest_retry_at=NULL, ingest_error='historical_source_unavailable'
        WHERE id=$1 AND ingest_status<>'stored'`, [receipt.id]);
      continue;
    }
    restored += (await processReservedCustomerImages([receipt])).length;
  }
  console.log(JSON.stringify({ candidates: candidates.length, reachable, unavailable,
    ...(apply ? { restored } : { dryRun: true }) }));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : "backfill_failed"); process.exitCode = 1; })
  .finally(() => closeNeonPool());
