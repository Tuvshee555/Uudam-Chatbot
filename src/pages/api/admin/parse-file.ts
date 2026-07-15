import type { NextApiRequest, NextApiResponse } from "next";
import JSZip from "jszip";
import { requireAdminAccess } from "../../../lib/adminAccess";
import {
  MAX_PARSE_UPLOAD_DECODED_BYTES,
  MAX_PARSE_UPLOAD_TOTAL_DECODED_BYTES,
  parseUpload,
  type ParsedUpload,
} from "../../../lib/fileParse";
import { getClientKey, rateLimitAsync } from "../../../lib/rateLimit";
import {
  extractGoogleDriveFileIds,
  parseGoogleDriveFileId,
} from "../../../lib/googleDriveSync";
import {
  generateAIProposalFromContentBatched,
  getAIProposalFailureResponse,
} from "../../../lib/travelOps";
import { uploadPdfToFacebook } from "../../../lib/fbAttachmentUpload";
import {
  beginRequestTrace,
  finishRequestTrace,
  recordCounter,
} from "../../../lib/observability";
import { uploadImageToCloudinary } from "../../../lib/tripPhotoImport/upload";
import {
  PayloadTooLargeError,
  readRawBodyLimited,
} from "../../../lib/webhookSecurity";

export const config = {
  api: {
    bodyParser: false,
  },
  maxDuration: 180,
};

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

type UploadPayload = {
  filename: string;
  mimeType: string;
  dataBase64: string;
};

type PhotoUploadAsset = {
  label: string;
  buffer: Buffer;
  mimeType: string;
};

// Vercel hard-caps a serverless request body at ~4.5MB — this stays under it.
// This is the one ceiling we cannot lift; the client chunker keeps every
// request well below it.
const ADMIN_PARSE_BODY_MAX_BYTES = 4_500_000;
// Generous rate window: a large multi-chunk file (e.g. a long PDF) fans out
// into many one-chunk requests, so the limit must comfortably exceed the
// chunk count of a single big upload to avoid mid-upload throttling.
const ADMIN_PARSE_RATE_LIMIT = 1_000;
const ADMIN_PARSE_RATE_WINDOW_MS = 10 * 60 * 1000;
// Latent per-request safety nets (the client sends one unit per request, so
// these are effectively never hit) — kept high so no future batching trips them.
const MAX_UPLOADS_PER_REQUEST = 1_000;
const MAX_DRIVE_FILE_IDS_PER_REQUEST = 1_000;
const MAX_NOTE_CHARS = 4_000;

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

function estimateDecodedBytes(dataBase64: string) {
  const cleaned = dataBase64.includes(",")
    ? dataBase64.slice(dataBase64.indexOf(",") + 1)
    : dataBase64;
  const compact = cleaned.replace(/\s/g, "");
  return (
    Math.ceil((compact.length * 3) / 4) -
    (compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0)
  );
}

function decodeUploadBuffer(dataBase64: string): Buffer {
  const cleaned = dataBase64.includes(",")
    ? dataBase64.slice(dataBase64.indexOf(",") + 1)
    : dataBase64;
  return Buffer.from(cleaned.replace(/\s/g, ""), "base64");
}

