import { useState } from "react";
import { Button, Card, Icons, cx } from "@/components/ui";
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

function formatMoneyMnt(value: unknown): string {
  const n = typeof value === "number" ? value : parseFloat(String(value ?? ""));
  if (!Number.isFinite(n) || n <= 0) return "";
  return `${n.toLocaleString("en-US")}₮`;
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
  const attachedTotalBytes = attachedFiles.reduce(
    (sum, file) => sum + file.sizeBytes,
    0,
  );
  const isEmpty = messages.length <= 1 && messages[0]?.id === "intro";
  const canSend = !busy && (Boolean(aiInput.trim()) || attachedFiles.length > 0);

  return (
    <Card
      className={cx(
        "flex flex-col overflow-hidden transition-shadow",
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
      <div className="scroll-area max-h-[62dvh] min-h-[22rem] space-y-3 overflow-y-auto p-3.5 sm:p-4">
        {isEmpty ? (
          <div className="flex h-full min-h-[20rem] flex-col items-center justify-center px-4 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-soft text-brand">
              <Icons.ai size={24} />
            </div>
            <p className="mt-3 text-base font-semibold text-ink">
              Аяллын мэдээллээ энд өөрчилнө
            </p>
            <p className="mt-1.5 max-w-md text-sm leading-6 text-ink-muted">
              Постер, прайс жагсаалтаа хавсаргавал би уншаад аялал болгож санал
              болгоно. Эсвэл бичгээр хэлээрэй, ж:{" "}
              <button
                type="button"
                onClick={() => {
                  setAiInput("Бангкок аяллын үнийг 4.5 сая болго");
                  inputRef.current?.focus();
                }}
                className="rounded text-brand underline decoration-brand/30 underline-offset-2 hover:decoration-brand"
              >
                «Бангкок аяллын үнийг 4.5 сая болго»
              </button>
            </p>
            <button
              type="button"
              onClick={onPickFile}
              className="mt-5 flex w-full max-w-md flex-col items-center gap-1 rounded-xl border-2 border-dashed border-line-strong px-6 py-6 transition-colors hover:border-brand hover:bg-brand-soft/40"
            >
              <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                <Icons.upload size={17} className="text-brand" />
                Файл сонгох эсвэл энд чирж тавих
              </span>
              <span className="text-xs text-ink-subtle">
                Зураг · PDF · Excel — олон файл зэрэг болно, би санал болгоно, та
                баталгаажуулна
              </span>
            </button>
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
            {busyProgress != null ? (
              <div className="w-full max-w-md rounded-2xl rounded-bl-md border border-line bg-surface px-4 py-3.5 shadow-xs">
                <div className="flex items-center justify-between gap-3">
                  <p className="min-w-0 truncate text-sm font-medium text-ink">
                    {busyLabel || "Файл уншиж байна"}
                  </p>
                  <span className="shrink-0 font-mono text-sm font-semibold text-brand">
                    {Math.round(busyProgress)}%
                  </span>
                </div>
                <div
                  className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-surface-sunken"
                  role="progressbar"
                  aria-label="Файл боловсруулах явц"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(busyProgress)}
                >
                  <div
                    className="h-full rounded-full bg-brand transition-[width] duration-500"
                    style={{ width: `${busyProgress}%` }}
                  />
                </div>
              </div>
            ) : (
              <div
                className="flex items-center gap-2.5 rounded-2xl rounded-bl-md border border-line bg-surface px-4 py-3 shadow-xs"
                role="status"
                aria-label="AI хариу бэлдэж байна"
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

      <div className="border-t border-line">
        <div className="scroll-area flex gap-1.5 overflow-x-auto px-3 pt-2.5">
          {QUICK_ACTIONS.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={() => {
                setAiInput(action.prompt);
                inputRef.current?.focus();
              }}
              className="shrink-0 rounded-full bg-surface-sunken px-3 py-1 text-xs font-medium text-ink-muted transition-colors duration-150 hover:bg-brand-soft hover:text-brand"
            >
              {action.label}
            </button>
          ))}
        </div>

        {attachedFiles.length > 0 && (
          <div className="px-3 pt-2.5">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-medium text-ink-muted">
                {attachedFiles.length} файл · {formatBytes(attachedTotalBytes)}
              </span>
              <button
                type="button"
                onClick={() =>
                  attachedFiles.forEach((file) => onRemoveAttachedFile(file.id))
                }
                className="rounded text-xs font-medium text-brand hover:text-brand-hover"
              >
                Бүгдийг арилгах
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
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

        <div className="p-2.5 sm:p-3">
          <div className="flex items-end gap-1 rounded-2xl bg-surface-sunken p-1.5 ring-1 ring-transparent transition-shadow focus-within:ring-brand/40">
            <button
              type="button"
              onClick={onPickFile}
              aria-label="Файл хавсаргах"
              title="Файл хавсаргах"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-ink-muted transition-colors hover:bg-surface hover:text-brand"
            >
              <Icons.paperclip size={17} />
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
              placeholder="Мессеж бичих…"
              className="scroll-area max-h-32 min-h-9 flex-1 resize-none border-0 bg-transparent px-2 py-2 text-sm text-ink placeholder:text-ink-muted focus-visible:[box-shadow:none]"
            />
            <button
              type="button"
              onClick={onSend}
              disabled={!canSend}
              aria-label="Илгээх"
              title="Илгээх"
              className={cx(
                "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors",
                canSend
                  ? "bg-brand text-white hover:bg-brand-hover"
                  : "cursor-not-allowed bg-surface text-ink-subtle ring-1 ring-line",
              )}
            >
              <Icons.send size={16} />
            </button>
          </div>
          <p className="mt-1.5 px-1.5 text-[11px] leading-4 text-ink-subtle">
            Enter — илгээх · Shift+Enter — шинэ мөр · Том файлыг систем хэсэглэн
            уншина
          </p>
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
  const [formDraft, setFormDraft] = useState<Record<string, string>>({});
  const [fieldOverrides, setFieldOverrides] = useState<Record<string, string>>({});
  const [showAllChanges, setShowAllChanges] = useState(false);
  const [openEditors, setOpenEditors] = useState<Record<number, boolean>>({});

  if (message.role === "admin") {
    const hasRealText = Boolean(message.text) && message.text !== "Файл орууллаа";
    return (
      <div className="animate-fade-up flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-brand px-3.5 py-2.5 text-sm leading-6 text-white shadow-xs sm:max-w-lg">
          {hasRealText && (
            <p className="whitespace-pre-wrap wrap-break-word">{message.text}</p>
          )}
          {message.fileNames && message.fileNames.length > 0 ? (
            <div className={hasRealText ? "mt-2 border-t border-white/20 pt-2" : undefined}>
              {message.fileNames.map((name) => (
                <p key={name} className="truncate text-xs text-white/90">
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
    // A genuine failure (upload broke, network error) reads as distinct from a
    // normal reply; everything else is just the assistant talking and looks
    // like an ordinary chat bubble.
    return (
      <div className="animate-fade-up flex justify-start">
        <div
          className={cx(
            "max-w-[85%] rounded-2xl rounded-bl-md px-4 py-2.5 text-sm leading-6 shadow-xs sm:max-w-lg",
            message.tone === "error"
              ? "border border-danger/25 bg-danger-soft text-danger"
              : "border border-line bg-surface text-ink",
          )}
        >
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
    "h-9 w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-ink transition-colors placeholder:text-ink-subtle focus:border-brand";
  const textareaCls =
    "min-h-[72px] w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink transition-colors placeholder:text-ink-subtle focus:border-brand";

  return (
    <div className="animate-fade-up flex justify-start">
      <div className="w-full max-w-3xl rounded-2xl rounded-bl-md border border-line bg-surface p-4 shadow-xs sm:p-5">
        {/* What I understood, in one sentence */}
        <div className="flex items-start justify-between gap-3">
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
              {reviewCount > 0 ? "Хариулт хүлээж байна" : "Бэлэн"}
            </span>
          )}
        </div>
        {message.sourceNames && message.sourceNames.length > 0 && (
          <p className="mt-1 truncate text-xs text-ink-subtle">
            📎 {message.sourceNames.join(" · ")}
          </p>
        )}

        {/* Anything worth a heads-up, said plainly */}
        {compactWarnings.length > 0 && (
          <div className="mt-3.5 space-y-2 rounded-xl bg-brand-soft/60 px-3.5 py-3">
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
              <h3 className="text-xs font-semibold text-ink-subtle">
                Өөрчлөлт · {describedActions.length}
              </h3>
              {describedActions.length > 5 && (
                <button
                  type="button"
                  onClick={() => setShowAllChanges((shown) => !shown)}
                  className="rounded text-xs font-medium text-brand hover:text-brand-hover"
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
                                <span className="text-ink-subtle line-through">
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
              <p className="mt-1 text-xs text-ink-subtle">
                +{hiddenActionCount} өөр өөрчлөлт
              </p>
            )}
          </section>
        )}

        {message.clarificationAnswers.length > 0 && (
          <details className="mt-3.5">
            <summary className="cursor-pointer rounded text-xs font-medium text-ink-subtle hover:text-ink-muted">
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
                    <p className="text-[11px] font-semibold text-ink-subtle">
                      Асуулт {qIndex + 1}/{reviewCount}
                    </p>
                  )}
                  <p className={cx("text-sm font-medium leading-6 text-ink", reviewCount > 1 && "mt-0.5")}>
                    {q.prompt}
                  </p>
                  {q.detail && (
                    <p className="mt-1 text-xs leading-5 text-ink-muted">{q.detail}</p>
                  )}
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {q.options.map((opt) => (
                      <button
                        key={opt.label}
                        type="button"
                        disabled={clarifyBusy}
                        onClick={() =>
                          setFormDraft((prev) => ({ ...prev, [q.id]: opt.answer }))
                        }
                        className={cx(
                          "rounded-full px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-60",
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
            <div className="flex gap-2">
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
              <Button size="sm" variant="ghost" onClick={() => onCancelProposal(message.id)}>
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
                          className="flex shrink-0 items-center gap-1 rounded text-xs font-medium text-brand hover:text-brand-hover"
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
                              <dd className="min-w-0 truncate text-sm text-ink" title={value}>
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
                        <div className="mt-3 space-y-3">
                          <div>
                            <label className="mb-1 block text-xs text-ink-muted">Аяллын нэр</label>
                            <input
                              value={getField(index, "route_name", f.route_name)}
                              onChange={(e) => setField(index, "route_name", e.target.value)}
                              placeholder="ж: Бээжин аялал"
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
                          <div>
                            <label className="mb-1 block text-xs text-ink-muted">
                              Ирээдүйн гарах өдрүүд — таслалаар
                            </label>
                            <input
                              value={getField(
                                index,
                                "departure_dates",
                                Array.isArray(f.departure_dates)
                                  ? (f.departure_dates as string[]).join(", ")
                                  : "",
                              )}
                              onChange={(e) => setField(index, "departure_dates", e.target.value)}
                              placeholder="7 сарын 9, 7 сарын 18, 8 сарын 1"
                              className={inputCls}
                            />
                          </div>
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
                              <label className="mb-1 block text-xs text-ink-muted">Нэмэлт тэмдэглэл</label>
                              <textarea
                                value={getField(index, "notes", f.notes)}
                                onChange={(e) => setField(index, "notes", e.target.value)}
                                placeholder="заавал биш"
                                className={textareaCls}
                              />
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="flex items-center gap-2">
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
              <Button size="sm" variant="ghost" onClick={() => onCancelProposal(message.id)}>
                Болих
              </Button>
              <span className="text-xs text-ink-subtle">
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
          <p className="mt-3.5 border-t border-line pt-3 text-xs text-ink-subtle">
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
