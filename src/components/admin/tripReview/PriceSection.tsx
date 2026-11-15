/**
 * «Гарах өдөр ба үнэ» of the new-trip review as the trip page shows it: a compact table, one row
 * per price (tripReviewPrices.ts cards: days with the same price are one row), the days of the row
 * with their seat state («Дүүрсэн», «4 суудал»), the adult / child / extra band / infant fares, the
 * single-room extra and the hotel.
 *
 * A click on a fare (or the row's «Засах») opens the row's editor under it (PriceRowEditor.tsx):
 * a date split off to its own price, merged back, an extra age band, hotel, package, single, note.
 * A click on a day opens its seat state (tripDayStates.ts). Columns nobody has a value in are not
 * shown; they are «+ …» chips under the table.
 *
 * Until 2026-11-11 this was one card of 10+ boxes per price, most of them empty (the owner: "those
 * empty fields are too extra").
 */
import { useState, type CSSProperties, type ReactNode } from "react";
import { Icons, cx } from "@/components/ui";
import { addStraysToCalendar, cardSummary, dayLabel, dropStrays, formatMnt, priceModel, type PriceCard } from "@/lib/tripReviewPrices";
import { dayStates, setDayState, type DayState } from "@/lib/tripDayStates";
import { DayStateBadge, DayStatePanel } from "./DayStateControl";
import { dayStateSpoken } from "./dayStateView";
import { PriceRowEditor, type Chooser } from "./PriceRowEditor";
import { AddChips, primarySmall, secondarySmall } from "./ReviewParts";
import { bandLabel, childHeader, priceColumns, type Chip, type PriceColumn } from "./reviewView";

type Row = Record<string, unknown>;
type StateEdit = { key: string; day: string } | null;

/** The extra age bands as columns: one per name while there are two at most, else one «Бусад ангилал» column. */
function bandColumnsOf(cards: PriceCard[]): string[] | null {
  const names: string[] = [];
  for (const card of cards) {
    for (const band of card.bands) {
      if (band.role !== "other") continue;
      const name = bandLabel(band.row);
      if (!names.some((entry) => entry.toLowerCase() === name.toLowerCase())) names.push(name);
    }
  }
  return names.length <= 2 ? names : null;
}

const money = (value: number | null) => (value === null ? null : value === 0 ? "0₮" : formatMnt(value));

