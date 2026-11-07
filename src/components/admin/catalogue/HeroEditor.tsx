import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Alert, Badge, Button, Card, EmptyState, Input, cx, useToast } from "@/components/ui";
import type { CataloguePhotosResponse } from "@/lib/catalogue/admin/types";
import type { PhotoFocal } from "@/lib/catalogue/types";
import type { CatalogueAdmin } from "./useCatalogueAdmin";
import {
  TITLE_MAX,
  ZOOM_MAX,
  ZOOM_MIN,
  cropStyle,
  draftOf,
  focalFromPointer,
  heroChanged,
  sizeLabel,
  titleChanged,
  type HeroDraft,
} from "./heroCrop";

const SOURCE_LABEL: Record<string, string> = {
  poster_hero: "Постерын гол зураг",
  trip_photo: "Аяллын зураг",
  poster_day: "Постерын өдрийн зураг",
};

/** The page-shaped (9:16) box with the photo cropped exactly as the book crops it. */
function CropPreview({ url, focal, zoom, label }: { url: string; focal: PhotoFocal; zoom: number; label: string }) {
  return (
    <div className="w-36 shrink-0">
      <p className="mb-1.5 text-xs font-semibold text-ink-muted">{label}</p>
      <div className="relative overflow-hidden rounded-lg border border-line-strong bg-surface-sunken" style={{ aspectRatio: "9 / 16" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="Нүүр хуудсанд гарах хэсэг" referrerPolicy="no-referrer" draggable={false} style={cropStyle(focal, zoom)} />
      </div>
    </div>
  );
}

/** The whole photo: press or drag on it to choose the point the crop keeps in view. */
function FocalFrame({ url, focal, onChange }: { url: string; focal: PhotoFocal; onChange: (next: PhotoFocal) => void }) {
  const dragging = useRef(false);
  const update = (event: PointerEvent<HTMLDivElement>) => onChange(focalFromPointer(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY));
  return (
    <div className="min-w-0 flex-1">
      <p className="mb-1.5 text-xs font-semibold text-ink-muted">Бүтэн зураг: дарж эсвэл чирж гол хэсгээ заана уу</p>
      <div
        data-testid="focal-frame"
        className="relative inline-block max-w-full cursor-crosshair touch-none select-none overflow-hidden rounded-lg border border-line-strong"
        onPointerDown={(event) => {
          dragging.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          update(event);
        }}
        onPointerMove={(event) => {
          if (dragging.current) update(event);
        }}
        onPointerUp={(event) => {
          dragging.current = false;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="Сонгосон зураг, бүтнээрээ" referrerPolicy="no-referrer" draggable={false} className="block max-h-64 w-auto max-w-full" />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-brand/30 shadow-[0_0_0_1px_rgba(0,0,0,0.45)]"
          style={{ left: `${focal.x * 100}%`, top: `${focal.y * 100}%` }}
        />
      </div>
    </div>
  );
}

function Slider({ label, value, min, max, step, onChange, format }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void; format: (value: number) => string;
}) {
  return (
    <label className="block text-sm text-ink">
      <span className="mb-1 flex items-center justify-between gap-2 text-xs font-semibold text-ink-muted">
        <span>{label}</span>
        <span className="tabular-nums text-ink">{format(value)}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} className="h-6 w-full accent-[var(--brand,#2563eb)]" />
    </label>
  );
}

type FormProps = {
  tripId: string;
  data: CataloguePhotosResponse;
  draft: HeroDraft;
  onDraft: (next: HeroDraft) => void;
  saving: boolean;
  dirty: boolean;
  titleTooLong: boolean;
  onSave: () => void;
  onClear: () => void;
  onReset: () => void;
};

/** The picker itself, free of data loading so it renders (and is tested) on its own. */
export function HeroEditorForm({ tripId, data, draft, onDraft: setDraft, saving, dirty, titleTooLong, onSave, onClear, onReset }: FormProps) {
  return (
    <div className="space-y-5">
      {data.candidates.length === 0 ? (
        <EmptyState title="Сонгох зураг алга" description="Энэ аяллын постер эсвэл зургийн санд зураг нэмсний дараа энд сонгох боломжтой болно." />
      ) : (
        <fieldset>
          <legend className="mb-2 text-sm font-semibold text-ink">Зураг сонгох ({data.candidates.length})</legend>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {data.candidates.map((candidate) => {
              const selected = draft.url === candidate.url;
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
                    name={`hero-${tripId}`}
                    className="sr-only"
                    checked={selected}
                    onChange={() => setDraft({ ...draft, url: candidate.url, focal: { x: 0.5, y: 0.5 }, zoom: 1 })}
                    aria-label={`Зураг, ${sizeLabel(candidate)}, оноо ${Math.round(candidate.score)}`}
                  />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={candidate.url} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-28 w-full bg-surface-sunken object-cover" />
                  <span className="block space-y-1.5 p-2.5">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={candidate.score >= 70 ? "success" : candidate.score >= 45 ? "warning" : "danger"}>Оноо {Math.round(candidate.score)}</Badge>
                      <span className="text-xs tabular-nums text-ink-muted">{sizeLabel(candidate)}</span>
                    </span>
                    <span className="block text-xs text-ink-muted">{SOURCE_LABEL[candidate.source] ?? candidate.source}{candidate.credit ? ` · ${candidate.credit}` : ""}</span>
                    {candidate.issues.length > 0 && (
                      <span className="flex flex-wrap gap-1">
                        {candidate.issues.map((issue) => (
                          <Badge key={issue} tone="warning">{issue}</Badge>
                        ))}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      )}

      {draft.url && (
        <Card className="space-y-4 p-4">
          <div className="flex flex-wrap items-start gap-5">
            <FocalFrame url={draft.url} focal={draft.focal} onChange={(focal) => setDraft({ ...draft, focal })} />
            <CropPreview url={draft.url} focal={draft.focal} zoom={draft.zoom} label="Хуудсанд (9:16)" />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Slider label="Хэвтээ байрлал" value={draft.focal.x} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(x) => setDraft({ ...draft, focal: { ...draft.focal, x } })} />
            <Slider label="Босоо байрлал" value={draft.focal.y} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(y) => setDraft({ ...draft, focal: { ...draft.focal, y } })} />
            <Slider label="Томруулалт" value={draft.zoom} min={ZOOM_MIN} max={ZOOM_MAX} step={0.05} format={(v) => `${v.toFixed(2)}×`} onChange={(zoom) => setDraft({ ...draft, zoom })} />
          </div>
        </Card>
      )}

      <Input
        label="Хэвлэгдэх гарчиг (заавал биш)"
        hint={`Зөвхөн каталогт харагдах богино гарчиг, ${TITLE_MAX} тэмдэгтээс ихгүй. Аяллын жинхэнэ нэр, үнэ, огноо өөрчлөгдөхгүй.`}
        error={titleTooLong ? `${TITLE_MAX} тэмдэгтээс урт байж болохгүй.` : undefined}
        value={draft.title}
        maxLength={TITLE_MAX + 20}
        placeholder="Автомат гарчиг ашиглана"
        onChange={(event) => setDraft({ ...draft, title: event.target.value })}
      />

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface p-3">
        <p className="text-sm text-ink-muted" role="status">
          {dirty ? "Хадгалаагүй өөрчлөлт байна." : data.chosen ? "Гараар сонгосон зураг хадгалагдсан." : "Автомат зураг ашиглаж байна."}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={onClear} disabled={!data.chosen || saving}>Автомат руу буцаах</Button>
          <Button variant="secondary" onClick={onReset} disabled={!dirty || saving}>Буцаах</Button>
          <Button onClick={onSave} disabled={!dirty || titleTooLong || saving} loading={saving}>Хадгалах</Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Hero photo + printed title of ONE trip. Choose a photo from the trip's own candidates (real size, score, issues),
 * set what stays in view and how far to zoom, optionally override the display title (<= 80 characters, display only).
 * Nothing here touches the trip's price, dates or title of record. Nothing is stored until staff press «Хадгалах».
 */
export function HeroEditor({ admin, tripId, onSaved }: { admin: CatalogueAdmin; tripId: string; onSaved: () => void }) {
  const toast = useToast();
  const { api } = admin;
  const [data, setData] = useState<CataloguePhotosResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<HeroDraft | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    api.photos(tripId).then(
      (response) => {
        if (!live) return;
        setData(response);
        setDraft(draftOf(response.chosen, response.titleOverride, response.candidates[0]?.url ?? null));
      },
      (err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : "Зургийн жагсаалтыг ачаалж чадсангүй.");
      },
    );
    return () => {
      live = false;
    };
  }, [api, tripId]);

  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!data || !draft) return <p role="status" className="py-8 text-center text-sm text-ink-muted">Зураг ачаалж байна…</p>;

  const heroDirty = heroChanged(draft, data.chosen, data.candidates[0]?.url ?? null);
  const titleDirty = titleChanged(draft, data.titleOverride);
  const dirty = heroDirty || titleDirty;
  const titleTooLong = draft.title.trim().length > TITLE_MAX;

  async function save(clearHero = false) {
    if (!draft || !data) return;
    setSaving(true);
    try {
      const result = await api.savePhoto({
        tripId,
        ...(clearHero ? { hero: null } : heroDirty && draft.url ? { hero: { url: draft.url, focal: draft.focal, zoom: draft.zoom } } : {}),
        ...(titleDirty ? { titleOverride: draft.title.trim() === "" ? null : draft.title.trim() } : {}),
        expectedUpdatedAt: admin.state?.config.updatedAt ?? null,
      });
      toast.success(clearHero ? "Автомат зураг руу буцлаа." : "Зураг, гарчгийг хадгаллаа.");
      setData({ ...data, chosen: result.chosen, titleOverride: result.titleOverride });
      setDraft(draftOf(result.chosen, result.titleOverride, data.candidates[0]?.url ?? null));
      await admin.reload();
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Хадгалж чадсангүй.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <HeroEditorForm
      tripId={tripId}
      data={data}
      draft={draft}
      onDraft={setDraft}
      saving={saving}
      dirty={dirty}
      titleTooLong={titleTooLong}
      onSave={() => void save()}
      onClear={() => void save(true)}
      onReset={() => setDraft(draftOf(data.chosen, data.titleOverride, data.candidates[0]?.url ?? null))}
    />
  );
}
