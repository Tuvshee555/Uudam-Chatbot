import { createHash } from "node:crypto";
import { getEnv } from "./env";
import { sharedMap } from "./processState";
import { withRedis } from "./redisState";

const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const receipts = sharedMap<string, { next: number; at: number }>("meta_text_delivery.receipts");

/** Preserve every character while keeping individual Messenger requests bounded. */
export function splitMessengerText(text: string, limit = 2000): string[] {
  if (!Number.isInteger(limit) || limit < 2) throw new Error("Invalid message limit");
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const prefix = remaining.slice(0, limit);
    let end = prefix.lastIndexOf("\n\n");
    if (end >= limit / 2) end += 2;
    else {
      end = prefix.lastIndexOf("\n");
      if (end >= limit / 2) end += 1;
      else {
        end = prefix.lastIndexOf(" ");
        end = end >= limit / 2 ? end + 1 : limit;
      }
    }
    // UTF-16 slicing must not separate the two halves of an emoji.
    if (/[\uD800-\uDBFF]/.test(remaining[end - 1]) && /[\uDC00-\uDFFF]/.test(remaining[end])) end--;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining || !chunks.length) chunks.push(remaining);
  return chunks;
}

function receiptKey(deliveryKey: string, recipientId: string, text: string): string {
  return `webhook:text_parts:${createHash("sha256").update(JSON.stringify([deliveryKey, recipientId, text])).digest("hex")}`;
}

async function readReceipt(key: string): Promise<number> {
  if (getEnv().redisReplayEnabled) {
    const result = await withRedis("webhook.text_parts.read", async redis => ({ value: await redis.get(key) }));
    if (!result) throw new Error("Text delivery receipts unavailable");
    const next = result.value === null ? 0 : Number(result.value);
    if (!Number.isSafeInteger(next) || next < 0) throw new Error("Invalid text delivery receipt");
    return next;
  }
  const now = Date.now();
  for (const [id, value] of receipts) if (now - value.at >= RECEIPT_TTL_MS) receipts.delete(id);
  const saved = receipts.get(key);
  if (!saved && receipts.size >= getEnv().rateLimitMaxBuckets) throw new Error("Text delivery receipt capacity reached");
  return saved?.next ?? 0;
}

async function saveReceipt(key: string, next: number): Promise<void> {
  if (getEnv().redisReplayEnabled) {
    const result = await withRedis("webhook.text_parts.save", async redis => ({ value: await redis.set(key, String(next), "PX", RECEIPT_TTL_MS) }));
    if (result?.value !== "OK") throw new Error("Text delivery receipt not saved");
    return;
  }
  // Receipts contain only digests and offsets, never message text or credentials.
  if (!receipts.has(key) && receipts.size >= getEnv().rateLimitMaxBuckets) {
    throw new Error("Text delivery receipt capacity reached");
  }
  receipts.set(key, { next, at: Date.now() });
}

/** Resume an interrupted multi-part reply only within the same inbound event. */
export async function deliverMessengerText(
  recipientId: string,
  text: string,
  send: (part: string, last: boolean) => Promise<void>,
  deliveryKey?: string,
): Promise<void> {
  const parts = splitMessengerText(text);
  const key = deliveryKey && parts.length > 1 ? receiptKey(deliveryKey, recipientId, text) : null;
  const next = key ? await readReceipt(key) : 0;
  if (next > parts.length) throw new Error("Invalid text delivery offset");
  for (let index = next; index < parts.length; index++) {
    await send(parts[index], index === parts.length - 1);
    if (key) await saveReceipt(key, index + 1);
  }
}
