/**
 * The lower parts of the trip page in the review: what the price includes and not, the hotels, the
 * notes and booking terms. Short lists edited line by line where they are read; a booking term is
 * one line of text. An empty one is a «+ …» chip at the bottom of its part (reviewView.ts).
 */
import { Icons } from "@/components/ui";
import type { HotelProfile } from "@/lib/adminTypes";
import { parseHotelProfiles } from "@/lib/tripEditorState";
import { reviewPriceGroups } from "@/lib/tripReviewPrices";
import { HotelProfilesEditor, hotelNamesOf } from "../tripEditor/HotelProfilesEditor";
import { AddChips, BedIcon, EditPanel, GhostInput, ReviewSection } from "./ReviewParts";
import { ReviewList } from "./ReviewList";
import {
  BOOKING_TERMS, CONDITION_OPTIONAL, LIST_OPTIONAL, splitOptional, type OptionalKey, type ShowOptions,
} from "./reviewView";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? value as Row : {});
const strings = (value: unknown) => (Array.isArray(value) ? value.map((item) => String(item ?? "")) : []);
const text = (value: unknown) => (typeof value === "string" ? value : "");

type Props = {
  fields: Row;
  onChange: (next: Row) => void;
  onReveal: (key: OptionalKey) => void;
  show: ShowOptions;
  disabled?: boolean;
};

/** «Үнэд багтсан» / «Үнэд багтаагүй», side by side as on the trip page. */
export function IncludedSection({ fields, onChange, onReveal, show }: Props) {
  const extra = record(fields.extra);
  const setExtra = (patch: Row) => onChange({ ...fields, extra: { ...extra, ...patch } });
  const { shown, chips } = splitOptional(fields, LIST_OPTIONAL, show);
  return (
    <ReviewSection title="Үнэд юу багтсан бэ" chips={<AddChips chips={chips} onAdd={onReveal} />}>
      {shown.length > 0 && (
        <div className="grid gap-x-8 gap-y-6 md:grid-cols-2">
          {shown.includes("list:included") && (
            <div data-review-target="list:included" className="min-w-0 scroll-mt-24">
              <h4 className="mb-1.5 text-[15px] font-semibold text-ink">Үнэд багтсан</h4>
              <ReviewList variant="preview" ariaLabel="Үнэд багтсан" addLabel="Мөр нэмэх" tone="good" items={strings(extra.included_items)} onChange={(items) => setExtra({ included_items: items })} />
            </div>
          )}
          {shown.includes("list:excluded") && (
            <div data-review-target="list:excluded" className="min-w-0 scroll-mt-24">
              <h4 className="mb-1.5 text-[15px] font-semibold text-ink">Үнэд багтаагүй</h4>
              <ReviewList variant="preview" ariaLabel="Үнэд багтаагүй" addLabel="Мөр нэмэх" tone="bad" items={strings(extra.excluded_items)} onChange={(items) => setExtra({ excluded_items: items })} />
            </div>
          )}
        </div>
      )}
    </ReviewSection>
  );
}

