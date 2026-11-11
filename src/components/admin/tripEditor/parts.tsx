/**
 * The trip editor's building blocks. One visual language for every section:
 * a section heading that says who reads the data (bot, website, poster),
 * field groups separated by rules rather than nested cards, labels that mark
 * what is required, and a calm "missing" state that only turns on once the
 * admin tries to save.
 */
import React from "react";
import { Icons, cx } from "@/components/ui";

export const controlCls =
  "w-full rounded-md border bg-surface text-sm text-ink transition-colors placeholder:text-ink-subtle focus:border-brand focus:outline-none focus:ring-3 focus:ring-brand/10 disabled:bg-surface-sunken/60 disabled:text-ink-subtle";

/** `danger`: a value that is required to publish and still empty is red, not the editor's calm amber. */
export function borderFor(missing?: boolean, danger?: boolean) {
  return missing ? (danger ? "border-danger" : "border-warning/70") : "border-line-strong";
}

export type Audience = "bot" | "website" | "poster";

const AUDIENCE_LABEL: Record<Audience, string> = { bot: "Чатбот", website: "Вэбсайт", poster: "Постер" };

/** Where a section's data is shown, so staff know what a field changes. */
export function AudienceTags({ audiences, className }: { audiences: Audience[]; className?: string }) {
  return (
    <span className={cx("inline-flex flex-wrap items-center gap-1", className)} aria-label="Хаана харагдах">
      {audiences.map((audience) => (
        <span key={audience} className="rounded-md bg-surface-sunken px-1.5 py-0.5 text-[11px] font-medium text-ink-muted">
          {AUDIENCE_LABEL[audience]}
        </span>
      ))}
    </span>
  );
}

export function SectionHeader({ title, description, audiences }: { title: string; description: string; audiences: Audience[] }) {
  return (
    <header className="mb-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-xl font-bold tracking-tight text-ink">{title}</h2>
        <AudienceTags audiences={audiences} />
      </div>
      <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-muted">{description}</p>
    </header>
  );
}

