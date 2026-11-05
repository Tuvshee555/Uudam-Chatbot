import { useId, useState } from "react";
import { Button, Icons, cx } from "@/components/ui";
import type {
  AIProposal,
  ClarificationQuestion,
  ProposalMsg,
  TravelTrip,
} from "@/lib/adminTypes";
import { isNewTripAction, reviewedProposal } from "@/lib/adminProposalApply";
import { describeAction, isRedundantDetail, summarizeConflict } from "@/lib/adminProposalUtils";
import { diffTripFields, type TripExtraDiff } from "@/lib/tripExtraSchema";
import { REVIEW_INLINE_ITEMS, departureDays, formatYmd, hasPrice, reviewFacts, reviewIssues, tripPhotos } from "@/lib/tripReview";
import { NewTripReview } from "./tripReview/NewTripReview";
import { thumb } from "./tripReview/DayCards";

/* ----------------------------------------------------------------
   One proposal, read top to bottom:
     header  — what kind of change, from which file
     body    — a new trip laid out for review (tripReview/), or an
               existing trip's change as before → after
     footer  — the one decision: answer, save as a draft, publish,
               or the result
   A new trip is corrected by clicking; what is on screen is what is
   saved. Nothing is said twice, and every button lives in the footer.
   ---------------------------------------------------------------- */

type Row = Record<string, unknown>;
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? value as Row : {});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "«Trip» — the note" → "The note", when the card already names the trip. */
function stripSubject(text: string, subjects: string[]): string {
  let out = text.trim();
  for (const subject of subjects) {
    const name = subject.trim();
    if (!name) continue;
    const pattern = new RegExp(`^«${escapeRegExp(name)}»\\s*(?:—|–|-|:)?\\s*`, "i");
    if (pattern.test(out)) { out = out.replace(pattern, ""); break; }
  }
  return out ? out.charAt(0).toUpperCase() + out.slice(1) : out;
}

type CardState = "answer" | "review" | "ready" | "applied" | "reverted" | "cancelled" | "error";

const STATE_TAG: Record<CardState, { label: string; className: string }> = {
  answer: { label: "Хариулт хэрэгтэй", className: "bg-warning-soft text-warning" },
  review: { label: "Шалгаад хадгална", className: "bg-brand-soft text-brand" },
  ready: { label: "Хадгалахад бэлэн", className: "bg-success-soft text-success" },
  applied: { label: "Хадгалагдсан", className: "bg-success-soft text-success" },
  reverted: { label: "Буцаасан", className: "bg-surface-sunken text-ink-muted" },
  cancelled: { label: "Цуцалсан", className: "bg-surface-sunken text-ink-muted" },
  error: { label: "Алдаа", className: "bg-danger-soft text-danger" },
};

const VERB_DOT: Record<string, string> = {
  "Шинэ аялал нэмэх": "bg-success",
  "Цуцлах": "bg-danger",
};

/** A new trip in a few lines: shown while a question is open and after the save. */
function TripSummary({ fields }: { fields: Row }) {
  const facts = reviewFacts(fields);
  const { days, other } = departureDays(fields.departure_dates);
  const photos = tripPhotos(fields).slice(0, 6);
  const dates = [...days.map((day) => formatYmd(day)), ...other];
  return (
    <div>
      {facts.length > 0 && <p className="text-sm text-ink-muted">{facts.join(" · ")}</p>}
      <dl className="mt-2 grid gap-x-8 gap-y-1.5 text-sm sm:grid-cols-2">
        <div className="flex items-baseline justify-between gap-3 border-b border-line/70 pb-1.5">
          <dt className="shrink-0 text-xs text-ink-muted">Том хүн</dt>
          <dd className="font-medium tabular-nums text-ink">{hasPrice(fields.adult_price) ? `${fields.adult_price.toLocaleString("en-US")}₮` : "Үнэ лавлах"}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3 border-b border-line/70 pb-1.5">
          <dt className="shrink-0 text-xs text-ink-muted">Гарах өдрүүд</dt>
          <dd className="min-w-0 text-right font-medium text-ink">{dates.length ? `${dates.slice(0, 4).join(", ")}${dates.length > 4 ? ` +${dates.length - 4}` : ""}` : "сонгоогүй"}</dd>
        </div>
      </dl>
      {photos.length > 0 && (
        <div className="mt-3 flex items-center gap-1.5">
          {photos.map((photo) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={photo.url} src={thumb(photo.url, 240, 180)} alt="" loading="lazy" className="h-12 w-16 shrink-0 rounded-md bg-surface-sunken object-cover" />
          ))}
        </div>
      )}
    </div>
  );
}

