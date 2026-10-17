import React from "react";
import { DayMealToggles, DayPhotoPreview } from "./ItineraryDayControls";
import { DateSeatsEditor } from "./DateSeatsEditor";
import { WebsiteTripFields, TripTextComparison } from "./WebsiteTripFields";
import { Button, DatePicker, Icons, Input, Modal, Select, Spinner, Switch, Textarea, cx } from "@/components/ui";
import { AmountInput, ChipsEditor, DurationField, EditorSection, FieldLabel, ListEditor, SaleBadgeFields, SeatsFields, displayDate, fieldCls } from "./TripEditorParts";
import { getPosterBrochureHref } from "@/lib/poster/pdfUrl";
import { blockingGaps, documentedFreeFare, findTripGaps, type TripGap } from "@/lib/tripCompleteness";
import { MAX_PHOTOS_PER_TRIP } from "@/lib/tripPhotoImport/types";
import { deriveChildRules } from "@/lib/priceGroups";
import { pricingDates, pricingDateRows, patchPricingDate, reconcilePricingDates, passengerPricingRows, passengerName, type PricingGroup } from "@/lib/adminDatePricing";
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
  apiFetch?: (url: string, init?: RequestInit) => Promise<Response>;
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
  /** Jumps to the AI туслах tab with this trip named in the instruction box — not available for a brand-new, unsaved trip. */
  onAskAi?: (tripName: string) => void;
};

const inputCls = "w-full rounded-md border border-line-strong bg-surface px-3 py-1.5 text-sm text-ink transition-colors placeholder:text-ink-subtle focus:border-brand";
const numCls = inputCls;
const delBtn = "shrink-0 rounded-md p-1 text-ink-muted transition-colors hover:bg-danger-soft hover:text-danger";

type TripEditorTab = "base" | "pricing" | "itinerary" | "media" | "terms" | "website" | "advanced";

