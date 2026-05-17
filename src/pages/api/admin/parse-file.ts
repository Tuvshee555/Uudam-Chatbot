import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import { parseUpload } from "../../../lib/fileParse";
import { generateAIProposalFromContentBatched } from "../../../lib/travelOps";
import { beginRequestTrace, finishRequestTrace } from "../../../lib/observability";

export const config = {
  api: {
    bodyParser: { sizeLimit: "140mb" },
  },
};

const MAX_UPLOAD_COUNT = 20;

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

type UploadPayload = {
  filename: string;
  mimeType: string;
  dataBase64: string;
};

function collectUploads(body: Record<string, unknown>): UploadPayload[] {
  if (Array.isArray(body.uploads)) {
    return body.uploads
      .map((item) => {
        const entry = item && typeof item === "object" ? item : {};
        return {
          filename: asText((entry as Record<string, unknown>).filename) || "upload",
          mimeType: asText((entry as Record<string, unknown>).mimeType),
          dataBase64:
            typeof (entry as Record<string, unknown>).dataBase64 === "string"
              ? String((entry as Record<string, unknown>).dataBase64)
              : "",
        };
      })
      .filter((item) => item.dataBase64);
  }

  const fallback = {
    filename: asText(body.filename) || "upload",
    mimeType: asText(body.mimeType),
    dataBase64: typeof body.dataBase64 === "string" ? body.dataBase64 : "",
  };
  return fallback.dataBase64 ? [fallback] : [];
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
    const note = asText((body as Record<string, unknown>).note);
    const uploads = collectUploads(body as Record<string, unknown>);

    if (uploads.length === 0) {
      return res.status(400).json({ error: "No uploaded file data was provided." });
    }
    if (uploads.length > MAX_UPLOAD_COUNT) {
      return res.status(400).json({
        error: `Attach up to ${MAX_UPLOAD_COUNT} files per request.`,
      });
    }

    let parsedUploads;
    try {
      parsedUploads = await Promise.all(uploads.map((upload) => parseUpload(upload)));
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : "Failed to parse uploaded file.",
      });
    }

    const result = await generateAIProposalFromContentBatched({
      note: note || undefined,
      sources: parsedUploads.map((parsed) => ({
        label: parsed.label,
        contentText: parsed.text || undefined,
        inline: parsed.inline,
      })),
    });

    return res.status(200).json({
      ok: true,
      proposal: result.proposal,
      request_id: result.request_id,
      requires_confirmation: Boolean(result.proposal.needs_confirmation),
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Internal server error.",
    });
  } finally {
    finishRequestTrace(trace, res.statusCode || 500);
  }
}
