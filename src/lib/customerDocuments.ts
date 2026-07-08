import { createHash } from "crypto";
import { waitUntil } from "@vercel/functions";
import { askGeminiParts, type GeminiPart } from "./gemini";
import { queryNeon } from "./neonDb";
import {
  classifyError,
  hashIdentifier,
  logInfo,
  logWarn,
  recordCounter,
} from "./observability";
import { ensureTravelSchema } from "./travelSchema";
import { uploadImageToCloudinary } from "./tripPhotoImport/upload";
import { createPaymentRecord, listPayments } from "./travelPayments";
import { listTrips, type TravelTrip } from "./travelOps";
import { resolveTripFromUserMessage } from "./travelFastPathsSearch";
import type { Platform } from "./webhookDedup";

export type CustomerDocumentCategory =
  | "passport"
  | "travel_document"
  | "booking_code"
  | "trip_screenshot"
  | "payment_screenshot"
  | "other";

export type CustomerDocumentStatus =
  | "needs_review"
  | "verified"
  | "wrong_extraction"
  | "duplicate"
  | "attached_to_booking"
  | "reviewed"
  | "ignored";

export type CustomerDocument = {
  id: number;
  platform: Platform;
  sender_id: string;
  page_id: string;
  source_url: string;
  stored_url: string;
  image_sha256: string;
  mime_type: string;
  category: CustomerDocumentCategory;
  extracted_json: Record<string, unknown>;
  matched_trip_id: string | null;
  matched_payment_id: number | null;
  duplicate_of_id: number | null;
  confidence: number;
  auto_action: string;
  status: CustomerDocumentStatus;
  created_at: string;
  updated_at: string;
  reviewed_at?: string | null;
  retention_hidden_at?: string | null;
};

export type ImageAttachmentInput = {
  platform: Platform;
  senderId: string;
  pageId: string;
  url: string;
  trace?: { requestId?: string; correlationId?: string };
};

const SENSITIVE_RETENTION_DAYS = 180;

type DownloadedImage = {
  buffer: Buffer;
  mimeType: string;
  hash: string;
};

function normalizeCategory(value: unknown): CustomerDocumentCategory {
  const category = String(value || "").trim().toLowerCase();
  if (category === "passport") return "passport";
  if (category === "travel_document") return "travel_document";
  if (category === "booking_code") return "booking_code";
  if (category === "trip_screenshot") return "trip_screenshot";
  if (category === "payment_screenshot") return "payment_screenshot";
  return "other";
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || trimmed;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(candidate.slice(start, end + 1));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
      } catch {
        return {};
      }
    }
    return {};
  }
}

function normalizeStatus(value: unknown): CustomerDocumentStatus {
  const status = String(value || "").trim().toLowerCase();
  if (status === "verified") return "verified";
  if (status === "wrong_extraction") return "wrong_extraction";
  if (status === "duplicate") return "duplicate";
  if (status === "attached_to_booking") return "attached_to_booking";
  if (status === "reviewed") return "reviewed";
  if (status === "ignored") return "ignored";
  return "needs_review";
}

function readNumber(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? Math.max(0, Math.min(1, num)) : 0;
}

function parseAmount(value: unknown): number {
  const raw = compactValue(value);
  if (!raw) return 0;
  const normalized = raw.replace(/[^\d.]/g, "");
  const num = Number(normalized);
  return Number.isFinite(num) ? Math.max(0, Math.trunc(num)) : 0;
}

async function writeDocumentAudit(input: {
  documentId: number;
  action: string;
  actor?: string;
  before?: unknown;
  after?: unknown;
}) {
  await queryNeon(
    `
      INSERT INTO travel_customer_document_audit (
        document_id, action, actor, before_json, after_json
      )
      VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
    `,
    [
      input.documentId,
      input.action,
      input.actor || "system",
      JSON.stringify(input.before || {}),
      JSON.stringify(input.after || {}),
    ],
  ).catch(() => {});
}

