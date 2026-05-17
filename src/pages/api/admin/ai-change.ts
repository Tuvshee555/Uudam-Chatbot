import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import { applyAIRequest, generateAIProposal } from "../../../lib/travelOps";
import { beginRequestTrace, finishRequestTrace } from "../../../lib/observability";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const trace = beginRequestTrace({
    route: "api.admin.ai_change",
    method: req.method,
    url: req.url,
    headers: req.headers,
    setHeader: (name, value) => res.setHeader(name, value),
  });

  try {
    const allowed = await requireAdminAccess(req, res, "api.admin.ai_change");
    if (!allowed) return;

    if (req.method !== "POST") return res.status(405).end();

    const { instruction, request_id, apply, confirm } = req.body || {};

    if (typeof request_id === "number" && apply === true) {
      if (confirm !== true) {
        return res.status(400).json({
          error: "confirmation_required",
          message: "Set confirm=true to apply stored AI proposal.",
        });
      }
      const applied = await applyAIRequest(request_id);
      return res.status(applied.ok ? 200 : 409).json(applied);
    }

    if (typeof instruction !== "string" || !instruction.trim()) {
      return res.status(400).json({ error: "instruction is required" });
    }

    const proposal = await generateAIProposal(instruction.trim());
    return res.status(200).json({
      ok: true,
      ...proposal,
      requires_confirmation: Boolean(proposal.proposal.needs_confirmation),
    });
  } finally {
    finishRequestTrace(trace, res.statusCode || 500);
  }
}
