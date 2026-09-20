import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import {
  ERROR_LOG_RETENTION_DAYS,
  listErrorLogs,
  summarizeErrorLogs,
  type ErrorLogQuery,
} from "../../../lib/errorLogStore";
import { isNeonConfigured } from "../../../lib/neonDb";

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) || "";
}

/**
 * Read-only view of the self-cleaning error log (see errorLogStore.ts).
 *   GET ?hours=24&level=error|warn|info&event=<name>&search=<text>&limit=200
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const allowed = await requireAdminAccess(req, res, "api.admin.error_logs");
  if (!allowed) return;
  if (req.method !== "GET") return res.status(405).end();

  if (!isNeonConfigured()) {
    return res.status(200).json({
      ok: true,
      configured: false,
      retentionDays: ERROR_LOG_RETENTION_DAYS,
      summary: [],
      rows: [],
    });
  }

  const level = first(req.query.level);
  const query: ErrorLogQuery = {
    hours: Number(first(req.query.hours)) || undefined,
    limit: Number(first(req.query.limit)) || undefined,
    level: level === "error" || level === "warn" || level === "info" ? level : undefined,
    event: first(req.query.event) || undefined,
    search: first(req.query.search) || undefined,
  };

  const [summary, rows] = await Promise.all([
    summarizeErrorLogs(query.hours),
    listErrorLogs(query),
  ]);
  return res.status(200).json({
    ok: true,
    configured: true,
    retentionDays: ERROR_LOG_RETENTION_DAYS,
    summary,
    rows,
  });
}
