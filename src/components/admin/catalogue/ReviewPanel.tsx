import { useEffect, useState } from "react";
import { Alert, Badge, Button, Card, EmptyState, Icons } from "@/components/ui";
import { SectionHeading } from "../AdminShared";
import type { CatalogueEdition } from "@/lib/catalogue/types";
import type { CatalogueReviewRow } from "@/lib/catalogue/admin/types";
import type { CatalogueAdmin } from "./useCatalogueAdmin";
import { EditionPicker, HeroQualityChip, SeverityChip, WARNING_HELP, WarningChip, formatMnt } from "./shared";

function PhotoCell({ row }: { row: CatalogueReviewRow }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex items-start gap-2">
      {row.photo && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={row.photo.url}
          alt={`${row.title}: ${row.photoSourceLabel}`}
          loading="lazy"
          referrerPolicy="no-referrer"
          width={72}
          height={48}
          onError={() => setFailed(true)}
          className="h-12 w-[72px] shrink-0 rounded-md border border-line bg-surface-sunken object-cover"
        />
      ) : (
        <span className="flex h-12 w-[72px] shrink-0 items-center justify-center rounded-md border border-dashed border-line-strong bg-surface-sunken text-[10px] text-ink-muted">
          {row.photo ? "ачаалагдсангүй" : "зураггүй"}
        </span>
      )}
      <span className="text-xs text-ink-muted">
        <HeroQualityChip quality={row.heroQuality} className="mb-1" />
        <span className="block">{row.photoSourceLabel}{row.heroChosen ? " · гараар сонгосон" : ""}</span>
        {row.photo?.width && row.photo.height ? <span className="block tabular-nums">{row.photo.width}×{row.photo.height}</span> : null}
        {row.heroReason && <span className="mt-0.5 block max-w-[220px] text-warning">{row.heroReason}</span>}
      </span>
    </div>
  );
}

