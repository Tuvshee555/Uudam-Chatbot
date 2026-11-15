/**
 * The trip editor as a workspace: a header with the trip's name, status and the
 * one save action; a section list at the left; one section at a time in a wide
 * column. Completeness is a quiet count in the header that opens a list which
 * jumps to each missing field. Unsaved work is tracked and never dropped
 * silently. The data model and the save request are the ones admin.tsx already
 * had; this file only decides what the admin sees.
 */
import React from "react";
import { Button, Icons, Modal, cx } from "@/components/ui";
import { getPosterBrochureHref } from "@/lib/poster/pdfUrl";
import { blockingGaps, documentedFreeFare, findTripGaps, type TripGap } from "@/lib/tripCompleteness";
import { deriveChildRules } from "@/lib/priceGroups";
import type { AnswerHint, BookingTerms, DiscountGroup, ExtraFee, ItineraryDay, PriceGroup, RoomPrice, SourceProvenance, TravelTrip } from "@/lib/adminTypes";
import { SelectInput } from "./parts";
import { BasicsSection, ItinerarySection, MediaSection, PricingSection, SettingsSection, TermsSection, WebsiteSection } from "./sections";

export type TripDraftState = Record<string, string>;

export type TripEditorProps = {
  open: boolean;
  isNewTrip: boolean;
  editingTrip: TravelTrip | null;
  tripDraft: TripDraftState;
  setTripDraft: (updater: (prev: TripDraftState) => TripDraftState) => void;
  tripPhotoUrls: string[];
  setTripPhotoUrls: React.Dispatch<React.SetStateAction<string[]>>;
  tripPhotoInput: string;
  setTripPhotoInput: (v: string) => void;
  photoDragging: boolean;
  setPhotoDragging: (v: boolean) => void;
  photoUploading: string[];
  photoFileInputRef: React.RefObject<HTMLInputElement | null>;
  saveDisabled?: boolean;
  busyKey: string;
  handlePhotoFiles: (files: FileList | File[]) => void;
  apiFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  onClose: () => void;
  /** confirmIncomplete is true when the admin accepted saving with required fields empty. */
  onSave: (confirmIncomplete?: boolean) => void;
  tripAliases: string[];
  setTripAliases: React.Dispatch<React.SetStateAction<string[]>>;
  tripPriceGroups: PriceGroup[];
  setTripPriceGroups: React.Dispatch<React.SetStateAction<PriceGroup[]>>;
  tripDiscounts: DiscountGroup[];
  setTripDiscounts: React.Dispatch<React.SetStateAction<DiscountGroup[]>>;
  tripExtraFees: ExtraFee[];
  setTripExtraFees: React.Dispatch<React.SetStateAction<ExtraFee[]>>;
  tripDepartureRule: string;
  setTripDepartureRule: React.Dispatch<React.SetStateAction<string>>;
  tripIncludedItems: string[];
  setTripIncludedItems: React.Dispatch<React.SetStateAction<string[]>>;
  tripExcludedItems: string[];
  setTripExcludedItems: React.Dispatch<React.SetStateAction<string[]>>;
  tripRoomPrices: RoomPrice[];
  setTripRoomPrices: React.Dispatch<React.SetStateAction<RoomPrice[]>>;
  tripItineraryDays: ItineraryDay[];
  setTripItineraryDays: React.Dispatch<React.SetStateAction<ItineraryDay[]>>;
  tripImportantNotes: string[];
  setTripImportantNotes: React.Dispatch<React.SetStateAction<string[]>>;
  tripBookingTerms: BookingTerms;
  setTripBookingTerms: React.Dispatch<React.SetStateAction<BookingTerms>>;
  tripCustomerVisible: boolean;
  setTripCustomerVisible: React.Dispatch<React.SetStateAction<boolean>>;
  tripNeedsHumanReview: boolean;
  setTripNeedsHumanReview: React.Dispatch<React.SetStateAction<boolean>>;
  tripReviewReasons: string[];
  setTripReviewReasons: React.Dispatch<React.SetStateAction<string[]>>;
  tripSourceProvenance: SourceProvenance[];
  tripAnswerHints: AnswerHint[];
  setTripAnswerHints: React.Dispatch<React.SetStateAction<AnswerHint[]>>;
  /** Jumps to the AI туслах tab with this trip named; not offered for an unsaved trip. */
  onAskAi?: (tripName: string) => void;
  /**
   * The editor is open on a trip read from a file and not saved yet: its save hands
   * the fields back to the AI review, which saves the trip as a draft or published.
   */
  draftMode?: boolean;
  /** Changes for each trip opened in draft mode, so unsaved-work tracking starts afresh. */
  draftKey?: number;
};

