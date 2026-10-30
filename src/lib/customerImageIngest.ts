import { waitUntil } from "@vercel/functions";
import { processCustomerImageAttachment, type CustomerDocument } from "./customerDocuments";
import { queryNeon } from "./neonDb";
import { ensureTravelSchema } from "./travelSchema";
import { classifyError, hashIdentifier, logError, logWarn, recordCounter } from "./observability";
import type { Platform } from "./webhookDedup";
import { listTrips, type TravelTrip } from "./travelOps";

export type IncomingImageAttachment = {
  type?: string;
  id?: string;
  mime_type?: string;
  payload?: { url?: string; attachment_id?: string };
};

export function imageAttachmentReceipts(attachments: IncomingImageAttachment[]) {
  return attachments.flatMap((attachment, index) => (attachment?.type === "image"
    || (attachment?.type === "file" && attachment.mime_type?.startsWith("image/")))
    ? [{ index, url: typeof attachment.payload?.url === "string" ? attachment.payload.url.trim() : "",
      attachmentId: String(attachment.payload?.attachment_id || attachment.id || "") }]
    : []);
}

export async function reserveCustomerImages(input: {
  platform: Platform;
  senderId: string;
  pageId: string;
  eventKey: string;
  timestamp?: number;
  attachments: IncomingImageAttachment[];
}): Promise<CustomerDocument[]> {
  const images = imageAttachmentReceipts(input.attachments);
  if (!images.length) return [];
  if (!input.eventKey || !(await ensureTravelSchema())) throw new Error("customer_image_receipt_unavailable");
  const rows = await Promise.all(images.map(async (image) => {
    const result = await queryNeon<CustomerDocument>(
      `INSERT INTO travel_customer_documents
         (platform, sender_id, page_id, event_key, attachment_index, attachment_id,
          source_url, mime_type, ingest_status, ingest_retry_at, received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'image/unknown','pending',NOW(),$8)
       ON CONFLICT (platform, page_id, sender_id, event_key, attachment_index)
         WHERE event_key <> ''
       DO UPDATE SET
         source_url=CASE WHEN travel_customer_documents.stored_url='' AND EXCLUDED.source_url<>''
           THEN EXCLUDED.source_url ELSE travel_customer_documents.source_url END,
         attachment_id=CASE WHEN EXCLUDED.attachment_id<>''
           THEN EXCLUDED.attachment_id ELSE travel_customer_documents.attachment_id END
       RETURNING *`,
      [input.platform, input.senderId, input.pageId, input.eventKey, image.index,
        image.attachmentId, image.url,
        Number.isFinite(input.timestamp) ? new Date(input.timestamp as number) : new Date()],
    );
    if (!result?.rows[0]) throw new Error("customer_image_receipt_write_failed");
    return result.rows[0];
  }));
  recordCounter("customer_documents.received_total", rows.length, { platform: input.platform });
  return rows;
}

async function claimImage(id: number) {
  const result = await queryNeon<CustomerDocument>(
    `UPDATE travel_customer_documents
       SET ingest_status='processing', ingest_attempts=ingest_attempts+1,
           ingest_retry_at=NOW()+INTERVAL '5 minutes', updated_at=NOW()
     WHERE id=$1 AND (
       ingest_status IN ('pending','retry') AND ingest_retry_at<=NOW()
       OR ingest_status='processing' AND ingest_retry_at<=NOW()
     ) RETURNING *`, [id],
  );
  return result?.rows[0] || null;
}

async function retryImage(id: number, attempts: number, reason: string) {
  const delayMinutes = Math.min(60 * 12, 2 ** Math.min(attempts, 9));
  await queryNeon(
    `UPDATE travel_customer_documents
       SET ingest_status=CASE WHEN ingest_attempts>=8 THEN 'failed' ELSE 'retry' END,
           ingest_retry_at=CASE WHEN ingest_attempts>=8 THEN NULL ELSE NOW()+($2::integer * INTERVAL '1 minute') END,
           ingest_error=$3, updated_at=NOW()
     WHERE id=$1 AND ingest_status<>'stored'`,
    [id, delayMinutes, reason],
  );
}

