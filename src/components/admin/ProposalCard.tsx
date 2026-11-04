import { useId, useState } from "react";
import { Button, Icons, cx } from "@/components/ui";
import type {
  AIAction,
  ClarificationQuestion,
  ConflictItem,
  ProposalMsg,
  TravelTrip,
} from "@/lib/adminTypes";
import { describeAction, isRedundantDetail, summarizeConflict } from "@/lib/adminProposalUtils";
import { diffTripFields, type TripExtraDiff } from "@/lib/tripExtraSchema";
import { TRANSPORT_LABELS, isTransportType } from "@/lib/tripTransitDays";

/* ----------------------------------------------------------------
   One proposal, read top to bottom:
     header  — what kind of change, to which trip, from which file
     body    — the record as it will be saved (or before → after)
     notes   — what the assistant assumed, short
     footer  — the one decision: answer, save, or the result
   Nothing is said twice, and every button lives in the footer.
   ---------------------------------------------------------------- */

function thumbnailUrl(url: string): string {
  return url.includes("res.cloudinary.com/") && url.includes("/upload/")
    ? url.replace("/upload/", "/upload/c_fill,w_240,h_180,q_auto,f_auto/")
    : url;
}

function formatMoneyMnt(value: unknown): string {
  const n = typeof value === "number" ? value : parseFloat(String(value ?? ""));
  if (!Number.isFinite(n) || n <= 0) return "";
  return `${n.toLocaleString("en-US")}₮`;
}

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

type CardState = "answer" | "price" | "ready" | "applied" | "reverted" | "cancelled" | "error";

