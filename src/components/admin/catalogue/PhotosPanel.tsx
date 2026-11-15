import { useEffect, useMemo, useState } from "react";
import { Alert, Badge, Button, Card, EmptyState, Icons, cx } from "@/components/ui";
import { SectionHeading } from "../AdminShared";
import type { CatalogueEdition } from "@/lib/catalogue/types";
import type { CatalogueReviewRow } from "@/lib/catalogue/admin/types";
import type { CatalogueAdmin } from "./useCatalogueAdmin";
import { CoverPhotoChooser } from "./CoverPhotoChooser";
import { HeroEditor } from "./HeroEditor";
import { needsNewPhoto } from "./heroCrop";
import { EditionPicker, HeroQualityChip } from "./shared";

function Thumb({ row }: { row: CatalogueReviewRow }) {
  const [failed, setFailed] = useState(false);
  return row.photo && !failed ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={row.photo.url}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="h-14 w-10 shrink-0 rounded-md border border-line bg-surface-sunken object-cover"
    />
  ) : (
    <span className="flex h-14 w-10 shrink-0 items-center justify-center rounded-md border border-dashed border-line-strong bg-surface-sunken text-[9px] text-ink-muted">зураггүй</span>
  );
}

/**
 * «Зураг ба гарчиг»: which trips need a better hero photo, and the per-trip picker. The list is the trips the
 * chosen edition prints; weak or missing heroes are listed first with the reason.
 */
export function PhotosPanel({ admin }: { admin: CatalogueAdmin }) {
  const { reviews, reviewLoading, reviewError, loadReview } = admin;
  const [edition, setEdition] = useState<CatalogueEdition>("quick");
  const [onlyWeak, setOnlyWeak] = useState(false);
  const [tripId, setTripId] = useState<string | null>(null);

  useEffect(() => {
    void loadReview(edition);
  }, [edition, loadReview]);

  const review = reviews[edition];
  const printed = useMemo(() => (review?.rows ?? []).filter((row) => row.eligible && (edition === "complete" ? !row.excluded : row.selected)), [review, edition]);
  const flagged = printed.filter((row) => needsNewPhoto(row.heroQuality));
  const shown = onlyWeak ? flagged : printed;
  const open = printed.find((row) => row.tripId === tripId) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <EditionPicker legend="Каталогийн төрөл" name="photos-edition" value={edition} onChange={(next) => { setEdition(next); setTripId(null); }} editions={["quick", "complete", "preview"]} />
        <Button variant="secondary" size="sm" onClick={() => void loadReview(edition)} loading={reviewLoading === edition}>
          <Icons.refresh size={14} />
          Дахин ачаалах
        </Button>
      </div>
      <SectionHeading
        title="Зураг ба гарчиг"
        description="Аялал бүрийн гол зургийг тухайн аяллын өөрийн зургуудаас сонгоно. Зөвхөн зураг, хэвлэгдэх гарчиг хадгалагдана: үнэ, огноо, аяллын нэр өөрчлөгдөхгүй."
      />
      <CoverPhotoChooser admin={admin} />
      {reviewError && <Alert tone="danger">{reviewError}</Alert>}

      {flagged.length > 0 && (
        <Card className="space-y-3 border-warning/40 p-4">
          <h3 className="text-base font-semibold text-ink">Хуучин/сул зураг — солих шаардлагатай ({flagged.length})</h3>
          <ul className="divide-y divide-line" aria-label="Солих шаардлагатай зургууд">
            {flagged.map((row) => (
              <li key={row.tripId} className="flex flex-wrap items-center gap-3 py-2.5">
                <Thumb row={row} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-ink">{row.code ? `${row.code} · ` : ""}{row.title}</span>
                  <span className="block text-xs text-ink-muted">{row.heroReason ?? "Зургийг солих шаардлагатай."}</span>
                </span>
                <HeroQualityChip quality={row.heroQuality} />
                <Button size="sm" variant="secondary" onClick={() => setTripId(row.tripId)} aria-label={`${row.title}: зураг солих`}>Зураг солих</Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <Card className="p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-base font-semibold text-ink">Хэвлэгдэх аяллууд ({printed.length})</h3>
            <label className="flex min-h-9 items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={onlyWeak} onChange={(event) => setOnlyWeak(event.target.checked)} className="h-4 w-4" />
              Зөвхөн солих
            </label>
          </div>
          {reviewLoading === edition && !review ? (
            <p role="status" className="py-8 text-center text-sm text-ink-muted">Аялал ачаалж байна…</p>
          ) : shown.length === 0 ? (
            <EmptyState
              title={printed.length === 0 ? "Энэ каталогт хэвлэгдэх аялал алга" : "Солих шаардлагатай зураг алга"}
              description={printed.length === 0 && edition !== "complete" ? "«Сонголт» хэсгээс аялал сонгоно уу." : undefined}
            />
          ) : (
            <ul className="max-h-[640px] divide-y divide-line overflow-y-auto" aria-label="Зураг сонгох аяллууд">
              {shown.map((row) => (
                <li key={row.tripId}>
                  <button
                    type="button"
                    onClick={() => setTripId(row.tripId)}
                    aria-pressed={tripId === row.tripId}
                    className={cx("flex w-full items-center gap-3 px-1 py-2.5 text-left transition-colors hover:bg-surface-sunken focus-visible:outline-brand", tripId === row.tripId && "bg-brand-soft")}
                  >
                    <Thumb row={row} />
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-sm font-semibold text-ink">{row.code ? `${row.code} · ` : ""}{row.titleOverride ?? row.editorialTitle ?? row.title}</span>
                      {(row.titleOverride ?? row.editorialTitle) && (row.titleOverride ?? row.editorialTitle) !== row.title && <span className="block text-xs text-ink-muted">{row.title}</span>}
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <HeroQualityChip quality={row.heroQuality} />
                      {row.heroChosen && <Badge tone="brand">Гараар сонгосон</Badge>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="min-w-0">
          {open ? (
            <Card className="space-y-4 p-4">
              <div>
                <h3 className="text-base font-semibold text-ink">{open.code ? `${open.code} · ` : ""}{open.title}</h3>
                {open.heroReason && <p className="mt-1 text-sm text-warning">{open.heroReason}</p>}
              </div>
              <HeroEditor key={open.tripId} admin={admin} tripId={open.tripId} onSaved={() => void loadReview(edition)} />
            </Card>
          ) : (
            <EmptyState icon={<Icons.trips size={20} />} title="Аялал сонгоно уу" description="Зүүн талаас аялал сонгоод зургаа, хэвлэгдэх гарчгаа тохируулна." />
          )}
        </div>
      </div>
    </div>
  );
}