export function PriceSection({ fields, onChange, openCard, onOpenCard, showAll, extraChips, onExtraChip, below }: {
  fields: Row;
  onChange: (next: Row) => void;
  /** The row whose editor is open («all» or «g<n>»); held by the review so a problem link can open it. */
  openCard?: string | null;
  onOpenCard?: (key: string | null, field?: string) => void;
  /** «Бүх талбар»: every column and every box of a row's editor. */
  showAll?: boolean;
  /** More chips for this section's chip row (the review's age bands). */
  extraChips?: Chip[];
  onExtraChip?: (key: string) => void;
  /** Shown under the table, above the chips (the age bands line). */
  below?: ReactNode;
}) {
  const model = priceModel(fields);
  const [localOpen, setLocalOpen] = useState<string | null>(openCard ?? null);
  const [chooser, setChooser] = useState<Chooser | null>(null);
  const [stateEdit, setStateEdit] = useState<StateEdit>(null);
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set());
  const open = onOpenCard ? openCard ?? null : localOpen;
  const setOpen = (key: string | null, field?: string) => {
    setChooser(null);
    if (onOpenCard) onOpenCard(key, field);
    else setLocalOpen(key);
  };
  const states = dayStates(fields);
  const calendarDays = new Set(model.calendar);
  const strays = Array.from(new Set(model.cards.flatMap((card) => card.strays))).sort();
  const noDates = model.calendar.length === 0 && !model.hasOwn;
  const years = model.spansYears;
  const columns = priceColumns(model.cards, { all: showAll, revealed });
  const bandNames = columns.shown.includes("bands") ? bandColumnsOf(model.cards) : [];
  const shows = (column: PriceColumn) => columns.shown.includes(column);
  const childName = childHeader(model.cards);
  const template = [
    "minmax(10.5rem,1.45fr)", "minmax(6.5rem,1fr)", "minmax(6.5rem,1fr)",
    ...(shows("bands") ? (bandNames && bandNames.length ? bandNames.map(() => "minmax(6.5rem,1fr)") : ["minmax(8rem,1.2fr)"]) : []),
    ...(shows("infant") ? ["minmax(5.5rem,0.85fr)"] : []),
    ...(shows("single") ? ["minmax(5.5rem,0.85fr)"] : []),
    ...(shows("hotel") ? ["minmax(9rem,1.6fr)"] : []),
    "2.75rem",
  ].join(" ");
  const grid = { "--review-cols": template } as CSSProperties;
  // On a phone a row is its days, then the fares two by two, then the hotel; from sm up, one grid line.
  const rowCls = "relative flex flex-wrap items-start gap-x-4 gap-y-1 py-3 sm:grid sm:items-center sm:gap-x-3 sm:py-2.5 sm:[grid-template-columns:var(--review-cols)]";
  const chips: Chip[] = [...columns.chips, ...(extraChips ?? [])];

  return (
    <div data-price-section data-review-target="prices" className="scroll-mt-24">
      <div className="rounded-xl border border-line bg-surface px-3 sm:px-4">
        {/* The column names, for the eye; each cell also names itself (read aloud, and shown on a phone). */}
        <div aria-hidden="true" style={grid} className="hidden border-b border-line py-2.5 text-[12px] font-semibold uppercase tracking-wide text-ink-muted sm:grid sm:gap-x-3 sm:[grid-template-columns:var(--review-cols)]">
          <span>Огноо</span>
          <span className="px-2">Том хүн</span>
          <span className="px-2">{childName}</span>
          {shows("bands") && (bandNames && bandNames.length ? bandNames : ["Бусад ангилал"]).map((name) => <span key={name} className="truncate px-2" title={name}>{name}</span>)}
          {shows("infant") && <span className="px-2">Нярай</span>}
          {shows("single") && <span className="px-2">Ганц өрөө</span>}
          {shows("hotel") && <span className="px-2">Буудал, багц</span>}
          <span />
        </div>
        <ul aria-label="Гарах өдөр ба үнэ" className="divide-y divide-line">

        {model.cards.map((card) => {
          const editing = open === card.key;
          const dayCount = card.days.length + card.other.length;
          const stateDay = stateEdit?.key === card.key ? stateEdit.day : null;
          const extras = card.bands.filter((band) => band.role === "other");
          const label = [String(card.group.label ?? "").trim(), String(card.group.note ?? "").trim()].filter(Boolean).join(" · ");
          const fare = (kind: "adult" | "child" | "infant" | "single", head: string, value: number | null, missing = false) => (
            <FareCell kind={kind} label={head} value={value} missing={missing} onOpen={() => setOpen(card.key, kind)}
              free={kind === "infant" && value === 0} />
          );
          return (
            <li key={card.key} data-review-target={`card:${card.key}`} className="scroll-mt-24">
              <div data-price-row={card.key} aria-label={cardSummary(card, years)} role="group" style={grid}
                className={cx(rowCls, editing && "sm:bg-brand-soft/25")}>
                <div className="mb-1 w-full min-w-0 pr-11 sm:mb-0 sm:w-auto sm:pr-0">
                  {dayCount > 0 ? (
                    <ul className="flex flex-wrap gap-1.5" aria-label="Энэ үнэтэй өдрүүд">
                      {card.days.map((day) => (
                        <li key={day}>
                          <DayChip day={day} years={years} state={states[day]} open={stateDay === day}
                            mode={card.strays.includes(day) || !calendarDays.has(day) ? "stray" : card.clash.includes(day) ? "clash" : card.past.includes(day) ? "past" : "open"}
                            onClick={() => setStateEdit(stateDay === day ? null : { key: card.key, day })} />
                        </li>
                      ))}
                      {card.other.map((entry) => <li key={entry}><span className="inline-flex h-7 items-center rounded-full border border-line-strong bg-surface px-2.5 text-[13px] font-medium text-ink">{entry}</span></li>)}
                    </ul>
                  ) : (
                    <span className="text-[14px] font-medium text-ink">{card.everyDate || noDates ? "Бүх гарах өдөр" : "Үнэ"}</span>
                  )}
                  {(label || (!card.upcoming && dayCount > 0) || (model.hasOwn && card.kind === "all")) && (
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[13px] leading-5 text-ink-muted">
                      {model.hasOwn && card.kind === "all" && <span>Бусад өдөр</span>}
                      {!card.upcoming && dayCount > 0 && <span className="rounded bg-surface-sunken px-1.5 text-[12px] font-semibold">Өнгөрсөн</span>}
                      {label && <span className="min-w-0">{label}</span>}
                    </p>
                  )}
                </div>
                {fare("adult", "Том хүн", card.adult, card.missing.adult)}
                {fare("child", childName, card.child, card.missing.child)}
                {shows("bands") && (bandNames && bandNames.length ? bandNames.map((name) => {
                  const band = extras.find((entry) => bandLabel(entry.row).toLowerCase() === name.toLowerCase());
                  const price = band && typeof band.row.price === "number" ? band.row.price : null;
                  return <FareCell key={name} kind="bands" label={name} value={price} onOpen={() => setOpen(card.key, "bands")} />;
                }) : (
                  <div className="w-full min-w-0 sm:w-auto">
                    <button type="button" data-cell="bands" onClick={() => setOpen(card.key, "bands")} className="w-full rounded-md px-2 py-1 text-left text-[13px] leading-5 text-ink hover:bg-brand-soft/60">
                      {extras.length ? extras.map((band) => <span key={band.index} className="block"><span className="text-ink-muted">{bandLabel(band.row)}</span> {money(typeof band.row.price === "number" ? band.row.price : null) ?? "—"}</span>) : <span className="text-ink-subtle">—</span>}
                    </button>
                  </div>
                ))}
                {shows("infant") && fare("infant", "Нярай", card.infant)}
                {shows("single") && fare("single", "Ганц өрөө", card.single)}
                {shows("hotel") && (
                  <div className="w-full min-w-0 sm:w-auto">
                    <button type="button" data-cell="hotel" onClick={() => setOpen(card.key, "hotel")} disabled={card.kind === "all"}
                      className="w-full rounded-md py-1 text-left text-[13px] leading-5 text-ink enabled:hover:bg-brand-soft/60 sm:px-2">
                      <span className="text-ink-muted sm:sr-only">Буудал: </span>
                      {[card.hotel, card.packageId].filter(Boolean).join(" · ") || <span className="text-ink-subtle">—</span>}
                    </button>
                  </div>
                )}
                <div className="absolute right-0 top-2.5 sm:static sm:flex sm:justify-end">
                  <button type="button" aria-expanded={editing} aria-label={editing ? "Үнэ засахыг хаах" : `Үнэ засах: ${cardSummary(card, years)}`}
                    title={editing ? "Хаах" : "Засах"} onClick={() => setOpen(editing ? null : card.key)}
                    className={cx("flex h-9 w-9 items-center justify-center rounded-md transition-colors", editing ? "bg-brand text-white" : "text-ink-muted hover:bg-brand-soft hover:text-brand")}>
                    {editing ? <Icons.close size={15} /> : <Icons.edit size={15} />}
                  </button>
                </div>
              </div>
              {stateDay && card.days.includes(stateDay) && (
                <div className="pb-3 sm:px-2">
                  <DayStatePanel dayLabel={dayLabel(stateDay, years)} state={states[stateDay]}
                    onChange={(next) => onChange(setDayState(fields, stateDay, next))} onClose={() => setStateEdit(null)} />
                </div>
              )}
              {editing && (
                <PriceRowEditor card={card} cards={model.cards} years={years} hasAll={model.showsAll} columns={columns.shown} showAll={showAll}
                  fields={fields} onChange={onChange} onClose={() => setOpen(null)}
                  chooser={chooser?.key === card.key ? chooser : null} setChooser={setChooser} />
              )}
            </li>
          );
        })}
        </ul>
      </div>

      {noDates && (
        <p className="mt-3 text-[13px] leading-5 text-ink-muted">Гарах өдөр сонгоогүй байна. «Огноо засах» дарж календариас сонговол өдөр бүр энд гарна. Одоохондоо бүх өдөрт нэг үнийг оруулж болно.</p>
      )}

      {strays.length > 0 && (
        <div className="mt-3 rounded-lg border border-warning/30 bg-warning-soft/60 px-4 py-3 text-sm leading-6 text-ink">
          <p className="flex items-start gap-2"><Icons.alert size={14} className="mt-1 shrink-0 text-warning" />
            <span>Календарьт сонгоогүй өдрийн үнэ байна: <b>{strays.map((day) => dayLabel(day, years)).join(", ")}</b>.</span>
          </p>
          <span className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={() => onChange(addStraysToCalendar(fields))} className={primarySmall}>Календарьт нэмэх</button>
            <button type="button" onClick={() => onChange(dropStrays(fields))} className={secondarySmall}>Үнийг нь хасах</button>
          </span>
        </div>
      )}

      <p className="mt-3 text-[13px] leading-5 text-ink-muted">
        Нэг хүний үнэ, төгрөгөөр. Үнэ дээр дарж засна, огноо дээр дарж суудлын төлөвийг солино.
        {model.headline !== null && model.cards.length > 0 && <> Сайтын картанд <b className="font-semibold text-ink">«эхлэх үнэ» {formatMnt(model.headline)}</b>.</>}
      </p>
      {below}
      <AddChips chips={chips} onAdd={(key) => {
        if (columns.chips.some((chip) => chip.key === key)) setRevealed((current) => new Set([...current, `column:${key}`]));
        else onExtraChip?.(key);
      }} />
    </div>
  );
}

