import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../lib/adminAccess";
import {
  beginRequestTrace,
  finishRequestTrace,
  getMetricsSnapshot,
  getObservabilityDiagnostics,
} from "../../lib/observability";
import { getRedisHealth } from "../../lib/redisState";
import { getRateLimitDiagnostics } from "../../lib/rateLimit";
import { getWebhookRuntimeDiagnostics } from "./webhook";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const trace = beginRequestTrace({
    route: "api.metrics",
    method: req.method,
    url: req.url,
    headers: req.headers,
    setHeader: (name, value) => res.setHeader(name, value),
  });

  try {
    if (req.method !== "GET") return res.status(405).end();

    // Shared guard so a wrong secret here is rate-limited and counted the same
    // way it is on every /api/admin/* route, instead of allowing unlimited
    // unauthenticated probing of an operational endpoint.
    const allowed = await requireAdminAccess(req, res, "api.metrics");
    if (!allowed) return;

    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      metrics: getMetricsSnapshot(),
      diagnostics: {
        observability: getObservabilityDiagnostics(),
        redis: getRedisHealth(),
        rateLimit: getRateLimitDiagnostics(),
        webhook: getWebhookRuntimeDiagnostics(),
      },
    });
  } finally {
    finishRequestTrace(trace, res.statusCode || 500);
  }
}