type SectionKey = "basics" | "pricing" | "itinerary" | "media" | "terms" | "website" | "settings";

const SECTIONS: Array<{ key: SectionKey; label: string; summary: string; gapKeys: string[] }> = [
  { key: "basics", label: "Үндсэн", summary: "Нэр, хугацаа, тайлбар", gapKeys: ["route_name", "duration_text", "route_name_date"] },
  { key: "pricing", label: "Үнэ ба гаралт", summary: "Үнэ, гарах өдөр, хямдрал", gapKeys: ["adult_price", "child_price", "infant_price", "departure_dates"] },
  { key: "itinerary", label: "Хөтөлбөр", summary: "Өдөр бүрийн хөтөлбөр", gapKeys: ["itinerary_days"] },
  { key: "media", label: "Зураг, бичлэг", summary: "Зураг, бичлэг, брошур", gapKeys: ["photo_urls", "brochure"] },
  { key: "terms", label: "Нөхцөл", summary: "Багтсан зүйл, захиалга", gapKeys: [] },
  { key: "website", label: "Вэбсайт", summary: "Вэбсайтын нэмэлт мэдээлэл", gapKeys: [] },
  { key: "settings", label: "Тохиргоо", summary: "Бот, шалгалт, заавар", gapKeys: [] },
];

const STATUS_OPTIONS: Array<{ value: string; label: string; hint: string }> = [
  { value: "active", label: "Идэвхтэй", hint: "Бот болон вэбсайт дээр харагдана." },
  { value: "sold_out", label: "Суудал дүүрсэн", hint: "Вэбсайт дээр «Суудал дүүрсэн» гэж харагдана." },
  { value: "paused", label: "Түр зогссон", hint: "Түр нуугдана." },
  { value: "draft", label: "Ноорог", hint: "Хэрэглэгчид харагдахгүй." },
  { value: "cancelled", label: "Цуцлагдсан", hint: "Хэрэглэгчид харагдахгүй." },
  { value: "archived", label: "Архив", hint: "Хэрэглэгчид харагдахгүй." },
];

