/**
 * A trip read from a file, reviewed in the trip editor's own design: the same
 * section groups, fields, duration steppers, day timeline, per-date price
 * editor (hotel, package, child and infant bands per departure) and hotel
 * editor. What only a file review needs is added on top: the departure
 * calendar, the transport switch, the checks against the file's own dates and
 * length, and the file's words quoted beside what was read from them.
 * Everything else (discounts, extra fees, website fields, settings) is one click
 * away in the full editor, which hands its result back here.
 */
import type { ReactNode } from "react";
import { Button, Icons, cx } from "@/components/ui";
import type { HotelProfile, PriceGroup } from "@/lib/adminTypes";
import { reconcilePricingDates, type PricingGroup } from "@/lib/adminDatePricing";
import {
  addDaysYmd, applyTransport, checkDeparture, checkDuration, departureDays, formatYmd, hasPrice, itineraryOf, makeCover,
  removePhoto, setDepartureDays, setProgramDays, shiftDepartureDay, transportOf, tripPhotos, withProgramDuration,
} from "@/lib/tripReview";
import { completePriceGroup, parseHotelProfiles } from "@/lib/tripEditorState";
import { TRANSPORT_TYPES, isTransitDay, type TransportType } from "@/lib/tripTransitDays";
import { ListEditor } from "../TripEditorParts";
import { DurationSteppers } from "../tripEditor/DurationSteppers";
import { HotelProfilesEditor, hotelNamesOf } from "../tripEditor/HotelProfilesEditor";
import { ItineraryTimeline } from "../tripEditor/ItineraryTimeline";
import { TripDatePriceEditor, emptyPriceGroup } from "../tripEditor/PricingEditor";
import { EmptyHint, Field, Group, MoneyField, TextArea, TextInput } from "../tripEditor/parts";
import { MultiDateCalendar } from "./MultiDateCalendar";
import { thumb } from "./photoThumb";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? value as Row : {});
const text = (value: unknown) => (typeof value === "string" ? value : "");
const strings = (value: unknown) => (Array.isArray(value) ? value.map((item) => String(item ?? "")) : []);

const TRANSPORT_SHORT: Record<TransportType, { label: string; hint: string }> = {
  land: { label: "Газраар", hint: "галт тэрэг, автобус" },
  land_flight: { label: "Газар + нислэг", hint: "хил гараад нисдэг" },
  direct_flight: { label: "Шууд нислэг", hint: "Улаанбаатараас нисдэг" },
  cruise: { label: "Усан онгоц", hint: "галт тэргээр боомт хүрнэ" },
};

const TERMS: Array<[string, string, string]> = [
  ["deposit", "Урьдчилгаа", "ж: 500,000₮ бүртгүүлэхдээ"],
  ["payment", "Төлбөр", "ж: Үлдэгдлийг гарахаас 14 хоногийн өмнө"],
  ["documents", "Бичиг баримт", "ж: Гадаад паспорт, 2 зураг"],
  ["visa", "Виз", "ж: Визгүй / Виз шаардлагатай"],
  ["cancellation", "Цуцлалт", "ж: Цуцалбал хураамж авна"],
];

/** What the file itself says, quoted, so a value can be checked against it at a glance. */
function Evidence({ quote }: { quote: unknown }) {
  const value = text(quote).trim();
  if (!value) return null;
  return (
    <p className="mt-2.5 flex items-start gap-1.5 text-xs leading-5 text-ink-subtle">
      <Icons.file size={12} className="mt-1 shrink-0" />
      <span className="min-w-0">Файлд: <span className="text-ink-muted">«{value}»</span></span>
    </p>
  );
}

function Notice({ tone, children }: { tone: "warning" | "success" | "muted"; children: ReactNode }) {
  return (
    <div className={cx("mt-3 rounded-lg px-3.5 py-3 text-[13px] leading-5",
      tone === "warning" ? "border border-warning/30 bg-warning-soft/60 text-ink" : tone === "success" ? "text-success" : "text-ink-muted")}>
      {children}
    </div>
  );
}