async function findDuplicateDocument(input: {
  senderId: string;
  imageSha256: string;
}): Promise<number | null> {
  if (!input.imageSha256) return null;
  const ready = await ensureTravelSchema();
  if (!ready) return null;
  const result = await queryNeon<{ id: number }>(
    `
      SELECT id
      FROM travel_customer_documents
      WHERE sender_id = $1 AND image_sha256 = $2
      ORDER BY created_at ASC
      LIMIT 1
    `,
    [input.senderId, input.imageSha256],
  );
  return result?.rows?.[0]?.id ? Number(result.rows[0].id) : null;
}

async function matchOrCreatePayment(input: {
  platform: Platform;
  senderId: string;
  imageSha256: string;
  extracted: Record<string, unknown>;
}): Promise<{ id: number | null; autoAction: string }> {
  if (normalizeCategory(input.extracted.category) !== "payment_screenshot") {
    return { id: null, autoAction: "" };
  }
  const payment = input.extracted.payment && typeof input.extracted.payment === "object"
    ? (input.extracted.payment as Record<string, unknown>)
    : {};
  const amount = parseAmount(payment.amount);
  if (amount <= 0) return { id: null, autoAction: "" };

  // Match ONLY this customer's own payment records. Trip prices are
  // standardized (many customers owe the identical amount), so the old
  // any-customer-by-amount fallback routinely attached customer B's receipt
  // to customer A's booking — staff would "verify" the wrong person's payment.
  const payments = await listPayments({ limit: 500 }).catch(() => []);
  const matched = payments.find(
    (item) =>
      item.sender_id === input.senderId &&
      item.amount === amount &&
      (item.status === "pending" || item.status === "paid"),
  );
  if (matched) {
    return { id: matched.id, autoAction: "matched_existing_payment" };
  }

  const created = await createPaymentRecord({
    invoiceId: `receipt:${input.imageSha256.slice(0, 24)}`,
    senderInvoiceNo: `receipt-${input.imageSha256.slice(0, 12)}`,
    platform: input.platform,
    senderId: input.senderId,
    customerName: compactValue(payment.sender_name),
    tripName: compactValue(payment.trip_name),
    amount,
    currency: compactValue(payment.currency) || "MNT",
    note: [
      "Customer sent payment receipt screenshot; verify manually before marking paid.",
      compactValue(payment.reference) ? `Reference: ${compactValue(payment.reference)}` : "",
      compactValue(payment.date) ? `Date: ${compactValue(payment.date)}` : "",
    ].filter(Boolean).join(" "),
  }).catch(() => null);
  return {
    id: created?.id ?? null,
    autoAction: created ? "created_pending_payment_from_receipt" : "",
  };
}