export async function processReservedCustomerImages(
  rows: Array<Pick<CustomerDocument, "id">>,
  trace?: { requestId?: string; correlationId?: string },
): Promise<CustomerDocument[]> {
  if (!rows.length) return [];
  const completed: CustomerDocument[] = [];
  const trips = await listTrips({ limit: 5000 }).catch(() => [] as TravelTrip[]);
  // Bound parallel downloads/uploads. Larger Messenger albums are never truncated.
  for (let start = 0; start < rows.length; start += 3) {
    const batch = await Promise.all(rows.slice(start, start + 3).map(async ({ id }) => {
      const row = await claimImage(id);
      if (!row) return null;
      try {
        if (!row.source_url.startsWith("https://")) throw new Error("image_source_url_missing");
        const result = await processCustomerImageAttachment({
          platform: row.platform, senderId: row.sender_id, pageId: row.page_id,
          url: row.source_url, documentId: row.id, trace, trips,
        });
        if (!result) throw new Error("image_processing_failed");
        return result;
      } catch (error) {
        const reason = classifyError(error);
        // A storage problem (not configured, access denied, store missing) is an operator's
        // problem, not a one-off: an error the admin issues list and quality panel count.
        const storageCode = error instanceof Error && (error.message === "private_blob_not_configured" || /^Blob/.test(error.name))
          ? (error.message === "private_blob_not_configured" ? error.message : error.name) : null;
        if (storageCode) {
          logError("customer_documents.private_storage_failed", { requestId: trace?.requestId, correlationId: trace?.correlationId,
            senderHash: hashIdentifier(row.sender_id), documentId: row.id, error: storageCode, attempt: row.ingest_attempts || 1 });
        }
        await retryImage(row.id, row.ingest_attempts || 1, storageCode || reason.category);
        logWarn("customer_documents.ingest_retry", {
          requestId: trace?.requestId, correlationId: trace?.correlationId,
          senderHash: hashIdentifier(row.sender_id), documentId: row.id, classification: reason,
        });
        return null;
      }
    }));
    completed.push(...batch.filter((row): row is CustomerDocument => Boolean(row)));
  }
  return completed;
}

export function scheduleReservedCustomerImages(
  rows: Array<Pick<CustomerDocument, "id">>,
  trace?: { requestId?: string; correlationId?: string },
  onProcessed?: (docs: CustomerDocument[]) => Promise<void>,
) {
  if (!rows.length) return;
  const work = processReservedCustomerImages(rows, trace).then(async (docs) => {
    if (docs.length && onProcessed) await onProcessed(docs);
  }).catch((error) => {
    logWarn("customer_documents.scheduled_ingest_failed", {
      requestId: trace?.requestId, correlationId: trace?.correlationId,
      classification: classifyError(error),
    });
  });
  try { waitUntil(work); } catch { void work; }
}

export async function retryDueCustomerImages(limit = 12) {
  if (!(await ensureTravelSchema())) return 0;
  const result = await queryNeon<{ id: number }>(
    `SELECT id FROM travel_customer_documents
      WHERE ingest_status IN ('pending','retry','processing') AND ingest_retry_at<=NOW()
      ORDER BY ingest_retry_at ASC, id ASC LIMIT $1`, [limit],
  );
  return (await processReservedCustomerImages(result?.rows || [])).length;
}

export async function requeueCustomerImage(id: number) {
  if (!(await ensureTravelSchema())) return null;
  const result = await queryNeon<CustomerDocument>(
    `UPDATE travel_customer_documents SET ingest_status='pending',
       ingest_attempts=0, ingest_retry_at=NOW(), ingest_error='', updated_at=NOW()
     WHERE id=$1 AND mime_type LIKE 'image/%' AND stored_url=''
       AND ingest_status IN ('failed','retry','pending') RETURNING *`, [id],
  );
  return result?.rows[0] || null;
}
