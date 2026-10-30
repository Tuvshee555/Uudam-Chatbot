import type { NextApiRequest, NextApiResponse } from "next";
import { getEnv } from "../../../lib/env";
import { hasAdminAccess } from "../../../lib/adminAccess";
import {
  getDriveSyncDiagnostics,
  scheduleDriveAutoSync,
} from "../../../lib/googleDriveSync";
import { getDbDiagnostics } from "../../../lib/travelOps";
import { getReadinessReport } from "../../../lib/readiness";
import { getOperationalIssues } from "../../../lib/aiHealth";
import { getAiUsageSummary } from "../../../lib/aiUsage";
import { staffAlertChannelStatus } from "../../../lib/staffAlerts";
import { beginRequestTrace, finishRequestTrace } from "../../../lib/observability";

const env = getEnv();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const trace = beginRequestTrace({
    route: "api.admin.system",
    method: req.method,
    url: req.url,
    headers: req.headers,
    setHeader: (name, value) => res.setHeader(name, value),
  });

  try {
    if (req.method !== "GET") return res.status(405).end();

    const authorized = hasAdminAccess(req);
    if (!authorized) {
      return res.status(200).json({
        ok: true,
        open_access: env.adminOpenAccess,
        authorized: false,
      });
    }

    scheduleDriveAutoSync({ source: "api.admin.system" });
    const [diagnostics, driveSync, operationalIssues, aiUsage, staffAlerts] = await Promise.all([
      getDbDiagnostics(),
      getDriveSyncDiagnostics(),
      getOperationalIssues(),
      // Model calls, tokens and estimated cost per day, environment and model (14 days).
      getAiUsageSummary(14).catch(() => []),
      // Which staff channel can deliver a lead alert (chat kind only, no token or id).
      staffAlertChannelStatus().catch(() => null),
    ]);
    return res.status(200).json({
      ok: true,
      open_access: env.adminOpenAccess,
      authorized: true,
      db: diagnostics,
      drive_sync: driveSync,
      readiness: getReadinessReport(env, operationalIssues),
      ai_usage: aiUsage,
      staff_alerts: staffAlerts,
    });
  } finally {
    finishRequestTrace(trace, res.statusCode || 500);
  }
}
