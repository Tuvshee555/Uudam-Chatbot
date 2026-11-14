import { useEffect, useId, useMemo, useState } from "react";
import { Button, Icons, cx } from "@/components/ui";
import type {
  AIAction,
  AIProposal,
  ClarificationQuestion,
  TravelTrip,
} from "@/lib/adminTypes";
import { isNewTripAction, reviewedProposal } from "@/lib/adminProposalApply";
import { actionView, describeAction, hasPlannedLines, isRedundantDetail, proposalWarnings, summarizeConflict, summaryLines, type ActionView } from "@/lib/adminProposalUtils";
import { diffTripFields, type TripExtraDiff } from "@/lib/tripExtraSchema";
import { REVIEW_INLINE_ITEMS, departureDays, formatYmd, hasPrice, removePhoto, reviewFacts, reviewIssues, tripPhotos } from "@/lib/tripReview";
import { NewTripReview } from "./tripReview/NewTripReview";
import { DamageNotice, damagedActions, withAcknowledgedDamage } from "./ProposalDamage";
import { mergeEditorResult } from "@/lib/tripEditorState";
import { withSuggestedHotelProfiles } from "@/lib/tripHotelNames";
import { thumb } from "./tripReview/photoThumb";
import { displayText, isSaveLocked } from "./assistantChatLogic";
import type { AssistantProposalMsg } from "./assistantChatTypes";

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

type CardState = "answer" | "review" | "ready" | "applied" | "reverted" | "cancelled" | "error" | "empty";

const STATE_TAG: Record<CardState, { label: string; className: string }> = {
  answer: { label: "Хариулт хэрэгтэй", className: "bg-warning-soft text-warning" },
  review: { label: "Шалгаад хадгална", className: "bg-brand-soft text-brand" },
  ready: { label: "Хадгалахад бэлэн", className: "bg-success-soft text-success" },
  applied: { label: "Хадгалагдсан", className: "bg-success-soft text-success" },
  reverted: { label: "Буцаасан", className: "bg-surface-sunken text-ink-muted" },
  cancelled: { label: "Цуцалсан", className: "bg-surface-sunken text-ink-muted" },
  error: { label: "Алдаа", className: "bg-danger-soft text-danger" },
  empty: { label: "Өөрчлөлт алга", className: "bg-surface-sunken text-ink-muted" },
};
/** A save that got no answer: maybe saved, maybe not — never «Алдаа» or «Хадгалагдсангүй». */
const UNKNOWN_TAG = { label: "Тодорхойгүй", className: "bg-warning-soft text-warning" };

/** "14:35": the minute a save lock is certainly over (rounded up). */
function clockOf(ms: number): string {
  const at = new Date(Math.ceil(ms / 60_000) * 60_000);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

const VERB_DOT: Record<string, string> = {
  "Шинэ аялал нэмэх": "bg-success",
  "Цуцлах": "bg-danger",
  "Архивлах": "bg-danger",
  "Огнооны төлөв": "bg-sun",
  "Сайтаас нуух": "bg-sun",
  "Зураг хасах": "bg-danger",
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

const LABELED_LINE = /^([^:]{1,48}):\s+(.+)$/u;

/** "12/2: Том хүн 2,590,000₮ → 2,690,000₮" as a label and a before → after value. */
function ChangeLine({ line, alignValue = false }: { line: string; alignValue?: boolean }) {
  const colon = LABELED_LINE.exec(line);
  const label = colon ? colon[1] : "";
  const value = colon ? colon[2] : line;
  const arrow = value.lastIndexOf(" → ");
  // An amount line with no label of its own ("Хүүхэд +100,000₮") sits under its labeled sibling.
  const spacer = !label && alignValue && /₮|→/u.test(value);
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm">
      {(label || spacer) && <dt className="w-28 shrink-0 text-xs text-ink-muted sm:w-36">{label}</dt>}
      <dd className="min-w-0 flex-1 wrap-break-word text-ink">
        {arrow > 0 ? (
          <>
            <span className="text-ink-muted">{value.slice(0, arrow)}</span>
            <span aria-hidden="true" className="mx-1.5 text-ink-subtle">→</span>
            <span className="sr-only">болно</span>
            <span className="font-semibold">{value.slice(arrow + 3)}</span>
          </>
        ) : value}
      </dd>
    </div>
  );
}

/** One photo of a before → after pair; an empty slot says what is there. */
function PhotoThumb({ url, caption }: { url?: string; caption: string }) {
  return (
    <figure className="flex min-w-0 flex-col items-center gap-1">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={thumb(url, 320, 240)} alt={caption} loading="lazy" className="h-20 w-28 rounded-lg border border-line bg-surface-sunken object-cover sm:h-24 sm:w-32" />
      ) : (
        <span className="flex h-20 w-28 items-center justify-center rounded-lg border border-dashed border-line bg-canvas text-[11px] text-ink-subtle sm:h-24 sm:w-32">
          <Icons.image size={18} />
        </span>
      )}
      <figcaption className="text-[11px] text-ink-muted">{caption}</figcaption>
    </figure>
  );
}

