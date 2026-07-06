import type { ReactNode } from "react";
import { Button, Icons, Spinner } from "@/components/ui";
import type { StructuredRow } from "@/lib/adminTypes";

/** Full-panel loading placeholder for a tab's initial data fetch. */
export function LoadingPanel() {
  return (
    <div className="flex items-center justify-center py-16">
      <Spinner />
    </div>
  );
}

export function SectionHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {description && (
          <p className="mt-0.5 text-sm text-ink-muted">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

export function StructuredEditor({
  title,
  addLabel,
  fields,
  rows,
  onChange,
}: {
  title: string;
  addLabel: string;
  fields: Array<{ key: string; label: string }>;
  rows: StructuredRow[];
  onChange: (rows: StructuredRow[]) => void;
}) {
  function update(index: number, key: string, value: string) {
    onChange(rows.map((row, i) => (i === index ? { ...row, [key]: value } : row)));
  }
  function remove(index: number) {
    onChange(rows.filter((_, i) => i !== index));
  }
  function add() {
    const blank: StructuredRow = {};
    for (const field of fields) blank[field.key] = "";
    onChange([...rows, blank]);
  }
  return (
    <div className="rounded-lg border border-line bg-surface-sunken p-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-ink">{title}</h4>
        <Button size="sm" variant="secondary" onClick={add}>
          <Icons.plus size={15} />
          {addLabel}
        </Button>
      </div>
      <div className="mt-2 space-y-2">
        {rows.length === 0 && (
          <p className="text-xs text-ink-subtle">Хоосон байна.</p>
        )}
        {rows.map((row, index) => (
          <div
            key={index}
            className="rounded-md border border-line bg-surface p-2.5"
          >
            <div className="grid gap-2 sm:grid-cols-2">
              {fields.map((field) => (
                <label key={field.key} className="block">
                  <span className="text-xs font-medium text-ink-muted">
                    {field.label}
                  </span>
                  <input
                    className="mt-1 h-9 w-full rounded-md border border-line-strong bg-surface px-2.5 text-sm text-ink focus:border-brand"
                    value={row[field.key] || ""}
                    onChange={(e) => update(index, field.key, e.target.value)}
                  />
                </label>
              ))}
            </div>
            <div className="mt-2 flex justify-end">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => remove(index)}
                className="text-danger"
              >
                <Icons.trash size={15} />
                Устгах
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
