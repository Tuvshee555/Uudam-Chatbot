import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import {
  getCustomerDocumentStats,
  listCustomerDocuments,
  updateCustomerDocument,
  updateCustomerDocumentStatus,
  type CustomerDocumentCategory,
  type CustomerDocumentStatus,
} from "../../../lib/customerDocuments";
import { beginRequestTrace, finishRequestTrace } from "../../../lib/observability";

const VALID_STATUSES: CustomerDocumentStatus[] = [
  "needs_review",
  "verified",
  "wrong_extraction",
  "duplicate",
  "attached_to_booking",
  "reviewed",
  "ignored",
];
const VALID_CATEGORIES: CustomerDocumentCategory[] = [
  "passport",
  "travel_document",
  "booking_code",
  "trip_screenshot",
  "payment_screenshot",
  "other",
];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const trace = beginRequestTrace({
    route: "api.admin.customer-documents",
    method: req.method,
    url: req.url,
    headers: req.headers,
    setHeader: (name, value) => res.setHeader(name, value),
  });

  try {
    const allowed = await requireAdminAccess(req, res, "api.admin.customer-documents");
    if (!allowed) return;

    if (req.method === "GET") {
      if (req.query.stats) {
        const stats = await getCustomerDocumentStats();
        return res.status(200).json({ ok: true, stats });
      }
      const senderId =
        typeof req.query.sender_id === "string" ? req.query.sender_id : undefined;
      const statusRaw =
        typeof req.query.status === "string" ? req.query.status : "needs_review";
      const categoryRaw =
        typeof req.query.category === "string" ? req.query.category : "all";
      const status =
        statusRaw === "all" || VALID_STATUSES.includes(statusRaw as CustomerDocumentStatus)
          ? (statusRaw as CustomerDocumentStatus | "all")
          : "needs_review";
      const category =
        categoryRaw === "all" || VALID_CATEGORIES.includes(categoryRaw as CustomerDocumentCategory)
          ? (categoryRaw as CustomerDocumentCategory | "all")
          : "all";
      const limit = Number(req.query.limit || 100);
      const documents = await listCustomerDocuments({
        senderId,
        status,
        category,
        limit: Number.isFinite(limit) ? limit : 100,
      });
      return res.status(200).json({ ok: true, documents });
    }

    if (req.method === "PATCH") {
      const id = Number(req.body?.id);
      const status = req.body?.status === undefined ? undefined : String(req.body.status);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: "valid id is required" });
      }
      if (status !== undefined && !VALID_STATUSES.includes(status as CustomerDocumentStatus)) {
        return res.status(400).json({ error: "invalid status" });
      }
      const hasEditableFields =
        req.body?.extracted_json !== undefined ||
        req.body?.matched_trip_id !== undefined ||
        req.body?.matched_payment_id !== undefined;
      if (hasEditableFields) {
        const extractedJson =
          req.body?.extracted_json && typeof req.body.extracted_json === "object"
            ? (req.body.extracted_json as Record<string, unknown>)
            : undefined;
        const updated = await updateCustomerDocument({
          id,
          status: status as CustomerDocumentStatus | undefined,
          extractedJson,
          matchedTripId:
            req.body?.matched_trip_id === undefined
              ? undefined
              : req.body.matched_trip_id === null
                ? null
                : String(req.body.matched_trip_id),
          matchedPaymentId:
            req.body?.matched_payment_id === undefined
              ? undefined
              : req.body.matched_payment_id === null
                ? null
                : Number(req.body.matched_payment_id),
          actor: "admin",
        });
        if (!updated) return res.status(404).json({ error: "document_not_found" });
        return res.status(200).json({ ok: true, document: updated });
      }
      if (status === undefined) return res.status(400).json({ error: "status required" });
      const updated = await updateCustomerDocumentStatus(id, status as CustomerDocumentStatus, "admin");
      if (!updated) return res.status(404).json({ error: "document_not_found" });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).end();
  } finally {
    finishRequestTrace(trace, res.statusCode || 500);
  }
}
