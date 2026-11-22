/**
 * POST /api/admin/file-text — one attached file as plain text for the assistant's agent.
 *
 * The page sends each file of a message about SAVED trips here («… аяллыг энэ файлаар шинэчил»,
 * «энэ мэдээллийг хоёр аялалд нэм») and passes the texts on to /api/admin/ai-change as
 * `documents`. Word (.docx, .doc), Excel, CSV, PDF and text are read without a model; a picture
 * (a price table) costs one vision call. Nothing is written: no proposal, no upload, no trip.
 */
import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import { aiBudgetMessage, aiBudgetState } from "../../../lib/aiUsage";
import { similarSavedTrips } from "../../../lib/assistantAgent/fileMatch";
import { documentTextOf } from "../../../lib/documentText";
import { listTrips } from "../../../lib/travelDb";
import { beginRequestTrace, finishRequestTrace, logWarn, recordCounter } from "../../../lib/observability";
import { getClientKey, rateLimitAsync } from "../../../lib/rateLimit";
import { PayloadTooLargeError, readRawBodyLimited } from "../../../lib/webhookSecurity";

export const config = { api: { bodyParser: false }, maxDuration: 120 };

// Vercel caps a request body at about 4.5 MB: one file per request, base64 included.
const BODY_MAX_BYTES = 4_500_000;
const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 10 * 60 * 1000;

const isImage = (filename: string, mimeType: string) => mimeType.toLowerCase().startsWith("image/") || /\.(png|jpe?g|webp|gif|heic|heif)$/i.test(filename);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const trace = beginRequestTrace({ route: "api.admin.file_text", method: req.method, url: req.url, headers: req.headers, setHeader: (name, value) => res.setHeader(name, value) });
  try {
    const allowed = await requireAdminAccess(req, res, "api.admin.file_text");
    if (!allowed) return;
    if (req.method !== "POST") return res.status(405).end();
    const limit = await rateLimitAsync(`admin-ai:file-text:${getClientKey(req)}`, RATE_LIMIT, RATE_WINDOW_MS);
    if (!limit.allowed) {
      recordCounter("abuse.rate_limited_total", 1, { route: "api.admin.file_text", scope: "admin_ai" });
      return res.status(429).json({ ok: false, error: "rate_limited", retry_after_ms: Math.max(0, limit.reset - Date.now()) });
    }
    let body: Record<string, unknown>;
    try {
      const header = req.headers["content-length"];
      const raw = (await readRawBodyLimited(req, BODY_MAX_BYTES, Array.isArray(header) ? header[0] : header)).toString("utf8").trim();
      const parsed = raw ? JSON.parse(raw) as unknown : {};
      body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        return res.status(413).json({ ok: false, error: "file_too_large", message: "Файл хэт том байна (4 MB-аас бага байх ёстой). PDF эсвэл .docx болгож жижигрүүлээд дахин оруулна уу." });
      }
      return res.status(400).json({ ok: false, error: "invalid_body", message: "Файлыг уншиж чадсангүй." });
    }
    const filename = typeof body.filename === "string" ? body.filename.trim().slice(0, 300) : "";
    const mimeType = typeof body.mimeType === "string" ? body.mimeType.trim().slice(0, 120) : "";
    const dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
    if (!filename || !dataBase64) return res.status(400).json({ ok: false, error: "no_file", message: "Файл ирсэнгүй." });
    if (isImage(filename, mimeType)) {
      // A picture is read by the model: the day's AI budget is checked first.
      const budget = await aiBudgetState();
      if (budget.exceeded) return res.status(402).json({ ok: false, error: "ai_budget_exceeded", message: aiBudgetMessage(budget) });
    }
    try {
      const document = await documentTextOf({ filename, mimeType, dataBase64 });
      // `match`: the page asks whether this document looks like a trip already saved (fileMatch.ts);
      // a likely match sends it to the assistant instead of straight to the new-trip reader.
      if (body.match === true) {
        const trips = await listTrips({ limit: 250, includeArchived: true }).catch(() => []);
        return res.status(200).json({ ok: true, document, similar: similarSavedTrips(document.text, trips) });
      }
      return res.status(200).json({ ok: true, document });
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : "Файлыг уншиж чадсангүй.";
      logWarn("api.admin.file_text.unreadable", { message: message.slice(0, 300) });
      return res.status(422).json({ ok: false, error: "file_unreadable", message });
    }
  } finally {
    finishRequestTrace(trace, res.statusCode || 500);
  }
}
