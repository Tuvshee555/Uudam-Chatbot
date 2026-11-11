import { useState } from "react";
import { Alert, Badge, Button, Card, EmptyState, cx, useToast } from "@/components/ui";
import type { CatalogueCoverCandidate, CatalogueCoverCandidatesResponse } from "@/lib/catalogue/admin/types";
import type { CatalogueHeroChoice, PhotoFocal } from "@/lib/catalogue/types";
import type { CatalogueAdmin } from "./useCatalogueAdmin";
import { CropPreview, FocalFrame, Slider } from "./HeroEditor";
import { FOCAL_CENTER, ZOOM_MAX, ZOOM_MIN, sizeLabel } from "./heroCrop";

export type CoverDraft = { url: string; tripId: string; focal: PhotoFocal; zoom: number };

/** The draft for the stored cover when its photo is still among the candidates (so its trip is known), else null. */
export function draftOfCover(current: CatalogueHeroChoice | null, candidates: readonly CatalogueCoverCandidate[]): CoverDraft | null {
  const match = current ? candidates.find((candidate) => candidate.url === current.url) : undefined;
  return current && match ? { url: current.url, tripId: match.tripId, focal: current.focal ?? FOCAL_CENTER, zoom: current.zoom ?? 1 } : null;
}

export function coverChanged(draft: CoverDraft | null, current: CatalogueHeroChoice | null): boolean {
  if (!draft) return false;
  if (!current) return true;
  const f = current.focal ?? FOCAL_CENTER;
  return draft.url !== current.url || Math.abs(draft.focal.x - f.x) > 0.0005 || Math.abs(draft.focal.y - f.y) > 0.0005 || Math.abs(draft.zoom - (current.zoom ?? 1)) > 0.004;
}

type FormProps = {
  data: CatalogueCoverCandidatesResponse;
  draft: CoverDraft | null;
  onDraft: (next: CoverDraft | null) => void;
  saving: boolean;
  onSave: () => void;
  onAutomatic: () => void;
};

