import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import { parseUpload } from "../../../lib/fileParse";
import { generateAIProposalFromContent } from "../../../lib/travelOps";
import { beginRequestTrace, finishRequestTrace } from "../../../lib/observability";

export const config = {
  api: {
    bodyParser: { sizeLimit: "20mb" },
  },
};

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const trace = beginRequestTrace({
    route: "api.admin.parse_file",
    method: req.method,
    url: req.url,
    headers: req.headers,
    setHeader: (name, value) => res.setHeader(name, value),
  });

  try {
    const allowed = await requireAdminAccess(req, res, "api.admin.parse_file");
    if (!allowed) return;

    if (req.method !== "POST") return res.status(405).end();

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const filename = asText(body.filename) || "upload";
    const mimeType = asText(body.mimeType);
    const dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
    const note = asText(body.note);

    if (!dataBase64) {
      return res.status(400).json({ error: "Файл хавсаргаагүй байна." });
    }

    let parsed;
    try {
      parsed = await parseUpload({ filename, mimeType, dataBase64 });
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : "Файлыг уншиж чадсангүй.",
      });
    }

    const result = await generateAIProposalFromContent({
      label: parsed.label,
      note: note || undefined,
      contentText: parsed.text || undefined,
      inline: parsed.inline,
    });

    return res.status(200).json({
      ok: true,
      proposal: result.proposal,
      request_id: result.request_id,
      requires_confirmation: Boolean(result.proposal.needs_confirmation),
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Дотоод алдаа гарлаа.",
    });
  } finally {
    finishRequestTrace(trace, res.statusCode || 500);
  }
}