async function downloadImage(url: string): Promise<DownloadedImage> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`image_download_failed:${res.status}`);
  }
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const mimeType = contentType.split(";")[0]?.trim() || "image/jpeg";
  if (!mimeType.startsWith("image/")) {
    throw new Error(`unsupported_attachment_type:${mimeType}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.length > 12 * 1024 * 1024) {
    throw new Error("image_too_large");
  }
  return {
    buffer,
    mimeType,
    hash: createHash("sha256").update(buffer).digest("hex"),
  };
}

// The retention sweep is an UPDATE over the whole table. It used to run on
// EVERY customer message (getCustomerMemoryText → listCustomerDocuments →
// sweep) — a pointless write on the reply hot path. A 6-hour throttle keeps
// the policy enforced without taxing every conversation turn.
let lastRetentionSweepAt = 0;
const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function applySensitiveRetentionPolicy() {
  const now = Date.now();
  if (now - lastRetentionSweepAt < RETENTION_SWEEP_INTERVAL_MS) return;
  lastRetentionSweepAt = now;
  const ready = await ensureTravelSchema();
  if (!ready) return;
  await queryNeon(
    `
      UPDATE travel_customer_documents
      SET retention_hidden_at = NOW(), updated_at = NOW()
      WHERE retention_hidden_at IS NULL
        AND category IN ('passport', 'travel_document', 'booking_code')
        AND status IN ('verified', 'reviewed', 'ignored', 'attached_to_booking')
        AND created_at < NOW() - ($1::text || ' days')::interval
    `,
    [String(SENSITIVE_RETENTION_DAYS)],
  ).catch(() => {});
}

function buildExtractionParts(image: DownloadedImage): GeminiPart[] {
  return [
    {
      text: [
        "You classify and extract customer-sent travel chatbot images.",
        "Return JSON only. Do not invent unreadable data.",
        "Categories — classify by MEANING, not visual style:",
        "- passport: passport bio page/photo or official passport image.",
        "- travel_document: visa, ID, ticket, booking document, certificate, or other customer travel document.",
        "- booking_code: screenshot or message image containing a booking code, reservation number, passcode, confirmation code, or other code the agency needs later.",
        "- trip_screenshot: screenshot/photo of a trip poster, social post, itinerary, price list, or tour ad — usually the customer asking 'what is this trip / how much'.",
        "- payment_screenshot: ANY proof that money was transferred, in ANY visual style:",
        "  * mobile banking success screen (green checkmark, 'Гүйлгээ амжилттай', amount + date)",
        "  * bank transfer statement/printout ('Шилжүүлгийн мэдээлэл', Журналын №, Илгээгч/Хүлээн авагч table)",
        "  * email receipt of a transfer (bank email with the statement embedded)",
        "  * QR payment confirmation, transaction-list screenshot",
        "  If the image shows an amount of money moving to an account, it is payment_screenshot.",
        "- other: any unrelated or unclear image.",
        "",
        "JSON schema:",
        "{",
        '  "category": "passport|travel_document|booking_code|trip_screenshot|payment_screenshot|other",',
        '  "confidence": 0.0,',
        '  "summary": "short Mongolian summary for staff",',
        '  "passport": {',
        '    "full_name": "", "passport_number": "", "date_of_birth": "",',
        '    "expiry_date": "", "nationality": "", "sex": ""',
        "  },",
        '  "trip": {',
        '    "title": "", "destination": "", "departure_dates": [],',
        '    "price_text": "", "duration": "", "operator": ""',
        "  },",
        '  "payment": {',
        '    "amount": "", "currency": "", "reference": "", "date": "",',
        '    "sender_name": "", "description": "", "phone": ""',
        "  },",
        '  "booking": { "code": "", "trip_name": "", "traveler_name": "", "phone": "", "notes": "" },',
        '  "visible_text": "important readable text, short",',
        '  "needs_human_review": true,',
        '  "warnings": []',
        "}",
        "",
        "Payment field rules:",
        "- description: the transaction memo line ('Гүйлгээний утга') VERBATIM — it usually names the customer and trip.",
        "- phone: any 8-digit Mongolian mobile number visible in the memo or receipt (starts with 6, 8, or 9). Empty if none.",
        "- reference: journal/transaction number ('Журналын №', reference code).",
        "- sender_name: who sent the money ('Илгээгч' / 'Нэр').",
        "",
        "For passports and documents, mark needs_human_review=true even if confident.",
      ].join("\n"),
    },
    {
      inlineData: {
        mimeType: image.mimeType,
        data: image.buffer.toString("base64"),
      },
    },
  ];
}

// Mongolian mobile numbers are 8 digits starting 6/8/9. A 7-prefix number is
// an Ulaanbaatar landline (often the agency's own) — never a customer phone.
const MONGOLIAN_MOBILE_RE = /(?<!\d)[689]\d{7}(?!\d)/;

/**
 * Deterministic fallback: staff match receipts to customers by the phone
 * number the payer writes into the transaction memo ("… аялалын төлбөр
 * 99183371"). If the vision model missed it, pull it from the memo/visible
 * text ourselves.
 */
export function extractMongolianPhone(text: string): string {
  const compact = (text || "").replace(/[\s\-()]/g, "");
  const match = compact.match(MONGOLIAN_MOBILE_RE);
  return match ? match[0] : "";
}

export type DocumentTripMatch = { id: string; route_name: string } | null;

/**
 * Resolve a document against the REAL trip catalog. A trip screenshot that
 * matches a catalog trip can be answered instantly (price/dates) instead of
 * waiting for staff; a payment memo naming a trip ("… 88112594 Dalyan") gives
 * staff the booking context without hunting.
 */
export function matchTripFromDocument(
  extracted: Record<string, unknown>,
  category: CustomerDocumentCategory,
  trips: Array<{ id: string; route_name: string } & Record<string, unknown>>,
  resolve: (
    text: string,
    trips: Array<{ id: string; route_name: string } & Record<string, unknown>>,
  ) =>
    | { status: "verified"; trip: { id: string; route_name: string } }
    | { status: string },
): DocumentTripMatch {
  if (trips.length === 0) return null;
  const trip = extracted.trip && typeof extracted.trip === "object"
    ? (extracted.trip as Record<string, unknown>)
    : {};
  const booking = extracted.booking && typeof extracted.booking === "object"
    ? (extracted.booking as Record<string, unknown>)
    : {};
  const payment = extracted.payment && typeof extracted.payment === "object"
    ? (extracted.payment as Record<string, unknown>)
    : {};
  const candidates =
    category === "trip_screenshot"
      ? [
          [compactValue(trip.title), compactValue(trip.destination)].filter(Boolean).join(" "),
          compactValue(trip.title),
          compactValue(trip.destination),
          compactValue(extracted.visible_text),
        ]
      : [
          compactValue(booking.trip_name),
          compactValue(payment.description),
        ];
  for (const candidate of candidates) {
    if (!candidate || candidate.length < 3) continue;
    const result = resolve(candidate, trips);
    if (result.status === "verified" && "trip" in result) {
      return { id: result.trip.id, route_name: result.trip.route_name };
    }
  }
  return null;
}

async function extractImageData(
  image: DownloadedImage,
  trace?: { requestId?: string; correlationId?: string },
) {
  const result = await askGeminiParts(buildExtractionParts(image), {
    source: "customer_documents.extract",
    requestId: trace?.requestId,
    correlationId: trace?.correlationId,
    jsonMode: true,
    timeoutMs: 25_000,
    maxRetries: 1,
    maxOutputTokens: 1600,
    temperature: 0,
    preferOpenAI: true,
  });
  const extracted = parseJsonObject(result.text);
  // Deterministic phone fallback over memo + visible text.
  const payment = extracted.payment && typeof extracted.payment === "object"
    ? (extracted.payment as Record<string, unknown>)
    : null;
  if (payment && !compactValue(payment.phone)) {
    const phone = extractMongolianPhone(
      [compactValue(payment.description), compactValue(extracted.visible_text)].join(" "),
    );
    if (phone) payment.phone = phone;
  }
  return {
    extracted,
    category: normalizeCategory(extracted.category),
  };
}

async function insertCustomerDocument(input: {
  platform: Platform;
  senderId: string;
  pageId: string;
  sourceUrl: string;
  storedUrl: string;
  imageSha256: string;
  mimeType: string;
  category: CustomerDocumentCategory;
  extractedJson: Record<string, unknown>;
  confidence: number;
  matchedPaymentId: number | null;
  matchedTripId: string | null;
  duplicateOfId: number | null;
  autoAction: string;
}) {
  const ready = await ensureTravelSchema();
  if (!ready) return null;
  const result = await queryNeon<CustomerDocument>(
    `
      INSERT INTO travel_customer_documents (
        platform, sender_id, page_id, source_url, stored_url, image_sha256,
        mime_type, category, extracted_json, confidence, matched_payment_id,
        matched_trip_id, duplicate_of_id, auto_action, status, reviewed_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14,
        CASE WHEN $13::bigint IS NULL THEN 'needs_review' ELSE 'duplicate' END,
        CASE WHEN $13::bigint IS NULL THEN NULL ELSE NOW() END,
        NOW()
      )
      ON CONFLICT (sender_id, image_sha256)
      WHERE image_sha256 <> ''
      DO UPDATE SET
        source_url = EXCLUDED.source_url,
        stored_url = COALESCE(NULLIF(EXCLUDED.stored_url, ''), travel_customer_documents.stored_url),
        mime_type = EXCLUDED.mime_type,
        category = EXCLUDED.category,
        extracted_json = EXCLUDED.extracted_json,
        confidence = EXCLUDED.confidence,
        matched_payment_id = COALESCE(EXCLUDED.matched_payment_id, travel_customer_documents.matched_payment_id),
        matched_trip_id = COALESCE(EXCLUDED.matched_trip_id, travel_customer_documents.matched_trip_id),
        auto_action = COALESCE(NULLIF(EXCLUDED.auto_action, ''), travel_customer_documents.auto_action),
        updated_at = NOW()
      RETURNING *
    `,
    [
      input.platform,
      input.senderId,
      input.pageId,
      input.sourceUrl,
      input.storedUrl,
      input.imageSha256,
      input.mimeType,
      input.category,
      JSON.stringify(input.extractedJson),
      input.confidence,
      input.matchedPaymentId,
      input.matchedTripId,
      input.duplicateOfId,
      input.autoAction,
    ],
  );
  return result?.rows?.[0] ?? null;
}

export async function processCustomerImageAttachment(
  input: ImageAttachmentInput & { trips?: TravelTrip[] },
) {
  try {
    const image = await downloadImage(input.url);
    let storedUrl = input.url;
    try {
      storedUrl = await uploadImageToCloudinary(
        image.buffer,
        `customer-${input.senderId}-${Date.now()}`,
        image.mimeType,
      );
    } catch (error) {
      logWarn("customer_documents.cloudinary_store_failed", {
        requestId: input.trace?.requestId,
        correlationId: input.trace?.correlationId,
        senderHash: hashIdentifier(input.senderId),
        classification: classifyError(error),
        message: error instanceof Error ? error.message : String(error),
      });
    }

    const { extracted, category } = await extractImageData(image, input.trace);
    const confidence = readNumber(extracted.confidence);
    // Resolve against the live catalog: a matched trip screenshot can be
    // answered instantly, and a payment memo naming a trip gives staff
    // booking context. Stamped into extracted_json so UI/memory can show the
    // name without a join.
    const tripMatch = matchTripFromDocument(
      extracted,
      category,
      input.trips || [],
      (text, candidateTrips) =>
        resolveTripFromUserMessage(text, candidateTrips as TravelTrip[], {
          allowLooseFallback: false,
        }),
    );
    if (tripMatch) {
      extracted.trip_match = { id: tripMatch.id, route_name: tripMatch.route_name };
    }
    const duplicateOfId = await findDuplicateDocument({
      senderId: input.senderId,
      imageSha256: image.hash,
    });
    const paymentMatch = await matchOrCreatePayment({
      platform: input.platform,
      senderId: input.senderId,
      imageSha256: image.hash,
      extracted,
    });
    const row = await insertCustomerDocument({
      platform: input.platform,
      senderId: input.senderId,
      pageId: input.pageId,
      sourceUrl: input.url,
      storedUrl,
      imageSha256: image.hash,
      mimeType: image.mimeType,
      category,
      extractedJson: extracted,
      confidence,
      matchedPaymentId: paymentMatch.id,
      matchedTripId: tripMatch?.id ?? null,
      duplicateOfId,
      autoAction: paymentMatch.autoAction,
    });
    if (row?.id) {
      await writeDocumentAudit({
        documentId: row.id,
        action: duplicateOfId ? "duplicate_detected" : "created",
        after: row,
      });
      if (paymentMatch.id) {
        await writeDocumentAudit({
          documentId: row.id,
          action: paymentMatch.autoAction || "payment_matched",
          after: { matched_payment_id: paymentMatch.id },
        });
      }
    }

    recordCounter("customer_documents.processed_total", 1, {
      platform: input.platform,
      category,
    });
    logInfo("customer_documents.processed", {
      requestId: input.trace?.requestId,
      correlationId: input.trace?.correlationId,
      senderHash: hashIdentifier(input.senderId),
      category,
      documentId: row?.id,
    });
    return row;
  } catch (error) {
    recordCounter("customer_documents.failed_total", 1, {
      platform: input.platform,
    });
    logWarn("customer_documents.process_failed", {
      requestId: input.trace?.requestId,
      correlationId: input.trace?.correlationId,
      senderHash: hashIdentifier(input.senderId),
      classification: classifyError(error),
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function processCustomerImageAttachments(input: {
  platform: Platform;
  senderId: string;
  pageId: string;
  urls: string[];
  trace?: { requestId?: string; correlationId?: string };
}) {
  const urls = Array.from(
    new Set(input.urls.map((url) => url.trim()).filter((url) => url.startsWith("http"))),
  ).slice(0, 5);
  if (urls.length === 0) return [];
  // One catalog fetch per batch — used to resolve trip screenshots and
  // payment memos against real trips.
  const trips = await listTrips({ limit: 5000 }).catch(() => [] as TravelTrip[]);
  const rows: CustomerDocument[] = [];
  for (const url of urls) {
    const row = await processCustomerImageAttachment({ ...input, url, trips });
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * Runs the vision pipeline WITHOUT blocking the reply path. Per image this
 * pipeline can take download (≤15s) + Cloudinary upload + extraction (≤25s,
 * with retry) — awaiting it inline meant a customer sending text+photo waited
 * for the whole thing before their text was even answered, and a multi-image
 * album could blow straight past the webhook's maxDuration (killed function,
 * no reply at all).
 *
 * `onProcessed` fires after classification with the created/updated rows —
 * used to send the customer a category-aware confirmation ("төлбөрийн баримт
 * хүлээн авлаа") once the system actually knows what arrived.
 */
export function scheduleCustomerImageProcessing(input: {
  platform: Platform;
  senderId: string;
  pageId: string;
  urls: string[];
  trace?: { requestId?: string; correlationId?: string };
  onProcessed?: (docs: CustomerDocument[]) => Promise<void>;
}): void {
  const work = (async () => {
    const docs = await processCustomerImageAttachments(input);
    if (docs.length > 0 && input.onProcessed) {
      await input.onProcessed(docs);
    }
  })().catch((error) => {
    logWarn("customer_documents.scheduled_processing_failed", {
      requestId: input.trace?.requestId,
      correlationId: input.trace?.correlationId,
      senderHash: hashIdentifier(input.senderId),
      classification: classifyError(error),
      message: error instanceof Error ? error.message : String(error),
    });
  });
  try {
    waitUntil(work);
  } catch {
    // Not running on Vercel (tests, local node) — detached execution is fine.
    void work;
  }
}

export async function listCustomerDocuments(options?: {
  senderId?: string;
  status?: CustomerDocumentStatus | "all";
  category?: CustomerDocumentCategory | "all";
  limit?: number;
}) {
  const ready = await ensureTravelSchema();
  if (!ready) return [];
  await applySensitiveRetentionPolicy();
  const where: string[] = [];
  const values: unknown[] = [];
  where.push(`retention_hidden_at IS NULL`);
  if (options?.senderId?.trim()) {
    values.push(options.senderId.trim());
    where.push(`sender_id = $${values.length}`);
  }
  if (options?.status && options.status !== "all") {
    values.push(normalizeStatus(options.status));
    where.push(`status = $${values.length}`);
  }
  if (options?.category && options.category !== "all") {
    values.push(options.category);
    where.push(`category = $${values.length}`);
  }
  const limit = Math.min(Math.max(Math.trunc(options?.limit || 100), 1), 300);
  values.push(limit);
  const result = await queryNeon<CustomerDocument>(
    `
      SELECT *
      FROM travel_customer_documents
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC
      LIMIT $${values.length}
    `,
    values,
  );
  return result?.rows || [];
}

export async function updateCustomerDocumentStatus(
  id: number,
  status: CustomerDocumentStatus,
  actor = "admin",
) {
  const ready = await ensureTravelSchema();
  if (!ready) return false;
  const before = await queryNeon<CustomerDocument>(
    `SELECT * FROM travel_customer_documents WHERE id = $1 LIMIT 1`,
    [id],
  );
  const nextStatus = normalizeStatus(status);
  const result = await queryNeon(
    `
      UPDATE travel_customer_documents
      SET
        status = $2,
        reviewed_at = CASE WHEN $2 IN ('verified', 'reviewed', 'ignored', 'duplicate', 'attached_to_booking') THEN NOW() ELSE reviewed_at END,
        updated_at = NOW()
      WHERE id = $1
    `,
    [id, nextStatus],
  );
  const ok = (result?.rowCount ?? 0) > 0;
  if (ok) {
    await writeDocumentAudit({
      documentId: id,
      action: "status_changed",
      actor,
      before: before?.rows?.[0] || {},
      after: { status: nextStatus },
    });
  }
  return ok;
}

export async function updateCustomerDocument(input: {
  id: number;
  status?: CustomerDocumentStatus;
  extractedJson?: Record<string, unknown>;
  matchedTripId?: string | null;
  matchedPaymentId?: number | null;
  actor?: string;
}) {
  const ready = await ensureTravelSchema();
  if (!ready) return null;
  const before = await queryNeon<CustomerDocument>(
    `SELECT * FROM travel_customer_documents WHERE id = $1 LIMIT 1`,
    [input.id],
  );
  const current = before?.rows?.[0];
  if (!current) return null;
  const nextStatus = input.status ? normalizeStatus(input.status) : current.status;
  const nextExtracted = input.extractedJson || current.extracted_json || {};
  const confidence = readNumber(nextExtracted.confidence ?? current.confidence);
  const result = await queryNeon<CustomerDocument>(
    `
      UPDATE travel_customer_documents
      SET
        status = $2,
        extracted_json = $3::jsonb,
        confidence = $4,
        matched_trip_id = $5,
        matched_payment_id = $6,
        reviewed_at = CASE WHEN $2 IN ('verified', 'reviewed', 'ignored', 'duplicate', 'attached_to_booking') THEN NOW() ELSE reviewed_at END,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [
      input.id,
      nextStatus,
      JSON.stringify(nextExtracted),
      confidence,
      input.matchedTripId === undefined ? current.matched_trip_id : input.matchedTripId,
      input.matchedPaymentId === undefined ? current.matched_payment_id : input.matchedPaymentId,
    ],
  );
  const updated = result?.rows?.[0] ?? null;
  if (updated) {
    await writeDocumentAudit({
      documentId: input.id,
      action: "document_updated",
      actor: input.actor || "admin",
      before: current,
      after: updated,
    });
  }
  return updated;
}