/** The chooser itself, free of data loading so it renders (and is tested) on its own. */
export function CoverPhotoForm({ data, draft, onDraft, saving, onSave, onAutomatic }: FormProps) {
  const dirty = coverChanged(draft, data.current);
  return (
    <div className="space-y-4">
      {data.candidates.length === 0 ? (
        <EmptyState title="Тохирох нүүр зураг олдсонгүй" description="Хуудас бүрт ашиглагдаагүй, хангалттай сайн зураг алга. Аяллын зураг нэмсний дараа дахин хайна уу." />
      ) : (
        <fieldset>
          <legend className="mb-2 text-sm font-semibold text-ink">Хуудсанд ороогүй хамгийн сайн зургууд ({data.candidates.length})</legend>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {data.candidates.map((candidate) => {
              const selected = draft?.url === candidate.url;
              return (
                <label
                  key={candidate.url}
                  className={cx(
                    "block cursor-pointer overflow-hidden rounded-xl border bg-surface transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-brand",
                    selected ? "border-brand ring-2 ring-brand/30" : "border-line hover:border-line-strong",
                  )}
                >
                  <input
                    type="radio"
                    name="cover-photo"
                    className="sr-only"
                    checked={selected}
                    onChange={() => onDraft({ url: candidate.url, tripId: candidate.tripId, focal: FOCAL_CENTER, zoom: 1 })}
                    aria-label={`${candidate.code ? `${candidate.code} ` : ""}${candidate.tripTitle}: зураг, ${sizeLabel(candidate)}, оноо ${Math.round(candidate.score)}`}
                  />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={candidate.url} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-28 w-full bg-surface-sunken object-cover" />
                  <span className="block space-y-1 p-2.5">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={candidate.score >= 70 ? "success" : "warning"}>Оноо {Math.round(candidate.score)}</Badge>
                      <span className="text-xs tabular-nums text-ink-muted">{sizeLabel(candidate)}</span>
                    </span>
                    <span className="block break-words text-xs text-ink-muted">{candidate.code ? `${candidate.code} · ` : ""}{candidate.tripTitle}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      )}
      {data.truncated && <Alert tone="info">Хайлт хугацааны хязгаарт хүрч зогссон тул бүх аяллын зураг орсонгүй. Дахин хайвал өөр зураг гарч болно.</Alert>}

      {draft && (
        <Card className="space-y-4 p-4">
          <div className="flex flex-wrap items-start gap-5">
            <FocalFrame url={draft.url} focal={draft.focal} onChange={(focal) => onDraft({ ...draft, focal })} />
            <CropPreview url={draft.url} focal={draft.focal} zoom={draft.zoom} label="Нүүр хуудсанд (9:16)" />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Slider label="Хэвтээ байрлал" value={draft.focal.x} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(x) => onDraft({ ...draft, focal: { ...draft.focal, x } })} />
            <Slider label="Босоо байрлал" value={draft.focal.y} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(y) => onDraft({ ...draft, focal: { ...draft.focal, y } })} />
            <Slider label="Томруулалт" value={draft.zoom} min={ZOOM_MIN} max={ZOOM_MAX} step={0.05} format={(v) => `${v.toFixed(2)}×`} onChange={(zoom) => onDraft({ ...draft, zoom })} />
          </div>
        </Card>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface p-3">
        <p className="text-sm text-ink-muted" role="status">
          {dirty ? "Хадгалаагүй өөрчлөлт байна." : data.current ? "Нүүр зургийг гараар сонгосон." : "Автомат нүүр зураг ашиглаж байна."}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={onAutomatic} disabled={!data.current || saving}>Автомат руу буцаах</Button>
          <Button onClick={onSave} disabled={!dirty || saving} loading={saving}>Нүүр зургийг хадгалах</Button>
        </div>
      </div>
    </div>
  );
}

/**
 * «Нүүр зураг»: the photograph that opens the book. Chosen from the best approved photos no trip page uses, so no
 * picture appears on both the cover and a page of its own. Nothing is stored until «Нүүр зургийг хадгалах».
 * The search reads every candidate trip's photo sizes, so it only runs when staff ask for it.
 */
export function CoverPhotoChooser({ admin }: { admin: CatalogueAdmin }) {
  const toast = useToast();
  const [data, setData] = useState<CatalogueCoverCandidatesResponse | null>(null);
  const [draft, setDraft] = useState<CoverDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stored = admin.state?.config.coverPhoto ?? null;

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const response = await admin.api.coverCandidates();
      setData(response);
      setDraft(draftOfCover(response.current, response.candidates));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Нүүр зургийн жагсаалтыг ачаалж чадсангүй.");
    } finally {
      setLoading(false);
    }
  }

  async function save(automatic: boolean) {
    if (!data) return;
    if (!automatic && !draft) return;
    setSaving(true);
    try {
      const response = await admin.api.saveCover({
        coverPhoto: automatic || !draft ? null : { url: draft.url, tripId: draft.tripId, focal: draft.focal, zoom: draft.zoom },
        expectedUpdatedAt: admin.state?.config.updatedAt ?? null,
      });
      toast.success(automatic ? "Автомат нүүр зураг руу буцлаа." : "Нүүр зургийг хадгаллаа.");
      setData({ ...data, current: response.config.coverPhoto ?? null });
      if (automatic) setDraft(null);
      await admin.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Хадгалж чадсангүй.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-ink">Нүүр зураг</h3>
          <p className="text-sm text-ink-muted">
            Каталогийг нээх зураг. Аяллын хуудсанд ашиглагдаагүй, хамгийн сайн зургуудаас сонгоно: ингэснээр нэг зураг нүүр болон хуудас дээр давхцахгүй.
            {stored ? " Одоо гараар сонгосон зураг ашиглагдаж байна." : " Сонгоогүй бол автоматаар хамгийн сайн зургийг авна."}
          </p>
        </div>
        {stored && !data && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={stored.url} alt="Одоогийн нүүр зураг" loading="lazy" referrerPolicy="no-referrer" className="h-24 w-[54px] rounded-md border border-line object-cover" />
        )}
        <Button variant={data ? "secondary" : "primary"} onClick={() => void load()} loading={loading}>
          {data ? "Дахин хайх" : "Нүүр зураг сонгох"}
        </Button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {loading && !data && <p role="status" className="py-4 text-center text-sm text-ink-muted">Зураг хайж байна… Аяллын зургийн хэмжээг шалгаж байгаа тул хэдэн секунд зарцуулна.</p>}
      {data && (
        <CoverPhotoForm data={data} draft={draft} onDraft={setDraft} saving={saving} onSave={() => void save(false)} onAutomatic={() => void save(true)} />
      )}
    </Card>
  );
}
