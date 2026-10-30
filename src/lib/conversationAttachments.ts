import { queryNeon } from "./neonDb";
import { ensureTravelSchema } from "./travelSchema";

type Attachment = { type?: string; url?: string };

export type AttachmentSource =
  | { kind: "serve"; url: string; mimeType?: string }
  | { kind: "hidden" }
  | { kind: "missing" };

/**
 * Where one inbox attachment's bytes come from, privately: the customer document made from
 * it (a document hidden by deletion or retention is not shown here either), or the copy kept
 * in travel_conversation_attachments; only an attachment never copied falls back to the URL
 * it arrived with, which the server fetches itself (adminFileProxy.ts).
 */
export async function resolveConversationAttachment(rowId: number, index: number): Promise<AttachmentSource> {
  await ensureTravelSchema();
  const row = (await queryNeon<{ sender_id: string; attachments: unknown }>(
    "SELECT sender_id, attachments FROM travel_conversations WHERE id=$1 LIMIT 1", [rowId],
  ))?.rows[0];
  const attachment = Array.isArray(row?.attachments) ? (row!.attachments as Attachment[])[index] : undefined;
  if (!row || !attachment?.url) return { kind: "missing" };

  const copy = (await queryNeon<{ status: string; document_id: string | null; blob_url: string; mime_type: string }>(
    "SELECT status, document_id, blob_url, mime_type FROM travel_conversation_attachments WHERE conversation_id=$1 AND idx=$2",
    [rowId, index],
  ))?.rows[0];
  if (copy?.status === "private" && copy.blob_url) return { kind: "serve", url: copy.blob_url, mimeType: copy.mime_type };

  const linked = copy?.status === "document" && copy.document_id;
  const document = (await queryNeon<{ stored_url: string; mime_type: string; hidden: boolean }>(
    linked
      ? "SELECT stored_url, mime_type, retention_hidden_at IS NOT NULL AS hidden FROM travel_customer_documents WHERE id=$1"
      : `SELECT stored_url, mime_type, retention_hidden_at IS NOT NULL AS hidden FROM travel_customer_documents
          WHERE sender_id=$1 AND source_url=$2 ORDER BY id LIMIT 1`,
    linked ? [copy!.document_id] : [row.sender_id, attachment.url],
  ))?.rows[0];
  if (document?.hidden) return { kind: "hidden" };
  if (document?.stored_url) return { kind: "serve", url: document.stored_url, mimeType: document.mime_type };
  return { kind: "serve", url: attachment.url };
}
