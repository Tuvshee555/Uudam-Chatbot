import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { Badge, Button, Card, EmptyState, Icons, Input, Select } from "@/components/ui";
import type { CatalogueReviewRow } from "@/lib/catalogue/admin/types";
import { setGroupOverride, toggleExcluded, type CurationDraft } from "./curationDraft";
import { SeverityChip, TripLine } from "./shared";

type Filter = "all" | "included" | "excluded" | "ineligible";

const FILTER_LABEL: Record<Filter, string> = {
  all: "Бүгд",
  included: "Орсон",
  excluded: "Хасагдсан",
  ineligible: "Тохирохгүй",
};

/**
 * The Complete edition is automatic: every eligible active trip is in. Staff can only remove a
 * trip (with a visible state) or change its group; ineligible trips are listed with the reason.
 */
export function CurationComplete({
  rows,
  groups,
  draft,
  setDraft,
  loading,
  dirty,
  saving,
  onSave,
  onReset,
}: {
  rows: CatalogueReviewRow[];
  groups: Array<{ key: string; label: string }>;
  draft: CurationDraft;
  setDraft: Dispatch<SetStateAction<CurationDraft | null>>;
  loading: boolean;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onReset: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const classified = useMemo(
    () =>
      rows.map((row) => {
        const excluded = draft.excluded.includes(row.tripId);
        const state: Exclude<Filter, "all"> = !row.eligible ? "ineligible" : excluded ? "excluded" : "included";
        return { row, state };
      }),
    [rows, draft.excluded],
  );
  const counts = {
    included: classified.filter((entry) => entry.state === "included").length,
    excluded: classified.filter((entry) => entry.state === "excluded").length,
    ineligible: classified.filter((entry) => entry.state === "ineligible").length,
  };
  const needle = query.trim().toLocaleLowerCase();
  const visible = classified.filter(({ row, state }) => {
    if (filter !== "all" && state !== filter) return false;
    if (!needle) return true;
    return `${row.code ?? ""} ${row.title} ${row.groupLabel ?? ""}`.toLocaleLowerCase().includes(needle);
  });

  if (loading) return <p role="status" className="py-10 text-center text-sm text-ink-muted">Аялал ачаалж байна…</p>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2" aria-live="polite">
        <Badge tone="success">{counts.included} орсон</Badge>
        <Badge tone={counts.excluded ? "warning" : "neutral"}>{counts.excluded} гараар хассан</Badge>
        <Badge tone={counts.ineligible ? "danger" : "neutral"}>{counts.ineligible} тохирохгүй</Badge>
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[200px] flex-1">
            <Input label="Хайх" placeholder="Код, нэр, бүлэг" value={query} onChange={(event) => setQuery(event.target.value)} />
          </div>
          <div className="min-w-[160px]">
            <Select label="Төлөв" value={filter} onChange={(event) => setFilter(event.target.value as Filter)}>
              {(Object.keys(FILTER_LABEL) as Filter[]).map((key) => (
                <option key={key} value={key}>{FILTER_LABEL[key]}</option>
              ))}
            </Select>
          </div>
        </div>

        {visible.length === 0 ? (
          <div className="mt-4"><EmptyState icon={<Icons.trips size={20} />} title="Тохирох аялал олдсонгүй" /></div>
        ) : (
          <ul className="mt-3 divide-y divide-line" aria-label="Бүрэн каталогийн аяллууд">
            {visible.map(({ row, state }) => (
              <li key={row.tripId} className="flex flex-wrap items-center gap-3 py-3">
                <span className="min-w-0 flex-1">
                  <TripLine row={row} />
                  {state === "ineligible" && <span className="mt-1 block text-xs text-warning">Яагаад ороогүй: {row.eligibilityReason}</span>}
                  {state === "excluded" && <span className="mt-1 block text-xs text-ink-muted">Ажилтан гараар хассан.</span>}
                </span>
                <Badge tone={state === "included" ? "success" : state === "excluded" ? "warning" : "danger"} dot>
                  {state === "included" ? "Орсон" : state === "excluded" ? "Хасагдсан" : "Тохирохгүй"}
                </Badge>
                {row.eligible && <SeverityChip severity={row.severity} />}
                {row.eligible && (
                  <span className="flex flex-wrap items-center gap-2">
                    <Select
                      aria-label={`${row.title}: бүлэг`}
                      value={draft.overrides[row.tripId] ?? ""}
                      onChange={(event) => setDraft((current) => (current ? setGroupOverride(current, row.tripId, event.target.value) : current))}
                      className="h-9 max-w-[170px] text-xs"
                    >
                      <option value="">{`Автомат${row.groupLabel ? ` (${row.groupLabel})` : ""}`}</option>
                      {groups.map((group) => (
                        <option key={group.key} value={group.key}>{group.label}</option>
                      ))}
                    </Select>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setDraft((current) => (current ? toggleExcluded(current, row.tripId) : current))}
                      aria-label={`${row.title}: ${state === "excluded" ? "буцааж оруулах" : "каталогоос хасах"}`}
                    >
                      {state === "excluded" ? "Оруулах" : "Хасах"}
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface p-3 shadow-card">
        <p className="text-sm text-ink-muted" role="status">{dirty ? "Хадгалаагүй өөрчлөлт байна." : "Бүх өөрчлөлт хадгалагдсан."}</p>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onReset} disabled={!dirty || saving}>Буцаах</Button>
          <Button onClick={onSave} disabled={!dirty} loading={saving}>Хадгалах</Button>
        </div>
      </div>
    </div>
  );
}
