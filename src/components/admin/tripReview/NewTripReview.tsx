import type { ReactNode } from "react";
import { Icons, cx } from "@/components/ui";
import {
  addDaysYmd, applyTransport, checkDeparture, checkDuration, departureDays, formatYmd, hasPrice, itineraryOf, makeCover, priceRows,
  removePhoto, setDepartureDays, transportOf, tripPhotos, withProgramDuration,
} from "@/lib/tripReview";
import { TRANSPORT_TYPES, isTransitDay, type TransportType } from "@/lib/tripTransitDays";
import { MoneyField, TextArea, TextInput } from "../tripEditor/parts";
import { DayCards, thumb } from "./DayCards";
import { MultiDateCalendar } from "./MultiDateCalendar";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? value as Row : {});
const text = (value: unknown) => (typeof value === "string" ? value : "");
const lines = (value: unknown) => (Array.isArray(value) ? value.map((item) => String(item ?? "")).join("\n") : "");
const fromLines = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean);

const TRANSPORT_SHORT: Record<TransportType, { label: string; hint: string }> = {
  land: { label: "Газраар", hint: "галт тэрэг, автобус" },
  land_flight: { label: "Газар + нислэг", hint: "хил гараад нисдэг" },
  direct_flight: { label: "Шууд нислэг", hint: "Улаанбаатараас нисдэг" },
  cruise: { label: "Усан онгоц", hint: "галт тэргээр боомт хүрнэ" },
};

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="px-4 py-5 sm:px-6" aria-label={title}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h4 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-muted">{title}</h4>
        {aside && <span className="text-xs text-ink-subtle">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

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

function Label({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <span className="mb-1.5 flex items-baseline justify-between gap-2 text-[13px] font-medium text-ink">
      <span>{children}</span>
      {hint && <span className="text-[11px] font-normal text-ink-subtle">{hint}</span>}
    </span>
  );
}

/**
 * A trip read from a file, laid out for review the way the trip itself is
 * structured: when it leaves, how it travels, what it costs, what happens each
 * day, what it looks like. Everything was read from the file; the admin
 * corrects by clicking — dates on a calendar, meals on chips, transport on a
 * switch — and types only what the file did not have.
 */
export function NewTripReview({
  fields,
  onChange,
  warnings,
  disabled,
}: {
  fields: Row;
  onChange: (next: Row) => void;
  /** The assistant's real doubts about this trip (not what the sections already say). */
  warnings: string[];
  disabled?: boolean;
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
  const fares = priceRows(fields);
  const duration = checkDuration(fields);
  const found = photos.filter((photo) => photo.author || photo.license).length;
  const amount = (value: number) => `${value.toLocaleString("en-US")}₮`;
  const childAge = text(record(extra.age_rules).child).trim();
  const programDuration = text(extra.program_duration_text).trim();
  const money = (key: string) => (digits: string) => onChange({ ...fields, [key]: digits === "" ? null : Number(digits) });

  return (
    <div className="divide-y divide-line">
      <Section title="Аяллын нэр">
        <input
          aria-label="Аяллын нэр"
          value={text(fields.route_name)}
          disabled={disabled}
          onChange={(e) => onChange({ ...fields, route_name: e.target.value })}
          placeholder="Аяллын нэр"
          className="h-12 w-full rounded-md border border-line-strong bg-surface px-3.5 text-lg font-bold tracking-tight text-ink transition-colors placeholder:font-normal placeholder:text-ink-subtle focus:border-brand focus:outline-none focus:ring-3 focus:ring-brand/10"
        />
      </Section>

      <Section title="Гарах өдрүүд" aside="календариас дарж сонгоно">
        <MultiDateCalendar
          selected={departures}
          tripDays={itinerary.length || undefined}
          disabled={disabled}
          onChange={(next) => onChange(setDepartureDays(fields, next))}
        />
        {rules.length > 0 && (
          <p className="mt-3 text-xs leading-5 text-ink-muted">Файлд бичсэн хуваарь: <span className="font-medium text-ink">{rules.join(", ")}</span></p>
        )}
        {check.kind === "shift" && (
          <div className="mt-3 rounded-lg border border-warning/30 bg-warning-soft/60 px-3.5 py-3">
            <p className="text-[13px] leading-5 text-ink">
              Файлд <b>{formatYmd(check.departure)}</b> нь хөтөлбөрийн эхний өдөр (хил дээр). Улаанбаатараас галт тэрэг өмнөх орой нь хөдөлдөг.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" disabled={disabled} onClick={() => onChange(setDepartureDays(fields, departures.map((day) => (day === check.departure ? check.suggested : day))))}
                className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-hover">
                {formatYmd(check.suggested)}-нд Улаанбаатараас гарна
              </button>
              <button type="button" disabled={disabled} onClick={() => onChange({ ...fields, extra: { ...extra, itinerary_days: itinerary.map((day) => ({ ...day, date: "" })) } })}
                className="rounded-md border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-ink-muted hover:border-brand hover:text-ink">
                {formatYmd(check.departure)} хэвээр
              </button>
            </div>
          </div>
        )}
        {check.kind === "conflict" && (
          <p className="mt-3 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft/60 px-3.5 py-2.5 text-[13px] leading-5 text-ink">
            <Icons.alert size={14} className="mt-0.5 shrink-0 text-warning" />
            <span>Гарах өдөр {formatYmd(check.departure)} боловч файлд хөтөлбөрийн эхний өдрийг {formatYmd(check.programStart)} гэж бичсэн ({formatYmd(check.expected)} байх ёстой). Аль нь зөвийг шалгаад календариас засна уу.</span>
          </p>
        )}
        {check.kind === "consistent" && (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-success">
            <Icons.check size={12} /> Файлын өдрүүдтэй таарч байна: хөтөлбөрийн эхний өдөр {formatYmd(check.programStart)}.
          </p>
        )}
        {check.kind === "unknown" && added > 0 && departures.length > 0 && (
          <p className="mt-3 text-xs leading-5 text-ink-muted">Сонгосон өдөр бол Улаанбаатараас галт тэрэг хөдлөх өдөр. Хөтөлбөрийн дараагийн өдөр ({formatYmd(addDaysYmd(departures[0], 1))}) хил давна.</p>
        )}
        <Evidence quote={evidence.departure} />
      </Section>

      <Section title="Тээвэр, хугацаа" aside={text(fields.duration_text) ? <span className="font-semibold text-ink">{text(fields.duration_text)}</span> : undefined}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Тээврийн төрөл">
          {TRANSPORT_TYPES.map((type) => {
            const on = transport === type;
            return (
              <button key={type} type="button" role="radio" aria-checked={on} disabled={disabled || !itinerary.length}
                onClick={() => { if (!on) onChange(applyTransport(fields, type).fields); }}
                className={cx("rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-60",
                  on ? "border-brand bg-brand-soft" : "border-line-strong bg-surface hover:border-brand")}>
                <span className={cx("flex items-center gap-1.5 text-[13px] font-semibold", on ? "text-brand" : "text-ink")}>
                  {on && <Icons.check size={12} />}{TRANSPORT_SHORT[type].label}
                </span>
                <span className="mt-0.5 block text-[11px] leading-4 text-ink-muted">{TRANSPORT_SHORT[type].hint}</span>
              </button>
            );
          })}
        </div>
        {itinerary.length > 0 && (
          <p className="mt-3 text-[13px] leading-5 text-ink-muted">
            {added > 0
              ? <>Файлын хөтөлбөр{programDuration ? ` (${programDuration})` : ""} хилээс эхэлдэг тул Улаанбаатараас галт тэргээр гарах, буцах <b className="text-ink">{added} өдөр</b> нэмэгдсэн: нийт <b className="text-ink">{text(fields.duration_text)}</b>. Хөтөлбөр дотор «Стандарт өдөр» гэж тэмдэглэсэн.</>
              : <>Хөтөлбөр Улаанбаатараас эхэлж Улаанбаатарт дуусдаг тул өдөр нэмээгүй. Хугацааг хөтөлбөрөөс авсан.</>}
          </p>
        )}
        {duration.kind === "mismatch" && (
          <div className="mt-3 rounded-lg border border-warning/30 bg-warning-soft/60 px-3.5 py-3">
            <p className="text-[13px] leading-5 text-ink">
              Файлд <b>«{duration.written}»</b> гэж бичсэн ч хөтөлбөрт <b>{duration.programDays} өдөр</b> байна. Аль нь зөв бэ?
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button type="button" disabled={disabled} onClick={() => onChange(withProgramDuration(fields))}
                className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-hover">
                Хөтөлбөрөөр: {duration.byProgram}
              </button>
              <span className="text-xs text-ink-muted">Өдөр дутуу уншигдсан бол доорх хөтөлбөрөөс шалгана уу.</span>
            </div>
          </div>
        )}
        <Evidence quote={evidence.duration} />
      </Section>

      <Section title="Үнэ" aside="нэг хүний, төгрөгөөр">
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block min-w-0">
            <Label>Том хүн</Label>
            <MoneyField ariaLabel="Том хүний үнэ" placeholder="Үнэ лавлах" disabled={disabled} value={hasPrice(fields.adult_price) ? String(fields.adult_price) : ""} onChange={money("adult_price")} />
          </label>
          <label className="block min-w-0">
            <Label hint={childAge || undefined}>Хүүхэд</Label>
            <MoneyField ariaLabel="Хүүхдийн үнэ" placeholder="заавал биш" disabled={disabled} value={hasPrice(fields.child_price) ? String(fields.child_price) : ""} onChange={money("child_price")} />
          </label>
          <label className="block min-w-0">
            <Label>Нярай</Label>
            <MoneyField ariaLabel="Нярайн үнэ" placeholder="заавал биш" disabled={disabled} value={hasPrice(fields.infant_price) ? String(fields.infant_price) : ""} onChange={money("infant_price")} />
          </label>
        </div>
        {hasPrice(fields.adult_price) && hasPrice(fields.child_price) && fields.child_price > fields.adult_price && (
          <p className="mt-2.5 flex items-start gap-2 text-xs leading-5 text-warning">
            <Icons.alert size={13} className="mt-0.5 shrink-0" /> Хүүхдийн үнэ том хүнийхээс өндөр байна. Зөв эсэхийг шалгана уу.
          </p>
        )}
        {!hasPrice(fields.adult_price) && !fares.length && (
          <p className="mt-2.5 text-xs leading-5 text-ink-muted">
            Файлд төгрөгийн зарах үнэ байгаагүй (юань, ландын үнэ бол хамтрагчийн өртөг тул авдаггүй). Хоосон орхивол сайтад <b className="text-ink">«Үнэ лавлах»</b> гэж гарна, дараа нь хэзээ ч нэмж болно.
          </p>
        )}
        {fares.length > 0 && (
          <div className="mt-4 overflow-hidden rounded-lg border border-line">
            <p className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-line bg-canvas/60 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
              <span>Гарах өдөр тус бүрийн үнэ · файлаас</span>
              <span className="font-normal normal-case tracking-normal">дээрх нь сайтын картанд гарах эхлэх үнэ</span>
            </p>
            <ul className="divide-y divide-line text-[13px]">
              {fares.map((fare, index) => (
                <li key={index} className="grid gap-x-4 gap-y-1 px-3 py-2.5 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]">
                  <span className="min-w-0 font-medium text-ink">
                    {fare.dates.map((day) => formatYmd(day)).join(", ")}
                    {fare.label && <span className="block font-normal text-ink-muted">{fare.label}</span>}
                  </span>
                  <span className="flex min-w-0 flex-wrap gap-x-4 gap-y-0.5 tabular-nums text-ink-muted">
                    {fare.adult !== null && <span>Том хүн <b className="font-semibold text-ink">{amount(fare.adult)}</b></span>}
                    {fare.child !== null && !fare.bands.length && <span>Хүүхэд <b className="font-semibold text-ink">{amount(fare.child)}</b></span>}
                    {fare.infant !== null && !fare.bands.length && <span>Нярай <b className="font-semibold text-ink">{fare.infant === 0 ? "Үнэгүй" : amount(fare.infant)}</b></span>}
                    {fare.bands.map((band, bandIndex) => (
                      <span key={bandIndex}>{band.label} <b className="font-semibold text-ink">{band.price === 0 ? "Үнэгүй" : amount(band.price)}</b></span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
            <p className="border-t border-line px-3 py-2 text-xs leading-5 text-ink-subtle">Нэг өдрийн үнийг өөрчлөх бол ноорог болгон хадгалаад «Аяллууд» → «Үнэ» хэсгээс засна. Календариас хассан өдрийн үнэ хамт хасагдана.</p>
          </div>
        )}
      </Section>

      <Section title="Өдөр тутмын хөтөлбөр" aside={itinerary.length ? `${itinerary.length} өдөр` : undefined}>
        {itinerary.length > 0 ? (
          <>
            <DayCards days={itinerary} disabled={disabled} onChange={(days) => setExtra({ itinerary_days: days })} />
            <Evidence quote={evidence.meals} />
          </>
        ) : (
          <p className="rounded-lg border border-dashed border-line px-4 py-5 text-center text-sm text-ink-muted">Файлд өдөр тутмын хөтөлбөр олдсонгүй. Хадгалсны дараа «Аяллууд» хэсгээс нэмж болно.</p>
        )}
      </Section>

      <Section title="Зураг" aside={photos.length ? `${photos.length} зураг · эхнийх нь нүүр зураг` : undefined}>
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
                <p className="truncate text-[11px] text-ink-subtle">
                  {[photo.day ? `${photo.day}-р өдөр` : "", photo.author, photo.license].filter(Boolean).join(" · ") || "Таны оруулсан зураг"}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-lg border border-dashed border-line px-4 py-5 text-center text-sm text-ink-muted">Энэ аялалд тохирох зураг олдсонгүй. Хадгалсны дараа «Зураг оруулах» хэсгээс нэмнэ.</p>
        )}
        {found > 0 && (
          <p className="mt-2.5 text-xs leading-5 text-ink-subtle">
            {found} зургийг хөтөлбөрт нэрлэсэн газруудаар Wikimedia Commons-оос хайж олсон (зохиогч, лицензийг хадгалсан). Тохирохгүй зургийг хогийн саваар хасна — цөөн, зөв зураг нь дээр.
          </p>
        )}
      </Section>

      <Section title="Буудал, нөхцөл">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block min-w-0 sm:col-span-2">
            <Label>Буудал</Label>
            <TextInput aria-label="Буудал" value={text(fields.hotel)} disabled={disabled} placeholder="заавал биш" onChange={(e) => onChange({ ...fields, hotel: e.target.value })} />
          </label>
          <label className="block min-w-0">
            <Label hint="мөр бүрт нэг">Үнэд багтсан</Label>
            <TextArea aria-label="Үнэд багтсан зүйлс" value={lines(extra.included_items)} disabled={disabled} placeholder="Файлд жагсаалт байгаагүй" onChange={(e) => setExtra({ included_items: fromLines(e.target.value) })} />
          </label>
          <label className="block min-w-0">
            <Label hint="мөр бүрт нэг">Үнэд багтаагүй</Label>
            <TextArea aria-label="Үнэд багтаагүй зүйлс" value={lines(extra.excluded_items)} disabled={disabled} placeholder="Файлд жагсаалт байгаагүй" onChange={(e) => setExtra({ excluded_items: fromLines(e.target.value) })} />
          </label>
          <label className="block min-w-0 sm:col-span-2">
            <Label hint="мөр бүрт нэг">Анхаарах зүйлс</Label>
            <TextArea aria-label="Анхаарах зүйлс" value={lines(extra.important_notes)} disabled={disabled} placeholder="Урьдчилгаа, цуцлалт, бүртгэлийн нөхцөл" onChange={(e) => setExtra({ important_notes: fromLines(e.target.value) })} />
          </label>
          <label className="block min-w-0 sm:col-span-2">
            <Label hint="цуцлалтын хураамж зэргийг файлд бичсэн валютаар нь">Тэмдэглэл</Label>
            <TextArea aria-label="Тэмдэглэл" value={text(fields.notes)} disabled={disabled} placeholder="заавал биш" onChange={(e) => onChange({ ...fields, notes: e.target.value })} />
          </label>
        </div>
      </Section>

      {warnings.length > 0 && (
        <Section title="Шалгах зүйлс">
          <ul className="space-y-1.5">
            {warnings.map((warning) => (
              <li key={warning} className="flex items-start gap-2 text-[13px] leading-5 text-ink">
                <Icons.alert size={14} className="mt-0.5 shrink-0 text-warning" />
                <span className="min-w-0 whitespace-pre-line">{warning}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
