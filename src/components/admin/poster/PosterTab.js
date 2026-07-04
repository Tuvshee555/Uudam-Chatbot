"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as htmlToImage from "html-to-image";
import { upload as uploadToBlob } from "@vercel/blob/client";
import Poster from "./Poster";
import AttachToTripModal from "./AttachToTripModal";
import { createDefaultTrip } from "@/lib/poster/defaultTrip";
import { Badge, Button, Card, Icons, Input, Select, Spinner, cx } from "@/components/ui";

const ADMIN_SECRET_STORAGE_KEY = "travel_admin_secret";
const POSTER_WIDTH = 1080;
const MESSENGER_SINGLE_IMAGE_MAX_HEIGHT = 1900;
const MESSENGER_MAX_IMAGE_SLICES = 3;
const MAX_UPLOAD_FILES = 10;
const MAX_UPLOAD_SIZE_MB = 100;
const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;
// Vercel's serverless request-body cap is 4.5MB. Direct multipart upload is
// the reliable path (Blob has repeatedly failed us: missing tokens, silent
// hangs), so use as much of that cap as possible — Blob is a last resort for
// the rare genuinely-huge file. 4.4MB leaves ~100KB for multipart framing;
// typical ~4,000KB poster PDFs now go direct instead of detouring via Blob.
const DIRECT_UPLOAD_LIMIT_BYTES = Math.floor(4.4 * 1024 * 1024);

function getStoredAdminSecret() {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(ADMIN_SECRET_STORAGE_KEY) || "";
}

function setPath(obj, path, value) {
  const clone = structuredClone(obj);
  let o = clone;
  for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
  o[path[path.length - 1]] = value;
  return clone;
}

