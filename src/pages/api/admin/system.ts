import type { NextApiRequest, NextApiResponse } from "next";
import { getEnv } from "../../../lib/env";
import { hasAdminAccess } from "../../../lib/adminAccess";
import { getDbDiagnostics } from "../../../lib/travelOps";
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

    const diagnostics = await getDbDiagnostics();
    return res.status(200).json({
      ok: true,
      open_access: env.adminOpenAccess,
      authorized: hasAdminAccess(req),
      db: diagnostics,
    });
  } finally {
    finishRequestTrace(trace, res.statusCode || 500);
  }
}
