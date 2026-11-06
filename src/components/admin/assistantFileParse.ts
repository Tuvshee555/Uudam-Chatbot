/**
 * The assistant tab's file → trip reader: each attached file (or Google Drive link) is sent to
 * /api/admin/parse-file, retried through rate limits with a visible countdown, and the readings
 * are merged into one proposal. Moved out of pages/admin.tsx unchanged (the page is capped at
 * 2,000 lines); photos sent with a photo instruction do not come here (useAssistantChat).
 */
import {
  MAX_PARSE_UPLOAD_BYTES, apiErrorMessage, buildImageUploadUnit, buildOfficeUploadUnits, buildPdfUploadUnits,
  buildTextUploadUnits, buildZipImageUploadUnits, dataUrlToText, delayMs, emptyChunkResult, fileToDataUrl,
  groupDocumentWithImages, isImageFile, isOfficeDocFile, isPdfFile, isStaleBundleError, isTextLikeFile,
  isTransientAiFailure, isZipFile, mergeAIProposals, shortId, STALE_BUNDLE_MESSAGE,
} from "@/lib/adminPageUtils";
import type { AIProposal, AIProposalResponse, AttachedFile, ParseUploadUnit } from "@/lib/adminTypes";

export const MAX_AI_SOURCE_TEXT_CHARS = 20_000;

type FileParserDeps = {
  fetchWithAdmin: (url: string, init?: RequestInit) => Promise<Response>;
  readJsonSafe: (response: Response) => Promise<Record<string, unknown>>;
  toastError: (message: string) => void;
  setBusyLabel: (label: string) => void;
  setBusyProgress: (next: number | null | ((current: number | null) => number | null)) => void;
};

export type ParsedFiles = { proposal: AIProposal; requestId: number | null; sourceText: string };

