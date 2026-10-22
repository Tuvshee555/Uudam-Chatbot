import { useEffect, useId, useState } from "react";
import { Button, Card, Icons, cx } from "@/components/ui";
import { AssistantQuickActions, type QuickActionKind } from "./AssistantQuickActions";
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

function formatMoneyMnt(value: unknown): string {
  const n = typeof value === "number" ? value : parseFloat(String(value ?? ""));
  if (!Number.isFinite(n) || n <= 0) return "";
  return `${n.toLocaleString("en-US")}₮`;
}

export function FileChip({
  file,
  onRemove,
  disabled = false,
}: {
  file: AttachedFile;
  onRemove: () => void;
  disabled?: boolean;
}) {
  return (
    <span
      className="flex max-w-full items-center gap-1.5 rounded-lg border border-line bg-surface py-1 pl-2.5 pr-1 text-xs text-ink shadow-xs"
      title={`${file.name} • ${formatBytes(file.sizeBytes)}`}
    >
      <span aria-hidden="true" className="shrink-0 text-sm leading-none">
        {fileGlyph(file)}
      </span>
      <span className="min-w-0 truncate font-medium" style={{ maxWidth: "11rem" }}>
        {file.name}
      </span>
      <span className="shrink-0 text-ink-muted">{formatBytes(file.sizeBytes)}</span>
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label={`${file.name} устгах`}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-muted hover:bg-surface-sunken hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Icons.close size={13} />
      </button>
    </span>
  );
}

