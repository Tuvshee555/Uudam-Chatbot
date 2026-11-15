import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Alert, Button, Icons, Select, cx } from "@/components/ui";
import type { CatalogueVersionView } from "@/lib/catalogue/admin/types";
import { pageImageUrl } from "./api";

/** CSS widths of common phones: the preview shows the stored page image at the width a recipient sees it. */
const PHONE_WIDTHS = [
  { width: 320, label: "Жижиг утас · 320 px" },
  { width: 360, label: "Android · 360 px" },
  { width: 390, label: "iPhone · 390 px" },
  { width: 430, label: "Том утас · 430 px" },
] as const;

/**
 * The real pages of a stored version (mount it with key={version.id}: a new version starts at page 1): the JPEGs captured from the same browser session that
 * produced the PDF. Previous / next, a page slider, a thumbnail strip and the phone width are all
 * working controls; nothing here is decorative.
 */
export function PagePreview({ version }: { version: CatalogueVersionView }) {
  const pageCount = Math.max(1, version.pageCount);
  const [page, setPage] = useState(1);
  const [width, setWidth] = useState<number>(390);
  const [failedPage, setFailedPage] = useState<number | null>(null);
  const activeThumb = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    activeThumb.current?.scrollIntoView?.({ block: "nearest", inline: "center" });
  }, [page]);

  const go = (next: number) => {
    setFailedPage(null);
    setPage(Math.min(pageCount, Math.max(1, next)));
  };

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowRight" || event.key === "PageDown") {
      event.preventDefault();
      go(page + 1);
    } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
      event.preventDefault();
      go(page - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      go(1);
    } else if (event.key === "End") {
      event.preventDefault();
      go(pageCount);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[200px]">
          <Select label="Утасны өргөн" value={String(width)} onChange={(event) => setWidth(Number(event.target.value))}>
            {PHONE_WIDTHS.map((option) => (
              <option key={option.width} value={option.width}>{option.label}</option>
            ))}
          </Select>
        </div>
        <p className="pb-2 text-xs text-ink-muted" aria-live="polite">Хуудас {page} / {pageCount}</p>
      </div>

      <div
        role="group"
        aria-roledescription="хуудас үзэгч"
        aria-label={`${version.fileName}: ${pageCount} хуудас. Сум товчоор хуудас солино.`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="rounded-2xl bg-surface-sunken p-4 outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        <div className="flex items-center justify-center gap-2 sm:gap-4">
          <Button variant="secondary" size="sm" onClick={() => go(page - 1)} disabled={page <= 1} aria-label="Өмнөх хуудас">
            <Icons.chevronLeft size={16} />
          </Button>
          <div
            className="overflow-hidden rounded-[28px] border-[6px] border-ink bg-surface shadow-card"
            style={{ width: `min(${width}px, calc(100% - 96px))`, maxWidth: width }}
          >
            {failedPage === page ? (
              <div className="flex aspect-[9/16] items-center justify-center p-6 text-center text-sm text-ink-muted">
                Энэ хуудасны урьдчилан харах зураг хадгалагдаагүй байна. PDF-ийг нээж шалгана уу.
              </div>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={`${version.id}-${page}`}
                src={pageImageUrl(version, page)}
                alt={`${version.fileName}: ${pageCount}-аас ${page}-р хуудас`}
                className="block aspect-[9/16] w-full bg-surface-sunken object-contain"
                onError={() => setFailedPage(page)}
              />
            )}
          </div>
          <Button variant="secondary" size="sm" onClick={() => go(page + 1)} disabled={page >= pageCount} aria-label="Дараагийн хуудас">
            <Icons.chevronRight size={16} />
          </Button>
        </div>
        <div className="mx-auto mt-4 max-w-md">
          <label className="block text-xs font-semibold text-ink-muted" htmlFor={`page-slider-${version.id}`}>Хуудас сонгох</label>
          <input
            id={`page-slider-${version.id}`}
            type="range"
            min={1}
            max={pageCount}
            value={page}
            onChange={(event) => go(Number(event.target.value))}
            className="mt-1 w-full accent-[var(--brand,#2563eb)]"
            aria-valuetext={`${pageCount} хуудасны ${page}-р`}
          />
        </div>
      </div>

      {version.pageCount > 1 && (
        <ul className="flex gap-2 overflow-x-auto pb-2" aria-label="Хуудсууд">
          {Array.from({ length: pageCount }, (_, index) => index + 1).map((n) => (
            <li key={n} className="shrink-0">
              <button
                type="button"
                ref={n === page ? activeThumb : undefined}
                onClick={() => go(n)}
                aria-label={`${n}-р хуудас`}
                aria-current={n === page ? "true" : undefined}
                className={cx(
                  "block overflow-hidden rounded-md border-2 bg-surface-sunken focus-visible:outline-brand",
                  n === page ? "border-brand" : "border-line hover:border-line-strong",
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={pageImageUrl(version, n)} alt="" loading="lazy" width={45} height={80} className="block h-20 w-[45px] object-cover" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Alert tone="info">
        Зураг нь PDF-тэй нэг хөтөч дээр, нэг дор авагдсан. PDF-ийн текст, үсэг, холбоосыг «PDF нээх» товчоор шалгана.
      </Alert>
    </div>
  );
}
