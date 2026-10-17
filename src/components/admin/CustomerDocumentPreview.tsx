/**
 * What a customer sent, shown as itself: the whole photo (click for full screen), a
 * shared reel or link as its cover + title + "open", a video or voice note as a player,
 * any other file as a card with an open button. Instagram reels used to show only a
 * file icon named after the post, and photos sat in a narrow side strip.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Icons, cx } from "@/components/ui";
import type { CustomerDocument } from "@/lib/adminTypes";

type Kind = "image" | "link" | "video" | "audio" | "file";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export function documentKind(doc: CustomerDocument): Kind {
  const mime = (doc.mime_type || "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "text/html") return "link";
  return "file";
}

function fileInfo(doc: CustomerDocument) {
  const file = record(doc.extracted_json?.file);
  const url = doc.stored_url || doc.source_url;
  const name = text(file.name) || decodeURIComponent(url.split("?")[0].split("/").pop() || "") || "Файл";
  return {
    url,
    name,
    preview: text(file.preview_url),
    linkUrl: text(file.link_url) || doc.source_url,
    linkTitle: text(file.link_title),
    reel: text(file.attachment_type) === "ig_reel" || /instagram\.com\/(?:[^/]+\/)?reel\//i.test(text(file.link_url) || doc.source_url),
  };
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const FILE_LABEL: Array<[RegExp, string]> = [
  [/pdf/i, "PDF"],
  [/sheet|excel|xls/i, "Excel"],
  [/word|docx?/i, "Word"],
  [/presentation|ppt/i, "PowerPoint"],
  [/zip|rar|7z/i, "Архив"],
];

export function DocumentPreview({ doc, onZoom }: { doc: CustomerDocument; onZoom: (url: string) => void }) {
  const kind = documentKind(doc);
  const info = fileInfo(doc);
  const [broken, setBroken] = useState(false);
  const box = "relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden bg-surface-sunken";

  if (kind === "image" && !broken) {
    return (
      <button type="button" onClick={() => onZoom(info.url)} className={cx(box, "group cursor-zoom-in")} title="Бүтнээр харах">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={info.url} alt="" loading="lazy" onError={() => setBroken(true)} className="h-full w-full object-contain" />
        <span className="absolute bottom-2 right-2 flex items-center gap-1 rounded-full bg-black/60 px-2 py-1 text-[11px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">
          <Icons.search size={12} /> Томруулах
        </span>
      </button>
    );
  }

  if (kind === "link") {
    return (
      <a href={info.linkUrl} target="_blank" rel="noopener noreferrer" className="group block">
        <div className={box}>
          {info.preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={info.preview} alt="" loading="lazy" className="h-full w-full object-cover" />
          ) : (
            <Icons.image size={34} className="text-ink-subtle" />
          )}
          {info.reel && (
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/55 text-white transition-transform group-hover:scale-110">
                <Icons.play size={20} />
              </span>
            </span>
          )}
        </div>
        <div className="border-b border-line px-3 py-2">
          <p className="line-clamp-2 text-xs font-medium text-ink">{info.linkTitle || info.linkUrl}</p>
          <p className="mt-0.5 flex items-center gap-1 text-[11px] font-semibold text-brand">
            {info.reel ? "Reel үзэх" : "Холбоос нээх"} · {host(info.linkUrl)} →
          </p>
        </div>
      </a>
    );
  }

  if (kind === "video") {
    return (
      <div className={cx(box, "bg-black")}>
        <video src={info.url} controls preload="metadata" className="h-full w-full object-contain" />
      </div>
    );
  }

  if (kind === "audio") {
    return (
      <div className="flex flex-col gap-2 bg-surface-sunken px-4 py-5">
        <span className="flex items-center gap-2 text-sm font-semibold text-ink">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-soft text-brand">🎤</span>
          Дуут мессеж
        </span>
        <audio src={info.url} controls preload="metadata" className="w-full" />
      </div>
    );
  }

  const label = FILE_LABEL.find(([pattern]) => pattern.test(`${doc.mime_type} ${info.name}`))?.[1] || "Файл";
  return (
    <a href={info.url} target="_blank" rel="noopener noreferrer" className={cx(box, "group flex-col gap-2 px-4 text-center")}>
      <span className="flex h-14 w-14 items-center justify-center rounded-xl bg-brand-soft text-brand">
        <Icons.file size={26} />
      </span>
      <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] font-semibold text-ink-muted">{label}</span>
      <span className="line-clamp-2 max-w-full break-all text-xs font-medium text-ink">{info.name}</span>
      <span className="text-[11px] font-semibold text-brand group-hover:underline">Нээх / татах →</span>
    </a>
  );
}

/** Full-screen photo viewer: Esc or a click outside closes it. */
export function PhotoLightbox({ url, onClose }: { url: string | null; onClose: () => void }) {
  useEffect(() => {
    if (!url) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [url, onClose]);
  if (!url || typeof document === "undefined") return null;
  // Rendered on <body>: inside the admin layout an animated parent trapped "fixed" in the content column.
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 p-4" role="dialog" aria-modal="true" aria-label="Зураг" onClick={onClose}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt="" className="max-h-full max-w-full rounded-md object-contain shadow-2xl" onClick={(event) => event.stopPropagation()} />
      <div className="absolute right-4 top-4 flex gap-2">
        <a href={url} target="_blank" rel="noopener noreferrer" onClick={(event) => event.stopPropagation()} className="flex h-10 items-center gap-1.5 rounded-full bg-white/15 px-4 text-sm font-medium text-white hover:bg-white/25">
          <Icons.download size={16} /> Эх зураг
        </a>
        <button type="button" onClick={onClose} aria-label="Хаах" className="flex h-10 w-10 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25">
          <Icons.close size={18} />
        </button>
      </div>
    </div>,
    document.body,
  );
}