export function NewTripReview({
  fields,
  onChange,
  warnings,
  disabled,
  onOpenEditor,
}: {
  fields: Row;
  onChange: (next: Row) => void;
  /** The assistant's real doubts about this trip (not what the sections already say). */
  warnings: string[];
  disabled?: boolean;
  /** Opens this trip in the full trip editor; its save comes back into this review. */
  onOpenEditor?: () => void;
}) {
  const extra = record(fields.extra);
  const setExtra = (patch: Row) => onChange({ ...fields, extra: { ...extra, ...patch } });
  const evidence = record(extra.source_evidence);
  const itinerary = itineraryOf(fields);
  const transport = transportOf(fields);
  const added = itinerary.filter(isTransitDay).length;
  const { days: departures, other: rules } = departureDays(fields.departure_dates);
  const check = checkDeparture(departures, itinerary);
  const photos = tripPhotos(fields);
  const duration = checkDuration(fields);
  const found = photos.filter((photo) => photo.author || photo.license).length;
  const programDuration = text(extra.program_duration_text).trim();
  const groups = (Array.isArray(extra.price_groups) && extra.price_groups.length ? extra.price_groups
    : Array.isArray(extra.departure_date_groups) ? extra.departure_date_groups : []).map(completePriceGroup);
  const ages = record(extra.age_rules);
  const terms = record(extra.booking_terms);
  const profiles = parseHotelProfiles(JSON.stringify(Array.isArray(extra.hotel_profiles) ? extra.hotel_profiles : []));
  const money = (key: string) => (digits: string) => onChange({ ...fields, [key]: digits === "" ? null : Number(digits) });

  /** Per-date fares, kept in step with the departure list the way the trip editor does it. */
  const changeGroups = (updater: PriceGroup[] | ((current: PriceGroup[]) => PriceGroup[])) => {
    const next = typeof updater === "function" ? updater(groups) : updater;
    const dates = reconcilePricingDates(strings(fields.departure_dates), groups as (PriceGroup & PricingGroup)[], next as (PriceGroup & PricingGroup)[]);
    onChange({ ...fields, departure_dates: dates, extra: { ...extra, price_groups: next, departure_date_groups: [] } });
  };
  const setDuration = (value: string) => {
    const days = Number(/(\d+)\s*өдөр/.exec(value)?.[1]);
    const nights = Number(/(\d+)\s*шөнө/.exec(value)?.[1]);
    onChange({ ...fields, duration_text: value, extra: { ...extra, ...(days ? { duration_days: days } : {}), ...(Number.isFinite(nights) ? { duration_nights: nights } : {}) } });
  };

  return (
    // While it saves the review is read-only: an edit made then would not be in what is being saved.
    <fieldset disabled={disabled} className="m-0 min-w-0 space-y-8 border-0 px-4 py-6 sm:px-6">
      {onOpenEditor && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-canvas/60 px-4 py-3">
          <p className="min-w-0 flex-1 basis-60 text-[13px] leading-5 text-ink-muted">
            Энд гол мэдээллийг шалгана. Хямдрал, нэмэлт төлбөр, вэбсайтын талбар, тохиргоо зэрэг бүх зүйлийг <b className="text-ink">аялал засах</b> цонхонд засна.
          </p>
          <Button size="sm" variant="secondary" disabled={disabled} onClick={onOpenEditor}>
            <Icons.edit size={14} /> Бүтэн засварлагчаар нээх
          </Button>
        </div>
      )}

      {warnings.length > 0 && (
        <Group title="Шалгах зүйлс">
          <ul className="space-y-1.5">
            {warnings.map((warning) => (
              <li key={warning} className="flex items-start gap-2 text-[13px] leading-5 text-ink">
                <Icons.alert size={14} className="mt-0.5 shrink-0 text-warning" />
                <span className="min-w-0 whitespace-pre-line">{warning}</span>
              </li>
            ))}
          </ul>
        </Group>
      )}

      <Group title="Үндсэн">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="review-route-name" label="Аяллын нэр" required missing={!text(fields.route_name).trim()} className="sm:col-span-2" hint="Огноог нэрэнд бичихгүй, доорх календарьт сонгоно.">
            <TextInput id="review-route-name" value={text(fields.route_name)} disabled={disabled} missing={!text(fields.route_name).trim()} className="text-[15px] font-semibold"
              placeholder="Аяллын нэр" onChange={(e) => onChange({ ...fields, route_name: e.target.value })} />
          </Field>
          <Field label="Тээвэр" className="sm:col-span-2">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Тээврийн төрөл">
              {TRANSPORT_TYPES.map((type) => {
                const on = transport === type;
                return (
                  <button key={type} type="button" role="radio" aria-checked={on} disabled={disabled || !itinerary.length}
                    onClick={() => { if (!on) onChange(applyTransport(fields, type).fields); }}
                    className={cx("rounded-md border px-3 py-2.5 text-left transition-colors disabled:opacity-60",
                      on ? "border-brand bg-brand-soft" : "border-line-strong bg-surface hover:border-brand")}>
                    <span className={cx("flex items-center gap-1.5 text-[13px] font-semibold", on ? "text-brand" : "text-ink")}>
                      {on && <Icons.check size={12} />}{TRANSPORT_SHORT[type].label}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-4 text-ink-muted">{TRANSPORT_SHORT[type].hint}</span>
                  </button>
                );
              })}
            </div>
          </Field>
          <Field label="Хугацаа" required missing={!text(fields.duration_text).trim()}
            hint={itinerary.length > 0 ? (added > 0
              ? `Файлын хөтөлбөр${programDuration ? ` (${programDuration})` : ""} хилээс эхэлдэг тул Улаанбаатараас гарах, буцах ${added} өдөр нэмэгдсэн.`
              : "Хөтөлбөр Улаанбаатараас эхэлж Улаанбаатарт дуусдаг тул өдөр нэмээгүй.") : undefined}>
            <DurationSteppers value={text(fields.duration_text)} disabled={disabled} missing={!text(fields.duration_text).trim()} onChange={setDuration} />
          </Field>
          <Field id="review-hotel" label="Зочид буудал" hint="Хэд хэдэн бол «А эсвэл Б» гэж бичнэ.">
            <TextInput id="review-hotel" value={text(fields.hotel)} disabled={disabled} placeholder="ж: 4* буудал" onChange={(e) => onChange({ ...fields, hotel: e.target.value })} />
          </Field>
        </div>
        {duration.kind === "mismatch" && (
          <Notice tone="warning">
            Файлд <b>«{duration.written}»</b> гэж бичсэн ч хөтөлбөрт <b>{duration.programDays} өдөр</b> байна.
            <button type="button" disabled={disabled} onClick={() => onChange(withProgramDuration(fields))}
              className="ml-2 rounded-md bg-brand px-2.5 py-1 text-xs font-semibold text-white hover:bg-brand-hover">Хөтөлбөрөөр: {duration.byProgram}</button>
          </Notice>
        )}
        <Evidence quote={evidence.duration} />
      </Group>

      <Group title="Гарах өдрүүд" hint={groups.length ? "Календариас хассан өдрийн үнэ хамт хасагдана. Шинэ өдрийн үнийг доорх «Гаралт нэмэх»-ээр оруулна." : "Календариас дарж сонгоно. Хэдэн ч өдөр сонгож болно."}>
        <MultiDateCalendar selected={departures} tripDays={itinerary.length || undefined} disabled={disabled} onChange={(next) => onChange(setDepartureDays(fields, next))} />
        {rules.length > 0 && <p className="mt-3 text-xs leading-5 text-ink-muted">Файлд бичсэн хуваарь: <span className="font-medium text-ink">{rules.join(", ")}</span></p>}
        {check.kind === "shift" && (
          <Notice tone="warning">
            Файлд <b>{formatYmd(check.departure)}</b> нь хөтөлбөрийн эхний өдөр (хил дээр). Улаанбаатараас галт тэрэг өмнөх орой нь хөдөлдөг.
            <span className="mt-2 flex flex-wrap gap-2">
              <button type="button" disabled={disabled} onClick={() => onChange(shiftDepartureDay(fields, check.departure, check.suggested))}
                className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-hover">{formatYmd(check.suggested)}-нд Улаанбаатараас гарна</button>
              <button type="button" disabled={disabled} onClick={() => onChange({ ...fields, extra: { ...extra, itinerary_days: itinerary.map((day) => ({ ...day, date: "" })) } })}
                className="rounded-md border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-ink-muted hover:border-brand hover:text-ink">{formatYmd(check.departure)} хэвээр</button>
            </span>
          </Notice>
        )}
        {check.kind === "conflict" && (
          <Notice tone="warning">Гарах өдөр {formatYmd(check.departure)} боловч файлд хөтөлбөрийн эхний өдрийг {formatYmd(check.programStart)} гэж бичсэн ({formatYmd(check.expected)} байх ёстой). Аль нь зөвийг шалгаад календариас засна уу.</Notice>
        )}
        {check.kind === "consistent" && (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-success"><Icons.check size={12} /> Файлын өдрүүдтэй таарч байна: хөтөлбөрийн эхний өдөр {formatYmd(check.programStart)}.</p>
        )}
        {check.kind === "unknown" && added > 0 && departures.length > 0 && (
          <p className="mt-3 text-xs leading-5 text-ink-muted">Сонгосон өдөр бол Улаанбаатараас галт тэрэг хөдлөх өдөр. Хөтөлбөрийн дараагийн өдөр ({formatYmd(addDaysYmd(departures[0], 1))}) хил давна.</p>
        )}
        <Evidence quote={evidence.departure} />
      </Group>

      {groups.length > 0 ? (
        <Group title="Гаралт ба үнэ" hint="Гарах өдөр бүрийн үнэ, буудал, багц, хүүхэд нярайн үнэ. Сайтын картанд хамгийн бага том хүний үнэ «эхлэх үнэ» болж гарна.">
          <TripDatePriceEditor groups={groups} onChange={changeGroups} />
        </Group>
      ) : (
        <Group title="Үнэ" hint="Нэг хүний, төгрөгөөр. Бүх гаралт ижил үнэтэй бол энд оруулна.">
          <div className="grid gap-5 sm:grid-cols-3">
            <Field label="Том хүн"><MoneyField ariaLabel="Том хүний үнэ" placeholder="Үнэ лавлах" disabled={disabled} value={hasPrice(fields.adult_price) ? String(fields.adult_price) : ""} onChange={money("adult_price")} /></Field>
            <Field label="Хүүхэд"><MoneyField ariaLabel="Хүүхдийн үнэ" placeholder="заавал биш" disabled={disabled} value={hasPrice(fields.child_price) ? String(fields.child_price) : ""} onChange={money("child_price")} /></Field>
            <Field label="Нярай"><MoneyField ariaLabel="Нярайн үнэ" placeholder="заавал биш" disabled={disabled} value={hasPrice(fields.infant_price) ? String(fields.infant_price) : ""} onChange={money("infant_price")} /></Field>
          </div>
          {hasPrice(fields.adult_price) && hasPrice(fields.child_price) && fields.child_price > fields.adult_price && (
            <p className="mt-2.5 flex items-start gap-2 text-xs leading-5 text-warning"><Icons.alert size={13} className="mt-0.5 shrink-0" /> Хүүхдийн үнэ том хүнийхээс өндөр байна. Зөв эсэхийг шалгана уу.</p>
          )}
          {!hasPrice(fields.adult_price) && (
            <p className="mt-2.5 text-xs leading-5 text-ink-muted">Файлд төгрөгийн зарах үнэ байгаагүй (юань, ландын үнэ бол хамтрагчийн өртөг тул авдаггүй). Хоосон орхивол сайтад <b className="text-ink">«Үнэ лавлах»</b> гэж гарна.</p>
          )}
          <button type="button" disabled={disabled} onClick={() => changeGroups([...groups, { ...emptyPriceGroup(), dates: departures.slice(0, 1), adult_price: hasPrice(fields.adult_price) ? fields.adult_price : null }])}
            className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-brand hover:text-brand-hover">
            <Icons.plus size={14} /> Гаралт тус бүрээр үнэ оруулах (буудал, багц өөр бол)
          </button>
        </Group>
      )}

      <Group title="Насны ангилал" hint="Хүүхэд, нярай гэж хэдэн наснаас хэдэн нас хүртэлхийг хэлэх вэ.">
        <div className="grid gap-5 sm:grid-cols-3">
          {([["adult", "Том хүн", "ж: 12+ нас"], ["child", "Хүүхэд", "ж: 2-11 нас"], ["infant", "Нярай", "ж: 0-23 сар"]] as const).map(([key, label, placeholder]) => (
            <Field key={key} label={label}><TextInput value={text(ages[key])} disabled={disabled} placeholder={placeholder} onChange={(e) => setExtra({ age_rules: { ...ages, [key]: e.target.value } })} /></Field>
          ))}
        </div>
      </Group>

      <div>
        <ItineraryTimeline
          days={itinerary.map((day, index) => ({ ...day, day: day.day ?? index + 1, title: day.title || "", description: day.description || "" }))}
          locked={isTransitDay}
          showSourceDates
          showMealNotes
          title={`Өдөр тутмын хөтөлбөр · ${itinerary.length} өдөр`}
          photoNote="Энэ өдрийн зураг. Доорх «Зураг» хэсгээс хасах эсвэл нүүр болгоно."
          onChange={(days) => onChange(setProgramDays(fields, days))}
        />
        <Evidence quote={evidence.meals} />
      </div>

      <Group title={photos.length ? `Зураг · ${photos.length}` : "Зураг"} hint={photos.length ? "Эхнийх нь нүүр зураг. Тохирохгүй зургийг хасна — цөөн, зөв зураг нь дээр." : undefined}>
        {photos.length > 0 ? (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {photos.map((photo, index) => (
              <li key={photo.url} className="group relative min-w-0">
                <div className="relative overflow-hidden rounded-lg border border-line bg-surface-sunken">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={thumb(photo.url, 480, 320)} alt={photo.title || `Зураг ${index + 1}`} loading="lazy" className="aspect-[3/2] w-full object-cover" />
                  {index === 0 && <span className="absolute left-2 top-2 rounded bg-ink/80 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">Нүүр зураг</span>}
                  <div className="absolute right-1.5 top-1.5 flex gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                    {index > 0 && (
                      <button type="button" disabled={disabled} onClick={() => onChange(makeCover(fields, photo.url))} title="Нүүр зураг болгох" aria-label="Нүүр зураг болгох"
                        className="flex h-7 items-center rounded-md bg-surface/95 px-2 text-[11px] font-semibold text-ink shadow-sm hover:bg-surface">Нүүр</button>
                    )}
                    <button type="button" disabled={disabled} onClick={() => onChange(removePhoto(fields, photo.url))} title="Энэ зургийг хасах" aria-label={`${photo.title || "Зураг"} хасах`}
                      className="flex h-7 w-7 items-center justify-center rounded-md bg-surface/95 text-ink-muted shadow-sm hover:bg-danger-soft hover:text-danger">
                      <Icons.trash size={13} />
                    </button>
                  </div>
                </div>
                <p className="mt-1.5 truncate text-xs font-medium text-ink" title={photo.title}>{photo.title || "Файлын зураг"}</p>
                <p className="truncate text-[11px] text-ink-subtle">{[photo.day ? `${photo.day}-р өдөр` : "", photo.author, photo.license].filter(Boolean).join(" · ") || "Таны оруулсан зураг"}</p>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyHint>Энэ аялалд тохирох зураг олдсонгүй. «Бүтэн засварлагчаар нээх» → «Зураг, бичлэг»-ээс нэмнэ.</EmptyHint>
        )}
        {found > 0 && <p className="mt-2.5 text-xs leading-5 text-ink-subtle">{found} зургийг хөтөлбөрт нэрлэсэн газруудаар Wikimedia Commons-оос хайж олсон (зохиогч, лицензийг хадгалсан).</p>}
      </Group>

      <Group title="Зочид буудлууд" hint="Буудал бүрийн холбоос, тайлбар, зураг. Вэбсайтын «Байрлах буудал» картанд харагдана.">
        <HotelProfilesEditor
          profiles={profiles}
          suggestions={hotelNamesOf(groups, text(fields.hotel))}
          onChange={(next: HotelProfile[]) => setExtra({ hotel_profiles: next })}
        />
      </Group>

      <Group title="Нөхцөл">
        <div className="grid gap-6 sm:grid-cols-2">
          <Field label="Үнэд багтсан"><ListEditor ariaLabel="Үнэд багтсан" addLabel="Нэмэх" tone="good" items={strings(extra.included_items)} onChange={(items) => setExtra({ included_items: items })} /></Field>
          <Field label="Үнэд багтаагүй"><ListEditor ariaLabel="Үнэд багтаагүй" addLabel="Нэмэх" tone="bad" items={strings(extra.excluded_items)} onChange={(items) => setExtra({ excluded_items: items })} /></Field>
          <Field label="Анхаарах зүйлс" className="sm:col-span-2" hint="Урьдчилгаа, цуцлалт, бүртгэлийн нөхцөл — файлд бичсэн валютаар нь.">
            <ListEditor ariaLabel="Анхаарах зүйл" addLabel="Нэмэх" items={strings(extra.important_notes)} onChange={(items) => setExtra({ important_notes: items })} />
          </Field>
        </div>
        <div className="mt-6 grid gap-5 sm:grid-cols-2">
          {TERMS.map(([key, label, placeholder]) => (
            <Field key={key} label={label}>
              <TextInput value={text(terms[key])} disabled={disabled} placeholder={placeholder} onChange={(e) => setExtra({ booking_terms: { deposit: "", payment: "", documents: "", visa: "", cancellation: "", ...terms, [key]: e.target.value } })} />
            </Field>
          ))}
          <Field label="Тэмдэглэл" className="sm:col-span-2">
            <TextArea value={text(fields.notes)} disabled={disabled} placeholder="заавал биш" onChange={(e) => onChange({ ...fields, notes: e.target.value })} />
          </Field>
        </div>
      </Group>

      <Group title="Вэбсайтын товч" hint="Сайтын аяллын картанд гарах 1-2 өгүүлбэр: үзэх газрууд, онцлог. Огноо, үнэ бичихгүй.">
        <TextArea value={text(extra.website_summary)} disabled={disabled} placeholder="ж: Далайн эрэг, усан парк, шилэн гүүр — гэр бүлээрээ амрах аялал." onChange={(e) => setExtra({ website_summary: e.target.value })} />
      </Group>
    </fieldset>
  );
}
