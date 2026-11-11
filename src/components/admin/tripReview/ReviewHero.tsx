/**
 * The top of the trip page as uudamtravel.mn shows it: the photos (cover first), the name, the short
 * summary, and one line of facts (duration · transport · hotel). Each is edited where it is shown:
 * the name and the texts are typed in place, a fact opens its panel under the line, a photo opens
 * the photo panel (make cover, remove).
 */
import type { ReactNode } from "react";
import { Icons, cx } from "@/components/ui";
import {
  applyTransport, checkDuration, itineraryOf, makeCover, removePhoto, transportOf, tripPhotos, withProgramDuration, type ReviewPhoto,
} from "@/lib/tripReview";
import { TRANSPORT_TYPES, isTransitDay, type TransportType } from "@/lib/tripTransitDays";
import { DurationSteppers } from "../tripEditor/DurationSteppers";
import { Field, TextInput } from "../tripEditor/parts";
import { AddChips, BedIcon, ClockIcon, EditPanel, Evidence, GhostTextArea, Notice, RouteIcon, primarySmall } from "./ReviewParts";
import { thumb } from "./photoThumb";
import { HERO_OPTIONAL, splitOptional, type OptionalKey, type ShowOptions } from "./reviewView";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? value as Row : {});
const text = (value: unknown) => (typeof value === "string" ? value : "");

export const TRANSPORT_SHORT: Record<TransportType, { label: string; hint: string }> = {
  land: { label: "Газраар", hint: "галт тэрэг, автобус" },
  land_flight: { label: "Газар + нислэг", hint: "хил гараад нисдэг" },
  direct_flight: { label: "Шууд нислэг", hint: "Улаанбаатараас нисдэг" },
  cruise: { label: "Усан онгоц", hint: "галт тэргээр боомт хүрнэ" },
};

export type HeroPanel = "photos" | "duration" | "transport" | "hotel";

