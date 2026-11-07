import { useEffect, useMemo, useState } from "react";
import { Alert, Badge, Button, Card, EmptyState, Icons, Input, Select, cx, useToast } from "@/components/ui";
import { SectionHeading } from "../AdminShared";
import type { CatalogueEdition } from "@/lib/catalogue/types";
import type { CatalogueAdmin } from "./useCatalogueAdmin";
import { CurationComplete } from "./CurationComplete";
import {
  addTrip,
  draftFromConfig,
  draftToConfig,
  isDirty,
  moveTrip,
  removeTrip,
  selectionStatus,
  setGroupOverride,
  toggleFeatured,
  type CurationDraft,
} from "./curationDraft";
import { EDITION_HINT, EditionPicker, SeverityChip, TripLine } from "./shared";

/** Edition curation: choose, order, feature and group trips. Only ids are saved; every fact is read live. */
export function CurationPanel({ admin }: { admin: CatalogueAdmin }) {
  const toast = useToast();
  const { state, reviews, reviewLoading, reviewError, loadReview, api } = admin;
  const [edition, setEdition] = useState<CatalogueEdition>("quick");
  const config = state?.config[edition];
  const configKey = `${edition}:${state?.config.updatedAt ?? "none"}`;
  const [draft, setDraft] = useState<CurationDraft | null>(() => (config ? draftFromConfig(config) : null));
  const [saved, setSaved] = useState<CurationDraft | null>(() => (config ? draftFromConfig(config) : null));
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [onlyEligible, setOnlyEligible] = useState(true);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [recommending, setRecommending] = useState(false);

  useEffect(() => {
    void loadReview(edition);
  }, [edition, loadReview]);

  useEffect(() => {
    if (!config) return;
    const next = draftFromConfig(config);
    setDraft(next);
    setSaved(next);
    // Re-seed only when the saved configuration or the edition changes, never while typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey]);

  const review = reviews[edition];
  const rows = useMemo(() => review?.rows ?? [], [review]);
  const byId = useMemo(() => new Map(rows.map((row) => [row.tripId, row])), [rows]);

  if (!state || !draft || !saved) return null;
  const limits = state.limits;
  const max = edition === "quick" ? limits.quickMax : limits.previewMax;
  const status = selectionStatus(edition, draft.tripIds.length);
  const dirty = isDirty(draft, saved);
  const canSave = dirty && status.ok;
  const needle = query.trim().toLocaleLowerCase();
  const selectedSet = new Set(draft.tripIds);
  const candidates = rows.filter((row) => {
    if (selectedSet.has(row.tripId)) return false;
    if (onlyEligible && !row.eligible) return false;
    if (!needle) return true;
    return `${row.code ?? ""} ${row.title} ${row.groupLabel ?? ""}`.toLocaleLowerCase().includes(needle);
  });

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const result = await api.saveConfig(edition, draftToConfig(draft), state?.config.updatedAt ?? null);
      toast.success("Сонголтыг хадгаллаа.");
      if (result.dropped.length > 0) toast.info(`${result.dropped.length} идэвхгүй аяллыг жагсаалтаас авлаа.`);
      await admin.reload();
      await loadReview(edition);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Хадгалж чадсангүй.");
    } finally {
      setSaving(false);
    }
  }

  /** Fills the selection with the recommended diverse shortlist. Nothing is saved until «Хадгалах». */
  async function applyRecommended() {
    if (!draft) return;
    setRecommending(true);
    try {
      const picked = await api.recommend();
      const ids = picked.tripIds.slice(0, max);
      if (ids.length === 0) {
        toast.info("Санал болгох аялал одоогоор алга.");
        return;
      }
      setDraft({ ...draft, tripIds: ids, featured: draft.featured.filter((id) => ids.includes(id)), excluded: draft.excluded.filter((id) => !ids.includes(id)) });
      setReasons(picked.reasons);
      toast.info(`${ids.length} аялал санал болголоо. Шалгаад «Хадгалах» дарна уу.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Санал болгосон жагсаалтыг ачаалж чадсангүй.");
    } finally {
      setRecommending(false);
    }
  }

  const header = (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <EditionPicker legend="Каталогийн төрөл" name="curation-edition" value={edition} onChange={setEdition} editions={["quick", "complete", "preview"]} />
      <p className="max-w-md text-xs text-ink-muted">{EDITION_HINT[edition]}</p>
    </div>
  );

  if (edition === "complete") {
    return (
      <div className="space-y-4">
        {header}
        {reviewError && <Alert tone="danger">{reviewError}</Alert>}
        <CurationComplete
          rows={rows}
          groups={review?.groups ?? []}
          draft={draft}
          setDraft={setDraft}
          loading={reviewLoading === edition && !review}
          dirty={dirty}
          saving={saving}
          onSave={() => void save()}
          onReset={() => setDraft(saved)}
        />
      </div>
    );
  }

  const selectedRows = draft.tripIds.map((id) => ({ id, row: byId.get(id) }));
  const missing = selectedRows.filter((entry) => !entry.row).length;
  return (
    <div className="space-y-4">
      {header}
      {reviewError && <Alert tone="danger">{reviewError}</Alert>}
      <div className="flex flex-wrap items-center gap-3" aria-live="polite">
        <Badge tone={status.count === 0 ? "neutral" : status.ok ? "success" : "warning"} className="text-sm">
          {status.count} / {status.min}–{status.max} аялал сонгосон
        </Badge>
        {status.message && <span className="text-sm text-ink-muted">{status.message}</span>}
      </div>
      {missing > 0 && (
        <Alert tone="warning">
          Сонгосон {missing} аялал идэвхтэй жагсаалтад олдсонгүй (архивлагдсан эсвэл нууцлагдсан). Доороос хасаад хадгална уу.
        </Alert>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="p-4">
          <SectionHeading title="Сонгосон аялал" description="Дараалал нь PDF-ийн дараалал. Онцлох аялал нүүр хуудсанд гарна." />
          {edition === "quick" && (
            <div className="mt-3">
              <Button variant="secondary" size="sm" onClick={() => void applyRecommended()} loading={recommending} disabled={saving}>
                Санал болгосон 10-г ашиглах
              </Button>
              <p className="mt-1.5 text-xs text-ink-muted">Өөр өөр чиглэлээс сонгосон жагсаалт. Хадгалахаас өмнө өөрчилж болно.</p>
            </div>
          )}
          {draft.tripIds.length === 0 ? (
            <div className="mt-4">
              <EmptyState icon={<Icons.trips size={20} />} title="Аялал сонгоогүй байна" description="Баруун талын жагсаалтаас «Нэмэх» дарна." />
            </div>
          ) : (
            <ol className="mt-3 divide-y divide-line" aria-label="Сонгосон аяллууд">
              {selectedRows.map(({ id, row }, index) => (
                <li key={id} className="flex flex-wrap items-center gap-3 py-3">
                  <span className="w-6 shrink-0 text-center text-sm font-bold tabular-nums text-ink-muted">{index + 1}</span>
                  <span className="min-w-0 flex-1">
                    {row ? <TripLine row={row} /> : <span className="text-sm text-danger">{id} — олдсонгүй</span>}
                    {reasons[id] && <span className="mt-0.5 block text-xs text-brand">Санал болгосон шалтгаан: {reasons[id]}</span>}
                  </span>
                  {row && <SeverityChip severity={row.severity} />}
                  <span className="flex flex-wrap items-center gap-1">
                    <Select
                      aria-label={`${row?.title ?? id}: бүлэг`}
                      value={draft.overrides[id] ?? ""}
                      onChange={(event) => setDraft(setGroupOverride(draft, id, event.target.value))}
                      className="h-9 max-w-[170px] text-xs"
                    >
                      <option value="">{`Автомат${row?.groupLabel ? ` (${row.groupLabel})` : ""}`}</option>
                      {(review?.groups ?? []).map((group) => (
                        <option key={group.key} value={group.key}>{group.label}</option>
                      ))}
                    </Select>
                    <Button size="sm" variant="ghost" onClick={() => setDraft(moveTrip(draft, id, -1))} disabled={index === 0} aria-label={`${row?.title ?? id}: дээш зөөх`}>↑</Button>
                    <Button size="sm" variant="ghost" onClick={() => setDraft(moveTrip(draft, id, 1))} disabled={index === draft.tripIds.length - 1} aria-label={`${row?.title ?? id}: доош зөөх`}>↓</Button>
                    <Button
                      size="sm"
                      variant={draft.featured.includes(id) ? "primary" : "secondary"}
                      aria-pressed={draft.featured.includes(id)}
                      onClick={() => setDraft(toggleFeatured(draft, id))}
                      aria-label={`${row?.title ?? id}: онцлох`}
                    >
                      Онцлох
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDraft(removeTrip(draft, id))} aria-label={`${row?.title ?? id}: хасах`}>
                      <Icons.close size={14} />
                    </Button>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Card>

        <Card className="p-4">
          <SectionHeading title="Идэвхтэй аяллууд" description="Нэр, үнэ, огноо шууд сангаас уншигдана: энд хуулбарлан хадгалахгүй." />
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div className="min-w-[180px] flex-1">
              <Input label="Хайх" placeholder="Код, нэр, бүлэг" value={query} onChange={(event) => setQuery(event.target.value)} />
            </div>
            <label className="flex min-h-10 items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={onlyEligible} onChange={(event) => setOnlyEligible(event.target.checked)} className="h-4 w-4 accent-[var(--brand,#2563eb)]" />
              Зөвхөн тохирох
            </label>
          </div>
          {reviewLoading === edition && !review ? (
            <p role="status" className="py-8 text-center text-sm text-ink-muted">Аялал ачаалж байна…</p>
          ) : candidates.length === 0 ? (
            <div className="mt-4"><EmptyState title="Нэмэх аялал олдсонгүй" description="Хайлтаа өөрчилнө үү." /></div>
          ) : (
            <ul className="mt-3 max-h-[560px] divide-y divide-line overflow-y-auto" aria-label="Нэмж болох аяллууд">
              {candidates.map((row) => {
                const blocked = !row.eligible;
                const full = draft.tripIds.length >= max;
                return (
                  <li key={row.tripId} className={cx("flex items-center gap-3 py-3", blocked && "opacity-75")}>
                    <span className="min-w-0 flex-1">
                      <TripLine row={row} />
                      {blocked && <span className="mt-1 block text-xs text-warning">Тохирохгүй: {row.eligibilityReason}</span>}
                    </span>
                    {row.eligible && <SeverityChip severity={row.severity} />}
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={blocked || full}
                      title={blocked ? row.eligibilityReason ?? undefined : full ? `Дээд хэмжээ ${max}` : undefined}
                      onClick={() => setDraft(addTrip(draft, row.tripId, max))}
                      aria-label={`${row.title}: нэмэх`}
                    >
                      <Icons.plus size={14} />
                      Нэмэх
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface p-3 shadow-card">
        <p className="text-sm text-ink-muted" role="status">
          {dirty ? (status.ok ? "Хадгалаагүй өөрчлөлт байна." : status.message) : "Бүх өөрчлөлт хадгалагдсан."}
        </p>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setDraft(saved)} disabled={!dirty || saving}>Буцаах</Button>
          <Button onClick={() => void save()} disabled={!canSave} loading={saving}>Хадгалах</Button>
        </div>
      </div>
    </div>
  );
}
