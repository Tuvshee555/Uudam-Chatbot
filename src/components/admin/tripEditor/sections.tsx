/**
 * The editor's sections. Each one receives the same editor state the modal used
 * to, so the save path in admin.tsx is untouched; only the layout is new.
 */
import React from "react";
import { Button, Icons, Spinner, Switch, cx } from "@/components/ui";
import { DayMealToggles, DayPhotoPreview } from "../ItineraryDayControls";
import { DateSeatsEditor } from "../DateSeatsEditor";
import { WebsiteTripFields, TripTextComparison } from "../WebsiteTripFields";
import { ChipsEditor, ListEditor, SaleBadgeFields, formatDuration, parseDuration } from "../TripEditorParts";
import { TripDescriptionEditor } from "../TripDescriptionEditor";
import { MAX_PHOTOS_PER_TRIP } from "@/lib/tripPhotoImport/types";
import { reconcilePricingDates, type PricingGroup } from "@/lib/adminDatePricing";
import type { AnswerHint, DiscountGroup, ExtraFee, ItineraryDay, PriceGroup, RoomPrice } from "@/lib/adminTypes";
import type { TripEditorProps } from "./TripEditor";
import { AddRowButton, Checkbox, CountInput, EmptyHint, Field, Group, MoneyField, RemoveButton, RowCard, SectionHeader, SelectInput, SwitchRow, TextArea, TextInput } from "./parts";
import { DateChips, TripDatePriceEditor, emptyPriceGroup, joinDepartureDraft, splitDepartureDraft } from "./PricingEditor";

export type SectionProps = TripEditorProps & {
  /** A required value is still empty and the admin has already tried to save. */
  missing: (key: string) => boolean;
  brochurePdfUrl: string | null;
  isPosterLinked: boolean;
  onWebsiteMediaBusy: (busy: boolean) => void;
};

const CURRENCIES = [["MNT", "₮"], ["CNY", "юань"], ["USD", "$"]] as const;

/* ------------------------------------------------------------------ basics */
export function BasicsSection(p: SectionProps) {
  const { tripDraft, setTripDraft } = p;
  const { days, nights } = parseDuration(tripDraft.duration_text || "");
  const durationMissing = p.missing("duration_text");
  const unreadable = Boolean((tripDraft.duration_text || "").trim()) && days == null && nights == null;
  const total = toCount(tripDraft.seats_total), left = toCount(tripDraft.seats_left);
  const tooMany = total != null && left != null && left > total;
  return (
    <>
      <SectionHeader title="Үндсэн мэдээлэл" description="Аяллын нэр, хугацаа, тайлбар. Чатбот хариулахдаа, вэбсайт аяллын хуудсандаа энэ мэдээллийг хэрэглэнэ." audiences={["bot", "website"]} />
      <Group>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="trip-route-name" label="Аяллын нэр" required missing={p.missing("route_name")} anchor="route_name" className="sm:col-span-2" hint="Хэрэглэгчийн таних нэр. Огноог нэрэнд бичихгүй, «Гарах өдөр» хэсэгт оруулна.">
            <TextInput id="trip-route-name" value={tripDraft.route_name} missing={p.missing("route_name")} placeholder="ж: Далайн эргийн амралт" onChange={(e) => setTripDraft((d) => ({ ...d, route_name: e.target.value }))} />
          </Field>
          <Field label="Хугацаа" required missing={durationMissing} anchor="duration_text"
            hint={unreadable ? `Одоо бичигдсэн: «${tripDraft.duration_text}». Тоогоор нь дахин оруулна уу.` : days != null && nights != null && nights > days ? "Шөнө өдрөөс олон байна. Шалгана уу." : "Өдрийг оруулахад шөнө нэгээр цөөн гэж өөрөө бөглөгдөнө."}>
            <div className="grid grid-cols-2 gap-2">
              <CountInput ariaLabel="Өдөр" unit="өдөр" min={1} max={60} value={days} missing={durationMissing} onChange={(next) => {
                const nightsFollowed = nights == null || days == null || nights === days - 1;
                setTripDraft((d) => ({ ...d, duration_text: formatDuration(next, nightsFollowed && next != null ? Math.max(0, next - 1) : nights) }));
              }} />
              <CountInput ariaLabel="Шөнө" unit="шөнө" min={0} max={60} value={nights} missing={durationMissing} onChange={(next) => setTripDraft((d) => ({ ...d, duration_text: formatDuration(days, next) }))} />
            </div>
          </Field>
          <Field id="trip-food" label="Хоол">
            <SelectInput id="trip-food" value={tripDraft.has_food} onChange={(e) => setTripDraft((d) => ({ ...d, has_food: e.target.value }))}>
              <option value="unknown">Тодорхойгүй</option>
              <option value="true">Үнэд багтсан</option>
              <option value="false">Багтаагүй</option>
            </SelectInput>
          </Field>
          <Field id="trip-hotel" label="Зочид буудал" className="sm:col-span-2">
            <TextInput id="trip-hotel" value={tripDraft.hotel} placeholder="ж: 4* зочид буудал, 2 хүний өрөө" onChange={(e) => setTripDraft((d) => ({ ...d, hotel: e.target.value }))} />
          </Field>
        </div>
      </Group>

      <Group title="Тайлбар" hint="Вэбсайтын аяллын хуудсанд тайлбар болж харагдана. Бүтэн өгүүлбэрээр бичнэ. Шинжилгээтэй аялалд шинжилгээний жагсаалт бүлгээрээ доор харагдана.">
        <TripDescriptionEditor key={p.editingTrip?.id ?? "new-trip"} value={tripDraft.notes || ""} onChange={(text) => setTripDraft((d) => ({ ...d, notes: text }))} />
      </Group>

      <Group title="Суудал" hint={tooMany ? "Үлдсэн суудал нийт суудлаас их байна." : left === 0 ? "Үлдсэн 0: бүх өдөр «Дүүрсэн» гэж харагдана." : "Хоосон орхивол суудлын тоо харагдахгүй. Нэг өдрийг «Цөөн суудал» болгохыг «Үнэ ба гаралт» хэсгээс хийнэ."}>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Нийт суудал"><CountInput ariaLabel="Нийт суудал" unit="хүн" value={total} onChange={(n) => setTripDraft((d) => ({ ...d, seats_total: n == null ? "" : String(n) }))} /></Field>
          <Field label="Үлдсэн суудал"><CountInput ariaLabel="Үлдсэн суудал" unit="хүн" value={left} missing={tooMany} onChange={(n) => setTripDraft((d) => ({ ...d, seats_left: n == null ? "" : String(n) }))} /></Field>
        </div>
      </Group>

      <Group title="Хямдралын тэмдэг">
        <SaleBadgeFields
          enabled={tripDraft.sale_badge_enabled === "true"}
          label={tripDraft.sale_badge_label || ""}
          ends={tripDraft.sale_badge_ends || ""}
          onChange={(patch) => setTripDraft((d) => ({ ...d, ...patch }))}
        />
      </Group>

      <Group title="Хайлтын нэрс" hint="Хэрэглэгч энэ аяллыг өөрөөр бичвэл (латинаар, товчилж) бот таних нэрс. Бичээд Enter дарна.">
        <ChipsEditor ariaLabel="Хайлтын нэр нэмэх" values={p.tripAliases} placeholder="ж: <хот> аялал, <city> tour" onChange={(values) => p.setTripAliases(values)} />
      </Group>
    </>
  );
}

