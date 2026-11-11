/**
 * The price part of the new-trip review, under the departure calendar. One list of cards: the
 * trip's price for every day without a price of its own, then one card per other price with the
 * days it covers (tripReviewPrices.ts). Days with the same price are written once.
 *
 * The adult and child fare are red while empty (the owner's rule: a trip is published with
 * them; the infant fare is optional and a draft needs none).
 *
 * A day chip shows the day's seat state («Дүүрсэн», «4 суудал») and opens it (tripDayStates.ts).
 */
import { useId, useState, type ReactNode } from "react";
import { Icons, cx } from "@/components/ui";
import type { PassengerPrice } from "@/lib/adminTypes";
import {
  ALL_CARD, BAND_PROBLEM_TEXT, addExtraBand, addOption, addStraysToCalendar, bandProblems, cardShort, cardSummary, dayLabel, dropCard, dropStrays,
  formatMnt, moveDays, patchCard, priceModel, priceProblems, setCardBands, setCardFare, splitDays, type FareKind, type PriceCard,
} from "@/lib/tripReviewPrices";
import { dayStates, setDayState, type DayState } from "@/lib/tripDayStates";
import { PassengerBandRow } from "../tripEditor/PricingEditor";
import { Checkbox, Field, MoneyField, TextInput } from "../tripEditor/parts";
import { DayStateBadge, DayStatePanel } from "./DayStateControl";
import { dayStateSpoken } from "./dayStateView";

type Row = Record<string, unknown>;
type Chooser = { key: string; picked: string[] };
/** The day whose seat state is open for editing, on one card. */
type StateEdit = { key: string; day: string } | null;

const pill = "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium tabular-nums";

const linkButton = "inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-brand hover:bg-brand-soft disabled:opacity-50";

function Tag({ tone, children }: { tone: "danger" | "muted"; children: ReactNode }) {
  return (
    <span className={cx("rounded-md px-2 py-0.5 text-[12px] font-semibold", tone === "danger" ? "bg-danger-soft text-danger" : "bg-surface-sunken text-ink-muted")}>{children}</span>
  );
}

/** Next to the days: what the card is. With a «Бусад өдөр» card the others are the days with an own price. */
function cardTitle(card: PriceCard, hasOwn: boolean, hasAll: boolean): string {
  if (card.kind === "all") return hasOwn ? "Бусад өдөр" : card.days.length || card.other.length ? "Бүх гарах өдөр" : "Үнэ";
  const name = [card.hotel, card.packageId].filter(Boolean).join(" · ");
  return name || (card.everyDate ? "Бүх гарах өдөр" : hasAll ? "Тусдаа үнэ" : "Үнэ");
}