/** The hotels the website's «Байрлах буудал» cards show (extra.hotel_profiles): read as cards, edited in a panel. */
export function HotelsSection({ fields, onChange, open, onOpen, show }: Props & { open: boolean; onOpen: (next: boolean) => void }) {
  const extra = record(fields.extra);
  const profiles = parseHotelProfiles(JSON.stringify(Array.isArray(extra.hotel_profiles) ? extra.hotel_profiles : []));
  const { shown } = splitOptional(fields, ["profiles"], show);
  if (!shown.length && !open) return null;
  return (
    <ReviewSection target="profiles" title="Зочид буудал" meta={profiles.length ? `· ${profiles.length}` : undefined}
      action={!open && (
        <button type="button" onClick={() => onOpen(true)} className="inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-brand hover:bg-brand-soft">
          <Icons.edit size={14} /> Засах
        </button>
      )}>
      {open ? (
        <EditPanel title="Буудлын холбоос, тайлбар, зураг" onClose={() => onOpen(false)} className="mt-0">
          <HotelProfilesEditor profiles={profiles} suggestions={hotelNamesOf(reviewPriceGroups(fields) as Array<{ hotel?: string | null }>, text(fields.hotel))}
            onChange={(next: HotelProfile[]) => onChange({ ...fields, extra: { ...extra, hotel_profiles: next } })} />
        </EditPanel>
      ) : profiles.length ? (
        <ul className="grid gap-2 md:grid-cols-2">
          {profiles.map((profile, index) => (
            <li key={`${profile.name}-${index}`} className="min-w-0">
              <button type="button" onClick={() => onOpen(true)}
                className="flex h-full w-full items-start gap-3 rounded-lg border border-line bg-surface p-3.5 text-left transition-colors hover:border-brand">
                <span className="mt-1 text-sun"><BedIcon /></span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-semibold leading-6 text-ink">{profile.name || `Буудал ${index + 1}`}</span>
                  {profile.description && <span className="mt-0.5 line-clamp-2 block text-[13px] leading-5 text-ink-muted">{profile.description}</span>}
                  <span className="mt-1 block text-[12px] text-ink-subtle">
                    {[profile.url ? "холбоостой" : "холбоосгүй", profile.media.length ? `${profile.media.length} зураг` : "зураггүй"].join(" · ")}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-muted">Буудлын холбоос, зураг оруулаагүй. «Засах» дарж нэмнэ.</p>
      )}
    </ReviewSection>
  );
}

/** «Анхаарах зүйл» and the booking terms the bot answers from («урьдчилгаа хэд вэ?», «виз хэрэгтэй юу?»). */
export function ConditionsSection({ fields, onChange, onReveal, show, disabled }: Props) {
  const extra = record(fields.extra);
  const setExtra = (patch: Row) => onChange({ ...fields, extra: { ...extra, ...patch } });
  const terms = record(extra.booking_terms);
  const { shown, chips } = splitOptional(fields, CONDITION_OPTIONAL, show);
  const shownTerms = BOOKING_TERMS.filter((term) => shown.includes(`terms:${term.key}`));
  const termChips = chips.some((chip) => chip.key.startsWith("terms:"));
  return (
    <ReviewSection title="Анхаарах зүйл, нөхцөл"
      chips={(
        <>
          <AddChips chips={chips} onAdd={onReveal} />
          {termChips && (
            <p className="mt-2 text-[13px] leading-5 text-ink-subtle">Бот «урьдчилгаа хэд вэ?», «виз хэрэгтэй юу?» зэрэг асуултад эдгээрээс хариулна; хоосон бол хариулахгүй.</p>
          )}
        </>
      )}>
      {shown.includes("list:important") && (
        <div data-review-target="list:important" className="scroll-mt-24">
          <ReviewList variant="preview" ariaLabel="Анхаарах зүйл" addLabel="Мөр нэмэх" items={strings(extra.important_notes)} onChange={(items) => setExtra({ important_notes: items })} />
        </div>
      )}
      {shownTerms.length > 0 && (
        <dl className="mt-4 divide-y divide-line rounded-xl border border-line">
          {shownTerms.map((term) => (
            <div key={term.key} data-review-target={`terms:${term.key}`} className="grid scroll-mt-24 items-center gap-x-4 gap-y-0.5 px-3 py-2 sm:grid-cols-[9rem_minmax(0,1fr)] sm:px-4">
              <dt className="px-2.5 text-[13px] font-semibold text-ink-muted sm:px-0">{term.label}</dt>
              <dd className="min-w-0">
                <GhostInput aria-label={term.label} value={text(terms[term.key])} disabled={disabled} placeholder={term.placeholder} className="text-[15px]"
                  onChange={(e) => setExtra({ booking_terms: { deposit: "", payment: "", documents: "", visa: "", cancellation: "", ...terms, [term.key]: e.target.value } })} />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </ReviewSection>
  );
}