export async function getCustomerDocumentStats() {
  const ready = await ensureTravelSchema();
  if (!ready) {
    return { unreviewed_count: 0, by_category: [] as Array<{ category: string; count: number }> };
  }
  await applySensitiveRetentionPolicy();
  const [unreviewed, byCategory] = await Promise.all([
    queryNeon<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM travel_customer_documents
        WHERE status = 'needs_review'
      `,
    ),
    queryNeon<{ category: string; count: string }>(
      `
        SELECT category, COUNT(*)::text AS count
        FROM travel_customer_documents
        WHERE status = 'needs_review'
        GROUP BY category
        ORDER BY count DESC
      `,
    ),
  ]);
  return {
    unreviewed_count: Number(unreviewed?.rows?.[0]?.count || 0),
    by_category: (byCategory?.rows || []).map((row) => ({
      category: row.category,
      count: Number(row.count || 0),
    })),
  };
}

function compactValue(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(compactValue).filter(Boolean).join(", ");
  if (typeof value === "object") return "";
  return String(value).trim();
}

export function summarizeCustomerDocumentForMemory(doc: CustomerDocument): string {
  const data = doc.extracted_json || {};
  const payment = data.payment && typeof data.payment === "object"
    ? (data.payment as Record<string, unknown>)
    : {};
  const booking = data.booking && typeof data.booking === "object"
    ? (data.booking as Record<string, unknown>)
    : {};
  const trip = data.trip && typeof data.trip === "object"
    ? (data.trip as Record<string, unknown>)
    : {};
  if (doc.category === "payment_screenshot") {
    const amount = [compactValue(payment.amount), compactValue(payment.currency)]
      .filter(Boolean)
      .join(" ");
    const date = compactValue(payment.date);
    const phone = compactValue(payment.phone);
    const matchedTrip = data.trip_match && typeof data.trip_match === "object"
      ? compactValue((data.trip_match as Record<string, unknown>).route_name)
      : "";
    return [
      "payment receipt sent",
      amount,
      date,
      phone ? `phone ${phone}` : "",
      matchedTrip ? `trip: ${matchedTrip}` : "",
    ]
      .filter(Boolean)
      .join(" - ");
  }
  if (doc.category === "booking_code") {
    // The memory summary is injected into EVERY AI prompt — a raw code there
    // can be echoed back to anyone in the chat. The bot only needs to know a
    // code exists (staff see the full value in the admin tab); a masked
    // suffix is enough to disambiguate "which code" in conversation.
    const code = compactValue(booking.code);
    const maskedCode = code.length > 3 ? `•••${code.slice(-3)}` : code ? "•••" : "";
    const tripName = compactValue(booking.trip_name);
    return [
      "booking/passcode image sent",
      maskedCode ? `code ending ${maskedCode}` : "",
      tripName,
    ]
      .filter(Boolean)
      .join(" - ");
  }
  if (doc.category === "passport") {
    return "passport image sent - staff review required";
  }
  if (doc.category === "travel_document") {
    return "travel document image sent - staff review required";
  }
  if (doc.category === "trip_screenshot") {
    const matchedTrip = data.trip_match && typeof data.trip_match === "object"
      ? compactValue((data.trip_match as Record<string, unknown>).route_name)
      : "";
    const title = compactValue(trip.title);
    const destination = compactValue(trip.destination);
    const summary = compactValue(data.summary);
    return [
      "trip screenshot sent",
      matchedTrip ? `matched our trip: ${matchedTrip}` : title || destination || summary,
    ]
      .filter(Boolean)
      .join(" - ");
  }
  return compactValue(data.summary) || "image attachment sent";
}

export type DocumentSenderSummary = {
  sender_id: string;
  platform: string;
  display_name: string;
  total: number;
  needs_review: number;
  last_at: string;
  by_category: Record<CustomerDocumentCategory, number>;
};

/**
 * Person-first view: who has sent documents, what kinds, and how many still
 * need review — so staff browse by customer instead of scrolling a flat feed.
 */
export async function listDocumentSenders(): Promise<DocumentSenderSummary[]> {
  const ready = await ensureTravelSchema();
  if (!ready) return [];
  await applySensitiveRetentionPolicy();
  const result = await queryNeon<{
    sender_id: string;
    platform: string;
    display_name: string | null;
    total: string;
    needs_review: string;
    last_at: string;
    passports: string;
    travel_docs: string;
    booking_codes: string;
    trip_screenshots: string;
    payments: string;
    others: string;
  }>(
    `
      SELECT
        d.sender_id,
        MAX(d.platform) AS platform,
        COALESCE(MAX(NULLIF(s.display_name, '')), '') AS display_name,
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE d.status = 'needs_review')::text AS needs_review,
        MAX(d.created_at)::text AS last_at,
        COUNT(*) FILTER (WHERE d.category = 'passport')::text AS passports,
        COUNT(*) FILTER (WHERE d.category = 'travel_document')::text AS travel_docs,
        COUNT(*) FILTER (WHERE d.category = 'booking_code')::text AS booking_codes,
        COUNT(*) FILTER (WHERE d.category = 'trip_screenshot')::text AS trip_screenshots,
        COUNT(*) FILTER (WHERE d.category = 'payment_screenshot')::text AS payments,
        COUNT(*) FILTER (WHERE d.category = 'other')::text AS others
      FROM travel_customer_documents d
      LEFT JOIN travel_senders s ON s.sender_id = d.sender_id
      WHERE d.retention_hidden_at IS NULL
      GROUP BY d.sender_id
      ORDER BY MAX(d.created_at) DESC
      LIMIT 200
    `,
  );
  return (result?.rows || []).map((row) => ({
    sender_id: row.sender_id,
    platform: row.platform || "facebook",
    display_name: row.display_name || "",
    total: Number(row.total || 0),
    needs_review: Number(row.needs_review || 0),
    last_at: row.last_at,
    by_category: {
      passport: Number(row.passports || 0),
      travel_document: Number(row.travel_docs || 0),
      booking_code: Number(row.booking_codes || 0),
      trip_screenshot: Number(row.trip_screenshots || 0),
      payment_screenshot: Number(row.payments || 0),
      other: Number(row.others || 0),
    },
  }));
}

export async function getCustomerDocumentMemoryText(senderId: string): Promise<string> {
  const docs = await listCustomerDocuments({ senderId, status: "all", limit: 10 });
  const important = docs
    .filter((doc) => doc.status !== "ignored")
    .map((doc) => summarizeCustomerDocumentForMemory(doc))
    .filter(Boolean);
  if (important.length === 0) return "";
  return [
    "Important customer attachments:",
    ...Array.from(new Set(important)).slice(0, 8).map((line) => `- ${line}`),
  ].join("\n");
}
