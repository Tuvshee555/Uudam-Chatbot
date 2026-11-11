/**
 * A trip read from a file or a partner page, reviewed as the customer will see it on
 * uudamtravel.mn: the photos, name, summary and facts; «Гарах өдөр ба үнэ» as a table; the
 * day-by-day program; what the price includes; the hotels; the notes and booking terms. Every part
 * is edited where it is shown: a click opens it in place.
 *
 * Above it, ONE list of what stops a publish (red) and what deserves a look (amber), each a link to
 * the place that fixes it (tripReviewProblems.ts), or a calm «Нийтлэхэд бэлэн».
 *
 * Empty optional fields are not shown: they are small «+ …» chips at the bottom of their part
 * (reviewView.ts); a field with a value always shows. «Бүх талбар» shows them all.
 *
 * The owner, 2026-11-11: the old review was a long form of ~40 boxes, mostly empty, and he scrolled
 * all of it to find the two that mattered. What is saved did not change: every edit goes through the
 * same helpers as before (tripReview.ts, tripReviewPrices.ts, tripDayStates.ts).
 */
import { useEffect, useRef, useState } from "react";
import { Icons, cx } from "@/components/ui";
import {
  addDaysYmd, checkDeparture, departureDays, formatYmd, itineraryOf, reviewIssues, setProgramDays, shiftDepartureDay,
} from "@/lib/tripReview";
import { withCalendarDays } from "@/lib/tripReviewPrices";
import { dayStates, setDayState } from "@/lib/tripDayStates";
import { reviewProblems, type ReviewProblem } from "@/lib/tripReviewProblems";
import { isTransitDay } from "@/lib/tripTransitDays";
import { ItineraryTimeline } from "../tripEditor/ItineraryTimeline";
import { MultiDateCalendar } from "./MultiDateCalendar";
import { PriceSection } from "./PriceSection";
import { ConditionsSection, HotelsSection, IncludedSection } from "./ReviewConditions";
import { ReviewHero, type HeroPanel } from "./ReviewHero";
import { EditPanel, Evidence, GhostInput, Notice, ReviewSection, primarySmall, secondarySmall } from "./ReviewParts";
import { ReviewProblemsBar } from "./ReviewProblemsBar";
import { splitOptional, type OptionalKey } from "./reviewView";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? value as Row : {});
const text = (value: unknown) => (typeof value === "string" ? value : "");

/** The parts that open as a panel (the rest are fields shown in place). */
const PANELS = new Set(["photos", "duration", "transport", "hotel", "calendar", "profiles"]);
const isPanel = (part: string) => PANELS.has(part) || part.startsWith("card:");

const AGES = [["adult", "Том хүн", "ж: 12+ нас"], ["child", "Хүүхэд", "ж: 2-11 нас"], ["infant", "Нярай", "ж: 0-23 сар"]] as const;

/**
 * Scrolls a part of the review into view and puts the cursor in it: the box `field` names (a fare),
 * else its first box. A click in place (`center` false) only focuses: the browser scrolls as little as it can.
 */
export function revealTarget(root: ParentNode | null, target: string, field?: string, center = true) {
  const place = root?.querySelector<HTMLElement>(`[data-review-target="${target}"]`);
  if (!place) return;
  if (center) place.scrollIntoView({ block: "center", behavior: "smooth" });
  const named = field ? place.querySelector<HTMLElement>(`[data-focus="${field}"]`) : null;
  const scope = named ?? place;
  // A box marked wrong first (the extra bands), then the first box to type in, then the first button.
  const box = named?.matches("input, textarea, select, button") ? named
    : scope.querySelector<HTMLElement>("input[aria-invalid=true], input.border-danger")
      ?? scope.querySelector<HTMLElement>("input:not([type=checkbox]):not([type=radio]):not(:disabled), textarea:not(:disabled), select:not(:disabled)")
      ?? scope.querySelector<HTMLElement>("button:not(:disabled):not([data-panel-close])");
  box?.focus({ preventScroll: center });
}