export function createFileParser({ fetchWithAdmin, readJsonSafe, toastError, setBusyLabel, setBusyProgress }: FileParserDeps) {
  async function waitWithCountdown(progressLabel: string, totalMs: number, attempt: number) {
    const stepMs = 1_000;
    let remaining = Math.max(stepMs, Math.round(totalMs));
    while (remaining > 0) {
      const secs = Math.ceil(remaining / 1000);
      setBusyLabel(`${progressLabel} — AI түр завгүй байна, ${secs}с дараа үргэлжилнэ` + (attempt > 3 ? ` (оролдлого ${attempt})` : ""));
      await delayMs(Math.min(stepMs, remaining));
      remaining -= stepMs;
    }
  }

  /** One parse-file request until it answers usefully, with the same retry rules for files and Drive links. */
  async function parseWithRetry(body: Record<string, unknown>, label: string, progressLabel: string): Promise<{ proposal: AIProposal; requestId: number | null }> {
    const MAX_HARD_FAILURES = 6; // consecutive non-rate-limit failures
    const MAX_TRANSIENT_RETRIES = 1;
    let hardFailures = 0;
    let transientRetries = 0;
    let waitAttempt = 0;
    while (true) {
      let res: Response;
      try {
        res = await fetchWithAdmin("/api/admin/parse-file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch {
        hardFailures += 1;
        if (hardFailures >= MAX_HARD_FAILURES) return emptyChunkResult(label, "Сүлжээний алдаа: сервер хүрч чадсангүй.");
        await waitWithCountdown(progressLabel, 15_000, ++waitAttempt);
        continue;
      }
      const json = (await readJsonSafe(res)) as AIProposalResponse;
      // Billing and key failures stop everything at once: no unit can succeed, and
      // waiting would only hide the cause. The thrown message becomes the chat note.
      if (res.status === 402 || json.error === "ai_credits_exhausted" || json.error === "ai_unauthorized") {
        throw new Error(apiErrorMessage(json, "AI үйлчилгээ ажиллахгүй байна."));
      }
      const rateLimited = res.status === 429;
      const transientOk = res.ok && isTransientAiFailure(json.proposal) && !json.proposal?.actions?.length;
      if (rateLimited || transientOk) {
        if (transientRetries >= MAX_TRANSIENT_RETRIES) {
          return emptyChunkResult(label, apiErrorMessage(json, "AI түр хязгаарлагдсан (rate limit). Хэдэн минутын дараа дахин оруулна уу."));
        }
        transientRetries += 1;
        const waitMs = typeof json.retry_after_ms === "number" && json.retry_after_ms > 0
          ? json.retry_after_ms
          : Math.min(60_000, 20_000 + waitAttempt * 10_000);
        await waitWithCountdown(progressLabel, waitMs, ++waitAttempt);
        continue;
      }
      if (!res.ok) {
        // The server already said what is wrong with this file (unreadable, too large, a
        // bad request): retrying the same bytes six times with 15s pauses changes nothing.
        if (res.status >= 400 && res.status < 500) {
          return emptyChunkResult(label, apiErrorMessage(json, "Серверт файлыг уншиж чадсангүй."));
        }
        hardFailures += 1;
        if (hardFailures >= MAX_HARD_FAILURES) return emptyChunkResult(label, apiErrorMessage(json, "AI сервер хариу өгсөнгүй."));
        await waitWithCountdown(progressLabel, 15_000, ++waitAttempt);
        continue;
      }
      if (!json.proposal || !Array.isArray(json.proposal.actions)) {
        hardFailures += 1;
        if (hardFailures >= MAX_HARD_FAILURES) return emptyChunkResult(label, "AI ойлгомжтой санал буцаасангүй.");
        await waitWithCountdown(progressLabel, 10_000, ++waitAttempt);
        continue;
      }
      return { proposal: json.proposal, requestId: typeof json.request_id === "number" ? json.request_id : null };
    }
  }

  function parseUploadUnit(unit: ParseUploadUnit, note: string, progressLabel: string) {
    return parseWithRetry({
      uploads: [
        { filename: unit.filename, mimeType: unit.mimeType, dataBase64: unit.dataUrl },
        ...(unit.companions || []).map((companion) => ({
          filename: companion.filename,
          mimeType: companion.mimeType,
          dataBase64: companion.dataUrl,
          ...(companion.photoOnly ? { photoOnly: true } : {}),
          ...(companion.evidenceOnly ? { evidenceOnly: true } : {}),
        })),
      ],
      ...(unit.sameTrip ? { sameTrip: true } : {}),
      note,
    }, unit.displayName, progressLabel);
  }

  async function parseAttachedFiles(files: AttachedFile[], note: string): Promise<ParsedFiles> {
    const proposals: AIProposal[] = [];
    setBusyProgress((current) => Math.max(current ?? 0, 8));
    let singleRequestId: number | null = null;
    const uploadUnits: ParseUploadUnit[] = [];
    const skippedFiles: string[] = [];
    for (const file of files) {
      try {
        if (isPdfFile(file.file)) uploadUnits.push(...(await buildPdfUploadUnits(file.file)));
        else if (isOfficeDocFile(file.file)) uploadUnits.push(...(await buildOfficeUploadUnits(file.file)));
        else if (isTextLikeFile(file.file)) uploadUnits.push(...(await buildTextUploadUnits(file.file)));
        else if (isImageFile(file.file)) uploadUnits.push(await buildImageUploadUnit(file.file));
        else if (isZipFile(file.file)) uploadUnits.push(...(await buildZipImageUploadUnits(file.file)));
        else {
          if (file.file.size > MAX_PARSE_UPLOAD_BYTES) {
            skippedFiles.push(file.name);
            continue;
          }
          uploadUnits.push({ displayName: file.name, filename: file.name, mimeType: file.mimeType, dataUrl: await fileToDataUrl(file.file) });
        }
      } catch (error) {
        // The reason used to be swallowed; "could not read" with no cause sent the
        // owner looking for a different file format (2026-11-04).
        console.error("[assistant] could not prepare file", file.name, error);
        const reason = isStaleBundleError(error)
          ? STALE_BUNDLE_MESSAGE
          : error instanceof Error && error.message ? error.message : "уншиж чадсангүй";
        skippedFiles.push(reason.includes(file.name) ? reason : `${file.name}: ${reason}`);
      }
    }
    if (skippedFiles.length > 0 && uploadUnits.length > 0) {
      toastError(`${skippedFiles.length} файлыг алгаслаа — ${skippedFiles.slice(0, 3).join("; ")}${skippedFiles.length > 3 ? "…" : ""}`);
    }
    // A program and its price picture sent together are one trip: one reading, not two proposals.
    const grouped = groupDocumentWithImages(uploadUnits);
    if (grouped !== uploadUnits) uploadUnits.splice(0, uploadUnits.length, ...grouped);
    const sourceParts: string[] = [];
    if (note.trim()) sourceParts.push(`Админы тэмдэглэл: ${note.trim()}`);
    for (const unit of uploadUnits) {
      if (unit.mimeType === "text/plain" || unit.filename.endsWith(".txt")) {
        const text = dataUrlToText(unit.dataUrl).trim();
        if (text) sourceParts.push(`[${unit.displayName}]\n${text}`);
      }
    }
    const sourceText = sourceParts.join("\n\n").slice(0, MAX_AI_SOURCE_TEXT_CHARS);
    if (uploadUnits.length === 0) {
      // Nothing was sent anywhere. The note must say why, not "no readable file".
      const reasons = skippedFiles.length ? skippedFiles : ["Файл уншигдах хэлбэрт хөрвөсөнгүй."];
      return {
        proposal: {
          summary: "Файлыг уншиж чадсангүй.",
          needs_confirmation: true,
          important_reason: reasons.join(" "),
          conflicts: reasons,
          conflict_items: reasons.map((text) => ({ text, severity: "blocker" as const, type: "file_unreadable" })),
          actions: [],
        },
        requestId: null,
        sourceText,
      };
    }
    setBusyProgress((current) => Math.max(current ?? 0, 15));
    const doneIndexes = new Set<number>();
    const results = await Promise.all(uploadUnits.map((unit, index) =>
      delayMs(index * 400).then(() => parseUploadUnit(
        unit,
        note,
        uploadUnits.length > 1 ? `${files.length} файл уншиж байна… ${index + 1}/${uploadUnits.length}` : `«${unit.displayName}» уншиж байна…`,
      ).then((result) => {
        setBusyProgress(() => {
          doneIndexes.add(index);
          return Math.min(90, 15 + Math.round((doneIndexes.size / uploadUnits.length) * 75));
        });
        return result;
      })),
    ));
    for (const parsed of results) proposals.push(parsed.proposal);
    if (uploadUnits.length === 1) singleRequestId = results[0]?.requestId ?? null;
    return {
      proposal: proposals.length === 1 ? proposals[0] : mergeAIProposals(proposals, files.map((file) => file.name)),
      requestId: singleRequestId,
      sourceText,
    };
  }

  async function parseDriveFileIds(fileIds: string[], note: string): Promise<ParsedFiles> {
    const proposals: AIProposal[] = [];
    let singleRequestId: number | null = null;
    for (let index = 0; index < fileIds.length; index += 1) {
      const fileId = fileIds[index];
      const progressLabel = `${fileIds.length} Google Drive файл уншиж байна… ${index + 1}/${fileIds.length}`;
      setBusyLabel(progressLabel);
      const parsed = await parseWithRetry({ driveFileIds: [fileId], note }, `Google Drive ${shortId(fileId)}`, progressLabel);
      proposals.push(parsed.proposal);
      setBusyProgress(Math.min(90, 15 + Math.round(((index + 1) / fileIds.length) * 75)));
      if (fileIds.length === 1) singleRequestId = parsed.requestId;
    }
    return {
      proposal: proposals.length === 1 ? proposals[0] : mergeAIProposals(proposals, fileIds.map((fileId) => `Google Drive ${shortId(fileId)}`)),
      requestId: singleRequestId,
      sourceText: "",
    };
  }

  return { parseAttachedFiles, parseDriveFileIds };
}
