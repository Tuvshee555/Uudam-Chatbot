import React from "react";
import { Button, Icons, Input, Modal, Select, Spinner, Textarea, cx } from "@/components/ui";
import type { AnswerHint, ChildRule, DiscountGroup, ExtraFee, PassengerPrice, PriceGroup, RoomPrice, SourceProvenance, TravelTrip } from "@/lib/adminTypes";

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
  busyKey: string;
  handlePhotoFiles: (files: FileList | File[]) => void;
  onClose: () => void;
  onSave: () => void;
  // Structured fields
  tripAliases: string[];
  setTripAliases: React.Dispatch<React.SetStateAction<string[]>>;
  tripPriceGroups: PriceGroup[];
  setTripPriceGroups: React.Dispatch<React.SetStateAction<PriceGroup[]>>;
  tripDiscounts: DiscountGroup[];
  setTripDiscounts: React.Dispatch<React.SetStateAction<DiscountGroup[]>>;
  tripChildRules: ChildRule[];
  setTripChildRules: React.Dispatch<React.SetStateAction<ChildRule[]>>;
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
  tripImportantNotes: string[];
  setTripImportantNotes: React.Dispatch<React.SetStateAction<string[]>>;
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

const inputCls = "w-full rounded-lg border border-line-strong bg-surface-sunken px-3 py-1.5 text-sm text-ink placeholder:text-ink-subtle focus:border-brand focus:outline-none";
const numCls = inputCls;
const sectionHdr = "mt-5 text-sm font-semibold text-ink";
const rowCls = "flex items-start gap-1.5";
const delBtn = "shrink-0 rounded-md p-1 text-ink-muted hover:bg-surface-sunken hover:text-red-500";