/** The lines of one assistant action (a date's price, a photo, a program day, …). */
function ActionLines({ view }: { view: ActionView }) {
  const { thumbs } = view;
  const labeled = view.lines.some((line) => LABELED_LINE.test(line));
  return (
    <div className="mt-1 space-y-2">
      {view.lines.length > 0 && (
        <dl className="space-y-1.5">
          {view.lines.map((line, index) => <ChangeLine key={`${index}-${line}`} line={line} alignValue={labeled} />)}
        </dl>
      )}
      {thumbs && (thumbs.before || thumbs.after) && (
        <div className="flex items-center gap-2 pt-1" aria-label="Зургийн өөрчлөлт">
          <PhotoThumb url={thumbs.before} caption={thumbs.before ? "Одоо" : "Зураггүй"} />
          <Icons.chevronRight size={16} className="shrink-0 text-ink-subtle" />
          <PhotoThumb url={thumbs.after} caption={thumbs.after ? "Шинэ" : "Хасагдана"} />
        </div>
      )}
      {view.warnings.map((warning) => (
        <p key={warning} className="flex items-start gap-1.5 text-[13px] leading-5 text-warning">
          <Icons.alert size={13} className="mt-0.5 shrink-0" />
          <span className="min-w-0">{warning}</span>
        </p>
      ))}
    </div>
  );
}

/** While a long save runs: after a few seconds, say that it is still working. */
function SaveWaitHint() {
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const seconds = Math.floor((now - startedAt) / 1000);
  if (seconds < 6) return null;
  return (
    <p className="text-xs leading-5 text-ink-muted" role="status">
      Хадгалж байна… {seconds}с. Олон аялал бол 1-2 минут болж магадгүй — хуудсыг бүү хаагаарай.
    </p>
  );
}

/** Opens the full trip editor on an unsaved trip; the editor's save hands the fields back. */
export type EditDraftTrip = (fields: Row, onDone: (fields: Row) => void) => void;

