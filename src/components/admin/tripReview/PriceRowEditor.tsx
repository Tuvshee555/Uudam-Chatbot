/**
 * One price row of the review's dates-and-prices table, opened for editing under the row. The
 * editing power of the old price card stays whole (tripReviewPrices.ts does the work): the adult,
 * child and infant fare, extra age bands, a date split off to its own price or moved to another
 * row, another hotel or package for the same days, the row dropped. What changed is what shows: the
 * adult and child fare always; the infant fare, hotel, package, single-room extra, name and note
 * only when they hold a value (or their column is shown); the rest are «+ …» chips.
 *
 * The adult and child fare are red while empty (the owner's rule: a trip is published with them;
 * the infant fare is optional and a draft needs none).
 */
import { useId, useState } from "react";
import { Icons, cx } from "@/components/ui";
import type { PassengerPrice } from "@/lib/adminTypes";
import {
  ALL_CARD, BAND_PROBLEM_TEXT, addExtraBand, addOption, bandProblems, cardShort, dayLabel, dropCard, moveDays, patchCard,
  setCardBands, setCardFare, splitDays, type FareKind, type PriceCard,
} from "@/lib/tripReviewPrices";
import { INVERTED_BAND_TEXT, cardWhere, invertedBands } from "@/lib/tripReviewProblems";
import { PassengerBandRow } from "../tripEditor/PricingEditor";
import { Checkbox, Field, MoneyField, TextInput } from "../tripEditor/parts";
import { AddChips, linkButton, useReturnFocus } from "./ReviewParts";
import { cardFields, type CardField, type PriceColumn } from "./reviewView";

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value : "");

export type Chooser = { key: string; picked: string[] };