/** One fare of a row: the amount, red «Оруулаагүй» when a fare needed to publish is empty; a click opens the row on it. */
function FareCell({ kind, label, value, missing, free, onOpen }: {
  kind: string; label: string; value: number | null; missing?: boolean; free?: boolean; onOpen: () => void;
}) {
  return (
    <div className="min-w-0 basis-[calc(50%-0.5rem)] sm:basis-auto">
      <button type="button" data-cell={kind} onClick={onOpen} aria-label={`${label}: ${missing ? "оруулаагүй" : free ? "үнэгүй" : value !== null ? formatMnt(value) : "хоосон"}. Засах`}
        className={cx("flex w-full flex-col items-start rounded-md py-1 text-left transition-colors sm:flex-row sm:items-baseline sm:gap-1.5 sm:px-2",
          missing ? "text-danger hover:bg-danger-soft" : "hover:bg-brand-soft/60")}>
        <span className="max-w-full truncate text-[12px] leading-5 text-ink-muted sm:sr-only">{label}</span>
        {missing ? (
          <span className="rounded bg-danger-soft px-1.5 text-[13px] font-semibold text-danger">Оруулаагүй</span>
        ) : free ? (
          <span className="text-[15px] font-semibold text-success">Үнэгүй</span>
        ) : value !== null ? (
          <span className="text-[15px] font-semibold tabular-nums text-ink">{formatMnt(value)}</span>
        ) : (
          <span className="text-[15px] text-ink-subtle">—</span>
        )}
      </button>
    </div>
  );
}

