import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { Badge, cx } from "@/components/ui";
import type { CatalogueEdition, CataloguePhotoQuality, CatalogueVersionStatus, CatalogueWarningCode } from "@/lib/catalogue/types";
import type { CatalogueFreshnessView, CatalogueReviewRow } from "@/lib/catalogue/admin/types";

export const EDITION_LABEL: Record<CatalogueEdition, string> = {
  quick: "Хурдан каталог",
  complete: "Бүрэн каталог",
  preview: "Дээж (урьдчилан харах)",
};

export const EDITION_HINT: Record<CatalogueEdition, string> = {
  quick: "Байгууллагад очдог үндсэн PDF: сонгосон 8–12 аялал.",
  complete: "Тохирох бүх идэвхтэй аялал, бүлэглэсэн.",
  preview: "Дизайныг шалгах 1–4 аялалтай дээж. Хэрэглэгчид илгээгдэхгүй.",
};

const STATUS_LABEL: Record<CatalogueVersionStatus, string> = {
  draft: "Ноорог",
  published: "Нийтлэгдсэн",
  superseded: "Хуучирсан",
};

export function VersionStatusBadge({ status }: { status: CatalogueVersionStatus }) {
  const tone = status === "published" ? "success" : status === "draft" ? "brand" : "neutral";
  return <Badge tone={tone} dot>{STATUS_LABEL[status]}</Badge>;
}

const SEVERITY_LABEL: Record<CatalogueReviewRow["severity"], string> = {
  blocking: "Хориглосон",
  warning: "Анхааруулга",
  info: "Мэдээлэл",
  ok: "Хэвийн",
};

export function SeverityChip({ severity, className }: { severity: CatalogueReviewRow["severity"]; className?: string }) {
  const tone = severity === "blocking" ? "danger" : severity === "warning" ? "warning" : severity === "ok" ? "success" : "neutral";
  return <Badge tone={tone} className={className}>{SEVERITY_LABEL[severity]}</Badge>;
}

/** Plain-language chip + explanation for the warnings that need staff to look at the trip itself. */
export const WARNING_HELP: Partial<Record<CatalogueWarningCode, { label: string; help: string }>> = {
  transport_conflict: {
    label: "Тээвэр зөрсөн",
    help: "Гарчиг эсвэл програм нэг тээврийг, бүртгэл өөр тээврийг заасан байна (жишээ нь гарчиг «дамжин нислэг», бүртгэл «шууд нислэг») — аялал засварлагч дээр шалгана уу. Зөрсөн тээврийг PDF-д хэвлэхгүй.",
  },
  duration_conflict: {
    label: "Хугацаа зөрсөн",
    help: "Гарчиг эсвэл програмын өдрийн тоо бүртгэлийн хоногтой таарахгүй байна — аялал засварлагч дээр шалгана уу.",
  },
  price_conflict: {
    label: "Үнэ зөрсөн",
    help: "Тайлбар дахь үнэ огнооны үнээс өөр байна. Каталог огнооны үнийг хэвлэнэ — аялал засварлагч дээр тайлбарыг засна уу.",
  },
};

export function WarningChip({ code }: { code: CatalogueWarningCode }) {
  const known = WARNING_HELP[code];
  return known ? <Badge tone="warning">{known.label}</Badge> : null;
}

export function HeroQualityChip({ quality, className }: { quality: CataloguePhotoQuality; className?: string }) {
  const tone = quality === "missing" ? "danger" : quality === "weak" ? "warning" : "success";
  const label = quality === "excellent" ? "Маш сайн зураг" : quality === "good" ? "Сайн зураг" : quality === "weak" ? "Сул зураг" : "Зураггүй";
  return <Badge tone={tone} className={className}>{label}</Badge>;
}

export function FreshnessBadge({ freshness }: { freshness: CatalogueFreshnessView }) {
  switch (freshness.status) {
    case "fresh":
      return <Badge tone="success" dot>Шинэ</Badge>;
    case "stale":
      return <Badge tone="danger" dot>Хугацаа хэтэрсэн</Badge>;
    case "unknown":
      return <Badge tone="warning" dot>Шалгаж чадсангүй</Badge>;
    default:
      return <Badge tone="neutral">Нийтлээгүй</Badge>;
  }
}

/** "2026.11.06 14:05" in the browser's clock; the admin is used from Ulaanbaatar. */
export function formatStamp(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}.${p(date.getMonth() + 1)}.${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

export function formatMnt(amount: number | null): string {
  return amount === null ? "—" : `${amount.toLocaleString("en-US")}₮`;
}

export function TripLine({ row }: { row: CatalogueReviewRow }) {
  return (
    <span className="min-w-0">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {row.code ? <Badge tone="brand">{row.code}</Badge> : <Badge tone="neutral">код алга</Badge>}
        <span className="break-words text-sm font-semibold text-ink">{row.title}</span>
      </span>
      <span className="mt-0.5 block text-xs text-ink-muted">
        {[row.durationText, row.priceDisplay, row.dateLabel].filter(Boolean).join(" · ") || "—"}
      </span>
    </span>
  );
}

export type SubTab<T extends string> = { key: T; label: string; badge?: ReactNode };

/** WAI-ARIA tabs: arrow keys, Home and End move between tabs; the panel is labelled by its tab. */
export function SubTabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  idPrefix,
}: {
  tabs: Array<SubTab<T>>;
  value: T;
  onChange: (next: T) => void;
  label: string;
  idPrefix: string;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex((tab) => tab.key === value);
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    onChange(tabs[next].key);
    refs.current[tabs[next].key]?.focus();
  }
  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="-mx-1 flex gap-1 overflow-x-auto border-b border-line px-1"
    >
      {tabs.map((tab) => {
        const active = tab.key === value;
        return (
          <button
            key={tab.key}
            ref={(node) => {
              refs.current[tab.key] = node;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab.key}`}
            aria-selected={active}
            aria-controls={`${idPrefix}-panel-${tab.key}`}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(tab.key)}
            className={cx(
              "-mb-px inline-flex min-h-10 shrink-0 items-center gap-2 border-b-2 px-3 py-2 text-[13px] font-semibold transition-colors focus-visible:outline-brand",
              active ? "border-brand text-brand" : "border-transparent text-ink-muted hover:text-ink",
            )}
          >
            {tab.label}
            {tab.badge}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ idPrefix, tabKey, children }: { idPrefix: string; tabKey: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`${idPrefix}-panel-${tabKey}`} aria-labelledby={`${idPrefix}-tab-${tabKey}`} tabIndex={0} className="space-y-5 outline-none">
      {children}
    </div>
  );
}

/** Native radio group styled as a segmented control: keyboard and screen-reader behaviour come for free. */
export function EditionPicker({
  value,
  onChange,
  editions,
  legend,
  name,
}: {
  value: CatalogueEdition;
  onChange: (edition: CatalogueEdition) => void;
  editions: CatalogueEdition[];
  legend: string;
  name: string;
}) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-xs font-semibold text-ink-muted">{legend}</legend>
      <div className="inline-flex flex-wrap gap-1 rounded-lg bg-surface-sunken p-1">
        {editions.map((edition) => (
          <label
            key={edition}
            className={cx(
              "cursor-pointer rounded-md px-3 py-1.5 text-[13px] font-semibold transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-brand",
              value === edition ? "bg-surface text-brand shadow-card" : "text-ink-muted hover:text-ink",
            )}
          >
            <input
              type="radio"
              name={name}
              value={edition}
              checked={value === edition}
              onChange={() => onChange(edition)}
              className="sr-only"
            />
            {EDITION_LABEL[edition]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
