import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import {
  countNewLeads,
  getLeadStats,
  listLeads,
  markLeadSeen,
  updateLeadStatus,
} from "../../../lib/travelOps";
import type { LeadCrmStatus } from "../../../lib/travelOps";
import { beginRequestTrace, finishRequestTrace } from "../../../lib/observability";

const VALID_CRM_STATUSES: LeadCrmStatus[] = ["new_lead", "contacted", "booked", "no_answer"];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const trace = beginRequestTrace({
    route: "api.admin.leads",
    method: req.method,
    url: req.url,
    headers: req.headers,
    setHeader: (name, value) => res.setHeader(name, value),
  });

  try {
    const allowed = await requireAdminAccess(req, res, "api.admin.leads");
    if (!allowed) return;

    if (req.method === "GET") {
      // ?stats=1 returns dashboard aggregates alongside the lead list.
      if (req.query.stats) {
        const [leads, newCount, stats] = await Promise.all([
          listLeads(80),
          countNewLeads(),
          getLeadStats(),
        ]);
        return res
          .status(200)
          .json({ ok: true, leads, new_count: newCount, stats });
      }
      const [leads, newCount] = await Promise.all([
        listLeads(80),
        countNewLeads(),
      ]);
      return res.status(200).json({ ok: true, leads, new_count: newCount });
    }

    if (req.method === "PATCH") {
      const { id, lead_status } = req.body || {};
      const leadId = Number(id);
      if (!Number.isInteger(leadId) || leadId <= 0) {
        return res.status(400).json({ error: "valid id is required" });
      }

      // If lead_status provided, update CRM status; otherwise just mark seen
      if (lead_status !== undefined) {
        if (!(VALID_CRM_STATUSES as string[]).includes(String(lead_status))) {
          return res.status(400).json({ error: "invalid lead_status" });
        }
        const updated = await updateLeadStatus(leadId, lead_status as LeadCrmStatus);
        if (!updated) return res.status(404).json({ error: "lead_not_found" });
        return res.status(200).json({ ok: true });
      }

      const updated = await markLeadSeen(leadId);
      if (!updated) return res.status(404).json({ error: "lead_not_found" });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).end();
  } finally {
    finishRequestTrace(trace, res.statusCode || 500);
  }
}