function imageMimeFromName(name: string, fallback?: string): string {
  const lower = name.trim().toLowerCase();
  if (fallback?.startsWith("image/")) return fallback;
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

function isImageUpload(upload: UploadPayload): boolean {
  return (
    upload.mimeType.toLowerCase().startsWith("image/") ||
    /\.(png|jpe?g|webp)$/i.test(upload.filename.trim())
  );
}

function isZipUpload(upload: UploadPayload): boolean {
  const mime = upload.mimeType.toLowerCase();
  return (
    mime === "application/zip" ||
    mime === "application/x-zip-compressed" ||
    /\.zip$/i.test(upload.filename.trim())
  );
}

async function collectPhotoAssets(upload: UploadPayload): Promise<PhotoUploadAsset[]> {
  const buffer = decodeUploadBuffer(upload.dataBase64);
  if (isImageUpload(upload)) {
    return [{
      label: upload.filename,
      buffer,
      mimeType: imageMimeFromName(upload.filename, upload.mimeType),
    }];
  }
  if (!isZipUpload(upload)) return [];

  const zip = await JSZip.loadAsync(buffer, {
    decodeFileName: (bytes) => new TextDecoder("utf-8").decode(bytes as Uint8Array),
  });
  const entries = Object.values(zip.files)
    .filter(
      (entry) =>
        !entry.dir &&
        !entry.name.includes("__MACOSX") &&
        /\.(png|jpe?g|webp)$/i.test(entry.name),
    )
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const assets: PhotoUploadAsset[] = [];
  for (const entry of entries) {
    const entryBuffer = await entry.async("nodebuffer");
    const cleanName = entry.name.split("/").pop() || entry.name;
    assets.push({
      // Keep the directory path: agencies commonly name each ZIP folder after
      // its trip, while the photos themselves are only "1.jpg", "2.jpg", etc.
      label: `${upload.filename}/${entry.name}`,
      buffer: entryBuffer,
      mimeType: imageMimeFromName(cleanName),
    });
  }
  return assets;
}

async function readJsonBody(req: NextApiRequest): Promise<Record<string, unknown>> {
  const contentLengthHeader = req.headers["content-length"];
  const contentLengthRaw = Array.isArray(contentLengthHeader)
    ? contentLengthHeader[0]
    : contentLengthHeader;
  const raw = (
    await readRawBodyLimited(
      req,
      ADMIN_PARSE_BODY_MAX_BYTES,
      contentLengthRaw,
    )
  )
    .toString("utf8")
    .trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
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

    const clientKey = getClientKey(req);
    const limit = await rateLimitAsync(
      `admin-ai:parse-file:${clientKey}`,
      ADMIN_PARSE_RATE_LIMIT,
      ADMIN_PARSE_RATE_WINDOW_MS,
    );
    if (!limit.allowed) {
      recordCounter("abuse.rate_limited_total", 1, {
        route: "api.admin.parse_file",
        scope: "admin_ai",
      });
      return res.status(429).json({
        error: "rate_limited",
        reset: limit.reset,
        retry_after_ms: Math.max(0, limit.reset - Date.now()),
      });
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        return res.status(413).json({
          error: "upload_payload_too_large",
          max_bytes: ADMIN_PARSE_BODY_MAX_BYTES,
        });
      }
      return res.status(400).json({ error: "Invalid JSON upload payload." });
    }
    const note = asText((body as Record<string, unknown>).note);
    if (note.length > MAX_NOTE_CHARS) {
      return res.status(413).json({
        error: "note_too_long",
        max_chars: MAX_NOTE_CHARS,
      });
    }
    const uploads = collectUploads(body);
    const driveFileIds = collectDriveFileIds(body, note);

    if (uploads.length === 0 && driveFileIds.length === 0) {
      return res.status(400).json({ error: "No uploaded file data was provided." });
    }
    if (uploads.length > MAX_UPLOADS_PER_REQUEST) {
      return res.status(413).json({
        error: "too_many_uploads",
        max_uploads: MAX_UPLOADS_PER_REQUEST,
      });
    }
    let totalUploadBytes = 0;
    for (const upload of uploads) {
      const uploadBytes = estimateDecodedBytes(upload.dataBase64);
      if (uploadBytes > MAX_PARSE_UPLOAD_DECODED_BYTES) {
        return res.status(413).json({
          error: "upload_file_too_large",
          max_file_bytes: MAX_PARSE_UPLOAD_DECODED_BYTES,
        });
      }
      totalUploadBytes += uploadBytes;
    }
    if (totalUploadBytes > MAX_PARSE_UPLOAD_TOTAL_DECODED_BYTES) {
      return res.status(413).json({
        error: "upload_total_too_large",
        max_total_bytes: MAX_PARSE_UPLOAD_TOTAL_DECODED_BYTES,
      });
    }
    if (driveFileIds.length > MAX_DRIVE_FILE_IDS_PER_REQUEST) {
      return res.status(413).json({
        error: "too_many_drive_files",
        max_drive_files: MAX_DRIVE_FILE_IDS_PER_REQUEST,
      });
    }

    const parsedUploads: ParsedUpload[] = [];
    const photoAssets: PhotoUploadAsset[] = [];
    try {
      for (const upload of uploads) {
        const assets = await collectPhotoAssets(upload);
        photoAssets.push(...assets);
        if (isZipUpload(upload)) {
          for (const asset of assets) {
            parsedUploads.push({
              label: asset.label,
              text: "",
              inline: {
                mimeType: asset.mimeType,
                data: asset.buffer.toString("base64"),
              },
            });
          }
        } else {
          parsedUploads.push(await parseUpload(upload));
        }
      }
      for (const fileId of driveFileIds) {
        const driveFile = await parseGoogleDriveFileId(fileId);
        parsedUploads.push(...driveFile.parsedUploads);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to parse uploaded file.";
      return res.status(/too large/i.test(message) ? 413 : 400).json({
        error: message,
      });
    }

    // Upload PDFs to Facebook reusable attachment store in parallel so each
    // trip saved from this file can send the brochure back to customers.
    const fbAttachmentIds = await Promise.all(
      parsedUploads.map(async (parsed) => {
        const upload = uploads.find((u) => u.filename === parsed.label) ?? null;
        if (!upload || !upload.mimeType.includes("pdf")) return null;
        return uploadPdfToFacebook(upload.dataBase64, parsed.label);
      }),
    );

    const photoUrlsByLabel = new Map<string, string[]>();
    const photoUploadWarnings: string[] = [];
    if (photoAssets.length > 0) {
      for (const asset of photoAssets) {
        try {
          const url = await uploadImageToCloudinary(
            asset.buffer,
            asset.label,
            asset.mimeType,
          );
          photoUrlsByLabel.set(asset.label, [
            ...(photoUrlsByLabel.get(asset.label) || []),
            url,
          ]);
        } catch (error) {
          photoUploadWarnings.push(
            `${asset.label}: ${error instanceof Error ? error.message : "upload failed"}`,
          );
        }
      }
    }

    const result = await generateAIProposalFromContentBatched({
      note: note || undefined,
      sources: parsedUploads.map((parsed, i) => ({
        label: parsed.label,
        contentText: parsed.text || undefined,
        inline: parsed.inline,
        fbAttachmentId: fbAttachmentIds[i] ?? undefined,
        photoUrls: photoUrlsByLabel.get(parsed.label),
      })),
    });

    if (photoUploadWarnings.length > 0) {
      const warning =
        `Зургийг аялалд автоматаар хавсаргах үед алдаа гарлаа: ${photoUploadWarnings
          .slice(0, 3)
          .join("; ")}${photoUploadWarnings.length > 3 ? "…" : ""}`;
      result.proposal.needs_confirmation = true;
      if (!result.proposal.conflicts.includes(warning)) {
        result.proposal.conflicts.push(warning);
      }
      result.proposal.conflict_items = [
        ...(result.proposal.conflict_items || []),
        { text: warning, severity: "warning", type: "photo_upload_failed" },
      ];
    }

    const failure = getAIProposalFailureResponse(result.proposal);
    if (failure) {
      return res.status(failure.statusCode).json({
        ok: false,
        error: failure.error,
        retry_after_ms: failure.retry_after_ms,
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