const toCount = (value: string | undefined) => {
  const digits = String(value || "").replace(/[^\d]/g, "");
  return digits === "" ? null : Number(digits);
};

/* ----------------------------------------------------------------- pricing */
export function PricingSection(p: SectionProps) {
  const { tripDraft, setTripDraft, tripPriceGroups, setTripPriceGroups } = p;
  const dated = tripPriceGroups.length > 0;
  const changeGroups = (updater: React.SetStateAction<PriceGroup[]>) => {
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
  };
  const childFree = tripDraft.child_price_free === "true";
  const infantFree = tripDraft.infant_price_free === "true";
  return (
    <>
      <SectionHeader title="Үнэ ба гаралт" description="Хэдэн төгрөгөөр, хэзээ гарах вэ. Чатбот үнийн асуултад эндээс хариулна, вэбсайт захиалгын хуудсандаа харуулна." audiences={["bot", "website"]} />

      {!dated ? (
        <Group title="Үнэ" hint="Бүх гаралт ижил үнэтэй бол энд оруулна.">
          <div className="grid gap-5 sm:grid-cols-3">
            <Field label="Том хүн" required missing={p.missing("adult_price")} anchor="adult_price">
              <MoneyField ariaLabel="Том хүний үнэ" value={tripDraft.adult_price} missing={p.missing("adult_price")} onChange={(v) => setTripDraft((d) => ({ ...d, adult_price: v }))} />
            </Field>
            <Field label="Хүүхэд" required missing={p.missing("child_price")} anchor="child_price">
              <MoneyField ariaLabel="Хүүхдийн үнэ" value={tripDraft.child_price} disabled={childFree} placeholder={childFree ? "Үнэгүй" : ""} missing={p.missing("child_price")} onChange={(v) => setTripDraft((d) => ({ ...d, child_price: v }))} />
              <div className="mt-1.5"><Checkbox label="Үнэгүй" checked={childFree} onChange={(free) => setTripDraft((d) => ({ ...d, child_price_free: free ? "true" : "", child_price: free ? "" : d.child_price }))} /></div>
            </Field>
            <Field label="Нярай" required missing={p.missing("infant_price")} anchor="infant_price">
              <MoneyField ariaLabel="Нярайн үнэ" value={tripDraft.infant_price} disabled={infantFree} placeholder={infantFree ? "Үнэгүй" : ""} missing={p.missing("infant_price")} onChange={(v) => setTripDraft((d) => ({ ...d, infant_price: v }))} />
              <div className="mt-1.5"><Checkbox label="Үнэгүй" checked={infantFree} onChange={(free) => setTripDraft((d) => ({ ...d, infant_price_free: free ? "true" : "", infant_price: free ? "" : d.infant_price }))} /></div>
            </Field>
          </div>
          <div className="mt-5">
            <Field label="Гарах өдрүүд" required missing={p.missing("departure_dates")} hint="Огноо бүр өөр үнэтэй бол доорх «Гаралт тус бүрээр үнэ оруулах» руу шилжинэ.">
              <DateChips anchor="departure_dates" dates={splitDepartureDraft(tripDraft.departure_dates)} missing={p.missing("departure_dates")} addLabel="Гарах өдөр нэмэх" emptyText="Гарах өдөр нэмээгүй байна."
                onChange={(dates) => setTripDraft((d) => ({ ...d, departure_dates: joinDepartureDraft(dates) }))} />
            </Field>
          </div>
          <button type="button" onClick={() => changeGroups((current) => [...current, emptyPriceGroup()])} className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-brand hover:text-brand-hover">
            <Icons.plus size={14} /> Гаралт тус бүрээр үнэ оруулах
          </button>
        </Group>
      ) : (
        <Group title="Гаралт ба үнэ" hint="Зүүн талаас гарах өдрөө сонгоод үнийг нь засна. Огноо бүр өөрийн үнэтэй байж болно.">
          <TripDatePriceEditor groups={tripPriceGroups} onChange={changeGroups} />
        </Group>
      )}

      {!p.isNewTrip && p.editingTrip && p.apiFetch && (
        <Group title="Огноо бүрийн суудал" hint="«Цөөн суудал» гэж сонгосон өдөр л вэбсайт болон чатбот дээр тэр өдрийн хажууд харагдана. Дарсан даруйдаа хадгалагдана.">
          <DateSeatsEditor trip={p.editingTrip} apiFetch={p.apiFetch} />
        </Group>
      )}

      <Group title="Насны ангилал" hint="Хүүхэд, нярай гэж хэдэн наснаас хэдэн нас хүртэлхийг хэлэх вэ.">
        <div className="grid gap-5 sm:grid-cols-3">
          <Field label="Том хүн"><TextInput placeholder="ж: 12+ нас" value={tripDraft.age_adult || ""} onChange={(e) => setTripDraft((d) => ({ ...d, age_adult: e.target.value }))} /></Field>
          <Field label="Хүүхэд"><TextInput placeholder="ж: 2-11 нас" value={tripDraft.age_child || ""} onChange={(e) => setTripDraft((d) => ({ ...d, age_child: e.target.value }))} /></Field>
          <Field label="Нярай"><TextInput placeholder="ж: 0-23 сар" value={tripDraft.age_infant || ""} onChange={(e) => setTripDraft((d) => ({ ...d, age_infant: e.target.value }))} /></Field>
        </div>
      </Group>

      <Group title="Хямдрал" hint="Тодорхой огноо эсвэл нөхцөлд (ж: 3+ хүн) хямдарсан үнэ." action={<AddRowButton label="Хямдрал нэмэх" onClick={() => p.setTripDiscounts((prev) => [...prev, emptyDiscountGroup()])} />}>
        {p.tripDiscounts.length === 0 ? <EmptyHint>Хямдрал байхгүй.</EmptyHint> : (
          <div className="space-y-3">
            {p.tripDiscounts.map((g, idx) => {
              const patch = (next: Partial<DiscountGroup>) => p.setTripDiscounts((prev) => prev.map((v, i) => i === idx ? { ...v, ...next } : v));
              return (
                <RowCard key={idx} title={g.label || `Хямдрал ${idx + 1}`} removeLabel="Хямдрал хасах" onRemove={() => p.setTripDiscounts((prev) => prev.filter((_, i) => i !== idx))}>
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    <Field label="Нэр"><TextInput value={g.label} placeholder="ж: Эрт захиалгын хямдрал" onChange={(e) => patch({ label: e.target.value })} /></Field>
                    <Field label="Нөхцөл"><TextInput value={g.condition} placeholder="ж: 3 ба түүнээс дээш хүн" onChange={(e) => patch({ condition: e.target.value })} /></Field>
                    <Field label="Огноонууд" hint="Таслалаар тусгаарлана."><TextInput value={g.dates.join(", ")} placeholder="ж: 11 сарын 5, 11 сарын 19" onChange={(e) => patch({ dates: e.target.value.split(",").map((d) => d.trim()).filter(Boolean) })} /></Field>
                    <Field label="Том хүн"><MoneyField ariaLabel="Том хүний хямдралтай үнэ" value={g.adult_price == null ? "" : String(g.adult_price)} onChange={(v) => patch({ adult_price: v === "" ? null : Number(v) })} /></Field>
                    <Field label="Хүүхэд"><MoneyField ariaLabel="Хүүхдийн хямдралтай үнэ" value={g.child_price == null ? "" : String(g.child_price)} onChange={(v) => patch({ child_price: v === "" ? null : Number(v) })} /></Field>
                    <Field label="Нярай"><MoneyField ariaLabel="Нярайн хямдралтай үнэ" value={g.infant_price == null ? "" : String(g.infant_price)} onChange={(v) => patch({ infant_price: v === "" ? null : Number(v) })} /></Field>
                    <Field label="Тайлбар" className="sm:col-span-2 lg:col-span-3"><TextInput value={g.note} onChange={(e) => patch({ note: e.target.value })} /></Field>
                  </div>
                </RowCard>
              );
            })}
          </div>
        )}
      </Group>

      <Group title="Нэмэлт төлбөр" hint="Үнэд ороогүй, хүсвэл нэмж төлдөг зүйл (ганц өрөө, нэмэлт үзвэр гэх мэт)." action={<AddRowButton label="Нэмэлт төлбөр нэмэх" onClick={() => p.setTripExtraFees((prev) => [...prev, emptyExtraFee()])} />}>
        {p.tripExtraFees.length === 0 ? <EmptyHint>Нэмэлт төлбөр байхгүй.</EmptyHint> : (
          <div className="divide-y divide-line rounded-lg border border-line">
            {p.tripExtraFees.map((f, idx) => {
              const patch = (next: Partial<ExtraFee>) => p.setTripExtraFees((prev) => prev.map((v, i) => i === idx ? { ...v, ...next } : v));
              return (
                <div key={idx} className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_6rem_minmax(0,1fr)_minmax(0,1.2fr)_2rem] lg:items-center">
                  <TextInput aria-label="Нэр" value={f.label} placeholder="Нэр, ж: Ганц хүний өрөө" onChange={(e) => patch({ label: e.target.value })} />
                  <MoneyField ariaLabel="Дүн" value={f.amount == null ? "" : String(f.amount)} currency={f.currency} placeholder="Дүн" onChange={(v) => patch({ amount: v === "" ? null : Number(v) })} />
                  <SelectInput aria-label="Валют" value={f.currency} onChange={(e) => patch({ currency: e.target.value })}>
                    {CURRENCIES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                  </SelectInput>
                  <TextInput aria-label="Хэнд хамаарах" value={f.applies_to} placeholder="Хэнд, ж: Бүгд" onChange={(e) => patch({ applies_to: e.target.value })} />
                  <TextInput aria-label="Тайлбар" value={f.note} placeholder="Тайлбар" onChange={(e) => patch({ note: e.target.value })} />
                  <RemoveButton label="Нэмэлт төлбөр хасах" onClick={() => p.setTripExtraFees((prev) => prev.filter((_, i) => i !== idx))} className="justify-self-end" />
                </div>
              );
            })}
          </div>
        )}
      </Group>

      <Group title="Гарах өдрийн дүрэм" hint="Тогтмол хуваарьтай аялалд, ж: «Пүрэв гараг бүр».">
        <TextArea aria-label="Гарах өдрийн дүрэм" rows={2} value={p.tripDepartureRule} placeholder="ж: Даваа, Лхагва, Баасан гарна" onChange={(e) => p.setTripDepartureRule(e.target.value)} />
      </Group>
    </>
  );
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

/* --------------------------------------------------------------- itinerary */
export function ItinerarySection(p: SectionProps) {
  const days = p.tripItineraryDays;
  const setDays = p.setTripItineraryDays;
  const [open, setOpen] = React.useState<Record<number, boolean>>({});
  const isOpen = (idx: number) => open[idx] ?? (idx === 0 || !days[idx]?.title);
  const moveDay = (from: number, to: number) => setDays((prev) => {
    if (to < 0 || to >= prev.length) return prev;
    const next = [...prev];
    [next[from], next[to]] = [next[to], next[from]];
    return next;
  });
  const addDay = () => { setDays((prev) => [...prev, emptyItineraryDay(prev.length + 1)]); setOpen((o) => ({ ...o, [days.length]: true })); };
  return (
    <>
      <SectionHeader title="Өдрийн хөтөлбөр" description="Өдөр бүр юу болохыг дарааллаар нь бичнэ. Постер болон вэбсайтын аяллын хуудсанд өдрөөр харагдана. Өдрийн зургийг Постер хэсгээс солино." audiences={["website", "poster"]} />
      <Group action={<AddRowButton label="Өдөр нэмэх" onClick={addDay} />} title={`${days.length} өдөр`}>
        {days.length === 0 ? <EmptyHint>Хөтөлбөр оруулаагүй байна. «Өдөр нэмэх» дарж эхлээрэй.</EmptyHint> : (
          <ol className="relative space-y-2 before:absolute before:bottom-6 before:left-4 before:top-6 before:w-px before:bg-line" aria-label="Өдрүүд">
            {days.map((d, idx) => {
              const patch = (next: Partial<ItineraryDay>) => setDays((prev) => prev.map((v, i) => i === idx ? { ...v, ...next } : v));
              const expanded = isOpen(idx);
              return (
                <li key={idx} className="relative pl-12">
                  <span className="absolute left-0 top-2.5 flex h-8 w-8 items-center justify-center rounded-full border border-line bg-surface text-sm font-bold text-brand">{idx + 1}</span>
                  <div className="rounded-lg border border-line bg-surface">
                    <div className="flex items-center gap-2 py-2 pl-4 pr-2">
                      <button type="button" aria-expanded={expanded} onClick={() => setOpen((o) => ({ ...o, [idx]: !expanded }))} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold text-ink">{d.title || "Гарчиггүй өдөр"}</span>
                          {!expanded && <span className="block truncate text-xs text-ink-muted">{(d.description || "").replace(/\s+/g, " ").slice(0, 140) || "Тайлбаргүй"}</span>}
                        </span>
                        <Icons.chevronRight size={16} className={cx("shrink-0 text-ink-subtle transition-transform", expanded ? "-rotate-90" : "rotate-90")} />
                      </button>
                      <span className="flex shrink-0 items-center border-l border-line pl-1">
                        <button type="button" className="rounded-md p-1.5 text-ink-subtle hover:bg-surface-sunken hover:text-ink disabled:opacity-30" disabled={idx === 0} title="Дээш зөөх" aria-label={`${idx + 1}-р өдрийг дээш зөөх`} onClick={() => moveDay(idx, idx - 1)}><Icons.chevronRight size={14} className="-rotate-90" /></button>
                        <button type="button" className="rounded-md p-1.5 text-ink-subtle hover:bg-surface-sunken hover:text-ink disabled:opacity-30" disabled={idx === days.length - 1} title="Доош зөөх" aria-label={`${idx + 1}-р өдрийг доош зөөх`} onClick={() => moveDay(idx, idx + 1)}><Icons.chevronRight size={14} className="rotate-90" /></button>
                        <RemoveButton label={`${idx + 1}-р өдрийг хасах`} onClick={() => { if (window.confirm(`${idx + 1}-р өдрийг хасах уу?`)) setDays((prev) => prev.filter((_, i) => i !== idx)); }} />
                      </span>
                    </div>
                    {expanded && (
                      <div className="space-y-4 border-t border-line px-4 pb-4 pt-4">
                        <div className="grid gap-4 sm:grid-cols-2">
                          <Field label="Гарчиг, чиглэл"><TextInput value={d.title} placeholder="ж: НИЙСЛЭЛ – ХИЛИЙН БООМТ" onChange={(e) => patch({ title: e.target.value })} /></Field>
                          <Field label="Хоноглох газар"><TextInput value={d.hotel || ""} placeholder="Буудал, галт тэрэг…" onChange={(e) => patch({ hotel: e.target.value })} /></Field>
                        </div>
                        <Field label="Тайлбар"><TextArea rows={4} className="min-h-28" value={d.description} placeholder="Энэ өдөр юу хийх вэ…" onChange={(e) => patch({ description: e.target.value })} /></Field>
                        <DayPhotoPreview photo={d.photo} title={d.title || `Өдөр ${idx + 1}`} />
                        <DayMealToggles meals={d.meals} onToggle={(key) => setDays((prev) => prev.map((v, i) => i === idx ? { ...v, meals: { ...v.meals, [key]: !v.meals?.[key] } } : v))} />
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </Group>
    </>
  );
}

/* ------------------------------------------------------------------- media */
export function MediaSection(p: SectionProps) {
  const {
    photoFileInputRef: fileInputRef, tripPhotoUrls, setTripPhotoUrls, photoDragging, setPhotoDragging, handlePhotoFiles, photoUploading,
    tripPhotoInput, setTripPhotoInput, editingTrip, tripDraft, setTripDraft, apiFetch, onWebsiteMediaBusy, isPosterLinked, brochurePdfUrl,
  } = p;
  const missing = p.missing("photo_urls");
  const addPhotoUrl = () => {
    const url = tripPhotoInput.trim();
    if (url.startsWith("https://") && tripPhotoUrls.length < MAX_PHOTOS_PER_TRIP) {
      setTripPhotoUrls((prev) => [...prev, url]);
      setTripPhotoInput("");
    }
  };
  return (
    <>
      <SectionHeader title="Зураг, бичлэг" description="Аяллын зургууд: хэрэглэгч энэ аяллыг асуухад чатбот илгээнэ, вэбсайт аяллын хуудсандаа харуулна. Буудлын зураг, бичлэг, брошур зөвхөн вэбсайтад." audiences={["bot", "website"]} />
      {isPosterLinked ? (
        <Group title="Аяллын зургууд">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-canvas px-4 py-3">
            <div className="min-w-0 text-sm">
              <p className="font-medium text-ink">Зураг постероос ирнэ.</p>
              <p className="mt-0.5 text-xs text-ink-muted">Зураг нэмэх, солихыг Постер хэсэгт хийнэ. Бот болон вэбсайт тэндээс авна.</p>
            </div>
            {brochurePdfUrl && <Button size="sm" variant="secondary" href={brochurePdfUrl}>PDF нээх</Button>}
          </div>
        </Group>
      ) : (
        <Group title="Аяллын зургууд" hint={`Хамгийн ихдээ ${MAX_PHOTOS_PER_TRIP} зураг. PNG, JPG, WEBP, 10MB хүртэл.`}>
          <div data-trip-field="photo_urls">
            <div
              onDragOver={(e) => { e.preventDefault(); setPhotoDragging(true); }}
              onDragLeave={() => setPhotoDragging(false)}
              onDrop={(e) => { e.preventDefault(); setPhotoDragging(false); void handlePhotoFiles(e.dataTransfer.files); }}
              className={cx("grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-6", tripPhotoUrls.length === 0 && "grid-cols-1 sm:grid-cols-1 lg:grid-cols-1")}
            >
              {tripPhotoUrls.map((url, idx) => (
                <div key={idx} className="group relative aspect-[4/3] overflow-hidden rounded-md border border-line bg-surface-sunken">
                  <a href={url} target="_blank" rel="noopener noreferrer" className="block h-full w-full" title="Бүтэн зураг харах">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={url} alt={`Зураг ${idx + 1}`} className="h-full w-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                  </a>
                  <button type="button" onClick={() => setTripPhotoUrls((prev) => prev.filter((_, i) => i !== idx))} className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-white opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100" aria-label={`${idx + 1}-р зургийг устгах`}>
                    <Icons.trash size={13} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className={cx(
                  "flex flex-col items-center justify-center gap-1.5 rounded-md border border-dashed text-center transition-colors hover:border-brand hover:bg-brand-soft/40",
                  tripPhotoUrls.length === 0 ? "px-4 py-10" : "aspect-[4/3]",
                  photoDragging ? "border-brand bg-brand-soft" : missing ? "border-warning/70 bg-warning-soft/30" : "border-line-strong",
                )}
              >
                <Icons.upload size={tripPhotoUrls.length === 0 ? 22 : 18} className="text-ink-muted" />
                <span className="text-sm font-medium text-ink">{tripPhotoUrls.length === 0 ? "Зураг чирж оруулах эсвэл сонгох" : "Нэмэх"}</span>
                {tripPhotoUrls.length === 0 && <span className="text-xs text-ink-muted">{missing ? "Ядаж нэг зураг заавал." : "Олон зураг зэрэг сонгож болно."}</span>}
              </button>
              <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { if (e.target.files) void handlePhotoFiles(e.target.files); e.target.value = ""; }} />
            </div>
          </div>
          {photoUploading.length > 0 && (
            <ul className="mt-3 space-y-1">
              {photoUploading.map((name) => (
                <li key={name} className="flex items-center gap-2 text-xs text-ink-muted"><Spinner className="shrink-0" /><span className="truncate">{name} байршуулж байна…</span></li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex gap-2">
            <TextInput type="url" aria-label="Зургийн холбоос" value={tripPhotoInput} onChange={(e) => setTripPhotoInput(e.target.value)} placeholder="Эсвэл зургийн холбоос: https://…"
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addPhotoUrl(); } }} />
            <Button size="md" variant="secondary" disabled={!tripPhotoInput.trim().startsWith("https://") || tripPhotoUrls.length >= MAX_PHOTOS_PER_TRIP} onClick={() => addPhotoUrl()}>Нэмэх</Button>
          </div>
        </Group>
      )}
      <Group title="Буудлын зураг, бичлэг, брошур" hint="Зөвхөн вэбсайтын аяллын хуудсанд.">
        <WebsiteTripFields scope="media" trip={editingTrip} draft={tripDraft.websiteDetails} onChange={(websiteDetails) => setTripDraft((d) => ({ ...d, websiteDetails }))} apiFetch={apiFetch} onBusyChange={onWebsiteMediaBusy} />
      </Group>
    </>
  );
}

/* ------------------------------------------------------------------- terms */
export function TermsSection(p: SectionProps) {
  const terms = p.tripBookingTerms;
  const setTerms = p.setTripBookingTerms;
  return (
    <>
      <SectionHeader title="Нөхцөл" description="Үнэд юу багтах, захиалгын журам. Чатбот эндээс хариулна; хоосон орхисон зүйлийг «тодорхойгүй» гээд ажилтанд шилжүүлнэ, зохиож хариулахгүй." audiences={["bot"]} />
      <Group title="Үнэд багтсан, багтаагүй" hint="Нэг мөрөнд нэг зүйл. Enter дарвал дараагийн мөр.">
        <div className="grid gap-5 lg:grid-cols-2">
          <Field label="Багтсан"><ListEditor ariaLabel="Багтсан зүйл" tone="good" items={p.tripIncludedItems} onChange={p.setTripIncludedItems} placeholder="ж: Зочид буудал" addLabel="Зүйл нэмэх" /></Field>
          <Field label="Багтаагүй"><ListEditor ariaLabel="Багтаагүй зүйл" tone="bad" items={p.tripExcludedItems} onChange={p.setTripExcludedItems} placeholder="ж: Визний хураамж" addLabel="Зүйл нэмэх" /></Field>
        </div>
      </Group>
      <Group title="Чухал тэмдэглэл" hint="Аялагчийн заавал мэдэх зүйл (паспорт, авч явах зүйл…).">
        <ListEditor ariaLabel="Чухал тэмдэглэл" items={p.tripImportantNotes} onChange={p.setTripImportantNotes} placeholder="ж: Паспортын хүчинтэй хугацаа 6 сараас дээш байна" addLabel="Тэмдэглэл нэмэх" />
      </Group>
      <Group title="Захиалгын нөхцөл">
        <div className="grid gap-5 lg:grid-cols-2">
          <Field label="Урьдчилгаа"><TextArea rows={2} value={terms.deposit} placeholder="ж: Урьдчилгаа …₮, үлдэгдлийг гарахаас 7 хоногийн өмнө" onChange={(e) => setTerms((t) => ({ ...t, deposit: e.target.value }))} /></Field>
          <Field label="Төлбөрийн нөхцөл"><TextArea rows={2} value={terms.payment} placeholder="ж: Дансаар, 2 хуваан төлж болно" onChange={(e) => setTerms((t) => ({ ...t, payment: e.target.value }))} /></Field>
          <Field label="Бүрдүүлэх бичиг баримт"><TextArea rows={2} value={terms.documents} placeholder="ж: Гадаад паспорт, 2 хувь цээж зураг" onChange={(e) => setTerms((t) => ({ ...t, documents: e.target.value }))} /></Field>
          <Field label="Виз"><TextArea rows={2} value={terms.visa} placeholder="ж: Виз шаардлагатай эсэх" onChange={(e) => setTerms((t) => ({ ...t, visa: e.target.value }))} /></Field>
          <Field label="Цуцлалт, буцаан олголт" className="lg:col-span-2"><TextArea rows={2} value={terms.cancellation} placeholder="ж: Гарахаас 14 хоногийн өмнө цуцлавал урьдчилгаа буцаана" onChange={(e) => setTerms((t) => ({ ...t, cancellation: e.target.value }))} /></Field>
        </div>
      </Group>
      <Group title="Өрөөний үнэ" hint="Өрөөний төрлөөс хамаарч үнэ өөр бол." action={<AddRowButton label="Өрөө нэмэх" onClick={() => p.setTripRoomPrices((prev) => [...prev, emptyRoomPrice()])} />}>
        {p.tripRoomPrices.length === 0 ? <EmptyHint>Өрөөний тусдаа үнэ байхгүй.</EmptyHint> : (
          <div className="divide-y divide-line rounded-lg border border-line">
            {p.tripRoomPrices.map((r, idx) => {
              const patch = (next: Partial<RoomPrice>) => p.setTripRoomPrices((prev) => prev.map((v, i) => i === idx ? { ...v, ...next } : v));
              return (
                <div key={idx} className="grid gap-3 p-3 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_6rem_minmax(0,1.2fr)_2rem] sm:items-center">
                  <TextInput aria-label="Өрөөний төрөл" value={r.room_type} placeholder="ж: Ганц хүний өрөө" onChange={(e) => patch({ room_type: e.target.value })} />
                  <MoneyField ariaLabel="Өрөөний үнэ" value={r.price == null ? "" : String(r.price)} currency={r.currency} placeholder="Үнэ" onChange={(v) => patch({ price: v === "" ? null : Number(v) })} />
                  <SelectInput aria-label="Валют" value={r.currency} onChange={(e) => patch({ currency: e.target.value })}>
                    {CURRENCIES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                  </SelectInput>
                  <TextInput aria-label="Тайлбар" value={r.note} placeholder="Тайлбар" onChange={(e) => patch({ note: e.target.value })} />
                  <RemoveButton label="Өрөө хасах" onClick={() => p.setTripRoomPrices((prev) => prev.filter((_, i) => i !== idx))} className="justify-self-end" />
                </div>
              );
            })}
          </div>
        )}
      </Group>
    </>
  );
}

/* ----------------------------------------------------------------- website */
export function WebsiteSection(p: SectionProps) {
  return (
    <>
      <SectionHeader title="Вэбсайт" description="Нэр, тайлбар, үнэ, гарах өдөр нь «Үндсэн» ба «Үнэ ба гаралт» хэсгээс ирдэг тул энд дахин бичихгүй. Доорх талбарууд зөвхөн вэбсайтын аяллын хуудсанд нэмэлт мэдээлэл болж харагдана." audiences={["website"]} />
      <Group title="Чатбот ба вэбсайт ижил үү" hint="Хоёр талд ижил байх ёстой мэдээлэл. Зөрүүтэй бол энд харагдана.">
        <TripTextComparison trip={p.editingTrip} />
      </Group>
      <Group title="Вэбсайтын нэмэлт мэдээлэл">
        <WebsiteTripFields trip={p.editingTrip} draft={p.tripDraft.websiteDetails} onChange={(websiteDetails) => p.setTripDraft((d) => ({ ...d, websiteDetails }))} />
      </Group>
    </>
  );
}

/* ---------------------------------------------------------------- settings */
export function SettingsSection(p: SectionProps) {
  return (
    <>
      <SectionHeader title="Тохиргоо" description="Чатбот энэ аяллыг хэрхэн хэрэглэх вэ." audiences={["bot"]} />
      <Group>
        <div className="divide-y divide-line">
          <SwitchRow title="Бот энэ аяллын талаар хариулна" hint="Унтраавал бот энэ аяллыг мэдэхгүй мэт хандана." control={<Switch label="Ботод харагдана" checked={p.tripCustomerVisible} onChange={p.setTripCustomerVisible} />} />
          <SwitchRow title="Ажилтан шалгах шаардлагатай" hint="Мэдээлэл эргэлзээтэй бол тэмдэглэнэ." control={<Switch label="Хүний шалгалт" checked={p.tripNeedsHumanReview} onChange={p.setTripNeedsHumanReview} />} />
        </div>
        {p.tripNeedsHumanReview && (
          <div className="mt-4">
            <Field label="Шалгах шалтгаан"><ListEditor ariaLabel="Шалгах шалтгаан" items={p.tripReviewReasons} onChange={p.setTripReviewReasons} placeholder="ж: Огноо таарахгүй байна" addLabel="Шалтгаан нэмэх" /></Field>
          </div>
        )}
      </Group>

      {p.tripSourceProvenance.length > 0 && (
        <Group title="Эх сурвалж" hint="AI туслах файлаас уншсан хэсгүүд.">
          <ul className="divide-y divide-line rounded-lg border border-line">
            {p.tripSourceProvenance.map((sp, idx) => (
              <li key={idx} className="p-3 text-xs text-ink-muted">
                <div className="flex items-center gap-2 font-medium text-ink">
                  <span className="truncate">{sp.file_name}</span>
                  {sp.page !== null && <span className="shrink-0 text-ink-subtle">{sp.page}-р хуудас</span>}
                  <span className={cx("ml-auto shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium", sp.confidence === "high" ? "bg-success-soft text-success" : sp.confidence === "medium" ? "bg-warning-soft text-warning" : "bg-danger-soft text-danger")}>
                    {sp.confidence === "high" ? "Итгэл өндөр" : sp.confidence === "medium" ? "Дунд" : "Бага"}
                  </span>
                </div>
                <p className="mt-1 text-ink-subtle">{sp.source_text}</p>
              </li>
            ))}
          </ul>
        </Group>
      )}

      <Group title="Хариултын заавар" hint="Тодорхой асуултад бот яг ингэж хариул гэсэн заавар." action={<AddRowButton label="Заавар нэмэх" onClick={() => p.setTripAnswerHints((prev) => [...prev, { intent: "price", question_pattern: "", expected_answer_summary: "" }])} />}>
        {p.tripAnswerHints.length === 0 ? <EmptyHint>Тусгай заавар байхгүй.</EmptyHint> : (
          <div className="space-y-3">
            {p.tripAnswerHints.map((h, idx) => {
              const patch = (next: Partial<AnswerHint>) => p.setTripAnswerHints((prev) => prev.map((v, i) => i === idx ? { ...v, ...next } : v));
              return (
                <RowCard key={idx} title={`Заавар ${idx + 1}`} removeLabel="Заавар хасах" onRemove={() => p.setTripAnswerHints((prev) => prev.filter((_, i) => i !== idx))}>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Сэдэв">
                      <SelectInput value={h.intent} onChange={(e) => patch({ intent: e.target.value as AnswerHint["intent"] })}>
                        <option value="price">Үнэ</option>
                        <option value="discount">Хямдрал</option>
                        <option value="comparison">Харьцуулалт</option>
                        <option value="child_price">Хүүхдийн үнэ</option>
                        <option value="included">Багтсан зүйл</option>
                        <option value="schedule">Хуваарь</option>
                      </SelectInput>
                    </Field>
                    <Field label="Асуулт"><TextInput value={h.question_pattern} placeholder="ж: * үнэ хэд вэ?" onChange={(e) => patch({ question_pattern: e.target.value })} /></Field>
                    <Field label="Хариулт" className="sm:col-span-2"><TextInput value={h.expected_answer_summary} placeholder="Ботын өгөх хариулт" onChange={(e) => patch({ expected_answer_summary: e.target.value })} /></Field>
                  </div>
                </RowCard>
              );
            })}
          </div>
        )}
      </Group>
    </>
  );
}