export function PriceRowEditor({ card, cards, years, hasAll, columns, showAll, fields, onChange, onClose, chooser, setChooser }: {
  card: PriceCard;
  cards: PriceCard[];
  years: boolean;
  hasAll: boolean;
  columns: readonly PriceColumn[];
  showAll?: boolean;
  fields: Row;
  onChange: (next: Row) => void;
  onClose: () => void;
  chooser: Chooser | null;
  setChooser: (next: Chooser | null) => void;
}) {
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set());
  const own = card.kind === "own";
  const act = (next: Row) => { setChooser(null); onChange(next); };
  const money = (kind: FareKind) => (digits: string) => onChange(setCardFare(fields, card.key, kind, digits === "" ? null : Number(digits)));
  const free = card.infant === 0;
  const dayCount = card.days.length + card.other.length;
  const extras = card.bands.filter((band) => band.role === "other");
  const bandIssues = bandProblems(card);
  const inverted = invertedBands(card);
  const targets = cards.filter((other) => other.key !== card.key);
  const choosing = chooser !== null;
  const picked = chooser?.picked ?? [];
  const toggle = (day: string) => setChooser({ key: card.key, picked: picked.includes(day) ? picked.filter((entry) => entry !== day) : [...picked, day] });
  const setBands = (rows: Row[]) => onChange(setCardBands(fields, card.key, rows));
  const bandRows = card.bands.map((band) => band.row);
  // Which row a price box belongs to, for a screen reader: the first day and how many more.
  const where = card.days.length ? ` · ${dayLabel(card.days[0], years)}${dayCount > 1 ? ` +${dayCount - 1}` : ""}` : "";
  const adultAbove = card.adult !== null && card.child !== null && card.child > card.adult;
  const { shown, chips } = cardFields(card, columns, { all: showAll, revealed });
  const has = (field: CardField) => shown.includes(field);
  const reveal = (field: CardField) => {
    setRevealed((current) => new Set([...current, `${card.key}:${field}`]));
    window.requestAnimationFrame(() => document.getElementById(id(field))?.focus());
  };
  const panel = useReturnFocus();
  const optionalChips = [...chips, ...(own ? [{ key: "bands" as const, label: "Өөр насны ангилал" }] : [])];

  return (
    <div ref={panel} role="group" aria-label={`Үнэ засах: ${cardWhere(card, years)}`}
      onKeyDown={(event) => { if (event.key === "Escape" && !(event.target instanceof HTMLSelectElement)) { event.preventDefault(); onClose(); } }}
      className="mx-0 mb-4 mt-1 rounded-xl border border-brand-border bg-surface p-4 shadow-[0_8px_24px_-18px_rgb(15_118_110/0.45)] sm:mx-2 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p className="min-w-0 flex-1 basis-56 text-[15px] font-semibold text-ink">
          {own ? "Энэ мөрийн үнэ" : dayCount ? "Бусад өдрийн үнэ" : "Аяллын үнэ"}
          <span className="font-normal text-ink-muted"> · нэг хүний, төгрөгөөр</span>
        </p>
        <div className="flex flex-wrap items-center gap-1">
          {dayCount >= 2 && !choosing && (
            <button type="button" className={linkButton} onClick={() => setChooser({ key: card.key, picked: [] })}>
              {own ? "Өдөр салгах, шилжүүлэх…" : "Энэ огнооны үнэ өөр бол…"}
            </button>
          )}
          {own && (
            <button type="button" className={cx(linkButton, "text-ink-muted hover:text-danger")} onClick={() => { act(dropCard(fields, card.key)); onClose(); }}
              title={hasAll ? "Эдгээр өдөр дахин «Бусад өдөр»-ийн үнэтэй болно" : "Эдгээр өдөр үнэгүй болно, дараа нь үнийг нь оруулна"}>
              <Icons.trash size={13} /> {hasAll ? "Тусдаа үнийг болих" : "Энэ үнийг арилгах"}
            </button>
          )}
          <button type="button" onClick={onClose} className="h-9 rounded-md px-3 text-sm font-semibold text-brand hover:bg-brand-soft">Болсон</button>
        </div>
      </div>

      {choosing && (
        <div className="mt-3 rounded-lg border border-brand-border bg-brand-soft/30 p-3">
          <p className="text-sm leading-6 text-ink">
            {own ? "Салгах эсвэл шилжүүлэх өдрүүдээ дарж сонгоно уу." : "Үнэ нь өөр өдрүүдээ дарж сонгоно уу. Тэд тусдаа үнэтэй мөр болно."}
          </p>
          <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Өдөр сонгох">
            {card.days.map((day) => {
              const on = picked.includes(day);
              return (
                <li key={day}>
                  <button type="button" aria-pressed={on} onClick={() => toggle(day)}
                    className={cx("inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium tabular-nums hover:border-brand",
                      on ? "border-brand bg-brand-soft text-brand" : "border-line-strong bg-surface text-ink")}>
                    <span className={cx("flex h-3.5 w-3.5 items-center justify-center rounded-sm border", on ? "border-brand bg-brand text-white" : "border-line-strong bg-surface")}>{on && <Icons.check size={10} />}</span>
                    {dayLabel(day, years)}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <button type="button" disabled={!picked.length || picked.length === dayCount} onClick={() => act(splitDays(fields, card.key, picked))}
              className="h-9 rounded-md bg-brand px-3 text-[13px] font-semibold text-white hover:bg-brand-hover disabled:opacity-50">
              Тусдаа үнэ оруулах{picked.length ? ` · ${picked.length} өдөр` : ""}
            </button>
            {own && (
              <select aria-label="Сонгосон өдрийг шилжүүлэх" disabled={!picked.length} value=""
                onChange={(event) => { if (event.target.value) act(moveDays(fields, card.key, picked, event.target.value)); }}
                className="h-9 w-full min-w-0 max-w-full rounded-md border border-line-strong bg-surface px-2.5 text-[13px] text-ink disabled:opacity-50 sm:w-auto sm:max-w-xs">
                <option value="">Өөр мөрөнд шилжүүлэх…</option>
                {targets.map((target) => (
                  <option key={target.key} value={target.key}>{target.kind === "all" ? "Бусад өдрийн үнэд" : cardShort(target, years)}</option>
                ))}
                {!targets.some((target) => target.kind === "all") && <option value={ALL_CARD}>Бусад өдрийн үнэд (шинээр)</option>}
              </select>
            )}
            <button type="button" onClick={() => setChooser(null)} className="h-9 rounded-md px-3 text-[13px] font-medium text-ink-muted hover:text-ink">Болих</button>
          </div>
        </div>
      )}

      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Field id={id("adult")} label="Том хүн" required missing={card.missing.adult} danger>
          <div data-focus="adult">
            <MoneyField id={id("adult")} ariaLabel={`Том хүний үнэ${where}`} placeholder="ж: 3,290,000" missing={card.missing.adult} danger
              value={card.adult !== null && card.adult > 0 ? String(card.adult) : card.adult === 0 ? "0" : ""} onChange={money("adult")} />
          </div>
        </Field>
        <Field id={id("child")} label="Хүүхэд" required missing={card.missing.child} danger>
          <div data-focus="child">
            <MoneyField id={id("child")} ariaLabel={`Хүүхдийн үнэ${where}`} placeholder="ж: 2,590,000" missing={card.missing.child} danger
              value={card.child !== null ? String(card.child) : ""} onChange={money("child")} />
          </div>
        </Field>
        {has("infant") && (
          <Field id={id("infant")} label="Нярай" className="col-span-2 sm:col-span-1">
            <div data-focus="infant">
              <MoneyField id={id("infant")} ariaLabel={`Нярайн үнэ${where}`} placeholder={free ? "Үнэгүй" : "заавал биш"} disabled={free}
                value={card.infant !== null && !free ? String(card.infant) : ""} onChange={money("infant")} />
            </div>
            <div className="mt-1.5">
              <Checkbox label="Үнэгүй" checked={free} onChange={(next) => onChange(setCardFare(fields, card.key, "infant", next ? 0 : null))} />
            </div>
          </Field>
        )}
      </div>

      {adultAbove && (
        <p className="mt-3 flex items-start gap-2 text-[13px] leading-5 text-warning"><Icons.alert size={14} className="mt-0.5 shrink-0" /> Хүүхдийн үнэ том хүнийхээс өндөр байна. Зөв эсэхийг шалгана уу.</p>
      )}
      {card.clash.length > 0 && (
        <p className="mt-3 flex items-start gap-2 text-[13px] leading-5 text-warning">
          <Icons.alert size={14} className="mt-0.5 shrink-0" />
          {card.clash.map((day) => dayLabel(day, years)).join(", ")} өдөр ижил буудал, багцтай хоёр үнэтэй байна. Буудал эсвэл багцаар нь ялгана уу, эсвэл нэг мөрийг болино уу.
        </p>
      )}

      {own && extras.length > 0 && (
        <div className="mt-4" data-focus="bands">
          <p className="text-[13px] leading-5 text-ink-muted"><b className="font-semibold text-ink">Өөр ангиллын үнэ</b> — өөр насны эсвэл өндрийн хүүхэд тус бүрийн нэг хүний үнэ.</p>
          {extras.map((band) => (
            <PassengerBandRow key={band.index} price={band.row as unknown as PassengerPrice}
              problem={(() => {
                const found = bandIssues.find((entry) => entry.index === band.index);
                return found ? BAND_PROBLEM_TEXT[found.kind] : inverted.includes(band.index) ? INVERTED_BAND_TEXT : undefined;
              })()}
              onChange={(next) => setBands(bandRows.map((row, index) => (index === band.index ? next as unknown as Row : row)))}
              onRemove={() => setBands(bandRows.filter((_, index) => index !== band.index))} />
          ))}
        </div>
      )}

      {own && (has("hotel") || has("package") || has("single") || has("label") || has("note")) && (
        <div className="mt-4 grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
          {has("hotel") && (
            <Field id={id("hotel")} label="Буудал" hint="Холбоос, зургийг доорх «Зочид буудал»-д нэмнэ.">
              <TextInput id={id("hotel")} value={card.hotel} placeholder="ж: Далайн эргийн 5* буудал" onChange={(event) => onChange(patchCard(fields, card.key, { hotel: event.target.value }))} />
            </Field>
          )}
          {has("package") && (
            <Field id={id("package")} label="Багц" hint="Ижил өдөр хэд хэдэн сонголт байвал, ж: Хөтөлбөртэй / Хөтөлбөргүй.">
              <TextInput id={id("package")} value={card.packageId} placeholder="ж: Хөтөлбөртэй" onChange={(event) => onChange(patchCard(fields, card.key, { package_id: event.target.value }))} />
            </Field>
          )}
          {has("single") && (
            <Field id={id("single")} label="Ганц өрөөний нэмэлт">
              <MoneyField id={id("single")} ariaLabel="Ганц өрөөний нэмэлт төлбөр" placeholder="заавал биш" value={card.single !== null ? String(card.single) : ""}
                onChange={(digits) => onChange(patchCard(fields, card.key, { single_price: digits === "" ? null : Number(digits) }))} />
            </Field>
          )}
          {has("label") && (
            <Field id={id("label")} label="Үнийн нэр">
              <TextInput id={id("label")} value={text(card.group.label)} placeholder="ж: Стандарт" onChange={(event) => onChange(patchCard(fields, card.key, { label: event.target.value }))} />
            </Field>
          )}
          {has("note") && (
            <Field id={id("note")} label="Тэмдэглэл" className="sm:col-span-2">
              <TextInput id={id("note")} value={text(card.group.note)} onChange={(event) => onChange(patchCard(fields, card.key, { note: event.target.value }))} />
            </Field>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-3">
        <AddChips chips={optionalChips} className="mt-1"
          onAdd={(key) => (key === "bands" ? onChange(addExtraBand(fields, card.key)) : reveal(key))} />
        {own && (
          <button type="button" className={cx(linkButton, "mt-1")} onClick={() => act(addOption(fields, card.key))}>
            <Icons.plus size={13} /> Ижил өдрүүдэд өөр буудал, багцтай сонголт
          </button>
        )}
      </div>
    </div>
  );
}
