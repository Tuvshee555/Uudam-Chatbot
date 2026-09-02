"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import * as htmlToImage from "html-to-image";
import { upload as uploadToBlob } from "@vercel/blob/client";
import Poster from "./Poster";
import AttachToTripModal from "./AttachToTripModal";
import { createDefaultTrip } from "@/lib/poster/defaultTrip";
import { Badge, Button, Card, Icons, Input, Select, Spinner, cx } from "@/components/ui";
import { TabHeader } from "@/components/admin/AdminShared";
import type { PosterBulkPlan, PosterBulkPlanItem } from "@/lib/poster/bulkPlan";

/* ------------------------------------------------------------------ *
 * Trip / poster data shape — mirrors TRIP_SCHEMA in src/lib/poster/openai.js
 * (the OpenAI structured-output schema) plus the extra editor-only fields
 * normalizeTripData() fills in (show_meals, photo_caption defaults, etc).
 * This is the single shared shape for PosterTab, Poster, and
 * AttachToTripModal — the untyped JS this feature used to live in let all
 * three drift independently, so this type is now the contract between them.
 * ------------------------------------------------------------------ */

export type PosterMeals = {
  breakfast?: boolean;
  lunch?: boolean;
  dinner?: boolean;
};

export type PosterDay = {
  day: number;
  route: string;
  distance_km?: number;
  summary: string;
  activities?: string[];
  meals?: PosterMeals;
  show_meals?: boolean;
  hotel?: string | null;
  flight?: string | null;
  bonus?: string[];
  photo?: string | null;
  photo_caption?: string;
};

export type PosterDeparture = {
  date?: string;
};

export type PosterPriceRow = {
  dates: string;
  cells: string[];
};

export type PosterPriceTable = {
  columns: string[];
  rows: PosterPriceRow[];
  note?: string;
};

export type PosterFlights = {
  outbound: string;
  return: string;
} | null;

export type PosterContacts = {
  phones?: string[];
  email?: string;
  address?: string;
};

/** A legacy/alternate price representation some older extracted trips carry. */
export type PosterLegacyPrice = {
  applies_to?: string;
  adult?: string | number;
  child?: string | number;
  child_years?: string;
  currency?: string;
};

export type PosterTrip = {
  agency?: string;
  title: string;
  subtitle?: string;
  duration_days?: number;
  duration_nights?: number;
  hero_image?: string | null;
  flights?: PosterFlights;
  departures?: PosterDeparture[];
  price_table?: PosterPriceTable | null;
  price_note?: string;
  price_desc?: string;
  /** Legacy per-trip prices array, superseded by price_table but still read as a fallback. */
  prices?: PosterLegacyPrice[];
  child_free_note?: string;
  days?: PosterDay[];
  includes?: string[];
  excludes?: string[];
  contacts?: PosterContacts;
};

/** A saved poster's history-list entry, as returned by GET /api/admin/poster/trips. */
export type PosterHistoryItem = {
  id: string;
  title: string;
  source_file: string | null;
  updated_at: string;
};

type HistorySort = "newest" | "oldest" | "title";
type HistoryGroupMode = "date" | "duplicate" | "none";

/** Generic dot-path used by upd()/addItem()/removeItem() to reach into PosterTrip. */
export type PosterPath = Array<string | number>;

export type PosterUpdateFn = (path: PosterPath, value: unknown) => void;
export type PosterAddItemFn = (path: PosterPath, value: unknown) => void;
export type PosterRemoveItemFn = (path: PosterPath, index: number) => void;
export type PosterInsertDayFn = (afterIndex: number) => void;
export type PosterReorderDayFn = (fromIndex: number, toIndex: number) => void;
export type PosterAddPriceRowFn = () => void;
export type PosterAddPriceColFn = () => void;
export type PosterRemovePriceColFn = (columnIndex: number) => void;
export type PosterOnDayPhotoFileFn = (index: number, file: File | null | undefined) => void | Promise<void>;
export type DayPhotoInputRefs = MutableRefObject<Record<number, HTMLInputElement>>;

export type ApiFetch = (url: string, init?: RequestInit) => Promise<Response>;
export type CapturedPosterImage =
  | string
  | {
      dataUrl?: string;
      url?: string;
      filename?: string;
    };

type JsonRecord = Record<string, unknown>;
type PosterBulkRunReport = {
  total: number;
  created: number;
  attached: number;
  skipped: PosterBulkPlanItem[];
  failed: Array<{ title: string; error: string }>;
};
type PosterSyncPhotoPayload = {
  dataUrl?: string;
  url?: string;
  filename: string;
};

const ADMIN_SECRET_STORAGE_KEY = "travel_admin_secret";
const POSTER_WIDTH = 1080;
const MESSENGER_SINGLE_IMAGE_MAX_HEIGHT = 1900;
const MESSENGER_MAX_IMAGE_SLICES = 3;
const PDF_MAX_BYTES = 25 * 1024 * 1024;
const PDF_COMPRESSION_STEPS = [
  { maxWidth: 1800, quality: 0.86 },
  { maxWidth: 1600, quality: 0.82 },
  { maxWidth: 1400, quality: 0.78 },
  { maxWidth: 1200, quality: 0.72 },
  { maxWidth: 1080, quality: 0.66 },
  { maxWidth: 900, quality: 0.58 },
  { maxWidth: 760, quality: 0.52 },
] as const;
const PDF_PAGE_EXTRACTION_LIMIT = 5;
const MAX_UPLOAD_FILES = 10;
const MAX_UPLOAD_SIZE_MB = 100;
const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;
// Vercel's serverless request-body cap is 4.5MB. Direct multipart upload is
// the reliable path (Blob has repeatedly failed us: missing tokens, silent
// hangs), so use as much of that cap as possible — Blob is a last resort for
// the rare genuinely-huge file. 4.4MB leaves ~100KB for multipart framing;
// typical ~4,000KB poster PDFs now go direct instead of detouring via Blob.
const DIRECT_UPLOAD_LIMIT_BYTES = Math.floor(4.4 * 1024 * 1024);
const DIRECT_POSTER_SYNC_BODY_LIMIT_CHARS = Math.floor(3.2 * 1024 * 1024);

function getStoredAdminSecret(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(ADMIN_SECRET_STORAGE_KEY) || "";
}

/** Sets a value at an arbitrary path inside a structured-clone of obj. Path segments are
 * property keys or array indices, matched 1:1 to the PosterTrip shape by the caller. */
function setPath<T>(obj: T, path: PosterPath, value: unknown): T {
  const clone = structuredClone(obj) as Record<string | number, unknown>;
  let o: Record<string | number, unknown> = clone;
  for (let i = 0; i < path.length - 1; i++) {
    o = o[path[i]] as Record<string | number, unknown>;
  }
  o[path[path.length - 1]] = value;
  return clone as T;
}

