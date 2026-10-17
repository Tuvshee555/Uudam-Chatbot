/**
 * Building blocks of the trip editor: a titled section card, number steppers, the
 * day/night duration, seats, the sale badge, alias chips and one-line-per-item lists.
 * Each one takes and returns the same values the trip draft already stores, so the
 * save path is unchanged.
 */
import React from "react";
import { Icons, Switch, cx } from "@/components/ui";

export const fieldCls =
  "w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-ink transition-colors placeholder:text-ink-subtle focus:border-brand focus:outline-none focus:ring-3 focus:ring-brand/10";

export function EditorSection({
  title,
  hint,
  action,
  children,
  className,
}: {
  title: string;
  hint?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("rounded-xl border border-line bg-surface p-4 sm:p-5", className)}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
          {hint && <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function FieldLabel({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-ink">{children}</label>;
}

/** A whole number with − / + buttons; empty means "not set". */
export function NumberStepper({
  value,
  onChange,
  min = 0,
  max = 999,
  unit,
  ariaLabel,
  invalid,
}: {
  value: number | null;
  onChange: (value: number | null) => void;
  min?: number;
  max?: number;
  unit?: string;
  ariaLabel: string;
  invalid?: boolean;
}) {
  const step = (delta: number) => onChange(Math.min(max, Math.max(min, (value ?? (delta > 0 ? min - 1 : min + 1)) + delta)));
  const btn = "flex h-10 w-10 shrink-0 items-center justify-center text-lg text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink disabled:opacity-30";
  return (
    <div className={cx("flex h-10 items-stretch overflow-hidden rounded-md border bg-surface focus-within:border-brand", invalid ? "border-danger" : "border-line-strong")}>
      <button type="button" className={cx(btn, "border-r border-line")} aria-label={`${ariaLabel} хасах`} disabled={value != null && value <= min} onClick={() => step(-1)}>−</button>
      <input
        aria-label={ariaLabel}
        inputMode="numeric"
        className="w-full min-w-0 bg-transparent text-center text-base font-semibold tabular-nums text-ink outline-none"
        value={value ?? ""}
        placeholder="—"
        onChange={(e) => {
          const digits = e.target.value.replace(/[^\d]/g, "");
          onChange(digits === "" ? null : Math.min(max, Number(digits)));
        }}
      />
      {unit && <span className="flex items-center pr-3 text-sm text-ink-muted">{unit}</span>}
      <button type="button" className={cx(btn, "border-l border-line")} aria-label={`${ariaLabel} нэмэх`} disabled={value != null && value >= max} onClick={() => step(1)}>+</button>
    </div>
  );
}

/** "10 өдөр 9 шөнө", "5ш6ө", "6 өдөр" → its numbers. */
export function parseDuration(text: string): { days: number | null; nights: number | null } {
  const value = String(text || "");
  const days = value.match(/(\d{1,3})\s*(?:өдөр|өдр|ө(?![\p{L}])|d(?:ays?)?\b)/iu);
  const nights = value.match(/(\d{1,3})\s*(?:шөнө|ш(?![\p{L}])|n(?:ights?)?\b)/iu);
  if (days || nights) return { days: days ? Number(days[1]) : null, nights: nights ? Number(nights[1]) : null };
  const only = value.match(/^\s*(\d{1,3})\s*$/);
  return { days: only ? Number(only[1]) : null, nights: null };
}

export function formatDuration(days: number | null, nights: number | null): string {
  if (days == null && nights == null) return "";
  if (days == null) return `${nights} шөнө`;
  return nights == null ? `${days} өдөр` : `${days} өдөр ${nights} шөнө`;
}

/** Days and nights as two numbers; the words are fixed. Nights follow days (one fewer) until changed by hand. */
export function DurationField({ value, onChange, error }: { value: string; onChange: (value: string) => void; error?: string }) {
  const { days, nights } = parseDuration(value);
  const unreadable = Boolean(value.trim()) && days == null && nights == null;
  return (
    <div>
      <FieldLabel>Хугацаа</FieldLabel>
      <div className="grid grid-cols-2 gap-2">
        <NumberStepper
          ariaLabel="Өдөр"
          unit="өдөр"
          min={1}
          max={60}
          value={days}
          invalid={Boolean(error)}
          onChange={(next) => {
            const nightsFollowed = nights == null || days == null || nights === days - 1;
            onChange(formatDuration(next, nightsFollowed && next != null ? Math.max(0, next - 1) : nights));
          }}
        />
        <NumberStepper ariaLabel="Шөнө" unit="шөнө" min={0} max={60} value={nights} invalid={Boolean(error)} onChange={(next) => onChange(formatDuration(days, next))} />
      </div>
      {error ? <p className="mt-1.5 text-xs font-medium text-danger">{error}</p>
        : unreadable ? <p className="mt-1.5 text-xs text-warning">Одоо бичигдсэн: «{value}» — тоогоор нь дахин оруулна уу.</p>
          : days != null && nights != null && nights > days ? <p className="mt-1.5 text-xs text-warning">Шөнө өдрөөс олон байна — шалгана уу.</p>
            : null}
    </div>
  );
}

const toCount = (value: string | undefined) => {
  const digits = String(value || "").replace(/[^\d]/g, "");
  return digits === "" ? null : Number(digits);
};

export function SeatsFields({
  total,
  left,
  onChange,
}: {
  total: string;
  left: string;
  onChange: (patch: { seats_total?: string; seats_left?: string }) => void;
}) {
  const totalN = toCount(total), leftN = toCount(left);
  const tooMany = totalN != null && leftN != null && leftN > totalN;
  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <FieldLabel>Нийт суудал</FieldLabel>
          <NumberStepper ariaLabel="Нийт суудал" unit="хүн" max={999} value={totalN} onChange={(n) => onChange({ seats_total: n == null ? "" : String(n) })} />
        </div>
        <div>
          <FieldLabel>Үлдсэн суудал</FieldLabel>
          <NumberStepper ariaLabel="Үлдсэн суудал" unit="хүн" max={999} value={leftN} invalid={tooMany} onChange={(n) => onChange({ seats_left: n == null ? "" : String(n) })} />
        </div>
      </div>
      <p className={cx("mt-2 text-xs", tooMany ? "font-medium text-danger" : "text-ink-subtle")}>
        {tooMany ? "Үлдсэн суудал нийт суудлаас их байна."
          : leftN === 0 ? "Үлдсэн 0 — бүх өдөр «Дүүрсэн» гэж харагдана."
            : "Хоосон орхивол суудлын тоо харагдахгүй. Нэг өдрийг «Цөөн суудал» болгохыг «Үнэ ба гаралт» табаас хийнэ."}
      </p>
    </div>
  );
}

export function SaleBadgeFields({
  enabled,
  label,
  ends,
  onChange,
}: {
  enabled: boolean;
  label: string;
  ends: string;
  onChange: (patch: { sale_badge_enabled?: string; sale_badge_label?: string; sale_badge_ends?: string }) => void;
}) {
  const expired = Boolean(ends) && ends < new Date().toISOString().slice(0, 10);
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">Вэбсайт дээр хямдралын тэмдэг харуулах</p>
          <p className="text-xs text-ink-subtle">Аяллын зураг дээр улаан тэмдэг гарна.</p>
        </div>
        <Switch label="Хямдралын тэмдэг" checked={enabled} onChange={(next) => onChange({ sale_badge_enabled: next ? "true" : "false" })} />
      </div>
      {enabled && (
        <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
          <div>
            <FieldLabel htmlFor="sale-badge-label">Тэмдгийн бичвэр</FieldLabel>
            <input id="sale-badge-label" className={cx(fieldCls, "h-10")} maxLength={24} placeholder="ХЯМДРАЛ" value={label} onChange={(e) => onChange({ sale_badge_label: e.target.value })} />
          </div>
          <div>
            <FieldLabel htmlFor="sale-badge-ends">Дуусах өдөр</FieldLabel>
            <div className="flex gap-2">
              <input id="sale-badge-ends" type="date" className={cx(fieldCls, "h-10", expired && "border-warning")} value={ends} onChange={(e) => onChange({ sale_badge_ends: e.target.value })} />
              {ends && <button type="button" className="shrink-0 rounded-md px-2 text-xs text-ink-muted hover:bg-surface-sunken" onClick={() => onChange({ sale_badge_ends: "" })}>Арилгах</button>}
            </div>
          </div>
          <span className="inline-flex h-10 items-center justify-center rounded-md bg-danger px-3 text-xs font-bold tracking-wide text-white" aria-label="Тэмдгийн харагдац">
            {(label || "ХЯМДРАЛ").toUpperCase()}
          </span>
          <p className={cx("text-xs sm:col-span-3", expired ? "font-medium text-warning" : "text-ink-subtle")}>
            {expired ? "Дуусах өдөр өнгөрсөн тул тэмдэг одоо харагдахгүй байна."
              : ends ? "Энэ өдрийн дараа тэмдэг өөрөө алга болно." : "Дуусах өдөргүй бол унтраах хүртэл харагдана."}
          </p>
        </div>
      )}
    </div>
  );
}

/** Names typed one at a time and shown as chips (Enter or comma adds one). */
export function ChipsEditor({
  values,
  onChange,
  placeholder,
  ariaLabel,
}: {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  ariaLabel: string;
}) {
  const [draft, setDraft] = React.useState("");
  const clean = values.map((value) => value.trim()).filter(Boolean);
  const add = () => {
    const parts = draft.split(",").map((part) => part.trim()).filter(Boolean);
    if (!parts.length) return;
    onChange([...clean, ...parts.filter((part) => !clean.some((value) => value.toLowerCase() === part.toLowerCase()))]);
    setDraft("");
  };
  return (
    <div className="flex min-h-11 flex-wrap items-center gap-1.5 rounded-md border border-line-strong bg-surface px-2 py-1.5 focus-within:border-brand">
      {clean.map((value, index) => (
        <span key={`${value}-${index}`} className="inline-flex items-center gap-1 rounded-md bg-brand-soft px-2 py-1 text-xs font-medium text-brand">
          {value}
          <button type="button" aria-label={`${value} хасах`} className="flex h-4 w-4 items-center justify-center rounded-full hover:bg-brand/15" onClick={() => onChange(clean.filter((_, i) => i !== index))}>×</button>
        </span>
      ))}
      <input
        aria-label={ariaLabel}
        className="min-w-[10rem] flex-1 bg-transparent px-1 py-1 text-sm text-ink outline-none placeholder:text-ink-subtle"
        value={draft}
        placeholder={clean.length ? "" : placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); }
          else if (e.key === "Backspace" && !draft && clean.length) onChange(clean.slice(0, -1));
        }}
      />
    </div>
  );
}