export function NewTripReview({
  fields,
  onChange,
  warnings,
  disabled,
  onOpenEditor,
  initialOpen,
}: {
  fields: Row;
  onChange: (next: Row) => void;
  /** The assistant's real doubts about this trip (not what the review already says). */
  warnings: string[];
  disabled?: boolean;
  /** Opens this trip in the full trip editor; its save comes back into this review. */
  onOpenEditor?: () => void;
  /** A part to show open from the start: a panel («calendar», «card:all» …) or an optional field («terms:visa» …). */
  initialOpen?: string;
}) {
  const extra = record(fields.extra);
  const setExtra = (patch: Row) => onChange({ ...fields, extra: { ...extra, ...patch } });
  const itinerary = itineraryOf(fields);
  const { days: departures, other: rules } = departureDays(fields.departure_dates);
  const evidence = record(extra.source_evidence);
  const added = itinerary.filter(isTransitDay).length;
  const check = checkDeparture(departures, itinerary);
  const issues = reviewIssues(fields);
  const dateIssue = issues.find((issue) => issue.key === "dates" || issue.key === "past_dates");
  const boundaryIssue = issues.find((issue) => issue.key === "boundary");
  const problems = reviewProblems(fields, warnings);
  const states = dayStates(fields);
  const ages = record(extra.age_rules);

  const rootRef = useRef<HTMLFieldSetElement>(null);
  // One part is open at a time: a hero fact, the photos, the calendar, a price row («card:<key>»), the hotels.
  // With no departure day yet, the calendar is what the admin needs first.
  const [open, setOpen] = useState<string | null>(() => (initialOpen && isPanel(initialOpen) ? initialOpen
    : departures.length === 0 && rules.length === 0 ? "calendar" : null));
  // Optional fields opened from their chip stay shown while the review is open, even while still empty.
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set(initialOpen ? [initialOpen] : []));
  const [showAll, setShowAll] = useState(false);
  const [focus, setFocus] = useState<{ target: string; field?: string; center: boolean; at: number } | null>(null);
  useEffect(() => {
    if (!focus) return;
    const frame = window.requestAnimationFrame(() => revealTarget(rootRef.current, focus.target, focus.field, focus.center));
    return () => window.cancelAnimationFrame(frame);
  }, [focus]);
  const show = { all: showAll, revealed };
  const go = (target: string, field?: string, center = true) => {
    setFocus({ target, field, center, at: Date.now() });
  };
  const openPart = (part: string | null, field?: string, center = false) => {
    setOpen(part);
    if (part) go(part, field, center);
  };
  const reveal = (key: OptionalKey) => {
    setRevealed((current) => new Set([...current, key]));
    if (key === "hotel" || key === "profiles") setOpen(key);
    go(key, undefined, false);
  };
  const goProblem = (problem: ReviewProblem) => {
    if (!problem.target) return;
    if (isPanel(problem.target)) setOpen(problem.target);
    go(problem.target, problem.field, true);
  };

  // A day taken off the calendar loses its seat state: added back later, it starts open.
  const setCalendar = (next: string[]) => {
    const kept = new Set(next);
    const cleared = Object.keys(states).filter((day) => !kept.has(day)).reduce((acc, day) => setDayState(acc, day, null), withCalendarDays(fields, next));
    onChange(cleared);
  };
  const calendarOpen = open === "calendar";
  const ageView = splitOptional(fields, ["ages"], show);
  const programTitle = `Өдөр тутмын хөтөлбөр · ${itinerary.length} өдөр`;

  return (
    // While it saves the review is read-only: an edit made then would not be in what is being saved.
    <fieldset ref={rootRef} disabled={disabled} className="m-0 min-w-0 space-y-7 border-0 px-4 py-5 text-[15px] sm:px-8 sm:py-6">
      <ReviewProblemsBar problems={problems} onGo={goProblem} showAll={showAll} onShowAll={setShowAll} onOpenEditor={onOpenEditor} disabled={disabled} />

      <ReviewHero fields={fields} onChange={onChange} open={open} onOpen={(panel: HeroPanel | null) => openPart(panel)}
        onReveal={reveal} show={show} disabled={disabled} />

      <ReviewSection target="dates" title="Гарах өдөр ба үнэ" meta={departures.length + rules.length ? `· ${departures.length + rules.length} гарах өдөр` : undefined}
        action={(
          <button type="button" aria-expanded={calendarOpen} onClick={() => openPart(calendarOpen ? null : "calendar")}
            className={cx("inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors",
              calendarOpen ? "border-brand bg-brand-soft text-brand" : "border-line-strong bg-surface text-ink hover:border-brand")}>
            <Icons.calendar size={15} /> Огноо нэмэх, хасах
          </button>
        )}>
        {check.kind === "shift" && (
          <Notice className="mb-3 mt-0">
            Файлд <b>{formatYmd(check.departure)}</b> нь хөтөлбөрийн эхний өдөр (хил дээр). Улаанбаатараас галт тэрэг өмнөх орой нь хөдөлдөг.
            <span className="mt-2 flex flex-wrap gap-2">
              <button type="button" disabled={disabled} onClick={() => onChange(shiftDepartureDay(fields, check.departure, check.suggested))} className={primarySmall}>
                {formatYmd(check.suggested)}-нд Улаанбаатараас гарна
              </button>
              <button type="button" disabled={disabled} onClick={() => onChange({ ...fields, extra: { ...extra, itinerary_days: itinerary.map((day) => ({ ...day, date: "" })) } })} className={secondarySmall}>
                {formatYmd(check.departure)} хэвээр
              </button>
            </span>
          </Notice>
        )}
        {check.kind === "conflict" && (
          <Notice className="mb-3 mt-0">Гарах өдөр {formatYmd(check.departure)} боловч файлд хөтөлбөрийн эхний өдрийг {formatYmd(check.programStart)} гэж бичсэн ({formatYmd(check.expected)} байх ёстой). Аль нь зөвийг шалгаад календариас засна уу.</Notice>
        )}
        {calendarOpen && (
          <EditPanel target="calendar" title="Гарах өдрүүд" onClose={() => setOpen(null)} className="mb-4 mt-0">
            <MultiDateCalendar selected={departures} tripDays={itinerary.length || undefined} disabled={disabled} onChange={setCalendar}
              states={states} onStateChange={(day, next) => onChange(setDayState(fields, day, next))} />
            {rules.length > 0 && <p className="mt-3 text-[13px] leading-5 text-ink-muted">Файлд бичсэн хуваарь: <span className="font-medium text-ink">{rules.join(", ")}</span></p>}
            {check.kind === "consistent" && (
              <p className="mt-3 flex items-center gap-1.5 text-[13px] text-success"><Icons.check size={13} /> Файлын өдрүүдтэй таарч байна: хөтөлбөрийн эхний өдөр {formatYmd(check.programStart)}.</p>
            )}
            {check.kind === "unknown" && added > 0 && departures.length > 0 && (
              <p className="mt-3 text-[13px] leading-5 text-ink-muted">Сонгосон өдөр бол Улаанбаатараас галт тэрэг хөдлөх өдөр. Хөтөлбөрийн дараагийн өдөр ({formatYmd(addDaysYmd(departures[0], 1))}) хил давна.</p>
            )}
            {dateIssue && (
              <p className="mt-3 flex items-start gap-2 text-[13px] font-medium leading-5 text-danger" role="status"><Icons.alert size={14} className="mt-0.5 shrink-0" />{dateIssue.text}{dateIssue.blocks === "publish" ? " Ноорог болгон хадгалж болно." : ""}</p>
            )}
            <Evidence quote={evidence.departure} />
          </EditPanel>
        )}
        <PriceSection fields={fields} onChange={onChange} showAll={showAll}
          openCard={open?.startsWith("card:") ? open.slice(5) : null}
          onOpenCard={(key, field) => (key ? openPart(`card:${key}`, field) : setOpen(null))}
          extraChips={ageView.chips} onExtraChip={() => reveal("ages")}
          below={ageView.shown.length > 0 && (
            <div data-review-target="ages" className="mt-4 scroll-mt-24">
              <p className="text-[13px] font-semibold text-ink-muted">Насны ангилал <span className="font-normal">· дээрх бүх үнэнд адил хамаарна</span></p>
              <div className="mt-1 grid gap-x-4 sm:grid-cols-3">
                {AGES.map(([key, label, placeholder]) => (
                  <label key={key} className="flex min-w-0 items-center gap-1 text-[15px]">
                    <span className="shrink-0 text-ink-muted">{label}</span>
                    <GhostInput value={text(ages[key])} disabled={disabled} placeholder={placeholder} aria-label={`${label}: нас`}
                      onChange={(e) => setExtra({ age_rules: { ...ages, [key]: e.target.value } })} />
                  </label>
                ))}
              </div>
            </div>
          )} />
      </ReviewSection>

      <div data-review-target="program" className="scroll-mt-24">
        <ItineraryTimeline
          days={itinerary.map((day, index) => ({ ...day, day: day.day ?? index + 1, title: day.title || "", description: day.description || "" }))}
          locked={isTransitDay}
          showSourceDates
          showMealNotes
          size="section"
          title={programTitle}
          photoNote="Энэ өдрийн зураг. Дээрх зургууд дээр дарж хасах эсвэл нүүр болгоно."
          onChange={(days) => onChange(setProgramDays(fields, days))}
        />
        {boundaryIssue && (
          <p className="mt-3 flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft/60 px-4 py-3 text-sm leading-6 text-danger" role="status">
            <Icons.alert size={15} className="mt-1 shrink-0" />{boundaryIssue.text}
          </p>
        )}
        <Evidence quote={evidence.meals} />
      </div>

      <IncludedSection fields={fields} onChange={onChange} onReveal={reveal} show={show} disabled={disabled} />
      <HotelsSection fields={fields} onChange={onChange} onReveal={reveal} show={show} disabled={disabled}
        open={open === "profiles"} onOpen={(next) => setOpen(next ? "profiles" : null)} />
      <ConditionsSection fields={fields} onChange={onChange} onReveal={reveal} show={show} disabled={disabled} />
    </fieldset>
  );
}
