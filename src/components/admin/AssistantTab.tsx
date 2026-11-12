import { useEffect, useId, useState } from "react";
import { Icons, cx } from "@/components/ui";
import {
  ActionGlyph,
  ComposerActionMenu,
  QuickActionList,
  QuickActionStep,
  useQuickAction,
  type ActionKey,
  type QuickActionKind,
} from "./AssistantQuickActions";
import { ProposalCard, type EditDraftTrip } from "./ProposalCard";
import type {
  AttachedFile,
  ProposalQuestionOption,
  TravelTrip,
} from "@/lib/adminTypes";
import {
  MAX_AI_INPUT_CHARS,
  formatBytes,
} from "@/lib/adminUtils";
import { displayText, openAskOf, replyCaption, stageAt, type ProgressStage } from "./assistantChatLogic";
import type { AssistantAskMsg, AssistantChatMessage, AssistantProposalMsg, ReplyMeta } from "./assistantChatTypes";
import { thumb } from "./tripReview/photoThumb";

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

/** What reading one file does, in order, with the second it usually starts at. */
const FILE_STAGES = [
  { at: 0, label: "Файлыг нээж байна" },
  { at: 5, label: "Аяллын хөтөлбөр, үнэ, огноог уншиж байна" },
  { at: 30, label: "Улаанбаатарын өдрүүд, тээврийг тохируулж байна" },
  { at: 42, label: "Аялалд тохирох зураг сонгож байна" },
] as const;

/**
 * One file is one server request (about a minute), so its real progress is unknown until it
 * answers. The bar follows the usual time and never claims to be finished before the answer;
 * the stage list and the clock show that work is happening (it sat at "15%" before, 2026-11-04).
 */