function parseMoneyDraft(value: string | undefined): number | null {
  const digits = (value || "").replace(/[^\d]/g, "");
  return digits ? Number(digits) : null;
}
function splitDraftList(value: string | undefined): string[] {
  return (value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

/** Everything the admin can change, as one string, to tell "unsaved" from "unchanged". */
function serialize(p: TripEditorProps): string {
  return JSON.stringify([
    p.tripDraft, p.tripPhotoUrls, p.tripAliases, p.tripPriceGroups, p.tripDiscounts, p.tripExtraFees, p.tripDepartureRule,
    p.tripIncludedItems, p.tripExcludedItems, p.tripRoomPrices, p.tripItineraryDays, p.tripImportantNotes, p.tripBookingTerms,
    p.tripCustomerVisible, p.tripNeedsHumanReview, p.tripReviewReasons, p.tripAnswerHints,
  ]);
}

export function TripEditor(props: TripEditorProps) {
  const { open, isNewTrip, editingTrip, tripDraft, setTripDraft, onClose, onSave, busyKey, saveDisabled = false } = props;
  const [section, setSection] = React.useState<SectionKey>("basics");
  const [attempted, setAttempted] = React.useState(false);
  const [confirmingIncomplete, setConfirmingIncomplete] = React.useState(false);
  const [closing, setClosing] = React.useState(false);
  const [gapsOpen, setGapsOpen] = React.useState(false);
  const [websiteMediaUploading, setWebsiteMediaUploading] = React.useState(false);
  const [saveAsDraftPending, setSaveAsDraftPending] = React.useState(false);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const gapsRef = React.useRef<HTMLDivElement>(null);

  const draftMode = Boolean(props.draftMode);
  const openKey = open ? (draftMode ? `draft-${props.draftKey ?? 0}` : `${isNewTrip ? "new" : editingTrip?.id ?? ""}`) : "";
  const saveLabel = draftMode ? "Шалгалт руу буцах" : isNewTrip ? "Аялал үүсгэх" : "Хадгалах";
  const current = serialize(props);
  // The state as it was when this trip opened; anything different is unsaved work.
  const [baseline, setBaseline] = React.useState<{ key: string; json: string }>({ key: "", json: "" });
  React.useEffect(() => {
    if (baseline.key !== openKey) setBaseline({ key: openKey, json: current });
  }, [openKey, baseline.key, current]);
  const dirty = open && baseline.key === openKey && baseline.json !== current;

  React.useEffect(() => {
    if (!open) return;
    setSection("basics");
    setAttempted(false);
    setConfirmingIncomplete(false);
    setClosing(false);
    setGapsOpen(false);
    contentRef.current?.scrollTo({ top: 0 });
  }, [open, openKey]);

  const editingExtra = (editingTrip?.extra || {}) as Record<string, unknown>;
  const isPosterLinked = typeof editingExtra.poster_trip_id === "string";
  const brochurePdfUrl = getPosterBrochureHref(editingExtra);
  const liveChildRulesExtra = {
    child_rules: deriveChildRules(props.tripPriceGroups, {
      child: tripDraft.child_price_free === "true",
      infant: tripDraft.infant_price_free === "true",
    }),
  };
  const gaps: TripGap[] = findTripGaps({
    route_name: tripDraft.route_name,
    duration_text: tripDraft.duration_text,
    adult_price: parseMoneyDraft(tripDraft.adult_price),
    child_price: parseMoneyDraft(tripDraft.child_price),
    infant_price: parseMoneyDraft(tripDraft.infant_price),
    infant_fare_free: documentedFreeFare(liveChildRulesExtra, "infant"),
    child_fare_free: documentedFreeFare(liveChildRulesExtra, "child"),
    departure_dates: splitDraftList(tripDraft.departure_dates),
    photo_urls: props.tripPhotoUrls,
    itinerary_days: props.tripItineraryDays,
    has_brochure: Boolean(brochurePdfUrl),
    poster_photo_count: typeof editingExtra.poster_photo_count === "number" ? editingExtra.poster_photo_count : 0,
  });
  const blocking = blockingGaps(gaps);
  const warnings = gaps.filter((gap) => gap.severity === "warning");
  const blockingKeys = new Set(blocking.map((gap) => gap.key));
  const missing = (key: string) => attempted && blockingKeys.has(key);

  React.useEffect(() => {
    if (blocking.length === 0) setConfirmingIncomplete(false);
  }, [blocking.length]);

  // A save requested as "draft" waits for the status change to reach the draft state.
  React.useEffect(() => {
    if (!saveAsDraftPending) return;
    if (tripDraft.status !== "draft") return;
    setSaveAsDraftPending(false);
    onSave(true);
  }, [saveAsDraftPending, tripDraft.status, onSave]);

  // Unsaved work survives an accidental reload prompt and an accidental Escape.
  React.useEffect(() => {
    if (!open || !dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [open, dirty]);

  React.useEffect(() => {
    if (!gapsOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !gapsRef.current?.contains(event.target)) setGapsOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [gapsOpen]);

  const saving = busyKey === "save-trip";
  const locked = saveDisabled || websiteMediaUploading;

  function requestClose() {
    if (locked && websiteMediaUploading) return;
    if (dirty) setClosing(true);
    else onClose();
  }
  function handleSave() {
    // Nothing is saved from here in draft mode: the review checks the trip and saves it.
    if (draftMode) { onSave(true); return; }
    setAttempted(true);
    if (blocking.length > 0 && !confirmingIncomplete) {
      setConfirmingIncomplete(true);
      jumpTo(blocking[0].key, false);
      return;
    }
    onSave();
  }
  function saveAsDraft() {
    if (tripDraft.status === "draft") { onSave(true); return; }
    setTripDraft((d) => ({ ...d, status: "draft" }));
    setSaveAsDraftPending(true);
  }
  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || closing) return;
      if (gapsOpen) { setGapsOpen(false); return; }
      event.preventDefault();
      if (websiteMediaUploading) return;
      if (dirty) setClosing(true);
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, closing, gapsOpen, dirty, websiteMediaUploading, onClose]);

  function sectionOf(gapKey: string): SectionKey {
    return SECTIONS.find((entry) => entry.gapKeys.includes(gapKey))?.key ?? "basics";
  }
  function jumpTo(gapKey: string, focus = true) {
    setGapsOpen(false);
    setSection(sectionOf(gapKey));
    window.setTimeout(() => {
      const target = contentRef.current?.querySelector<HTMLElement>(`[data-trip-field="${gapKey}"]`);
      if (!target) return;
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      if (focus) target.querySelector<HTMLElement>("input, textarea, select, button")?.focus({ preventScroll: true });
    }, 60);
  }

  if (!open) return null;

  const title = tripDraft.route_name.trim() || (isNewTrip ? "Шинэ аялал" : editingTrip?.route_name || "Аялал");
  const status = STATUS_OPTIONS.find((option) => option.value === tripDraft.status) ?? STATUS_OPTIONS[0];
  const sectionIndex = SECTIONS.findIndex((entry) => entry.key === section);
  const prev = SECTIONS[sectionIndex - 1];
  const next = SECTIONS[sectionIndex + 1];
  const sectionState = (entry: typeof SECTIONS[number]) =>
    entry.gapKeys.some((key) => blockingKeys.has(key)) ? "missing" : entry.gapKeys.some((key) => warnings.some((gap) => gap.key === key)) ? "warning" : "ok";

  const sectionProps = { ...props, missing, brochurePdfUrl, isPosterLinked, onWebsiteMediaBusy: setWebsiteMediaUploading };
  const nav = (
    <nav aria-label="Аяллын хэсгүүд">
      <ul className="flex gap-1 overflow-x-auto px-3 py-2 lg:flex-col lg:gap-0.5 lg:px-3 lg:py-4">
        {SECTIONS.map((entry) => {
          const active = entry.key === section;
          const state = sectionState(entry);
          return (
            <li key={entry.key} className="shrink-0">
              <button
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={() => setSection(entry.key)}
                className={cx(
                  "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors",
                  active ? "bg-brand-soft font-semibold text-brand" : "text-ink-muted hover:bg-surface-sunken hover:text-ink",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{entry.label}</span>
                  <span className={cx("hidden truncate text-[11px] font-normal lg:block", active ? "text-brand/80" : "text-ink-subtle")}>{entry.summary}</span>
                </span>
                {state === "missing" && <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", attempted ? "bg-warning" : "bg-ink-subtle/60")} aria-label="Заавал талбар дутуу" />}
                {state === "ok" && entry.gapKeys.length > 0 && <Icons.check size={13} className="shrink-0 text-success" aria-label="Бүрэн" />}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-canvas" role="dialog" aria-modal="true" aria-label={isNewTrip ? "Шинэ аялал нэмэх" : `Аялал засах: ${title}`}>
      {/* ------------------------------------------------------------ header */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 sm:px-4">
        <button type="button" onClick={requestClose} aria-label="Аяллын жагсаалт руу буцах" title="Буцах (Esc)" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink">
          <Icons.chevronLeft size={18} />
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">{draftMode ? "Файлаас уншсан аялал · хадгалаагүй" : isNewTrip ? "Шинэ аялал" : "Аялал засах"}</p>
          <h1 className="truncate text-sm font-semibold leading-5 text-ink sm:text-[15px]">{title}</h1>
        </div>

        <div className="hidden items-center gap-2 md:flex">
          <label className="sr-only" htmlFor="trip-status">Төлөв</label>
          {!draftMode && (
            <SelectInput id="trip-status" value={tripDraft.status} onChange={(e) => setTripDraft((d) => ({ ...d, status: e.target.value }))} className="h-9 w-44 text-[13px]" title={status.hint}>
              {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </SelectInput>
          )}

          <div ref={gapsRef} className="relative">
            <button
              type="button"
              onClick={() => setGapsOpen((v) => !v)}
              aria-expanded={gapsOpen}
              className={cx(
                "flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-[13px] font-medium transition-colors",
                blocking.length === 0 ? "text-success hover:bg-success-soft" : attempted ? "text-warning hover:bg-warning-soft" : "text-ink-muted hover:bg-surface-sunken",
              )}
            >
              {blocking.length === 0 ? <Icons.check size={14} /> : <span className={cx("h-2 w-2 rounded-full", attempted ? "bg-warning" : "bg-ink-subtle")} aria-hidden="true" />}
              {blocking.length === 0 ? "Бүрэн" : `${blocking.length} заавал дутуу`}
              {warnings.length > 0 && blocking.length === 0 && <span className="text-ink-subtle">· {warnings.length} зөвлөмж</span>}
            </button>
            {gapsOpen && (
              <div className="animate-scale-in absolute right-0 top-full z-10 mt-1.5 w-80 origin-top-right rounded-lg border border-line bg-surface p-1.5 shadow-md">
                {blocking.length > 0 && <p className="px-2.5 pt-1.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">Заавал</p>}
                {blocking.map((gap) => (
                  <button key={gap.key} type="button" onClick={() => jumpTo(gap.key)} className="flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left text-sm text-ink hover:bg-brand-soft">
                    <span className="min-w-0 truncate">{gap.label}</span>
                    <span className="shrink-0 text-xs text-ink-subtle">{gap.where}</span>
                  </button>
                ))}
                {warnings.length > 0 && <p className="px-2.5 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">Зөвлөмж</p>}
                {warnings.map((gap) => (
                  <button key={gap.key} type="button" onClick={() => jumpTo(gap.key)} className="flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left text-sm text-ink-muted hover:bg-surface-sunken">
                    <span className="min-w-0 truncate">{gap.label}</span>
                    <span className="shrink-0 text-xs text-ink-subtle">{gap.where}</span>
                  </button>
                ))}
                {gaps.length === 0 && <p className="px-2.5 py-3 text-sm text-ink-muted">Бүх мэдээлэл бүрэн байна.</p>}
                {!isNewTrip && props.onAskAi && tripDraft.route_name && blocking.length > 0 && (
                  <button type="button" onClick={() => props.onAskAi?.(tripDraft.route_name)} className="mt-1 flex w-full items-center gap-2 rounded-md border-t border-line px-2.5 py-2.5 text-left text-sm font-medium text-brand hover:bg-brand-soft">
                    <Icons.bot size={14} /> AI туслахаар бөглүүлэх
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className={cx("hidden text-xs sm:inline", dirty ? "text-warning" : "text-ink-subtle")} role="status">
            {saving ? "Хадгалж байна…" : draftMode ? (dirty ? "Засвар хийгдсэн" : "") : dirty ? "Хадгалаагүй өөрчлөлт" : isNewTrip ? "" : "Өөрчлөлт алга"}
          </span>
          <Button variant="ghost" size="sm" disabled={websiteMediaUploading} onClick={requestClose}>Болих</Button>
          <Button size="sm" disabled={locked} loading={saving} onClick={handleSave}>
            <Icons.check size={15} />
            {saveLabel}
          </Button>
        </div>
      </header>

      {/* ----------------------------------------- calm incomplete-save bar */}
      {confirmingIncomplete && blocking.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-warning/30 bg-warning-soft px-4 py-2.5 text-sm text-ink sm:px-6" role="alert">
          <p className="min-w-0 flex-1">
            <span className="font-semibold text-warning">{blocking.length} заавал талбар дутуу:</span>{" "}
            {blocking.map((gap, i) => (
              <React.Fragment key={gap.key}>
                {i > 0 && ", "}
                <button type="button" onClick={() => jumpTo(gap.key)} className="rounded font-medium underline decoration-warning/40 underline-offset-2 hover:decoration-warning">{gap.label}</button>
              </React.Fragment>
            ))}
            . Дутуугаар хадгалбал бот энэ мэдээллийг хэрэглэгчид хэлж чадахгүй.
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => setConfirmingIncomplete(false)}>Бөглөнө</Button>
            {tripDraft.status !== "draft" && <Button size="sm" variant="secondary" disabled={locked} loading={saving} onClick={saveAsDraft}>Ноорог болгож хадгалах</Button>}
            <Button size="sm" variant="primary" disabled={locked} loading={saving} onClick={() => onSave(true)}>Дутуугаар хадгалах</Button>
          </div>
        </div>
      )}

      {/* --------------------------------------------------------- workspace */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="shrink-0 border-b border-line bg-surface lg:w-60 lg:border-b-0 lg:border-r">
          {nav}
          <div className="hidden border-t border-line px-6 py-4 lg:block">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">Төлөв</p>
            <p className="mt-1 text-sm font-medium text-ink">{status.label}</p>
            <p className="text-xs leading-5 text-ink-muted">{status.hint}</p>
          </div>
        </aside>

        <div ref={contentRef} className="scroll-area min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-8 sm:py-8">
            <div className={cx("mb-6 md:hidden", draftMode && "hidden")}>
              <label htmlFor="trip-status-mobile" className="mb-1.5 block text-sm font-medium text-ink">Төлөв</label>
              <SelectInput id="trip-status-mobile" value={tripDraft.status} onChange={(e) => setTripDraft((d) => ({ ...d, status: e.target.value }))}>
                {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </SelectInput>
              {blocking.length > 0 && (
                <p className="mt-2 text-xs text-ink-muted">
                  {blocking.length} заавал талбар дутуу: {blocking.map((gap) => gap.label).join(", ")}.
                </p>
              )}
            </div>

            <div className="space-y-8">
              {section === "basics" && <BasicsSection {...sectionProps} />}
              {section === "pricing" && <PricingSection {...sectionProps} />}
              {section === "itinerary" && <ItinerarySection {...sectionProps} />}
              {section === "media" && <MediaSection {...sectionProps} />}
              {section === "terms" && <TermsSection {...sectionProps} />}
              {section === "website" && <WebsiteSection {...sectionProps} />}
              {section === "settings" && <SettingsSection {...sectionProps} />}
            </div>

            <div className="mt-10 flex items-center justify-between gap-3 border-t border-line pt-5">
              {prev ? (
                <button type="button" onClick={() => { setSection(prev.key); contentRef.current?.scrollTo({ top: 0 }); }} className="flex items-center gap-1.5 text-sm font-medium text-ink-muted hover:text-ink">
                  <Icons.chevronLeft size={15} /> {prev.label}
                </button>
              ) : <span />}
              {next ? (
                <button type="button" onClick={() => { setSection(next.key); contentRef.current?.scrollTo({ top: 0 }); }} className="flex items-center gap-1.5 text-sm font-medium text-brand hover:text-brand-hover">
                  Дараах: {next.label} <Icons.chevronRight size={15} />
                </button>
              ) : (
                <Button size="sm" disabled={locked} loading={saving} onClick={handleSave}><Icons.check size={15} />{saveLabel}</Button>
              )}
            </div>
          </div>
        </div>
      </div>

      <Modal
        open={closing}
        onClose={() => setClosing(false)}
        title="Хадгалаагүй өөрчлөлт байна"
        description="Хаавал энэ удаад хийсэн өөрчлөлт алдагдана."
        panelClassName="max-w-md"
        footer={
          <>
            <Button variant="secondary" onClick={() => setClosing(false)}>Үргэлжлүүлэн засах</Button>
            <Button variant="danger" onClick={() => { setClosing(false); onClose(); }}>Хаах, өөрчлөлтийг хаях</Button>
          </>
        }
      >
        <p className="text-sm text-ink-muted">Өөрчлөлтөө үлдээхийг хүсвэл буцаж очоод «{saveLabel}» дарна уу.</p>
      </Modal>
    </div>
  );
}