function emptyPassengerPrice(): PassengerPrice {
  return { label: "", age_range: "", price: null, currency: "MNT" };
}
function emptyPriceGroup(): PriceGroup {
  return { label: "", dates: [], display_dates: [], date_keys: [], adult_price: null, child_price: null, infant_price: null, child_age: "", infant_age: "", passenger_prices: [], note: "" };
}
function emptyDiscountGroup(): DiscountGroup {
  return { label: "", dates: [], display_dates: [], date_keys: [], adult_price: null, child_price: null, infant_price: null, condition: "", note: "" };
}
function emptyChildRule(): ChildRule {
  return { label: "", age_range: "", price: null, currency: "MNT", note: "" };
}
function emptyExtraFee(): ExtraFee {
  return { label: "", amount: null, currency: "MNT", applies_to: "", note: "" };
}
function emptyRoomPrice(): RoomPrice {
  return { room_type: "", price: null, currency: "MNT", note: "" };
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
  tripChildRules,
  setTripChildRules,
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
  tripImportantNotes,
  setTripImportantNotes,
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
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isNewTrip ? "Шинэ аялал нэмэх" : "Аялал засах"}
      description={isNewTrip ? undefined : editingTrip?.route_name || undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Болих
          </Button>
          <Button loading={busyKey === "save-trip"} onClick={onSave}>
            Хадгалах
          </Button>
        </>
      }
    >
      {/* Base fields */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          label="Маршрут"
          value={tripDraft.route_name}
          onChange={(e) => setTripDraft((p) => ({ ...p, route_name: e.target.value }))}
        />
        <Input
          label="Оператор"
          value={tripDraft.operator_name}
          onChange={(e) => setTripDraft((p) => ({ ...p, operator_name: e.target.value }))}
        />
        <Input
          label="Ангилал"
          value={tripDraft.category}
          onChange={(e) => setTripDraft((p) => ({ ...p, category: e.target.value }))}
        />
        <Input
          label="Хугацаа (ж: 5ш6ө)"
          value={tripDraft.duration_text}
          onChange={(e) => setTripDraft((p) => ({ ...p, duration_text: e.target.value }))}
        />
        <Input
          label="Том хүний үнэ"
          inputMode="numeric"
          value={tripDraft.adult_price}
          onChange={(e) => setTripDraft((p) => ({ ...p, adult_price: e.target.value }))}
        />
        <Input
          label="Хүүхдийн үнэ"
          inputMode="numeric"
          value={tripDraft.child_price}
          onChange={(e) => setTripDraft((p) => ({ ...p, child_price: e.target.value }))}
        />
        <Select
          label="Валют"
          value={tripDraft.currency}
          onChange={(e) => setTripDraft((p) => ({ ...p, currency: e.target.value }))}
        >
          <option value="MNT">MNT (₮)</option>
          <option value="CNY">CNY (юань)</option>
          <option value="USD">USD ($)</option>
        </Select>
        <Select
          label="Төлөв"
          value={tripDraft.status}
          onChange={(e) => setTripDraft((p) => ({ ...p, status: e.target.value }))}
        >
          <option value="active">Идэвхтэй</option>
          <option value="cancelled">Цуцлагдсан</option>
          <option value="sold_out">Суудал дууссан</option>
          <option value="draft">Ноорог</option>
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
          label="Гарах өдөр (таслалаар)"
          value={tripDraft.departure_dates}
          onChange={(e) => setTripDraft((p) => ({ ...p, departure_dates: e.target.value }))}
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
          label="Эх сурвалжийн тайлбар"
          rows={2}
          value={tripDraft.source_description}
          onChange={(e) => setTripDraft((p) => ({ ...p, source_description: e.target.value }))}
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

      {/* Photo URL editor */}
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
              : "border-line-strong bg-surface-sunken hover:border-brand",
          )}
        >
          <Icons.download size={24} className="text-ink-subtle" />
          <p className="text-sm font-medium text-ink">Зураг чирж оруулах эсвэл дарж сонгох</p>
          <p className="text-xs text-ink-subtle">PNG, JPG, WEBP — хамгийн ихдээ 10MB</p>
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
          </div>
        )}
        {tripPhotoUrls.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {tripPhotoUrls.map((url, idx) => (
              <div key={idx} className="group relative h-20 w-20 overflow-hidden rounded-lg border border-line">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={url}
                  alt={`Зураг ${idx + 1}`}
                  className="h-full w-full object-cover"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                />
                <button
                  type="button"
                  onClick={() => setTripPhotoUrls((prev) => prev.filter((_, i) => i !== idx))}
                  className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100"
                  aria-label="Устгах"
                >
                  <Icons.trash size={16} className="text-white" />
                </button>
              </div>
            ))}
          </div>
        )}
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
                if (url.startsWith("https://") && tripPhotoUrls.length < 20) {
                  setTripPhotoUrls((prev) => [...prev, url]);
                  setTripPhotoInput("");
                }
              }
            }}
            placeholder="https://example.com/photo.jpg"
            className="flex-1 rounded-lg border border-line-strong bg-surface-sunken px-3 py-2 text-sm text-ink placeholder:text-ink-subtle focus:border-brand focus:outline-none"
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={!tripPhotoInput.trim().startsWith("https://") || tripPhotoUrls.length >= 20}
            onClick={() => {
              const url = tripPhotoInput.trim();
              if (url.startsWith("https://") && tripPhotoUrls.length < 20) {
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

      {/* B. Price groups */}
      <p className={sectionHdr}>Огноо тус бүрийн үнэ</p>
      <div className="mt-2 space-y-3">
        {tripPriceGroups.map((g, idx) => (
          <div key={idx} className="rounded-lg border border-line bg-surface-sunken p-3 text-sm">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-ink-muted">Бүлэг {idx + 1}</span>
              <button type="button" className={delBtn} onClick={() => setTripPriceGroups((prev) => prev.filter((_, i) => i !== idx))}>
                <Icons.trash size={13} />
              </button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <label className="mb-0.5 block text-xs text-ink-muted">Бүлгийн нэр</label>
                <input className={inputCls} value={g.label} onChange={(e) => setTripPriceGroups((prev) => prev.map((v, i) => i === idx ? { ...v, label: e.target.value } : v))} />
              </div>
              <div>
                <label className="mb-0.5 block text-xs text-ink-muted">Огноонууд (таслалаар)</label>
                <input className={inputCls} value={g.dates.join(", ")} placeholder="ж: 7/5, 7/12, 7/19" onChange={(e) => setTripPriceGroups((prev) => prev.map((v, i) => i === idx ? { ...v, dates: e.target.value.split(",").map((d) => d.trim()).filter(Boolean) } : v))} />
              </div>
              <div>
                <label className="mb-0.5 block text-xs text-ink-muted">Том хүний үнэ</label>
                <input className={numCls} type="number" value={g.adult_price ?? ""} onChange={(e) => setTripPriceGroups((prev) => prev.map((v, i) => i === idx ? { ...v, adult_price: e.target.value === "" ? null : Number(e.target.value) } : v))} />
              </div>
              <div>
                <label className="mb-0.5 block text-xs text-ink-muted">Хүүхдийн үнэ</label>
                <input className={numCls} type="number" value={g.child_price ?? ""} onChange={(e) => setTripPriceGroups((prev) => prev.map((v, i) => i === idx ? { ...v, child_price: e.target.value === "" ? null : Number(e.target.value) } : v))} />
              </div>
              <div>
                <label className="mb-0.5 block text-xs text-ink-muted">Хүүхдийн нас (ж: 2-12)</label>
                <input className={inputCls} value={g.child_age} onChange={(e) => setTripPriceGroups((prev) => prev.map((v, i) => i === idx ? { ...v, child_age: e.target.value } : v))} />
              </div>
              <div>
                <label className="mb-0.5 block text-xs text-ink-muted">Нярайн үнэ</label>
                <input className={numCls} type="number" value={g.infant_price ?? ""} onChange={(e) => setTripPriceGroups((prev) => prev.map((v, i) => i === idx ? { ...v, infant_price: e.target.value === "" ? null : Number(e.target.value) } : v))} />
              </div>
              <div>
                <label className="mb-0.5 block text-xs text-ink-muted">Нярайн нас (ж: 0-2)</label>
                <input className={inputCls} value={g.infant_age} onChange={(e) => setTripPriceGroups((prev) => prev.map((v, i) => i === idx ? { ...v, infant_age: e.target.value } : v))} />
              </div>
              <div className="sm:col-span-2">
                <label className="mb-0.5 block text-xs text-ink-muted">Тайлбар</label>
                <input className={inputCls} value={g.note} onChange={(e) => setTripPriceGroups((prev) => prev.map((v, i) => i === idx ? { ...v, note: e.target.value } : v))} />
              </div>
            </div>
            {/* passenger_prices sub-editor */}
            <div className="mt-2">
              <p className="mb-1 text-xs font-medium text-ink-muted">Зорчигчийн үнэ (нарийвчилсан)</p>
              {(g.passenger_prices ?? []).map((pp, ppIdx) => (
                <div key={ppIdx} className="mb-1 grid gap-1.5 rounded border border-line bg-surface p-2 sm:grid-cols-5">
                  <div>
                    <label className="mb-0.5 block text-xs text-ink-subtle">Нэр</label>
                    <input className={inputCls} value={pp.label} placeholder="Том хүн" onChange={(e) => setTripPriceGroups((prev) => prev.map((v, i) => i === idx ? { ...v, passenger_prices: v.passenger_prices.map((p2, j) => j === ppIdx ? { ...p2, label: e.target.value } : p2) } : v))} />
                  </div>
                  <div>
                    <label className="mb-0.5 block text-xs text-ink-subtle">Нас</label>
                    <input className={inputCls} value={pp.age_range} placeholder="2-12" onChange={(e) => setTripPriceGroups((prev) => prev.map((v, i) => i === idx ? { ...v, passenger_prices: v.passenger_prices.map((p2, j) => j === ppIdx ? { ...p2, age_range: e.target.value } : p2) } : v))} />
                  </div>
                  <div>
                    <label className="mb-0.5 block text-xs text-ink-subtle">Үнэ</label>
                    <input className={numCls} type="number" value={pp.price ?? ""} onChange={(e) => setTripPriceGroups((prev) => prev.map((v, i) => i === idx ? { ...v, passenger_prices: v.passenger_prices.map((p2, j) => j === ppIdx ? { ...p2, price: e.target.value === "" ? null : Number(e.target.value) } : p2) } : v))} />
                  </div>
                  <div>
                    <label className="mb-0.5 block text-xs text-ink-subtle">Валют</label>
                    <select className={inputCls} value={pp.currency} onChange={(e) => setTripPriceGroups((prev) => prev.map((v, i) => i === idx ? { ...v, passenger_prices: v.passenger_prices.map((p2, j) => j === ppIdx ? { ...p2, currency: e.target.value } : p2) } : v))}>
                      <option value="MNT">MNT</option>
                      <option value="CNY">CNY</option>
                      <option value="USD">USD</option>
                    </select>
                  </div>
                  <div className="flex items-end">
                    <button type="button" className={delBtn} onClick={() => setTripPriceGroups((prev) => prev.map((v, i) => i === idx ? { ...v, passenger_prices: v.passenger_prices.filter((_, j) => j !== ppIdx) } : v))}>
                      <Icons.trash size={13} />
                    </button>
                  </div>
                </div>
              ))}
              <button type="button" className="text-xs text-brand hover:underline" onClick={() => setTripPriceGroups((prev) => prev.map((v, i) => i === idx ? { ...v, passenger_prices: [...(v.passenger_prices ?? []), emptyPassengerPrice()] } : v))}>
                + Зорчигч нэмэх
              </button>
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

      {/* D. Child rules */}
      <p className={sectionHdr}>Хүүхдийн насны ангилал</p>
      <div className="mt-2 space-y-2">
        {tripChildRules.map((r, idx) => (
          <div key={idx} className="grid gap-2 rounded-lg border border-line bg-surface-sunken p-2 sm:grid-cols-5">
            <div>
              <label className="mb-0.5 block text-xs text-ink-muted">Ангилал</label>
              <input className={inputCls} value={r.label} placeholder="ж: Хүүхэд" onChange={(e) => setTripChildRules((prev) => prev.map((v, i) => i === idx ? { ...v, label: e.target.value } : v))} />
            </div>
            <div>
              <label className="mb-0.5 block text-xs text-ink-muted">Нас</label>
              <input className={inputCls} value={r.age_range} placeholder="ж: 2-12" onChange={(e) => setTripChildRules((prev) => prev.map((v, i) => i === idx ? { ...v, age_range: e.target.value } : v))} />
            </div>
            <div>
              <label className="mb-0.5 block text-xs text-ink-muted">Үнэ</label>
              <input className={numCls} type="number" value={r.price ?? ""} onChange={(e) => setTripChildRules((prev) => prev.map((v, i) => i === idx ? { ...v, price: e.target.value === "" ? null : Number(e.target.value) } : v))} />
            </div>
            <div>
              <label className="mb-0.5 block text-xs text-ink-muted">Валют</label>
              <select className={inputCls} value={r.currency ?? "MNT"} onChange={(e) => setTripChildRules((prev) => prev.map((v, i) => i === idx ? { ...v, currency: e.target.value } : v))}>
                <option value="MNT">MNT</option>
                <option value="CNY">CNY</option>
                <option value="USD">USD</option>
              </select>
            </div>
            <div className="flex gap-1">
              <div className="flex-1">
                <label className="mb-0.5 block text-xs text-ink-muted">Тайлбар</label>
                <input className={inputCls} value={r.note} onChange={(e) => setTripChildRules((prev) => prev.map((v, i) => i === idx ? { ...v, note: e.target.value } : v))} />
              </div>
              <button type="button" className={cx(delBtn, "mt-5")} onClick={() => setTripChildRules((prev) => prev.filter((_, i) => i !== idx))}>
                <Icons.trash size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>
      <button type="button" className="mt-1 text-xs text-brand hover:underline" onClick={() => setTripChildRules((prev) => [...prev, emptyChildRule()])}>
        + Насны ангилал нэмэх
      </button>

      {/* E. Extra fees */}
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

      {/* F. Departure rule */}
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
                <input className={inputCls} value={h.expected_answer_summary} placeholder="ж: 3,290,000₮ буюу …" onChange={(e) => setTripAnswerHints((prev) => prev.map((v, i) => i === idx ? { ...v, expected_answer_summary: e.target.value } : v))} />
              </div>
            </div>
          </div>
        ))}
      </div>
      <button type="button" className="mt-1 mb-2 text-xs text-brand hover:underline" onClick={() => setTripAnswerHints((prev) => [...prev, { intent: "price", question_pattern: "", expected_answer_summary: "" }])}>
        + Заавар нэмэх
      </button>
    </Modal>
  );
}
