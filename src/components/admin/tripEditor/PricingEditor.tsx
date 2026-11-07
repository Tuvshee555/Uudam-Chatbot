/**
 * Prices and departures. The data model is unchanged: a flat adult/child/infant
 * price with a departure list, or one price group per departure (date, adult
 * fare, passenger bands, hotel, note). Only the presentation moved here.
 */
import React from "react";
import { Button, DatePicker, Icons, cx } from "@/components/ui";
import { displayDate } from "../TripEditorParts";
import { passengerName, passengerPricingRows, patchPricingDate, pricingDateRows, pricingDates, type PricingGroup } from "@/lib/adminDatePricing";
import type { PassengerPrice, PriceGroup } from "@/lib/adminTypes";
import { Checkbox, Field, MoneyField, RemoveButton, SelectInput, TextInput, controlCls, borderFor } from "./parts";

export function emptyPassengerPrice(label = ""): PassengerPrice {
  return { label, age_range: "", price: null, currency: "MNT" };
}
export function emptyPriceGroup(): PriceGroup {
  return { label: "", dates: [], display_dates: [], date_keys: [], adult_price: null, adult_price_range: null, child_price: null, infant_price: null, child_age: "", infant_age: "", passenger_prices: [], note: "" };
}

export function splitDepartureDraft(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}
export function joinDepartureDraft(values: string[]): string {
  return values.join(", ");
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
export function parseAgeRange(input: string | null | undefined): { min: string; max: string; unit: "сар" | "нас" } {
  // A band read from a file can have no age range at all (a height band, "оргүй"): never crash on it.
  const value = typeof input === "string" ? input : "";
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

/** A date chip list with a picker to add one. Used for the trip's departures and a price group's dates. */
export function DateChips({
  dates,
  onChange,
  addLabel = "Огноо нэмэх",
  missing,
  emptyText = "Огноо нэмээгүй байна.",
  anchor,
}: {
  dates: string[];
  onChange: (dates: string[]) => void;
  addLabel?: string;
  missing?: boolean;
  emptyText?: string;
  anchor?: string;
}) {
  const add = (formatted: string) => { if (formatted && !dates.includes(formatted)) onChange([...dates, formatted]); };
  return (
    <div data-trip-field={anchor}>
      <div className={cx("flex min-h-12 flex-wrap items-center gap-1.5 rounded-md border p-1.5", borderFor(missing))}>
        {dates.length === 0 && <span className="px-2 text-sm text-ink-subtle">{emptyText}</span>}
        {dates.map((date, index) => (
          <span key={`${date}-${index}`} className="inline-flex h-8 items-center gap-1 rounded-md bg-surface-sunken pl-2.5 pr-1 text-sm font-medium text-ink">
            {displayDate(date)}
            <button type="button" onClick={() => onChange(dates.filter((_, i) => i !== index))} className="flex h-6 w-6 items-center justify-center rounded text-ink-subtle hover:bg-danger-soft hover:text-danger" title="Огноо устгах" aria-label={`${date} устгах`}>
              <Icons.close size={12} />
            </button>
          </span>
        ))}
        <span className="ml-auto">
          <DatePicker onSelect={(formatted) => add(formatted)} placeholder={addLabel} className="w-44" />
        </span>
      </div>
    </div>
  );
}

function AgeRangePicker({ value, onChange, missing }: { value: string; onChange: (value: string) => void; missing?: boolean }) {
  const { min, max, unit } = parseAgeRange(value);
  const setPart = (next: Partial<{ min: string; max: string; unit: "сар" | "нас" }>) => {
    const merged = { min, max, unit, ...next };
    onChange(formatAgeRange(merged.min, merged.max, merged.unit));
  };
  const small = cx(controlCls, borderFor(missing, true), "h-10 w-full min-w-0 px-2 text-center");
  return (
    <div className="grid grid-cols-[1fr_auto_1fr_4.5rem] items-center gap-1.5">
      <input className={small} aria-label="Насны доод хязгаар" inputMode="numeric" value={min} placeholder="0" onChange={(e) => setPart({ min: e.target.value.replace(/[^\d]/g, "") })} />
      <span className="text-ink-subtle">–</span>
      <input className={small} aria-label="Насны дээд хязгаар" inputMode="numeric" value={max} placeholder="23" onChange={(e) => setPart({ max: e.target.value.replace(/[^\d]/g, "") })} />
      <SelectInput aria-label="Насны нэгж" value={unit} onChange={(e) => setPart({ unit: e.target.value as "сар" | "нас" })}>
        <option value="сар">сар</option>
        <option value="нас">нас</option>
      </SelectInput>
    </div>
  );
}

/** One extra passenger band (an age or height tier): name, age range, one-person price, free. Also used by the new-trip review. */
export function PassengerBandRow({ price, onChange, onRemove, problem }: {
  price: PassengerPrice; onChange: (next: PassengerPrice) => void; onRemove: () => void;
  /** Why this band cannot be saved as it is (the review): shown in red under the row, the age range turns red. */
  problem?: string;
}) {
  const free = isFreeFare(price);
  return (
    <div className="grid min-w-0 gap-3 border-t border-line py-4 sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1.3fr)_minmax(0,1fr)_2rem] sm:items-end">
      <Field label="Зорчигчийн нэр">
        <TextInput aria-label="Зорчигчийн ангилал" value={passengerName(price as PassengerPrice & PricingGroup)} placeholder="ж: Хүүхэд, Нярай" onChange={(e) => onChange({ ...price, label: e.target.value })} />
      </Field>
      <Field label="Насны хүрээ" required={Boolean(problem)} missing={Boolean(problem)} danger>
        <AgeRangePicker missing={Boolean(problem)} value={price.age_range} onChange={(age_range) => onChange({ ...price, label: passengerName(price as PassengerPrice & PricingGroup), age_range })} />
      </Field>
      <Field label="Нэг хүний үнэ">
        <MoneyField
          ariaLabel={`${price.label || "Зорчигч"} үнэ`}
          currency={price.currency}
          disabled={free}
          value={free ? "" : price.price == null ? "" : String(price.price)}
          placeholder={free ? "Үнэгүй" : ""}
          onChange={(digits) => onChange({ ...price, price: digits === "" ? null : Number(digits), note: free ? "" : price.note })}
        />
        <div className="mt-1.5">
          <Checkbox label="Үнэгүй" checked={free} onChange={(next) => onChange(next ? { ...price, price: 0, note: FREE_FARE_NOTE } : { ...price, price: null, note: "" })} />
        </div>
      </Field>
      <RemoveButton label="Насны ангилал хасах" onClick={onRemove} className="justify-self-end sm:mb-7" />
      {problem && (
        <p className="flex items-start gap-2 text-xs leading-5 text-danger sm:col-span-full" role="status">
          <Icons.alert size={13} className="mt-0.5 shrink-0" /> {problem}
        </p>
      )}
    </div>
  );
}

/** Departure list on the left, the chosen departure's fares on the right. */
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
  const addDeparture = () => {
    onChange((current) => [...current, emptyPriceGroup()]);
    setSelection(`|${groups.length}`);
    setSearch("");
  };
  const rowTitle = (row: typeof rows[number]) => row.date ? displayDate(row.date) : "Огноогүй гаралт";
  // Hotel and package side by side ("Буудал · Багц"); a hotel string that already carries the package is shown once.
  const rowMeta = (row: typeof rows[number]) => {
    const item = records[row.groupIndex];
    const hotel = String(item.hotel || "").trim();
    const pack = String(item.package_id || "").trim();
    const both = pack && !hotel.includes(pack) ? [hotel, pack].filter(Boolean).join(" · ") : hotel || pack;
    return both || String(item.note || item.label || "");
  };

  return (
    <div className="grid min-w-0 gap-6 md:grid-cols-[16rem_minmax(0,1fr)]">
      <div className="min-w-0">
        <div className="md:hidden">
          <Field label="Гарах огноо">
            <SelectInput aria-label="Гарах огноо сонгох" value={selected ? key(selected) : ""} onChange={(e) => setSelection(e.target.value)}>
              {rows.map((row) => <option key={key(row)} value={key(row)}>{rowTitle(row)} · {records[row.groupIndex].adult_price?.toLocaleString("en-US") || "—"}₮</option>)}
            </SelectInput>
          </Field>
        </div>
        <div className="hidden md:block">
          {rows.length > 6 && (
            <TextInput aria-label="Огноо хайх" placeholder="Огноо хайх…" value={search} onChange={(e) => setSearch(e.target.value)} className="mb-2 h-9" />
          )}
          <ul className="max-h-[26rem] divide-y divide-line overflow-y-auto rounded-md border border-line" role="list" aria-label="Гарах огноонууд">
            {visible.map((row) => {
              const item = records[row.groupIndex];
              const active = !!selected && key(row) === key(selected);
              return (
                <li key={key(row)}>
                  <button type="button" aria-pressed={active} onClick={() => setSelection(key(row))}
                    className={cx("flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm transition-colors", active ? "bg-brand-soft/70 text-ink" : "hover:bg-surface-sunken")}>
                    <span className="min-w-0">
                      <span className={cx("block font-medium", active && "text-brand")}>{rowTitle(row)}</span>
                      {rowMeta(row) && <span className="block truncate text-xs text-ink-muted">{rowMeta(row)}</span>}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-ink-muted">{item.adult_price != null ? `${item.adult_price.toLocaleString("en-US")}₮` : "—"}</span>
                  </button>
                </li>
              );
            })}
            {!visible.length && <li className="px-3 py-4 text-sm text-ink-muted">Огноо олдсонгүй.</li>}
          </ul>
        </div>
        <Button variant="secondary" size="sm" className="mt-3" onClick={addDeparture}><Icons.plus size={14} />Гаралт нэмэх</Button>
      </div>

      {group && selected && (
        <div className="min-w-0">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h4 className="text-base font-semibold text-ink">{rowTitle(selected)}</h4>
              {rowMeta(selected) && <p className="text-xs text-ink-muted">{rowMeta(selected)}</p>}
            </div>
            <RemoveButton label="Сонгосон гаралт хасах" onClick={() => {
              if (!window.confirm(`${selected.date ? displayDate(selected.date) : "Энэ"} гаралтыг хасах уу?`)) return;
              const dates = pricingDates(records[selected.groupIndex]).filter((date) => date !== selected.date);
              onChange((current) => current.flatMap((item, index) => index !== selected.groupIndex ? [item] : dates.length ? [{ ...item, dates, date_keys: dates, display_dates: dates }] : []));
              setSelection("");
            }} />
          </div>

          <Field label="Огноо" hint="Нэг гаралт хэд хэдэн огноотой байж болно.">
            <DateChips
              dates={selected.date ? [selected.date] : group.dates}
              onChange={(dates) => {
                update({ dates, display_dates: dates, date_keys: dates });
                setSelection(`${dates[0] || ""}|${selected.groupIndex + (pricingDates(records[selected.groupIndex]).length > 1 && selected.date ? 1 : 0)}`);
              }}
            />
          </Field>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Том хүний үнэ" required missing={group.adult_price == null}>
              <MoneyField ariaLabel="Том хүний үнэ" value={group.adult_price != null ? String(group.adult_price) : ""} onChange={(digits) => update({ adult_price: digits === "" ? null : Number(digits), adult_price_range: null })} />
            </Field>
          </div>

          <div className="mt-4">
            {bands.map((price, index) => (
              <PassengerBandRow key={index} price={price}
                onChange={(next) => update({ passenger_prices: bands.map((item, i) => i === index ? next : item) })}
                onRemove={() => update({ passenger_prices: bands.filter((_, i) => i !== index) })} />
            ))}
            <div className="flex flex-wrap gap-2 border-t border-line pt-3">
              {["Хүүхэд", "Нярай"].map((label) => (
                <Button key={label} variant="ghost" size="sm" onClick={() => update({ passenger_prices: [...bands, emptyPassengerPrice(label)] })}><Icons.plus size={14} />{label} нэмэх</Button>
              ))}
            </div>
          </div>

          <details key={key(selected)} className="mt-4 border-t border-line pt-4" open={!selected.date || Boolean(group.hotel || group.package_id || group.note)}>
            <summary className="cursor-pointer text-sm font-medium text-ink-muted hover:text-ink">Буудал, багц, тэмдэглэл</summary>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <Field label="Буудал" hint="Энэ гаралтын буудал. Холбоос, зургийг «Үндсэн» → «Зочид буудлууд»-д нэмнэ."><TextInput value={group.hotel || ""} placeholder="ж: Далайн эргийн 5* буудал" onChange={(e) => update({ hotel: e.target.value })} /></Field>
              <Field label="Багц" hint="Ижил өдөр хэд хэдэн сонголт байвал, ж: Хөтөлбөртэй / Хөтөлбөргүй."><TextInput value={group.package_id || ""} placeholder="ж: Хөтөлбөртэй" onChange={(e) => update({ package_id: e.target.value })} /></Field>
              <Field label="Ганц өрөөний нэмэлт"><MoneyField ariaLabel="Ганц өрөөний нэмэлт төлбөр" value={group.single_price != null ? String(group.single_price) : ""} placeholder="заавал биш" onChange={(digits) => update({ single_price: digits === "" ? null : Number(digits) })} /></Field>
              <Field label="Үнийн нэр"><TextInput value={group.label} onChange={(e) => update({ label: e.target.value })} placeholder="ж: Стандарт" /></Field>
              <Field label="Тэмдэглэл" className="sm:col-span-2"><TextInput value={group.note} onChange={(e) => update({ note: e.target.value })} /></Field>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