export function ReviewHero({ fields, onChange, open, onOpen, onReveal, show, disabled }: {
  fields: Row;
  onChange: (next: Row) => void;
  /** The panel open in the review (only the hero's own matter here). */
  open: string | null;
  onOpen: (panel: HeroPanel | null) => void;
  /** A chip clicked: the empty field shows and takes the cursor. */
  onReveal: (key: OptionalKey) => void;
  show: ShowOptions;
  disabled?: boolean;
}) {
  const extra = record(fields.extra);
  const setExtra = (patch: Row) => onChange({ ...fields, extra: { ...extra, ...patch } });
  const photos = tripPhotos(fields);
  const itinerary = itineraryOf(fields);
  const transport = transportOf(fields);
  const added = itinerary.filter(isTransitDay).length;
  const duration = checkDuration(fields);
  const programDuration = text(extra.program_duration_text).trim();
  const evidence = record(extra.source_evidence);
  const name = text(fields.route_name);
  const durationText = text(fields.duration_text).trim();
  const hotel = text(fields.hotel).trim();
  const { shown, chips } = splitOptional(fields, HERO_OPTIONAL, show);
  const toggle = (panel: HeroPanel) => onOpen(open === panel ? null : panel);
  const setDuration = (value: string) => {
    const days = Number(/(\d+)\s*өдөр/.exec(value)?.[1]);
    const nights = Number(/(\d+)\s*шөнө/.exec(value)?.[1]);
    onChange({ ...fields, duration_text: value, extra: { ...extra, ...(days ? { duration_days: days } : {}), ...(Number.isFinite(nights) ? { duration_nights: nights } : {}) } });
  };
  const fact = (panel: HeroPanel, icon: ReactNode, value: ReactNode, empty = false) => (
    <button type="button" aria-expanded={open === panel} onClick={() => toggle(panel)} data-fact={panel}
      className={cx("inline-flex min-h-9 max-w-full items-center gap-2 rounded-md px-2.5 py-1 text-left text-[15px] leading-6 transition-colors",
        open === panel ? "bg-brand-soft text-brand" : empty ? "text-warning hover:bg-warning-soft/60" : "text-ink hover:bg-canvas")}>
      <span className={open === panel ? "text-brand" : "text-sun"}>{icon}</span>
      <span className="min-w-0">{value}</span>
    </button>
  );

  return (
    <div className="space-y-1">
      <Gallery photos={photos} active={open === "photos"} onOpen={() => toggle("photos")} />
      {open === "photos" && (
        <EditPanel target="photos" title={`Зураг · ${photos.length}`} onClose={() => onOpen(null)}>
          <PhotoGrid photos={photos} disabled={disabled} onCover={(url) => onChange(makeCover(fields, url))} onRemove={(url) => onChange(removePhoto(fields, url))} />
        </EditPanel>
      )}

      <div data-review-target="name" className="scroll-mt-24 pt-4">
        <label htmlFor="review-route-name" className="sr-only">Аяллын нэр</label>
        <GhostTextArea id="review-route-name" value={name} disabled={disabled} aria-invalid={!name.trim() || undefined} placeholder="Аяллын нэр оруулаагүй — энд бичнэ"
          onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }}
          onChange={(event) => onChange({ ...fields, route_name: event.target.value.replace(/\n/g, " ") })}
          className={cx("-mx-2.5 w-[calc(100%+1.25rem)] text-[26px] font-bold leading-9 tracking-tight sm:text-[30px] sm:leading-10",
            !name.trim() && "border-danger/60 bg-danger-soft/30 placeholder:text-danger/80")} />
      </div>

      {shown.includes("summary") && (
        <div data-review-target="summary" className="scroll-mt-24">
          <GhostTextArea aria-label="Товч танилцуулга (сайтын картанд гарна)" value={text(extra.website_summary)} disabled={disabled}
            placeholder="Сайтын картанд гарах 1-2 өгүүлбэр: үзэх газрууд, онцлог. Огноо, үнэ бичихгүй."
            onChange={(event) => setExtra({ website_summary: event.target.value })}
            className="-mx-2.5 w-[calc(100%+1.25rem)] max-w-3xl text-[16px] leading-7 text-ink-muted focus:text-ink" />
        </div>
      )}

      <div className="-mx-2.5 flex flex-wrap items-center gap-x-1 gap-y-1 pt-2" aria-label="Аяллын товч мэдээлэл">
        {fact("duration", <ClockIcon />, durationText || "Хугацаа оруулаагүй", !durationText)}
        {fact("transport", <RouteIcon />, transport ? TRANSPORT_SHORT[transport].label : "Тээвэр сонгоогүй", !transport)}
        {shown.includes("hotel") && fact("hotel", <BedIcon />, hotel || "Зочид буудал", !hotel)}
      </div>

      {open === "duration" && (
        <EditPanel target="duration" title="Хугацаа" onClose={() => onOpen(null)}>
          <div className="max-w-md"><DurationSteppers value={durationText} disabled={disabled} missing={!durationText} onChange={setDuration} /></div>
          {itinerary.length > 0 && (
            <p className="mt-2 text-[13px] leading-5 text-ink-muted">
              {added > 0
                ? `Файлын хөтөлбөр${programDuration ? ` (${programDuration})` : ""} хилээс эхэлдэг тул Улаанбаатараас гарах, буцах ${added} өдөр нэмэгдсэн.`
                : "Хөтөлбөр Улаанбаатараас эхэлж Улаанбаатарт дуусдаг тул өдөр нэмээгүй."}
            </p>
          )}
          <Evidence quote={evidence.duration} />
        </EditPanel>
      )}
      {open === "transport" && (
        <EditPanel target="transport" title="Тээвэр" onClose={() => onOpen(null)}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Тээврийн төрөл">
            {TRANSPORT_TYPES.map((type) => {
              const on = transport === type;
              return (
                <button key={type} type="button" role="radio" aria-checked={on} disabled={disabled || !itinerary.length}
                  onClick={() => { if (!on) onChange(applyTransport(fields, type).fields); }}
                  className={cx("rounded-md border px-3 py-2.5 text-left transition-colors disabled:opacity-60",
                    on ? "border-brand bg-brand-soft" : "border-line-strong bg-surface hover:border-brand")}>
                  <span className={cx("flex items-center gap-1.5 text-sm font-semibold", on ? "text-brand" : "text-ink")}>
                    {on && <Icons.check size={12} />}{TRANSPORT_SHORT[type].label}
                  </span>
                  <span className="mt-0.5 block text-[13px] leading-5 text-ink-muted">{TRANSPORT_SHORT[type].hint}</span>
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-[13px] leading-5 text-ink-muted">
            {itinerary.length ? "Тээврээс хамаарч Улаанбаатараас гарах, буцах стандарт өдрүүд, хугацаа өөрөө солигдоно." : "Хөтөлбөр алга тул тээврийг сонгох боломжгүй. Хөтөлбөртэй болмогц сонгоно."}
          </p>
        </EditPanel>
      )}
      {open === "hotel" && (
        <EditPanel target="hotel" title="Зочид буудал" onClose={() => onOpen(null)}>
          <Field id="review-hotel" label="Товч нэр" hint="Хэд хэдэн бол «А эсвэл Б» гэж бичнэ. Буудал бүрийн холбоос, зургийг доорх «Зочид буудал»-д нэмнэ.">
            <TextInput id="review-hotel" value={text(fields.hotel)} disabled={disabled} placeholder="ж: 4* буудал" onChange={(e) => onChange({ ...fields, hotel: e.target.value })} />
          </Field>
        </EditPanel>
      )}

      {duration.kind === "mismatch" && duration.programDays > duration.writtenDays && (
        <Notice>
          Файлд <b>«{duration.written}»</b> гэж бичсэн ч хөтөлбөрт <b>{duration.programDays} өдөр</b> байна.
          <button type="button" disabled={disabled} onClick={() => onChange(withProgramDuration(fields))} className={cx(primarySmall, "ml-2")}>
            Хөтөлбөрөөр: {duration.byProgram}
          </button>
        </Notice>
      )}
      {/* A program shorter than the stated length usually skips the free days (a free tour writes 3 of 8):
          shrinking the trip to the written days would be wrong, so there is no button for it. */}
      {duration.kind === "mismatch" && duration.programDays < duration.writtenDays && (
        <Notice>
          Хөтөлбөрт <b>{duration.programDays} өдөр</b> бичсэн — чөлөөт өдрүүд бичигдээгүй байж болно. Хугацаа файлын <b>«{duration.written}»</b> хэвээр.
        </Notice>
      )}

      {shown.includes("notes") && (
        <div data-review-target="notes" className="scroll-mt-24 pt-3">
          <p className="text-[13px] font-semibold text-ink-muted">Хуудасны тайлбар</p>
          <GhostTextArea aria-label="Хуудсанд гарах тайлбар" value={text(fields.notes)} disabled={disabled}
            placeholder="Аяллын хуудсанд тайлбар болж гарна. Бүтэн өгүүлбэрээр бичнэ."
            onChange={(event) => onChange({ ...fields, notes: event.target.value })}
            className="-mx-2.5 w-[calc(100%+1.25rem)] max-w-3xl text-[15px] leading-7" />
        </div>
      )}

      <AddChips chips={chips} onAdd={onReveal} />
    </div>
  );
}

/** The photos as the page opens with them: the cover large, the next ones beside it. */
function Gallery({ photos, active, onOpen }: { photos: ReviewPhoto[]; active: boolean; onOpen: () => void }) {
  if (!photos.length) {
    return (
      <button type="button" onClick={onOpen} className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong px-4 py-8 text-sm text-ink-muted hover:border-brand hover:text-brand">
        <Icons.image size={18} /> Зураг олдсонгүй. «Бүтэн засварлагч» → «Зураг, бичлэг»-ээс нэмнэ.
      </button>
    );
  }
  const shown = photos.slice(0, 9);
  const more = photos.length - shown.length;
  return (
    <div className={cx("grid grid-cols-4 gap-1.5 rounded-xl sm:grid-cols-6 sm:gap-2", active && "ring-2 ring-brand ring-offset-2")} data-review-target="gallery">
      {shown.map((photo, index) => (
        <button key={photo.url} type="button" onClick={onOpen} aria-label={index === 0 ? "Нүүр зураг. Зураг засах" : `${photo.title || `Зураг ${index + 1}`}. Зураг засах`}
          className={cx("group relative overflow-hidden rounded-lg bg-surface-sunken focus-visible:ring-2 focus-visible:ring-brand",
            index === 0 ? "col-span-4 aspect-[16/9] sm:col-span-2 sm:row-span-2 sm:aspect-auto sm:min-h-64" : "aspect-[4/3]", index > 4 && "hidden sm:block")}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={thumb(photo.url, index === 0 ? 960 : 360, index === 0 ? 640 : 270)} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
          {index === 0 && <span className="absolute left-2 top-2 rounded bg-ink/80 px-1.5 py-0.5 text-[12px] font-semibold text-white">Нүүр зураг</span>}
          {index === shown.length - 1 && more > 0 && (
            <span className="absolute inset-0 flex items-center justify-center bg-ink/55 text-[15px] font-semibold text-white">+{more}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/** Every photo with its credit: make it the cover, or take it off. */
function PhotoGrid({ photos, disabled, onCover, onRemove }: { photos: ReviewPhoto[]; disabled?: boolean; onCover: (url: string) => void; onRemove: (url: string) => void }) {
  const found = photos.filter((photo) => photo.author || photo.license).length;
  return (
    <>
      <p className="mb-3 text-[13px] leading-5 text-ink-muted">Эхнийх нь нүүр зураг. Тохирохгүй зургийг хасна — цөөн, зөв зураг нь дээр.</p>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {photos.map((photo, index) => (
          <li key={photo.url} className="min-w-0">
            <div className="relative overflow-hidden rounded-lg border border-line bg-surface-sunken">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={thumb(photo.url, 480, 320)} alt={photo.title || `Зураг ${index + 1}`} loading="lazy" className="aspect-[3/2] w-full object-cover" />
              {index === 0 && <span className="absolute left-2 top-2 rounded bg-ink/80 px-1.5 py-0.5 text-[12px] font-semibold text-white">Нүүр зураг</span>}
            </div>
            <p className="mt-1.5 truncate text-[13px] font-medium text-ink" title={photo.title}>{photo.title || "Файлын зураг"}</p>
            <p className="truncate text-[12px] text-ink-muted">{[photo.day ? `${photo.day}-р өдөр` : "", photo.author, photo.license].filter(Boolean).join(" · ") || "Таны оруулсан зураг"}</p>
            <span className="mt-1.5 flex gap-1.5">
              {index > 0 && (
                <button type="button" disabled={disabled} onClick={() => onCover(photo.url)}
                  className="h-8 rounded-md border border-line-strong bg-surface px-2.5 text-[12px] font-semibold text-ink hover:border-brand">Нүүр болгох</button>
              )}
              <button type="button" disabled={disabled} onClick={() => onRemove(photo.url)} aria-label={`${photo.title || "Зураг"} хасах`}
                className="flex h-8 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-ink-muted hover:bg-danger-soft hover:text-danger">
                <Icons.trash size={13} /> Хасах
              </button>
            </span>
          </li>
        ))}
      </ul>
      {found > 0 && <p className="mt-3 text-[13px] leading-5 text-ink-muted">{found} зургийг хөтөлбөрт нэрлэсэн газруудаар Wikimedia Commons-оос хайж олсон (зохиогч, лицензийг хадгалсан).</p>}
    </>
  );
}