function emptyPassengerPrice(label = ""): PassengerPrice {
  return { label, age_range: "", price: null, currency: "MNT" };
}
function emptyPriceGroup(): PriceGroup {
  return { label: "", dates: [], display_dates: [], date_keys: [], adult_price: null, adult_price_range: null, child_price: null, infant_price: null, child_age: "", infant_age: "", passenger_prices: [], note: "" };
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

function GapWarning({
  gaps,
  isNewTrip,
  onAskAi,
}: {
  gaps: TripGap[];
  isNewTrip: boolean;
  onAskAi?: () => void;
}) {
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
          {onAskAi && (
            <Button size="sm" variant="secondary" className="mt-2.5" onClick={onAskAi}>
              <Icons.bot size={14} />
              AI туслахаар бөглүүлэх
            </Button>
          )}
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
          "flex h-10 items-center rounded-md border bg-surface px-3 transition-colors focus-within:border-brand",
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
              {displayDate(date)}
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
    <div className="flex min-w-0 items-stretch gap-1">
      <input
        className={cx(inputCls.replace("w-full", ""), "min-w-0 flex-1 text-center")}
        style={{ width: 0 }}
        aria-label="Насны доод хязгаар"
        inputMode="numeric"
        value={min}
        placeholder="0"
        onChange={(e) => setPart({ min: e.target.value.replace(/[^\d]/g, "") })}
      />
      <span className="flex items-center text-ink-subtle">–</span>
      <input
        className={cx(inputCls.replace("w-full", ""), "min-w-0 flex-1 text-center")}
        style={{ width: 0 }}
        aria-label="Насны дээд хязгаар"
        inputMode="numeric"
        value={max}
        placeholder="23"
        onChange={(e) => setPart({ max: e.target.value.replace(/[^\d]/g, "") })}
      />
      <select
        className={cx(inputCls.replace("w-full", ""), "shrink-0")}
        style={{ width: 64 }}
        aria-label="Насны нэгж"
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
    <div className="grid min-w-0 grid-cols-2 gap-2 border-b border-line py-3 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] [&>div]:min-w-0">
      <div>
        <label className="mb-0.5 block text-xs text-ink-muted">Зорчигчийн нэр</label>
        <input
          className={inputCls}
          aria-label="Зорчигчийн ангилал"
          value={passengerName(price as PassengerPrice & PricingGroup)}
          placeholder="ж: Хүүхэд, Нярай"
          onChange={(e) => onChange({ ...price, label: e.target.value })}
        />
      </div>
      <div>
        <label className="mb-0.5 block text-xs text-ink-muted">Насны хүрээ</label>
        <AgeRangePicker
          value={price.age_range}
          onChange={(age_range) => onChange({ ...price, label: passengerName(price as PassengerPrice & PricingGroup), age_range })}
        />
      </div>
      <div>
        <label className="mb-0.5 block text-xs text-ink-muted">Нэг хүний үнэ ({price.currency === "MNT" ? "₮" : price.currency})</label>
        <input
          className={numCls}
          aria-label={`${price.label || "Зорчигч"} үнэ`}
          inputMode="numeric"
          disabled={free}
          value={free ? "" : price.price ?? ""}
          placeholder={free ? "Үнэгүй" : ""}
          onChange={(e) => {
            const digits = e.target.value.replace(/[^\d]/g, "");
            onChange({ ...price, price: digits === "" ? null : Number(digits), note: free ? "" : price.note });
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
        <button type="button" className={delBtn} onClick={onRemove} title="Насны ангилал хасах" aria-label="Насны ангилал хасах">
          <Icons.trash size={13} />
        </button>
      </div>
    </div>
  );
}

export function TripDatePriceEditor({ groups, onChange }: { groups: PriceGroup[]; onChange: React.Dispatch<React.SetStateAction<PriceGroup[]>> }) {
  const [selection, setSelection] = React.useState("");
  const [search, setSearch] = React.useState("");
  const records = groups as (PriceGroup & PricingGroup)[];
  const rows = pricingDateRows(records);
  const key = (row: typeof rows[number]) => `${row.date}|${row.groupIndex}`;
  const selected = rows.find((row) => key(row) === selection) || rows[0];
  const visible = rows.filter((row) => [row.date, records[row.groupIndex].hotel, records[row.groupIndex].label, records[row.groupIndex].note].join(" ").toLowerCase().includes(search.toLowerCase()));
  const group = selected ? groups[selected.groupIndex] : null;
  const bands = group ? passengerPricingRows(records[selected.groupIndex]) as PassengerPrice[] : [];
  const update = (patch: Partial<PriceGroup>) => {
    if (!selected || !group) return;
    const nextIndex = selected.groupIndex + (pricingDates(records[selected.groupIndex]).length > 1 && selected.date ? 1 : 0);
    onChange((current) => patchPricingDate(current as (PriceGroup & PricingGroup)[], selected, {
      ...(!group.passenger_prices?.length ? { passenger_prices: bands } : {}),
      ...patch,
    }));
    setSelection(`${selected.date}|${nextIndex}`);
  };
  return <div className="grid min-w-0 gap-5 md:grid-cols-[260px_minmax(0,1fr)]">
    <div className="min-w-0">
      <div className="md:hidden"><Select label="Гарах огноо" aria-label="Гарах огноо сонгох" value={selected ? key(selected) : ""} onChange={(e) => setSelection(e.target.value)}>
        {rows.map((row) => <option key={key(row)} value={key(row)}>{row.date ? displayDate(row.date) : "Шинэ гаралт"} · {String(records[row.groupIndex].package_id || records[row.groupIndex].hotel || records[row.groupIndex].note || "")} · {records[row.groupIndex].adult_price?.toLocaleString("mn-MN") || "—"}</option>)}
      </Select></div>
      <div className="hidden md:block"><Input label="Гарах огноо" aria-label="Огноо хайх" placeholder="Огноо хайх" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
      <div className="mt-2 hidden max-h-[420px] overflow-y-auto rounded-lg border border-line md:block" role="list" aria-label="Гарах огноонууд">
        {visible.map((row) => {
          const item = records[row.groupIndex];
          return <button key={key(row)} type="button" aria-pressed={!!selected && key(row) === key(selected)} onClick={() => setSelection(key(row))} className={cx("flex w-full items-center justify-between gap-2 border-b border-line px-3 py-3 text-left text-sm last:border-0", selected && key(row) === key(selected) ? "border-l-2 border-l-brand bg-brand-soft" : "hover:bg-surface-sunken")}>
            <span className="min-w-0"><span className="block font-medium">{row.date ? displayDate(row.date) : "Үндсэн үнэ"}</span><span className="block truncate text-xs text-ink-muted">{String(item.package_id || item.hotel || item.note || item.label || "")}</span></span>
            <span className="shrink-0 text-xs tabular-nums">{item.adult_price != null ? item.adult_price.toLocaleString("mn-MN") : "—"}</span>
          </button>;
        })}
        {!visible.length && <p className="py-3 text-sm text-ink-muted">Огноо олдсонгүй.</p>}
      </div>
      <Button variant="secondary" size="sm" className="mt-3" onClick={() => {
        onChange((current) => [...current, emptyPriceGroup()]);
        setSelection(`|${groups.length}`);
        setSearch("");
      }}><Icons.plus size={14} />Гаралт нэмэх</Button>
    </div>
    {group && <div className="min-w-0">
      <div className="mb-3 flex items-center justify-between gap-3 border-b border-line pb-3">
        <div className="min-w-0"><h3 className="text-sm font-semibold">{selected.date ? displayDate(selected.date) : "Шинэ гаралт"}</h3><p className="break-words text-xs text-ink-muted">{String(records[selected.groupIndex].package_id || group.note || "")}{group.hotel ? ` · ${group.hotel}` : ""}</p></div>
        <button type="button" className={delBtn} title="Гаралт хасах" aria-label="Сонгосон гаралт хасах" onClick={() => {
          if (!window.confirm(`${selected.date ? displayDate(selected.date) : "Энэ"} гаралтыг хасах уу?`)) return;
          const dates = pricingDates(records[selected.groupIndex]).filter((date) => date !== selected.date);
          onChange((current) => current.flatMap((item, index) => index !== selected.groupIndex ? [item] : dates.length ? [{ ...item, dates, date_keys: dates, display_dates: dates }] : []));
          setSelection("");
        }}><Icons.trash size={14} /></button>
      </div>
      <MoneyInput label="Том хүний үнэ" value={group.adult_price != null ? String(group.adult_price) : ""} onChange={(value) => update({ adult_price: value === "" ? null : Number(value), adult_price_range: null })} />
      {bands.map((price, index) => <PassengerBandRow key={index} price={price}
        onChange={(next) => update({ passenger_prices: bands.map((item, i) => i === index ? next : item) })}
        onRemove={() => update({ passenger_prices: bands.filter((_, i) => i !== index) })} />)}
      <div className="flex gap-3 py-3">{["Хүүхэд", "Нярай"].map((label) => <Button key={label} variant="ghost" size="sm" onClick={() => update({ passenger_prices: [...bands, emptyPassengerPrice(label)] })}><Icons.plus size={14} />{label}</Button>)}</div>
      <details className="border-t border-line pt-3" open={!selected.date}><summary className="cursor-pointer text-sm text-ink-muted">Огноо, багц, буудал, тэмдэглэл</summary>
        <div className="mt-3 space-y-3">
          <PriceGroupDateChips dates={selected.date ? [selected.date] : group.dates} onChange={(dates) => {
            update({ dates, display_dates: dates, date_keys: dates });
            setSelection(`${dates[0] || ""}|${selected.groupIndex + (pricingDates(records[selected.groupIndex]).length > 1 && selected.date ? 1 : 0)}`);
          }} />
          <Input label="Үнийн нэр" value={group.label} onChange={(e) => update({ label: e.target.value })} />
          <Input label="Аяллын төрөл" value={group.package_id || ""} onChange={(e) => update({ package_id: e.target.value })} />
          <Input label="Буудал" value={group.hotel || ""} onChange={(e) => update({ hotel: e.target.value })} />
          <Input label="Тэмдэглэл" value={group.note} onChange={(e) => update({ note: e.target.value })} />
        </div>
      </details>
    </div>}
  </div>;
}

function EditorTabButton({
  active,
  label,
  onClick,
  disabled,
  missing,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** A required field on this tab is empty. */
  missing?: boolean;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "relative shrink-0 border-b-2 px-3.5 py-3 text-sm font-medium transition-colors disabled:opacity-50",
        active
          ? "border-brand text-brand"
          : "border-transparent text-ink-muted hover:text-ink",
      )}
    >
      {label}
      {missing && <span className="absolute right-1 top-2 h-2 w-2 rounded-full bg-danger" aria-label="дутуу талбартай" />}
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
  apiFetch,
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
  onAskAi,
}: TripEditModalProps) {
  const [activeTab, setActiveTab] = React.useState<TripEditorTab>("base");
  const [confirmingIncomplete, setConfirmingIncomplete] = React.useState(false);
  const [websiteMediaUploading, setWebsiteMediaUploading] = React.useState(false);

  React.useEffect(() => {
    if (open) setActiveTab("base");
  }, [open, editingTrip?.id, isNewTrip]);

  const editingExtra = (editingTrip?.extra || {}) as Record<string, unknown>;
  const isPosterLinked = typeof editingExtra.poster_trip_id === "string";
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

  const tabs: Array<{ key: TripEditorTab; label: string; gapKeys: string[] }> = [
    { key: "base", label: "Үндсэн", gapKeys: ["route_name", "duration_text"] },
    { key: "pricing", label: "Үнэ ба гаралт", gapKeys: ["adult_price", "child_price", "infant_price", "departure_dates"] },
    { key: "itinerary", label: "Хөтөлбөр", gapKeys: [] },
    { key: "media", label: "Зураг, бичлэг", gapKeys: ["photo_urls"] },
    { key: "terms", label: "Нөхцөл", gapKeys: [] },
    { key: "website", label: "Веб мэдээлэл", gapKeys: [] },
    { key: "advanced", label: "Харьцуулах", gapKeys: [] },
  ];
  const setDays = setTripItineraryDays;
  const moveDay = (from: number, to: number) => setDays((prev) => {
    if (to < 0 || to >= prev.length) return prev;
    const next = [...prev];
    [next[from], next[to]] = [next[to], next[from]];
    return next;
  });

  return (
    <Modal
      open={open}
      onClose={() => { if (!websiteMediaUploading) onClose(); }}
      title={isNewTrip ? "Шинэ аялал нэмэх" : "Аялал засах"}
      description={isNewTrip ? undefined : editingTrip?.route_name || undefined}
      panelClassName="max-w-6xl sm:h-[88dvh]"
      toolbar={
        <div role="tablist" aria-label="Аяллын мэдээлэл" className="-mb-px flex gap-1 overflow-x-auto">
          {tabs.map((tab) => (
            <EditorTabButton
              key={tab.key}
              disabled={websiteMediaUploading}
              active={activeTab === tab.key}
              label={tab.label}
              missing={tab.gapKeys.some((key) => gapKeys.has(key))}
              onClick={() => setActiveTab(tab.key)}
            />
          ))}
        </div>
      }
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
              disabled={saveDisabled || websiteMediaUploading}
              loading={busyKey === "save-trip"}
              onClick={() => onSave(true)}
            >
              Тийм, дутуугаар хадгална
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" disabled={websiteMediaUploading} onClick={onClose}>
              Болих
            </Button>
            <Button disabled={saveDisabled || websiteMediaUploading} loading={busyKey === "save-trip"} onClick={handleSave}>
              Хадгалах
            </Button>
          </>
        )
      }
    >
      {activeTab !== "advanced" && blocking.length > 0 && <GapWarning
        gaps={gaps}
        isNewTrip={isNewTrip}
        onAskAi={
          !isNewTrip && onAskAi && tripDraft.route_name
            ? () => onAskAi(tripDraft.route_name)
            : undefined
        }
      />}

      {activeTab === "base" && (
        <div className="space-y-4">
          <EditorSection title="Аяллын мэдээлэл">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
              <div className="lg:col-span-3">
                <Input
                  label="Аяллын нэр"
                  value={tripDraft.route_name}
                  onChange={(e) => setTripDraft((p) => ({ ...p, route_name: e.target.value }))}
                  error={gapKeys.has("route_name") ? "Заавал бөглөх" : undefined}
                />
              </div>
              <DurationField
                value={tripDraft.duration_text || ""}
                onChange={(duration_text) => setTripDraft((p) => ({ ...p, duration_text }))}
                error={gapKeys.has("duration_text") ? "Заавал бөглөх" : undefined}
              />
              <Select
                label="Төлөв"
                value={tripDraft.status}
                onChange={(e) => setTripDraft((p) => ({ ...p, status: e.target.value }))}
                hint={STATUS_HINT[tripDraft.status]}
              >
                <option value="active">Идэвхтэй</option>
                <option value="sold_out">Суудал дүүрсэн</option>
                <option value="paused">Түр зогссон</option>
                <option value="draft">Ноорог</option>
                <option value="cancelled">Цуцлагдсан</option>
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
              <div className="lg:col-span-3">
                <Input
                  label="Зочид буудал"
                  placeholder="ж: 4* зочид буудал, 2 хүний өрөө"
                  value={tripDraft.hotel}
                  onChange={(e) => setTripDraft((p) => ({ ...p, hotel: e.target.value }))}
                />
              </div>
            </div>
          </EditorSection>

          <EditorSection title="Аяллын тайлбар" hint="Вэбсайтын аяллын хуудсанд тайлбар болж харагдана. Бүтэн өгүүлбэрээр бичнэ.">
            <Textarea
              aria-label="Аяллын тайлбар"
              rows={6}
              className="[field-sizing:content] min-h-36"
              value={tripDraft.notes}
              onChange={(e) => setTripDraft((p) => ({ ...p, notes: e.target.value }))}
            />
          </EditorSection>

          <div className="grid gap-4 lg:grid-cols-2">
            <EditorSection title="Суудал">
              <SeatsFields
                total={tripDraft.seats_total || ""}
                left={tripDraft.seats_left || ""}
                onChange={(patch) => setTripDraft((p) => ({ ...p, ...patch }))}
              />
            </EditorSection>
            <EditorSection title="Хямдралын тэмдэг">
              <SaleBadgeFields
                enabled={tripDraft.sale_badge_enabled === "true"}
                label={tripDraft.sale_badge_label || ""}
                ends={tripDraft.sale_badge_ends || ""}
                onChange={(patch) => setTripDraft((p) => ({ ...p, ...patch }))}
              />
            </EditorSection>
          </div>

          <EditorSection title="Хайлтын нэрс" hint="Хэрэглэгч энэ аяллыг өөрөөр бичвэл (латинаар, товчилж) бот таних нэрс. Бичээд Enter дарна.">
            <ChipsEditor
              ariaLabel="Хайлтын нэр нэмэх"
              values={tripAliases}
              placeholder="ж: <хот> аялал, <city> tour"
              onChange={(values) => setTripAliases(values)}
            />
          </EditorSection>
        </div>
      )}

      {activeTab === "pricing" && (
        <div className="space-y-4">
          {tripPriceGroups.length === 0 ? (
            <EditorSection title="Үнэ ба гарах өдөр" hint="Бүх гаралт ижил үнэтэй бол энд оруулна. Огноо бүр өөр үнэтэй бол доор «Гаралт нэмэх».">
              <div className="grid gap-4 sm:grid-cols-3">
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
                <div className="sm:col-span-3">
                  <DepartureDateEditor
                    value={tripDraft.departure_dates}
                    onChange={(value) => setTripDraft((p) => ({ ...p, departure_dates: value }))}
                    missing={gapKeys.has("departure_dates")}
                  />
                </div>
              </div>
              <TripDatePriceEditor groups={tripPriceGroups} onChange={(updater) => {
                const next = typeof updater === "function" ? updater(tripPriceGroups) : updater;
                setTripPriceGroups(next);
                setTripDraft((current) => ({
                  ...current,
                  departure_dates: joinDepartureDraft(reconcilePricingDates(
                    splitDepartureDraft(current.departure_dates),
                    tripPriceGroups as (PriceGroup & PricingGroup)[],
                    next as (PriceGroup & PricingGroup)[],
                  )),
                }));
              }} />
            </EditorSection>
          ) : (
            <EditorSection title="Гаралт ба үнэ" hint="Зүүн талаас гарах өдрөө сонгоод үнийг нь засна. Огноо бүр өөрийн үнэтэй байж болно.">
              <TripDatePriceEditor groups={tripPriceGroups} onChange={(updater) => {
                const next = typeof updater === "function" ? updater(tripPriceGroups) : updater;
                setTripPriceGroups(next);
                setTripDraft((current) => ({
                  ...current,
                  departure_dates: joinDepartureDraft(reconcilePricingDates(
                    splitDepartureDraft(current.departure_dates),
                    tripPriceGroups as (PriceGroup & PricingGroup)[],
                    next as (PriceGroup & PricingGroup)[],
                  )),
                }));
              }} />
            </EditorSection>
          )}

          {!isNewTrip && editingTrip && apiFetch && <DateSeatsEditor trip={editingTrip} apiFetch={apiFetch} />}

          <EditorSection title="Насны ангилал" hint="Хүүхэд, нярай гэж хэдэн наснаас хэдэн нас хүртэлхийг хэлэх вэ.">
            <div className="grid gap-4 sm:grid-cols-3">
              <Input label="Том хүн" placeholder="ж: 12+ нас" value={tripDraft.age_adult || ""} onChange={(e) => setTripDraft((p) => ({ ...p, age_adult: e.target.value }))} />
              <Input label="Хүүхэд" placeholder="ж: 2-11 нас" value={tripDraft.age_child || ""} onChange={(e) => setTripDraft((p) => ({ ...p, age_child: e.target.value }))} />
              <Input label="Нярай" placeholder="ж: 0-23 сар" value={tripDraft.age_infant || ""} onChange={(e) => setTripDraft((p) => ({ ...p, age_infant: e.target.value }))} />
            </div>
          </EditorSection>

          <EditorSection
            title="Хямдрал"
            hint="Тодорхой огноо эсвэл нөхцөлд (ж: 3+ хүн) хямдарсан үнэ."
          >
            <div className="space-y-3">
              {tripDiscounts.map((g, idx) => {
                const patch = (next: Partial<DiscountGroup>) => setTripDiscounts((prev) => prev.map((v, i) => i === idx ? { ...v, ...next } : v));
                return (
                  <div key={idx} className="rounded-lg border border-line bg-surface-sunken/50 p-3">
                    <div className="mb-3 flex items-center justify-between">
                      <span className="text-sm font-semibold text-ink">{g.label || `Хямдрал ${idx + 1}`}</span>
                      <button type="button" className={delBtn} aria-label="Хямдрал хасах" onClick={() => setTripDiscounts((prev) => prev.filter((_, i) => i !== idx))}>
                        <Icons.trash size={14} />
                      </button>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      <Input label="Нэр" value={g.label} placeholder="ж: Эрт захиалгын хямдрал" onChange={(e) => patch({ label: e.target.value })} />
                      <Input label="Нөхцөл" value={g.condition} placeholder="ж: 3 ба түүнээс дээш хүн" onChange={(e) => patch({ condition: e.target.value })} />
                      <Input label="Огноонууд (таслалаар)" value={g.dates.join(", ")} placeholder="ж: 11 сарын 5, 11 сарын 19" onChange={(e) => patch({ dates: e.target.value.split(",").map((d) => d.trim()).filter(Boolean) })} />
                      <div><FieldLabel>Том хүн</FieldLabel><AmountInput ariaLabel="Том хүний хямдралтай үнэ" value={g.adult_price} onChange={(adult_price) => patch({ adult_price })} /></div>
                      <div><FieldLabel>Хүүхэд</FieldLabel><AmountInput ariaLabel="Хүүхдийн хямдралтай үнэ" value={g.child_price} onChange={(child_price) => patch({ child_price })} /></div>
                      <div><FieldLabel>Нярай</FieldLabel><AmountInput ariaLabel="Нярайн хямдралтай үнэ" value={g.infant_price} onChange={(infant_price) => patch({ infant_price })} /></div>
                      <div className="sm:col-span-2 lg:col-span-3"><Input label="Тайлбар" value={g.note} onChange={(e) => patch({ note: e.target.value })} /></div>
                    </div>
                  </div>
                );
              })}
              <AddRowButton label="Хямдрал нэмэх" onClick={() => setTripDiscounts((prev) => [...prev, emptyDiscountGroup()])} />
            </div>
          </EditorSection>

          <EditorSection title="Нэмэлт төлбөр" hint="Үнэд ороогүй, хүсвэл нэмж төлдөг зүйл (ганц өрөө, нэмэлт үзвэр гэх мэт).">
            <div className="space-y-2">
              {tripExtraFees.length > 0 && (
                <div className="hidden grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_88px_minmax(0,1fr)_minmax(0,1.2fr)_36px] gap-2 px-1 text-xs font-medium text-ink-muted lg:grid">
                  <span>Нэр</span><span>Дүн</span><span>Валют</span><span>Хэнд</span><span>Тайлбар</span><span />
                </div>
              )}
              {tripExtraFees.map((f, idx) => {
                const patch = (next: Partial<ExtraFee>) => setTripExtraFees((prev) => prev.map((v, i) => i === idx ? { ...v, ...next } : v));
                return (
                  <div key={idx} className="grid gap-2 rounded-lg border border-line p-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_88px_minmax(0,1fr)_minmax(0,1.2fr)_36px] lg:border-0 lg:p-0">
                    <input aria-label="Нэр" className={cx(fieldCls, "h-10")} value={f.label} placeholder="ж: Ганц хүний өрөө" onChange={(e) => patch({ label: e.target.value })} />
                    <AmountInput ariaLabel="Дүн" value={f.amount} currency={f.currency} onChange={(amount) => patch({ amount })} />
                    <select aria-label="Валют" className={cx(fieldCls, "h-10")} value={f.currency} onChange={(e) => patch({ currency: e.target.value })}>
                      <option value="MNT">₮</option>
                      <option value="CNY">юань</option>
                      <option value="USD">$</option>
                    </select>
                    <input aria-label="Хэнд хамаарах" className={cx(fieldCls, "h-10")} value={f.applies_to} placeholder="ж: Бүгд" onChange={(e) => patch({ applies_to: e.target.value })} />
                    <input aria-label="Тайлбар" className={cx(fieldCls, "h-10")} value={f.note} placeholder="Тайлбар" onChange={(e) => patch({ note: e.target.value })} />
                    <button type="button" className={cx(delBtn, "h-10 justify-self-end p-2")} aria-label="Нэмэлт төлбөр хасах" onClick={() => setTripExtraFees((prev) => prev.filter((_, i) => i !== idx))}>
                      <Icons.trash size={14} />
                    </button>
                  </div>
                );
              })}
              <AddRowButton label="Нэмэлт төлбөр нэмэх" onClick={() => setTripExtraFees((prev) => [...prev, emptyExtraFee()])} />
            </div>
          </EditorSection>

          <EditorSection title="Гарах өдрийн дүрэм" hint="Тогтмол хуваарьтай аялалд: ж «Пүрэв гараг бүр».">
            <Textarea
              aria-label="Гарах өдрийн дүрэм"
              rows={2}
              value={tripDepartureRule}
              placeholder="ж: Даваа, Лхагва, Баасан гарна"
              onChange={(e) => setTripDepartureRule(e.target.value)}
            />
          </EditorSection>
        </div>
      )}

      {activeTab === "itinerary" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h3 className="text-[15px] font-semibold text-ink">Өдрийн хөтөлбөр · {tripItineraryDays.length} өдөр</h3>
              <p className="mt-0.5 text-xs text-ink-muted">Постер болон вэбсайтад мөн харагдана. Өдрийн зургийг Постер таб дээрээс солино.</p>
            </div>
          </div>
          {tripItineraryDays.map((d, idx) => {
            const patch = (next: Partial<ItineraryDay>) => setDays((prev) => prev.map((v, i) => i === idx ? { ...v, ...next } : v));
            return (
              <details key={idx} open={idx === 0 || !d.title} className="group rounded-xl border border-line bg-surface">
                <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-sm font-bold text-brand">{idx + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-ink">{d.title || "Гарчиггүй өдөр"}</span>
                    <span className="block truncate text-xs text-ink-muted group-open:hidden">{(d.description || "").replace(/\s+/g, " ").slice(0, 140) || "Тайлбаргүй"}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-0.5" onClick={(e) => e.preventDefault()}>
                    <button type="button" className="rounded-md p-1.5 text-ink-muted hover:bg-surface-sunken hover:text-ink disabled:opacity-30" disabled={idx === 0} title="Дээш зөөх" aria-label={`${idx + 1}-р өдрийг дээш зөөх`} onClick={() => moveDay(idx, idx - 1)}>
                      <Icons.chevronRight size={14} className="-rotate-90" />
                    </button>
                    <button type="button" className="rounded-md p-1.5 text-ink-muted hover:bg-surface-sunken hover:text-ink disabled:opacity-30" disabled={idx === tripItineraryDays.length - 1} title="Доош зөөх" aria-label={`${idx + 1}-р өдрийг доош зөөх`} onClick={() => moveDay(idx, idx + 1)}>
                      <Icons.chevronRight size={14} className="rotate-90" />
                    </button>
                    <button type="button" className={delBtn} title="Өдөр хасах" aria-label={`${idx + 1}-р өдрийг хасах`} onClick={() => {
                      if (window.confirm(`${idx + 1}-р өдрийг хасах уу?`)) setDays((prev) => prev.filter((_, i) => i !== idx));
                    }}>
                      <Icons.trash size={14} />
                    </button>
                  </span>
                  <Icons.chevronRight size={16} className="shrink-0 rotate-90 text-ink-subtle transition-transform group-open:-rotate-90" />
                </summary>
                <div className="space-y-3 border-t border-line px-4 pb-4 pt-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Input label="Гарчиг / чиглэл" value={d.title} placeholder="ж: УЛААНБААТАР – ЗАМЫН ҮҮД" onChange={(e) => patch({ title: e.target.value })} />
                    <Input label="Зочид буудал" value={d.hotel || ""} placeholder="Хоноглох газар (галт тэрэг, буудал…)" onChange={(e) => patch({ hotel: e.target.value })} />
                  </div>
                  <Textarea
                    label="Тайлбар"
                    rows={4}
                    className="[field-sizing:content] min-h-28"
                    value={d.description}
                    placeholder="Энэ өдөр юу хийх вэ…"
                    onChange={(e) => patch({ description: e.target.value })}
                  />
                  <DayPhotoPreview photo={d.photo} title={d.title || `Өдөр ${idx + 1}`} />
                  <DayMealToggles
                    meals={d.meals}
                    onToggle={(key) => setDays((prev) => prev.map((v, i) =>
                      i === idx ? { ...v, meals: { ...v.meals, [key]: !v.meals?.[key] } } : v,
                    ))}
                  />
                </div>
              </details>
            );
          })}
          <AddRowButton label="Өдөр нэмэх" onClick={() => setDays((prev) => [...prev, emptyItineraryDay(prev.length + 1)])} />
        </div>
      )}

      {activeTab === "media" && (
        <div className="space-y-4">
          {isPosterLinked ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-success/25 bg-success-soft px-4 py-3 text-sm text-success">
              <div className="min-w-0">
                <p className="font-semibold">Аяллын зураг постероос ирнэ</p>
                <p className="mt-0.5 text-xs text-success/80">Зураг нэмэх, солихыг Постер таб дээр хийнэ. Бот болон вэбсайт тэндээс авна.</p>
              </div>
              {brochurePdfUrl && (
                <a href={brochurePdfUrl} target="_blank" rel="noopener noreferrer" className="rounded-md bg-surface px-3 py-1.5 text-xs font-semibold text-success shadow-xs hover:underline">
                  PDF нээх
                </a>
              )}
            </div>
          ) : (
            <EditorSection title="Аяллын зургууд" hint="Хэрэглэгч энэ аяллыг асуухад бот эдгээр зургийг илгээнэ.">
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
                <Icons.upload size={24} className={gapKeys.has("photo_urls") ? "text-danger" : "text-ink-subtle"} />
                <p className="text-sm font-medium text-ink">Зураг чирж оруулах эсвэл дарж сонгох</p>
                <p className="text-xs text-ink-subtle">PNG, JPG, WEBP — хамгийн ихдээ 10MB</p>
                {gapKeys.has("photo_urls") && <p className="text-xs font-medium text-danger">Заавал бөглөх — зураг дутуу</p>}
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
                <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-6">
                  {tripPhotoUrls.map((url, idx) => (
                    <div key={idx} className="group relative aspect-[4/3] overflow-hidden rounded-lg border border-line">
                      <a href={url} target="_blank" rel="noopener noreferrer" className="block h-full w-full" title="Бүтэн зураг харах">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={url} alt={`Зураг ${idx + 1}`} className="h-full w-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                      </a>
                      <button
                        type="button"
                        onClick={() => setTripPhotoUrls((prev) => prev.filter((_, i) => i !== idx))}
                        className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
                        aria-label={`${idx + 1}-р зургийг устгах`}
                      >
                        <Icons.trash size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-3 flex gap-2">
                <input
                  type="url"
                  aria-label="Зургийн холбоос"
                  value={tripPhotoInput}
                  onChange={(e) => setTripPhotoInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    const url = tripPhotoInput.trim();
                    if (url.startsWith("https://") && tripPhotoUrls.length < MAX_PHOTOS_PER_TRIP) {
                      setTripPhotoUrls((prev) => [...prev, url]);
                      setTripPhotoInput("");
                    }
                  }}
                  placeholder="Эсвэл зургийн холбоос: https://…"
                  className={cx(fieldCls, "h-10 flex-1")}
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
            </EditorSection>
          )}
          <WebsiteTripFields scope="media" trip={editingTrip} draft={tripDraft.websiteDetails} onChange={(websiteDetails) => setTripDraft((previous) => ({ ...previous, websiteDetails }))} apiFetch={apiFetch} onBusyChange={setWebsiteMediaUploading} />
        </div>
      )}

      {activeTab === "terms" && (
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <EditorSection title="Үнэд багтсан" hint="Нэг мөрөнд нэг зүйл. Enter дарвал дараагийн мөр.">
              <ListEditor ariaLabel="Багтсан зүйл" tone="good" items={tripIncludedItems} onChange={setTripIncludedItems} placeholder="ж: Зочид буудал" addLabel="Зүйл нэмэх" />
            </EditorSection>
            <EditorSection title="Үнэд багтаагүй" hint="Нэг мөрөнд нэг зүйл. Enter дарвал дараагийн мөр.">
              <ListEditor ariaLabel="Багтаагүй зүйл" tone="bad" items={tripExcludedItems} onChange={setTripExcludedItems} placeholder="ж: Визний хураамж" addLabel="Зүйл нэмэх" />
            </EditorSection>
          </div>

          <EditorSection title="Чухал тэмдэглэл" hint="Аялагчийн заавал мэдэх зүйл (паспорт, авч явах зүйл…).">
            <ListEditor ariaLabel="Чухал тэмдэглэл" items={tripImportantNotes} onChange={setTripImportantNotes} placeholder="ж: Паспортын хүчинтэй хугацаа 6 сараас дээш байна" addLabel="Тэмдэглэл нэмэх" />
          </EditorSection>

          <EditorSection title="Захиалгын нөхцөл" hint="Хоосон орхисон зүйлийг бот «тодорхойгүй» гээд ажилтанд шилжүүлнэ — зохиож хариулахгүй.">
            <div className="grid gap-4 lg:grid-cols-2">
              <Textarea label="Урьдчилгаа" rows={2} value={tripBookingTerms.deposit} placeholder="ж: Урьдчилгаа …₮, үлдэгдлийг гарахаас 7 хоногийн өмнө" onChange={(e) => setTripBookingTerms((p) => ({ ...p, deposit: e.target.value }))} />
              <Textarea label="Төлбөрийн нөхцөл" rows={2} value={tripBookingTerms.payment} placeholder="ж: Дансаар, 2 хуваан төлж болно" onChange={(e) => setTripBookingTerms((p) => ({ ...p, payment: e.target.value }))} />
              <Textarea label="Бүрдүүлэх бичиг баримт" rows={2} value={tripBookingTerms.documents} placeholder="ж: Гадаад паспорт, 2 хувь цээж зураг" onChange={(e) => setTripBookingTerms((p) => ({ ...p, documents: e.target.value }))} />
              <Textarea label="Виз" rows={2} value={tripBookingTerms.visa} placeholder="ж: Виз шаардлагатай эсэх" onChange={(e) => setTripBookingTerms((p) => ({ ...p, visa: e.target.value }))} />
              <div className="lg:col-span-2">
                <Textarea label="Цуцлалт / буцаан олголт" rows={2} value={tripBookingTerms.cancellation} placeholder="ж: Гарахаас 14 хоногийн өмнө цуцлавал урьдчилгаа буцаана" onChange={(e) => setTripBookingTerms((p) => ({ ...p, cancellation: e.target.value }))} />
              </div>
            </div>
          </EditorSection>

          <EditorSection title="Өрөөний үнэ" hint="Өрөөний төрлөөс хамаарч үнэ өөр бол.">
            <div className="space-y-2">
              {tripRoomPrices.map((r, idx) => {
                const patch = (next: Partial<RoomPrice>) => setTripRoomPrices((prev) => prev.map((v, i) => i === idx ? { ...v, ...next } : v));
                return (
                  <div key={idx} className="grid gap-2 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_88px_minmax(0,1.2fr)_36px]">
                    <input aria-label="Өрөөний төрөл" className={cx(fieldCls, "h-10")} value={r.room_type} placeholder="ж: Ганц хүний өрөө" onChange={(e) => patch({ room_type: e.target.value })} />
                    <AmountInput ariaLabel="Өрөөний үнэ" value={r.price} currency={r.currency} onChange={(price) => patch({ price })} />
                    <select aria-label="Валют" className={cx(fieldCls, "h-10")} value={r.currency} onChange={(e) => patch({ currency: e.target.value })}>
                      <option value="MNT">₮</option>
                      <option value="CNY">юань</option>
                      <option value="USD">$</option>
                    </select>
                    <input aria-label="Тайлбар" className={cx(fieldCls, "h-10")} value={r.note} placeholder="Тайлбар" onChange={(e) => patch({ note: e.target.value })} />
                    <button type="button" className={cx(delBtn, "h-10 justify-self-end p-2")} aria-label="Өрөө хасах" onClick={() => setTripRoomPrices((prev) => prev.filter((_, i) => i !== idx))}>
                      <Icons.trash size={14} />
                    </button>
                  </div>
                );
              })}
              <AddRowButton label="Өрөө нэмэх" onClick={() => setTripRoomPrices((prev) => [...prev, emptyRoomPrice()])} />
            </div>
          </EditorSection>
        </div>
      )}

      {activeTab === "website" && <WebsiteTripFields trip={editingTrip} draft={tripDraft.websiteDetails} onChange={(websiteDetails) => setTripDraft((previous) => ({ ...previous, websiteDetails }))} />}

      {activeTab === "advanced" && (
        <div className="space-y-4">
          <GapWarning gaps={gaps} isNewTrip={isNewTrip} onAskAi={!isNewTrip && onAskAi && tripDraft.route_name ? () => onAskAi(tripDraft.route_name) : undefined} />
          <EditorSection title="Чатбот ба вэбсайт" hint="Хоёр талд ижил байх ёстой мэдээлэл. Зөрүүтэй бол доор харагдана.">
            <TripTextComparison trip={editingTrip} />
          </EditorSection>

          <EditorSection title="Тохиргоо">
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-ink">Бот энэ аяллын талаар хариулна</p>
                  <p className="text-xs text-ink-subtle">Унтраавал бот энэ аяллыг мэдэхгүй мэт хандана.</p>
                </div>
                <Switch label="Ботод харагдана" checked={tripCustomerVisible} onChange={setTripCustomerVisible} />
              </div>
              <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
                <div>
                  <p className="text-sm font-medium text-ink">Ажилтан шалгах шаардлагатай</p>
                  <p className="text-xs text-ink-subtle">Мэдээлэл эргэлзээтэй бол тэмдэглэнэ.</p>
                </div>
                <Switch label="Хүний шалгалт" checked={tripNeedsHumanReview} onChange={setTripNeedsHumanReview} />
              </div>
              {tripNeedsHumanReview && (
                <ListEditor ariaLabel="Шалгах шалтгаан" items={tripReviewReasons} onChange={setTripReviewReasons} placeholder="ж: Огноо таарахгүй байна" addLabel="Шалтгаан нэмэх" />
              )}
            </div>
          </EditorSection>

          {tripSourceProvenance.length > 0 && (
            <EditorSection title="Эх сурвалж" hint="AI файлаас уншсан хэсгүүд.">
              <div className="space-y-2">
                {tripSourceProvenance.map((sp, idx) => (
                  <div key={idx} className="rounded-lg border border-line bg-surface-sunken p-2.5 text-xs text-ink-muted">
                    <div className="flex items-center gap-2 font-medium text-ink">
                      <span className="truncate">{sp.file_name}</span>
                      {sp.page !== null && <span className="shrink-0 text-ink-subtle">— {sp.page}-р хуудас</span>}
                      <span className={cx(
                        "ml-auto shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
                        sp.confidence === "high" ? "bg-success-soft text-success" : sp.confidence === "medium" ? "bg-warning-soft text-warning" : "bg-danger-soft text-danger",
                      )}>
                        {sp.confidence === "high" ? "Итгэл өндөр" : sp.confidence === "medium" ? "Дунд" : "Бага"}
                      </span>
                    </div>
                    <p className="mt-1 text-ink-subtle">{sp.source_text}</p>
                  </div>
                ))}
              </div>
            </EditorSection>
          )}

          <EditorSection title="Хариултын заавар" hint="Тодорхой асуултад бот яг ингэж хариул гэсэн заавар.">
            <div className="space-y-3">
              {tripAnswerHints.map((h, idx) => {
                const patch = (next: Partial<AnswerHint>) => setTripAnswerHints((prev) => prev.map((v, i) => i === idx ? { ...v, ...next } : v));
                return (
                  <div key={idx} className="rounded-lg border border-line bg-surface-sunken/50 p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-sm font-semibold text-ink">Заавар {idx + 1}</span>
                      <button type="button" className={delBtn} aria-label="Заавар хасах" onClick={() => setTripAnswerHints((prev) => prev.filter((_, i) => i !== idx))}>
                        <Icons.trash size={14} />
                      </button>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Select label="Сэдэв" value={h.intent} onChange={(e) => patch({ intent: e.target.value as AnswerHint["intent"] })}>
                        <option value="price">Үнэ</option>
                        <option value="discount">Хямдрал</option>
                        <option value="comparison">Харьцуулалт</option>
                        <option value="child_price">Хүүхдийн үнэ</option>
                        <option value="included">Багтсан зүйл</option>
                        <option value="schedule">Хуваарь</option>
                      </Select>
                      <Input label="Асуулт" value={h.question_pattern} placeholder="ж: * үнэ хэд вэ?" onChange={(e) => patch({ question_pattern: e.target.value })} />
                      <div className="sm:col-span-2">
                        <Input label="Хариулт" value={h.expected_answer_summary} placeholder="Ботын өгөх хариулт" onChange={(e) => patch({ expected_answer_summary: e.target.value })} />
                      </div>
                    </div>
                  </div>
                );
              })}
              <AddRowButton label="Заавар нэмэх" onClick={() => setTripAnswerHints((prev) => [...prev, { intent: "price", question_pattern: "", expected_answer_summary: "" }])} />
            </div>
          </EditorSection>
        </div>
      )}
    </Modal>
  );
}

const STATUS_HINT: Record<string, string | undefined> = {
  active: "Бот болон вэбсайт дээр харагдана.",
  sold_out: "Вэбсайт дээр харагдана, «Суудал дүүрсэн» гэж гарна.",
  paused: "Түр нуугдана.",
  draft: "Хэрэглэгчид харагдахгүй.",
  cancelled: "Хэрэглэгчид харагдахгүй.",
  archived: "Хэрэглэгчид харагдахгүй.",
};

function AddRowButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-line-strong py-2.5 text-sm font-medium text-ink-muted transition-colors hover:border-brand hover:bg-brand-soft/40 hover:text-brand"
    >
      <Icons.plus size={14} />
      {label}
    </button>
  );
}