function resizeImage(file: File, maxW = 1500): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxW / img.width);
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      const ctx = c.getContext("2d");
      if (!ctx) {
        reject(new Error("Canvas 2D context unavailable"));
        return;
      }
      ctx.drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL("image/jpeg", 0.82));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function tableFromPriceNote(note: string | undefined): { priceTable: PosterPriceTable; remainingNote: string } | null {
  const text = String(note || "").replace(/^⚠\s*/, "").trim();
  if (!text) return null;

  const matches = [...text.matchAll(/(\d[\d\s,'’]*\d)\s*₮/g)];
  if (matches.length < 2) return null;

  let cursor = 0;
  const columns: string[] = [];
  const cells: string[] = [];
  let consumedEnd = 0;

  for (const match of matches) {
    const rawLabel = text
      .slice(cursor, match.index)
      .replace(/[—–:;,]+$/g, "")
      .trim();
    const isExplanation = /өрөөнд|ганцаараа|тусгай|нэмж|орох бол/i.test(rawLabel);
    if (isExplanation && columns.length === 0) return null;
    if (isExplanation && columns.length >= 2) break;

    const label = rawLabel || `Үнэ ${columns.length + 1}`;
    const amount = `${match[1].replace(/[’']/g, ",").replace(/\s+/g, "")}₮`;
    const paren = text.slice((match.index ?? 0) + match[0].length).match(/^\s*(\([^)]*\))/);
    const end = (match.index ?? 0) + match[0].length + (paren ? paren[0].length : 0);

    columns.push(paren ? `${label} ${paren[1]}` : label);
    cells.push(amount);
    cursor = end;
    consumedEnd = end;
  }

  if (columns.length < 2) return null;

  return {
    priceTable: {
      columns,
      rows: [{ dates: "Үнэ", cells }],
      note: "",
    },
    remainingNote: text.slice(consumedEnd).replace(/^[\s—–:;,]+/, "").trim(),
  };
}

function normalizeTripData(trip: PosterTrip | null): PosterTrip | null {
  if (!trip) return trip;
  const clone = structuredClone(trip);
  clone.departures = (clone.departures || []).filter((d) => d?.date?.trim());
  clone.includes = (clone.includes || []).filter((x) => String(x || "").trim());
  clone.excludes = (clone.excludes || []).filter((x) => String(x || "").trim());
  clone.days = (clone.days || []).map((day, index) => ({
    ...day,
    day: index + 1,
    summary: day.summary || "",
    activities: (day.activities || []).filter((x) => String(x || "").trim()),
    meals: day.meals || { breakfast: true, lunch: false, dinner: true },
    show_meals: day.show_meals !== false,
    bonus: day.bonus || [],
    photo: day.photo || null,
    photo_caption: day.photo_caption || "",
  }));

  if (!clone.price_table && clone.price_note) {
    const parsedPriceNote = tableFromPriceNote(clone.price_note);
    if (parsedPriceNote) {
      clone.price_table = parsedPriceNote.priceTable;
      clone.price_note = parsedPriceNote.remainingNote;
    }
  }

  if (clone.price_table) {
    const priceTable = clone.price_table;
    priceTable.columns = (priceTable.columns || []).filter((x) => String(x || "").trim());
    const colCount = priceTable.columns.length;

    // Normalize rows: filter empty, pad/clamp cells
    const cleaned = (priceTable.rows || [])
      .filter((r) => {
        const hasDate = String(r?.dates || "").trim();
        const hasCells = (r?.cells || []).some((x) => String(x || "").trim());
        return hasDate || hasCells;
      })
      .map((r) => ({
        ...r,
        cells: Array.from({ length: colCount }, (_, i) => r.cells?.[i] ?? ""),
      }));

    // Merge rows with identical prices — combine their dates into one row
    const merged: PosterPriceRow[] = [];
    for (const row of cleaned) {
      const sig = row.cells.join("||");
      const existing = merged.find((m) => m.cells.join("||") === sig);
      if (existing) {
        // Add this date to the existing row's dates
        const existingDates = existing.dates.split(/[,،、]\s*/);
        const newDate = String(row.dates || "").trim();
        if (newDate && !existingDates.includes(newDate)) {
          existing.dates = [...existingDates, newDate].join(", ");
        }
      } else {
        merged.push({ ...row, dates: String(row.dates || "").trim() });
      }
    }

    priceTable.rows = merged;
  }
  return clone;
}

function normalizeHistoryTitle(title: string | undefined): string {
  return String(title || "Untitled")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function historyDateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Огноогүй";
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (sameDay(date, today)) return "Өнөөдөр";
  if (sameDay(date, yesterday)) return "Өчигдөр";
  return date.toLocaleDateString();
}

export default function PosterTab({ apiFetch }: { apiFetch: ApiFetch }) {
  // apiFetch(url, init) injects the admin secret header (from admin.tsx).
  const fetchJson = async (url: string, init?: RequestInit): Promise<JsonRecord> => {
    const res = await apiFetch(url, init);
    const text = await res.text();
    let json: JsonRecord = {};
    if (text) {
      try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 300) }; }
    }
    if (!res.ok && !json.error) json.error = `HTTP ${res.status}`;
    return json;
  };

  const [trip, setTrip] = useState<PosterTrip | null>(null);
  const [tripId, setTripId] = useState<string | null>(null);
  const [source, setSource] = useState("");
  const [history, setHistory] = useState<PosterHistoryItem[]>([]);
  const [historySearch, setHistorySearch] = useState("");
  const [historySort, setHistorySort] = useState<HistorySort>("newest");
  const [historyGroup, setHistoryGroup] = useState<HistoryGroupMode>("date");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [scale, setScale] = useState(0.6);
  const [totalH, setTotalH] = useState(0);
  const [attachModalOpen, setAttachModalOpen] = useState(false);
  const [bulkReport, setBulkReport] = useState<PosterBulkRunReport | null>(null);

  const page1Ref = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const dayPhotoInputRefs: DayPhotoInputRefs = useRef({});

  const upd: PosterUpdateFn = (path, value) => setTrip((t) => (t ? setPath(t, path, value) : t));

  const historyTitleCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of history) {
      const key = normalizeHistoryTitle(item.title);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }, [history]);

  const visibleHistoryGroups = useMemo(() => {
    const query = historySearch.trim().toLocaleLowerCase();
    const filtered = history.filter((item) => {
      const haystack = `${item.title || ""} ${item.source_file || ""}`.toLocaleLowerCase();
      return !query || haystack.includes(query);
    });

    filtered.sort((a, b) => {
      if (historySort === "oldest") return new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime();
      if (historySort === "title") return String(a.title || "").localeCompare(String(b.title || ""));
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });

    if (historyGroup === "none") return [{ label: "", items: filtered }];

    const groups = new Map<string, PosterHistoryItem[]>();
    for (const item of filtered) {
      const duplicateCount = historyTitleCounts.get(normalizeHistoryTitle(item.title)) || 0;
      let label = historyDateLabel(item.updated_at);
      if (historyGroup === "duplicate") label = duplicateCount > 1 ? "Давхардсан нэртэй" : "Давхардаагүй";
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label)?.push(item);
    }

    return Array.from(groups, ([label, items]) => ({ label, items }));
  }, [history, historyGroup, historySearch, historySort, historyTitleCounts]);

  const currentDuplicateCount = trip
    ? [...historyTitleCounts.entries()].find(([key]) => key === normalizeHistoryTitle(trip.title))?.[1] || 0
    : 0;

  const startTemplate = () => {
    setError("");
    setBusy("");
    setTrip(normalizeTripData(createDefaultTrip() as PosterTrip));
    setTripId(null);
    setSource("Default template");
  };

  /** Walks a PosterPath into a structured-clone of an arbitrary trip-shaped object,
   * returning the array found at that path. Used by addItem/removeItem, which — like
   * the original JS — push/splice generic path-addressed arrays (departures, days,
   * price_table.rows, etc.) rather than one setter per array. */
  function getArrayAtPath(root: Record<string, unknown>, path: PosterPath): unknown[] {
    let o: unknown = root;
    for (const p of path) o = (o as Record<string | number, unknown>)[p];
    return o as unknown[];
  }

  const addItem: PosterAddItemFn = (path, value) =>
    setTrip((t) => {
      if (!t) return t;
      const clone = structuredClone(t) as unknown as Record<string, unknown>;
      getArrayAtPath(clone, path).push(value);
      return normalizeTripData(clone as unknown as PosterTrip);
    });

  const removeItem: PosterRemoveItemFn = (path, idx) =>
    setTrip((t) => {
      if (!t) return t;
      const clone = structuredClone(t) as unknown as Record<string, unknown>;
      getArrayAtPath(clone, path).splice(idx, 1);
      return normalizeTripData(clone as unknown as PosterTrip);
    });

  const addDeparture = () => addItem(["departures"], { date: "Шинэ огноо" });

  const newDayObj = (): PosterDay => ({
    day: 0,
    route: "Шинэ өдөр",
    distance_km: 0,
    summary:
      "Энэ хэсэгт тухайн өдрийн аяллын уур амьсгал, үзэх газар, амрах цаг болон аялагчид юуг мэдрэхийг ойлгомжтой тайлбарлан бичнэ.",
    activities: ["Шинэ үйл ажиллагаа"],
    meals: { breakfast: true, lunch: false, dinner: true },
    show_meals: true,
    hotel: null,
    flight: null,
    bonus: [],
    photo: null,
    photo_caption: "",
  });

  const addDay = () =>
    setTrip((t) => {
      if (!t) return t;
      const clone = structuredClone(t);
      clone.days ||= [];
      clone.days.push(newDayObj());
      return normalizeTripData(clone);
    });

  const insertDay: PosterInsertDayFn = (afterIndex) =>
    setTrip((t) => {
      if (!t) return t;
      const clone = structuredClone(t);
      clone.days ||= [];
      clone.days.splice(afterIndex + 1, 0, newDayObj());
      return normalizeTripData(clone);
    });

  const reorderDay: PosterReorderDayFn = (fromIdx, toIdx) =>
    setTrip((t) => {
      if (!t) return t;
      const clone = structuredClone(t);
      const days = clone.days || [];
      const [moved] = days.splice(fromIdx, 1);
      days.splice(toIdx, 0, moved);
      clone.days = days;
      return normalizeTripData(clone);
    });

  const removeLastDay = () =>
    setTrip((t) => {
      if (!t) return t;
      const clone = structuredClone(t);
      clone.days = (clone.days || []).slice(0, -1);
      return normalizeTripData(clone);
    });

  const ensurePriceTable = () =>
    setTrip((t) => {
      if (!t) return t;
      const clone = structuredClone(t);
      clone.price_table ||= { columns: ["Том хүн", "Хүүхэд"], rows: [], note: "" };
      if (!clone.price_table.columns?.length) clone.price_table.columns = ["Том хүн", "Хүүхэд"];
      clone.price_table.rows ||= [];
      if (clone.price_table.rows.length === 0) {
        clone.price_table.rows.push({ dates: "Шинэ огноо", cells: clone.price_table.columns.map(() => "") });
      }
      return normalizeTripData(clone);
    });

  const addPriceRow: PosterAddPriceRowFn = () =>
    setTrip((t) => {
      if (!t) return t;
      const clone = structuredClone(t);
      clone.price_table ||= { columns: ["Том хүн", "Хүүхэд"], rows: [], note: "" };
      const cols = clone.price_table.columns?.length || 2;
      clone.price_table.rows ||= [];
      clone.price_table.rows.push({ dates: "Шинэ огноо", cells: Array.from({ length: cols }, () => "") });
      return clone;
    });

  const addPriceCol: PosterAddPriceColFn = () =>
    setTrip((t) => {
      if (!t) return t;
      const clone = structuredClone(t);
      if (!clone.price_table) return clone;
      clone.price_table.columns.push("Шинэ багана");
      clone.price_table.rows = clone.price_table.rows.map((r) => ({
        ...r,
        cells: [...r.cells, ""],
      }));
      return clone;
    });

  const removePriceCol: PosterRemovePriceColFn = (ci) =>
    setTrip((t) => {
      if (!t) return t;
      const clone = structuredClone(t);
      if (!clone.price_table) return clone;
      clone.price_table.columns.splice(ci, 1);
      clone.price_table.rows = clone.price_table.rows.map((r) => ({
        ...r,
        cells: r.cells.filter((_, i) => i !== ci),
      }));
      return clone;
    });

  const toggleFlights = () =>
    setTrip((t) => {
      if (!t) return t;
      const clone = structuredClone(t);
      clone.flights = clone.flights ? null : { outbound: "MR855 УБ → Датун 16:30-18:10", return: "MR856 Датун → УБ 19:10-21:00" };
      return clone;
    });

  useLayoutEffect(() => {
    const fit = () => {
      const w = mainRef.current ? mainRef.current.clientWidth : POSTER_WIDTH;
      setScale(Math.min(1, (w - 4) / POSTER_WIDTH));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [trip]);

  useLayoutEffect(() => {
    if (previewRef.current) setTotalH(previewRef.current.scrollHeight);
  }, [trip, scale]);

  const loadHistory = async () => {
    const r = await fetchJson("/api/admin/poster/trips");
    if (r.trips) setHistory(r.trips as PosterHistoryItem[]);
  };

  function waitForPosterRender(): Promise<void> {
    return new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  }

  useEffect(() => {
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function sha256File(file: File): Promise<string> {
    const buf = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest("SHA-256", buf);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // Keep the simple direct extract for smaller files, but send large files to
  // Blob first so Vercel's 4.5MB function body cap doesn't reject them.
  // Hard client-side deadline on the extract call. If Vercel kills the
  // function mid-request (its 60s ceiling), the connection can hang instead
  // of erroring — without this abort, the spinner would spin forever, which
  // is exactly the failure mode this feature kept hitting.
  const EXTRACT_TIMEOUT_MS = 90 * 1000;

  // The 4.5MB body cap is a VERCEL platform limit — local dev has no such
  // cap, and no BLOB_READ_WRITE_TOKEN either, so routing big files through
  // Blob on localhost just fails with "Failed to retrieve the client token".
  // On localhost every file goes direct multipart, any size.
  function isLocalDevHost(): boolean {
    if (typeof window === "undefined") return false;
    return ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
  }

  function isPosterImageFile(file: File): boolean {
    const name = file.name.trim().toLowerCase();
    return file.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|bmp)$/.test(name);
  }

  function canBatchImageSlices(files: File[]): boolean {
    if (files.length <= 1 || files.length > 5) return false;
    if (!files.every(isPosterImageFile)) return false;
    return true;
  }

  async function extractImageSliceBatch(files: File[]): Promise<{ trip: PosterTrip; source_file: string }> {
    const timeoutMs = isLocalDevHost() ? 300 * 1000 : EXTRACT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
      let res: Response;
      if (totalBytes > DIRECT_UPLOAD_LIMIT_BYTES && !isLocalDevHost()) {
        const blobs = await Promise.all(
          files.map((file) =>
            uploadToBlob(file.name, file, {
              access: "public",
              handleUploadUrl: "/api/admin/poster/upload",
              clientPayload: JSON.stringify({ adminSecret: getStoredAdminSecret() }),
              abortSignal: controller.signal,
            }),
          ),
        );
        res = await apiFetch("/api/admin/poster/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            files: blobs.map((blob, index) => ({
              blobUrl: blob.url,
              filename: files[index]?.name || `poster-slice-${index + 1}`,
              mimeType: files[index]?.type || "",
            })),
          }),
          signal: controller.signal,
        });
      } else {
        const fd = new FormData();
        for (const file of files) fd.append("file", file, file.name);
        res = await apiFetch("/api/admin/poster/extract", {
          method: "POST",
          body: fd,
          signal: controller.signal,
        });
      }
      const text = await res.text();
      let json: JsonRecord = {};
      if (text) {
        try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 300) }; }
      }
      if (!res.ok) throw new Error((json.error as string) || `HTTP ${res.status}`);
      if (json.error) throw new Error(json.error as string);
      return {
        ...(json as unknown as { trip: PosterTrip; source_file?: string }),
        source_file: (json.source_file as string) || files.map((file) => file.name).join(", "),
      };
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError" || /abort/i.test(String((e as { message?: string })?.message || ""))) {
        throw new Error(`Хүсэлт хэт удаж зогслоо (${timeoutMs / 1000}s). Зургууд хэт том эсвэл сервер ачаалалтай байж магадгүй — дахин оролдоно уу.`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async function dataUrlToFile(dataUrl: string, filename: string): Promise<File> {
    const blob = await fetch(dataUrl).then((response) => response.blob());
    return new File([blob], filename, { type: blob.type || "image/png" });
  }

  async function uploadPosterCapture(dataUrl: string, filename: string): Promise<string> {
    const file = await dataUrlToFile(dataUrl, filename);
    const blob = await uploadToBlob(filename, file, {
      access: "public",
      handleUploadUrl: "/api/admin/poster/upload",
      clientPayload: JSON.stringify({ adminSecret: getStoredAdminSecret() }),
    });
    return blob.url;
  }

  async function extractOne(file: File): Promise<{ trip: PosterTrip; source_file: string }> {
    // Local dev has no Vercel 60s kill, and its server budget is 5 min —
    // give the client the same room so slow local runs aren't cut at 90s.
    const timeoutMs = isLocalDevHost() ? 300 * 1000 : EXTRACT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      if (file.size > DIRECT_UPLOAD_LIMIT_BYTES && !isLocalDevHost()) {
        const blob = await uploadToBlob(file.name, file, {
          access: "public",
          handleUploadUrl: "/api/admin/poster/upload",
          clientPayload: JSON.stringify({ adminSecret: getStoredAdminSecret() }),
          abortSignal: controller.signal,
        });
        res = await apiFetch("/api/admin/poster/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            blobUrl: blob.url,
            filename: file.name,
            mimeType: file.type || "",
          }),
          signal: controller.signal,
        });
      } else {
        const fd = new FormData();
        fd.append("file", file, file.name);
        res = await apiFetch("/api/admin/poster/extract", {
          method: "POST",
          body: fd,
          signal: controller.signal,
        });
      }
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError" || /abort/i.test(String((e as { message?: string })?.message || ""))) {
        throw new Error(`Хүсэлт хэт удаж зогслоо (${timeoutMs / 1000}s). Файл хэт том эсвэл сервер ачаалалтай байж магадгүй — дахин оролдоно уу.`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let json: JsonRecord = {};
    if (text) {
      try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 300) }; }
    }
    if (!res.ok) throw new Error((json.error as string) || `HTTP ${res.status}`);
    if (json.error) throw new Error(json.error as string);
    return { ...(json as unknown as { trip: PosterTrip; source_file?: string }), source_file: (json.source_file as string) || file.name };
  }

  async function saveTripData(data: PosterTrip, sourceFile: string): Promise<{ id: string; trip: PosterTrip }> {
    const cleanTrip = normalizeTripData(data) as PosterTrip;
    const r = await fetchJson("/api/admin/poster/trips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: cleanTrip.title, data: cleanTrip, source_file: sourceFile }),
    });
    if (r.error) throw new Error(r.error as string);
    return { id: r.id as string, trip: cleanTrip };
  }

  async function handleFiles(files: FileList | null | undefined) {
    if (!files || files.length === 0) return;
    setError("");
    let fileList = Array.from(files).filter((f) => f instanceof File);
    const droppedCount = fileList.length;
    const warnings: string[] = [];

    if (droppedCount > MAX_UPLOAD_FILES) {
      warnings.push(`Зөвхөн эхний ${MAX_UPLOAD_FILES} файлыг боловсруулна (${droppedCount} файлаас).`);
      fileList = fileList.slice(0, MAX_UPLOAD_FILES);
    }

    const tooBig = fileList.filter((f) => f.size > MAX_UPLOAD_SIZE_BYTES);
    if (tooBig.length > 0) {
      warnings.push(`${tooBig.map((f) => f.name).join(", ")} файл ${MAX_UPLOAD_SIZE_MB}MB-с том тул алгаслаа.`);
      fileList = fileList.filter((f) => f.size <= MAX_UPLOAD_SIZE_BYTES);
    }

    if (fileList.length === 0) {
      setError(warnings.join(" "));
      return;
    }

    const seen = new Set<string>();
    const uniqueFiles: File[] = [];
    for (const file of fileList) {
      const hash = await sha256File(file);
      if (seen.has(hash)) {
        warnings.push(`${file.name} нөгөө файлтай ижиг агуулгатай байсан тул алгаслаа.`);
      } else {
        seen.add(hash);
        uniqueFiles.push(file);
      }
    }

    const saved: Array<{ file: string; trip: PosterTrip; id: string }> = [];
    const failed: Array<{ file: string; error: string }> = [];

    if (canBatchImageSlices(uniqueFiles)) {
      const label = uniqueFiles.map((file) => file.name).join(", ");
      setBusy(`${uniqueFiles.length} зургийн хэсгийг зэрэг уншиж байна: ${label}…`);
      try {
        const { trip, source_file } = await extractImageSliceBatch(uniqueFiles);
        setBusy(`${uniqueFiles.length} зургийн хэсгийг нэг аялал болгож хадгалж байна…`);
        const { id } = await saveTripData(trip, source_file || label);
        saved.push({ file: source_file || label, trip, id });
      } catch (e) {
        console.error("image slice batch failed:", label, e);
        failed.push({ file: label, error: String((e as { message?: string })?.message || e) });
      }
    } else {
    for (let i = 0; i < uniqueFiles.length; i++) {
      const file = uniqueFiles[i];
      setBusy(`${uniqueFiles.length} файлаас ${i + 1}-г уншиж байна: ${file.name}…`);
      try {
        const { trip, source_file } = await extractOne(file);
        setBusy(`${uniqueFiles.length} файлаас ${i + 1}-г хадгалж байна: ${file.name}…`);
        const { id } = await saveTripData(trip, source_file || file.name);
        saved.push({ file: file.name, trip, id });
      } catch (e) {
        console.error("file failed:", file.name, e);
        failed.push({ file: file.name, error: String((e as { message?: string })?.message || e) });
      }
    }

    }

    if (saved.length > 0) {
      const first = saved[0];
      setTrip(normalizeTripData(first.trip));
      setTripId(first.id);
      setSource(first.file);
    }

    await loadHistory();
    setBusy("");

    const messages = [...warnings];
    if (failed.length > 0) {
      messages.push(`${failed.length} файл уншихад алдаа гарлаа: ${failed.map((f) => f.file).join(", ")}`);
    }
    if (messages.length > 0) setError(messages.join(" "));
  }

  async function capture(node: HTMLElement): Promise<string> {
    const imgs = Array.from(node.querySelectorAll("img"));
    await Promise.all(
      imgs.map(async (img) => {
        if (!img.complete || !img.naturalWidth) {
          await new Promise<void>((resolve) => {
            const done = () => resolve();
            img.addEventListener("load", done, { once: true });
            img.addEventListener("error", done, { once: true });
          });
        }
        if (img.decode) {
          try {
            await img.decode();
          } catch {
            // Decode failures are non-fatal — the image still renders via <img>.
          }
        }
      })
    );

    if (document.fonts?.ready) await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

    return htmlToImage.toPng(node, {
      pixelRatio: 2,
      width: node.offsetWidth,
      height: node.offsetHeight,
      backgroundColor: "#ffffff",
      style: { transform: "none", margin: "0", boxShadow: "none" },
      filter: (domNode) =>
        !(domNode as Element).classList?.contains("editor-only") &&
        !(domNode as Element).classList?.contains("hidden-input"),
    });
  }

  async function withExportMode<T>(work: () => Promise<T>): Promise<T> {
    document.body.classList.add("exporting");
    try {
      return await work();
    } finally {
      document.body.classList.remove("exporting");
    }
  }

  function buildExportBaseName(titleOverride?: string): string {
    return (titleOverride || trip?.title || "poster")
      .slice(0, 40)
      .replace(/[\\/:*?"<>|]/g, "")
      .trim() || "poster";
  }

  type SplitCandidate = { y: number; quality: number; label: string };
  type SplitRange = { top: number; bottom: number };

  function getRelativeRect(el: HTMLElement, container: HTMLElement): SplitRange {
    const containerRect = container.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    const scaleFactor = container.offsetWidth
      ? containerRect.width / container.offsetWidth
      : 1;
    const safeScale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
    return {
      top: (rect.top - containerRect.top) / safeScale,
      bottom: (rect.bottom - containerRect.top) / safeScale,
    };
  }

  function isVisibleSplitElement(el: HTMLElement): boolean {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getMessengerSplitCandidates(node: HTMLElement): SplitCandidate[] {
    const totalHeight = node.offsetHeight;
    const candidates: SplitCandidate[] = [];

    const addCandidate = (y: number, quality: number, label: string) => {
      if (!Number.isFinite(y)) return;
      const rounded = Math.round(y);
      if (rounded < 80 || rounded > totalHeight - 80) return;
      candidates.push({ y: rounded, quality, label });
    };

    const blocks = Array.from(
      node.querySelectorAll<HTMLElement>(".hero,.sec.compact-sec,.program-head,.dayrow,.foot"),
    )
      .filter(isVisibleSplitElement)
      .map((el) => ({ el, ...getRelativeRect(el, node) }))
      .sort((a, b) => a.top - b.top);

    for (let i = 0; i < blocks.length - 1; i++) {
      const gapStart = blocks[i].bottom;
      const gapEnd = blocks[i + 1].top;
      const gap = gapEnd - gapStart;
      if (gap >= 6) {
        addCandidate(gapStart + gap / 2, 115 + Math.min(40, gap), "section-gap");
      }
    }

    node.querySelectorAll<HTMLElement>(".program-head,.sec.compact-sec,.foot").forEach((el) => {
      if (!isVisibleSplitElement(el)) return;
      const rect = getRelativeRect(el, node);
      addCandidate(rect.top, 80, "section-start");
      addCandidate(rect.bottom, 65, "section-end");
    });

    node.querySelectorAll<HTMLElement>(".dayrow").forEach((row) => {
      if (!isVisibleSplitElement(row)) return;
      const rowRect = getRelativeRect(row, node);
      addCandidate(rowRect.top, 120, "day-start");
      addCandidate(rowRect.bottom, 95, "day-end");

      const photo = row.querySelector<HTMLElement>(".dside");
      if (photo && isVisibleSplitElement(photo)) {
        const photoRect = getRelativeRect(photo, node);
        addCandidate(photoRect.top, 78, "before-day-photo");
      }

      row.querySelectorAll<HTMLElement>(".dsummary li").forEach((li) => {
        if (!isVisibleSplitElement(li)) return;
        const liRect = getRelativeRect(li, node);
        addCandidate(liRect.bottom + 5, 42, "between-bullets");
      });
    });

    const deduped = new Map<number, SplitCandidate>();
    for (const candidate of candidates) {
      const nearKey = Array.from(deduped.keys()).find((key) => Math.abs(key - candidate.y) <= 4);
      const key = nearKey ?? candidate.y;
      const existing = deduped.get(key);
      if (!existing || candidate.quality > existing.quality) {
        deduped.set(key, { ...candidate, y: key });
      }
    }

    return Array.from(deduped.values()).sort((a, b) => a.y - b.y);
  }

  function getUnsafeSplitRanges(node: HTMLElement): SplitRange[] {
    const textSelectors = [
      ".kicker",
      ".htitle",
      ".ptable tr",
      ".price-note-box",
      ".price-desc-input",
      ".program-head",
      ".droute",
      ".dsummary li",
      ".dhotel",
      ".mealgrid",
      ".foot span",
    ].join(",");

    return Array.from(node.querySelectorAll<HTMLElement>(textSelectors))
      .filter(isVisibleSplitElement)
      .map((el) => {
        const rect = getRelativeRect(el, node);
        return { top: rect.top - 18, bottom: rect.bottom + 18 };
      });
  }

  function isUnsafeSplitY(y: number, unsafeRanges: SplitRange[]): boolean {
    return unsafeRanges.some((range) => y > range.top && y < range.bottom);
  }

  function chooseNearestSafeY(
    target: number,
    minY: number,
    maxY: number,
    unsafeRanges: SplitRange[],
  ): number {
    let best = Math.round(Math.max(minY, Math.min(maxY, target)));
    let bestScore = isUnsafeSplitY(best, unsafeRanges) ? Number.POSITIVE_INFINITY : Math.abs(best - target);

    for (let y = Math.round(minY); y <= maxY; y += 6) {
      if (isUnsafeSplitY(y, unsafeRanges)) continue;
      const score = Math.abs(y - target);
      if (score < bestScore) {
        best = y;
        bestScore = score;
      }
    }

    return best;
  }

  function chooseSafeFallbackSplitPoints(node: HTMLElement, sliceCount: number): number[] {
    if (sliceCount <= 1) return [];
    const totalHeight = node.offsetHeight;
    const unsafeRanges = getUnsafeSplitRanges(node);
    const minSliceHeight = Math.max(260, totalHeight * 0.12);
    const points: number[] = [];

    for (let index = 1; index < sliceCount; index++) {
      const target = (totalHeight * index) / sliceCount;
      const previous = points[points.length - 1] ?? 0;
      const remainingCuts = sliceCount - index;
      const minY = previous + minSliceHeight;
      const maxY = totalHeight - remainingCuts * minSliceHeight;
      points.push(chooseNearestSafeY(target, minY, maxY, unsafeRanges));
    }

    return points.map(Math.round);
  }

  function chooseMessengerSplitPoint(node: HTMLElement): number | null {
    const totalHeight = node.offsetHeight;
    const target = totalHeight / 2;
    const minY = totalHeight * 0.34;
    const maxY = totalHeight * 0.74;
    const unsafeRanges = getUnsafeSplitRanges(node);
    const candidates = getMessengerSplitCandidates(node).filter(
      (candidate) =>
        candidate.y > minY &&
        candidate.y < maxY &&
        !isUnsafeSplitY(candidate.y, unsafeRanges),
    );

    if (!candidates.length) return null;

    return candidates.reduce((best, current) => {
      const bestScore = Math.abs(best.y - target) - best.quality * 5;
      const currentScore = Math.abs(current.y - target) - current.quality * 5;
      return currentScore < bestScore ? current : best;
    }).y;
  }

  function chooseMessengerSplitPoints(node: HTMLElement, sliceCount: number): number[] | null {
    if (sliceCount <= 1) return [];
    if (sliceCount === 2) {
      const point = chooseMessengerSplitPoint(node);
      return point === null ? null : [point];
    }

    const totalHeight = node.offsetHeight;
    const targets = Array.from({ length: sliceCount - 1 }, (_, i) => (totalHeight * (i + 1)) / sliceCount);
    const unsafeRanges = getUnsafeSplitRanges(node);
    const candidates = getMessengerSplitCandidates(node).filter(
      (candidate) =>
        candidate.y > totalHeight * 0.14 &&
        candidate.y < totalHeight * 0.9 &&
        !isUnsafeSplitY(candidate.y, unsafeRanges),
    );

    if (candidates.length < sliceCount - 1) {
      return null;
    }

    let bestPoints: number[] = [];
    let foundPlan = false;
    let bestScore = Infinity;

    const scorePoints = (points: number[]): number => {
      const sorted = [...points].sort((a, b) => a - b);
      const ranges = [0, ...sorted, totalHeight].map((startY, index, all) => all[index + 1] - startY).filter(Boolean);
      const ideal = totalHeight / sliceCount;
      const maxRange = Math.max(...ranges);
      const minRange = Math.min(...ranges);
      const balancePenalty = ranges.reduce((sum, height) => sum + Math.abs(height - ideal), 0);
      const targetPenalty = sorted.reduce((sum, point, index) => sum + Math.abs(point - targets[index]), 0);
      const hugeSlicePenalty = Math.max(0, maxRange - MESSENGER_SINGLE_IMAGE_MAX_HEIGHT) * 3;
      const tinySlicePenalty = Math.max(0, totalHeight * 0.14 - minRange) * 4;
      const qualityBonus = sorted.reduce((sum, point) => {
        const candidate = candidates.find((item) => item.y === point);
        return sum + (candidate?.quality ?? 0);
      }, 0);
      return balancePenalty * 1.25 + targetPenalty + hugeSlicePenalty + tinySlicePenalty - qualityBonus * 5;
    };

    function visit(startIndex: number, picked: number[]) {
      if (picked.length === sliceCount - 1) {
        const score = scorePoints(picked);
        if (score < bestScore) {
          bestScore = score;
          bestPoints = [...picked];
          foundPlan = true;
        }
        return;
      }

      const remainingNeeded = sliceCount - 1 - picked.length;
      for (let i = startIndex; i <= candidates.length - remainingNeeded; i++) {
        const point = candidates[i].y;
        const previous = picked[picked.length - 1] ?? 0;
        if (point - previous < totalHeight * 0.12) continue;
        visit(i + 1, [...picked, point]);
      }
    }

    visit(0, []);
    return foundPlan ? [...bestPoints].sort((a, b) => a - b).map(Math.round) : null;
  }

  function scoreMessengerSplitPlan(totalHeight: number, sliceCount: number, splitPoints: number[]): number {
    const ideal = totalHeight / sliceCount;
    const ranges = [0, ...splitPoints, totalHeight]
      .map((startY, index, points) => points[index + 1] - startY)
      .filter(Boolean);
    const targets = Array.from({ length: sliceCount - 1 }, (_, i) => (totalHeight * (i + 1)) / sliceCount);
    const balancePenalty = ranges.reduce((sum, height) => sum + Math.abs(height - ideal), 0);
    const targetPenalty = splitPoints.reduce(
      (sum, point, index) => sum + Math.abs(point - targets[index]),
      0
    );
    const oversizePenalty = ranges.reduce((sum, height) => {
      const extra = Math.max(0, height - MESSENGER_SINGLE_IMAGE_MAX_HEIGHT);
      return sum + extra * extra * 0.08;
    }, 0);
    const tinySlicePenalty = ranges.reduce((sum, height) => {
      const shortfall = Math.max(0, totalHeight * 0.14 - height);
      return sum + shortfall * shortfall * 0.2;
    }, 0);
    const slicePenalty = Math.max(0, sliceCount - 1) * 80;

    return balancePenalty * 1.2 + targetPenalty + oversizePenalty + tinySlicePenalty + slicePenalty;
  }

  type MessengerSlicePlan = { sliceCount: number; splitPoints: number[]; score: number };

  function chooseMessengerSlicePlan(node: HTMLElement): MessengerSlicePlan {
    const totalHeight = node.offsetHeight;
    const preferredCount = Math.min(
      MESSENGER_MAX_IMAGE_SLICES,
      Math.max(1, Math.ceil(totalHeight / MESSENGER_SINGLE_IMAGE_MAX_HEIGHT))
    );
    const countsToTry = Array.from({ length: MESSENGER_MAX_IMAGE_SLICES }, (_, index) => index + 1)
      .sort((a, b) => Math.abs(a - preferredCount) - Math.abs(b - preferredCount) || a - b);

    let bestPlan: MessengerSlicePlan | null = null;

    for (const sliceCount of countsToTry) {
      const splitPoints = chooseMessengerSplitPoints(node, sliceCount);
      if (splitPoints === null) continue;

      const plan: MessengerSlicePlan = {
        sliceCount,
        splitPoints,
        score: scoreMessengerSplitPlan(totalHeight, sliceCount, splitPoints),
      };

      if (!bestPlan || plan.score < bestPlan.score) {
        bestPlan = plan;
      }
    }

    if (bestPlan) return bestPlan;

    const fallbackPoints = chooseSafeFallbackSplitPoints(node, preferredCount);

    return {
      sliceCount: preferredCount,
      splitPoints: fallbackPoints,
      score: Number.POSITIVE_INFINITY,
    };
  }

  function drawMessengerBadge(ctx: CanvasRenderingContext2D, width: number, height: number, index: number, total: number) {
    const label = `${index + 1}/${total}`;
    const badgeWidth = 120;
    const badgeHeight = 56;
    const x = width - badgeWidth - 28;
    const y = height - badgeHeight - 28;

    ctx.fillStyle = "rgba(17, 62, 103, 0.88)";
    ctx.beginPath();
    ctx.roundRect(x, y, badgeWidth, badgeHeight, 18);
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    ctx.font = "700 30px Segoe UI";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x + badgeWidth / 2, y + badgeHeight / 2 + 1);
  }

  function loadImageFromUrl(url: string): Promise<HTMLImageElement> {
    return new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }

  function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function renderSliceForPdf(
    url: string,
    step: (typeof PDF_COMPRESSION_STEPS)[number],
  ): Promise<{ url: string; width: number; height: number }> {
    const img = await loadImageFromUrl(url);
    const scaleDown = Math.min(1, step.maxWidth / img.width);
    const width = Math.max(1, Math.round(img.width * scaleDown));
    const height = Math.max(1, Math.round(img.height * scaleDown));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    return { url: canvas.toDataURL("image/jpeg", step.quality), width, height };
  }

  async function buildCompressedPdfBlob(captures: Array<{ index: number; url: string }>): Promise<{
    blob: Blob;
    sizeBytes: number;
    maxWidth: number;
    quality: number;
  }> {
    const { jsPDF } = await import("jspdf");
    let lastResult: { blob: Blob; sizeBytes: number; maxWidth: number; quality: number } | null = null;

    for (const step of PDF_COMPRESSION_STEPS) {
      let pdf: InstanceType<typeof jsPDF> | undefined;
      for (let i = 0; i < captures.length; i++) {
        const image = await renderSliceForPdf(captures[i].url, step);
        const format: [number, number] = [image.width, image.height];
        if (i === 0) {
          pdf = new jsPDF({ orientation: "p", unit: "px", format, compress: true });
        } else {
          pdf?.addPage(format, "p");
        }
        pdf?.addImage(image.url, "JPEG", 0, 0, image.width, image.height, undefined, "FAST");
      }

      if (!pdf) throw new Error("Poster capture failed.");
      const blob = pdf.output("blob");
      lastResult = { blob, sizeBytes: blob.size, maxWidth: step.maxWidth, quality: step.quality };
      if (blob.size <= PDF_MAX_BYTES) return lastResult;
    }

    if (!lastResult) throw new Error("PDF бэлдэхэд алдаа гарлаа.");
    if (lastResult.sizeBytes > PDF_MAX_BYTES) {
      throw new Error(
        `PDF ${Math.ceil(lastResult.sizeBytes / 1024 / 1024)}MB болж байна. 25MB-аас бага болгохын тулд зураг/өдрийг цөөлж дахин оролдоно уу.`,
      );
    }
    return lastResult;
  }

  async function captureMessengerSlices(): Promise<Array<{ index: number; url: string }>> {
    const node = page1Ref.current;
    if (!node) return [];

    const fullUrl = await capture(node);
    const fullImage = await loadImageFromUrl(fullUrl);

    const totalHeight = node.offsetHeight;
    const { splitPoints } = chooseMessengerSlicePlan(node);
    const ranges = [0, ...splitPoints, totalHeight]
      .map((startY, index, points) => [startY, points[index + 1]] as [number, number | undefined])
      .filter((range): range is [number, number] => range[1] !== undefined);
    const scaleY = fullImage.height / totalHeight;

    return ranges.map(([startY, endY], index) => {
      const sourceY = Math.round(startY * scaleY);
      const sourceHeight = Math.round((endY - startY) * scaleY);
      const canvas = document.createElement("canvas");
      canvas.width = fullImage.width;
      canvas.height = sourceHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return { index, url: "" };
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(fullImage, 0, sourceY, fullImage.width, sourceHeight, 0, 0, canvas.width, canvas.height);
      drawMessengerBadge(ctx, canvas.width, canvas.height, index, ranges.length);

      return {
        index,
        url: canvas.toDataURL("image/png"),
      };
    }).filter((slice) => Boolean(slice.url));
  }

  // Renders the poster as Messenger-sized images for AttachToTripModal — the
  // same finished, branded poster the customer will actually see.
  async function captureForAttach(titleOverride?: string): Promise<CapturedPosterImage[]> {
    const slices = await withExportMode(() => captureMessengerSlices());
    const captures = slices.map((slice) => ({
      dataUrl: slice.url,
      filename: `${buildExportBaseName(titleOverride)}-messenger-${slice.index + 1}.png`,
    }));

    if (isLocalDevHost()) return captures;

    try {
      return await Promise.all(
        captures.map(async (capture) => ({
          url: await uploadPosterCapture(capture.dataUrl, capture.filename),
          filename: capture.filename,
        })),
      );
    } catch (error) {
      const totalChars = captures.reduce((sum, capture) => sum + capture.dataUrl.length, 0);
      if (totalChars > DIRECT_POSTER_SYNC_BODY_LIMIT_CHARS) {
        throw new Error(
          `Poster image upload failed before saving to the trip: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return captures;
    }
  }

  function buildPosterSyncPhotoPayload(
    image: CapturedPosterImage,
    index: number,
    titleOverride?: string,
  ): PosterSyncPhotoPayload {
    const fallbackFilename = `${buildExportBaseName(titleOverride)}-messenger-${index + 1}.png`;
    if (typeof image === "string") {
      return image.startsWith("data:")
        ? { dataUrl: image, filename: fallbackFilename }
        : { url: image, filename: fallbackFilename };
    }
    const filename = image.filename || fallbackFilename;
    if (image.url) return { url: image.url, filename };
    return { dataUrl: image.dataUrl || "", filename };
  }

  async function downloadFullPng() {
    const node = page1Ref.current;
    if (!node) return;
    setBusy("Бүтэн PNG бэлдэж байна…");
    try {
      await withExportMode(async () => {
        const url = await capture(node);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${buildExportBaseName()}-full.png`;
        a.click();
      });
    } catch (e) {
      setError(String((e as { message?: string })?.message || e));
    } finally {
      setBusy("");
    }
  }

  async function downloadSplitImages() {
    setBusy("Messenger зурагнуудыг бэлдэж байна…");
    try {
      await withExportMode(async () => {
        const captures = await captureMessengerSlices();
        const baseName = buildExportBaseName();

        for (const item of captures) {
          const a = document.createElement("a");
          a.href = item.url;
          a.download = `${baseName}-messenger-${item.index + 1}.png`;
          a.click();
        }
      });
    } catch (e) {
      setError(String((e as { message?: string })?.message || e));
    } finally {
      setBusy("");
    }
  }

  async function downloadSplitZip() {
    setBusy("ZIP файл бэлдэж байна…");
    try {
      await withExportMode(async () => {
        const captures = await captureMessengerSlices();
        const JSZip = (await import("jszip")).default;
        const zip = new JSZip();
        const baseName = buildExportBaseName();

        await Promise.all(
          captures.map(async (item) => {
            const blob = await fetch(item.url).then((response) => response.blob());
            zip.file(`${baseName}-messenger-${item.index + 1}.png`, blob);
          })
        );

        const blob = await zip.generateAsync({ type: "blob" });
        const zipUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = zipUrl;
        a.download = `${baseName}-messenger-split.zip`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(zipUrl), 1000);
      });
    } catch (e) {
      setError(String((e as { message?: string })?.message || e));
    } finally {
      setBusy("");
    }
  }

  async function downloadPdf() {
    setBusy("PDF бэлдэж байна…");
    try {
      await withExportMode(async () => {
        const captures = await captureMessengerSlices();
        if (captures.length === 0) throw new Error("Poster capture failed.");
        const result = await buildCompressedPdfBlob(captures);
        if (result.sizeBytes > PDF_MAX_BYTES) {
          throw new Error(
            `PDF ${Math.ceil(result.sizeBytes / 1024 / 1024)}MB болж байна. 25MB-аас бага болгож чадсангүй.`,
          );
        }
        downloadBlob(result.blob, `${buildExportBaseName()}-split.pdf`);
      });
    } catch (e) {
      setError(String((e as { message?: string })?.message || e));
    } finally {
      setBusy("");
    }
  }

  const onDayPhotoFile: PosterOnDayPhotoFileFn = async (index, file) => {
    if (!file) return;
    setBusy("Өдрийн зураг нэмж байна…");
    try {
      const dataUrl = await resizeImage(file, 1400);
      setTrip((t) => {
        if (!t) return t;
        const clone = structuredClone(t);
        const day = clone.days?.[index];
        if (!day) return t;
        day.photo = dataUrl;
        if (!day.photo_caption) day.photo_caption = day.summary || day.route || "";
        return normalizeTripData(clone);
      });
    } catch (e) {
      setError(String((e as { message?: string })?.message || e));
    } finally {
      setBusy("");
      if (dayPhotoInputRefs.current[index]) dayPhotoInputRefs.current[index].value = "";
    }
  };

  async function loadPosterForBatch(posterId: string): Promise<PosterTrip> {
    const r = await fetchJson(`/api/admin/poster/trip?id=${encodeURIComponent(posterId)}`);
    if (r.error) throw new Error(r.error as string);
    const tripRow = r.trip as { id: string; data: PosterTrip; source_file: string | null };
    const nextTrip = normalizeTripData(tripRow.data) as PosterTrip;
    setTrip(nextTrip);
    setTripId(tripRow.id);
    setSource(tripRow.source_file || "");
    await waitForPosterRender();
    return nextTrip;
  }

  async function syncAllSafePosters() {
    setError("");
    setBulkReport(null);
    setBusy("Бүх постерын төлөвлөгөө шалгаж байна…");
    const failed: PosterBulkRunReport["failed"] = [];
    let created = 0;
    let attached = 0;

    try {
      const planResponse = await fetchJson("/api/admin/poster-bulk-plan", { method: "POST" });
      if (planResponse.error) throw new Error(planResponse.error as string);
      const plan = planResponse as unknown as PosterBulkPlan;
      if (!Array.isArray(plan.items)) throw new Error("Bulk plan response invalid.");

      const runnable = plan.items.filter((item) => item.action === "create" || item.action === "attach_exact");
      const skipped = plan.items.filter((item) => item.action === "skip");

      for (let i = 0; i < runnable.length; i++) {
        const item = runnable[i];
        const title = item.title || "poster";
        setBusy(`${runnable.length} постероос ${i + 1}-г аялалд холбож байна: ${title}…`);

        try {
          if (item.action === "attach_exact" && !item.targetTripId) {
            throw new Error("Exact target trip missing from plan.");
          }

          const renderedTrip = await loadPosterForBatch(item.posterId);
          const captureTitle = item.title || renderedTrip.title || "poster";
          const images = await captureForAttach(captureTitle);
          const photos = images
            .map((image, index) => buildPosterSyncPhotoPayload(image, index, captureTitle))
            .filter((photo) => photo.dataUrl || photo.url);

          const syncResult = await fetchJson("/api/admin/poster-sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              tripId: item.action === "attach_exact" ? item.targetTripId : undefined,
              createNew: item.action === "create" || undefined,
              newTripTitle: item.action === "create" ? captureTitle : undefined,
              mode: "replace",
              photos,
              fields: item.fields,
            }),
          });
          if (syncResult.error) throw new Error(syncResult.error as string);
          if (syncResult.created) created++;
          else attached++;
        } catch (e) {
          failed.push({ title, error: String((e as { message?: string })?.message || e) });
        }
      }

      await loadHistory();
      setBulkReport({
        total: plan.summary?.total ?? plan.items.length,
        created,
        attached,
        skipped,
        failed,
      });
    } catch (e) {
      setError(String((e as { message?: string })?.message || e));
    } finally {
      setBusy("");
    }
  }

  async function save() {
    setError("");
    setBusy("Хадгалж байна…");
    try {
      const cleanTrip = normalizeTripData(trip) as PosterTrip;
      const matchingTitles = history.filter((item) => {
        if (item.id === tripId) return false;
        return normalizeHistoryTitle(item.title) === normalizeHistoryTitle(cleanTrip.title);
      });
      const r = await fetchJson("/api/admin/poster/trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: tripId, title: cleanTrip.title, data: cleanTrip, source_file: source }),
      });
      if (r.error) throw new Error(r.error as string);
      setTrip(cleanTrip);
      setTripId(r.id as string);
      await loadHistory();
      if (matchingTitles.length > 0) {
        setError(`Ижил нэртэй ${matchingTitles.length} хадгалсан аялал байна: "${cleanTrip.title}"`);
      }
    } catch (e) {
      setError(String((e as { message?: string })?.message || e));
    } finally {
      setBusy("");
    }
  }

  async function openTrip(id: string) {
    setBusy("Ачааллаж байна…");
    try {
      const r = await fetchJson(`/api/admin/poster/trip?id=${encodeURIComponent(id)}`);
      if (r.error) throw new Error(r.error as string);
      const tripRow = r.trip as { id: string; data: PosterTrip; source_file: string | null };
      setTrip(normalizeTripData(tripRow.data));
      setTripId(tripRow.id);
      setSource(tripRow.source_file || "");
    } catch (e) {
      setError(String((e as { message?: string })?.message || e));
    } finally {
      setBusy("");
    }
  }

  async function deleteTrip(id: string) {
    const previousHistory = history;
    setHistory((items) => items.filter((item) => item.id !== id));
    if (tripId === id) {
      setTrip(null);
      setTripId(null);
      setSource("");
    }

    try {
      const r = await fetchJson(`/api/admin/poster/trip?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (r.error) throw new Error(r.error as string);
    } catch (e) {
      setHistory(previousHistory);
      setError(String((e as { message?: string })?.message || e));
    }
  }

  return (
    <div className="space-y-3">
      <TabHeader
        icon={<Icons.image size={20} />}
        title="Постер үүсгэгч"
        description="Хятадаас ирсэн файлаас брэнд постер — PNG, PDF болон Messenger хэсэглэлээр татна."
      />
      {busy && (
        <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-sunken px-3 py-2 text-sm text-ink-muted">
          <Spinner /> {busy}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
          ⚠ {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_320px] lg:items-start">
        <div className="min-w-0 space-y-3" ref={mainRef}>
          {trip ? (
            /* Compact upload strip — shown when a poster is already open */
            <Card
              className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
              onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add("ring-2", "ring-brand"); }}
              onDragLeave={(e) => e.currentTarget.classList.remove("ring-2", "ring-brand")}
              onDrop={(e) => { e.preventDefault(); e.currentTarget.classList.remove("ring-2", "ring-brand"); handleFiles(e.dataTransfer.files); }}
            >
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm text-ink-muted hover:text-ink">
                <input type="file" multiple accept=".pdf,.docx,.txt,image/*" className="hidden" onChange={(e) => handleFiles(e.target.files)} />
                <Icons.upload size={16} className="shrink-0" />
                <span className="truncate">Шинэ файл чирж тавих эсвэл дарах</span>
              </label>
              <Button size="sm" variant="secondary" onClick={startTemplate}>
                Хоосон template
              </Button>
            </Card>
          ) : (
            /* Full uploader — shown on empty state */
            <Card className="p-5">
              <p className="text-sm text-ink-muted">
                Хятадаас ирсэн файлаa оруулаад, брэнд постер бэлэн.{" "}
                <span className="text-ink-subtle">AI уншиж, аяллын постерийг ~10 секундэд үүсгэнэ.</span>
              </p>
              <label
                className="mt-3 flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-line-strong bg-surface-sunken p-8 text-center transition-colors hover:border-brand"
                onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add("border-brand", "bg-brand-soft"); }}
                onDragLeave={(e) => e.currentTarget.classList.remove("border-brand", "bg-brand-soft")}
                onDrop={(e) => { e.preventDefault(); e.currentTarget.classList.remove("border-brand", "bg-brand-soft"); handleFiles(e.dataTransfer.files); }}
              >
                <input type="file" multiple accept=".pdf,.docx,.txt,image/*" className="hidden" onChange={(e) => handleFiles(e.target.files)} />
                <Icons.upload size={26} className="text-ink-subtle" />
                <p className="text-sm font-medium text-ink">Файл эсвэл зураг энд чирж тавь</p>
                <p className="text-xs text-ink-subtle">{`Дээд тал нь ${MAX_UPLOAD_FILES} файл · тус бүр ${MAX_UPLOAD_SIZE_MB}MB хүртэл · Word (.docx), PDF, .txt · JPG, PNG, WEBP зураг`}</p>
                <p className="text-xs text-ink-subtle">{`PDF уншилт: эхний ${PDF_PAGE_EXTRACTION_LIMIT} хуудсыг зэрэг уншина. PNG/PDF таталт Messenger-д таарахаар хэсэглэгдэнэ.`}</p>
              </label>
              <div className="mt-3 flex flex-col items-center gap-1.5 text-center">
                <Button onClick={startTemplate}>Default template-ээр эхлэх</Button>
                <span className="text-xs text-ink-subtle">
                  Файлгүйгээр шууд poster нээгээд бүх текст, үнэ, өдөр, хоол, зураг засна.
                </span>
              </div>
            </Card>
          )}

          {trip && (
            <>
              <Card className="p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-xs font-medium uppercase tracking-wide text-ink-subtle">Workspace</p>
                    <h2 className="truncate text-base font-semibold text-ink">{trip.title || "Untitled poster"}</h2>
                    <p className="text-xs text-ink-subtle">
                      {source || "Live editable travel poster"} · {trip.days?.length || 0} өдөр · 1 export page
                    </p>
                  </div>
                  <Button size="sm" variant="secondary" onClick={startTemplate} disabled={!!busy}>
                    Шинэ default template
                  </Button>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={addDeparture}>+ Огноо</Button>
                  <Button size="sm" variant="secondary" onClick={addDay}>+ Өдөр</Button>
                  <Button size="sm" variant="secondary" onClick={removeLastDay} disabled={(trip.days || []).length <= 1}>
                    Сүүлийн өдөр устгах
                  </Button>
                  <Button size="sm" variant="secondary" onClick={ensurePriceTable}>Үнийн хүснэгт асаах</Button>
                  <Button size="sm" variant="secondary" onClick={addPriceRow} disabled={!trip.price_table}>+ Үнэ мөр</Button>
                  <Button size="sm" variant="secondary" onClick={addPriceCol} disabled={!trip.price_table}>+ Үнэ багана</Button>
                  <Button size="sm" variant="secondary" onClick={toggleFlights}>
                    {trip.flights ? "Нислэг нуух" : "Нислэг нэмэх"}
                  </Button>
                </div>

                <div className="mt-3 flex flex-col gap-1 border-t border-line pt-3 text-xs text-ink-subtle">
                  <span>Canvas маягаар: постер дээрх бичвэр дээр шууд дарж засна.</span>
                  <span>Зураг: нүүр зураг toolbar-аас, өдрийн зураг тухайн зурагны box дээр дарж орно.</span>
                  <span>Download/print үед editor товч, хоосон зурагны box автоматаар алга болно.</span>
                </div>
              </Card>

              <Card className="p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" onClick={save} disabled={!!busy}>
                    <Icons.check size={14} /> Хадгалах
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => setAttachModalOpen(true)} disabled={!!busy}>
                    <Icons.plus size={14} /> Аялалд нэмэх
                  </Button>
                  <Button size="sm" variant="secondary" onClick={syncAllSafePosters} disabled={!!busy || history.length === 0}>
                    <Icons.plus size={14} /> Бүгдийг аялал болгох
                  </Button>
                  <Button size="sm" variant="secondary" onClick={downloadFullPng} disabled={!!busy}>
                    <Icons.image size={14} /> Бүтэн PNG
                  </Button>
                  <Button size="sm" variant="secondary" onClick={downloadSplitImages} disabled={!!busy}>
                    <Icons.image size={14} /> PNG (Messenger)
                  </Button>
                  <Button size="sm" variant="secondary" onClick={downloadPdf} disabled={!!busy}>
                    <Icons.file size={14} /> PDF
                  </Button>
                  <Button size="sm" variant="secondary" onClick={downloadSplitZip} disabled={!!busy}>
                    Messenger ZIP
                  </Button>
                </div>
                <p className="mt-2 text-xs text-ink-subtle">
                  Бичвэр дээр дарж засаарай · хоолны таглыг дарж асаах/унтраах · PNG/PDF/Messenger export: main poster-оос 1-2 зураг, хэт урт бол {MESSENGER_MAX_IMAGE_SLICES}
                </p>
                {bulkReport && (
                  <div className="mt-3 rounded-lg border border-line bg-surface-sunken px-3 py-2 text-xs text-ink-muted">
                    <p className="font-medium text-ink">
                      Bulk: {bulkReport.created} шинэ аялал, {bulkReport.attached} existing аялалд poster нэмсэн.
                    </p>
                    <p className="mt-1">
                      Нийт {bulkReport.total} poster · skip {bulkReport.skipped.length} · failed {bulkReport.failed.length}
                    </p>
                    {(bulkReport.skipped.length > 0 || bulkReport.failed.length > 0) && (
                      <div className="mt-2 max-h-28 space-y-1 overflow-y-auto">
                        {bulkReport.skipped.slice(0, 8).map((item) => (
                          <p key={`skip-${item.posterId}`}>
                            Skip: {item.title || "Untitled"} - {item.reason || item.reasonCode}
                          </p>
                        ))}
                        {bulkReport.failed.slice(0, 8).map((item, index) => (
                          <p key={`fail-${index}`} className="text-danger">
                            Failed: {item.title} - {item.error}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </Card>

              <div className="poster-root overflow-x-auto rounded-xl border border-line bg-surface-sunken p-3">
                <div
                  style={{ width: POSTER_WIDTH * scale, height: totalH * scale }}
                >
                  <div
                    className="preview-stage"
                    ref={previewRef}
                    style={{ transform: `scale(${scale})`, transformOrigin: "top left", width: POSTER_WIDTH }}
                  >
                    <Poster
                      trip={trip}
                      upd={upd}
                      addItem={addItem}
                      removeItem={removeItem}
                      insertDay={insertDay}
                      reorderDay={reorderDay}
                      addPriceRow={addPriceRow}
                      addPriceCol={addPriceCol}
                      removePriceCol={removePriceCol}
                      logoSrc="/poster/uudam-logo.jpg"
                      page1Ref={page1Ref}
                      onDayPhotoFile={onDayPhotoFile}
                      dayPhotoInputRefs={dayPhotoInputRefs}
                    />
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        <Card className="flex flex-col p-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-ink">Түүх</h3>
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-ink-muted">{history.length}</span>
              {history.length > 0 && (
                <button
                  type="button"
                  className="flex items-center gap-1 rounded-md border border-line-strong px-2 py-1 text-xs font-medium text-ink-muted hover:border-brand hover:text-brand"
                  onClick={async () => {
                    const res = await apiFetch("/api/admin/poster/export");
                    const blob = await res.blob();
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `uudam-posters-${new Date().toISOString().slice(0, 10)}.json`;
                    a.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                  }}
                  title="Бүх аялалыг JSON файлаар татах"
                >
                  <Icons.download size={13} /> Татах
                </button>
              )}
            </div>
          </div>

          <div className="mt-3 space-y-2">
            <Input
              value={historySearch}
              onChange={(e) => setHistorySearch(e.target.value)}
              placeholder="Нэрээр хайх..."
            />
            <div className="grid grid-cols-2 gap-2">
              <Select value={historySort} onChange={(e) => setHistorySort(e.target.value as HistorySort)}>
                <option value="newest">Шинэ эхэнд</option>
                <option value="oldest">Хуучин эхэнд</option>
                <option value="title">Нэрээр</option>
              </Select>
              <Select value={historyGroup} onChange={(e) => setHistoryGroup(e.target.value as HistoryGroupMode)}>
                <option value="date">Огноогоор</option>
                <option value="duplicate">Давхардлаар</option>
                <option value="none">Бүлэггүй</option>
              </Select>
            </div>
            {trip && currentDuplicateCount > (tripId ? 1 : 0) && (
              <div className="rounded-lg border border-warning/30 bg-warning-soft px-2.5 py-1.5 text-xs text-warning">
                Ижил нэртэй хадгалсан аялал байна.
              </div>
            )}
          </div>

          <div className="mt-3 max-h-[70vh] space-y-3 overflow-y-auto">
            {history.length === 0 && (
              <p className="py-4 text-center text-sm text-ink-subtle">Хадгалсан постер алга</p>
            )}
            {history.length > 0 && visibleHistoryGroups.every((group) => group.items.length === 0) && (
              <p className="py-4 text-center text-sm text-ink-subtle">Хайлтад тохирох аялал алга</p>
            )}
            {visibleHistoryGroups.map((group) => (
              <div key={group.label || "all"} className="space-y-1.5">
                {group.label && (
                  <p className="text-xs font-medium uppercase tracking-wide text-ink-subtle">{group.label}</p>
                )}
                {group.items.map((h, index) => {
                  const duplicateCount = historyTitleCounts.get(normalizeHistoryTitle(h.title)) || 0;
                  return (
                    <div
                      key={h.id}
                      className={cx(
                        "flex items-start gap-2 rounded-lg border p-2",
                        duplicateCount > 1 ? "border-warning/40 bg-warning-soft" : "border-line hover:border-line-strong",
                      )}
                    >
                      <span className="mt-0.5 shrink-0 text-xs text-ink-subtle">{index + 1}</span>
                      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => openTrip(h.id)}>
                        <p className="truncate text-sm font-medium text-ink">{h.title}</p>
                        <p className="truncate text-xs text-ink-subtle">
                          {h.source_file && <span className="mr-1">{h.source_file}</span>}
                          {new Date(h.updated_at).toLocaleString()}
                        </p>
                        {duplicateCount > 1 && (
                          <Badge tone="warning" className="mt-1">Ижил нэр x{duplicateCount}</Badge>
                        )}
                      </button>
                      <button
                        type="button"
                        className="shrink-0 rounded-md p-1 text-ink-muted hover:bg-surface-sunken hover:text-danger"
                        title="Постер устгах"
                        onClick={() => deleteTrip(h.id)}
                        disabled={!!busy}
                      >
                        <Icons.trash size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </Card>
      </div>

      <AttachToTripModal
        open={attachModalOpen}
        onClose={() => setAttachModalOpen(false)}
        posterTitle={trip?.title || ""}
        posterTrip={trip}
        apiFetch={apiFetch}
        captureImages={captureForAttach}
        onDone={() => {}}
      />
    </div>
  );
}