export function PriceSection({ fields, onChange }: { fields: Row; onChange: (next: Row) => void }) {
  const uid = useId();
  const model = priceModel(fields);
  const [chooser, setChooser] = useState<Chooser | null>(null);
  const [stateEdit, setStateEdit] = useState<StateEdit>(null);
  const states = dayStates(fields);
  const calendarDays = new Set(model.calendar);
  const strays = Array.from(new Set(model.cards.flatMap((card) => card.strays))).sort();
  const act = (next: Row) => { setChooser(null); onChange(next); };
  const noDates = model.calendar.length === 0 && !model.hasOwn;
  // What the save would refuse about these fares, said here beside them (the footer says it once more).
  const problems = priceProblems(fields);

  return (
    <div className="mt-8 border-t border-line pt-6" data-price-section>
      <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h4 className="text-base font-semibold text-ink">Үнэ</h4>
        <p className="text-[13px] leading-5 text-ink-muted">Нэг хүний, төгрөгөөр. Юань, ландын өртгийг биш, зарах үнийг бичнэ.</p>
      </div>

      <div className="space-y-4">
        {model.cards.map((card) => (
          <PriceCardView key={card.key} card={card} uid={uid} hasOwn={model.hasOwn} hasAll={model.showsAll} years={model.spansYears} cards={model.cards}
            chooser={chooser?.key === card.key ? chooser : null} setChooser={setChooser}
            states={states} calendarDays={calendarDays} stateDay={stateEdit?.key === card.key ? stateEdit.day : null}
            setStateDay={(day) => setStateEdit(day ? { key: card.key, day } : null)}
            fields={fields} act={act} onChange={onChange} />
        ))}
      </div>

      {noDates && (
        <p className="mt-3 text-[13px] leading-5 text-ink-muted">Гарах өдөр сонгоогүй байна. Дээрх календариас сонговол өдөр бүрийн үнэ энд гарна. Одоохондоо бүх өдөрт нэг үнийг оруулж болно.</p>
      )}

      {strays.length > 0 && (
        <div className="mt-3 rounded-lg border border-warning/30 bg-warning-soft/60 px-4 py-3 text-sm leading-6 text-ink">
          <p className="flex items-start gap-2"><Icons.alert size={14} className="mt-0.5 shrink-0 text-warning" />
            Календарьт сонгоогүй өдрийн үнэ байна: <b>{strays.map((day) => dayLabel(day, model.spansYears)).join(", ")}</b>.
          </p>
          <span className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={() => act(addStraysToCalendar(fields))} className="rounded-md bg-brand px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-brand-hover">Календарьт нэмэх</button>
            <button type="button" onClick={() => act(dropStrays(fields))} className="rounded-md border border-line-strong bg-surface px-3 py-1.5 text-[13px] font-medium text-ink hover:border-brand">Үнийг нь хасах</button>
          </span>
        </div>
      )}

      {model.headline !== null && model.cards.length > 0 && (
        <p className="mt-4 text-[13px] leading-5 text-ink-muted">
          Сайтын аяллын картанд <b className="text-ink">«эхлэх үнэ» {formatMnt(model.headline)}</b> гэж гарна (хамгийн бага том хүний үнэ).
        </p>
      )}

      {problems.map((problem) => (
        <p key={problem} className="mt-3 flex items-start gap-2 text-[13px] font-medium leading-5 text-danger" role="status">
          <Icons.alert size={14} className="mt-0.5 shrink-0" /> <span>{problem} Засаагүй бол ноорог ч хадгалагдахгүй.</span>
        </p>
      ))}

      {model.missingCards > 0 ? (
        <p className="mt-3 flex items-start gap-2 text-[13px] leading-5 text-danger" role="status">
          <Icons.alert size={14} className="mt-0.5 shrink-0" />
          <span><b>Том хүн, хүүхдийн үнэ заавал.</b> Нийтлэхийн өмнө улаанаар тэмдэглэсэн үнийг бөглөнө. Үнэгүйгээр ноорог хадгалж болно. Нярайн үнэ заавал биш.</span>
        </p>
      ) : (
        <p className="mt-3 text-[13px] leading-5 text-ink-muted">Нярайн үнэ заавал биш. Үнэгүй бол «Үнэгүй» гэж тэмдэглэнэ.</p>
      )}
    </div>
  );
}