/* ----------------------------------------------------------------
   Assistant tab — one chat surface. Drop files anywhere on it,
   type below, review proposals inline like a conversation.
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
  onQuickAction,
  onEditTripPrice,
  onNewTrip,
  onApply,
  onRollback,
  onSubmitClarificationForm,
  onCancelProposal,
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
  onQuickAction: (kind: QuickActionKind, trip: TravelTrip, value?: number | boolean) => void;
  onEditTripPrice: (trip: TravelTrip) => void;
  onNewTrip: () => void;
  onApply: (message: ProposalMsg) => void;
  onRollback: (message: ProposalMsg) => void;
  onSubmitClarificationForm: (
    message: ProposalMsg,
    answers: Record<string, string>,
  ) => void;
  onCancelProposal: (id: string) => void;
  onPickFile: () => void;
  onDropFiles: (files: FileList | File[]) => void;
  chatEndRef: React.RefObject<HTMLDivElement | null>;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const composerId = useId();
  const attachedTotalBytes = attachedFiles.reduce(
    (sum, file) => sum + file.sizeBytes,
    0,
  );
  const isEmpty = messages.length === 0 || (messages.length === 1 && messages[0]?.id === "intro");
  const canSend = !busy && (Boolean(aiInput.trim()) || attachedFiles.length > 0);
  const progress = busyProgress == null ? null : Math.min(100, Math.max(0, busyProgress));

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }, [aiInput, inputRef]);

  return (
    <Card
      className={cx(
        "relative flex min-w-0 flex-col overflow-hidden transition-shadow",
        dragOver && "ring-2 ring-brand",
      )}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = busy ? "none" : "copy";
        if (busy) return;
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setDragOver(false);
      }}
      onDrop={(e) => {
        const files = e.dataTransfer.files;
        if (!files?.length) return;
        e.preventDefault();
        setDragOver(false);
        if (!busy) onDropFiles(files);
      }}
    >
      <div className="flex items-center gap-3 border-b border-line px-4 py-3.5 sm:px-5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
          <Icons.ai size={19} />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink">Аяллын туслах</h2>
          <p className="mt-0.5 text-xs leading-5 text-ink-muted">Би санал бэлдэнэ. Та хянаад хадгална.</p>
        </div>
      </div>
      {dragOver && !busy && (
        <div className="pointer-events-none absolute inset-2 z-10 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-brand bg-surface/95 p-5 text-center" role="status">
          <Icons.upload size={28} className="text-brand" />
          <p className="text-base font-semibold text-ink">Файлаа энд тавиарай</p>
          <p className="text-sm text-ink-muted">Уншаад өөрчлөлтийн санал бэлдье.</p>
        </div>
      )}
      <div className="scroll-area max-h-[60dvh] min-h-[18rem] space-y-4 overflow-y-auto bg-canvas/40 p-3.5 sm:min-h-[22rem] sm:p-5" role="log" aria-label="Туслахтай ярилцсан түүх" aria-relevant="additions text">
        {isEmpty ? (
          <div className="mx-auto flex h-full min-h-[16rem] w-full max-w-3xl flex-col justify-center gap-6 px-1 py-4 sm:min-h-[20rem] sm:px-3">
            <div>
              <p className="text-2xl font-extrabold tracking-tight text-ink sm:text-[28px]">
                Юуг шинэчлэх вэ?
              </p>
              <p className="mt-2 max-w-xl text-sm leading-6 text-ink-muted">
                Постер, үнийн жагсаалтаа оруулаарай. Би уншаад юуг нэмэх, өөрчлөхийг санал болгоно.
                Эсвэл{" "}
                <button
                  type="button"
                  onClick={() => {
                    setAiInput("[Аяллын нэр] аяллын мэдээллийг шинэчлэх");
                    inputRef.current?.focus();
                  }}
                  className="rounded font-medium text-brand underline decoration-brand/30 underline-offset-2 hover:decoration-brand"
                >
                  хийх зүйлээ бичээрэй.
                </button>
              </p>
            </div>
            <button
              type="button"
              onClick={onPickFile}
              disabled={busy}
              className="group flex w-full items-center gap-4 rounded-xl border border-dashed border-line-strong bg-surface px-5 py-5 text-left transition-colors hover:border-brand hover:bg-brand-soft/30 disabled:cursor-wait disabled:opacity-60"
            >
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand transition-transform group-hover:-translate-y-0.5">
                <Icons.upload size={20} />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-bold text-ink">Файл сонгох эсвэл энд чирж тавих</span>
                <span className="mt-0.5 block text-xs leading-5 text-ink-muted">
                  Зураг · PDF · Excel · Word — олон файл зэрэг оруулж болно
                </span>
              </span>
            </button>
            <ol className="grid gap-3 sm:grid-cols-3">
              {[
                ["1", "Уншина", "Постер, үнийн жагсаалтаас аялал, үнэ, огноог гаргана."],
                ["2", "Санал болгоно", "Юу өөрчлөгдөхийг өмнөх утгатай нь зэрэгцүүлж харуулна."],
                ["3", "Та баталгаажуулна", "Та зөвшөөрөөгүй зүйл хадгалагдахгүй. Буцаах боломжтой."],
              ].map(([n, title, body]) => (
                <li key={n} className="rounded-xl border border-line bg-surface p-3.5">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-surface-sunken text-xs font-bold text-ink-muted">{n}</span>
                  <p className="mt-2.5 text-sm font-semibold text-ink">{title}</p>
                  <p className="mt-1 text-xs leading-5 text-ink-muted">{body}</p>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          messages.map((message) => (
            <ChatBubble
              key={message.id}
              message={message}
              existingTrips={existingTrips}
              applyBusy={applyBusyId === message.id}
              clarifyBusy={clarifyBusyId === message.id}
              onApply={onApply}
              onRollback={onRollback}
              onSubmitClarificationForm={onSubmitClarificationForm}
              onCancelProposal={onCancelProposal}
            />
          ))
        )}

        {busy && (
          <div className="flex justify-start">
            {progress != null ? (
              <div className="w-full max-w-md rounded-2xl rounded-bl-md border border-line bg-surface px-4 py-3.5 shadow-xs">
                <div className="flex items-center justify-between gap-3">
                  <p className="min-w-0 truncate text-sm font-medium text-ink">
                    {busyLabel || "Файл уншиж байна"}
                  </p>
                  <span className="shrink-0 font-mono text-sm font-semibold text-brand">
                    {Math.round(progress)}%
                  </span>
                </div>
                <div
                  className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-surface-sunken"
                  role="progressbar"
                  aria-label="Файл боловсруулах явц"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(progress)}
                >
                  <div
                    className="h-full rounded-full bg-brand transition-[width] duration-500"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
            ) : (
              <div
                className="flex items-center gap-2.5 rounded-2xl rounded-bl-md border border-line bg-surface px-4 py-3 shadow-xs"
                role="status"
                aria-label="Туслах хариу бэлдэж байна"
              >
                <span className="flex items-center gap-1" aria-hidden="true">
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-subtle [animation-delay:-0.32s]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-subtle [animation-delay:-0.16s]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-subtle" />
                </span>
                <span className="text-sm text-ink-muted">
                  {busyLabel || "Бодож байна…"}
                </span>
              </div>
            )}
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      <div className="border-t border-line bg-surface">
        <AssistantQuickActions
          trips={existingTrips}
          busy={busy}
          onQuick={onQuickAction}
          onEditPrice={onEditTripPrice}
          onNewTrip={onNewTrip}
        />

        {attachedFiles.length > 0 && (
          <div className="px-3 pt-2.5">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-medium text-ink-muted">
                {attachedFiles.length} файл · {formatBytes(attachedTotalBytes)}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  attachedFiles.forEach((file) => onRemoveAttachedFile(file.id))
                }
                className="rounded px-1 py-1 text-xs font-medium text-brand hover:text-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                Бүгдийг арилгах
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {attachedFiles.map((file) => (
                <FileChip
                  key={file.id}
                  file={file}
                  disabled={busy}
                  onRemove={() => onRemoveAttachedFile(file.id)}
                />
              ))}
            </div>
          </div>
        )}

        <div className="p-2.5 sm:p-3">
          <div className="flex items-end gap-1 rounded-2xl border border-line-strong bg-surface p-1.5 shadow-xs transition-shadow focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/10">
            <button
              type="button"
              onClick={onPickFile}
              disabled={busy}
              aria-label="Файл хавсаргах"
              title="Файл хавсаргах"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-ink-muted transition-colors hover:bg-brand-soft hover:text-brand disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Icons.paperclip size={17} />
            </button>
            <textarea
              ref={inputRef}
              id={composerId}
              aria-label="Туслахад илгээх мессеж"
              aria-describedby={`${composerId}-hint`}
              value={aiInput}
              onChange={(e) => setAiInput(e.target.value)}
              onPaste={(e) => {
                if (!e.clipboardData.files.length) return;
                e.preventDefault();
                if (!busy) onDropFiles(e.clipboardData.files);
              }}
              maxLength={MAX_AI_INPUT_CHARS}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (canSend) onSend();
                }
              }}
              rows={1}
              placeholder={attachedFiles.length ? "Файлаар юу хийхийг хэлээрэй…" : "Аялал нэмэх, үнэ эсвэл суудал өөрчлөх…"}
              className="scroll-area max-h-40 min-h-10 min-w-0 flex-1 resize-none border-0 bg-transparent px-1 py-2.5 text-sm leading-5 text-ink placeholder:text-ink-muted focus-visible:[box-shadow:none]"
            />
            <button
              type="button"
              onClick={onSend}
              disabled={!canSend}
              aria-label="Илгээх"
              title="Илгээх"
              className={cx(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors",
                canSend
                  ? "bg-brand text-white hover:bg-brand-hover"
                  : "cursor-not-allowed bg-surface-sunken text-ink-muted",
              )}
            >
              <Icons.send size={16} />
            </button>
          </div>
          <div id={`${composerId}-hint`} className="mt-2 flex items-center justify-between gap-3 px-1.5 text-[11px] leading-4 text-ink-muted">
            <span className="hidden sm:inline">Enter — илгээх · Shift+Enter — шинэ мөр</span>
            <span className="sm:hidden">Хадгалахаас өмнө саналаа хянаарай.</span>
            {aiInput.length >= MAX_AI_INPUT_CHARS * 0.8 && (
              <span className="shrink-0 font-mono" role="status">{aiInput.length.toLocaleString()} / {MAX_AI_INPUT_CHARS.toLocaleString()}</span>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

/* ----------------------------------------------------------------
   One message in the conversation.
   ---------------------------------------------------------------- */
