import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import { parseUpload, type ParsedUpload } from "../../../lib/fileParse";
import {
  extractGoogleDriveFileIds,
  parseGoogleDriveFileId,
} from "../../../lib/googleDriveSync";
import { generateAIProposalFromContentBatched } from "../../../lib/travelOps";
import { beginRequestTrace, finishRequestTrace } from "../../../lib/observability";

export const config = {
  api: {
    bodyParser: false,
  },
};

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

type UploadPayload = {
  filename: string;
  mimeType: string;
  dataBase64: string;
};

type ProposalLike = {
  summary?: string;
  important_reason?: string;
  conflicts?: string[];
  actions?: unknown[];
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

function collectDriveFileIds(body: Record<string, unknown>, note: string): string[] {
  const ids: string[] = [];
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    for (const id of extractGoogleDriveFileIds(value)) {
      if (!ids.includes(id)) ids.push(id);
    }
    const trimmed = value.trim();
    if (/^[A-Za-z0-9_-]{10,}$/.test(trimmed) && !ids.includes(trimmed)) {
      ids.push(trimmed);
    }
  };

  if (Array.isArray(body.driveLinks)) {
    body.driveLinks.forEach(add);
  }
  if (Array.isArray(body.driveFileIds)) {
    body.driveFileIds.forEach(add);
  }
  add(note);
  return ids;
}

async function readJsonBody(req: NextApiRequest): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function hasTransientAiFailure(proposal: ProposalLike): boolean {
  const text = [
    proposal.summary || "",
    proposal.important_reason || "",
    ...(Array.isArray(proposal.conflicts) ? proposal.conflicts : []),
  ].join(" ");
  return /429|rate.?limit|quota|resource.?exhausted|circuit|upstream|could not finish reading batch/i.test(
    text,
  );
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

    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch {
      return res.status(400).json({ error: "Invalid JSON upload payload." });
    }
    const note = asText((body as Record<string, unknown>).note);
    const uploads = collectUploads(body);
    const driveFileIds = collectDriveFileIds(body, note);

    if (uploads.length === 0 && driveFileIds.length === 0) {
      return res.status(400).json({ error: "No uploaded file data was provided." });
    }

    const parsedUploads: ParsedUpload[] = [];
    try {
      for (const upload of uploads) {
        parsedUploads.push(await parseUpload(upload));
      }
      for (const fileId of driveFileIds) {
        const driveFile = await parseGoogleDriveFileId(fileId);
        parsedUploads.push(...driveFile.parsedUploads);
      }
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

    if (
      result.proposal.actions.length === 0 &&
      hasTransientAiFailure(result.proposal)
    ) {
      return res.status(429).json({
        ok: false,
        error:
          "AI file reader is temporarily rate limited. The admin UI will retry this file part.",
        retry_after_ms: 35_000,
      });
    }

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