/** A named group of fields. Groups follow each other separated by a rule. */
export function Group({ title, hint, action, children, className }: { title?: string; hint?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cx("border-t border-line pt-6 first:border-t-0 first:pt-0", className)}>
      {(title || action) && (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <h3 className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">{title}</h3>}
            {hint && <p className="mt-1 max-w-2xl text-xs leading-5 text-ink-muted">{hint}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * Label, control and help text. `required` shows a quiet marker; `missing` (a required
 * value still empty after a save attempt) turns the help text amber: an empty field is
 * unfinished work, not a mistake. Only what the owner decided must be there to publish
 * (the adult and child fare) asks for `danger`, which is red.
 */
export function Field({
  id,
  label,
  required,
  missing,
  danger,
  hint,
  anchor,
  className,
  children,
}: {
  id?: string;
  label: React.ReactNode;
  required?: boolean;
  missing?: boolean;
  /** With `missing`: red instead of amber (needed to publish). */
  danger?: boolean;
  hint?: React.ReactNode;
  /** The completeness key this field answers; the header's "missing" list jumps here. */
  anchor?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cx("min-w-0", className)} data-trip-field={anchor}>
      <label htmlFor={id} className="mb-1.5 flex items-baseline justify-between gap-2 text-sm font-medium text-ink">
        <span className="min-w-0">{label}</span>
        {required && (
          <span className={cx("shrink-0 text-[11px] font-medium", missing ? (danger ? "text-danger" : "text-warning") : "text-ink-subtle")}>
            {missing ? "Дутуу" : "Заавал"}
          </span>
        )}
      </label>
      {children}
      {hint && <p className="mt-1.5 text-xs leading-5 text-ink-subtle">{hint}</p>}
    </div>
  );
}

export function TextInput({ missing, danger, className, ...rest }: React.InputHTMLAttributes<HTMLInputElement> & { missing?: boolean; danger?: boolean }) {
  return <input {...rest} aria-invalid={missing && danger ? true : rest["aria-invalid"]} className={cx(controlCls, "h-10 px-3", borderFor(missing, danger), className)} />;
}

export function TextArea({ className, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cx(controlCls, "min-h-20 px-3 py-2 leading-6 [field-sizing:content]", borderFor(false), className)} />;
}

export function SelectInput({ className, children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cx(controlCls, "h-10 appearance-none bg-[length:16px] bg-[right_0.6rem_center] bg-no-repeat pl-3 pr-9", borderFor(false), className)}
      style={{ backgroundImage: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%235a6163' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>\")" }}>
      {children}
    </select>
  );
}

/** A whole number with a unit, and small − / + at the right edge. Empty means "not set". */
export function CountInput({
  value,
  onChange,
  min = 0,
  max = 999,
  unit,
  ariaLabel,
  missing,
  id,
}: {
  value: number | null;
  onChange: (value: number | null) => void;
  min?: number;
  max?: number;
  unit?: string;
  ariaLabel: string;
  missing?: boolean;
  id?: string;
}) {
  const step = (delta: number) => onChange(Math.min(max, Math.max(min, (value ?? (delta > 0 ? min - 1 : min + 1)) + delta)));
  const btn = "flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink disabled:opacity-30";
  return (
    <div className={cx("flex h-10 items-center rounded-md border bg-surface pl-3 pr-1 focus-within:border-brand focus-within:ring-3 focus-within:ring-brand/10", borderFor(missing))}>
      <input
        id={id}
        aria-label={ariaLabel}
        inputMode="numeric"
        className="w-full min-w-0 bg-transparent text-sm font-semibold tabular-nums text-ink outline-none placeholder:font-normal placeholder:text-ink-subtle"
        value={value ?? ""}
        placeholder="—"
        onChange={(e) => {
          const digits = e.target.value.replace(/[^\d]/g, "");
          onChange(digits === "" ? null : Math.min(max, Number(digits)));
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp") { e.preventDefault(); step(1); }
          if (e.key === "ArrowDown") { e.preventDefault(); step(-1); }
        }}
      />
      {unit && <span className="mr-1 shrink-0 text-sm text-ink-muted">{unit}</span>}
      <span className="ml-1 flex shrink-0 items-center border-l border-line pl-1">
        <button type="button" className={btn} aria-label={`${ariaLabel} хасах`} disabled={value != null && value <= min} onClick={() => step(-1)}>−</button>
        <button type="button" className={btn} aria-label={`${ariaLabel} нэмэх`} disabled={value != null && value >= max} onClick={() => step(1)}>+</button>
      </span>
    </div>
  );
}

/** Money typed as digits, shown with separators, with the currency at the edge. */
export function MoneyField({
  value,
  onChange,
  currency = "MNT",
  ariaLabel,
  placeholder,
  disabled,
  missing,
  danger,
  id,
}: {
  value: string;
  onChange: (digits: string) => void;
  currency?: string;
  ariaLabel: string;
  placeholder?: string;
  disabled?: boolean;
  missing?: boolean;
  /** With `missing`: red (a fare needed to publish). */
  danger?: boolean;
  id?: string;
}) {
  const number = value.replace(/[^\d]/g, "");
  return (
    <span className={cx("flex h-10 items-center rounded-md border bg-surface pl-3 pr-2.5 focus-within:border-brand focus-within:ring-3 focus-within:ring-brand/10", disabled && "bg-surface-sunken/60", borderFor(missing, danger))}>
      <input
        id={id}
        aria-label={ariaLabel}
        aria-invalid={missing && danger ? true : undefined}
        inputMode="numeric"
        disabled={disabled}
        value={number ? Number(number).toLocaleString("en-US") : ""}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, ""))}
        className="min-w-0 flex-1 bg-transparent text-sm tabular-nums text-ink outline-none placeholder:text-ink-subtle disabled:text-ink-subtle"
      />
      <span className="ml-2 shrink-0 text-sm font-semibold text-ink-muted">{currency === "MNT" ? "₮" : currency === "CNY" ? "¥" : currency === "USD" ? "$" : currency}</span>
    </span>
  );
}

export function Checkbox({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  return (
    <label className={cx("inline-flex items-center gap-2 text-sm text-ink", disabled && "opacity-60")}>
      <input type="checkbox" className="h-4 w-4 rounded border-line-strong accent-brand" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function AddRowButton({ label, onClick, className }: { label: string; onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx("inline-flex h-9 items-center gap-1.5 rounded-md border border-dashed border-line-strong px-3 text-sm font-medium text-ink-muted transition-colors hover:border-brand hover:bg-brand-soft/40 hover:text-brand", className)}
    >
      <Icons.plus size={14} />
      {label}
    </button>
  );
}

export function RemoveButton({ label, onClick, className }: { label: string; onClick: () => void; className?: string }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} className={cx("flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-danger-soft hover:text-danger", className)}>
      <Icons.trash size={14} />
    </button>
  );
}

/** A removable list entry with a title row; replaces "card inside a card" rows. */
export function RowCard({ title, onRemove, removeLabel, children }: { title: React.ReactNode; onRemove: () => void; removeLabel: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-sm font-semibold text-ink">{title}</span>
        <RemoveButton label={removeLabel} onClick={onRemove} />
      </div>
      {children}
    </div>
  );
}

/** A switch row: a title, a one-line explanation, the switch at the right. */
export function SwitchRow({ title, hint, control }: { title: string; hint?: string; control: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">{title}</p>
        {hint && <p className="mt-0.5 text-xs leading-5 text-ink-muted">{hint}</p>}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

export function EmptyHint({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg border border-dashed border-line px-4 py-5 text-center text-sm text-ink-muted">{children}</p>;
}