function PriceCardView({ card, uid, hasOwn, hasAll, years, cards, chooser, setChooser, states, calendarDays, stateDay, setStateDay, fields, act, onChange }: {
  card: PriceCard; uid: string; hasOwn: boolean; hasAll: boolean; years: boolean; cards: PriceCard[]; chooser: Chooser | null;
  setChooser: (next: Chooser | null) => void; states: Record<string, DayState>; calendarDays: Set<string>;
  stateDay: string | null; setStateDay: (day: string | null) => void;
  fields: Row; act: (next: Row) => void; onChange: (next: Row) => void;
}) {
  const id = (name: string) => `${uid}-${card.key}-${name}`;
  const own = card.kind === "own";
  const money = (kind: FareKind) => (digits: string) => onChange(setCardFare(fields, card.key, kind, digits === "" ? null : Number(digits)));
  const free = card.infant === 0;
  const dayCount = card.days.length + card.other.length;
  const canChoose = dayCount >= 2;
  const unpriced = !own && dayCount > 0 && card.adult === null && card.child === null && card.infant === null;
  const extras = card.bands.filter((band) => band.role === "other");
  const bandIssues = bandProblems(card);
  const targets = cards.filter((other) => other.key !== card.key);
  const choosing = chooser !== null;
  const picked = chooser?.picked ?? [];
  const toggle = (day: string) => setChooser({ key: card.key, picked: picked.includes(day) ? picked.filter((entry) => entry !== day) : [...picked, day] });
  const setBands = (rows: Row[]) => onChange(setCardBands(fields, card.key, rows));
  const bandRows = card.bands.map((band) => band.row);
  const details = own && (card.hotel || card.packageId || card.single !== null || text(card.group.label) || text(card.group.note));
  // Which card a price box belongs to, for a screen reader: the first day and how many more.
  const where = own && card.days.length ? ` · ${dayLabel(card.days[0], years)}${dayCount > 1 ? ` +${dayCount - 1}` : ""}` : "";
  const adultAbove = card.adult !== null && card.child !== null && card.child > card.adult;
  const chipId = (day: string) => id(`day-${day}`);
  const closeState = () => {
    const day = stateDay;
    setStateDay(null);
    if (day) window.setTimeout(() => document.getElementById(chipId(day))?.focus(), 0);
  };

  return (
    <section aria-label={cardSummary(card, years)} className="rounded-xl bg-canvas p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-60">
          <div className="flex flex-wrap items-center gap-2">
            <h5 className="text-[15px] font-semibold text-ink">{cardTitle(card, hasOwn, hasAll)}{dayCount > 1 ? <span className="font-normal text-ink-muted"> · {dayCount} өдөр</span> : null}</h5>
            {unpriced && <Tag tone="danger">Үнэ оруулаагүй</Tag>}
            {!card.upcoming && dayCount > 0 && <Tag tone="muted">Өнгөрсөн</Tag>}
          </div>
          {dayCount > 0 && (
            <ul className="mt-2.5 flex flex-wrap gap-2" aria-label="Энэ үнэтэй өдрүүд">
              {card.days.map((day) => {
                const on = picked.includes(day);
                const stray = card.strays.includes(day);
                const clash = card.clash.includes(day);
                const gone = card.past.includes(day);
                const state = states[day];
                const editing = stateDay === day;
                const cls = cx(pill, on || editing ? "border-brand bg-brand-soft text-brand" : stray || clash ? "border-dashed border-warning bg-warning-soft text-warning" : gone ? "border-warning/40 bg-warning-soft text-warning"
                  : state?.state === "full" ? "border-danger/35 bg-danger-soft text-danger" : "border-line-strong bg-surface text-ink");
                const why = stray ? "Календарьт сонгоогүй өдөр" : clash ? "Ижил буудал, багцтай хоёр үнэтэй" : gone ? "Өнгөрсөн өдөр" : undefined;
                return (
                  <li key={day}>
                    {choosing ? (
                      <button type="button" aria-pressed={on} onClick={() => toggle(day)} className={cx(cls, "hover:border-brand")}>
                        <span className={cx("flex h-3.5 w-3.5 items-center justify-center rounded-sm border", on ? "border-brand bg-brand text-white" : "border-line-strong bg-surface")}>{on && <Icons.check size={10} />}</span>
                        {dayLabel(day, years)}
                      </button>
                    ) : calendarDays.has(day) && !stray ? (
                      <button type="button" id={chipId(day)} aria-expanded={editing} onClick={() => setStateDay(editing ? null : day)}
                        aria-label={`${dayLabel(day, years)}${dayStateSpoken(state)}. Суудлын төлөв солих`} title={why || "Суудлын төлөв солих"}
                        className={cx(cls, "hover:border-brand")}>
                        {dayLabel(day, years)}
                        <DayStateBadge state={state} />
                      </button>
                    ) : (
                      <span className={cls} title={why}>{dayLabel(day, years)}</span>
                    )}
                  </li>
                );
              })}
              {card.other.map((entry) => <li key={entry}><span className={cx(pill, "border-line-strong bg-surface text-ink")}>{entry}</span></li>)}
            </ul>
          )}
          {stateDay && card.days.includes(stateDay) && !choosing && (
            <DayStatePanel dayLabel={dayLabel(stateDay, years)} state={states[stateDay]}
              onChange={(next) => onChange(setDayState(fields, stateDay, next))} onClose={closeState} />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {canChoose && !choosing && (
            <button type="button" className={linkButton} onClick={() => { setStateDay(null); setChooser({ key: card.key, picked: [] }); }}>
              {own ? "Өдөр салгах эсвэл шилжүүлэх…" : "Энэ огнооны үнэ өөр бол…"}
            </button>
          )}
          {own && (
            <button type="button" className={cx(linkButton, "text-ink-muted hover:text-danger")} onClick={() => act(dropCard(fields, card.key))}
              title={hasAll ? "Эдгээр өдөр дахин «Бусад өдөр»-ийн үнэтэй болно" : "Эдгээр өдөр үнэгүй болно, дараа нь үнийг нь оруулна"}>
              <Icons.trash size={13} /> {hasAll ? "Тусдаа үнийг болих" : "Энэ үнийг арилгах"}
            </button>
          )}
        </div>
      </div>

      {choosing && (
        <div className="mt-3 rounded-lg border border-brand-border bg-surface p-3">
          <p className="text-sm leading-6 text-ink">
            {own ? "Салгах эсвэл шилжүүлэх өдрүүдээ дарж сонгоно уу." : "Үнэ нь өөр өдрүүдээ дарж сонгоно уу. Тэд тусдаа үнэтэй карт болно."}
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <button type="button" disabled={!picked.length || picked.length === dayCount} onClick={() => act(splitDays(fields, card.key, picked))}
              className="h-9 rounded-md bg-brand px-3 text-[13px] font-semibold text-white hover:bg-brand-hover disabled:opacity-50">
              Тусдаа үнэ оруулах{picked.length ? ` · ${picked.length} өдөр` : ""}
            </button>
            {own && (
              <select aria-label="Сонгосон өдрийг шилжүүлэх" disabled={!picked.length} value=""
                onChange={(event) => { if (event.target.value) act(moveDays(fields, card.key, picked, event.target.value)); }}
                className="h-9 w-full min-w-0 max-w-full rounded-md border border-line-strong bg-surface px-2.5 text-[13px] text-ink disabled:opacity-50 sm:w-auto sm:max-w-xs">
                <option value="">Өөр картад шилжүүлэх…</option>
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
          <MoneyField id={id("adult")} ariaLabel={`Том хүний үнэ${where}`} placeholder="ж: 3,290,000" missing={card.missing.adult} danger
            value={card.adult !== null && card.adult > 0 ? String(card.adult) : card.adult === 0 ? "0" : ""} onChange={money("adult")} />
        </Field>
        <Field id={id("child")} label="Хүүхэд" required missing={card.missing.child} danger>
          <MoneyField id={id("child")} ariaLabel={`Хүүхдийн үнэ${where}`} placeholder="ж: 2,590,000" missing={card.missing.child} danger
            value={card.child !== null ? String(card.child) : ""} onChange={money("child")} />
        </Field>
        <Field id={id("infant")} label="Нярай" className="col-span-2 sm:col-span-1">
          <MoneyField id={id("infant")} ariaLabel={`Нярайн үнэ${where}`} placeholder={free ? "Үнэгүй" : "заавал биш"} disabled={free}
            value={card.infant !== null && !free ? String(card.infant) : ""} onChange={money("infant")} />
          <div className="mt-1.5">
            <Checkbox label="Үнэгүй" checked={free} onChange={(next) => onChange(setCardFare(fields, card.key, "infant", next ? 0 : null))} />
          </div>
        </Field>
      </div>

      {adultAbove && (
        <p className="mt-3 flex items-start gap-2 text-[13px] leading-5 text-warning"><Icons.alert size={14} className="mt-0.5 shrink-0" /> Хүүхдийн үнэ том хүнийхээс өндөр байна. Зөв эсэхийг шалгана уу.</p>
      )}
      {card.clash.length > 0 && (
        <p className="mt-3 flex items-start gap-2 text-[13px] leading-5 text-warning">
          <Icons.alert size={14} className="mt-0.5 shrink-0" />
          {card.clash.map((day) => dayLabel(day, years)).join(", ")} өдөр ижил буудал, багцтай хоёр үнэтэй байна. Буудал эсвэл багцаар нь ялгана уу, эсвэл нэг картыг болино уу.
        </p>
      )}

      {own && (
        <div className={extras.length ? "mt-4" : "mt-4 border-t border-line-strong/60 pt-3"}>
          {extras.length > 0 && (
            <p className="mt-1 text-[13px] leading-5 text-ink-muted"><b className="font-semibold text-ink">Өөр ангиллын үнэ</b> — өөр насны эсвэл өндрийн хүүхэд тус бүрийн нэг хүний үнэ.</p>
          )}
          {extras.map((band) => (
            <PassengerBandRow key={band.index} price={band.row as unknown as PassengerPrice}
              problem={(() => { const found = bandIssues.find((entry) => entry.index === band.index); return found ? BAND_PROBLEM_TEXT[found.kind] : undefined; })()}
              onChange={(next) => setBands(bandRows.map((row, index) => (index === band.index ? next as unknown as Row : row)))}
              onRemove={() => setBands(bandRows.filter((_, index) => index !== band.index))} />
          ))}
          <button type="button" className={linkButton} onClick={() => onChange(addExtraBand(fields, card.key))}>
            <Icons.plus size={13} /> Өөр насны ангилал нэмэх <span className="hidden font-normal text-ink-muted sm:inline">(ж: ор эзлэхгүй хүүхэд)</span>
          </button>
        </div>
      )}

      {own && (
        <details key={card.key} className="mt-3 border-t border-line-strong/60 pt-3" open={Boolean(details)}>
          <summary className="cursor-pointer text-sm font-medium text-ink hover:text-brand">Буудал, багц, ганц өрөө, тэмдэглэл</summary>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <Field label="Буудал" hint="Холбоос, зургийг доорх «Зочид буудлууд»-д нэмнэ.">
              <TextInput value={card.hotel} placeholder="ж: Далайн эргийн 5* буудал" onChange={(event) => onChange(patchCard(fields, card.key, { hotel: event.target.value }))} />
            </Field>
            <Field label="Багц" hint="Ижил өдөр хэд хэдэн сонголт байвал, ж: Хөтөлбөртэй / Хөтөлбөргүй.">
              <TextInput value={card.packageId} placeholder="ж: Хөтөлбөртэй" onChange={(event) => onChange(patchCard(fields, card.key, { package_id: event.target.value }))} />
            </Field>
            <Field label="Ганц өрөөний нэмэлт">
              <MoneyField ariaLabel="Ганц өрөөний нэмэлт төлбөр" placeholder="заавал биш" value={card.single !== null ? String(card.single) : ""}
                onChange={(digits) => onChange(patchCard(fields, card.key, { single_price: digits === "" ? null : Number(digits) }))} />
            </Field>
            <Field label="Үнийн нэр">
              <TextInput value={text(card.group.label)} placeholder="ж: Стандарт" onChange={(event) => onChange(patchCard(fields, card.key, { label: event.target.value }))} />
            </Field>
            <Field label="Тэмдэглэл" className="sm:col-span-2">
              <TextInput value={text(card.group.note)} onChange={(event) => onChange(patchCard(fields, card.key, { note: event.target.value }))} />
            </Field>
          </div>
          <button type="button" className={cx(linkButton, "mt-3")} onClick={() => act(addOption(fields, card.key))}>
            <Icons.plus size={13} /> Ижил өдрүүдэд өөр буудал, багцтай сонголт нэмэх
          </button>
        </details>
      )}
    </section>
  );
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
