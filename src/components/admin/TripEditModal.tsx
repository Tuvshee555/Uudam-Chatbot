import React from "react";
import { Button, DatePicker, Icons, Input, Modal, Select, Spinner, Textarea, cx } from "@/components/ui";
import { getPosterBrochureHref } from "@/lib/poster/pdfUrl";
import { blockingGaps, documentedFreeFare, findTripGaps, type TripGap } from "@/lib/tripCompleteness";
import { MAX_PHOTOS_PER_TRIP } from "@/lib/tripPhotoImport/types";
import { deriveChildRules } from "@/lib/priceGroups";
import { isInfantShapedAge } from "@/lib/travelFastPathsSearch";
import type { AnswerHint, BookingTerms, DiscountGroup, ExtraFee, ItineraryDay, PassengerPrice, PriceGroup, RoomPrice, SourceProvenance, TravelTrip } from "@/lib/adminTypes";

export type TripDraftState = Record<string, string>;

export type TripEditModalProps = {
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
  onClose: () => void;
  /** confirmIncomplete is true when the user accepted the missing-fields prompt. */
  onSave: (confirmIncomplete?: boolean) => void;
  // Structured fields
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
  // Metadata fields
  tripCustomerVisible: boolean;
  setTripCustomerVisible: React.Dispatch<React.SetStateAction<boolean>>;
  tripNeedsHumanReview: boolean;
  setTripNeedsHumanReview: React.Dispatch<React.SetStateAction<boolean>>;
  tripReviewReasons: string[];
  setTripReviewReasons: React.Dispatch<React.SetStateAction<string[]>>;
  tripSourceProvenance: SourceProvenance[];
  tripAnswerHints: AnswerHint[];
  setTripAnswerHints: React.Dispatch<React.SetStateAction<AnswerHint[]>>;
};

const inputCls = "w-full rounded-md border border-line-strong bg-surface px-3 py-1.5 text-sm text-ink transition-colors placeholder:text-ink-subtle focus:border-brand";
const numCls = inputCls;
const sectionHdr = "mt-5 text-sm font-semibold text-ink";
const rowCls = "flex items-start gap-1.5";
const delBtn = "shrink-0 rounded-md p-1 text-ink-muted transition-colors hover:bg-danger-soft hover:text-danger";

type TripEditorTab = "base" | "pricing" | "itinerary" | "advanced";

function emptyPassengerPrice(label = ""): PassengerPrice {
  return { label, age_range: "", price: null, currency: "MNT" };
}
function emptyPriceGroup(): PriceGroup {
  return { label: "", dates: [], display_dates: [], date_keys: [], adult_price: null, child_price: null, infant_price: null, child_age: "", infant_age: "", passenger_prices: [], note: "" };
}
function emptyDiscountGroup(): DiscountGroup {
  return { label: "", dates: [], display_dates: [], date_keys: [], adult_price: null, child_price: null, infant_price: null, condition: "", note: "" };
}
function emptyExtraFee(): ExtraFee {
  return { label: "", amount: null, currency: "MNT", applies_to: "", note: "" };
}
function emptyRoomPrice(): RoomPrice {
  return { room_type: "", price: null, currency: "MNT", note: "" };
}
function emptyItineraryDay(dayNumber: number): ItineraryDay {
  return { day: dayNumber, title: "", description: "", hotel: "", meals: { breakfast: false, lunch: false, dinner: false } };
}