export function ProposalCard({
  message,
  existingTrips = [],
  tripDetails,
  applyBusy,
  clarifyBusy,
  onApply,
  onRollback,
  onSubmitClarificationForm,
  onCancelProposal,
  onResendInstruction,
  onEditDraftTrip,
}: {
  message: AssistantProposalMsg;
  existingTrips?: TravelTrip[];
  /** Trips loaded in full (program days, day photos), by id; used while they are current. */
  tripDetails?: Record<string, TravelTrip>;
  applyBusy: boolean;
  clarifyBusy: boolean;
  onApply: (message: AssistantProposalMsg) => void;
  onRollback: (message: AssistantProposalMsg) => void;
  onSubmitClarificationForm: (message: AssistantProposalMsg, answers: Record<string, string>) => void;
  onCancelProposal: (id: string) => void;
  onResendInstruction?: (message: AssistantProposalMsg) => void;
  onEditDraftTrip?: EditDraftTrip;
}) {
  const fieldId = useId();
  const [formDraft, setFormDraft] = useState<Record<string, string>>({});
  const [customChosen, setCustomChosen] = useState<Record<string, boolean>>({});
  const [showAllActions, setShowAllActions] = useState(false);
  const [showAllNotes, setShowAllNotes] = useState(false);
  // The tick holds for exactly the damage it was given on: a revised card asks again.
  const [damageOkFor, setDamageOkFor] = useState("");
  // What the admin changed in the review, per action. It belongs to one reading of the
  // file: an answered question brings a new proposal and starts the review afresh.
  const [edits, setEdits] = useState<{ proposal: AIProposal; drafts: Record<number, Row>; open: Record<number, boolean> }>({ proposal: message.proposal, drafts: {}, open: {} });

  const { proposal } = message;
  const drafts = edits.proposal === proposal ? edits.drafts : {};
  const openTrips = edits.proposal === proposal ? edits.open : {};
  // A new trip opens with the hotels its file names already listed (name only), once per reading:
  // a hotel the admin then removes stays removed. The file reader does the same (tripProposalFinalize.ts).
  const opening = useMemo(() => proposal.actions.map((action) => (isNewTripAction(action)
    ? withSuggestedHotelProfiles(record(action.fields)) : record(action.fields))), [proposal]);
  const fieldsOf = (index: number): Row => drafts[index] ?? opening[index] ?? {};
  // Functional: the full editor answers later, after other edits may have landed.
  const setDraft = (index: number, next: Row | ((current: Row) => Row)) => setEdits((prev) => {
    const base = prev.proposal === proposal ? prev : { proposal, drafts: {}, open: {} };
    const current = base.drafts[index] ?? opening[index] ?? {};
    return { ...base, drafts: { ...base.drafts, [index]: typeof next === "function" ? next(current) : next } };
  });
  const openFullEditor = (index: number) => {
    const opened = fieldsOf(index);
    onEditDraftTrip?.(opened, (edited) => setDraft(index, (current) => {
      // A photo removed in the editor also leaves its day and its credit: tripPhotos would add a day photo back.
      const kept = Array.isArray(edited.photo_urls) ? new Set(edited.photo_urls as string[]) : null;
      const removed = kept ? (Array.isArray(opened.photo_urls) ? (opened.photo_urls as string[]) : []).filter((url) => !kept.has(url)) : [];
      return mergeEditorResult(removed.reduce((fields, url) => removePhoto(fields, url), current), edited);
    }));
  };
  /** The trip as it is now: the full copy while it is current, else the list row. */
  const tripFor = (id?: string): TravelTrip | undefined => {
    if (!id) return undefined;
    const listed = existingTrips.find((entry) => entry.id === id);
    const full = tripDetails?.[id];
    return full && (!listed || listed.updated_at === full.updated_at) ? full : listed;
  };
  const isPending = message.status === "pending";
  // An action built from an id alone (a tapped choice, a per-date change) is shown under the
  // trip's name, never its id.
  const described = proposal.actions.map((action, index) => {
    const info = describeAction(isNewTripAction(action) ? { ...action, fields: fieldsOf(index) } : action);
    const trip = tripFor(action.trip_id);
    return trip && info.target === action.trip_id ? { ...info, target: trip.route_name } : info;
  });
  const views: Array<ActionView | null> = proposal.actions.map((action) =>
    hasPlannedLines(action) ? actionView(action, tripFor(action.trip_id), { live: isPending }) : null);
  // The public pages the server read after the save (savedTripLinks.ts); a draft or hidden trip has none.
  const savedLinks = (message.savedLinks || []).filter((link) => link.url);
  // A card saved before the server sent links: the slug the trip list holds, if any.
  const websiteLink = (() => {
    if (message.savedLinks) return null;
    const id = proposal.actions.find((action) => action.trip_id)?.trip_id;
    const extra = tripFor(id)?.extra;
    const slug = (typeof extra?.website_slug === "string" ? extra.website_slug : "")
      || (extra?.website_sync as { website_slug?: string } | null | undefined)?.website_slug;
    return slug ? `https://uudamtravel.mn/mn/trips/${encodeURIComponent(slug)}` : null;
  })();

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
  const none = proposal.actions.length === 0;
  const questions = message.clarifications;
  // Set while a save may still be running on the server (also across a reload); a timer clears it
  // when that time is up, and the time itself is checked so a stale lock never keeps Save off.
  const locked = isSaveLocked(message);
  const canSave = isPending && questions.length === 0 && !none;
  const reviewing = canSave && creates.length > 0;
  // The last save got no answer: said as unknown, in amber, with when Save comes back.
  const unknownSave = Boolean(message.saveUnknown) && (canSave || message.status === "error");
  const lockNote = unknownSave && locked && message.saveLockedUntil
    ? `\nСервер өмнөх хадгалалтаа үргэлжлүүлж байж магадгүй тул товч ${clockOf(message.saveLockedUntil)} хүртэл идэвхгүй.`
    : "";
  const state: CardState = !isPending
    ? (message.status as CardState)
    : questions.length > 0 ? "answer" : none ? "empty" : reviewing ? "review" : "ready";

  // Several changes to one trip ("12/2 дүүрсэн, 12/9-ний үнэ +100k, 3-р өдрийн зураг"): the trip is the title.
  const tripIds = new Set(proposal.actions.map((action) => action.trip_id || ""));
  const sameTrip = proposal.actions.length > 1 && tripIds.size === 1 && !tripIds.has("");
  const title = none
    ? "Тодруулах зүйл байна"
    : single >= 0
      ? (String(fieldsOf(0).route_name ?? "").trim() || described[0]?.target || "Аялал")
      : sameTrip ? described[0]?.target || "Аялал"
        : creates.length === proposal.actions.length ? `${creates.length} шинэ аялал` : `${tripIds.size} аяллын ${proposal.actions.length} өөрчлөлт`;
  const eyebrow = none ? "Тодруулга" : single >= 0 ? described[0]?.verb ?? "Өөрчлөлт" : creates.length === proposal.actions.length ? "Шинэ аялал нэмэх" : sameTrip ? `${proposal.actions.length} өөрчлөлт` : "Хэд хэдэн өөрчлөлт";
  // The sentence under the title, without repeating the title ("«Trip» — 12-р сарын 27…" → "12-р сарын 27…").
  const summary = stripSubject(proposal.summary.trim(), [title]);
  // In a review the name is the first field and the sections say the rest.
  const showTitle = !(reviewing && single >= 0);
  const showSummary = showTitle && !creates.length && summary && summary.toLowerCase() !== title.toLowerCase()
    // One assistant change: its lines say it; the summary would repeat them.
    && !(single >= 0 && views[0] && summaryLines(proposal.actions[0] && (proposal.actions[0] as AIAction & { summary?: string }).summary).join("; ") === summary);

  /* ---- notes: real doubts only; what a review section already states is left out ---- */
  const subjects = described.map((d) => d.target);
  const structured = proposal.conflict_items ?? [];
  const noteItems = structured.filter((item) => (item.severity === "info" || item.severity === "warning") && !(item.type && REVIEW_INLINE_ITEMS.has(item.type) && creates.length > 0));
  /** The notes about one new trip (all of them when the proposal holds a single trip). */
  const allNotes = Array.from(new Set((structured.length > 0 ? noteItems.map((item) => item.text) : proposal.conflicts.map(summarizeConflict).filter(Boolean))
    .map((text) => stripSubject(text, subjects)).filter(Boolean))).slice(0, 6);
  const notesFor = (index: number): string[] => {
    if (creates.length === 1) return allNotes;
    const name = described[index]?.target || "";
    return Array.from(new Set(noteItems
      .filter((item) => String(record(item.data).route_name || "") === name || item.text.includes(`«${name}»`))
      .map((item) => stripSubject(item.text, [name])).filter(Boolean)));
  };
  // Changes to existing trips: what was refused or needs a look is said plainly, all of it.
  const plain = creates.length ? null : proposalWarnings(proposal);
  const strip = (list: string[]) => Array.from(new Set(list.map((text) => stripSubject(text, single >= 0 || sameTrip ? subjects : [])).filter(Boolean)));
  const warnings = plain ? strip(plain.warnings) : [];
  const skipped = plain ? plain.skipped : [];
  const notes = plain ? strip(plain.notes) : allNotes;
  const visibleNotes = showAllNotes || plain ? notes : notes.slice(0, 2);
  const showNotesSection = (notes.length > 0 || warnings.length > 0 || skipped.length > 0) && !(reviewing && creates.length === proposal.actions.length);

  const visibleActionIndexes = (showAllActions ? proposal.actions : proposal.actions.slice(0, 5)).map((_, i) => i);
  const hiddenActions = proposal.actions.length - visibleActionIndexes.length;

  /* ---- the review's verdict ---- */
  const issues = creates.flatMap((index) => reviewIssues(fieldsOf(index)).map((issue) => ({ ...issue, index })));
  const saveBlock = issues.find((issue) => issue.blocks === "save");
  const publishBlock = saveBlock ?? issues.find((issue) => issue.blocks === "publish");
  const tripTag = (index: number) => (creates.length > 1 ? `«${described[index]?.target || `Аялал ${index + 1}`}»: ` : "");
  /* ---- a change that would break a saved trip: said in red, saved only once ticked (ProposalDamage.tsx) ---- */
  const damaged = damagedActions(proposal, (index) => described[index]?.target || "Аялал");
  const damageKey = damaged.map((item) => `${item.index}:${item.lines.join(" ")}`).join("|");
  const damageOk = damageKey !== "" && damageOkFor === damageKey;
  const damageBlocks = damaged.length > 0 && !damageOk;
  const acknowledged = (next: AIProposal) => (damaged.length > 0 && damageOk ? withAcknowledgedDamage(next) : next);
  // What is on screen is what is saved, the opening hotels included.
  const save = (mode: "draft" | "publish") => onApply({ ...message, proposal: acknowledged(reviewedProposal(proposal, Object.fromEntries(creates.map((index) => [index, fieldsOf(index)])), mode)), reviewed: true, savedAs: mode });
  const saveEdit = () => onApply(damaged.length > 0 && damageOk ? { ...message, proposal: acknowledged(message.proposal), reviewed: true } : message);

  /* ---- clarification drafts ---- */
  const answerFor = (q: ClarificationQuestion) =>
    formDraft[q.id] ?? q.options.find((o) => o.recommended)?.answer ?? "";
  const isCustom = (q: ClarificationQuestion) => {
    const value = formDraft[q.id];
    if (customChosen[q.id]) return true;
    return value != null && value !== "" && !q.options.some((o) => o.answer === value);
  };
  const allAnswered = questions.every((q) => answerFor(q).trim());
  // One question the server asked (which trip, which day): its choices are buttons, a tap answers.
  const serverIds = new Set((proposal.questions || []).map((question) => question.id));
  const tapQuestion = questions.length === 1 && serverIds.has(questions[0].id) ? questions[0] : null;

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
  function answerWith(q: ClarificationQuestion, answer: string) {
    if (!answer.trim()) return;
    onSubmitClarificationForm(message, { [q.id]: answer });
    setFormDraft({});
    setCustomChosen({});
  }

  const tag = unknownSave ? UNKNOWN_TAG
    : state === "applied" && message.savedAs === "draft"
    ? { label: "Ноорог хадгалсан", className: "bg-surface-sunken text-ink" }
    : state === "applied" && message.savedAs === "publish" ? { label: "Нийтэлсэн", className: STATE_TAG.applied.className }
      : state === "error" && message.expired ? { label: "Хуучирсан", className: "bg-surface-sunken text-ink-muted" } : STATE_TAG[state];
  const footerCls = "rounded-b-xl border-t border-line px-4 py-3 sm:px-6";

  return (
    <article id={`proposal-${message.id}`} className="animate-fade-up w-full min-w-0 scroll-mt-4 rounded-xl border border-line bg-surface" aria-label={`${eyebrow}: ${title}`}>
      {/* ---------- header ---------- */}
      <header className={cx("px-4 pt-4", reviewing ? "sm:px-8 sm:pt-5" : "sm:px-6")}>
        <div className="flex items-center gap-2 text-[12px] font-semibold tracking-wide text-ink-muted">
          <span className={cx("h-2 w-2 shrink-0 rounded-full", VERB_DOT[eyebrow] || "bg-brand")} aria-hidden="true" />
          <span className="min-w-0 truncate">{eyebrow.toLocaleUpperCase("mn")}</span>
          <span className={cx("ml-auto shrink-0 rounded-md px-2 py-0.5 text-[12px] font-semibold", tag.className)}>{tag.label}</span>
        </div>
        {showTitle && <h3 className="mt-2 text-lg font-bold leading-6 tracking-tight text-ink">{title}</h3>}
        {showSummary && <p className="mt-1 text-sm leading-6 text-ink-muted">{summary}</p>}
        {reviewing && (
          <p className="mt-2 text-[15px] leading-6 text-ink">
            Аялал сайт дээр ингэж харагдана. Зөв бол шууд хадгална, буруу зүйл дээр нь дарж засна.
          </p>
        )}
        {message.sourceNames && message.sourceNames.length > 0 && (
          <p className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[13px] text-ink-muted">
            <Icons.paperclip size={13} className="shrink-0" />
            <span className="truncate">{message.sourceNames.join(", ")}</span>
          </p>
        )}
      </header>
      {isPending && <DamageNotice items={damaged} checked={damageOk} onToggle={(next) => setDamageOkFor(next ? damageKey : "")} disabled={applyBusy} />}

      {/* ---------- body ---------- */}
      <div className={cx("mt-4 divide-y divide-line", (!none || showNotesSection || message.clarificationAnswers.length > 0) && "border-t border-line")}>
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
                    <NewTripReview fields={fields} onChange={(next) => setDraft(index, next)} warnings={notesFor(index)} disabled={applyBusy}
                      onOpenEditor={onEditDraftTrip ? () => openFullEditor(index) : undefined} />
                  </div>
                )}
              </section>
            );
          }

          const view = views[index];
          const diffs = view ? [] : diffsFor(index);
          const fallbackLines = !view && !create && diffs.length === 0 && info.changes.length === 0
            ? summaryLines((action as AIAction & { summary?: string }).summary) : [];
          return (
            <section key={index} className="px-4 py-3.5 sm:px-6" aria-label={`${info.verb}: ${info.target}`}>
              {single < 0 && (
                <p className="mb-1.5 min-w-0 text-sm font-semibold text-ink">
                  {!sameTrip && info.target}
                  <span className={cx(!sameTrip && "ml-2", "whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-medium",
                    info.verb === "Шинэ аялал нэмэх" ? "bg-success-soft text-success" : info.verb === "Цуцлах" || info.verb === "Архивлах" ? "bg-danger-soft text-danger" : "bg-brand-soft text-brand")}>
                    {info.verb}
                  </span>
                </p>
              )}
              {create && <TripSummary fields={fields} />}

              {view && <ActionLines view={view} />}

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
              {!view && !create && diffs.length === 0 && info.changes.length > 0 && (
                <p className="mt-1 text-sm leading-6 text-ink-muted">{info.changes.slice(0, 6).join(" · ")}</p>
              )}
              {fallbackLines.length > 0 && info.verb !== "Цуцлах" && info.verb !== "Архивлах" && (
                <dl className="mt-1 space-y-1.5">{fallbackLines.map((line, at) => <ChangeLine key={`${at}-${line}`} line={line} />)}</dl>
              )}
              {!view && !create && diffs.length === 0 && info.changes.length === 0 && info.verb === "Цуцлах" && (
                <p className="mt-1 text-sm text-ink-muted">Төлөв <span className="text-ink-subtle line-through">Идэвхтэй</span> <span aria-hidden="true">→</span> <span className="font-semibold text-danger">Цуцлагдсан</span></p>
              )}
              {!view && !create && diffs.length === 0 && info.changes.length === 0 && info.verb === "Архивлах" && (
                <p className="mt-1.5 text-sm text-ink-muted">Төлөв <span aria-hidden="true">→</span> <span className="font-semibold text-danger">Архив</span> · сайт болон ботоос харагдахгүй, буцаах боломжтой</p>
              )}
            </section>
          );
        })}
        {hiddenActions > 0 && !showAllActions && (
          <button type="button" onClick={() => setShowAllActions(true)} className="w-full px-4 py-2.5 text-left text-xs font-medium text-brand hover:bg-brand-soft/40 sm:px-6">
            Өөр {hiddenActions} өөрчлөлтийг харах
          </button>
        )}

        {/* ---------- warnings and notes ---------- */}
        {showNotesSection && (
          <section className="space-y-3 px-4 py-3.5 sm:px-6" aria-label="Тэмдэглэл">
            {warnings.length > 0 && (
              <div className="rounded-lg border border-warning/30 bg-warning-soft/60 px-3 py-2.5" role="note">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-warning">
                  <Icons.alert size={12} /> Анхаарах · {warnings.length}
                </p>
                <ul className="mt-1 space-y-1">
                  {warnings.map((warning) => <li key={warning} className="text-sm leading-6 text-ink">{warning}</li>)}
                </ul>
              </div>
            )}
            {skipped.length > 0 && (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Алгассан аялал · {skipped.length}</p>
                <ul className="mt-1 space-y-1">
                  {skipped.map((line) => (
                    <li key={line} className="flex gap-2 text-sm leading-6 text-ink-muted">
                      <span aria-hidden="true" className="mt-[11px] h-1 w-1 shrink-0 rounded-full bg-ink-subtle" />
                      <span className="min-w-0">{line}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {notes.length > 0 && (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Туслахын тэмдэглэл · {notes.length}</p>
                <ul className="mt-1.5 space-y-1">
                  {visibleNotes.map((note) => (
                    <li key={note} className="flex gap-2 text-sm leading-6 text-ink-muted">
                      <span aria-hidden="true" className="mt-[11px] h-1 w-1 shrink-0 rounded-full bg-ink-subtle" />
                      <span className="min-w-0 whitespace-pre-line">{note}</span>
                    </li>
                  ))}
                </ul>
                {!plain && notes.length > 2 && (
                  <button type="button" onClick={() => setShowAllNotes((v) => !v)} aria-expanded={showAllNotes} className="mt-1 rounded text-xs font-medium text-brand hover:text-brand-hover">
                    {showAllNotes ? "Хураах" : `Бүгдийг харах (${notes.length})`}
                  </button>
                )}
              </div>
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
                  <dd className="font-medium text-ink">{displayText(item.answer)}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}
      </div>

      {/* ---------- footer: the one decision ---------- */}
      {state === "answer" && tapQuestion && (
        <footer className={cx(footerCls, "bg-canvas/70 py-4")}>
          <fieldset disabled={clarifyBusy} className="min-w-0">
            <legend className="text-sm font-semibold leading-6 text-ink">{tapQuestion.prompt}</legend>
            {tapQuestion.detail && !isRedundantDetail(tapQuestion.prompt, tapQuestion.detail) && <p className="mt-0.5 text-xs leading-5 text-ink-muted">{tapQuestion.detail}</p>}
            {tapQuestion.options.length > 0 && (
              <ul className={cx("mt-2.5 grid gap-1.5", tapQuestion.options.length > 3 && "sm:grid-cols-2")} aria-label="Сонголтууд">
                {tapQuestion.options.map((option) => (
                  <li key={option.answer} className="min-w-0">
                    <button type="button" onClick={() => answerWith(tapQuestion, option.answer)}
                      className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl border border-line bg-surface px-3 py-2 text-left text-sm text-ink transition-colors hover:border-brand hover:bg-brand-soft disabled:cursor-wait disabled:opacity-60">
                      <span className="min-w-0 font-medium wrap-break-word">{option.label}</span>
                      <Icons.chevronRight size={14} className="shrink-0 text-ink-subtle" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {tapQuestion.allowCustom && (
              <form className="mt-2 flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); answerWith(tapQuestion, formDraft[tapQuestion.id] ?? ""); }}>
                <input
                  aria-label={`${tapQuestion.prompt} Өөрийн хариулт`}
                  value={formDraft[tapQuestion.id] ?? ""}
                  onChange={(e) => setFormDraft((prev) => ({ ...prev, [tapQuestion.id]: e.target.value }))}
                  placeholder={tapQuestion.customPlaceholder || "Эсвэл хариултаа бичнэ үү"}
                  className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-sm text-ink placeholder:text-ink-subtle focus:border-line-strong"
                />
                <Button size="sm" type="submit" loading={clarifyBusy} disabled={clarifyBusy || !(formDraft[tapQuestion.id] ?? "").trim()}>Илгээх</Button>
              </form>
            )}
          </fieldset>
          <div className="mt-3 flex justify-end">
            <Button size="sm" variant="ghost" disabled={clarifyBusy} onClick={() => onCancelProposal(message.id)}>Болих</Button>
          </div>
        </footer>
      )}
      {state === "answer" && !tapQuestion && (
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
        // Stays in reach while the review scrolls, one slim row; the negative offset is the conversation's own padding (AssistantTab).
        <footer className="sticky -bottom-4 z-10 rounded-b-xl border-t border-line bg-surface/95 px-4 py-2 shadow-[0_-8px_16px_-12px_rgb(0_0_0/0.25)] backdrop-blur-sm sm:-bottom-5 sm:px-8">
          {message.saveError && (unknownSave ? (
            <p role="status" className="mb-2.5 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-[13px] leading-5 text-ink">
              <Icons.alert size={14} className="mt-0.5 shrink-0 text-warning" />
              <span className="min-w-0 whitespace-pre-line">{message.saveError}{lockNote}</span>
            </p>
          ) : (
            <p role="alert" className="mb-2.5 flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft px-3 py-2 text-[13px] leading-5 text-danger">
              <Icons.alert size={14} className="mt-0.5 shrink-0" />
              <span className="min-w-0 whitespace-pre-line">Хадгалагдсангүй: {message.saveError}</span>
            </p>
          ))}
          {applyBusy && <div className="mb-2"><SaveWaitHint /></div>}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            {/* On a phone the «ready» line is left out so the footer stays one row; what still blocks is always said. */}
            <p className={cx("min-w-0 flex-1 basis-56 text-[13px] leading-5", !publishBlock && !damageBlocks && "hidden sm:block")} aria-live="polite">
              {damageBlocks ? (
                <span className="flex items-start gap-1.5 font-medium text-danger">
                  <Icons.alert size={14} className="mt-0.5 shrink-0" />
                  <span>Дээрх улаан хэсгийг уншаад тэмдэглэсний дараа хадгална.</span>
                </span>
              ) : publishBlock ? (
                <span className="flex items-start gap-1.5 font-medium text-warning">
                  <Icons.alert size={14} className="mt-0.5 shrink-0" />
                  <span>{tripTag(publishBlock.index)}{publishBlock.text}{publishBlock.blocks === "publish" && !saveBlock ? " Ноорог болгон хадгалж болно." : ""}</span>
                </span>
              ) : (
                <span className="flex items-start gap-1.5 text-ink-muted">
                  <Icons.check size={14} className="mt-0.5 shrink-0 text-success" />
                  <span>Нийтлэхэд бэлэн. Ноорог нь сайтад гарахгүй, бот хариулахгүй.</span>
                </span>
              )}
            </p>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <Button size="sm" variant="ghost" disabled={applyBusy} onClick={() => onCancelProposal(message.id)}>Болих</Button>
              <Button size="sm" variant="secondary" loading={applyBusy && message.savedAs === "draft"} disabled={applyBusy || locked || Boolean(saveBlock) || damageBlocks} onClick={() => save("draft")}>
                Ноорог хадгалах
              </Button>
              <Button size="sm" loading={applyBusy && message.savedAs !== "draft"} disabled={applyBusy || locked || Boolean(publishBlock) || damageBlocks} onClick={() => save("publish")}>
                <Icons.check size={15} /> Нийтлэх
              </Button>
            </div>
          </div>
        </footer>
      )}

      {canSave && !reviewing && (
        <footer className={cx(footerCls, "space-y-2 bg-canvas/70")}>
          {applyBusy && <SaveWaitHint />}
          <div className="flex flex-wrap items-center justify-between gap-3">
            {message.saveError && unknownSave ? (
              <p className="flex min-w-0 flex-1 basis-56 items-start gap-1.5 whitespace-pre-line text-xs leading-5 text-warning" role="status">
                <Icons.alert size={13} className="mt-0.5 shrink-0" />
                <span className="min-w-0">{message.saveError}{lockNote}</span>
              </p>
            ) : (
              <p className={cx("min-w-0 flex-1 basis-56 whitespace-pre-line text-xs leading-5", message.saveError ? "text-danger" : "text-ink-muted")} role={message.saveError ? "alert" : undefined}>
                {message.saveError ? `Хадгалагдсангүй: ${message.saveError}` : "Хадгалсны дараа буцаах боломжтой."}
              </p>
            )}
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" disabled={applyBusy} onClick={() => onCancelProposal(message.id)}>Болих</Button>
              <Button size="sm" loading={applyBusy} disabled={applyBusy || locked || damageBlocks} onClick={saveEdit}>
                <Icons.check size={15} /> {locked && !applyBusy ? "Хүлээж байна…" : "Хадгалах"}
              </Button>
            </div>
          </div>
        </footer>
      )}

      {state === "empty" && (
        <footer className={cx(footerCls, "bg-canvas/70 text-sm text-ink-muted")}>Хадгалах өөрчлөлт алга.</footer>
      )}
      {state === "applied" && (
        <footer className={cx(footerCls, "flex flex-wrap items-center justify-between gap-3 bg-success-soft/50")}>
          <div className="flex min-w-0 flex-1 basis-56 items-start gap-2 text-sm leading-6 text-ink">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success text-white"><Icons.check size={12} /></span>
            <div className="min-w-0">
              <p>
                <span className="font-semibold text-success">
                  {message.savedAs === "draft" ? "Ноорог болгон хадгаллаа." : message.savedAs === "publish" ? "Нийтлэгдлээ." : "Хадгалагдлаа."}
                </span>{" "}
                <span className="text-ink-muted">
                  {message.savedAs === "draft"
                    ? "Ноорог — сайтад гараагүй, бот хариулахгүй. «Аяллууд» хэсгээс нээж засаад нийтэлнэ."
                    : message.savedAs === "publish" ? "Сайт болон чатботод орлоо." : message.resultText}
                </span>
              </p>
              {savedLinks.length > 0 && (
                <ul className="mt-1 space-y-0.5" aria-label="Сайт дээрх хуудас">
                  {savedLinks.map((link) => (
                    <li key={link.trip_id} className="min-w-0 text-[13px] leading-5">
                      {savedLinks.length > 1 && link.route_name && <span className="text-ink-muted">«{link.route_name}»: </span>}
                      <a href={link.url!} target="_blank" rel="noopener noreferrer"
                        className="break-all font-medium text-brand underline decoration-brand/40 underline-offset-4 hover:decoration-brand">
                        {link.url!.replace(/^https:\/\//, "")}
                      </a>
                      {link.pending && <span className="text-ink-subtle"> · сайтад орж байна, хэдэн секундын дараа нээгдэнэ</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          <span className="flex items-center gap-3">
            {websiteLink && (
              <a href={websiteLink} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-brand underline decoration-brand/40 underline-offset-4 hover:decoration-brand">
                Сайтаас харах
              </a>
            )}
            {message.requestId != null && (
              <Button size="sm" variant="secondary" loading={applyBusy} onClick={() => onRollback(message)}>Буцаах</Button>
            )}
          </span>
        </footer>
      )}
      {state === "reverted" && (
        <footer className={cx(footerCls, "bg-canvas/70 text-sm text-ink-muted")}>Өөрчлөлт буцаагдлаа. Юу ч үлдээгүй.</footer>
      )}
      {state === "cancelled" && (
        <footer className={cx(footerCls, "bg-canvas/70 text-sm text-ink-muted")}>{message.resultText || "Цуцлагдсан. Юу ч хадгалагдаагүй."}</footer>
      )}
      {state === "error" && message.expired && (
        <footer className={cx(footerCls, "flex flex-wrap items-center justify-between gap-3 bg-canvas/70")}>
          <p className="min-w-0 flex-1 basis-56 text-sm leading-6 text-ink" role="alert">{message.resultText}</p>
          {onResendInstruction && (
            <Button size="sm" variant="secondary" onClick={() => onResendInstruction(message)}>
              <Icons.refresh size={14} /> Дахин илгээх
            </Button>
          )}
        </footer>
      )}
      {state === "error" && !message.expired && unknownSave && (
        <footer className={cx(footerCls, "flex items-start gap-2 bg-warning-soft/50 text-sm leading-6 text-ink")} role="status">
          <Icons.alert size={14} className="mt-1 shrink-0 text-warning" />
          <span className="min-w-0 whitespace-pre-line">{message.resultText}</span>
        </footer>
      )}
      {state === "error" && !message.expired && !unknownSave && (
        <footer className={cx(footerCls, "whitespace-pre-line bg-danger-soft/50 text-sm text-danger")}>{message.resultText || "Алдаа гарлаа."}</footer>
      )}
    </article>
  );
}