function Row({ row }: { row: CatalogueReviewRow }) {
  return (
    <tr className={row.severity === "blocking" ? "bg-danger-soft/40" : undefined}>
      <td className="px-4 py-3 align-top">
        {row.code ? <Badge tone="brand">{row.code}</Badge> : <span className="text-xs text-ink-muted">—</span>}
      </td>
      <td className="min-w-[180px] px-3 py-3 align-top">
        <span className="text-sm font-semibold text-ink">{row.title}</span>
        {(row.titleOverride ?? row.editorialTitle) && (row.titleOverride ?? row.editorialTitle) !== row.title && (
          <span className="block text-xs text-ink">Хэвлэгдэх гарчиг: {row.titleOverride ?? row.editorialTitle}{row.titleOverride ? " (гараар)" : ""}</span>
        )}
        <span className="block text-xs text-ink-muted">
          {[row.durationText, row.transportLabel, row.groupLabel].filter(Boolean).join(" · ")}
        </span>
        {!row.eligible && <span className="mt-1 block text-xs text-warning">Тохирохгүй: {row.eligibilityReason}</span>}
      </td>
      <td className="min-w-[210px] px-3 py-3 align-top">
        <span className="text-sm font-semibold tabular-nums text-ink">{row.priceDisplay ?? "—"}</span>
        {row.priceAmountMnt !== null && <span className="block text-xs tabular-nums text-ink-muted">{formatMnt(row.priceAmountMnt)}</span>}
        <span className="block text-xs text-ink-muted">
          Огноо: {row.priceDate ?? row.nextDeparture ?? "заагаагүй"}
          {row.departureCount > 1 ? ` (+${row.departureCount - 1})` : ""}
        </span>
        <span className="block text-xs text-ink-muted">{row.priceSourceLabel}</span>
      </td>
      <td className="px-3 py-3 align-top"><PhotoCell row={row} /></td>
      <td className="min-w-[240px] px-3 py-3 align-top">
        {row.warnings.length === 0 ? (
          <span className="text-xs text-ink-muted">Анхааруулга алга</span>
        ) : (
          <ul className="space-y-1.5">
            {row.warnings.map((warning, index) => (
              <li key={`${warning.code}-${index}`} className="flex items-start gap-2 text-xs text-ink">
                <SeverityChip severity={warning.severity} className="shrink-0" />
                <span>
                  <WarningChip code={warning.code} /> {warning.message}
                  {WARNING_HELP[warning.code] && <span className="mt-0.5 block text-ink-muted">{WARNING_HELP[warning.code]?.help}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </td>
      <td className="px-3 py-3 align-top"><SeverityChip severity={row.eligible ? row.severity : "info"} /></td>
    </tr>
  );
}

/** Per-trip review: the exact price and date that would print, where they came from, the photo, and every warning. */
export function ReviewPanel({ admin }: { admin: CatalogueAdmin }) {
  const { reviews, reviewLoading, reviewError, loadReview } = admin;
  const [edition, setEdition] = useState<CatalogueEdition>("quick");
  const [scope, setScope] = useState<"printed" | "eligible" | "all">("printed");
  const [onlyFlagged, setOnlyFlagged] = useState(false);

  useEffect(() => {
    void loadReview(edition);
  }, [edition, loadReview]);

  const review = reviews[edition];
  const rows = (review?.rows ?? []).filter((row) => {
    if (scope === "printed" && !row.selected) return false;
    if (scope === "eligible" && !row.eligible) return false;
    if (onlyFlagged && row.severity !== "blocking" && row.severity !== "warning") return false;
    return true;
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <EditionPicker legend="Каталогийн төрөл" name="review-edition" value={edition} onChange={setEdition} editions={["quick", "complete", "preview"]} />
        <Button variant="secondary" size="sm" onClick={() => void loadReview(edition)} loading={reviewLoading === edition}>
          <Icons.refresh size={14} />
          Дахин ачаалах
        </Button>
      </div>
      <SectionHeading
        title="Аяллын шалгалт"
        description="Үнэ, огноо, зураг бүгд аяллын сангаас одоо уншигдсан утга. PDF яг эдгээрийг хэвлэнэ; энд юу ч хадгалагдахгүй."
      />
      {reviewError && <Alert tone="danger">{reviewError}</Alert>}
      {review && (
        <div className="flex flex-wrap items-center gap-2" aria-live="polite">
          <Badge tone="neutral">{review.counts.active} идэвхтэй</Badge>
          <Badge tone="success">{review.counts.eligible} тохирох</Badge>
          <Badge tone={review.counts.blocking ? "danger" : "neutral"}>{review.counts.blocking} хориглосон</Badge>
          <Badge tone={review.counts.warning ? "warning" : "neutral"}>{review.counts.warning} анхааруулга</Badge>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <fieldset className="flex flex-wrap items-center gap-3">
          <legend className="sr-only">Харуулах аялал</legend>
          {([
            ["printed", "Хэвлэгдэх"],
            ["eligible", "Бүх тохирох"],
            ["all", "Бүх идэвхтэй"],
          ] as const).map(([key, label]) => (
            <label key={key} className="flex min-h-9 items-center gap-2 text-ink">
              <input type="radio" name="review-scope" checked={scope === key} onChange={() => setScope(key)} className="h-4 w-4" />
              {label}
            </label>
          ))}
        </fieldset>
        <label className="flex min-h-9 items-center gap-2 text-ink">
          <input type="checkbox" checked={onlyFlagged} onChange={(event) => setOnlyFlagged(event.target.checked)} className="h-4 w-4" />
          Зөвхөн анхааруулгатай
        </label>
      </div>

      {reviewLoading === edition && !review ? (
        <p role="status" className="py-10 text-center text-sm text-ink-muted">Аялал шалгаж байна…</p>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Icons.trips size={20} />}
          title={scope === "printed" ? "Энэ каталогт хэвлэгдэх аялал алга" : "Харуулах аялал алга"}
          description={scope === "printed" && edition !== "complete" ? "«Сонголт» хэсгээс аялал сонгоно уу." : undefined}
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto" role="region" aria-label="Аяллын шалгалтын хүснэгт" tabIndex={0}>
            <table className="w-full min-w-[960px] text-left">
              <caption className="sr-only">Аялал бүрийн үнэ, огноо, зураг, анхааруулга</caption>
              <thead className="bg-surface-sunken text-[11px] uppercase tracking-[0.06em] text-ink-muted">
                <tr>
                  <th scope="col" className="px-4 py-2.5">Код</th>
                  <th scope="col" className="px-3 py-2.5">Аялал</th>
                  <th scope="col" className="px-3 py-2.5">Үнэ ба огноо</th>
                  <th scope="col" className="px-3 py-2.5">Зураг ба чанар</th>
                  <th scope="col" className="px-3 py-2.5">Анхааруулга</th>
                  <th scope="col" className="px-3 py-2.5">Төлөв</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((row) => (
                  <Row key={row.tripId} row={row} />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
