import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Icons,
  Spinner,
  cx,
} from "@/components/ui";
import type {
  AttachedFile,
  ChatMessage,
  ConflictItem,
  ProposalMsg,
  TravelTrip,
} from "@/lib/adminTypes";
import { describeAction, summarizeConflict } from "@/lib/adminProposalUtils";
import {
  MAX_AI_INPUT_CHARS,
  QUICK_ACTIONS,
  formatBytes,
} from "@/lib/adminUtils";
import { diffTripFields, type TripExtraDiff } from "@/lib/tripExtraSchema";

function fileGlyph(file: AttachedFile): string {
  const name = file.name.toLowerCase();
  const mime = (file.mimeType || "").toLowerCase();
  if (mime.startsWith("image/") || /\.(png|jpe?g|webp|gif|heic|heif)$/.test(name))
    return "🖼️";
  if (mime === "application/pdf" || name.endsWith(".pdf")) return "📕";
  if (/\.(xlsx|xlsm|xls|csv)$/.test(name) || mime.includes("sheet")) return "📊";
  if (/\.(txt|text|md|log)$/.test(name) || mime.startsWith("text/")) return "📝";
  return "📎";
}

export function FileChip({
  file,
  onRemove,
}: {
  file: AttachedFile;
  onRemove: () => void;
}) {
  return (
    <span
      className="flex max-w-full items-center gap-1.5 rounded-md border border-line-strong bg-surface py-1 pl-2 pr-1 text-xs text-ink"
      title={`${file.name} • ${formatBytes(file.sizeBytes)}`}
    >
      <span aria-hidden="true" className="shrink-0 text-sm leading-none">
        {fileGlyph(file)}
      </span>
      <span className="truncate font-medium" style={{ maxWidth: "11rem" }}>
        {file.name}
      </span>
      <span className="shrink-0 text-ink-subtle">{formatBytes(file.sizeBytes)}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`${file.name} устгах`}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-subtle hover:bg-surface-sunken hover:text-danger"
      >
        <Icons.close size={13} />
      </button>
    </span>
  );
}

/* ----------------------------------------------------------------
   Assistant tab
   ---------------------------------------------------------------- */
