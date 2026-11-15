/**
 * The new-trip review's building blocks: a section of the preview, the «+ …» chips an empty
 * optional field folds into, the panel a click opens under what it edits, and inputs that read as
 * the page's own text until they are clicked (a value is edited where it is shown).
 */
import { useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { Icons, cx } from "@/components/ui";
import type { Chip } from "./reviewView";

/** One part of the preview: a heading, what the trip page shows, then the chips of its empty fields. */
export function ReviewSection({ target, title, meta, action, chips, children, className }: {
  /** The place a problem link opens (tripReviewProblems.ReviewTarget, or an optional field's key). */
  target?: string;
  title: string;
  meta?: ReactNode;
  action?: ReactNode;
  chips?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section data-review-target={target} className={cx("scroll-mt-24 border-t border-line pt-7", className)} aria-label={title}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h3 className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-lg font-bold leading-7 tracking-tight text-ink">
          {title}
          {meta && <span className="text-sm font-medium text-ink-muted">{meta}</span>}
        </h3>
        {action}
      </div>
      {children}
      {chips}
    </section>
  );
}

/** The empty optional fields of a part, as small chips: a click opens the field. */
export function AddChips<K extends string>({ chips, onAdd, className, label = "Нэмэх:" }: {
  chips: Array<Chip<K>>;
  onAdd: (key: K) => void;
  className?: string;
  label?: string;
}) {
  if (!chips.length) return null;
  return (
    <div className={cx("mt-4 flex flex-wrap items-center gap-1.5", className)} data-review-chips>
      <span className="mr-0.5 text-[13px] text-ink-subtle">{label}</span>
      {chips.map((chip) => (
        <button key={chip.key} type="button" onClick={() => onAdd(chip.key)}
          className="inline-flex h-8 items-center gap-1 rounded-full border border-dashed border-line-strong px-3 text-[13px] font-medium text-ink-muted transition-colors hover:border-brand hover:bg-brand-soft/50 hover:text-brand">
          <Icons.plus size={12} />{chip.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Closing a panel gives the focus back to what opened it (the fare, chip or date), so a keyboard user
 * goes on where they were. Only when the focus was inside the panel or nowhere: a click elsewhere wins.
 */
export function useReturnFocus() {
  const [opener] = useState<HTMLElement | null>(() => (typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const panel = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = panel.current;
    return () => {
      const active = typeof document !== "undefined" ? document.activeElement : null;
      if (opener?.isConnected && (!active || active === document.body || (element && element.contains(active)))) {
        window.requestAnimationFrame(() => opener.focus());
      }
    };
  }, [opener]);
  return panel;
}

/** The panel a click opens under what it edits; «Болсон» or Escape closes it (the focus goes back). */
export function EditPanel({ title, onClose, children, target, className }: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  target?: string;
  className?: string;
}) {
  const panel = useReturnFocus();
  return (
    <div ref={panel} data-review-target={target} role="group" aria-label={typeof title === "string" ? title : undefined}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}
      className={cx("mt-3 scroll-mt-24 rounded-xl border border-brand-border bg-surface p-4 shadow-[0_1px_0_rgb(0_0_0/0.02),0_8px_24px_-16px_rgb(15_118_110/0.35)] sm:p-5", className)}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="min-w-0 text-[15px] font-semibold text-ink">{title}</p>
        <button type="button" onClick={onClose} data-panel-close className="h-8 shrink-0 rounded-md px-3 text-sm font-semibold text-brand hover:bg-brand-soft">Болсон</button>
      </div>
      {children}
    </div>
  );
}

const ghost = "w-full min-w-0 rounded-md border border-transparent bg-transparent text-ink outline-none transition-colors placeholder:text-ink-subtle hover:border-line-strong hover:bg-surface focus:border-brand focus:bg-surface focus:ring-3 focus:ring-brand/10 disabled:hover:border-transparent";

/** A value that reads as the page's own text and is edited where it is shown. */
export function GhostInput({ className, invalid, ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input {...rest} aria-invalid={invalid || undefined} className={cx(ghost, "h-10 px-2.5", invalid && "border-danger/60 bg-danger-soft/30 placeholder:text-danger/70", className)} />;
}

export function GhostTextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={1} {...rest} className={cx(ghost, "resize-none px-2.5 py-1.5 leading-7 [field-sizing:content]", className)} />;
}

/** What the file itself says, quoted, so a value can be checked against it at a glance. */
export function Evidence({ quote }: { quote: unknown }) {
  const value = typeof quote === "string" ? quote.trim() : "";
  if (!value) return null;
  return (
    <p className="mt-3 flex items-start gap-1.5 text-[13px] leading-5 text-ink-muted">
      <Icons.file size={13} className="mt-0.5 shrink-0" />
      <span className="min-w-0">Файлд: <span className="text-ink">«{value}»</span></span>
    </p>
  );
}

/** A decision the file asks for (its dates or length disagree), with the buttons that settle it. */
export function Notice({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx("mt-3 flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning-soft/60 px-4 py-3 text-sm leading-6 text-ink", className)}>
      <Icons.alert size={15} className="mt-1 shrink-0 text-warning" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/* The trip page's own small icons for its facts (the admin icon set has no clock, route or bed). */
const svg = (path: ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">{path}</svg>
);
export const ClockIcon = () => svg(<><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15.5 14" /></>);
export const RouteIcon = () => svg(<><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="6" r="2.5" /><path d="M8.5 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.5" /></>);
export const BedIcon = () => svg(<><path d="M3 18V6" /><path d="M3 14h18v4" /><path d="M21 14v-2.5A2.5 2.5 0 0 0 18.5 9H11v5" /><circle cx="7" cy="11" r="1.8" /></>);

export const primarySmall = "rounded-md bg-brand px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-brand-hover disabled:opacity-50";
export const secondarySmall = "rounded-md border border-line-strong bg-surface px-3 py-1.5 text-[13px] font-medium text-ink hover:border-brand disabled:opacity-50";
export const linkButton = "inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-brand hover:bg-brand-soft disabled:opacity-50";