function splitDepartureDraft(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinDepartureDraft(values: string[]): string {
  return values.join(", ");
}

/** Money inputs hold digit-only strings; departure dates a comma-separated line. */
function parseMoneyDraft(value: string | undefined): number | null {
  const digits = (value || "").replace(/[^\d]/g, "");
  return digits ? Number(digits) : null;
}

function splitDraftList(value: string | undefined): string[] {
  return (value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function GapWarning({ gaps, isNewTrip }: { gaps: TripGap[]; isNewTrip: boolean }) {
  const blocking = gaps.filter((gap) => gap.severity === "blocking");
  const warnings = gaps.filter((gap) => gap.severity === "warning");
  if (gaps.length === 0) {
    return (
      <div className="mb-4 flex items-center gap-2 rounded-lg border border-success/25 bg-success-soft px-3 py-2 text-sm text-success">
        <Icons.check size={16} className="shrink-0" />
        <span>Бүх мэдээлэл бүрэн байна.</span>
      </div>
    );
  }
  return (
    <div
      className={cx(
        "mb-4 rounded-lg border px-3.5 py-3",
        blocking.length > 0 ? "border-danger/30 bg-danger-soft" : "border-warning/30 bg-warning-soft",
      )}
    >
      <div className="flex items-start gap-2.5">
        <Icons.alert
          size={18}
          className={cx("mt-0.5 shrink-0", blocking.length > 0 ? "text-danger" : "text-warning")}
        />
        <div className="min-w-0">
          <p className={cx("text-sm font-bold", blocking.length > 0 ? "text-danger" : "text-warning")}>
            {blocking.length > 0
              ? `${blocking.length} заавал бөглөх талбар дутуу байна`
              : `${warnings.length} талбар дутуу байна`}
          </p>
          {blocking.length > 0 && (
            <p className="mt-0.5 text-xs text-ink-muted">
              {isNewTrip
                ? "Эдгээрийг бөглөхгүй бол шинэ аялал үүсгэхэд баталгаажуулалт шаардана."
                : "Эдгээрийг бөглөхгүй бол хадгалахад баталгаажуулалт шаардана."}{" "}
              Бот болон вебсайт энэ мэдээллийг хэрэглэгчид харуулна.
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {[...blocking, ...warnings].map((gap) => (
              <span
                key={gap.key}
                className={cx(
                  "rounded-md border px-2 py-1 text-xs font-medium",
                  gap.severity === "blocking"
                    ? "border-danger/30 bg-surface text-danger"
                    : "border-line bg-surface text-ink-muted",
                )}
              >
                {gap.label}
                <span className="ml-1 font-normal text-ink-subtle">· {gap.where}</span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function MoneyInput({
  label,
  value,
  onChange,
  missing,
  free,
  onFreeChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Reddens the box until a real amount is entered — a required field. */
  missing?: boolean;
  /** When provided, shows a "Үнэгүй" checkbox that disables the number box
   * instead of demanding a price — for a passenger type this trip genuinely
   * never charges (almost always the infant fare). */
  free?: boolean;
  onFreeChange?: (free: boolean) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-semibold text-ink">{label}</span>
      <span
        className={cx(
          "flex h-12 items-center rounded-md border bg-surface px-3 transition-colors focus-within:border-brand",
          missing ? "border-danger" : "border-line-strong",
        )}
      >
        <input
          inputMode="numeric"
          disabled={free}
          value={free ? "" : value}
          placeholder={free ? "Үнэгүй" : ""}
          onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, ""))}
          className="min-w-0 flex-1 bg-transparent text-sm tabular-nums text-ink outline-none placeholder:text-ink-subtle disabled:text-ink-subtle"
        />
        <span className="ml-2 rounded-[6px] bg-surface-sunken px-2 py-1 text-sm font-semibold text-ink-muted">
          ₮
        </span>
      </span>
      {missing && !free && <span className="mt-1 block text-xs font-medium text-danger">Заавал бөглөх</span>}
      {onFreeChange && (
        <span className="mt-1.5 flex items-center gap-1.5 text-xs text-ink-subtle">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 rounded border-line-strong accent-brand"
            checked={!!free}
            onChange={(e) => onFreeChange(e.target.checked)}
          />
          Үнэгүй
        </span>
      )}
    </label>
  );
}

function DepartureDateEditor({
  value,
  onChange,
  missing,
}: {
  value: string;
  onChange: (value: string) => void;
  missing?: boolean;
}) {
  const dates = splitDepartureDraft(value);
  const addFormattedDate = (formatted: string) => {
    if (!formatted || dates.includes(formatted)) return;
    onChange(joinDepartureDraft([...dates, formatted]));
  };
  const removeDate = (index: number) => {
    onChange(joinDepartureDraft(dates.filter((_, i) => i !== index)));
  };

  return (
    <div className="sm:col-span-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="sm:w-52">
          <DatePicker label="Гарах өдөр нэмэх" onSelect={(formatted) => addFormattedDate(formatted)} />
        </div>
        <label className="block min-w-0 flex-1">
          <span className="mb-1 block text-sm font-semibold text-ink">Гарах өдрүүд</span>
          <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="ж: 7 сарын 5, 7 сарын 12, Пүрэв гараг бүр"
            className={cx(inputCls, missing && "border-danger")}
          />
        </label>
      </div>
      <div
        className={cx(
          "mt-2 flex min-h-9 flex-wrap gap-1.5 rounded-lg border p-2",
          missing ? "border-danger/40 bg-danger-soft" : "border-line bg-surface-sunken",
        )}
      >
        {dates.length === 0 ? (
          <span className="px-1 py-1 text-xs font-medium text-danger">Заавал бөглөх — гарах өдөр дутуу</span>
        ) : (
          dates.map((date, index) => (
            <span
              key={`${date}-${index}`}
              className="inline-flex items-center gap-1 rounded-md border border-line-strong bg-surface px-2 py-1 text-xs font-semibold text-ink-muted"
            >
              {date}
              <button
                type="button"
                onClick={() => removeDate(index)}
                className="ml-0.5 flex h-4 w-4 items-center justify-center rounded-full text-ink-subtle hover:bg-danger-soft hover:text-danger"
                title="Огноо устгах"
                aria-label={`${date} устгах`}
              >
                ×
              </button>
            </span>
          ))
        )}
      </div>
    </div>
  );
}

/** Same date-chip pattern as DepartureDateEditor, but working on a plain
 * string[] (a price group's own dates) instead of a comma-draft string. */
function PriceGroupDateChips({
  dates,
  onChange,
}: {
  dates: string[];
  onChange: (dates: string[]) => void;
}) {
  const addDate = (formatted: string) => {
    if (!formatted || dates.includes(formatted)) return;
    onChange([...dates, formatted]);
  };
  const removeDate = (index: number) => onChange(dates.filter((_, i) => i !== index));

  return (
    <div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="sm:w-52">
          <DatePicker label="Огноо нэмэх" onSelect={(formatted) => addDate(formatted)} />
        </div>
      </div>
      <div className="mt-2 flex min-h-9 flex-wrap gap-1.5 rounded-lg border border-line bg-surface p-2">
        {dates.length === 0 ? (
          <span className="px-1 py-1 text-xs font-medium text-danger">Огноо сонгоогүй байна</span>
        ) : (
          dates.map((date, index) => (
            <span
              key={`${date}-${index}`}
              className="inline-flex items-center gap-1 rounded-md border border-line-strong bg-surface-sunken px-2 py-1 text-xs font-semibold text-ink-muted"
            >
              {date}
              <button
                type="button"
                onClick={() => removeDate(index)}
                className="ml-0.5 flex h-4 w-4 items-center justify-center rounded-full text-ink-subtle hover:bg-danger-soft hover:text-danger"
                title="Огноо устгах"
                aria-label={`${date} устгах`}
              >
                ×
              </button>
            </span>
          ))
        )}
      </div>
    </div>
  );
}

const FREE_FARE_NOTE = "Үнэгүй";
function isFreeFare(price: PassengerPrice) {
  return price.price === 0 && price.note === FREE_FARE_NOTE;
}

/** "2-11 нас" / "0-23 сар" / "12 сар" -> the picker's own numeric parts.
 * Infants are usually banded in months, children/adults in years — every
 * downstream reader (isInfantShapedAge and friends) tells the two apart by
 * checking for the literal substring "сар", so the unit must round-trip
 * exactly, never default silently to years. */
export function parseAgeRange(value: string): { min: string; max: string; unit: "сар" | "нас" } {
  const unit: "сар" | "нас" = /сар/i.test(value) ? "сар" : "нас";
  const range = value.match(/(\d{1,3})\s*[-–—]\s*(\d{1,3})/);
  if (range) return { min: range[1], max: range[2], unit };
  const single = value.match(/(\d{1,3})/);
  return { min: single?.[1] ?? "", max: "", unit };
}

export function formatAgeRange(min: string, max: string, unit: "сар" | "нас"): string {
  if (!min && !max) return "";
  if (min && max) return `${min}-${max} ${unit}`;
  return `${min || max} ${unit}`;
}

/** Pick an age band instead of typing it freeform — a min/max number and a
 * unit toggle (months for infants, years for children), so a mistyped "нас"
 * can never silently stand in for "сар" the way free text let it. */
function AgeRangePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { min, max, unit } = parseAgeRange(value);
  const setPart = (next: Partial<{ min: string; max: string; unit: "сар" | "нас" }>) => {
    const merged = { min, max, unit, ...next };
    onChange(formatAgeRange(merged.min, merged.max, merged.unit));
  };
  return (
    <div className="flex items-stretch gap-1">
      <input
        className={cx(inputCls, "w-14 text-center")}
        inputMode="numeric"
        value={min}
        placeholder="0"
        onChange={(e) => setPart({ min: e.target.value.replace(/[^\d]/g, "") })}
      />
      <span className="flex items-center text-ink-subtle">–</span>
      <input
        className={cx(inputCls, "w-14 text-center")}
        inputMode="numeric"
        value={max}
        placeholder="23"
        onChange={(e) => setPart({ max: e.target.value.replace(/[^\d]/g, "") })}
      />
      <select
        className={cx(inputCls, "w-20")}
        value={unit}
        onChange={(e) => setPart({ unit: e.target.value as "сар" | "нас" })}
      >
        <option value="сар">сар</option>
        <option value="нас">нас</option>
      </select>
    </div>
  );
}

/** One editable price band for a non-adult passenger type (child, infant, or
 * any other age tier the trip needs) — label, age range, price, and a Free
 * toggle. Adult stays its own single required field above this list since a
 * trip never has more than one adult fare per date group. */
function PassengerBandRow({
  price,
  onChange,
  onRemove,
}: {
  price: PassengerPrice;
  onChange: (next: PassengerPrice) => void;
  onRemove: () => void;
}) {
  const free = isFreeFare(price);
  return (
    <div className="grid gap-2 rounded-lg border border-line bg-surface p-2.5 sm:grid-cols-[1.2fr_1fr_1fr_auto]">
      <div>
        <label className="mb-0.5 block text-xs text-ink-muted">Ангилал</label>
        <input
          className={inputCls}
          value={price.label}
          placeholder="ж: Хүүхэд, Нярай"
          onChange={(e) => onChange({ ...price, label: e.target.value })}
        />
      </div>
      <div>
        <label className="mb-0.5 block text-xs text-ink-muted">Нас</label>
        <AgeRangePicker
          value={price.age_range}
          onChange={(age_range) => onChange({ ...price, age_range })}
        />
      </div>
      <div>
        <label className="mb-0.5 block text-xs text-ink-muted">Үнэ</label>
        <input
          className={numCls}
          inputMode="numeric"
          disabled={free}
          value={free ? "" : price.price ?? ""}
          placeholder={free ? "Үнэгүй" : ""}
          onChange={(e) => {
            const digits = e.target.value.replace(/[^\d]/g, "");
            onChange({ ...price, price: digits === "" ? null : Number(digits), note: "" });
          }}
        />
        <label className="mt-1 flex items-center gap-1.5 text-xs text-ink-subtle">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 rounded border-line-strong accent-brand"
            checked={free}
            onChange={(e) => onChange(e.target.checked
              ? { ...price, price: 0, note: FREE_FARE_NOTE }
              : { ...price, price: null, note: "" })}
          />
          Үнэгүй
        </label>
      </div>
      <div className="flex items-start justify-end pt-5">
        <button type="button" className={delBtn} onClick={onRemove} title="Устгах">
          <Icons.trash size={13} />
        </button>
      </div>
    </div>
  );
}

function EditorTabButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
        active
          ? "border-brand bg-brand text-white"
          : "border-line-strong bg-surface text-ink-muted hover:border-brand hover:text-ink",
      )}
    >
      {label}
    </button>
  );
}

export function TripEditModal({
  open,
  isNewTrip,
  editingTrip,
  tripDraft,
  setTripDraft,
  tripPhotoUrls,
  setTripPhotoUrls,
  tripPhotoInput,
  setTripPhotoInput,
  photoDragging,
  setPhotoDragging,
  photoUploading,
  photoFileInputRef,
  saveDisabled = false,
  busyKey,
  handlePhotoFiles,
  onClose,
  onSave,
  tripAliases,
  setTripAliases,
  tripPriceGroups,
  setTripPriceGroups,
  tripDiscounts,
  setTripDiscounts,
  tripExtraFees,
  setTripExtraFees,
  tripDepartureRule,
  setTripDepartureRule,
  tripIncludedItems,
  setTripIncludedItems,
  tripExcludedItems,
  setTripExcludedItems,
  tripRoomPrices,
  setTripRoomPrices,
  tripItineraryDays,
  setTripItineraryDays,
  tripImportantNotes,
  setTripImportantNotes,
  tripBookingTerms,
  setTripBookingTerms,
  tripCustomerVisible,
  setTripCustomerVisible,
  tripNeedsHumanReview,
  setTripNeedsHumanReview,
  tripReviewReasons,
  setTripReviewReasons,
  tripSourceProvenance,
  tripAnswerHints,
  setTripAnswerHints,
}: TripEditModalProps) {
  const [activeTab, setActiveTab] = React.useState<TripEditorTab>("base");
  const [confirmingIncomplete, setConfirmingIncomplete] = React.useState(false);

  React.useEffect(() => {
    if (open) setActiveTab("base");
  }, [open, editingTrip?.id, isNewTrip]);

  const editingExtra = (editingTrip?.extra || {}) as Record<string, unknown>;
  const isPosterLinked = typeof editingExtra.poster_trip_id === "string";
  const linkedPosterId = isPosterLinked ? String(editingExtra.poster_trip_id) : "";
  const linkedSourceFile = typeof editingExtra.source_file_name === "string" ? editingExtra.source_file_name : "";
  const originalPosterTitle = typeof editingExtra.original_title_text === "string" ? editingExtra.original_title_text : "";
  const brochurePdfUrl = getPosterBrochureHref(editingExtra);

  // Checked against what is on screen right now, not the saved trip, so filling
  // a field clears its warning before saving. child_rules only exists on the
  // SAVED trip (it's derived from price groups at save time — see
  // deriveChildRules in priceGroups.ts) so re-derive it from the live,
  // on-screen price groups here too, otherwise marking infant/child free in
  // this same modal would still show as a missing-data gap until reopened.
  // Free can also be declared on the base tab's flat price (no date groups
  // at all yet) — either source counts as documented.
  const liveChildRulesExtra = {
    child_rules: deriveChildRules(tripPriceGroups, {
      child: tripDraft.child_price_free === "true",
      infant: tripDraft.infant_price_free === "true",
    }),
  };
  const infantFareFree = documentedFreeFare(liveChildRulesExtra, "infant");
  const childFareFree = documentedFreeFare(liveChildRulesExtra, "child");
  const gaps = findTripGaps({
    route_name: tripDraft.route_name,
    duration_text: tripDraft.duration_text,
    adult_price: parseMoneyDraft(tripDraft.adult_price),
    child_price: parseMoneyDraft(tripDraft.child_price),
    infant_price: parseMoneyDraft(tripDraft.infant_price),
    infant_fare_free: infantFareFree,
    child_fare_free: childFareFree,
    departure_dates: splitDraftList(tripDraft.departure_dates),
    photo_urls: tripPhotoUrls,
    itinerary_days: tripItineraryDays,
    has_brochure: Boolean(brochurePdfUrl),
    poster_photo_count:
      typeof editingExtra.poster_photo_count === "number" ? editingExtra.poster_photo_count : 0,
  });
  const blocking = blockingGaps(gaps);
  // Drives the red border on each field itself, not just the summary banner.
  const gapKeys = new Set(blocking.map((gap) => gap.key));

  React.useEffect(() => {
    if (blocking.length === 0) setConfirmingIncomplete(false);
  }, [blocking.length]);

  React.useEffect(() => {
    setConfirmingIncomplete(false);
  }, [open, editingTrip?.id, isNewTrip]);

  function handleSave() {
    if (blocking.length > 0 && !confirmingIncomplete) {
      setConfirmingIncomplete(true);
      return;
    }
    onSave();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isNewTrip ? "Шинэ аялал нэмэх" : "Аялал засах"}
      description={isNewTrip ? undefined : editingTrip?.route_name || undefined}
      panelClassName="max-w-4xl"
      footer={
        confirmingIncomplete ? (
          <>
            <div className="mr-auto flex min-w-0 items-center gap-2 text-left">
              <Icons.alert size={16} className="shrink-0 text-danger" />
              <p className="text-sm text-ink">
                <span className="font-semibold text-danger">
                  {blocking.map((gap) => gap.label).join(", ")}
                </span>{" "}
                дутуу байхад хадгалах уу?
              </p>
            </div>
            <Button variant="secondary" onClick={() => setConfirmingIncomplete(false)}>
              Үгүй, бөглөнө
            </Button>
            <Button
              variant="danger"
              disabled={saveDisabled}
              loading={busyKey === "save-trip"}
              onClick={() => onSave(true)}
            >
              Тийм, дутуугаар хадгална
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Болих
            </Button>
            <Button disabled={saveDisabled} loading={busyKey === "save-trip"} onClick={handleSave}>
              Хадгалах
            </Button>
          </>
        )
      }
    >
      <GapWarning gaps={gaps} isNewTrip={isNewTrip} />
      <div className="mb-4 flex flex-wrap gap-2 border-b border-line pb-4">
        <EditorTabButton active={activeTab === "base"} label="Үндсэн" onClick={() => setActiveTab("base")} />
        <EditorTabButton active={activeTab === "pricing"} label="Үнэ ба гаралт" onClick={() => setActiveTab("pricing")} />
        <EditorTabButton active={activeTab === "itinerary"} label="Хөтөлбөр" onClick={() => setActiveTab("itinerary")} />
        <EditorTabButton active={activeTab === "advanced"} label="Нэмэлт" onClick={() => setActiveTab("advanced")} />
      </div>

      {activeTab === "base" && (
        <>
      {/* Base fields */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          label="Аяллын нэр"
          value={tripDraft.route_name}
          onChange={(e) => setTripDraft((p) => ({ ...p, route_name: e.target.value }))}
          error={gapKeys.has("route_name") ? "Заавал бөглөх" : undefined}
        />
        <Input
          label="Хугацаа (ж: 5ш6ө)"
          value={tripDraft.duration_text}
          onChange={(e) => setTripDraft((p) => ({ ...p, duration_text: e.target.value }))}
          error={gapKeys.has("duration_text") ? "Заавал бөглөх" : undefined}
        />
        <MoneyInput
          label="Том хүний үнэ"
          value={tripDraft.adult_price}
          onChange={(value) => setTripDraft((p) => ({ ...p, adult_price: value }))}
          missing={gapKeys.has("adult_price")}
        />
        <MoneyInput
          label="Хүүхдийн үнэ"
          value={tripDraft.child_price}
          onChange={(value) => setTripDraft((p) => ({ ...p, child_price: value }))}
          missing={gapKeys.has("child_price")}
          free={tripDraft.child_price_free === "true"}
          onFreeChange={(free) => setTripDraft((p) => ({ ...p, child_price_free: free ? "true" : "", child_price: free ? "" : p.child_price }))}
        />
        <MoneyInput
          label="Нярайн үнэ"
          value={tripDraft.infant_price}
          onChange={(value) => setTripDraft((p) => ({ ...p, infant_price: value }))}
          missing={gapKeys.has("infant_price")}
          free={tripDraft.infant_price_free === "true"}
          onFreeChange={(free) => setTripDraft((p) => ({ ...p, infant_price_free: free ? "true" : "", infant_price: free ? "" : p.infant_price }))}
        />
        <div className="rounded-lg border border-line bg-surface-sunken p-3 sm:col-span-2">
          <p className="text-sm font-semibold text-ink">Насны ангилал</p>
          <p className="mt-0.5 text-xs text-ink-muted">
            Энэ аялалд хэн нярай, хэн хүүхэд, хэн том хүн болохыг энд бичнэ — аялал бүр өөр байж болно. Бот болон вэбсайт яг энэ ангиллаар үнэ хэлнэ.
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <Input
              label="Нярай"
              placeholder="ж: 0-23 сар"
              value={tripDraft.age_infant || ""}
              onChange={(e) => setTripDraft((p) => ({ ...p, age_infant: e.target.value }))}
            />
            <Input
              label="Хүүхэд"
              placeholder="ж: 2-11 нас"
              value={tripDraft.age_child || ""}
              onChange={(e) => setTripDraft((p) => ({ ...p, age_child: e.target.value }))}
            />
            <Input
              label="Том хүн"
              placeholder="ж: 12+ нас"
              value={tripDraft.age_adult || ""}
              onChange={(e) => setTripDraft((p) => ({ ...p, age_adult: e.target.value }))}
            />
          </div>
        </div>
        <Select
          label="Төлөв"
          value={tripDraft.status}
          onChange={(e) => setTripDraft((p) => ({ ...p, status: e.target.value }))}
        >
          <option value="active">Идэвхтэй</option>
          <option value="cancelled">Цуцлагдсан</option>
          <option value="sold_out">Суудал дууссан</option>
          <option value="draft">Ноорог</option>
          <option value="archived">Архив</option>
        </Select>
        <Select
          label="Хоол"
          value={tripDraft.has_food}
          onChange={(e) => setTripDraft((p) => ({ ...p, has_food: e.target.value }))}
        >
          <option value="unknown">Тодорхойгүй</option>
          <option value="true">Багтсан</option>
          <option value="false">Багтаагүй</option>
        </Select>
        <Input
          label="Нийт суудал"
          inputMode="numeric"
          value={tripDraft.seats_total}
          onChange={(e) => setTripDraft((p) => ({ ...p, seats_total: e.target.value }))}
        />
        <Input
          label="Үлдсэн суудал"
          inputMode="numeric"
          value={tripDraft.seats_left}
          onChange={(e) => setTripDraft((p) => ({ ...p, seats_left: e.target.value }))}
        />
        <DepartureDateEditor
          value={tripDraft.departure_dates}
          onChange={(value) => setTripDraft((p) => ({ ...p, departure_dates: value }))}
          missing={gapKeys.has("departure_dates")}
        />
      </div>
      <div className="mt-3">
        <Input
          label="Зочид буудал"
          placeholder="ж: Shangri-La Ulaanbaatar (4*)"
          value={tripDraft.hotel}
          onChange={(e) => setTripDraft((p) => ({ ...p, hotel: e.target.value }))}
        />
      </div>
      <div className="mt-3">
        <Textarea
          label="Тэмдэглэл"
          rows={2}
          value={tripDraft.notes}
          onChange={(e) => setTripDraft((p) => ({ ...p, notes: e.target.value }))}
        />
      </div>

      {isPosterLinked && (
        <div className="mt-4 rounded-lg border border-success/25 bg-success-soft px-3 py-2.5 text-sm text-success">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="font-semibold">Постертэй холбогдсон аялал</p>
              <p className="mt-0.5 truncate text-xs text-success/80">
                {linkedPosterId}
                {originalPosterTitle ? ` · ${originalPosterTitle}` : ""}
                {linkedSourceFile ? ` · ${linkedSourceFile}` : ""}
              </p>
            </div>
            {brochurePdfUrl && (
              <a
                href={brochurePdfUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md bg-surface px-2.5 py-1 text-xs font-semibold text-success shadow-xs hover:underline"
              >
                PDF нээх
              </a>
            )}
          </div>
        </div>
      )}

      {!isPosterLinked && (
      <div className="mt-4">
        <p className="mb-1 text-sm font-medium text-ink">Аялалын зургууд</p>
        <p className="mb-2 text-xs text-ink-subtle">
          Хэрэглэгч энэ аялалыг асуухад бот зургийг автоматаар илгээнэ.
        </p>
        <div
          onDragOver={(e) => { e.preventDefault(); setPhotoDragging(true); }}
          onDragLeave={() => setPhotoDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setPhotoDragging(false);
            void handlePhotoFiles(e.dataTransfer.files);
          }}
          onClick={() => photoFileInputRef.current?.click()}
          className={cx(
            "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 transition-colors",
            photoDragging
              ? "border-brand bg-brand-soft"
              : gapKeys.has("photo_urls")
                ? "border-danger bg-danger-soft"
                : "border-line-strong bg-surface-sunken hover:border-brand",
          )}
        >
          <Icons.download size={24} className={gapKeys.has("photo_urls") ? "text-danger" : "text-ink-subtle"} />
          <p className="text-sm font-medium text-ink">Зураг чирж оруулах эсвэл дарж сонгох</p>
          <p className="text-xs text-ink-subtle">PNG, JPG, WEBP — хамгийн ихдээ 10MB</p>
          {gapKeys.has("photo_urls") && (
            <p className="text-xs font-medium text-danger">Заавал бөглөх — зураг дутуу</p>
          )}
          <input
            ref={photoFileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) void handlePhotoFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
        {photoUploading.length > 0 && (
          <div className="mt-2 space-y-1">
            {photoUploading.map((name) => (
              <div key={name} className="flex items-center gap-2 rounded-md border border-line bg-surface-sunken px-3 py-2 text-xs text-ink-muted">
                <Spinner className="shrink-0" />
                <span className="truncate">{name} — байршуулж байна…</span>
              </div>
            ))}
            <p className="px-1 text-xs text-ink-subtle">Хадгалах товч зураг байршуулж дуустал идэвхгүй байна.</p>
          </div>
        )}
        {tripPhotoUrls.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {tripPhotoUrls.map((url, idx) => (
              <div key={idx} className="group relative h-20 w-20 overflow-hidden rounded-lg border border-line">
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block h-full w-full"
                  title="Бүтэн зураг харах (шинэ хуудсанд)"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={url}
                    alt={`Зураг ${idx + 1}`}
                    className="h-full w-full object-cover"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                  />
                </a>
                <button
                  type="button"
                  onClick={() => setTripPhotoUrls((prev) => prev.filter((_, i) => i !== idx))}
                  className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100"
                  aria-label="Устгах"
                >
                  <Icons.trash size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="hidden" aria-hidden="true">
        {/* Brochure PDF URL */}
        <div className="mt-4">
          <p className="mb-1 text-sm font-medium text-ink">Хөтөлбөрийн PDF холбоос</p>
          <p className="mb-2 text-xs text-ink-subtle">
            Хэрэглэгч аялалыг асуухад бот хөтөлбөрийн PDF файлыг автоматаар илгээнэ.
          </p>
          <input
            type="url"
            value={tripDraft.brochure_pdf_url || ""}
            onChange={(e) => setTripDraft((p) => ({ ...p, brochure_pdf_url: e.target.value }))}
            placeholder="https://example.com/brochure.pdf"
            className={inputCls}
          />
        </div>
        {/* Manual URL paste fallback */}
        <p className="mt-3 mb-1 text-xs font-medium text-ink-muted">Эсвэл URL-аар нэмэх</p>
        <div className="flex gap-2">
          <input
            type="url"
            value={tripPhotoInput}
            onChange={(e) => setTripPhotoInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                const url = tripPhotoInput.trim();
                if (url.startsWith("https://") && tripPhotoUrls.length < MAX_PHOTOS_PER_TRIP) {
                  setTripPhotoUrls((prev) => [...prev, url]);
                  setTripPhotoInput("");
                }
              }
            }}
            placeholder="https://example.com/photo.jpg"
            className="flex-1 rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink transition-colors placeholder:text-ink-subtle focus:border-brand"
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={!tripPhotoInput.trim().startsWith("https://") || tripPhotoUrls.length >= MAX_PHOTOS_PER_TRIP}
            onClick={() => {
              const url = tripPhotoInput.trim();
              if (url.startsWith("https://") && tripPhotoUrls.length < MAX_PHOTOS_PER_TRIP) {
                setTripPhotoUrls((prev) => [...prev, url]);
                setTripPhotoInput("");
              }
            }}
          >
            <Icons.plus size={14} />
            Нэмэх
          </Button>
        </div>
        </div>
      </div>
      )}

        </>
      )}

      {activeTab === "advanced" && (
        <>
      {/* A. Aliases */}
      <p className={sectionHdr}>Өөр нэршил / хайлтын нэр</p>
      <div className="mt-2 space-y-1">
        {tripAliases.map((alias, idx) => (
          <div key={idx} className={rowCls}>
            <input
              className={cx(inputCls, "flex-1")}
              value={alias}
              placeholder="ж: Хятад аялал, Beijing tour"
              onChange={(e) => setTripAliases((prev) => prev.map((v, i) => i === idx ? e.target.value : v))}
            />
            <button type="button" className={delBtn} onClick={() => setTripAliases((prev) => prev.filter((_, i) => i !== idx))}>
              <Icons.trash size={14} />
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="mt-1 text-xs text-brand hover:underline" onClick={() => setTripAliases((prev) => [...prev, ""])}>
        + Нэршил нэмэх
      </button>

        </>
      )}

      {activeTab === "pricing" && (
        <>
      {/* B. Price groups — one entry per set of departure dates. Adult price is
          always a single value; child/infant are a flexible list of price
          bands (a trip can have more than one child age tier) with a Free
          option, and that list is the ONLY place either is entered — no
          separate "child price"/"infant price" fields to keep in sync. */}
      <p className={sectionHdr}>Огноо тус бүрийн үнэ</p>
      <div className="mt-2 space-y-3">
        {tripPriceGroups.map((g, idx) => (
          <div key={idx} className="rounded-lg border border-line bg-surface-sunken p-3 text-sm">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-ink-muted">
                {g.dates.length ? g.dates.join(", ") : `Огноо сонгоогүй үнэ ${idx + 1}`}
              </span>
              <button type="button" className={delBtn} onClick={() => setTripPriceGroups((prev) => prev.filter((_, i) => i !== idx))}>
                <Icons.trash size={13} />
              </button>
            </div>

            <PriceGroupDateChips
              dates={g.dates}
              onChange={(dates) => setTripPriceGroups((prev) => prev.map((v, i) => i === idx ? { ...v, dates, display_dates: dates } : v))}
            />

            <div className="mt-3">
              <MoneyInput
                label="Том хүний үнэ"
                value={g.adult_price != null ? String(g.adult_price) : ""}
                onChange={(value) => setTripPriceGroups((prev) => prev.map((v, i) => i === idx ? { ...v, adult_price: value === "" ? null : Number(value) } : v))}
              />
            </div>

            {(() => {
              const bands = g.passenger_prices ?? [];
              const isInfantBand = (pp: PassengerPrice) => isInfantShapedAge(pp.label.toLowerCase(), pp.age_range);
              const childBands = bands.map((pp, ppIdx) => ({ pp, ppIdx })).filter(({ pp }) => !isInfantBand(pp));
              const infantBands = bands.map((pp, ppIdx) => ({ pp, ppIdx })).filter(({ pp }) => isInfantBand(pp));
              const updateBand = (ppIdx: number, next: PassengerPrice) =>
                setTripPriceGroups((prev) => prev.map((v, i) => i === idx ? { ...v, passenger_prices: v.passenger_prices.map((p2, j) => j === ppIdx ? next : p2) } : v));
              const removeBand = (ppIdx: number) =>
                setTripPriceGroups((prev) => prev.map((v, i) => i === idx ? { ...v, passenger_prices: v.passenger_prices.filter((_, j) => j !== ppIdx) } : v));
              const addBand = (label: string) =>
                setTripPriceGroups((prev) => prev.map((v, i) => i === idx ? { ...v, passenger_prices: [...(v.passenger_prices ?? []), emptyPassengerPrice(label)] } : v));
              return (
                <>
                  <div className="mt-3">
                    <p className="mb-1.5 text-xs font-semibold text-ink">Хүүхдийн үнэ</p>
                    <div className="space-y-1.5">
                      {childBands.map(({ pp, ppIdx }) => (
                        <PassengerBandRow key={ppIdx} price={pp} onChange={(next) => updateBand(ppIdx, next)} onRemove={() => removeBand(ppIdx)} />
                      ))}
                    </div>
                    <button type="button" className="mt-1.5 text-xs text-brand hover:underline" onClick={() => addBand("Хүүхэд")}>
                      + Хүүхдийн үнэ нэмэх
                    </button>
                  </div>

                  <div className="mt-3">
                    <p className="mb-1.5 text-xs font-semibold text-ink">Нярайн үнэ</p>
                    <p className="mb-1.5 text-xs text-ink-subtle">Ихэвчлэн сараар тоологдоно (ж: 0-23 сар).</p>
                    <div className="space-y-1.5">
                      {infantBands.map(({ pp, ppIdx }) => (
                        <PassengerBandRow key={ppIdx} price={pp} onChange={(next) => updateBand(ppIdx, next)} onRemove={() => removeBand(ppIdx)} />
                      ))}
                    </div>
                    <button type="button" className="mt-1.5 text-xs text-brand hover:underline" onClick={() => addBand("Нярай")}>
                      + Нярайн үнэ нэмэх
                    </button>
                  </div>
                </>
              );
            })()}

            <div className="mt-3">
              <label className="mb-0.5 block text-xs text-ink-muted">Тайлбар</label>
              <input className={inputCls} value={g.note} onChange={(e) => setTripPriceGroups((prev) => prev.map((v, i) => i === idx ? { ...v, note: e.target.value } : v))} />
            </div>
          </div>
        ))}
      </div>
      <button type="button" className="mt-1 text-xs text-brand hover:underline" onClick={() => setTripPriceGroups((prev) => [...prev, emptyPriceGroup()])}>
        + Үнийн бүлэг нэмэх
      </button>

      {/* C. Discounts */}
      <p className={sectionHdr}>Хямдрал / урамшуулал</p>
      <div className="mt-2 space-y-3">
        {tripDiscounts.map((g, idx) => (
          <div key={idx} className="rounded-lg border border-line bg-surface-sunken p-3 text-sm">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-ink-muted">Хямдрал {idx + 1}</span>
              <button type="button" className={delBtn} onClick={() => setTripDiscounts((prev) => prev.filter((_, i) => i !== idx))}>
                <Icons.trash size={13} />
              </button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <label className="mb-0.5 block text-xs text-ink-muted">Хямдралын нэр</label>
                <input className={inputCls} value={g.label} onChange={(e) => setTripDiscounts((prev) => prev.map((v, i) => i === idx ? { ...v, label: e.target.value } : v))} />
              </div>
              <div>
                <label className="mb-0.5 block text-xs text-ink-muted">Огноонууд (таслалаар)</label>
                <input className={inputCls} value={g.dates.join(", ")} onChange={(e) => setTripDiscounts((prev) => prev.map((v, i) => i === idx ? { ...v, dates: e.target.value.split(",").map((d) => d.trim()).filter(Boolean) } : v))} />
              </div>
              <div>
                <label className="mb-0.5 block text-xs text-ink-muted">Том хүний хямдралтай үнэ</label>
                <input className={numCls} type="number" value={g.adult_price ?? ""} onChange={(e) => setTripDiscounts((prev) => prev.map((v, i) => i === idx ? { ...v, adult_price: e.target.value === "" ? null : Number(e.target.value) } : v))} />
              </div>
              <div>
                <label className="mb-0.5 block text-xs text-ink-muted">Хүүхдийн хямдралтай үнэ</label>
                <input className={numCls} type="number" value={g.child_price ?? ""} onChange={(e) => setTripDiscounts((prev) => prev.map((v, i) => i === idx ? { ...v, child_price: e.target.value === "" ? null : Number(e.target.value) } : v))} />
              </div>
              <div>
                <label className="mb-0.5 block text-xs text-ink-muted">Нярайн үнэ</label>
                <input className={numCls} type="number" value={g.infant_price ?? ""} onChange={(e) => setTripDiscounts((prev) => prev.map((v, i) => i === idx ? { ...v, infant_price: e.target.value === "" ? null : Number(e.target.value) } : v))} />
              </div>
              <div>
                <label className="mb-0.5 block text-xs text-ink-muted">Нөхцөл</label>
                <input className={inputCls} value={g.condition} onChange={(e) => setTripDiscounts((prev) => prev.map((v, i) => i === idx ? { ...v, condition: e.target.value } : v))} />
              </div>
              <div className="sm:col-span-2">
                <label className="mb-0.5 block text-xs text-ink-muted">Тайлбар</label>
                <input className={inputCls} value={g.note} onChange={(e) => setTripDiscounts((prev) => prev.map((v, i) => i === idx ? { ...v, note: e.target.value } : v))} />
              </div>
            </div>
          </div>
        ))}
      </div>
      <button type="button" className="mt-1 text-xs text-brand hover:underline" onClick={() => setTripDiscounts((prev) => [...prev, emptyDiscountGroup()])}>
        + Хямдрал нэмэх
      </button>

      {/* D. Extra fees */}
      <p className={sectionHdr}>Нэмэлт төлбөр</p>
      <div className="mt-2 space-y-2">
        {tripExtraFees.map((f, idx) => (
          <div key={idx} className="grid gap-2 rounded-lg border border-line bg-surface-sunken p-2 sm:grid-cols-5">
            <div>
              <label className="mb-0.5 block text-xs text-ink-muted">Нэр</label>
              <input className={inputCls} value={f.label} onChange={(e) => setTripExtraFees((prev) => prev.map((v, i) => i === idx ? { ...v, label: e.target.value } : v))} />
            </div>
            <div>
              <label className="mb-0.5 block text-xs text-ink-muted">Дүн</label>
              <input className={numCls} type="number" value={f.amount ?? ""} onChange={(e) => setTripExtraFees((prev) => prev.map((v, i) => i === idx ? { ...v, amount: e.target.value === "" ? null : Number(e.target.value) } : v))} />
            </div>
            <div>
              <label className="mb-0.5 block text-xs text-ink-muted">Валют</label>
              <select className={inputCls} value={f.currency} onChange={(e) => setTripExtraFees((prev) => prev.map((v, i) => i === idx ? { ...v, currency: e.target.value } : v))}>
                <option value="MNT">MNT</option>
                <option value="CNY">CNY</option>
                <option value="USD">USD</option>
              </select>
            </div>
            <div>
              <label className="mb-0.5 block text-xs text-ink-muted">Хэнд хамаарах</label>
              <input className={inputCls} value={f.applies_to} placeholder="ж: Бүгд" onChange={(e) => setTripExtraFees((prev) => prev.map((v, i) => i === idx ? { ...v, applies_to: e.target.value } : v))} />
            </div>
            <div className="flex gap-1">
              <div className="flex-1">
                <label className="mb-0.5 block text-xs text-ink-muted">Тайлбар</label>
                <input className={inputCls} value={f.note} onChange={(e) => setTripExtraFees((prev) => prev.map((v, i) => i === idx ? { ...v, note: e.target.value } : v))} />
              </div>
              <button type="button" className={cx(delBtn, "mt-5")} onClick={() => setTripExtraFees((prev) => prev.filter((_, i) => i !== idx))}>
                <Icons.trash size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>
      <button type="button" className="mt-1 text-xs text-brand hover:underline" onClick={() => setTripExtraFees((prev) => [...prev, emptyExtraFee()])}>
        + Нэмэлт төлбөр нэмэх
      </button>

      {/* E. Departure rule */}
      <p className={sectionHdr}>Гарах өдрийн дүрэм</p>
      <div className="mt-2">
        <textarea
          className={cx(inputCls, "resize-y")}
          rows={2}
          value={tripDepartureRule}
          placeholder="ж: Даваа, Лхагва, Баасан гарна"
          onChange={(e) => setTripDepartureRule(e.target.value)}
        />
      </div>

        </>
      )}

      {activeTab === "itinerary" && (
        <>
      <p className={sectionHdr}>Өдрийн хөтөлбөр</p>
      <p className="mt-0.5 text-xs text-ink-subtle">
        Эдгээр өдрүүд постер болон вебсайтад мөн харагдана. Зураг зөвхөн Постер таб дээрээс нэмнэ.
      </p>
      <div className="mt-2 space-y-2">
        {tripItineraryDays.map((d, idx) => (
          <div key={idx} className="rounded-lg border border-line bg-surface-sunken p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-ink-muted">Өдөр {idx + 1}</span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="rounded-md p-1 text-ink-muted transition-colors hover:bg-surface hover:text-ink disabled:opacity-30"
                  disabled={idx === 0}
                  title="Дээш зөөх"
                  onClick={() => setTripItineraryDays((prev) => {
                    if (idx === 0) return prev;
                    const next = [...prev];
                    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
                    return next;
                  })}
                >
                  <Icons.chevronRight size={14} className="-rotate-90" />
                </button>
                <button
                  type="button"
                  className="rounded-md p-1 text-ink-muted transition-colors hover:bg-surface hover:text-ink disabled:opacity-30"
                  disabled={idx === tripItineraryDays.length - 1}
                  title="Доош зөөх"
                  onClick={() => setTripItineraryDays((prev) => {
                    if (idx === prev.length - 1) return prev;
                    const next = [...prev];
                    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
                    return next;
                  })}
                >
                  <Icons.chevronRight size={14} className="rotate-90" />
                </button>
                <button
                  type="button"
                  className={delBtn}
                  onClick={() => setTripItineraryDays((prev) => prev.filter((_, i) => i !== idx))}
                >
                  <Icons.trash size={13} />
                </button>
              </div>
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <div>
                <label className="mb-0.5 block text-xs text-ink-muted">Гарчиг / чиглэл</label>
                <input
                  className={inputCls}
                  value={d.title}
                  placeholder="ж: Улаанбаатар – Хархорин"
                  onChange={(e) => setTripItineraryDays((prev) => prev.map((v, i) => i === idx ? { ...v, title: e.target.value } : v))}
                />
              </div>
              <div>
                <label className="mb-0.5 block text-xs text-ink-muted">Зочид буудал</label>
                <input
                  className={inputCls}
                  value={d.hotel || ""}
                  placeholder="ж: Kharkhorin Hotel"
                  onChange={(e) => setTripItineraryDays((prev) => prev.map((v, i) => i === idx ? { ...v, hotel: e.target.value } : v))}
                />
              </div>
            </div>
            <div className="mt-2">
              <label className="mb-0.5 block text-xs text-ink-muted">Тайлбар</label>
              <textarea
                className={cx(inputCls, "resize-y")}
                rows={2}
                value={d.description}
                placeholder="Энэ өдрийн аяллын тайлбар..."
                onChange={(e) => setTripItineraryDays((prev) => prev.map((v, i) => i === idx ? { ...v, description: e.target.value } : v))}
              />
            </div>
            <div className="mt-2 flex gap-1.5">
              {([
                ["breakfast", "Өглөөний хоол"],
                ["lunch", "Өдрийн хоол"],
                ["dinner", "Оройн хоол"],
              ] as const).map(([key, label]) => {
                const on = Boolean(d.meals?.[key]);
                return (
                  <button
                    key={key}
                    type="button"
                    className={cx(
                      "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                      on ? "border-brand bg-brand-soft text-brand" : "border-line-strong bg-surface text-ink-muted",
                    )}
                    onClick={() => setTripItineraryDays((prev) => prev.map((v, i) =>
                      i === idx ? { ...v, meals: { ...v.meals, [key]: !on } } : v,
                    ))}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="mt-1 text-xs text-brand hover:underline"
        onClick={() => setTripItineraryDays((prev) => [...prev, emptyItineraryDay(prev.length + 1)])}
      >
        + Өдөр нэмэх
      </button>
        </>
      )}

      {activeTab === "advanced" && (
        <>
      {/* G. Included items */}
      <p className={sectionHdr}>Багтсан зүйлс</p>
      <div className="mt-2 space-y-1">
        {tripIncludedItems.map((item, idx) => (
          <div key={idx} className={rowCls}>
            <input
              className={cx(inputCls, "flex-1")}
              value={item}
              placeholder="ж: Нислэгийн тийз, Зочид буудал"
              onChange={(e) => setTripIncludedItems((prev) => prev.map((v, i) => i === idx ? e.target.value : v))}
            />
            <button type="button" className={delBtn} onClick={() => setTripIncludedItems((prev) => prev.filter((_, i) => i !== idx))}>
              <Icons.trash size={14} />
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="mt-1 text-xs text-brand hover:underline" onClick={() => setTripIncludedItems((prev) => [...prev, ""])}>
        + Зүйл нэмэх
      </button>

      {/* H. Excluded items */}
      <p className={sectionHdr}>Багтаагүй зүйлс</p>
      <div className="mt-2 space-y-1">
        {tripExcludedItems.map((item, idx) => (
          <div key={idx} className={rowCls}>
            <input
              className={cx(inputCls, "flex-1")}
              value={item}
              placeholder="ж: Визний зардал, Хоол"
              onChange={(e) => setTripExcludedItems((prev) => prev.map((v, i) => i === idx ? e.target.value : v))}
            />
            <button type="button" className={delBtn} onClick={() => setTripExcludedItems((prev) => prev.filter((_, i) => i !== idx))}>
              <Icons.trash size={14} />
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="mt-1 text-xs text-brand hover:underline" onClick={() => setTripExcludedItems((prev) => [...prev, ""])}>
        + Зүйл нэмэх
      </button>

      {/* I. Room prices */}
      <p className={sectionHdr}>Өрөөний үнэ</p>
      <div className="mt-2 space-y-2">
        {tripRoomPrices.map((r, idx) => (
          <div key={idx} className="grid gap-2 rounded-lg border border-line bg-surface-sunken p-2 sm:grid-cols-4">
            <div>
              <label className="mb-0.5 block text-xs text-ink-muted">Өрөөний төрөл</label>
              <input className={inputCls} value={r.room_type} placeholder="ж: Давхар өрөө" onChange={(e) => setTripRoomPrices((prev) => prev.map((v, i) => i === idx ? { ...v, room_type: e.target.value } : v))} />
            </div>
            <div>
              <label className="mb-0.5 block text-xs text-ink-muted">Үнэ</label>
              <input className={numCls} type="number" value={r.price ?? ""} onChange={(e) => setTripRoomPrices((prev) => prev.map((v, i) => i === idx ? { ...v, price: e.target.value === "" ? null : Number(e.target.value) } : v))} />
            </div>
            <div>
              <label className="mb-0.5 block text-xs text-ink-muted">Валют</label>
              <select className={inputCls} value={r.currency} onChange={(e) => setTripRoomPrices((prev) => prev.map((v, i) => i === idx ? { ...v, currency: e.target.value } : v))}>
                <option value="MNT">MNT</option>
                <option value="CNY">CNY</option>
                <option value="USD">USD</option>
              </select>
            </div>
            <div className="flex gap-1">
              <div className="flex-1">
                <label className="mb-0.5 block text-xs text-ink-muted">Тайлбар</label>
                <input className={inputCls} value={r.note} onChange={(e) => setTripRoomPrices((prev) => prev.map((v, i) => i === idx ? { ...v, note: e.target.value } : v))} />
              </div>
              <button type="button" className={cx(delBtn, "mt-5")} onClick={() => setTripRoomPrices((prev) => prev.filter((_, i) => i !== idx))}>
                <Icons.trash size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>
      <button type="button" className="mt-1 text-xs text-brand hover:underline" onClick={() => setTripRoomPrices((prev) => [...prev, emptyRoomPrice()])}>
        + Өрөө нэмэх
      </button>

      {/* J. Important notes */}
      <p className={sectionHdr}>Чухал тэмдэглэл</p>
      <div className="mt-2 space-y-1">
        {tripImportantNotes.map((note, idx) => (
          <div key={idx} className={rowCls}>
            <input
              className={cx(inputCls, "flex-1")}
              value={note}
              placeholder="ж: Паспортын хүчинтэй хугацаа 6 сараас дээш байх шаардлагатай"
              onChange={(e) => setTripImportantNotes((prev) => prev.map((v, i) => i === idx ? e.target.value : v))}
            />
            <button type="button" className={delBtn} onClick={() => setTripImportantNotes((prev) => prev.filter((_, i) => i !== idx))}>
              <Icons.trash size={14} />
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="mt-1 mb-2 text-xs text-brand hover:underline" onClick={() => setTripImportantNotes((prev) => [...prev, ""])}>
        + Тэмдэглэл нэмэх
      </button>

      {/* J2. Booking terms — what a buyer asks before committing. Empty fields
          stay unknown so the bot refers to a consultant instead of inventing. */}
      <p className={sectionHdr}>Захиалгын нөхцөл</p>
      <p className="mt-0.5 text-xs text-ink-subtle">Хоосон талбарыг бот &laquo;тодорхойгүй&raquo; гэж үзэж, зөвлөхөд шилжүүлнэ. Зохиож бичихгүй.</p>
      <div className="mt-2 space-y-2">
        <div>
          <label className="mb-0.5 block text-xs text-ink-muted">Урьдчилгаа</label>
          <input className={inputCls} value={tripBookingTerms.deposit} placeholder="ж: Урьдчилгаа 111,111₮, үлдэгдлийг гарахаас 7 хоногийн өмнө" onChange={(e) => setTripBookingTerms((p) => ({ ...p, deposit: e.target.value }))} />
        </div>
        <div>
          <label className="mb-0.5 block text-xs text-ink-muted">Төлбөрийн нөхцөл</label>
          <input className={inputCls} value={tripBookingTerms.payment} placeholder="ж: Дансаар эсвэл QPay-ээр, 2 хэсэгт хуваан төлж болно" onChange={(e) => setTripBookingTerms((p) => ({ ...p, payment: e.target.value }))} />
        </div>
        <div>
          <label className="mb-0.5 block text-xs text-ink-muted">Бүрдүүлэх бичиг баримт</label>
          <input className={inputCls} value={tripBookingTerms.documents} placeholder="ж: Гадаад паспорт (6 сараас дээш хүчинтэй), 2 хувь цээж зураг" onChange={(e) => setTripBookingTerms((p) => ({ ...p, documents: e.target.value }))} />
        </div>
        <div>
          <label className="mb-0.5 block text-xs text-ink-muted">Виз</label>
          <input className={inputCls} value={tripBookingTerms.visa} placeholder="ж: Хятадын виз шаардлагатай, бид мэдүүлэгт туслана" onChange={(e) => setTripBookingTerms((p) => ({ ...p, visa: e.target.value }))} />
        </div>
        <div>
          <label className="mb-0.5 block text-xs text-ink-muted">Цуцлалт / буцаан олголт</label>
          <input className={inputCls} value={tripBookingTerms.cancellation} placeholder="ж: Гарахаас 14 хоногийн өмнө цуцлавал урьдчилгаа буцаана" onChange={(e) => setTripBookingTerms((p) => ({ ...p, cancellation: e.target.value }))} />
        </div>
      </div>

      {/* K. Metadata toggles */}
      <p className={sectionHdr}>Тохиргоо / мета</p>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-line-strong accent-brand"
            checked={tripCustomerVisible}
            onChange={(e) => setTripCustomerVisible(e.target.checked)}
          />
          Ботод харагдана (хэрэглэгчид)
        </label>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-line-strong accent-brand"
            checked={tripNeedsHumanReview}
            onChange={(e) => setTripNeedsHumanReview(e.target.checked)}
          />
          Хүний шалгалт шаарддаг
        </label>
      </div>
      {tripNeedsHumanReview && (
        <div className="mt-2 space-y-1">
          <p className="text-xs text-ink-muted">Шалтгаанууд:</p>
          {tripReviewReasons.map((reason, idx) => (
            <div key={idx} className={rowCls}>
              <input
                className={cx(inputCls, "flex-1")}
                value={reason}
                placeholder="ж: Огноо таарахгүй байна"
                onChange={(e) => setTripReviewReasons((prev) => prev.map((v, i) => i === idx ? e.target.value : v))}
              />
              <button type="button" className={delBtn} onClick={() => setTripReviewReasons((prev) => prev.filter((_, i) => i !== idx))}>
                <Icons.trash size={14} />
              </button>
            </div>
          ))}
          <button type="button" className="text-xs text-brand hover:underline" onClick={() => setTripReviewReasons((prev) => [...prev, ""])}>
            + Шалтгаан нэмэх
          </button>
        </div>
      )}

      {/* L. Source provenance (read-only, from AI extraction) */}
      {tripSourceProvenance.length > 0 && (
        <>
          <p className={sectionHdr}>Эх сурвалж (AI-ийн задлалт)</p>
          <div className="mt-2 space-y-2">
            {tripSourceProvenance.map((sp, idx) => (
              <div key={idx} className="rounded-lg border border-line bg-surface-sunken p-2 text-xs text-ink-muted">
                <div className="flex items-center gap-2 font-medium text-ink">
                  <span>{sp.file_name}</span>
                  {sp.page !== null && <span className="text-ink-subtle">— {sp.page}-р хуудас</span>}
                  <span className={cx(
                    "ml-auto rounded-full px-2 py-0.5 text-xs font-medium",
                    sp.confidence === "high" ? "bg-green-100 text-green-700" :
                    sp.confidence === "medium" ? "bg-yellow-100 text-yellow-700" :
                    "bg-red-100 text-red-600"
                  )}>
                    {sp.confidence === "high" ? "Өндөр" : sp.confidence === "medium" ? "Дунд" : "Бага"}
                  </span>
                </div>
                <p className="mt-1 text-ink-subtle">{sp.source_text}</p>
              </div>
            ))}
          </div>
        </>
      )}

      {/* M. Answer hints */}
      <p className={sectionHdr}>Хариултын заавар (Answer hints)</p>
      <div className="mt-2 space-y-2">
        {tripAnswerHints.map((h, idx) => (
          <div key={idx} className="rounded-lg border border-line bg-surface-sunken p-2 text-sm">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-ink-muted">Заавар {idx + 1}</span>
              <button type="button" className={delBtn} onClick={() => setTripAnswerHints((prev) => prev.filter((_, i) => i !== idx))}>
                <Icons.trash size={13} />
              </button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <label className="mb-0.5 block text-xs text-ink-muted">Санаа (intent)</label>
                <select className={inputCls} value={h.intent} onChange={(e) => setTripAnswerHints((prev) => prev.map((v, i) => i === idx ? { ...v, intent: e.target.value as AnswerHint["intent"] } : v))}>
                  <option value="price">price — Үнэ</option>
                  <option value="discount">discount — Хямдрал</option>
                  <option value="comparison">comparison — Харьцуулалт</option>
                  <option value="child_price">child_price — Хүүхдийн үнэ</option>
                  <option value="included">included — Багтсан зүйл</option>
                  <option value="schedule">schedule — Хуваарь</option>
                </select>
              </div>
              <div>
                <label className="mb-0.5 block text-xs text-ink-muted">Асуулт загвар</label>
                <input className={inputCls} value={h.question_pattern} placeholder="ж: * үнэ хэд вэ?" onChange={(e) => setTripAnswerHints((prev) => prev.map((v, i) => i === idx ? { ...v, question_pattern: e.target.value } : v))} />
              </div>
              <div className="sm:col-span-2">
                <label className="mb-0.5 block text-xs text-ink-muted">Хүлээгдэж буй хариулт</label>
                <input className={inputCls} value={h.expected_answer_summary} placeholder="ж: 1,111,111₮ буюу …" onChange={(e) => setTripAnswerHints((prev) => prev.map((v, i) => i === idx ? { ...v, expected_answer_summary: e.target.value } : v))} />
              </div>
            </div>
          </div>
        ))}
      </div>
      <button type="button" className="mt-1 mb-2 text-xs text-brand hover:underline" onClick={() => setTripAnswerHints((prev) => [...prev, { intent: "price", question_pattern: "", expected_answer_summary: "" }])}>
        + Заавар нэмэх
      </button>
        </>
      )}
    </Modal>
  );
}