export function ProposalCard({
  message,
  existingTrips = [],
  applyBusy,
  clarifyBusy,
  onApply,
  onRollback,
  onSubmitClarificationForm,
  onCancelProposal,
}: {
  message: ProposalMsg;
  existingTrips?: TravelTrip[];
  applyBusy: boolean;
  clarifyBusy: boolean;
  onApply: (message: ProposalMsg) => void;
  onRollback: (message: ProposalMsg) => void;
  onSubmitClarificationForm: (message: ProposalMsg, answers: Record<string, string>) => void;
  onCancelProposal: (id: string) => void;
}) {
  const fieldId = useId();
  const [formDraft, setFormDraft] = useState<Record<string, string>>({});
  const [customChosen, setCustomChosen] = useState<Record<string, boolean>>({});
  const [showAllActions, setShowAllActions] = useState(false);
  const [showAllNotes, setShowAllNotes] = useState(false);
  // What the admin changed in the review, per action. It belongs to one reading of the
  // file: an answered question brings a new proposal and starts the review afresh.
  const [edits, setEdits] = useState<{ proposal: AIProposal; drafts: Record<number, Row>; open: Record<number, boolean> }>({ proposal: message.proposal, drafts: {}, open: {} });

  const { proposal } = message;
  const drafts = edits.proposal === proposal ? edits.drafts : {};
  const openTrips = edits.proposal === proposal ? edits.open : {};
  const fieldsOf = (index: number): Row => drafts[index] ?? record(proposal.actions[index]?.fields);
  const setDraft = (index: number, next: Row) => setEdits({ proposal, drafts: { ...drafts, [index]: next }, open: openTrips });
  const described = proposal.actions.map((action, index) => describeAction(isNewTripAction(action) ? { ...action, fields: fieldsOf(index) } : action));

  function diffsFor(index: number): TripExtraDiff[] {
    const action = proposal.actions[index];
    if (!action || !existingTrips.length || isNewTripAction(action)) return [];
    const verb = String(action.action || "").toLowerCase();
    if (verb !== "patch" && verb !== "upsert") return [];
    const tripId = action.trip_id?.trim();
    const routeName = action.match?.route_name?.trim() || (action.fields?.route_name as string | undefined)?.trim();
    const existing = existingTrips.find((t) => (tripId && t.id === tripId) || (routeName && t.route_name.toLowerCase() === routeName.toLowerCase()));
    return diffTripFields((action.fields as Row) ?? {}, {
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

  /* ---- what the card is about ---- */
  const creates = proposal.actions.map((action, index) => (isNewTripAction(action) ? index : -1)).filter((index) => index >= 0);
  const single = proposal.actions.length === 1 ? 0 : -1;
  const questions = message.clarifications;
  const isPending = message.status === "pending";
  const canSave = isPending && questions.length === 0;
  const reviewing = canSave && creates.length > 0;
  const state: CardState = !isPending
    ? (message.status as CardState)
    : questions.length > 0 ? "answer" : reviewing ? "review" : "ready";

  const title = single >= 0
    ? (String(fieldsOf(0).route_name ?? "").trim() || described[0]?.target || "Аялал")
    : creates.length === proposal.actions.length ? `${creates.length} шинэ аялал` : `${proposal.actions.length} аяллын өөрчлөлт`;
  const eyebrow = single >= 0 ? described[0]?.verb ?? "Өөрчлөлт" : creates.length === proposal.actions.length ? "Шинэ аялал нэмэх" : "Хэд хэдэн өөрчлөлт";
  const summary = proposal.summary.trim();
  // In a review the name is the first field and the sections say the rest.
  const showTitle = !(reviewing && single >= 0);
  const showSummary = showTitle && !creates.length && summary && summary.toLowerCase() !== title.toLowerCase();

  /* ---- notes: real doubts only; what a review section already states is left out ---- */
  const subjects = described.map((d) => d.target);
  const structured = proposal.conflict_items ?? [];
  const noteItems = structured.filter((item) => (item.severity === "info" || item.severity === "warning") && !(item.type && REVIEW_INLINE_ITEMS.has(item.type) && creates.length > 0));
  const rawNotes = structured.length > 0
    ? noteItems.map((item) => item.text)
    : Array.from(new Set(proposal.conflicts.map(summarizeConflict).filter(Boolean)));
  const notes = Array.from(new Set(rawNotes.map((text) => stripSubject(text, subjects)).filter(Boolean))).slice(0, 6);
  const visibleNotes = showAllNotes ? notes : notes.slice(0, 2);
  /** The notes about one new trip (all of them when the proposal holds a single trip). */
  const notesFor = (index: number): string[] => {
    if (creates.length === 1) return notes;
    const name = described[index]?.target || "";
    return Array.from(new Set(noteItems
      .filter((item) => String(record(item.data).route_name || "") === name || item.text.includes(`«${name}»`))
      .map((item) => stripSubject(item.text, [name])).filter(Boolean)));
  };
  const showNotesSection = notes.length > 0 && !(reviewing && creates.length === proposal.actions.length);

  const visibleActionIndexes = (showAllActions ? proposal.actions : proposal.actions.slice(0, 5)).map((_, i) => i);
  const hiddenActions = proposal.actions.length - visibleActionIndexes.length;

  /* ---- the review's verdict ---- */
  const issues = creates.flatMap((index) => reviewIssues(fieldsOf(index)).map((issue) => ({ ...issue, index })));
  const saveBlock = issues.find((issue) => issue.blocks === "save");
  const publishBlock = saveBlock ?? issues.find((issue) => issue.blocks === "publish");
  const priceless = issues.some((issue) => issue.key === "price");
  const tripTag = (index: number) => (creates.length > 1 ? `«${described[index]?.target || `Аялал ${index + 1}`}»: ` : "");
  const save = (mode: "draft" | "publish") => onApply({ ...message, proposal: reviewedProposal(proposal, drafts, mode), reviewed: true, savedAs: mode });

  /* ---- clarification drafts ---- */
  const answerFor = (q: ClarificationQuestion) =>
    formDraft[q.id] ?? q.options.find((o) => o.recommended)?.answer ?? "";
  const isCustom = (q: ClarificationQuestion) => {
    const value = formDraft[q.id];
    if (customChosen[q.id]) return true;
    return value != null && value !== "" && !q.options.some((o) => o.answer === value);
  };
  const allAnswered = questions.every((q) => answerFor(q).trim());

  function submitAnswers() {
    const effective = { ...formDraft };
    for (const q of questions) {
      if (effective[q.id]) continue;
      const recommended = q.options.find((o) => o.recommended)?.answer;
      if (recommended) effective[q.id] = recommended;
    }
    onSubmitClarificationForm(message, effective);
    setFormDraft({});
    setCustomChosen({});
  }

  const tag = state === "applied" && message.savedAs === "draft"
    ? { label: "Ноорог хадгалсан", className: "bg-surface-sunken text-ink" }
    : state === "applied" && message.savedAs === "publish" ? { label: "Нийтэлсэн", className: STATE_TAG.applied.className } : STATE_TAG[state];
  const footerCls = "rounded-b-xl border-t border-line px-4 py-3 sm:px-6";

  return (
    <article id={`proposal-${message.id}`} className="animate-fade-up w-full min-w-0 scroll-mt-4 rounded-xl border border-line bg-surface" aria-label={`${eyebrow}: ${title}`}>
      {/* ---------- header ---------- */}
      <header className="px-4 pt-4 sm:px-6">
        <div className="flex items-center gap-2 text-[11px] font-semibold tracking-wide text-ink-muted">
          <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", VERB_DOT[eyebrow] || "bg-brand")} aria-hidden="true" />
          <span className="min-w-0 truncate">{eyebrow.toLocaleUpperCase("mn")}</span>
          <span className={cx("ml-auto shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold", tag.className)}>{tag.label}</span>
        </div>
        {showTitle && <h3 className="mt-2 text-lg font-bold leading-6 tracking-tight text-ink">{title}</h3>}
        {showSummary && <p className="mt-1 text-sm leading-6 text-ink-muted">{summary}</p>}
        {reviewing && (
          <p className="mt-2 text-sm leading-6 text-ink-muted">
            Файлаас уншсан мэдээлэл доор байна. Зөв бол шууд хадгална, буруу зүйлийг л дарж засна.
          </p>
        )}
        {message.sourceNames && message.sourceNames.length > 0 && (
          <p className="mt-1.5 flex min-w-0 items-center gap-1.5 text-xs text-ink-subtle">
            <Icons.paperclip size={12} className="shrink-0" />
            <span className="truncate">{message.sourceNames.join(", ")}</span>
          </p>
        )}
      </header>

      {/* ---------- body ---------- */}
      <div className="mt-4 divide-y divide-line border-t border-line">
        {visibleActionIndexes.map((index) => {
          const action = proposal.actions[index];
          const info = described[index];
          const create = isNewTripAction(action);
          const fields = fieldsOf(index);

          if (create && reviewing) {
            const tripIssues = issues.filter((issue) => issue.index === index && issue.blocks);
            const open = single >= 0 || (openTrips[index] ?? index === creates[0]);
            return (
              <section key={index} aria-label={`${info.verb}: ${info.target}`}>
                {single < 0 && (
                  <button type="button" aria-expanded={open} onClick={() => setEdits({ proposal, drafts, open: { ...openTrips, [index]: !open } })}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-canvas/60 sm:px-6">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-ink">{info.target}</span>
                      <span className="block truncate text-xs text-ink-muted">{reviewFacts(fields).join(" · ") || "мэдээлэл дутуу"}</span>
                    </span>
                    {tripIssues.length > 0 && <span className="shrink-0 rounded-md bg-warning-soft px-2 py-0.5 text-[11px] font-semibold text-warning">{tripIssues.length} зүйл дутуу</span>}
                    <Icons.chevronRight size={15} className={cx("shrink-0 text-ink-subtle transition-transform", open && "rotate-90")} />
                  </button>
                )}
                {open && (
                  <div className={cx(single < 0 && "border-t border-line")}>
                    <NewTripReview fields={fields} onChange={(next) => setDraft(index, next)} warnings={notesFor(index)} disabled={applyBusy} />
                  </div>
                )}
              </section>
            );
          }

          const diffs = diffsFor(index);
          return (
            <section key={index} className="px-4 py-3.5 sm:px-6" aria-label={`${info.verb}: ${info.target}`}>
              {single < 0 && (
                <p className="mb-1.5 min-w-0 text-sm font-semibold text-ink">
                  {info.target}
                  <span className={cx("ml-2 rounded-md px-1.5 py-0.5 text-[11px] font-medium",
                    info.verb === "Шинэ аялал нэмэх" ? "bg-success-soft text-success" : info.verb === "Цуцлах" ? "bg-danger-soft text-danger" : "bg-brand-soft text-brand")}>
                    {info.verb}
                  </span>
                </p>
              )}
              {create && <TripSummary fields={fields} />}

              {/* an update: before → after */}
              {!create && diffs.length > 0 && (
                <dl className="mt-1 space-y-1.5">
                  {diffs.map((d) => (
                    <div key={d.field} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm">
                      <dt className="w-36 shrink-0 text-xs text-ink-muted">{d.label}</dt>
                      <dd className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                        {d.kind === "changed" && (<><span className="text-ink-subtle line-through">{d.before}</span><span aria-hidden="true" className="text-ink-subtle">→</span><span className="font-semibold text-ink">{d.after}</span></>)}
                        {d.kind === "added" && <span className="font-semibold text-success">{d.after}</span>}
                        {d.kind === "removed" && <span className="text-danger line-through">{d.before}</span>}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              {!create && diffs.length === 0 && info.changes.length > 0 && (
                <p className="mt-1 text-sm leading-6 text-ink-muted">{info.changes.slice(0, 6).join(" · ")}</p>
              )}
              {!create && diffs.length === 0 && info.changes.length === 0 && info.verb === "Цуцлах" && (
                <p className="mt-1 text-sm text-ink-muted">Төлөв <span className="text-ink-subtle line-through">Идэвхтэй</span> <span aria-hidden="true">→</span> <span className="font-semibold text-danger">Цуцлагдсан</span></p>
              )}
            </section>
          );
        })}
        {hiddenActions > 0 && !showAllActions && (
          <button type="button" onClick={() => setShowAllActions(true)} className="w-full px-4 py-2.5 text-left text-xs font-medium text-brand hover:bg-brand-soft/40 sm:px-6">
            Өөр {hiddenActions} өөрчлөлтийг харах
          </button>
        )}

        {/* ---------- notes ---------- */}
        {showNotesSection && (
          <section className="px-4 py-3.5 sm:px-6" aria-label="Тэмдэглэл">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Туслахын тэмдэглэл · {notes.length}</p>
            <ul className="mt-1.5 space-y-1">
              {visibleNotes.map((note) => (
                <li key={note} className="flex gap-2 text-sm leading-6 text-ink-muted">
                  <span aria-hidden="true" className="mt-[11px] h-1 w-1 shrink-0 rounded-full bg-ink-subtle" />
                  <span className="min-w-0 whitespace-pre-line">{note}</span>
                </li>
              ))}
            </ul>
            {notes.length > 2 && (
              <button type="button" onClick={() => setShowAllNotes((v) => !v)} aria-expanded={showAllNotes} className="mt-1 rounded text-xs font-medium text-brand hover:text-brand-hover">
                {showAllNotes ? "Хураах" : `Бүгдийг харах (${notes.length})`}
              </button>
            )}
          </section>
        )}

        {message.clarificationAnswers.length > 0 && (
          <section className="px-4 py-3.5 sm:px-6" aria-label="Өмнөх хариултууд">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Таны хариулт · {message.clarificationAnswers.length}</p>
            <dl className="mt-1.5 space-y-1.5">
              {message.clarificationAnswers.map((item) => (
                <div key={item.questionId} className="text-sm leading-6">
                  <dt className="text-xs text-ink-muted">{item.prompt}</dt>
                  <dd className="font-medium text-ink">{item.answer}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}
      </div>

      {/* ---------- footer: the one decision ---------- */}
      {state === "answer" && (
        <footer className={cx(footerCls, "bg-canvas/70 py-4")}>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-warning">
            {creates.length > 0 ? "Шалгахын өмнө" : "Хадгалахын өмнө"} {questions.length > 1 ? `· ${questions.length} асуулт` : ""}
          </p>
          <div className="mt-2 space-y-4">
            {questions.map((q, qIndex) => {
              const selected = answerFor(q);
              const custom = isCustom(q);
              const name = `${fieldId}-q${qIndex}`;
              const detail = q.detail && !isRedundantDetail(q.prompt, q.detail) ? q.detail : "";
              return (
                <fieldset key={q.id} disabled={clarifyBusy} className="min-w-0">
                  <legend className="text-sm font-semibold leading-6 text-ink">{q.prompt}</legend>
                  {detail && <p className="mt-0.5 text-xs leading-5 text-ink-muted">{detail}</p>}
                  <div className="mt-2 divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
                    {q.options.map((opt) => {
                      const checked = !custom && selected === opt.answer;
                      return (
                        <label key={opt.label} className={cx("flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm transition-colors hover:bg-brand-soft/40", checked && "bg-brand-soft/60")}>
                          <input
                            type="radio"
                            name={name}
                            checked={checked}
                            onChange={() => { setCustomChosen((prev) => ({ ...prev, [q.id]: false })); setFormDraft((prev) => ({ ...prev, [q.id]: opt.answer })); }}
                            className="h-4 w-4 shrink-0 accent-brand"
                          />
                          <span className="min-w-0 font-medium text-ink">{opt.label}</span>
                          {opt.recommended && <span className="ml-auto shrink-0 text-[11px] font-medium text-ink-subtle">санал болгож буй</span>}
                        </label>
                      );
                    })}
                    {q.allowCustom && (
                      <label className={cx("flex cursor-pointer items-center gap-3 px-3 py-2 text-sm transition-colors hover:bg-brand-soft/40", custom && "bg-brand-soft/60")}>
                        <input
                          type="radio"
                          name={name}
                          checked={custom}
                          onChange={() => { setCustomChosen((prev) => ({ ...prev, [q.id]: true })); setFormDraft((prev) => ({ ...prev, [q.id]: q.options.some((o) => o.answer === (prev[q.id] ?? "")) ? "" : (prev[q.id] ?? "") })); }}
                          className="h-4 w-4 shrink-0 accent-brand"
                        />
                        <span className="shrink-0 font-medium text-ink">Өөрөөр</span>
                        <input
                          aria-label={`${q.prompt} Өөрийн хариулт`}
                          value={custom ? selected : ""}
                          onFocus={() => { setCustomChosen((prev) => ({ ...prev, [q.id]: true })); if (!custom) setFormDraft((prev) => ({ ...prev, [q.id]: "" })); }}
                          onChange={(e) => { setCustomChosen((prev) => ({ ...prev, [q.id]: true })); setFormDraft((prev) => ({ ...prev, [q.id]: e.target.value })); }}
                          placeholder={q.customPlaceholder || "Хариултаа бичнэ үү"}
                          className="h-8 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 text-sm text-ink placeholder:text-ink-subtle focus:border-line-strong focus:bg-surface"
                        />
                      </label>
                    )}
                  </div>
                </fieldset>
              );
            })}
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={clarifyBusy} onClick={() => onCancelProposal(message.id)}>Болих</Button>
            <Button size="sm" loading={clarifyBusy} disabled={clarifyBusy || !allAnswered} onClick={submitAnswers}>
              Хариулт илгээх
            </Button>
          </div>
        </footer>
      )}

      {reviewing && (
        // Stays in reach while the review scrolls; the negative offset is the conversation's own padding.
        <footer className={cx(footerCls, "sticky -bottom-3.5 z-10 bg-surface/95 shadow-[0_-8px_16px_-12px_rgb(0_0_0/0.25)] backdrop-blur-sm sm:-bottom-5")}>
          {message.saveError && (
            <p role="alert" className="mb-2.5 flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft px-3 py-2 text-[13px] leading-5 text-danger">
              <Icons.alert size={14} className="mt-0.5 shrink-0" />
              <span className="min-w-0 whitespace-pre-line">Хадгалагдсангүй: {message.saveError}</span>
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5">
            <p className="min-w-0 flex-1 basis-56 text-xs leading-5" aria-live="polite">
              {publishBlock ? (
                <span className="flex items-start gap-1.5 font-medium text-warning">
                  <Icons.alert size={13} className="mt-0.5 shrink-0" />
                  <span>{tripTag(publishBlock.index)}{publishBlock.text}</span>
                </span>
              ) : (
                <span className="flex items-start gap-1.5 text-ink-muted">
                  <Icons.check size={13} className="mt-0.5 shrink-0 text-success" />
                  <span>Нийтлэхэд бэлэн.{priceless ? " Үнэ оруулаагүй тул сайтад «Үнэ лавлах» гэж гарна." : ""} Ноорог нь сайтад гарахгүй, бот хариулахгүй.</span>
                </span>
              )}
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <Button size="sm" variant="ghost" disabled={applyBusy} onClick={() => onCancelProposal(message.id)}>Болих</Button>
              <Button size="sm" variant="secondary" loading={applyBusy && message.savedAs === "draft"} disabled={applyBusy || Boolean(saveBlock)} onClick={() => save("draft")}>
                Ноорог хадгалах
              </Button>
              <Button size="sm" loading={applyBusy && message.savedAs !== "draft"} disabled={applyBusy || Boolean(publishBlock)} onClick={() => save("publish")}>
                <Icons.check size={15} /> Нийтлэх
              </Button>
            </div>
          </div>
        </footer>
      )}

      {canSave && !reviewing && (
        <footer className={cx(footerCls, "flex flex-wrap items-center justify-between gap-3 bg-canvas/70")}>
          <p className={cx("min-w-0 whitespace-pre-line text-xs leading-5", message.saveError ? "text-danger" : "text-ink-muted")}>
            {message.saveError ? `Хадгалагдсангүй: ${message.saveError}` : "Хадгалсны дараа буцаах боломжтой."}
          </p>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" disabled={applyBusy} onClick={() => onCancelProposal(message.id)}>Болих</Button>
            <Button size="sm" loading={applyBusy} disabled={applyBusy} onClick={() => onApply(message)}>
              <Icons.check size={15} /> Хадгалах
            </Button>
          </div>
        </footer>
      )}

      {state === "applied" && (
        <footer className={cx(footerCls, "flex flex-wrap items-center justify-between gap-3 bg-success-soft/50")}>
          <p className="flex min-w-0 flex-1 basis-56 items-start gap-2 text-sm leading-6 text-ink">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success text-white"><Icons.check size={12} /></span>
            <span className="min-w-0">
              <span className="font-semibold text-success">
                {message.savedAs === "draft" ? "Ноорог болгон хадгаллаа." : message.savedAs === "publish" ? "Нийтлэгдлээ." : "Хадгалагдлаа."}
              </span>{" "}
              <span className="text-ink-muted">
                {message.savedAs === "draft"
                  ? "Сайтад гараагүй, бот хариулахгүй. «Аяллууд» хэсгээс нээж засаад нийтэлнэ."
                  : message.savedAs === "publish" ? "Сайт болон чатботод орлоо." : message.resultText}
              </span>
            </span>
          </p>
          {message.requestId != null && (
            <Button size="sm" variant="secondary" loading={applyBusy} onClick={() => onRollback(message)}>Буцаах</Button>
          )}
        </footer>
      )}
      {state === "reverted" && (
        <footer className={cx(footerCls, "bg-canvas/70 text-sm text-ink-muted")}>Өөрчлөлт буцаагдлаа. Юу ч үлдээгүй.</footer>
      )}
      {state === "cancelled" && (
        <footer className={cx(footerCls, "bg-canvas/70 text-sm text-ink-muted")}>Цуцлагдсан. Юу ч хадгалагдаагүй.</footer>
      )}
      {state === "error" && (
        <footer className={cx(footerCls, "whitespace-pre-line bg-danger-soft/50 text-sm text-danger")}>{message.resultText || "Алдаа гарлаа."}</footer>
      )}
    </article>
  );
}
