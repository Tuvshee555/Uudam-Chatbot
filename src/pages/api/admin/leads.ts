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
import { summarizeLeadAttention } from "../../../lib/leadAttention";
import { assignLead, countLeads } from "../../../lib/travelLeadsDb";

const VALID_CRM_STATUSES: LeadCrmStatus[] = ["new_lead", "contacted", "booked", "no_answer"];
/** One page of the Leads tab, and the set the attention summary is computed over. */
const LEAD_PAGE_SIZE = 200;

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
      // ?summary=1: the dashboard's background check — how many leads need a person now,
      // and when the newest activity was, so an open dashboard can alert (leadAttention.ts).
      if (req.query.summary) {
        const attention = summarizeLeadAttention(await listLeads(LEAD_PAGE_SIZE));
        return res.status(200).json({ ok: true, attention });
      }
      // ?stats=1 returns dashboard aggregates alongside one page of the lead list.
      // ?q= searches every lead (not only the loaded page); ?offset= pages on.
      // The first unfiltered page is the same 200 leads ?summary=1 reads, so the
      // tab's "needs attention" count and the nav badge always agree.
      if (req.query.stats) {
        const search = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 120) : "";
        const offset = Math.max(0, Number.parseInt(String(req.query.offset ?? "0"), 10) || 0);
        const [leads, total, newCount, stats] = await Promise.all([
          listLeads(LEAD_PAGE_SIZE, { offset, search }),
          countLeads(search),
          countNewLeads(),
          getLeadStats(),
        ]);
        const firstPage = !search && offset === 0;
        return res.status(200).json({
          ok: true, leads, total, offset, search, new_count: newCount, stats,
          ...(firstPage ? { attention: summarizeLeadAttention(leads) } : {}),
        });
      }
      const [leads, newCount] = await Promise.all([
        listLeads(80),
        countNewLeads(),
      ]);
      return res.status(200).json({ ok: true, leads, new_count: newCount });
    }

    if (req.method === "PATCH") {
      const { id, lead_status, assigned_to } = req.body || {};
      const leadId = Number(id);
      if (!Number.isInteger(leadId) || leadId <= 0) {
        return res.status(400).json({ error: "valid id is required" });
      }

      // A consultant takes the lead (free-text name; "" clears it).
      if (typeof assigned_to === "string") {
        const updated = await assignLead(leadId, assigned_to);
        if (!updated) return res.status(404).json({ error: "lead_not_found" });
        return res.status(200).json({ ok: true });
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
