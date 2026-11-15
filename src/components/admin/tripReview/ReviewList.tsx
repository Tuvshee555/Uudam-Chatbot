/**
 * A list of one-line facts the review shows whole: «Үнэд багтсан», «Үнэд багтаагүй», «Анхаарах зүйлс».
 * The trip editor's ListEditor keeps each row on one line, so a sentence from a file
 * («Аяллын хугацаанд нийт 4 шөнө 4 одтой зэрэглэлийн буудалд байрлана») was cut at the edge of the
 * box and the admin could not read what they were about to publish. Here a row grows to fit its text.
 * Enter starts the next row, Backspace on an empty row removes it, as in the editor.
 */
import { useEffect, useRef, type KeyboardEvent } from "react";
import { Icons, cx } from "@/components/ui";

export function ReviewList({
  items,
  onChange,
  addLabel,
  ariaLabel,
  tone = "neutral",
  variant = "box",
}: {
  items: string[];
  onChange: (items: string[]) => void;
  addLabel: string;
  ariaLabel: string;
  tone?: "neutral" | "good" | "bad";
  /** "preview": the list as the trip page shows it (no box), each line edited where it is read. */
  variant?: "box" | "preview";
}) {
  const refs = useRef<Array<HTMLTextAreaElement | null>>([]);
  // The row to put the cursor in once the list has re-rendered (after Enter, Backspace or add).
  const focusNext = useRef<number | null>(null);
  useEffect(() => {
    if (focusNext.current == null) return;
    refs.current[focusNext.current]?.focus();
    focusNext.current = null;
  });
  const setFocusIndex = (index: number) => { focusNext.current = index; };
  const mark = tone === "good" ? <Icons.check size={14} className="text-success" />
    : tone === "bad" ? <span className="text-sm font-bold leading-none text-danger">×</span>
      : <span className="h-1.5 w-1.5 rounded-full bg-ink-subtle" />;
  const onKeyDown = (index: number, item: string) => (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onChange([...items.slice(0, index + 1), "", ...items.slice(index + 1)]);
      setFocusIndex(index + 1);
    } else if (e.key === "Backspace" && !item && items.length) {
      e.preventDefault();
      onChange(items.filter((_, i) => i !== index));
      setFocusIndex(Math.max(0, index - 1));
    }
  };
  if (variant === "preview") {
    return (
      <div>
        {items.length > 0 && (
          <ul className="space-y-0.5">
            {items.map((item, index) => (
              <li key={index} className="group flex items-start gap-1.5 rounded-md transition-colors focus-within:bg-surface hover:bg-canvas">
                <span className="mt-2.5 flex h-5 w-5 shrink-0 items-center justify-center" aria-hidden="true">{mark}</span>
                <textarea
                  ref={(el) => { refs.current[index] = el; }}
                  rows={1}
                  aria-label={`${ariaLabel} ${index + 1}`}
                  className="min-h-10 min-w-0 flex-1 resize-none rounded-md border border-transparent bg-transparent px-1.5 py-2 text-[15px] leading-6 text-ink outline-none [field-sizing:content] placeholder:text-ink-subtle focus:border-brand focus:bg-surface focus:ring-3 focus:ring-brand/10"
                  value={item}
                  placeholder="Шинэ мөр…"
                  onChange={(e) => onChange(items.map((value, i) => (i === index ? e.target.value.replace(/\n/g, " ") : value)))}
                  onKeyDown={onKeyDown(index, item)}
                />
                <button type="button" aria-label={`${ariaLabel} ${index + 1} хасах`}
                  className="mt-1 shrink-0 rounded-md p-2 text-ink-subtle opacity-40 transition hover:bg-danger-soft hover:text-danger group-hover:opacity-100 group-focus-within:opacity-100"
                  onClick={() => onChange(items.filter((_, i) => i !== index))}>
                  <Icons.trash size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <button type="button"
          className="mt-1 inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium text-ink-muted transition-colors hover:bg-brand-soft hover:text-brand"
          onClick={() => { onChange([...items, ""]); setFocusIndex(items.length); }}>
          <Icons.plus size={13} />
          {addLabel}
        </button>
      </div>
    );
  }
  return (
    <div>
      {items.length > 0 && (
        <ul className="divide-y divide-line rounded-md border border-line">
          {items.map((item, index) => (
            <li key={index} className="group flex items-start gap-2 pl-3 pr-1">
              <span className="mt-2.5 flex h-5 w-4 shrink-0 items-center justify-center" aria-hidden="true">{mark}</span>
              <textarea
                ref={(el) => { refs.current[index] = el; }}
                rows={1}
                aria-label={`${ariaLabel} ${index + 1}`}
                className="min-h-10 min-w-0 flex-1 resize-none bg-transparent py-2.5 text-sm leading-5 text-ink outline-none [field-sizing:content] placeholder:text-ink-subtle"
                value={item}
                onChange={(e) => onChange(items.map((value, i) => (i === index ? e.target.value.replace(/\n/g, " ") : value)))}
                onKeyDown={onKeyDown(index, item)}
              />
              <button type="button" aria-label={`${ariaLabel} ${index + 1} хасах`}
                className="mt-1 shrink-0 rounded-md p-2 text-ink-subtle opacity-60 transition hover:bg-danger-soft hover:text-danger group-hover:opacity-100"
                onClick={() => onChange(items.filter((_, i) => i !== index))}>
                <Icons.trash size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button"
        className={cx("flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-line-strong py-2 text-sm font-medium text-ink-muted transition-colors hover:border-brand hover:text-brand", items.length > 0 && "mt-2")}
        onClick={() => { onChange([...items, ""]); setFocusIndex(items.length); }}>
        <Icons.plus size={14} />
        {addLabel}
      </button>
    </div>
  );
}