const STATE_TAG: Record<CardState, { label: string; className: string }> = {
  answer: { label: "Хариулт хэрэгтэй", className: "bg-warning-soft text-warning" },
  price: { label: "Үнэ дутуу", className: "bg-warning-soft text-warning" },
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

const inputCls =
  "h-9 w-full rounded-lg border border-line-strong bg-surface px-2.5 text-sm text-ink transition-colors placeholder:text-ink-subtle focus:border-brand";

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
  const [fieldOverrides, setFieldOverrides] = useState<Record<string, string>>({});
  const [showAllActions, setShowAllActions] = useState(false);
  const [showAllNotes, setShowAllNotes] = useState(false);
  const [openEditors, setOpenEditors] = useState<Record<number, boolean>>({});

  const { proposal } = message;
  const described = proposal.actions.map(describeAction);

  /* ---- field overrides: the admin can correct a new trip before saving ---- */
  const fieldKey = (index: number, field: string) => `${index}:${field}`;
  function getField(index: number, field: string, fallback: unknown): string {
    const key = fieldKey(index, field);
    if (key in fieldOverrides) return fieldOverrides[key];
    const value = (proposal.actions[index]?.fields ?? {})[field];
    return value != null ? String(value) : fallback != null ? String(fallback) : "";
  }
  function setField(index: number, field: string, value: string) {
    setFieldOverrides((prev) => ({ ...prev, [fieldKey(index, field)]: value }));
  }
  function withOverrides(): ProposalMsg {
    if (Object.keys(fieldOverrides).length === 0) return message;
    const actions = proposal.actions.map((action, i) => {
      const entries = Object.entries(fieldOverrides)
        .filter(([key]) => key.startsWith(`${i}:`))
        .map(([key, value]) => [key.slice(key.indexOf(":") + 1), value] as const);
      if (entries.length === 0) return action;
      const fields: Record<string, unknown> = { ...(action.fields ?? {}) };
      for (const [field, raw] of entries) {
        if (field === "adult_price" || field === "child_price" || field === "seats_total" || field === "seats_left") {
          const n = parseFloat(raw);
          fields[field] = Number.isNaN(n) ? null : n;
        } else if (field === "has_food") {
          fields[field] = raw === "true" ? true : raw === "false" ? false : null;
        } else if (field === "departure_dates") {
          fields[field] = raw.split(",").map((d) => d.trim()).filter(Boolean);
        } else {
          fields[field] = raw;
        }
      }
      return { ...action, fields };
    });
    return { ...message, proposal: { ...proposal, actions } };
  }

  function diffsFor(index: number): TripExtraDiff[] {
    const action = proposal.actions[index];
    if (!action || !existingTrips.length) return [];
    const verb = String(action.action || "").toLowerCase();
    const isCreate = verb === "upsert" && !action.trip_id;
    if (verb !== "patch" && !isCreate && !(verb === "upsert" && action.trip_id)) return [];
    const tripId = action.trip_id?.trim();
    const routeName = action.match?.route_name?.trim() || (action.fields?.route_name as string | undefined)?.trim();
    const existing = isCreate
      ? null
      : existingTrips.find((t) => (tripId && t.id === tripId) || (routeName && t.route_name.toLowerCase() === routeName.toLowerCase()));
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

  /* ---- what the card is about ---- */
  const isCreateAction = (action: AIAction) => String(action.action || "").toLowerCase() === "upsert" && !action.trip_id;
  const single = proposal.actions.length === 1 ? 0 : -1;
  const title = single >= 0
    ? (getField(0, "route_name", described[0]?.target).trim() || described[0]?.target || "Аялал")
    : `${proposal.actions.length} аяллын өөрчлөлт`;
  const eyebrow = single >= 0 ? described[0]?.verb ?? "Өөрчлөлт" : "Хэд хэдэн өөрчлөлт";
  const summary = proposal.summary.trim();
  const showSummary = summary && summary.toLowerCase() !== title.toLowerCase();

  const questions = message.clarifications;
  const isPending = message.status === "pending";
  const priceMissing = proposal.actions.some((action, index) =>
    isCreateAction(action) && !getField(index, "adult_price", action.fields?.adult_price).trim());
  const state: CardState = !isPending
    ? (message.status as CardState)
    : questions.length > 0 ? "answer" : priceMissing ? "price" : "ready";
  const canSave = isPending && questions.length === 0;

  /* ---- notes: assumptions worth a glance, without repeating the trip name ---- */
  const askedIds = new Set(questions.map((q) => q.id));
  const askedAs = (item: ConflictItem) => {
    const route = String(item.data?.route_name || "").trim();
    return (item.type === "transport_choice" && askedIds.has(`transport:${route}`))
      || (item.type === "price_missing" && askedIds.has(`price:${route}`));
  };
  const structured = proposal.conflict_items ?? [];
  const rawNotes = structured.length > 0
    ? structured.filter((item) => (item.severity === "info" || item.severity === "warning") && !askedAs(item)).map((item) => item.text)
    : Array.from(new Set(proposal.conflicts.map(summarizeConflict).filter(Boolean)));
  const subjects = described.map((d) => d.target);
  const notes = Array.from(new Set(rawNotes.map((text) => stripSubject(text, subjects)).filter(Boolean))).slice(0, 6);
  const visibleNotes = showAllNotes ? notes : notes.slice(0, 2);

  const visibleActionIndexes = (showAllActions ? proposal.actions : proposal.actions.slice(0, 5)).map((_, i) => i);
  const hiddenActions = proposal.actions.length - visibleActionIndexes.length;

  function isEditing(index: number): boolean {
    if (index in openEditors) return openEditors[index];
    return !getField(index, "route_name", "").trim() || !getField(index, "adult_price", "").trim();
  }

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

  const tag = STATE_TAG[state];

  return (
    <article className="animate-fade-up w-full min-w-0 overflow-hidden rounded-xl border border-line bg-surface" aria-label={`${eyebrow}: ${title}`}>
      {/* ---------- header ---------- */}
      <header className="px-4 pt-4 sm:px-5">
        <div className="flex items-center gap-2 text-[11px] font-semibold tracking-wide text-ink-muted">
          <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", VERB_DOT[eyebrow] || "bg-brand")} aria-hidden="true" />
          <span className="min-w-0 truncate">{eyebrow.toLocaleUpperCase("mn")}</span>
          <span className={cx("ml-auto shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold", tag.className)}>{tag.label}</span>
        </div>
        <h3 className="mt-2 text-lg font-bold leading-6 tracking-tight text-ink">{title}</h3>
        {showSummary && <p className="mt-1 text-sm leading-6 text-ink-muted">{summary}</p>}
        {message.sourceNames && message.sourceNames.length > 0 && (
          <p className="mt-1.5 flex min-w-0 items-center gap-1.5 text-xs text-ink-subtle">
            <Icons.paperclip size={12} className="shrink-0" />
            <span className="truncate">{message.sourceNames.join(", ")}</span>
          </p>
        )}
      </header>

      {/* ---------- body: the record ---------- */}
      <div className="mt-4 divide-y divide-line border-t border-line">
        {visibleActionIndexes.map((index) => {
          const action = proposal.actions[index];
          const info = described[index];
          const create = isCreateAction(action);
          // Corrections are offered only when saving is the next step: before a question is
          // answered the proposal is regenerated, and edits made now would be lost.
          const editing = create && canSave && isEditing(index);
          const f = action.fields ?? {};
          const extra = (f.extra && typeof f.extra === "object" ? f.extra : {}) as Record<string, unknown>;
          const dayCount = Array.isArray(extra.itinerary_days) ? extra.itinerary_days.length : 0;
          const photos = (Array.isArray(f.photo_urls) ? (f.photo_urls as unknown[]) : [])
            .filter((url): url is string => typeof url === "string" && url.startsWith("https://"));
          const diffs = create ? [] : diffsFor(index);
          const adult = getField(index, "adult_price", f.adult_price);
          const foodValue = getField(index, "has_food", f.has_food == null ? "" : String(f.has_food));
          const departures = getField(index, "departure_dates", Array.isArray(f.departure_dates) ? (f.departure_dates as string[]).join(", ") : "");

          const rows: Array<{ label: string; value: string; missing?: boolean; wide?: boolean }> = create
            ? [
                { label: "Хугацаа", value: getField(index, "duration_text", f.duration_text) },
                { label: "Тээвэр", value: isTransportType(extra.transport_type) ? TRANSPORT_LABELS[extra.transport_type] : "" },
                { label: "Том хүн", value: formatMoneyMnt(adult), missing: !adult.trim() },
                { label: "Хүүхэд", value: formatMoneyMnt(getField(index, "child_price", f.child_price)) },
                { label: "Гарах өдрүүд", value: departures },
                { label: "Суудал", value: getField(index, "seats_total", f.seats_total) },
                { label: "Хоол", value: foodValue === "true" ? "Багтсан" : foodValue === "false" ? "Ороогүй" : "" },
                { label: "Хөтөлбөр", value: dayCount ? `${dayCount} өдөр` : "" },
                { label: "Буудал", value: getField(index, "hotel", f.hotel) },
                { label: "Тэмдэглэл", value: getField(index, "notes", f.notes), wide: true },
              ].filter((row) => row.value.trim() || row.missing)
            : [];

          return (
            <section key={index} className="px-4 py-3.5 sm:px-5" aria-label={`${info.verb}: ${info.target}`}>
              {(single < 0 || (create && canSave)) && (
                <div className="flex items-center justify-between gap-3">
                  {single < 0 ? (
                    <p className="min-w-0 text-sm font-semibold text-ink">
                      {info.target}
                      <span className={cx("ml-2 rounded-md px-1.5 py-0.5 text-[11px] font-medium",
                        info.verb === "Шинэ аялал нэмэх" ? "bg-success-soft text-success" : info.verb === "Цуцлах" ? "bg-danger-soft text-danger" : "bg-brand-soft text-brand")}>
                        {info.verb}
                      </span>
                    </p>
                  ) : (
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Хадгалагдах мэдээлэл</p>
                  )}
                  {create && canSave && (
                    <button
                      type="button"
                      onClick={() => setOpenEditors((prev) => ({ ...prev, [index]: !editing }))}
                      aria-expanded={editing}
                      aria-controls={`${fieldId}-${index}-editor`}
                      disabled={applyBusy}
                      className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-brand transition-colors hover:bg-brand-soft disabled:opacity-50"
                    >
                      {editing ? <Icons.check size={13} /> : <Icons.edit size={13} />}
                      {editing ? "Болсон" : "Засах"}
                    </button>
                  )}
                </div>
              )}

              {/* a new trip: the record, or the same record as inputs */}
              {create && !editing && rows.length > 0 && (
                <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                  {rows.map((row) => (
                    <div key={row.label} className={cx("flex min-w-0 items-baseline justify-between gap-3 border-b border-line/70 pb-1.5", row.wide && "sm:col-span-2")}>
                      <dt className="shrink-0 text-xs text-ink-muted">{row.label}</dt>
                      <dd className={cx("min-w-0 text-right text-sm font-medium wrap-break-word", row.missing ? "text-warning" : "text-ink")}>
                        {row.missing ? "Дутуу" : row.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              {create && !editing && rows.length === 0 && (
                <p className="mt-2 text-sm text-ink-muted">Дэлгэрэнгүй мэдээлэл олдсонгүй. «Засах» дээр дараад нөхөөрэй.</p>
              )}
              {create && editing && (
                <fieldset id={`${fieldId}-${index}-editor`} disabled={applyBusy} className="mt-3 grid min-w-0 grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
                  <Field id={`${fieldId}-${index}-name`} label="Аяллын нэр" wide>
                    <input id={`${fieldId}-${index}-name`} value={getField(index, "route_name", f.route_name)} onChange={(e) => setField(index, "route_name", e.target.value)} placeholder="Аяллын нэр" className={inputCls} />
                  </Field>
                  <Field id={`${fieldId}-${index}-adult`} label="Том хүний үнэ ₮" hint={!adult.trim() ? "Заавал" : undefined}>
                    <input id={`${fieldId}-${index}-adult`} type="number" min={0} inputMode="decimal" value={adult} onChange={(e) => setField(index, "adult_price", e.target.value)} placeholder="0" className={cx(inputCls, !adult.trim() && "border-warning/60")} />
                  </Field>
                  <Field id={`${fieldId}-${index}-child`} label="Хүүхдийн үнэ ₮">
                    <input id={`${fieldId}-${index}-child`} type="number" min={0} inputMode="decimal" value={getField(index, "child_price", f.child_price)} onChange={(e) => setField(index, "child_price", e.target.value)} placeholder="заавал биш" className={inputCls} />
                  </Field>
                  <Field id={`${fieldId}-${index}-duration`} label="Хугацаа">
                    <input id={`${fieldId}-${index}-duration`} value={getField(index, "duration_text", f.duration_text)} onChange={(e) => setField(index, "duration_text", e.target.value)} placeholder="Өдөр, шөнийн тоо" className={inputCls} />
                  </Field>
                  <Field id={`${fieldId}-${index}-departures`} label="Гарах өдрүүд" hint="таслалаар">
                    <input id={`${fieldId}-${index}-departures`} value={departures} onChange={(e) => setField(index, "departure_dates", e.target.value)} placeholder="2026-06-15, 2026-07-02" className={inputCls} />
                  </Field>
                  <Field id={`${fieldId}-${index}-seats`} label="Суудал">
                    <input id={`${fieldId}-${index}-seats`} type="number" min={0} inputMode="numeric" value={getField(index, "seats_total", f.seats_total)} onChange={(e) => setField(index, "seats_total", e.target.value)} placeholder="заавал биш" className={inputCls} />
                  </Field>
                  <Field id={`${fieldId}-${index}-food`} label="Хоол">
                    <select id={`${fieldId}-${index}-food`} value={foodValue} onChange={(e) => setField(index, "has_food", e.target.value)} className={inputCls}>
                      <option value="">Тодорхойгүй</option>
                      <option value="true">Багтсан</option>
                      <option value="false">Ороогүй</option>
                    </select>
                  </Field>
                  <Field id={`${fieldId}-${index}-hotel`} label="Буудал">
                    <input id={`${fieldId}-${index}-hotel`} value={getField(index, "hotel", f.hotel)} onChange={(e) => setField(index, "hotel", e.target.value)} placeholder="заавал биш" className={inputCls} />
                  </Field>
                  <Field id={`${fieldId}-${index}-notes`} label="Тэмдэглэл" wide>
                    <textarea id={`${fieldId}-${index}-notes`} value={getField(index, "notes", f.notes)} onChange={(e) => setField(index, "notes", e.target.value)} placeholder="заавал биш" className="min-h-[64px] w-full rounded-lg border border-line-strong bg-surface px-2.5 py-2 text-sm text-ink placeholder:text-ink-subtle focus:border-brand" />
                  </Field>
                </fieldset>
              )}
              {create && photos.length > 0 && (
                <div className="mt-3 flex items-center gap-1.5">
                  {photos.slice(0, 6).map((url) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={url} src={thumbnailUrl(url)} alt="" loading="lazy" className="h-12 w-16 shrink-0 rounded-md bg-surface-sunken object-cover" />
                  ))}
                  <span className="ml-1 text-xs text-ink-muted">{photos.length} зураг</span>
                </div>
              )}

              {/* an update: before → after */}
              {!create && diffs.length > 0 && (
                <dl className="mt-2 space-y-1.5">
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
                <p className="mt-1.5 text-sm leading-6 text-ink-muted">{info.changes.slice(0, 6).join(" · ")}</p>
              )}
              {!create && diffs.length === 0 && info.changes.length === 0 && info.verb === "Цуцлах" && (
                <p className="mt-1.5 text-sm text-ink-muted">Төлөв <span className="text-ink-subtle line-through">Идэвхтэй</span> <span aria-hidden="true">→</span> <span className="font-semibold text-danger">Цуцлагдсан</span></p>
              )}
            </section>
          );
        })}
        {hiddenActions > 0 && !showAllActions && (
          <button type="button" onClick={() => setShowAllActions(true)} className="w-full px-4 py-2.5 text-left text-xs font-medium text-brand hover:bg-brand-soft/40 sm:px-5">
            Өөр {hiddenActions} өөрчлөлтийг харах
          </button>
        )}

        {/* ---------- notes ---------- */}
        {notes.length > 0 && (
          <section className="px-4 py-3.5 sm:px-5" aria-label="Тэмдэглэл">
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
          <section className="px-4 py-3.5 sm:px-5" aria-label="Өмнөх хариултууд">
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
        <footer className="border-t border-line bg-canvas/70 px-4 py-4 sm:px-5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-warning">
            Хадгалахын өмнө {questions.length > 1 ? `· ${questions.length} асуулт` : ""}
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

      {canSave && (
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-canvas/70 px-4 py-3 sm:px-5">
          <p className={cx("text-xs leading-5", state === "price" ? "text-warning" : "text-ink-muted")}>
            {state === "price" ? "Том хүний төгрөгийн үнэ дутуу. Оруулаад хадгалахыг зөвлөж байна." : "Хадгалсны дараа буцаах боломжтой."}
          </p>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" disabled={applyBusy} onClick={() => onCancelProposal(message.id)}>Болих</Button>
            <Button size="sm" loading={applyBusy} disabled={applyBusy} onClick={() => onApply(withOverrides())}>
              <Icons.check size={15} /> Хадгалах
            </Button>
          </div>
        </footer>
      )}

      {state === "applied" && (
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-success-soft/50 px-4 py-3 sm:px-5">
          <p className="flex items-center gap-2 text-sm text-ink">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-success text-white"><Icons.check size={12} /></span>
            <span className="font-semibold text-success">Хадгалагдлаа.</span>
            {message.resultText && <span className="text-ink-muted">{message.resultText}</span>}
          </p>
          {message.requestId != null && (
            <Button size="sm" variant="secondary" loading={applyBusy} onClick={() => onRollback(message)}>Буцаах</Button>
          )}
        </footer>
      )}
      {state === "reverted" && (
        <footer className="border-t border-line bg-canvas/70 px-4 py-3 text-sm text-ink-muted sm:px-5">Өөрчлөлт буцаагдлаа. {message.resultText}</footer>
      )}
      {state === "cancelled" && (
        <footer className="border-t border-line bg-canvas/70 px-4 py-3 text-sm text-ink-muted sm:px-5">Цуцлагдсан. Юу ч хадгалагдаагүй.</footer>
      )}
      {state === "error" && (
        <footer className="border-t border-line bg-danger-soft/50 px-4 py-3 text-sm text-danger sm:px-5">{message.resultText || "Алдаа гарлаа."}</footer>
      )}
    </article>
  );
}

function Field({ id, label, hint, wide, children }: { id: string; label: string; hint?: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={cx("min-w-0", wide && "sm:col-span-2")}>
      <label htmlFor={id} className="mb-1 flex items-baseline justify-between text-xs text-ink-muted">
        <span>{label}</span>
        {hint && <span className={cx("text-[11px]", hint === "Заавал" ? "font-medium text-warning" : "text-ink-subtle")}>{hint}</span>}
      </label>
      {children}
    </div>
  );
}