function ChatBubble({
  message,
  existingTrips = [],
  applyBusy,
  clarifyBusy,
  onApply,
  onRollback,
  onSubmitClarificationForm,
  onCancelProposal,
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
}) {
  const fieldId = useId();
  const [formDraft, setFormDraft] = useState<Record<string, string>>({});
  const [fieldOverrides, setFieldOverrides] = useState<Record<string, string>>({});
  const [showAllChanges, setShowAllChanges] = useState(false);
  const [openEditors, setOpenEditors] = useState<Record<number, boolean>>({});

  if (message.role === "admin") {
    const hasRealText = Boolean(message.text) && message.text !== "Файл орууллаа";
    return (
      <div className="animate-fade-up flex justify-end">
        <div className="min-w-0 max-w-[92%] rounded-2xl rounded-br-md bg-brand px-3.5 py-2.5 text-sm leading-6 text-white shadow-xs sm:max-w-lg">
          {hasRealText && (
            <p className="whitespace-pre-wrap wrap-break-word">{message.text}</p>
          )}
          {message.fileNames && message.fileNames.length > 0 ? (
            <div className={hasRealText ? "mt-2 border-t border-white/20 pt-2" : undefined}>
              {message.fileNames.map((name) => (
                <p key={name} className="truncate text-xs text-white/90" title={name}>
                  📎 {name}
                </p>
              ))}
            </div>
          ) : (
            !hasRealText && (
              <p className="whitespace-pre-wrap wrap-break-word">{message.text}</p>
            )
          )}
        </div>
      </div>
    );
  }

  if (message.kind === "note") {
    return (
      <div className="animate-fade-up flex justify-start">
        <div className="min-w-0 max-w-[92%] rounded-2xl rounded-bl-md border border-line bg-surface px-4 py-2.5 text-sm leading-6 text-ink shadow-xs sm:max-w-lg">
          <p className="whitespace-pre-wrap wrap-break-word">{message.text}</p>
        </div>
      </div>
    );
  }

  const proposalMsg = message as ProposalMsg;
  const { proposal } = proposalMsg;
  const describedActions = proposal.actions.map(describeAction);

  function getDiffsForAction(actionIndex: number): TripExtraDiff[] {
    const action = proposal.actions[actionIndex];
    if (!action || !existingTrips.length) return [];
    const verb = String(action.action || "").toLowerCase();
    const isCreate = verb === "upsert" && !action.trip_id;
    if (verb !== "patch" && !isCreate && !(verb === "upsert" && action.trip_id)) {
      return [];
    }
    const tripId = action.trip_id?.trim();
    const routeName =
      action.match?.route_name?.trim() ||
      (action.fields?.route_name as string | undefined)?.trim();
    const existing = isCreate
      ? null
      : existingTrips.find(
          (t) =>
            (tripId && t.id === tripId) ||
            (routeName && t.route_name.toLowerCase() === routeName.toLowerCase()),
        );
    return diffTripFields((action.fields as Record<string, unknown>) ?? {}, {
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
        if (
          field === "adult_price" ||
          field === "child_price" ||
          field === "seats_total" ||
          field === "seats_left"
        ) {
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

  const visibleActions = showAllChanges
    ? describedActions
    : describedActions.slice(0, 5);
  const hiddenActionCount = Math.max(0, describedActions.length - visibleActions.length);
  const hasStructuredItems = (proposal.conflict_items?.length ?? 0) > 0;
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
  const isPending = message.status === "pending";
  const isReadyToApply = isPending && reviewCount === 0;

  const createActions = proposal.actions
    .map((a, i) => ({ action: a, index: i }))
    .filter(({ action }) => (action.action || "").toLowerCase() === "upsert");

  function isEditorOpen(index: number): boolean {
    if (index in openEditors) return openEditors[index];
    // Open automatically when the extraction missed the essentials — the
    // admin has to type those anyway, so don't hide the fields behind a tap.
    const name = getField(index, "route_name", "").trim();
    const price = getField(index, "adult_price", "").trim();
    return !name || !price;
  }

  const inputCls =
    "h-10 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink transition-colors placeholder:text-ink-muted focus:border-brand";
  const textareaCls =
    "min-h-[72px] w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-ink transition-colors placeholder:text-ink-muted focus:border-brand";

  return (
    <div className="animate-fade-up flex justify-start">
      <div className="min-w-0 w-full max-w-3xl rounded-2xl rounded-bl-md border border-line bg-surface p-3.5 shadow-xs sm:p-5">
        {/* What I understood, in one sentence */}
        <div className="flex flex-wrap items-start justify-between gap-2.5">
          <p className="min-w-0 text-[15px] font-semibold leading-6 text-ink">
            {proposal.summary}
          </p>
          {isPending && (
            <span
              className={cx(
                "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold",
                reviewCount > 0
                  ? "bg-surface-sunken text-ink-muted"
                  : "bg-success-soft text-success",
              )}
            >
              {reviewCount > 0 ? "Тодруулах зүйл байна" : "Хадгалахад бэлэн"}
            </span>
          )}
        </div>
        {message.sourceNames && message.sourceNames.length > 0 && (
          <p className="mt-1.5 wrap-break-word text-xs leading-5 text-ink-muted">
            📎 {message.sourceNames.join(" · ")}
          </p>
        )}

        {/* Anything worth a heads-up, said plainly */}
        {compactWarnings.length > 0 && (
          <div className="mt-3.5 space-y-2">
            {compactWarnings.map((item) => (
              <p
                key={item}
                className="whitespace-pre-line text-sm leading-6 text-ink"
              >
                {item}
              </p>
            ))}
          </div>
        )}

        {/* The changes, scannable */}
        {visibleActions.length > 0 && (
          <section className="mt-4" aria-label="Санал болгосон өөрчлөлтүүд">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-xs font-semibold text-ink-muted">
                Өөрчлөлт · {describedActions.length}
              </h3>
              {describedActions.length > 5 && (
                <button
                  type="button"
                  onClick={() => setShowAllChanges((shown) => !shown)}
                  aria-expanded={showAllChanges}
                  className="rounded px-1 py-1 text-xs font-medium text-brand hover:text-brand-hover"
                >
                  {showAllChanges ? "Хураах" : "Бүгдийг харах"}
                </button>
              )}
            </div>
            <ul
              className={cx(
                "mt-1 divide-y divide-line",
                showAllChanges && "scroll-area max-h-96 overflow-y-auto pr-1",
              )}
            >
              {visibleActions.map((described, index) => {
                const diffs = getDiffsForAction(index);
                const verbChip =
                  described.verb === "Шинэ аялал нэмэх"
                    ? "bg-success-soft text-success"
                    : described.verb === "Цуцлах"
                      ? "bg-danger-soft text-danger"
                      : "bg-brand-soft text-brand";
                return (
                  <li
                    key={`${described.verb}:${described.target}:${index}`}
                    className="py-2.5"
                  >
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-sm font-medium leading-5 text-ink">
                        {described.target}
                      </span>
                      <span
                        className={cx(
                          "rounded-full px-2 py-0.5 text-[11px] font-medium",
                          verbChip,
                        )}
                      >
                        {described.verb}
                      </span>
                    </div>
                    {described.changes.length > 0 && (
                      <p className="mt-0.5 text-xs leading-5 text-ink-muted">
                        {described.changes.slice(0, 4).join(" · ")}
                      </p>
                    )}
                    {diffs.length > 0 && (
                      <div className="mt-1 space-y-0.5">
                        {diffs.map((d) => (
                          <p key={d.field} className="text-xs leading-5 text-ink-muted">
                            {d.label}:{" "}
                            {d.kind === "changed" && (
                              <>
                                <span className="text-ink-muted line-through">
                                  {d.before}
                                </span>{" "}
                                <span className="font-medium text-ink">{d.after}</span>
                              </>
                            )}
                            {d.kind === "added" && (
                              <span className="font-medium text-success">{d.after}</span>
                            )}
                            {d.kind === "removed" && (
                              <span className="text-danger line-through">{d.before}</span>
                            )}
                          </p>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {hiddenActionCount > 0 && !showAllChanges && (
              <p className="mt-1 text-xs text-ink-muted">
                +{hiddenActionCount} өөр өөрчлөлт
              </p>
            )}
          </section>
        )}

        {message.clarificationAnswers.length > 0 && (
          <details className="mt-3.5">
            <summary className="cursor-pointer rounded text-xs font-medium text-ink-muted hover:text-ink">
              Өмнө сонгосон хариултууд · {message.clarificationAnswers.length}
            </summary>
            <div className="mt-2 space-y-1.5">
              {message.clarificationAnswers.map((item) => (
                <div key={item.questionId} className="rounded-lg bg-surface-sunken px-3 py-2">
                  <p className="text-xs text-ink-muted">{item.prompt}</p>
                  <p className="mt-0.5 text-sm text-ink">{item.answer}</p>
                </div>
              ))}
            </div>
          </details>
        )}

        {/* Questions the assistant needs answered before saving */}
        {isPending && reviewCount > 0 && (
          <div className="mt-4 space-y-3 border-t border-line pt-4">
            {message.clarifications.map((q, qIndex) => {
              const selected =
                formDraft[q.id] ?? q.options.find((o) => o.recommended)?.answer ?? "";
              return (
                <div key={q.id} className="rounded-xl bg-surface-sunken px-3.5 py-3">
                  {reviewCount > 1 && (
                    <p className="text-[11px] font-semibold text-ink-muted">
                      Асуулт {qIndex + 1}/{reviewCount}
                    </p>
                  )}
                  <p className={cx("text-sm font-medium leading-6 text-ink", reviewCount > 1 && "mt-0.5")}>
                    {q.prompt}
                  </p>
                  {q.detail && (
                    <p className="mt-1 text-xs leading-5 text-ink-muted">{q.detail}</p>
                  )}
                  <div className="mt-2.5 flex flex-wrap gap-1.5" role="group" aria-label={q.prompt}>
                    {q.options.map((opt) => (
                      <button
                        key={opt.label}
                        type="button"
                        disabled={clarifyBusy}
                        aria-pressed={selected === opt.answer}
                        onClick={() =>
                          setFormDraft((prev) => ({ ...prev, [q.id]: opt.answer }))
                        }
                        className={cx(
                          "rounded-xl px-3 py-2 text-left text-sm font-medium transition-colors disabled:opacity-60",
                          selected === opt.answer
                            ? "bg-brand text-white"
                            : "bg-surface text-ink ring-1 ring-line-strong hover:text-brand hover:ring-brand",
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  {q.allowCustom && (
                    <input
                      aria-label={`${q.prompt} Өөрийн хариулт`}
                      disabled={clarifyBusy}
                      value={q.options.some((o) => o.answer === selected) ? "" : selected}
                      onChange={(e) =>
                        setFormDraft((prev) => ({ ...prev, [q.id]: e.target.value }))
                      }
                      placeholder={q.customPlaceholder || "Өөрөөр бичих бол энд…"}
                      className={cx(inputCls, "mt-2")}
                    />
                  )}
                </div>
              );
            })}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                loading={clarifyBusy}
                disabled={
                  clarifyBusy ||
                  message.clarifications.some(
                    (q) =>
                      !(
                        formDraft[q.id] ??
                        q.options.find((o) => o.recommended)?.answer ??
                        ""
                      ).trim(),
                  )
                }
                onClick={() => {
                  // Fill in the recommended default for any question the admin
                  // never explicitly tapped, so it's actually submitted.
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
                Хариулт илгээх
              </Button>
              <Button size="sm" variant="ghost" disabled={clarifyBusy} onClick={() => onCancelProposal(message.id)}>
                Болих
              </Button>
            </div>
          </div>
        )}

        {/* Ready to save: extracted trips as a readable summary, editable on demand */}
        {isReadyToApply && (
          <div className="mt-4 space-y-3 border-t border-line pt-4">
            {createActions.length > 0 && (
              <div
                className={cx(
                  "space-y-2.5",
                  createActions.length > 3 && "scroll-area max-h-96 overflow-y-auto pr-1",
                )}
              >
                {createActions.map(({ action, index }) => {
                  const f = action.fields ?? {};
                  const editing = isEditorOpen(index);
                  const name = getField(index, "route_name", f.route_name).trim();
                  const summaryRows: Array<[string, string]> = [
                    ["Хугацаа", getField(index, "duration_text", f.duration_text)],
                    ["Том хүн", formatMoneyMnt(getField(index, "adult_price", f.adult_price))],
                    ["Хүүхэд", formatMoneyMnt(getField(index, "child_price", f.child_price))],
                    [
                      "Ирээдүйн гарах өдрүүд",
                      getField(
                        index,
                        "departure_dates",
                        Array.isArray(f.departure_dates)
                          ? (f.departure_dates as string[]).join(", ")
                          : "",
                      ),
                    ],
                    ["Суудал", getField(index, "seats_total", f.seats_total)],
                    [
                      "Хоол",
                      (() => {
                        const v = getField(index, "has_food", f.has_food == null ? "" : String(f.has_food));
                        return v === "true" ? "Багтсан" : v === "false" ? "Ороогүй" : "";
                      })(),
                    ],
                    ["Буудал", getField(index, "hotel", f.hotel)],
                    ["Нэмэлт тэмдэглэл", getField(index, "notes", f.notes)],
                  ].filter(([, value]) => value.trim()) as Array<[string, string]>;

                  return (
                    <div key={index} className="rounded-xl bg-surface-sunken p-3.5">
                      <div className="flex items-start justify-between gap-3">
                        <p className="min-w-0 text-sm font-semibold leading-5 text-ink">
                          {name || `Аялал ${index + 1} — нэр дутуу`}
                        </p>
                        <button
                          type="button"
                          onClick={() =>
                            setOpenEditors((prev) => ({ ...prev, [index]: !editing }))
                          }
                          aria-expanded={editing}
                          aria-controls={`${fieldId}-${index}-editor`}
                          disabled={applyBusy}
                          className="flex shrink-0 items-center gap-1 rounded px-1 py-1 text-xs font-medium text-brand hover:text-brand-hover disabled:opacity-50"
                        >
                          <Icons.edit size={13} />
                          {editing ? "Хураах" : "Засах"}
                        </button>
                      </div>

                      {!editing && summaryRows.length > 0 && (
                        <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
                          {summaryRows.map(([label, value]) => (
                            <div key={label} className="flex items-baseline gap-2">
                              <dt className="shrink-0 text-xs text-ink-muted">{label}</dt>
                              <dd className="min-w-0 wrap-break-word text-sm text-ink">
                                {value}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      )}
                      {!editing && summaryRows.length === 0 && (
                        <p className="mt-1.5 text-xs text-ink-muted">
                          Дэлгэрэнгүй мэдээлэл олдсонгүй — «Засах» дээр дараад нөхөөрэй.
                        </p>
                      )}

                      {editing && (
                        <fieldset id={`${fieldId}-${index}-editor`} disabled={applyBusy} className="mt-3 min-w-0 space-y-3">
                          <div>
                            <label htmlFor={`${fieldId}-${index}-name`} className="mb-1 block text-xs text-ink-muted">Аяллын нэр</label>
                            <input
                              id={`${fieldId}-${index}-name`}
                              value={getField(index, "route_name", f.route_name)}
                              onChange={(e) => setField(index, "route_name", e.target.value)}
                              placeholder="Аяллын нэрийг бичээрэй"
                              className={inputCls}
                            />
                          </div>
                          <div>
                            <label htmlFor={`${fieldId}-${index}-duration`} className="mb-1 block text-xs text-ink-muted">Хугацаа</label>
                            <input
                              id={`${fieldId}-${index}-duration`}
                              value={getField(index, "duration_text", f.duration_text)}
                              onChange={(e) => setField(index, "duration_text", e.target.value)}
                              placeholder="Өдөр, шөнийн тоо"
                              className={inputCls}
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label htmlFor={`${fieldId}-${index}-adult`} className="mb-1 block text-xs text-ink-muted">Том хүний үнэ ₮</label>
                              <input
                                id={`${fieldId}-${index}-adult`}
                                type="number"
                                min={0}
                                inputMode="decimal"
                                value={getField(index, "adult_price", f.adult_price)}
                                onChange={(e) => setField(index, "adult_price", e.target.value)}
                                placeholder="Үнэ оруулах"
                                className={inputCls}
                              />
                            </div>
                            <div>
                              <label htmlFor={`${fieldId}-${index}-child`} className="mb-1 block text-xs text-ink-muted">Хүүхдийн үнэ ₮</label>
                              <input
                                id={`${fieldId}-${index}-child`}
                                type="number"
                                min={0}
                                inputMode="decimal"
                                value={getField(index, "child_price", f.child_price)}
                                onChange={(e) => setField(index, "child_price", e.target.value)}
                                placeholder="заавал биш"
                                className={inputCls}
                              />
                            </div>
                          </div>
                          <div>
                            <label htmlFor={`${fieldId}-${index}-departures`} className="mb-1 block text-xs text-ink-muted">
                              Ирээдүйн гарах өдрүүд — таслалаар
                            </label>
                            <input
                              id={`${fieldId}-${index}-departures`}
                              value={getField(
                                index,
                                "departure_dates",
                                Array.isArray(f.departure_dates)
                                  ? (f.departure_dates as string[]).join(", ")
                                  : "",
                              )}
                              onChange={(e) => setField(index, "departure_dates", e.target.value)}
                              placeholder="Гарах өдрүүдийг таслалаар тусгаарлаарай"
                              className={inputCls}
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label htmlFor={`${fieldId}-${index}-seats`} className="mb-1 block text-xs text-ink-muted">Суудал</label>
                              <input
                                id={`${fieldId}-${index}-seats`}
                                type="number"
                                min={0}
                                inputMode="numeric"
                                value={getField(index, "seats_total", f.seats_total)}
                                onChange={(e) => setField(index, "seats_total", e.target.value)}
                                placeholder="заавал биш"
                                className={inputCls}
                              />
                            </div>
                            <div>
                              <label htmlFor={`${fieldId}-${index}-food`} className="mb-1 block text-xs text-ink-muted">Хоол</label>
                              <select
                                id={`${fieldId}-${index}-food`}
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
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label htmlFor={`${fieldId}-${index}-hotel`} className="mb-1 block text-xs text-ink-muted">Буудал</label>
                              <input
                                id={`${fieldId}-${index}-hotel`}
                                value={getField(index, "hotel", f.hotel)}
                                onChange={(e) => setField(index, "hotel", e.target.value)}
                                placeholder="заавал биш"
                                className={inputCls}
                              />
                            </div>
                            <div>
                              <label htmlFor={`${fieldId}-${index}-notes`} className="mb-1 block text-xs text-ink-muted">Нэмэлт тэмдэглэл</label>
                              <textarea
                                id={`${fieldId}-${index}-notes`}
                                value={getField(index, "notes", f.notes)}
                                onChange={(e) => setField(index, "notes", e.target.value)}
                                placeholder="заавал биш"
                                className={textareaCls}
                              />
                            </div>
                          </div>
                        </fieldset>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="primary"
                loading={applyBusy}
                disabled={!isReadyToApply || applyBusy}
                onClick={() => onApply(buildMessageWithOverrides())}
              >
                <Icons.check size={15} />
                Хадгалах
              </Button>
              <Button size="sm" variant="ghost" disabled={applyBusy} onClick={() => onCancelProposal(message.id)}>
                Болих
              </Button>
              <span className="text-xs text-ink-muted">
                Хадгалсны дараа буцаах боломжтой
              </span>
            </div>
          </div>
        )}

        {message.status === "applied" && (
          <div className="mt-3.5 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-3">
            <span className="flex items-center gap-1.5 text-sm font-medium text-success">
              <Icons.check size={15} />
              Хадгалагдлаа
            </span>
            {message.resultText && (
              <span className="text-xs text-ink-muted">{message.resultText}</span>
            )}
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
          <p className="mt-3.5 border-t border-line pt-3 text-sm text-ink-muted">
            Өөрчлөлт буцаагдлаа. {message.resultText}
          </p>
        )}
        {message.status === "cancelled" && (
          <p className="mt-3.5 border-t border-line pt-3 text-xs text-ink-muted">
            Цуцлагдсан.
          </p>
        )}
        {message.status === "error" && (
          <p className="mt-3.5 border-t border-line pt-3 text-sm text-danger">
            {message.resultText || "Алдаа гарлаа."}
          </p>
        )}
      </div>
    </div>
  );
}