/** A day of a row with its seat state; a click opens the state. A day off the calendar or listed twice cannot be. */
function DayChip({ day, years, state, open, mode, onClick }: {
  day: string; years: boolean; state: DayState | undefined; open: boolean; mode: "open" | "stray" | "clash" | "past"; onClick: () => void;
}) {
  const base = "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[13px] font-medium tabular-nums";
  if (mode === "stray") {
    return <span className={cx(base, "border-dashed border-warning bg-warning-soft text-warning")} title="Календарьт сонгоогүй өдөр">{dayLabel(day, years)}</span>;
  }
  return (
    <button type="button" aria-expanded={open} onClick={onClick}
      title={mode === "clash" ? "Ижил буудал, багцтай хоёр үнэтэй" : mode === "past" ? "Өнгөрсөн өдөр" : "Суудлын төлөв солих"}
      aria-label={`${dayLabel(day, years)}${dayStateSpoken(state)}. Суудлын төлөв солих`}
      className={cx(base, "transition-colors hover:border-brand",
        open ? "border-brand bg-brand-soft text-brand" : mode === "clash" ? "border-dashed border-warning bg-warning-soft text-warning"
          : state?.state === "full" ? "border-danger/35 bg-danger-soft text-danger"
            : mode === "past" ? "border-line bg-surface-sunken text-ink-muted" : "border-line-strong bg-surface text-ink")}>
      {dayLabel(day, years)}
      <DayStateBadge state={state} className="-mr-1" />
    </button>
  );
}
