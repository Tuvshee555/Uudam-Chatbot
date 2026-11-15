/**
 * One wrapper for every /api/admin/catalogue/* route, so the safety properties cannot differ
 * between them: no-store caching, request tracing, the same admin auth as the other admin routes
 * (a signed-in same-origin session for writes, the read-only bearer token for GET only), a
 * method allow-list, an optional per-client rate limit, and Mongolian JSON errors.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { readAdminSession, requireAdminAccess } from "../../adminAccess";
import {
  beginRequestTrace,
  classifyError,
  finishRequestTrace,
  logError,
  logInfo,
  recordCounter,
  type RequestTrace,
} from "../../observability";
import { getClientKey, rateLimitAsync } from "../../rateLimit";

export type CatalogueRouteContext = {
  req: NextApiRequest;
  res: NextApiResponse;
  trace: RequestTrace;
  /** Signed-in admin's email, or null for the read-only token. Never a customer identifier. */
  actor: string | null;
};

export class CatalogueHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CatalogueHttpError";
  }
}

const STORE_ERROR_HTTP: Record<string, { status: number; message: string }> = {
  db_not_configured: { status: 503, message: "Өгөгдлийн сан тохируулагдаагүй байна." },
  invalid_input: { status: 400, message: "Оруулсан мэдээлэл буруу байна." },
  version_not_found: { status: 404, message: "Хувилбар олдсонгүй." },
  blocking_warnings: {
    status: 409,
    message: "Хориглосон анхааруулга байгаа тул нийтэлж болохгүй. Анхааруулгыг уншиж, баталгаажуулна уу.",
  },
  preview_not_publishable: { status: 422, message: "Дээжийн хувилбарыг нийтэлж болохгүй." },
  rollback_requires_previous_version: { status: 409, message: "Буцаах өмнөх хувилбар байхгүй байна." },
  invalid_pdf: { status: 422, message: "PDF файл буруу бүтэцтэй байна." },
  pdf_too_large: { status: 422, message: "PDF файл Messenger-ийн хэмжээний хязгаараас хэтэрсэн байна." },
  code_space_exhausted: { status: 500, message: "Аяллын кодын сан дүүрсэн байна." },
  config_conflict: {
    status: 409,
    message: "Өөр хүн энэ тохиргоог хадгалсан байна. Хуудсаа шинэчлээд дахин оролдоно уу.",
  },
};

/** The store's typed errors (CatalogueStoreError) become precise HTTP answers instead of a blank 500. */
function asStoreError(error: unknown): CatalogueHttpError | null {
  if (!error || typeof error !== "object") return null;
  const { name, code } = error as { name?: unknown; code?: unknown };
  if (name !== "CatalogueStoreError" || typeof code !== "string") return null;
  const mapped = STORE_ERROR_HTTP[code];
  if (!mapped) return null;
  const detail = (error as { detail?: unknown }).detail;
  return new CatalogueHttpError(
    mapped.status,
    code,
    mapped.message,
    detail && typeof detail === "object" ? { detail } : {},
  );
}

/** The renderer's typed errors: a browser that cannot start is 503, anything else a safe 500 (no internals echoed). */
function asRenderError(error: unknown): CatalogueHttpError | null {
  if (!error || typeof error !== "object") return null;
  const { name, code } = error as { name?: unknown; code?: unknown };
  if (name !== "CatalogueRenderError") return null;
  if (code === "browser_unavailable") {
    return new CatalogueHttpError(
      503,
      "render_unavailable",
      "PDF үүсгэх хөтөч (Chromium) энэ орчинд ажиллахгүй байна. Серверийн тохиргоог шалгаад дахин оролдоно уу.",
    );
  }
  return new CatalogueHttpError(500, "render_failed", "PDF үүсгэж чадсангүй. Дахин оролдоно уу, үргэлжилбэл бүртгэлийг шалгана уу.");
}

export type CatalogueRouteOptions = {
  /** Trace / metric name, e.g. "api.admin.catalogue.state". */
  route: string;
  methods: ReadonlyArray<"GET" | "POST" | "PUT">;
  /** Per-client budget for expensive or state-changing calls. */
  rateLimit?: { limit: number; windowMs: number };
  handle: (context: CatalogueRouteContext) => Promise<void>;
};

export function sendCatalogueError(
  res: NextApiResponse,
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.status(status).json({ ok: false, error: code, message, ...extra });
}

/** Asia/Ulaanbaatar calendar day (UTC+8, no daylight saving) for a clock reading. */
export function ulaanbaatarDay(now: Date): string {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

export function catalogueRoute(options: CatalogueRouteOptions) {
  return async function handler(req: NextApiRequest, res: NextApiResponse) {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    const trace = beginRequestTrace({
      route: options.route,
      method: req.method,
      url: req.url,
      headers: req.headers,
      setHeader: (name, value) => res.setHeader(name, value),
    });
    try {
      const method = (req.method || "GET").toUpperCase();
      if (!options.methods.includes(method as "GET" | "POST" | "PUT")) {
        res.setHeader("Allow", options.methods.join(", "));
        return sendCatalogueError(res, 405, "method_not_allowed", "Энэ хүсэлтийн төрөл зөвшөөрөгдөөгүй.");
      }
      // Auth first: an unauthenticated caller learns nothing and reaches no module.
      const allowed = await requireAdminAccess(req, res, options.route);
      if (!allowed) return;

      if (options.rateLimit && method !== "GET") {
        const limit = await rateLimitAsync(
          `catalogue-admin:${options.route}:${getClientKey(req)}`,
          options.rateLimit.limit,
          options.rateLimit.windowMs,
        );
        if (!limit.allowed) {
          recordCounter("catalogue.admin_rate_limited_total", 1, { route: options.route });
          res.setHeader("Retry-After", String(Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000))));
          return sendCatalogueError(res, 429, "too_many_requests", "Хэт олон хүсэлт илгээлээ. Түр хүлээгээд дахин оролдоно уу.");
        }
      }

      await options.handle({ req, res, trace, actor: readAdminSession(req)?.email ?? null });
    } catch (thrown) {
      const error = thrown instanceof CatalogueHttpError ? thrown : asStoreError(thrown) ?? asRenderError(thrown) ?? thrown;
      if (error instanceof CatalogueHttpError) {
        logInfo("catalogue.admin.rejected", {
          route: options.route,
          requestId: trace.requestId,
          status: error.status,
          code: error.code,
        });
        if (!res.headersSent) sendCatalogueError(res, error.status, error.code, error.message, error.extra);
        return;
      }
      const classification = classifyError(error);
      logError("catalogue.admin.failed", {
        route: options.route,
        requestId: trace.requestId,
        category: classification.category,
        error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
      });
      recordCounter("catalogue.admin_errors_total", 1, { route: options.route, category: classification.category });
      if (!res.headersSent) {
        sendCatalogueError(res, 500, "catalogue_failed", "Каталогийн үйлдэл амжилтгүй боллоо. Дахин оролдоно уу.");
      }
    } finally {
      finishRequestTrace(trace, res.statusCode || 500);
    }
  };
}