function FileProgress({ label, reported, stages = FILE_STAGES, footer = "Нэг файл ихэвчлэн 1 минут орчим. Энэ хуудсыг бүү хаагаарай." }: {
  label: string; reported: number; stages?: ReadonlyArray<{ at: number; label: string }>; footer?: string;
}) {
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  const shown = Math.min(95, Math.max(reported, Math.round(92 * (1 - Math.exp(-elapsed / 28)))));
  const current = stages.reduce((index, stage, i) => (elapsed >= stage.at ? i : index), 0);
  const clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
  return (
    <div className="w-full max-w-md rounded-2xl rounded-bl-md border border-line bg-surface px-4 py-3.5 shadow-xs">
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-sm font-semibold text-ink">{label || "Файл уншиж байна"}</p>
        <span className="shrink-0 font-mono text-xs text-ink-muted" aria-label="Өнгөрсөн хугацаа">{clock}</span>
      </div>
      <div
        className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-surface-sunken"
        role="progressbar"
        aria-label="Файл боловсруулах явц"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={shown}
      >
        <div className="h-full rounded-full bg-brand transition-[width] duration-1000 ease-out" style={{ width: `${shown}%` }} />
      </div>
      <ol className="mt-3 space-y-1.5" aria-label="Алхамууд">
        {stages.map((stage, index) => (
          <li key={stage.label} className={cx("flex items-center gap-2 text-xs leading-5",
            index < current ? "text-ink-muted" : index === current ? "font-medium text-ink" : "text-ink-subtle")}>
            <span aria-hidden="true" className={cx("flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
              index < current ? "bg-success-soft text-success" : index === current ? "bg-brand-soft text-brand" : "bg-surface-sunken")}>
              {index < current ? <Icons.check size={11} /> : index === current ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" /> : null}
            </span>
            {stage.label}
          </li>
        ))}
      </ol>
      <p className="mt-2.5 text-[12px] leading-4 text-ink-muted">{footer}</p>
    </div>
  );
}

/**
 * The agent's work while it runs (about 3-15 s): the usual steps in order, by the clock, and
 * how long it has taken once that is worth saying. The real steps come back with the answer.
 */
function AgentProgress({ stages }: { stages: ProgressStage[] }) {
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);
  const seconds = Math.max(0, (now - startedAt) / 1000);
  const label = stageAt(stages, seconds);
  return (
    <div className="flex items-center gap-2.5 rounded-2xl rounded-bl-md border border-line bg-surface px-4 py-3 shadow-xs" role="status" aria-live="polite" aria-label="Туслах ажиллаж байна">
      <span className="flex items-center gap-1" aria-hidden="true">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand [animation-delay:-0.32s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand [animation-delay:-0.16s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand" />
      </span>
      <span className="text-sm text-ink">{label}</span>
      {seconds >= 8 && <span className="font-mono text-xs text-ink-subtle" aria-label="Өнгөрсөн хугацаа">{Math.floor(seconds)}с</span>}
    </div>
  );
}

/** One small line under a reply: how it was made (the agent's steps, or «энгийн горим»). */
function ReplyCaption({ meta }: { meta?: ReplyMeta }) {
  const caption = replyCaption(meta);
  if (!caption) return null;
  return (
    <p className={cx("mt-1 px-1 text-[12px] leading-4", meta?.simple ? "text-warning" : "text-ink-muted")}>{caption}</p>
  );
}

/** A small Cloudinary rendition for the proposal's photo strip (other hosts as they are). */
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
  tripDetails,
  aiInput,
  setAiInput,
  attachedFiles,
  onRemoveAttachedFile,
  dragOver,
  setDragOver,
  busy,
  busyLabel,
  busyProgress,
  busyStages = null,
  applyBusyId,
  clarifyBusyId,
  onSend,
  onChooseOption,
  onQuickAction,
  onEditTripPrice,
  onNewTrip,
  onEditDraftTrip,
  onApply,
  onRollback,
  onSubmitClarificationForm,
  onCancelProposal,
  onResendInstruction,
  onNewConversation,
  onPickFile,
  onDropFiles,
  chatEndRef,
  inputRef,
}: {
  messages: AssistantChatMessage[];
  existingTrips?: TravelTrip[];
  /** Trips loaded in full for the cards (a list row has no program text or day photos). */
  tripDetails?: Record<string, TravelTrip>;
  aiInput: string;
  setAiInput: (value: string) => void;
  attachedFiles: AttachedFile[];
  onRemoveAttachedFile: (fileId: string) => void;
  dragOver: boolean;
  setDragOver: (value: boolean) => void;
  busy: boolean;
  busyLabel: string;
  busyProgress: number | null;
  /** The agent's usual steps while it works (null for files and quick actions). */
  busyStages?: ProgressStage[] | null;
  applyBusyId: string;
  clarifyBusyId: string;
  onSend: () => void;
  /** The admin tapped one of the choices the assistant offered. */
  onChooseOption: (message: AssistantAskMsg, option: ProposalQuestionOption) => void;
  onQuickAction: (kind: QuickActionKind, trip: TravelTrip, value?: number | boolean) => void;
  onEditTripPrice: (trip: TravelTrip) => void;
  onNewTrip: () => void;
  /** Opens the full trip editor on a trip read from a file; its save returns the fields here. */
  onEditDraftTrip?: EditDraftTrip;
  onApply: (message: AssistantProposalMsg) => void;
  onRollback: (message: AssistantProposalMsg) => void;
  onSubmitClarificationForm: (
    message: AssistantProposalMsg,
    answers: Record<string, string>,
  ) => void;
  onCancelProposal: (id: string) => void;
  /** An expired proposal: its instruction sent again for a fresh one. */
  onResendInstruction?: (message: AssistantProposalMsg) => void;
  /** Clears the thread and starts a new conversation. */
  onNewConversation?: () => void;
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
  const progress = busyProgress == null ? null : Math.min(100, Math.max(0, busyProgress));

  const quick = useQuickAction({ trips: existingTrips, busy, onQuick: onQuickAction, onEditPrice: onEditTripPrice, onNewTrip });
  const { step } = quick;
  const stepPhase = step?.phase ?? null;
  // A question the assistant asked, still its latest word: the composer answers it.
  const openAsk = openAskOf(messages);
  // Example instructions, on a real trip when there is one, so a tap is a real request.
  const sampleName = existingTrips.find((trip) => trip.status === "active")?.route_name ?? "Аяллын нэр";
  const examples = [
    `«${sampleName}» 12/27 дүүрсэн`,
    `«${sampleName}» 12/27-ны үнийг 100 мянгаар нэм`,
    `«${sampleName}» хүүхэд 300 мянгаар бага`,
    `«${sampleName}» сайтаас нуу`,
    `«${sampleName}» 3-р өдрийн хөтөлбөрийг «…» болго`,
  ];

  // While a step is open the composer answers the step; the draft message is kept aside.
  const composerValue = step ? quick.input : aiInput;
  const setComposerValue = step ? quick.setInput : setAiInput;
  const canSend = !busy && (Boolean(aiInput.trim()) || attachedFiles.length > 0);
  const submitLabel = step
    ? stepPhase === "trip" ? "Эхний аяллыг сонгох" : stepPhase === "value" ? "Суудлыг баталгаажуулах" : "Дээрээс сонгоно уу"
    : "Илгээх";
  const submitEnabled = step ? Boolean(quick.enterAction) : canSend;
  const placeholder = step
    ? stepPhase === "trip" ? "Аяллын нэрийг бичиж хайх…"
      : stepPhase === "value" ? "Үлдсэн суудлын тоо…"
        : "Дээрх сонголтоос нэгийг нь дарна уу"
    : openAsk ? (openAsk.customPlaceholder || "Хариултаа бичээрэй…")
      : attachedFiles.length ? "Файлаар юу хийхийг хэлээрэй (ж: «3-р өдрийн зургийг соль»)…" : "Юуг өөрчлөх вэ? Хамт ажилладаг хүндээ хэлдэг шигээ бичээрэй…";

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }, [composerValue, placeholder, inputRef]);

  // A new step, or a new phase of one, scrolls into view and takes the keyboard.
  useEffect(() => {
    if (!stepPhase) return;
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    inputRef.current?.focus();
  }, [stepPhase, chatEndRef, inputRef]);

  const startAction = (key: ActionKey) => {
    quick.start(key);
    inputRef.current?.focus();
  };

  // The whole content area, edge to edge (admin.tsx gives this tab no page padding): one scroll
  // area for the conversation, a slim header above and the composer below. The owner, 2026-11-11:
  // the card inside the page left wide gaps and showed half a screen of the review.
  return (
    <div
      className={cx(
        "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface",
        dragOver && "ring-2 ring-inset ring-brand",
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
      <div className="flex min-h-12 shrink-0 items-center gap-3 border-b border-line px-4 py-1.5 sm:px-6">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand to-travel text-white shadow-xs">
          <Icons.ai size={16} />
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3">
          <h2 className="text-[15px] font-semibold leading-6 text-ink">Аяллын туслах</h2>
          <p className="hidden truncate text-sm leading-6 text-ink-muted sm:block">Би санал бэлдэнэ. Та хянаад хадгална.</p>
        </div>
        {existingTrips.length > 0 && (
          <span className="hidden shrink-0 items-center gap-1.5 text-[13px] font-medium text-ink-muted sm:inline-flex">
            <Icons.trips size={14} />
            {existingTrips.length} аялал
          </span>
        )}
        {!isEmpty && onNewConversation && (
          <button
            type="button"
            onClick={onNewConversation}
            disabled={busy}
            title="Яриаг цэвэрлээд шинээр эхлэх (хадгалсан өөрчлөлт хэвээр)"
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 text-[13px] font-medium text-ink transition-colors hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Icons.plus size={13} />
            Шинэ яриа
          </button>
        )}
      </div>
      {dragOver && !busy && (
        <div className="pointer-events-none absolute inset-2 z-10 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-brand bg-surface/95 p-5 text-center" role="status">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-soft text-brand">
            <Icons.upload size={26} />
          </span>
          <p className="mt-1 text-base font-semibold text-ink">Файлаа энд тавиарай</p>
          <p className="text-sm text-ink-muted">Уншаад өөрчлөлтийн санал бэлдье.</p>
        </div>
      )}
      {/* The one scrollbar. The review card's sticky footer sits on this padding's bottom edge (ProposalCard: -bottom-4 / sm:-bottom-5). */}
      <div
        className="scroll-area flex min-h-0 flex-1 flex-col overflow-y-auto bg-surface px-4 py-4 sm:px-6 sm:py-5"
        role="log"
        aria-label="Туслахтай ярилцсан түүх"
        aria-relevant="additions text"
      >
        {isEmpty ? (
          <div className="mx-auto my-auto flex w-full max-w-xl flex-col items-center py-2 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-brand to-travel text-white shadow-sm">
              <Icons.ai size={22} />
            </span>
            <p className="mt-4 text-2xl font-extrabold tracking-tight text-ink sm:text-[28px]">
              Юуг өөрчлөх вэ?
            </p>
            <p className="mt-2 max-w-md text-sm leading-6 text-ink-muted">
              Хамт ажилладаг хүндээ хэлдэг шигээ бичээрэй. Би аяллыг нь олж, тодорхойгүйг нь асууж,
              өөрчлөлтийг харуулна. Та зөвшөөрснийг л хадгална, буцаах боломжтой.
            </p>
            <ul className="mt-5 flex w-full flex-wrap justify-center gap-2" aria-label="Жишээ заавар">
              {examples.map((example) => (
                <li key={example} className="min-w-0 max-w-full">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => { setAiInput(example); inputRef.current?.focus(); }}
                    className="max-w-full truncate rounded-full border border-line bg-surface px-3.5 py-1.5 text-[13px] font-medium text-ink transition-colors hover:border-brand hover:bg-brand-soft hover:text-brand disabled:opacity-50"
                    title={example}
                  >
                    {example}
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-3 max-w-md text-[13px] leading-5 text-ink-muted">
              Зураг солихдоо зургаа хавсаргаад «3-р өдрийн зургийг соль» гэж бичнэ. uudamtravel.mn эсвэл хамтрагчийн
              хуудасны холбоосыг буулгаж болно. Нэг мессежид хэд хэдэн өөрчлөлт бичиж болно.
            </p>
            <button
              type="button"
              onClick={onPickFile}
              disabled={busy}
              className="group mt-6 flex w-full items-center gap-4 rounded-2xl border-2 border-dashed border-brand-border bg-brand-soft/40 px-5 py-4 text-left transition-colors hover:border-brand hover:bg-brand-soft disabled:cursor-wait disabled:opacity-60"
            >
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface text-brand shadow-xs transition-transform group-hover:-translate-y-0.5">
                <Icons.upload size={20} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-bold text-ink">Постер, үнийн жагсаалт оруулах</span>
                <span className="mt-0.5 block text-xs leading-5 text-ink-muted">Файл сонгох эсвэл энд чирж тавих. Олон файл зэрэг болно.</span>
              </span>
              <span className="hidden shrink-0 flex-wrap justify-end gap-1.5 sm:flex" aria-label="Дэмжигдэх файлын төрөл">
                {["Зураг", "PDF", "Excel", "Word"].map((kind) => (
                  <span key={kind} className="rounded-md border border-line bg-surface px-2 py-0.5 text-[11px] font-medium text-ink-muted">{kind}</span>
                ))}
              </span>
            </button>
            <div className="mt-6 flex w-full items-center gap-3" aria-hidden="true">
              <span className="h-px flex-1 bg-line" />
              <span className="text-[12px] font-semibold uppercase tracking-wide text-ink-muted">
                {step ? "өөрчлөлт хийж байна" : "эсвэл шууд өөрчлөх"}
              </span>
              <span className="h-px flex-1 bg-line" />
            </div>
            <div className="mt-3 w-full text-left">
              {step ? <QuickActionStep controller={quick} busy={busy} /> : <QuickActionList onStart={startAction} busy={busy} />}
            </div>
          </div>
        ) : (
          <div className="mx-auto mt-auto w-full max-w-6xl space-y-4">
          {messages.map((message) => (
            <ChatBubble
              key={message.id}
              message={message}
              existingTrips={existingTrips}
              tripDetails={tripDetails}
              busy={busy}
              applyBusy={applyBusyId === message.id}
              clarifyBusy={clarifyBusyId === message.id}
              onApply={onApply}
              onRollback={onRollback}
              onSubmitClarificationForm={onSubmitClarificationForm}
              onCancelProposal={onCancelProposal}
              onResendInstruction={onResendInstruction}
              onChooseOption={onChooseOption}
              onEditDraftTrip={onEditDraftTrip}
            />
          ))}
          {step && <QuickActionStep controller={quick} busy={busy} />}
          </div>
        )}

        {busy && (
          <div className="mx-auto mt-4 flex w-full max-w-6xl justify-start">
            {progress != null ? (
              <FileProgress label={busyLabel} reported={Math.round(progress)} />
            ) : busyStages?.some((stage) => stage.long) ? (
              // A partner page read as a new trip takes 1–2 minutes: the steps and the clock, like a file.
              <FileProgress label="Хуудсыг шинэ аялал болгон уншиж байна" reported={0} stages={busyStages}
                footer="Нэг хуудас ихэвчлэн 1–1.5 минут. Энэ хуудсыг бүү хаагаарай." />
            ) : busyStages && busyStages.length > 0 && !busyLabel ? (
              <AgentProgress key={busyStages.map((stage) => stage.label).join("|")} stages={busyStages} />
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

      <div className="shrink-0 border-t border-line bg-surface px-4 py-2.5 sm:px-6">
        <div className="mx-auto w-full max-w-6xl">
        <div className={cx(
          "rounded-2xl border bg-surface shadow-xs transition-[border-color,box-shadow] duration-200 focus-within:ring-2",
          step
            ? "border-brand-border focus-within:border-brand focus-within:ring-brand/10"
            : "border-line-strong focus-within:border-brand focus-within:ring-brand/10",
        )}>
          {attachedFiles.length > 0 && !step && (
            <div className="border-b border-line px-3 pt-2.5 pb-2">
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
          <div className="flex items-end gap-1 p-1.5">
            {step && quick.definition ? (
              <span className="flex h-10 shrink-0 items-center gap-1.5 self-end rounded-xl bg-brand-soft pl-2.5 pr-1 text-xs font-semibold text-brand" aria-label={`Одоогийн үйлдэл: ${quick.definition.label}`}>
                <ActionGlyph icon={quick.definition.icon} size={14} />
                <span className="hidden sm:inline">{quick.definition.label}</span>
                <button
                  type="button"
                  onClick={quick.cancel}
                  aria-label="Үйлдлийг болих"
                  title="Болих (Esc)"
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-brand/70 transition-colors hover:bg-brand/10 hover:text-brand"
                >
                  <Icons.close size={13} />
                </button>
              </span>
            ) : (
              <ComposerActionMenu busy={busy} onStart={startAction} onPickFile={onPickFile} menuId={`${composerId}-menu`} />
            )}
            <textarea
              ref={inputRef}
              id={composerId}
              aria-label={step ? submitLabel : "Туслахад илгээх мессеж"}
              aria-describedby={`${composerId}-hint`}
              value={composerValue}
              onChange={(e) => setComposerValue(e.target.value)}
              onPaste={(e) => {
                if (!e.clipboardData.files.length) return;
                e.preventDefault();
                if (!busy) onDropFiles(e.clipboardData.files);
              }}
              maxLength={step ? 120 : MAX_AI_INPUT_CHARS}
              inputMode={stepPhase === "value" ? "numeric" : undefined}
              onKeyDown={(e) => {
                if (e.key === "Escape" && step) {
                  e.preventDefault();
                  quick.cancel();
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (step) { quick.enterAction?.(); return; }
                  if (canSend) onSend();
                }
              }}
              rows={1}
              placeholder={placeholder}
              className="scroll-area max-h-40 min-h-10 min-w-0 flex-1 resize-none border-0 bg-transparent px-1.5 py-2.5 text-[15px] leading-5 text-ink placeholder:text-ink-muted focus-visible:[box-shadow:none]"
            />
            <button
              type="button"
              onClick={() => { if (step) quick.enterAction?.(); else onSend(); }}
              disabled={!submitEnabled}
              aria-label={submitLabel}
              title={submitLabel}
              className={cx(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-all duration-150",
                submitEnabled
                  ? "bg-brand text-white shadow-xs hover:bg-brand-hover active:scale-[0.97]"
                  : "cursor-not-allowed bg-surface-sunken text-ink-subtle",
              )}
            >
              {step ? <Icons.check size={17} /> : <Icons.send size={16} />}
            </button>
          </div>
        </div>
        <div id={`${composerId}-hint`} className="mt-1.5 flex items-center justify-between gap-3 px-1.5 text-[12px] leading-4 text-ink-muted">
          {step ? (
            <span>
              {(stepPhase === "trip" || stepPhase === "value") && (
                <>
                  <kbd className="rounded border border-line bg-canvas px-1 py-px font-sans text-[10px] font-medium text-ink-muted">Enter</kbd>{" "}
                  {stepPhase === "trip" ? "эхний аяллыг сонгох" : "баталгаажуулах"}
                  <span className="mx-1.5 text-line-strong">·</span>
                </>
              )}
              <kbd className="rounded border border-line bg-canvas px-1 py-px font-sans text-[10px] font-medium text-ink-muted">Esc</kbd> болих
            </span>
          ) : (
            <>
              <span className="hidden sm:inline">
                <kbd className="rounded border border-line bg-canvas px-1 py-px font-sans text-[10px] font-medium text-ink-muted">Enter</kbd> илгээх
                <span className="mx-1.5 text-line-strong">·</span>
                <kbd className="rounded border border-line bg-canvas px-1 py-px font-sans text-[10px] font-medium text-ink-muted">Shift+Enter</kbd> шинэ мөр
                <span className="mx-1.5 text-line-strong">·</span>
                <kbd className="rounded border border-line bg-canvas px-1 py-px font-sans text-[10px] font-medium text-ink-muted">+</kbd> файл, үйлдэл
              </span>
              <span className="sm:hidden">Хадгалахаас өмнө саналаа хянаарай.</span>
            </>
          )}
          {!step && aiInput.length >= MAX_AI_INPUT_CHARS * 0.8 && (
            <span className="shrink-0 font-mono" role="status">{aiInput.length.toLocaleString()} / {MAX_AI_INPUT_CHARS.toLocaleString()}</span>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------
   One message in the conversation.
   ---------------------------------------------------------------- */
function ChatBubble({
  message,
  existingTrips = [],
  tripDetails,
  busy,
  applyBusy,
  clarifyBusy,
  onApply,
  onRollback,
  onSubmitClarificationForm,
  onCancelProposal,
  onResendInstruction,
  onChooseOption,
  onEditDraftTrip,
}: {
  message: AssistantChatMessage;
  existingTrips?: TravelTrip[];
  tripDetails?: Record<string, TravelTrip>;
  busy: boolean;
  applyBusy: boolean;
  clarifyBusy: boolean;
  onApply: (message: AssistantProposalMsg) => void;
  onRollback: (message: AssistantProposalMsg) => void;
  onSubmitClarificationForm: (
    message: AssistantProposalMsg,
    answers: Record<string, string>,
  ) => void;
  onCancelProposal: (id: string) => void;
  onResendInstruction?: (message: AssistantProposalMsg) => void;
  onChooseOption: (message: AssistantAskMsg, option: ProposalQuestionOption) => void;
  onEditDraftTrip?: EditDraftTrip;
}) {
  if (message.role === "admin") {
    // An option's answer carries the trip it chose as a tag: it travels to the server, never to the screen.
    const shownText = displayText(message.text);
    const hasRealText = Boolean(shownText) && shownText !== "Файл орууллаа";
    const images = message.imageUrls || [];
    return (
      <div className="animate-fade-up flex justify-end">
        <div className="min-w-0 max-w-[92%] rounded-2xl rounded-br-md bg-brand px-3.5 py-2.5 text-sm leading-6 text-white shadow-xs sm:max-w-lg">
          {hasRealText && (
            <p className="whitespace-pre-wrap wrap-break-word">{shownText}</p>
          )}
          {images.length > 0 ? (
            <div className={cx("flex flex-wrap gap-1.5", hasRealText && "mt-2")} aria-label="Илгээсэн зураг">
              {images.map((url) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={url} src={thumb(url, 160, 120)} alt="" loading="lazy" className="h-14 w-[4.5rem] rounded-lg bg-white/20 object-cover" />
              ))}
            </div>
          ) : message.fileNames && message.fileNames.length > 0 ? (
            <div className={hasRealText ? "mt-2 border-t border-white/20 pt-2" : undefined}>
              {message.fileNames.map((name) => (
                <p key={name} className="truncate text-xs text-white/90" title={name}>
                  📎 {name}
                </p>
              ))}
            </div>
          ) : (
            !hasRealText && (
              <p className="whitespace-pre-wrap wrap-break-word">{shownText}</p>
            )
          )}
        </div>
      </div>
    );
  }

  if (message.kind === "ask") {
    const answered = message.answered;
    return (
      <div className="animate-fade-up flex flex-col items-start" role="group" aria-label="Туслахын асуулт">
        <div className="w-full min-w-0 max-w-3xl rounded-2xl rounded-bl-md border border-line bg-surface px-4 py-3.5 shadow-xs">
          <p className="whitespace-pre-line text-[15px] font-semibold leading-6 text-ink">{message.text}</p>
          {message.options.length > 0 && (
            <ul className={cx("mt-3 grid gap-1.5", message.options.length > 3 && "sm:grid-cols-2")} aria-label="Сонголтууд">
              {message.options.map((option) => {
                const chosen = answered === option.label;
                return (
                  <li key={option.answer} className="min-w-0">
                    <button
                      type="button"
                      disabled={Boolean(answered) || busy}
                      aria-pressed={chosen}
                      onClick={() => onChooseOption(message, option)}
                      className={cx(
                        "flex min-h-11 w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left text-sm transition-colors disabled:cursor-default",
                        chosen
                          ? "border-brand bg-brand-soft text-ink"
                          : answered
                            ? "border-line text-ink-subtle"
                            : "border-line bg-surface text-ink hover:border-brand hover:bg-brand-soft",
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block font-medium wrap-break-word">{option.label}</span>
                        {option.hint && <span className="mt-0.5 block text-xs leading-4 text-ink-muted">{option.hint}</span>}
                      </span>
                      {chosen ? (
                        <Icons.check size={15} className="shrink-0 text-brand" />
                      ) : (
                        !answered && <Icons.chevronRight size={14} className="shrink-0 text-ink-subtle" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {!answered && message.allowCustom && (
            <p className="mt-2.5 text-xs leading-5 text-ink-muted">
              {message.options.length === 0
                ? (message.customPlaceholder ? `Доор бичээрэй — ${message.customPlaceholder}` : "Хариултаа доор бичээрэй.")
                : message.customPlaceholder ? `Эсвэл доор бичээрэй — ${message.customPlaceholder}` : "Эсвэл доор бичээрэй."}
            </p>
          )}
          {answered && !message.options.some((option) => option.label === answered) && (
            <p className="mt-2.5 text-xs leading-5 text-ink-muted">Таны хариулт: <span className="font-medium text-ink">{answered}</span></p>
          )}
        </div>
        <ReplyCaption meta={message.meta} />
      </div>
    );
  }

  if (message.kind === "note") {
    const tone = message.tone;
    return (
      <div className="animate-fade-up flex flex-col items-start">
        <div
          role={tone === "error" ? "alert" : undefined}
          className={cx(
            "flex min-w-0 max-w-[92%] items-start gap-2.5 rounded-2xl rounded-bl-md border px-4 py-2.5 text-sm leading-6 shadow-xs sm:max-w-lg",
            tone === "error"
              ? "border-danger/30 bg-danger-soft text-ink"
              : tone === "success"
                ? "border-success/30 bg-success-soft text-ink"
                : "border-line bg-surface text-ink",
          )}
        >
          {tone === "error" && <Icons.alert size={16} className="mt-1 shrink-0 text-danger" />}
          {tone === "success" && <Icons.check size={16} className="mt-1 shrink-0 text-success" />}
          <p className="min-w-0 whitespace-pre-wrap wrap-break-word">{message.text}</p>
        </div>
        <ReplyCaption meta={message.meta} />
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <ProposalCard
        message={message}
        existingTrips={existingTrips}
        tripDetails={tripDetails}
        applyBusy={applyBusy}
        clarifyBusy={clarifyBusy}
        onApply={onApply}
        onRollback={onRollback}
        onSubmitClarificationForm={onSubmitClarificationForm}
        onCancelProposal={onCancelProposal}
        onResendInstruction={onResendInstruction}
        onEditDraftTrip={onEditDraftTrip}
      />
      <ReplyCaption meta={message.meta} />
    </div>
  );
}