/** A list where each row is one item; Enter on a row starts the next one. */
export function ListEditor({
  items,
  onChange,
  placeholder,
  addLabel,
  ariaLabel,
  tone = "neutral",
}: {
  items: string[];
  onChange: (items: string[]) => void;
  placeholder?: string;
  addLabel: string;
  ariaLabel: string;
  tone?: "neutral" | "good" | "bad";
}) {
  const refs = React.useRef<Array<HTMLInputElement | null>>([]);
  const [focusIndex, setFocusIndex] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (focusIndex == null) return;
    refs.current[focusIndex]?.focus();
    setFocusIndex(null);
  }, [focusIndex, items.length]);
  const mark = tone === "good" ? <Icons.check size={14} className="text-success" /> : tone === "bad" ? <span className="text-sm font-bold leading-none text-danger">×</span> : <span className="h-1.5 w-1.5 rounded-full bg-ink-subtle" />;
  return (
    <div>
      {items.length > 0 && (
        <ul className="divide-y divide-line rounded-md border border-line">
          {items.map((item, index) => (
            <li key={index} className="group flex items-center gap-2 pl-3 pr-1">
              <span className="flex w-4 shrink-0 justify-center" aria-hidden="true">{mark}</span>
              <input
                ref={(el) => { refs.current[index] = el; }}
                aria-label={`${ariaLabel} ${index + 1}`}
                className="h-10 min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-subtle"
                value={item}
                placeholder={placeholder}
                onChange={(e) => onChange(items.map((value, i) => (i === index ? e.target.value : value)))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onChange([...items.slice(0, index + 1), "", ...items.slice(index + 1)]);
                    setFocusIndex(index + 1);
                  } else if (e.key === "Backspace" && !item && items.length) {
                    e.preventDefault();
                    onChange(items.filter((_, i) => i !== index));
                    setFocusIndex(Math.max(0, index - 1));
                  }
                }}
              />
              <button type="button" aria-label={`${ariaLabel} ${index + 1} хасах`} className="shrink-0 rounded-md p-2 text-ink-subtle opacity-60 transition hover:bg-danger-soft hover:text-danger group-hover:opacity-100" onClick={() => onChange(items.filter((_, i) => i !== index))}>
                <Icons.trash size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className={cx("flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-line-strong py-2 text-sm font-medium text-ink-muted transition-colors hover:border-brand hover:text-brand", items.length > 0 && "mt-2")}
        onClick={() => { onChange([...items, ""]); setFocusIndex(items.length); }}
      >
        <Icons.plus size={14} />
        {addLabel}
      </button>
    </div>
  );
}

/** Money typed as digits and shown with thousands separators. */
export function AmountInput({
  value,
  onChange,
  currency = "MNT",
  ariaLabel,
  placeholder,
}: {
  value: number | null;
  onChange: (value: number | null) => void;
  currency?: string;
  ariaLabel: string;
  placeholder?: string;
}) {
  return (
    <span className="flex h-10 items-center rounded-md border border-line-strong bg-surface px-3 focus-within:border-brand">
      <input
        aria-label={ariaLabel}
        inputMode="numeric"
        className="min-w-0 flex-1 bg-transparent text-sm tabular-nums text-ink outline-none placeholder:text-ink-subtle"
        value={value == null ? "" : value.toLocaleString("en-US")}
        placeholder={placeholder}
        onChange={(e) => {
          const digits = e.target.value.replace(/[^\d]/g, "");
          onChange(digits === "" ? null : Number(digits));
        }}
      />
      <span className="ml-2 shrink-0 text-sm font-semibold text-ink-muted">{currency === "MNT" ? "₮" : currency}</span>
    </span>
  );
}

/** "2026-11-05" → "2026 оны 11 сарын 5"; anything else is shown as written. */
export function displayDate(value: string): string {
  const iso = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!iso) return value;
  const year = Number(iso[1]);
  const text = `${Number(iso[2])} сарын ${Number(iso[3])}`;
  return year === new Date().getFullYear() ? text : `${year} оны ${text}`;
}