export function AssistantTab({
  messages,
  existingTrips = [],
  aiInput,
  setAiInput,
  attachedFiles,
  onRemoveAttachedFile,
  dragOver,
  setDragOver,
  busy,
  busyLabel,
  busyProgress,
  applyBusyId,
  clarifyBusyId,
  onSend,
  onApply,
  onRollback,
  onSubmitClarificationForm,
  onCancelProposal,
  onToggleConfirm,
  onPickFile,
  onDropFiles,
  chatEndRef,
  inputRef,
}: {
  messages: ChatMessage[];
  existingTrips?: TravelTrip[];
  aiInput: string;
  setAiInput: (value: string) => void;
  attachedFiles: AttachedFile[];
  onRemoveAttachedFile: (fileId: string) => void;
  dragOver: boolean;
  setDragOver: (value: boolean) => void;
  busy: boolean;
  busyLabel: string;
  busyProgress: number | null;
  applyBusyId: string;
  clarifyBusyId: string;
  onSend: () => void;
  onApply: (message: ProposalMsg) => void;
  onRollback: (message: ProposalMsg) => void;
  onSubmitClarificationForm: (
    message: ProposalMsg,
    answers: Record<string, string>,
  ) => void;
  onCancelProposal: (id: string) => void;
  onToggleConfirm: (id: string, value: boolean) => void;
  onPickFile: () => void;
  onDropFiles: (files: FileList | File[]) => void;
  chatEndRef: React.RefObject<HTMLDivElement | null>;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const attachedTotalBytes = attachedFiles.reduce(
    (sum, file) => sum + file.sizeBytes,
    0,
  );

  return (
    <div className="space-y-4">
      {/* Photo-first hero: drop trip photos → AI reads them into draft trips */}
      <Card
        className={cx(
          "overflow-hidden",
          dragOver && "ring-2 ring-brand",
        )}
      >
        <button
          type="button"
          onClick={onPickFile}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const files = e.dataTransfer.files;
            if (files?.length) onDropFiles(files);
          }}
          className="group flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-brand-soft/35 sm:gap-4"
        >
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-soft to-travel-soft text-brand transition-transform duration-200 group-hover:scale-105 sm:h-14 sm:w-14">
            <Icons.trips size={26} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-base font-semibold text-ink">
              Аяллын зургаа энд тавьж аялал үүсгэх
            </p>
            <p className="mt-0.5 text-sm text-ink-muted">
              Аяллын постер, үнийн зураг, хөтөлбөрийн зургаа чирж оруулаарай — AI
              уншиж, үнэ/огноо/маршрутыг автоматаар аялал болгож санал болгоно. Та
              шалгаад баталгаажуулна.
            </p>
            <p className="mt-1 text-sm text-ink-subtle">
              Зураг (JPG, PNG), PDF, Excel дэмжинэ. Олон зураг нэг дор болно.
            </p>
          </div>
          <span className="hidden h-10 shrink-0 items-center gap-2 rounded-md bg-brand px-4 text-sm font-semibold text-white shadow-xs shadow-brand/30 sm:inline-flex">
            <Icons.paperclip size={15} />
            Файл сонгох
          </span>
        </button>
      </Card>

      <Card
        className={cx(
          "flex flex-col overflow-hidden",
          dragOver && "ring-2 ring-brand",
        )}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const files = e.dataTransfer.files;
          if (files?.length) onDropFiles(files);
        }}
      >
        <div className="scroll-area max-h-[55dvh] min-h-[18rem] space-y-3 overflow-y-auto p-3.5">
          {/* Friendly empty state when only the intro note is present. */}
          {messages.length <= 1 && messages[0]?.id === "intro" ? (
            <div className="flex h-full min-h-[16rem] flex-col items-center justify-center px-6 text-center">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-soft text-brand">
                <Icons.ai size={24} />
              </div>
              <p className="text-base font-semibold text-ink">
                AI туслахтай ярилцаарай
              </p>
              <p className="mt-1.5 max-w-md text-sm text-ink-muted">
                Аяллын зураг, прайс жагсаалт (PDF, Excel) хавсаргаж аялал
                автоматаар үүсгээрэй. Эсвэл доор бичгээр зааварчилж болно — ж:{" "}
                <span className="text-ink">«Бээжингийн аяллын үнийг 4.5 сая болго»</span>.
              </p>
              <p className="mt-2 text-xs text-ink-subtle">
                AI санал болгоно — та шалгаад баталгаажуулна.
              </p>
            </div>
          ) : (
            messages.map((message) => (
              <ChatBubbleV2
                key={message.id}
                message={message}
                existingTrips={existingTrips}
                applyBusy={applyBusyId === message.id}
                clarifyBusy={clarifyBusyId === message.id}
                onApply={onApply}
                onRollback={onRollback}
                onSubmitClarificationForm={onSubmitClarificationForm}
                onCancelProposal={onCancelProposal}
                onToggleConfirm={onToggleConfirm}
              />
            ))
          )}
          {busy && (
            <div className="flex justify-start">
              <div className="w-full max-w-xl rounded-2xl rounded-bl-sm border border-line bg-surface px-4 py-3.5 shadow-sm">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink">
                      {busyProgress != null ? "Файл боловсруулж байна" : "AI хариу бэлдэж байна"}
                    </p>
                    {busyLabel && (
                      <p className="mt-0.5 truncate text-sm text-ink-muted">{busyLabel}</p>
                    )}
                  </div>
                  {busyProgress != null ? (
                    <span className="shrink-0 font-mono text-lg font-bold text-brand">
                      {Math.round(busyProgress)}%
                    </span>
                  ) : (
                    <Spinner className="shrink-0 text-brand" />
                  )}
                </div>
                <div
                  className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-sunken"
                  role="progressbar"
                  aria-label="Файл боловсруулах явц"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={busyProgress ?? undefined}
                >
                  <div
                    className={cx(
                      "h-full rounded-full bg-brand transition-[width] duration-500",
                      busyProgress == null && "w-1/3 animate-pulse",
                    )}
                    style={busyProgress != null ? { width: `${busyProgress}%` } : undefined}
                  />
                </div>
                {busyProgress != null && (
                  <p className="mt-1.5 text-right text-sm text-ink-subtle">
                    {Math.max(0, 100 - Math.round(busyProgress))}% үлдсэн
                  </p>
                )}
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        <div className="scroll-area flex gap-1.5 overflow-x-auto border-t border-line bg-surface-sunken px-3 py-2">
          {QUICK_ACTIONS.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={() => {
                setAiInput(action.prompt);
                inputRef.current?.focus();
              }}
              className="shrink-0 rounded-full border border-line-strong bg-surface px-3 py-1 text-xs font-medium text-ink-muted transition-colors duration-150 hover:border-brand hover:bg-brand-soft/50 hover:text-brand"
            >
              {action.label}
            </button>
          ))}
        </div>

        {attachedFiles.length > 0 && (
          <div className="border-t border-line bg-surface-sunken px-3 py-2.5">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-ink-muted">
                {attachedFiles.length} файл бэлэн • ~{formatBytes(attachedTotalBytes)}
              </span>
              <button
                type="button"
                onClick={() =>
                  attachedFiles.forEach((file) => onRemoveAttachedFile(file.id))
                }
                className="text-xs font-medium text-brand hover:opacity-70"
              >
                Бүгдийг арилгах
              </button>
            </div>
            <div className="scroll-area flex flex-wrap gap-1.5">
              {attachedFiles.map((file) => (
                <FileChip
                  key={file.id}
                  file={file}
                  onRemove={() => onRemoveAttachedFile(file.id)}
                />
              ))}
            </div>
          </div>
        )}

        <div className="flex items-end gap-2 border-t border-line p-2.5">
          <button
            type="button"
            onClick={onPickFile}
            aria-label="Файл хавсаргах"
            className="flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-md border border-line-strong bg-surface px-2.5 text-sm font-medium text-ink-muted transition-colors hover:border-brand hover:text-brand"
          >
            <Icons.paperclip size={17} />
            <span className="hidden sm:inline">Файл</span>
          </button>
          <textarea
            ref={inputRef}
            value={aiInput}
            onChange={(e) => setAiInput(e.target.value)}
            maxLength={MAX_AI_INPUT_CHARS}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            rows={1}
            placeholder="Ж: «Бангкок аяллыг цуцал» эсвэл прайс жагсаалт файл хавсаргах"
            className="scroll-area max-h-32 min-h-10 flex-1 resize-none rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink transition-colors placeholder:text-ink-subtle focus:border-brand"
          />
          <Button
            onClick={onSend}
            disabled={busy || (!aiInput.trim() && attachedFiles.length === 0)}
            className="h-10 shrink-0"
          >
            Илгээх
          </Button>
        </div>
      </Card>

      <p className="px-1 text-xs text-ink-subtle">
        Олон файл нэг дор оруулж болно. Том файлуудыг систем автоматаар хэсэглэн, дарааллаар нь уншина.
      </p>

    </div>
  );
}
function ChatBubbleV2({
  message,
  existingTrips = [],
  applyBusy,
  clarifyBusy,
  onApply,
  onRollback,
  onSubmitClarificationForm,
  onCancelProposal,
  onToggleConfirm,
}: {
  message: ChatMessage;
  existingTrips?: TravelTrip[];
  applyBusy: boolean;
  clarifyBusy: boolean;
  onApply: (message: ProposalMsg) => void;
  onRollback: (message: ProposalMsg) => void;
  onSubmitClarificationForm: (
    message: ProposalMsg,
    answers: Record<string, string>,
  ) => void;
  onCancelProposal: (id: string) => void;
  onToggleConfirm: (id: string, value: boolean) => void;
}) {
  const [formDraft, setFormDraft] = useState<Record<string, string>>({});
  const [fieldOverrides, setFieldOverrides] = useState<Record<string, string>>({});
  const [showAllChanges, setShowAllChanges] = useState(false);
  if (message.role === "admin") {
    return (
      <div className="animate-fade-up flex justify-end">
        <div className="max-w-[90%] rounded-xl rounded-br-sm bg-gradient-to-b from-brand-hover to-brand px-3.5 py-2.5 text-sm text-white shadow-sm shadow-brand/20">
          {message.text && message.text !== "Файл орууллаа" && (
            <p className="whitespace-pre-wrap wrap-break-word">{message.text}</p>
          )}
          {message.fileNames && message.fileNames.length > 0 && (
            <div className={message.text && message.text !== "Файл орууллаа" ? "mt-2 border-t border-white/20 pt-2" : undefined}>
              <p className="text-xs font-semibold text-white/70 mb-1">
                📎 {message.fileNames.length === 1 ? "Файл" : `${message.fileNames.length} файл`}
              </p>
              {message.fileNames.map((name) => (
                <p key={name} className="text-xs text-white/90 truncate">{name}</p>
              ))}
            </div>
          )}
          {(!message.fileNames || message.fileNames.length === 0) && (!message.text || message.text === "Файл орууллаа") && (
            <p className="whitespace-pre-wrap wrap-break-word">{message.text}</p>
          )}
        </div>
      </div>
    );
  }

  if (message.kind === "note") {
    const tone =
      message.tone === "error"
        ? "danger"
        : message.tone === "success"
          ? "success"
          : "info";
    return (
      <div className="animate-fade-up max-w-[92%]">
        <Alert tone={tone}>{message.text}</Alert>
      </div>
    );
  }

  const { proposal } = message;
  const describedActions = proposal.actions.map(describeAction);

  // Build a diff per action: match the action's trip_id or route_name against existing trips
  function getDiffsForAction(actionIndex: number): TripExtraDiff[] {
    const action = proposal.actions[actionIndex];
    if (!action || !existingTrips.length) return [];
    const verb = String(action.action || "").toLowerCase();
    const isCreate = verb === "upsert" && !action.trip_id;
    if (verb !== "patch" && !isCreate && !(verb === "upsert" && action.trip_id)) {
      return [];
    }
    const tripId = action.trip_id?.trim();
    const routeName = action.match?.route_name?.trim() ||
      (action.fields?.route_name as string | undefined)?.trim();
    const existing = isCreate
      ? null
      : existingTrips.find(
          (t) =>
            (tripId && t.id === tripId) ||
            (routeName &&
              t.route_name.toLowerCase() === routeName.toLowerCase()),
        );
    return diffTripFields(action.fields as Record<string, unknown> ?? {}, {
      adult_price: existing?.adult_price ?? null,
      child_price: existing?.child_price ?? null,
      departure_dates: existing?.departure_dates ?? [],
      status: existing?.status ?? "",
      seats_total: existing?.seats_total ?? null,
      seats_left: existing?.seats_left ?? null,
      duration_text: existing?.duration_text ?? "",
      currency: existing?.currency ?? "MNT",
    });
  }
  const visibleActions = showAllChanges
    ? describedActions
    : describedActions.slice(0, 5);
  const hiddenActionCount = Math.max(0, describedActions.length - visibleActions.length);
  // When structured conflict_items are present, use them for display.
  // info/warning items → amber info box (no question asked).
  // blocker items not yet answered → become clarification questions.
  const hasStructuredItems =
    (proposal.conflict_items?.length ?? 0) > 0;
  const infoWarningItems: ConflictItem[] = hasStructuredItems
    ? (proposal.conflict_items ?? []).filter(
        (item) => item.severity === "info" || item.severity === "warning",
      )
    : [];
  const compactWarnings: string[] = hasStructuredItems
    ? infoWarningItems.map((item) => item.text).slice(0, 3)
    : Array.from(
        new Set(proposal.conflicts.map(summarizeConflict).filter(Boolean)),
      ).slice(0, 3);
  const reviewCount = message.clarifications.length;
  const isReadyToApply =
    message.status === "pending" &&
    reviewCount === 0 &&
    message.confirmChecked === true;

  return (
    <div className="animate-fade-up w-full max-w-5xl">
      <div className="rounded-2xl rounded-bl-sm bg-surface p-4 shadow-sm ring-1 ring-line sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-base font-semibold leading-6 text-ink">{proposal.summary}</p>
            {message.sourceNames && message.sourceNames.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-sm text-ink-muted">
                <Icons.paperclip size={15} className="shrink-0 text-ink-subtle" />
                <span className="font-medium text-ink">Эх файл:</span>
                {message.sourceNames.map((name, index) => (
                  <span key={`${name}:${index}`} className="rounded-full bg-surface-sunken px-2.5 py-1 text-ink-muted">
                    {name}
                  </span>
                ))}
              </div>
            )}
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge tone="neutral">{proposal.actions.length} өөрчлөлт</Badge>
              {reviewCount > 0 ? (
                <Badge tone="warning">{reviewCount} шийдвэр хэрэгтэй</Badge>
              ) : (
                <Badge tone="success">Шууд хадгалахад бэлэн</Badge>
              )}
            </div>
          </div>
          <Badge tone={isReadyToApply ? "success" : "warning"}>
            {isReadyToApply ? "Бэлэн" : "Хянах"}
          </Badge>
        </div>

        {compactWarnings.length > 0 && (
          <div className="mt-4 rounded-lg border-l-4 border-warning bg-warning-soft px-3.5 py-3">
            <p className="text-sm font-semibold text-warning">
              Анхаарах зүйл
            </p>
            <div className="mt-1 space-y-1">
              {compactWarnings.map((item) => (
                <p key={item} className="text-sm leading-5 text-warning">
                  {item}
                </p>
              ))}
            </div>
          </div>
        )}

        {visibleActions.length > 0 && (
          <section className="mt-4 border-t border-line pt-4" aria-label="Санал болгосон өөрчлөлтүүд">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">Өөрчлөлтүүд</h3>
              {describedActions.length > 5 && (
                <button
                  type="button"
                  onClick={() => setShowAllChanges((shown) => !shown)}
                  className="text-xs font-medium text-brand hover:text-brand-hover"
                >
                  {showAllChanges ? "Хураах" : `Бүгдийг харах · ${describedActions.length}`}
                </button>
              )}
            </div>
            <div className={cx("mt-2 space-y-1", showAllChanges && "max-h-96 overflow-y-auto pr-1 scroll-area")}>
              {visibleActions.map((described, index) => {
                const diffs = getDiffsForAction(index);
                const verbColor =
                  described.verb === "Шинэ аялал нэмэх"
                    ? "bg-success-soft text-success"
                    : described.verb === "Цуцлах"
                      ? "bg-danger-soft text-danger"
                      : "bg-surface-sunken text-ink-muted";
                return (
                  <div
                    key={`${described.verb}:${described.target}:${index}`}
                    className="rounded-xl bg-surface-sunken px-3 py-2.5"
                  >
                    <div className="flex items-start gap-2.5">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface text-[11px] font-semibold text-ink-subtle ring-1 ring-line">
                        {index + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-sm font-semibold text-ink leading-5">{described.target}</span>
                          <span className={cx("rounded-full px-2 py-0.5 text-[11px] font-medium", verbColor)}>
                            {described.verb}
                          </span>
                        </div>
                        {described.changes.length > 0 && (
                          <p className="mt-0.5 text-xs leading-5 text-ink-muted">
                            {described.changes.slice(0, 4).join(" · ")}
                          </p>
                        )}
                        {diffs.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {diffs.map((d) => (
                              <span
                                key={d.field}
                                className={cx(
                                  "inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium",
                                  d.kind === "added" && "bg-success-soft text-success",
                                  d.kind === "removed" && "bg-danger-soft text-danger",
                                  d.kind === "changed" && "bg-warning-soft text-warning",
                                )}
                              >
                                {d.kind === "changed" && (
                                  <>{d.label}: <span className="line-through opacity-60">{d.before}</span> → {d.after}</>
                                )}
                                {d.kind === "added" && <>+{d.label}: {d.after}</>}
                                {d.kind === "removed" && <>−{d.label}: {d.before}</>}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {hiddenActionCount > 0 && (
              <p className="mt-1.5 text-xs text-ink-subtle">+ {hiddenActionCount} өөр өөрчлөлт</p>
            )}
          </section>
        )}

        {message.clarificationAnswers.length > 0 && (
          <details className="mt-4 border-t border-line pt-3">
            <summary className="cursor-pointer text-sm font-semibold text-brand">
              Өмнө сонгосон хариултууд ({message.clarificationAnswers.length})
            </summary>
            <div className="mt-2 space-y-2">
              {message.clarificationAnswers.map((item) => (
                <div key={item.questionId} className="rounded-md bg-surface-sunken px-2.5 py-2">
                  <p className="text-sm text-ink-muted">{item.prompt}</p>
                  <p className="mt-1 text-sm text-ink">{item.answer}</p>
                </div>
              ))}
            </div>
          </details>
        )}

        {message.status === "pending" && (
          <div className="mt-4 border-t border-line pt-4">
            {message.clarifications.length > 0 ? (
              <div className="space-y-4">
                <div>
                  <h3 className="text-base font-semibold text-ink">Тодруулах зүйлс</h3>
                  <p className="mt-0.5 text-sm text-ink-muted">
                    Доорх нэг шийдвэрийг сонгох эсвэл зөв утгыг өөрөө бичнэ үү.
                  </p>
                </div>
                {message.clarifications.map((q) => {
                  const selected =
                    formDraft[q.id] ?? q.options.find((o) => o.recommended)?.answer ?? "";
                  return (
                    <div
                      key={q.id}
                      className="rounded-xl border border-warning/30 bg-warning-soft px-4 py-3.5"
                    >
                      <p className="text-sm font-semibold leading-5 text-ink">{q.prompt}</p>
                      {q.detail && (
                        <p className="mt-1.5 text-xs leading-5 text-ink-muted">{q.detail}</p>
                      )}
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {q.options.map((opt) => (
                          <button
                            key={opt.label}
                            type="button"
                            disabled={clarifyBusy}
                            onClick={() =>
                              setFormDraft((prev) => ({ ...prev, [q.id]: opt.answer }))
                            }
                            className={cx(
                              "rounded-full border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-60",
                              selected === opt.answer
                                ? "border-brand bg-brand text-white"
                                : "border-line-strong bg-surface text-ink hover:border-brand hover:text-brand",
                            )}
                          >
                            {opt.label}
                            {opt.recommended && (
                              <span
                                className={cx(
                                  "ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                                  selected === opt.answer
                                    ? "bg-white/20 text-white"
                                    : "bg-brand-soft text-brand",
                                )}
                              >
                                Санал болгосон
                              </span>
                            )}
                          </button>
                        ))}
                      </div>
                      {q.allowCustom && (
                        <input
                          value={
                            q.options.some((o) => o.answer === selected) ? "" : selected
                          }
                          onChange={(e) =>
                            setFormDraft((prev) => ({ ...prev, [q.id]: e.target.value }))
                          }
                          placeholder={q.customPlaceholder || "Өөрийн хариуг бичнэ үү"}
                          className="mt-2 h-9 w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-ink transition-colors focus:border-brand"
                        />
                      )}
                    </div>
                  );
                })}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    loading={clarifyBusy}
                    disabled={
                      clarifyBusy ||
                      message.clarifications.some(
                        (q) =>
                          !(
                            formDraft[q.id] ?? q.options.find((o) => o.recommended)?.answer ?? ""
                          ).trim(),
                      )
                    }
                    onClick={() => {
                      // Fill in the recommended default for any question the
                      // admin never explicitly tapped, so it's actually
                      // submitted (not silently dropped for having no entry).
                      const effectiveDraft = { ...formDraft };
                      for (const q of message.clarifications) {
                        if (effectiveDraft[q.id]) continue;
                        const recommended = q.options.find((o) => o.recommended)?.answer;
                        if (recommended) effectiveDraft[q.id] = recommended;
                      }
                      onSubmitClarificationForm(message, effectiveDraft);
                      setFormDraft({});
                    }}
                  >
                    Шийдвэрүүдийг хадгалах
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onCancelProposal(message.id)}
                  >
                    Болих
                  </Button>
                </div>
              </div>
            ) : (
              <p className="mb-3 text-sm text-ink-muted">
                {proposal.conflicts.length > 0
                  ? "Тодорхойгүй байсан зүйлсийг нарийвчилсан. Зөв харагдвал хэрэгжүүлж болно."
                  : "Бүх зүйл тодорхой байна. Өөрчлөлтийг хэрэгжүүлж болно."}
              </p>
            )}
            {message.clarifications.length === 0 && (() => {
              const proposalMsg = message as ProposalMsg;
              const createActions = proposal.actions
                .map((a, i) => ({ action: a, index: i }))
                .filter(({ action }) => (action.action || "").toLowerCase() === "upsert");

              function fieldKey(actionIndex: number, field: string) {
                return `${actionIndex}:${field}`;
              }
              function getField(actionIndex: number, field: string, fallback: unknown): string {
                const k = fieldKey(actionIndex, field);
                if (k in fieldOverrides) return fieldOverrides[k];
                const v = (proposal.actions[actionIndex]?.fields ?? {})[field];
                return v != null ? String(v) : fallback != null ? String(fallback) : "";
              }
              function setField(actionIndex: number, field: string, value: string) {
                setFieldOverrides((prev) => ({ ...prev, [fieldKey(actionIndex, field)]: value }));
              }

              function buildMessageWithOverrides(): ProposalMsg {
                if (Object.keys(fieldOverrides).length === 0) return proposalMsg;
                const newActions = proposalMsg.proposal.actions.map((action, i) => {
                  const overrideEntries = Object.entries(fieldOverrides)
                    .filter(([k]) => k.startsWith(`${i}:`))
                    .map(([k, v]) => [k.slice(k.indexOf(":") + 1), v]);
                  if (overrideEntries.length === 0) return action;
                  const newFields = { ...(action.fields ?? {}) };
                  for (const [field, val] of overrideEntries) {
                    if (field === "adult_price" || field === "child_price" || field === "seats_total" || field === "seats_left") {
                      const n = parseFloat(val);
                      newFields[field] = isNaN(n) ? null : n;
                    } else if (field === "has_food") {
                      newFields[field] = val === "true" ? true : val === "false" ? false : null;
                    } else if (field === "departure_dates") {
                      newFields[field] = val.split(",").map((d) => d.trim()).filter(Boolean);
                    } else {
                      newFields[field] = val;
                    }
                  }
                  return { ...action, fields: newFields };
                });
                return {
                  ...proposalMsg,
                  proposal: { ...proposalMsg.proposal, actions: newActions },
                };
              }

              return (
                <div className="space-y-3">
                  {createActions.length > 5 && (
                    <p className="text-xs text-ink-subtle">
                      {createActions.length} шинэ аяллын мэдээлэл байна. Доорх картуудыг гүйлгэж засварлана.
                    </p>
                  )}
                  <div className={cx("space-y-3", createActions.length > 3 && "max-h-96 overflow-y-auto scroll-area pr-1")}>
                  {createActions.map(({ action, index }) => {
                    const f = action.fields ?? {};
                    const inputCls = "h-9 w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-ink transition-colors placeholder:text-ink-subtle focus:border-brand";
                    return (
                      <div key={index} className="rounded-xl border border-line bg-surface-sunken p-3 space-y-3">
                        <p className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
                          {createActions.length > 1 ? `Аялал ${index + 1}` : "Аялалын мэдээлэл"}
                        </p>
                        {/* Row 1: name full width */}
                        <div>
                          <label className="mb-1 block text-xs text-ink-muted">Аяллын нэр</label>
                          <input
                            value={getField(index, "route_name", f.route_name)}
                            onChange={(e) => setField(index, "route_name", e.target.value)}
                            placeholder="ж: Бээжин аялал"
                            className={inputCls}
                          />
                        </div>
                        {/* Row 2: operator + duration */}
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="mb-1 block text-xs text-ink-muted">Оператор</label>
                            <input
                              value={getField(index, "operator_name", f.operator_name)}
                              onChange={(e) => setField(index, "operator_name", e.target.value)}
                              placeholder="Uudam Travel"
                              className={inputCls}
                            />
                          </div>
                          <div>
                            <label className="mb-1 block text-xs text-ink-muted">Хугацаа</label>
                            <input
                              value={getField(index, "duration_text", f.duration_text)}
                              onChange={(e) => setField(index, "duration_text", e.target.value)}
                              placeholder="5 хоног"
                              className={inputCls}
                            />
                          </div>
                        </div>
                        {/* Row 3: prices */}
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="mb-1 block text-xs text-ink-muted">Том хүн үнэ ₮</label>
                            <input
                              type="number"
                              value={getField(index, "adult_price", f.adult_price)}
                              onChange={(e) => setField(index, "adult_price", e.target.value)}
                              placeholder="1890000"
                              className={inputCls}
                            />
                          </div>
                          <div>
                            <label className="mb-1 block text-xs text-ink-muted">Хүүхэд үнэ ₮</label>
                            <input
                              type="number"
                              value={getField(index, "child_price", f.child_price)}
                              onChange={(e) => setField(index, "child_price", e.target.value)}
                              placeholder="заавал биш"
                              className={inputCls}
                            />
                          </div>
                        </div>
                        {/* Row 4: dates full width */}
                        <div>
                          <label className="mb-1 block text-xs text-ink-muted">Гарах өдрүүд — таслалаар</label>
                          <input
                            value={getField(index, "departure_dates", Array.isArray(f.departure_dates) ? (f.departure_dates as string[]).join(", ") : "")}
                            onChange={(e) => setField(index, "departure_dates", e.target.value)}
                            placeholder="7 сарын 9, 7 сарын 18, 8 сарын 1"
                            className={inputCls}
                          />
                        </div>
                        {/* Row 5: seats + food */}
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="mb-1 block text-xs text-ink-muted">Суудал</label>
                            <input
                              type="number"
                              value={getField(index, "seats_total", f.seats_total)}
                              onChange={(e) => setField(index, "seats_total", e.target.value)}
                              placeholder="заавал биш"
                              className={inputCls}
                            />
                          </div>
                          <div>
                            <label className="mb-1 block text-xs text-ink-muted">Хоол</label>
                            <select
                              value={getField(index, "has_food", f.has_food == null ? "" : String(f.has_food))}
                              onChange={(e) => setField(index, "has_food", e.target.value)}
                              className={inputCls}
                            >
                              <option value="">Тодорхойгүй</option>
                              <option value="true">Багтсан</option>
                              <option value="false">Ороогүй</option>
                            </select>
                          </div>
                        </div>
                        {/* Row 6: hotel + notes */}
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="mb-1 block text-xs text-ink-muted">Буудал</label>
                            <input
                              value={getField(index, "hotel", f.hotel)}
                              onChange={(e) => setField(index, "hotel", e.target.value)}
                              placeholder="заавал биш"
                              className={inputCls}
                            />
                          </div>
                          <div>
                            <label className="mb-1 block text-xs text-ink-muted">Тэмдэглэл</label>
                            <input
                              value={getField(index, "notes", f.notes)}
                              onChange={(e) => setField(index, "notes", e.target.value)}
                              placeholder="заавал биш"
                              className={inputCls}
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  </div>
                  <label className="flex cursor-pointer items-start gap-2 pt-1">
                    <input
                      type="checkbox"
                      checked={message.confirmChecked === true}
                      onChange={(e) => onToggleConfirm(message.id, e.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-line-strong accent-brand"
                    />
                    <span className="text-sm text-ink">
                      Баталгаажуулж байна: энэ өөрчлөлтийг хадгална
                    </span>
                  </label>
                  <div className="flex gap-2 pt-1">
                    <Button
                      size="sm"
                      variant="success"
                      loading={applyBusy}
                      disabled={!isReadyToApply || applyBusy}
                      onClick={() => onApply(buildMessageWithOverrides())}
                    >
                      <Icons.check size={15} />
                      Хадгалах
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onCancelProposal(message.id)}
                    >
                      Болих
                    </Button>
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {message.status === "applied" && (
          <div className="mt-3 space-y-2 border-t border-line pt-2">
            <div className="flex items-center gap-1.5 text-xs font-medium text-success">
              <Icons.check size={14} />
              Хадгалагдлаа. {message.resultText}
            </div>
            {message.requestId != null && (
              <Button
                size="sm"
                variant="secondary"
                loading={applyBusy}
                onClick={() => onRollback(message)}
              >
                Буцаах
              </Button>
            )}
          </div>
        )}
        {message.status === "reverted" && (
          <div className="mt-3 flex items-center gap-1.5 border-t border-line pt-2 text-xs font-medium text-warning">
            <Icons.alert size={14} />
            Өөрчлөлт буцаагдлаа. {message.resultText}
          </div>
        )}
        {message.status === "cancelled" && (
          <p className="mt-3 border-t border-line pt-2 text-xs text-ink-subtle">
            Цуцлагдсан.
          </p>
        )}
        {message.status === "error" && (
          <p className="mt-3 border-t border-line pt-2 text-xs text-danger">
            {message.resultText || "Алдаа гарлаа."}
          </p>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------
   Trips tab
   ---------------------------------------------------------------- */