function resizeImage(file, maxW = 1500) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxW / img.width);
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL("image/jpeg", 0.82));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function tableFromPriceNote(note) {
  const text = String(note || "").replace(/^⚠\s*/, "").trim();
  if (!text) return null;

  const matches = [...text.matchAll(/(\d[\d\s,'’]*\d)\s*₮/g)];
  if (matches.length < 2) return null;

  let cursor = 0;
  const columns = [];
  const cells = [];
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
    const paren = text.slice(match.index + match[0].length).match(/^\s*(\([^)]*\))/);
    const end = match.index + match[0].length + (paren ? paren[0].length : 0);

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

function normalizeTripData(trip) {
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
    clone.price_table.columns = (clone.price_table.columns || []).filter((x) => String(x || "").trim());
    const colCount = clone.price_table.columns.length;

    // Normalize rows: filter empty, pad/clamp cells
    const cleaned = (clone.price_table.rows || [])
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
    const merged = [];
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

    clone.price_table.rows = merged;
  }
  return clone;
}

function normalizeHistoryTitle(title) {
  return String(title || "Untitled")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function historyDateLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Огноогүй";
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (sameDay(date, today)) return "Өнөөдөр";
  if (sameDay(date, yesterday)) return "Өчигдөр";
  return date.toLocaleDateString();
}

export default function PosterTab({ apiFetch }) {
  // apiFetch(url, init) injects the admin secret header (from admin.tsx).
  const fetchJson = async (url, init) => {
    const res = await apiFetch(url, init);
    const text = await res.text();
    let json = {};
    if (text) {
      try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 300) }; }
    }
    if (!res.ok && !json.error) json.error = `HTTP ${res.status}`;
    return json;
  };

  const [trip, setTrip] = useState(null);
  const [tripId, setTripId] = useState(null);
  const [source, setSource] = useState("");
  const [history, setHistory] = useState([]);
  const [historySearch, setHistorySearch] = useState("");
  const [historySort, setHistorySort] = useState("newest");
  const [historyGroup, setHistoryGroup] = useState("date");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [scale, setScale] = useState(0.6);
  const [totalH, setTotalH] = useState(0);
  const [attachModalOpen, setAttachModalOpen] = useState(false);

  const page1Ref = useRef(null);
  const previewRef = useRef(null);
  const mainRef = useRef(null);
  const dayPhotoInputRefs = useRef({});

  const upd = (path, value) => setTrip((t) => setPath(t, path, value));

  const historyTitleCounts = useMemo(() => {
    const counts = new Map();
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
      if (historySort === "oldest") return new Date(a.updated_at) - new Date(b.updated_at);
      if (historySort === "title") return String(a.title || "").localeCompare(String(b.title || ""));
      return new Date(b.updated_at) - new Date(a.updated_at);
    });

    if (historyGroup === "none") return [{ label: "", items: filtered }];

    const groups = new Map();
    for (const item of filtered) {
      const duplicateCount = historyTitleCounts.get(normalizeHistoryTitle(item.title)) || 0;
      let label = historyDateLabel(item.updated_at);
      if (historyGroup === "duplicate") label = duplicateCount > 1 ? "Давхардсан нэртэй" : "Давхардаагүй";
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(item);
    }

    return Array.from(groups, ([label, items]) => ({ label, items }));
  }, [history, historyGroup, historySearch, historySort, historyTitleCounts]);

  const currentDuplicateCount = trip
    ? [...historyTitleCounts.entries()].find(([key]) => key === normalizeHistoryTitle(trip.title))?.[1] || 0
    : 0;

  const startTemplate = () => {
    setError("");
    setBusy("");
    setTrip(normalizeTripData(createDefaultTrip()));
    setTripId(null);
    setSource("Default template");
  };

  const addItem = (path, value) =>
    setTrip((t) => {
      const clone = structuredClone(t);
      let o = clone;
      for (const p of path) o = o[p];
      o.push(value);
      return normalizeTripData(clone);
    });

  const removeItem = (path, idx) =>
    setTrip((t) => {
      const clone = structuredClone(t);
      let o = clone;
      for (const p of path) o = o[p];
      o.splice(idx, 1);
      return normalizeTripData(clone);
    });

  const addDeparture = () => addItem(["departures"], { date: "Шинэ огноо" });

  const newDayObj = () => ({
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
      const clone = structuredClone(t);
      clone.days ||= [];
      clone.days.push(newDayObj());
      return normalizeTripData(clone);
    });

  const insertDay = (afterIndex) =>
    setTrip((t) => {
      const clone = structuredClone(t);
      clone.days ||= [];
      clone.days.splice(afterIndex + 1, 0, newDayObj());
      return normalizeTripData(clone);
    });

  const reorderDay = (fromIdx, toIdx) =>
    setTrip((t) => {
      const clone = structuredClone(t);
      const days = clone.days || [];
      const [moved] = days.splice(fromIdx, 1);
      days.splice(toIdx, 0, moved);
      clone.days = days;
      return normalizeTripData(clone);
    });

  const removeLastDay = () =>
    setTrip((t) => {
      const clone = structuredClone(t);
      clone.days = (clone.days || []).slice(0, -1);
      return normalizeTripData(clone);
    });

  const ensurePriceTable = () =>
    setTrip((t) => {
      const clone = structuredClone(t);
      clone.price_table ||= { columns: ["Том хүн", "Хүүхэд"], rows: [], note: "" };
      if (!clone.price_table.columns?.length) clone.price_table.columns = ["Том хүн", "Хүүхэд"];
      clone.price_table.rows ||= [];
      if (clone.price_table.rows.length === 0) {
        clone.price_table.rows.push({ dates: "Шинэ огноо", cells: clone.price_table.columns.map(() => "") });
      }
      return normalizeTripData(clone);
    });

  const addPriceRow = () =>
    setTrip((t) => {
      const clone = structuredClone(t);
      clone.price_table ||= { columns: ["Том хүн", "Хүүхэд"], rows: [], note: "" };
      const cols = clone.price_table.columns?.length || 2;
      clone.price_table.rows ||= [];
      clone.price_table.rows.push({ dates: "Шинэ огноо", cells: Array.from({ length: cols }, () => "") });
      return clone;
    });

  const addPriceCol = () =>
    setTrip((t) => {
      const clone = structuredClone(t);
      if (!clone.price_table) return clone;
      clone.price_table.columns.push("Шинэ багана");
      clone.price_table.rows = clone.price_table.rows.map((r) => ({
        ...r,
        cells: [...r.cells, ""],
      }));
      return clone;
    });

  const removePriceCol = (ci) =>
    setTrip((t) => {
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
    if (r.trips) setHistory(r.trips);
  };

  useEffect(() => {
    loadHistory();
  }, []);

  async function sha256File(file) {
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
  function isLocalDevHost() {
    if (typeof window === "undefined") return false;
    return ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
  }

  async function extractOne(file) {
    // Local dev has no Vercel 60s kill, and its server budget is 5 min —
    // give the client the same room so slow local runs aren't cut at 90s.
    const timeoutMs = isLocalDevHost() ? 300 * 1000 : EXTRACT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      if (file.size > DIRECT_UPLOAD_LIMIT_BYTES && !isLocalDevHost()) {
        const blob = await uploadToBlob(file.name, file, {
          access: "public",
          handleUploadUrl: "/api/admin/poster/upload",
          headers: { "x-admin-secret": getStoredAdminSecret() },
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
      if (e?.name === "AbortError" || /abort/i.test(String(e?.message || ""))) {
        throw new Error(`Хүсэлт хэт удаж зогслоо (${timeoutMs / 1000}s). Файл хэт том эсвэл сервер ачаалалтай байж магадгүй — дахин оролдоно уу.`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let json = {};
    if (text) {
      try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 300) }; }
    }
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    if (json.error) throw new Error(json.error);
    return { ...json, source_file: json.source_file || file.name };
  }

  async function saveTripData(data, sourceFile) {
    const cleanTrip = normalizeTripData(data);
    const r = await fetchJson("/api/admin/poster/trips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: cleanTrip.title, data: cleanTrip, source_file: sourceFile }),
    });
    if (r.error) throw new Error(r.error);
    return { id: r.id, trip: cleanTrip };
  }

  async function handleFiles(files) {
    if (!files || files.length === 0) return;
    setError("");
    let fileList = Array.from(files).filter((f) => f instanceof File);
    const droppedCount = fileList.length;
    const warnings = [];

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

    const seen = new Set();
    const uniqueFiles = [];
    for (const file of fileList) {
      const hash = await sha256File(file);
      if (seen.has(hash)) {
        warnings.push(`${file.name} нөгөө файлтай ижиг агуулгатай байсан тул алгаслаа.`);
      } else {
        seen.add(hash);
        uniqueFiles.push(file);
      }
    }

    const saved = [];
    const failed = [];

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
        failed.push({ file: file.name, error: String(e.message || e) });
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

  async function capture(node) {
    const imgs = Array.from(node.querySelectorAll("img"));
    await Promise.all(
      imgs.map(async (img) => {
        if (!img.complete || !img.naturalWidth) {
          await new Promise((resolve) => {
            const done = () => resolve();
            img.addEventListener("load", done, { once: true });
            img.addEventListener("error", done, { once: true });
          });
        }
        if (img.decode) {
          try {
            await img.decode();
          } catch {}
        }
      })
    );

    if (document.fonts?.ready) await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    return htmlToImage.toPng(node, {
      pixelRatio: 2,
      width: node.offsetWidth,
      height: node.offsetHeight,
      backgroundColor: "#ffffff",
      style: { transform: "none", margin: "0", boxShadow: "none" },
      filter: (domNode) => !domNode.classList?.contains("editor-only") && !domNode.classList?.contains("hidden-input"),
    });
  }

  async function withExportMode(work) {
    document.body.classList.add("exporting");
    try {
      return await work();
    } finally {
      document.body.classList.remove("exporting");
    }
  }

  function buildExportBaseName() {
    return (trip?.title || "poster")
      .slice(0, 40)
      .replace(/[\\/:*?"<>|]/g, "")
      .trim() || "poster";
  }

  function getRelativeTop(node, container) {
    return node.getBoundingClientRect().top - container.getBoundingClientRect().top;
  }

  function getMessengerSplitCandidates(node) {
    const totalHeight = node.offsetHeight;
    const candidates = [];

    node.querySelectorAll(".dayrow,.program-head,.sec.compact-sec,.foot").forEach((el) => {
      const top = getRelativeTop(el, node);
      // Only split at real section/day boundaries, and avoid tiny header/footer slivers.
      if (top > totalHeight * 0.12 && top < totalHeight * 0.92) candidates.push(top);
    });

    return Array.from(new Set(candidates.map(Math.round))).sort((a, b) => a - b);
  }

  function chooseMessengerSplitPoint(node) {
    const totalHeight = node.offsetHeight;
    const target = totalHeight / 2;
    const minY = totalHeight * 0.38;
    const maxY = totalHeight * 0.72;
    const candidates = getMessengerSplitCandidates(node).filter((top) => top > minY && top < maxY);

    if (!candidates.length) return Math.round(target);

    return Math.round(
      candidates.reduce((best, current) =>
        Math.abs(current - target) < Math.abs(best - target) ? current : best
      )
    );
  }

  function chooseMessengerSplitPoints(node, sliceCount) {
    if (sliceCount <= 1) return [];
    if (sliceCount === 2) return [chooseMessengerSplitPoint(node)];

    const totalHeight = node.offsetHeight;
    const targets = Array.from({ length: sliceCount - 1 }, (_, i) => (totalHeight * (i + 1)) / sliceCount);
    const candidates = getMessengerSplitCandidates(node).filter((point) => point > totalHeight * 0.16 && point < totalHeight * 0.9);

    if (candidates.length < sliceCount - 1) {
      return targets.map(Math.round);
    }

    let bestPoints = targets;
    let bestScore = Infinity;

    const scorePoints = (points) => {
      const sorted = [...points].sort((a, b) => a - b);
      const ranges = [0, ...sorted, totalHeight].map((startY, index, all) => all[index + 1] - startY).filter(Boolean);
      const ideal = totalHeight / sliceCount;
      const maxRange = Math.max(...ranges);
      const minRange = Math.min(...ranges);
      const balancePenalty = ranges.reduce((sum, height) => sum + Math.abs(height - ideal), 0);
      const targetPenalty = sorted.reduce((sum, point, index) => sum + Math.abs(point - targets[index]), 0);
      const hugeSlicePenalty = Math.max(0, maxRange - MESSENGER_SINGLE_IMAGE_MAX_HEIGHT) * 3;
      const tinySlicePenalty = Math.max(0, totalHeight * 0.16 - minRange) * 4;
      return balancePenalty * 1.4 + targetPenalty + hugeSlicePenalty + tinySlicePenalty;
    };

    function visit(startIndex, picked) {
      if (picked.length === sliceCount - 1) {
        const score = scorePoints(picked);
        if (score < bestScore) {
          bestScore = score;
          bestPoints = [...picked];
        }
        return;
      }

      const remainingNeeded = sliceCount - 1 - picked.length;
      for (let i = startIndex; i <= candidates.length - remainingNeeded; i++) {
        const point = candidates[i];
        const previous = picked[picked.length - 1] ?? 0;
        if (point - previous < totalHeight * 0.14) continue;
        visit(i + 1, [...picked, point]);
      }
    }

    visit(0, []);
    return bestPoints.sort((a, b) => a - b).map(Math.round);
  }

  function drawMessengerBadge(ctx, width, height, index, total) {
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

  async function captureMessengerSlices() {
    const node = page1Ref.current;
    if (!node) return [];

    const fullUrl = await capture(node);
    const fullImage = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = fullUrl;
    });

    const totalHeight = node.offsetHeight;
    const sliceCount = Math.min(
      MESSENGER_MAX_IMAGE_SLICES,
      Math.max(1, Math.ceil(totalHeight / MESSENGER_SINGLE_IMAGE_MAX_HEIGHT))
    );
    const splitPoints = chooseMessengerSplitPoints(node, sliceCount);
    const ranges = [0, ...splitPoints, totalHeight].map((startY, index, points) => [startY, points[index + 1]]).filter((range) => range[1]);
    const scaleY = fullImage.height / totalHeight;

    return ranges.map(([startY, endY], index) => {
      const sourceY = Math.round(startY * scaleY);
      const sourceHeight = Math.round((endY - startY) * scaleY);
      const canvas = document.createElement("canvas");
      canvas.width = fullImage.width;
      canvas.height = sourceHeight;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(fullImage, 0, sourceY, fullImage.width, sourceHeight, 0, 0, canvas.width, canvas.height);
      drawMessengerBadge(ctx, canvas.width, canvas.height, index, ranges.length);

      return {
        index,
        url: canvas.toDataURL("image/png"),
      };
    });
  }

  // Renders the poster as Messenger-sized images for AttachToTripModal — the
  // same finished, branded poster the customer will actually see.
  async function captureForAttach() {
    const slices = await withExportMode(() => captureMessengerSlices());
    return slices.map((s) => s.url);
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
      setError(String(e.message || e));
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
      setError(String(e.message || e));
    } finally {
      setBusy("");
    }
  }

  async function downloadPng() {
    setBusy("Зураг бэлдэж байна…");
    try {
      await withExportMode(async () => {
        const nodes = [page1Ref.current].filter(Boolean);
        for (let i = 0; i < nodes.length; i++) {
          const url = await capture(nodes[i]);
          const a = document.createElement("a");
          a.href = url;
          a.download = `${(trip.title || "poster").slice(0, 30)}-${i + 1}.png`;
          a.click();
        }
      });
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy("");
    }
  }

  async function downloadPdf() {
    setBusy("PDF бэлдэж байна…");
    try {
      await withExportMode(async () => {
        const { jsPDF } = await import("jspdf");
        const nodes = [page1Ref.current].filter(Boolean);
        let pdf;
        for (let i = 0; i < nodes.length; i++) {
          const url = await capture(nodes[i]);
          const w = nodes[i].offsetWidth;
          const h = nodes[i].offsetHeight;
          if (i === 0) pdf = new jsPDF({ orientation: "p", unit: "px", format: [w, h] });
          else pdf.addPage([w, h], "p");
          pdf.addImage(url, "PNG", 0, 0, w, h);
        }
        pdf.save(`${(trip.title || "poster").slice(0, 30)}.pdf`);
      });
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy("");
    }
  }

  async function onDayPhotoFile(index, file) {
    if (!file) return;
    setBusy("Өдрийн зураг нэмж байна…");
    try {
      const dataUrl = await resizeImage(file, 1400);
      setTrip((t) => {
        const clone = structuredClone(t);
        const day = clone.days?.[index];
        if (!day) return t;
        day.photo = dataUrl;
        if (!day.photo_caption) day.photo_caption = day.summary || day.route || "";
        return normalizeTripData(clone);
      });
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy("");
      if (dayPhotoInputRefs.current[index]) dayPhotoInputRefs.current[index].value = "";
    }
  }

  async function save() {
    setError("");
    setBusy("Хадгалж байна…");
    try {
      const cleanTrip = normalizeTripData(trip);
      const matchingTitles = history.filter((item) => {
        if (item.id === tripId) return false;
        return normalizeHistoryTitle(item.title) === normalizeHistoryTitle(cleanTrip.title);
      });
      const r = await fetchJson("/api/admin/poster/trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: tripId, title: cleanTrip.title, data: cleanTrip, source_file: source }),
      });
      if (r.error) throw new Error(r.error);
      setTrip(cleanTrip);
      setTripId(r.id);
      await loadHistory();
      if (matchingTitles.length > 0) {
        setError(`Ижил нэртэй ${matchingTitles.length} хадгалсан аялал байна: "${cleanTrip.title}"`);
      }
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy("");
    }
  }

  async function openTrip(id) {
    setBusy("Ачааллаж байна…");
    try {
      const r = await fetchJson(`/api/admin/poster/trip?id=${encodeURIComponent(id)}`);
      if (r.error) throw new Error(r.error);
      setTrip(normalizeTripData(r.trip.data));
      setTripId(r.trip.id);
      setSource(r.trip.source_file || "");
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy("");
    }
  }

  async function deleteTrip(id) {
    const previousHistory = history;
    setHistory((items) => items.filter((item) => item.id !== id));
    if (tripId === id) {
      setTrip(null);
      setTripId(null);
      setSource("");
    }

    try {
      const r = await fetchJson(`/api/admin/poster/trip?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (r.error) throw new Error(r.error);
    } catch (e) {
      setHistory(previousHistory);
      setError(String(e.message || e));
    }
  }

  return (
    <div className="space-y-3">
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
                  <Button size="sm" variant="secondary" onClick={downloadPng} disabled={!!busy}>
                    <Icons.image size={14} /> PNG
                  </Button>
                  <Button size="sm" variant="secondary" onClick={downloadPdf} disabled={!!busy}>
                    <Icons.file size={14} /> PDF
                  </Button>
                  <Button size="sm" variant="secondary" onClick={downloadSplitImages} disabled={!!busy}>
                    Messenger Split
                  </Button>
                  <Button size="sm" variant="secondary" onClick={downloadSplitZip} disabled={!!busy}>
                    Messenger ZIP
                  </Button>
                </div>
                <p className="mt-2 text-xs text-ink-subtle">
                  Бичвэр дээр дарж засаарай · хоолны таглыг дарж асаах/унтраах · Messenger split: main poster-оос 1-2 зураг, хэт урт бол 3
                </p>
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
              <Select value={historySort} onChange={(e) => setHistorySort(e.target.value)}>
                <option value="newest">Шинэ эхэнд</option>
                <option value="oldest">Хуучин эхэнд</option>
                <option value="title">Нэрээр</option>
              </Select>
              <Select value={historyGroup} onChange={(e) => setHistoryGroup(e.target.value)}>
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
