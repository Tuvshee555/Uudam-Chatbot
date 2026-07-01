"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as htmlToImage from "html-to-image";
import Poster from "./Poster";
import { createDefaultTrip } from "@/lib/poster/defaultTrip";

const POSTER_WIDTH = 1080;
const MESSENGER_SINGLE_IMAGE_MAX_HEIGHT = 1900;
const MESSENGER_MAX_IMAGE_SLICES = 3;
const MAX_UPLOAD_FILES = 10;
const MAX_UPLOAD_SIZE_MB = 100;
const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;

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

  // Upload the raw file to the chatbot in <4MB base64 chunks (Vercel body cap),
  // reassembled server-side. The final chunk returns the extracted trip JSON.
  async function extractOne(file) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const CHUNK_BYTES = 3 * 1024 * 1024; // ~4MB base64, under the 5mb route limit
    const totalChunks = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
    const uploadId = `${Date.now()}-${Math.round(scale * 1e6)}-${file.name.length}-${bytes.length}`;

    let last = null;
    for (let i = 0; i < totalChunks; i++) {
      const slice = bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
      // base64-encode this slice
      let binary = "";
      const sub = 0x8000;
      for (let j = 0; j < slice.length; j += sub) {
        binary += String.fromCharCode(...slice.subarray(j, j + sub));
      }
      const chunkB64 = btoa(binary);

      last = await fetchJson("/api/admin/poster/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uploadId,
          filename: file.name,
          mimeType: file.type || "",
          chunkIndex: i,
          totalChunks,
          chunk: chunkB64,
        }),
      });
      if (last.error) throw new Error(last.error);
    }
    // `last` is the final response = { trip, source_file }
    return last;
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

  function chooseMessengerSplitPoint(node) {
    const totalHeight = node.offsetHeight;
    const target = totalHeight / 2;
    const minY = totalHeight * 0.38;
    const maxY = totalHeight * 0.72;
    const candidates = [];

    node.querySelectorAll(".dayrow,.program-head,.sec.compact-sec,.foot").forEach((el) => {
      const top = getRelativeTop(el, node);
      if (top > minY && top < maxY) candidates.push(top);
    });

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
    const candidates = [];
    node.querySelectorAll(".dayrow,.program-head,.sec.compact-sec,.foot").forEach((el) => {
      const top = getRelativeTop(el, node);
      if (top > totalHeight * 0.18 && top < totalHeight * 0.88) candidates.push(top);
    });

    const points = [];
    for (let i = 1; i < sliceCount; i++) {
      const target = (totalHeight * i) / sliceCount;
      const minGap = totalHeight * 0.18;
      const eligible = candidates.filter((point) => points.every((existing) => Math.abs(existing - point) > minGap));
      const best = (eligible.length ? eligible : candidates).reduce((currentBest, current) =>
        Math.abs(current - target) < Math.abs(currentBest - target) ? current : currentBest,
        target
      );
      points.push(best);
    }

    return points.sort((a, b) => a - b).map(Math.round);
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
    <div className="poster-root">
      {busy && (
        <div className="loading-bar-wrap">
          <div className="loading-bar" />
          <div className="loading-label">{busy}</div>
        </div>
      )}
      <div className="appbar">
        <img src="/poster/uudam-logo.jpg" alt="" />
        <h1>UUDAM — Постер үүсгэгч</h1>
        <span className="sub">China doc → AI → брэнд постер</span>
      </div>

      <div className="layout">
        <div className="main" ref={mainRef}>
          {trip ? (
            /* Compact upload strip — shown when a poster is already open */
            <div
              className="upload-strip"
              onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add("over"); }}
              onDragLeave={(e) => e.currentTarget.classList.remove("over")}
              onDrop={(e) => { e.preventDefault(); e.currentTarget.classList.remove("over"); handleFiles(e.dataTransfer.files); }}
            >
              <label className="upload-strip-file">
                <input type="file" multiple accept=".pdf,.docx,.txt,image/*" style={{ display: "none" }} onChange={(e) => handleFiles(e.target.files)} />
                <span className="upload-strip-ic">⬆</span>
                <span className="upload-strip-label">Шинэ файл чирж тавих эсвэл дарах</span>
              </label>
              <button type="button" className="btn ghost upload-strip-tpl" onClick={startTemplate}>Хоосон template</button>
            </div>
          ) : (
            /* Full uploader — shown on empty state */
            <div className="uploader">
              <div className="lead">
                Хятадаас ирсэн файлаa оруулаад, брэнд постер бэлэн.
                <small>AI уншиж, аяллын постерийг ~10 секундэд үүсгэнэ.</small>
              </div>
              <label
                className="drop"
                onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add("over"); }}
                onDragLeave={(e) => e.currentTarget.classList.remove("over")}
                onDrop={(e) => { e.preventDefault(); e.currentTarget.classList.remove("over"); handleFiles(e.dataTransfer.files); }}
              >
                <input type="file" multiple accept=".pdf,.docx,.txt,image/*" style={{ display: "none" }} onChange={(e) => handleFiles(e.target.files)} />
                <div className="ic">⬆</div>
                <div className="dt">Файл эсвэл зураг энд чирж тавь</div>
                <div className="ds">{`Дээд тал нь ${MAX_UPLOAD_FILES} файл · тус бүр ${MAX_UPLOAD_SIZE_MB}MB хүртэл · Word (.docx), PDF, .txt · JPG, PNG, WEBP зураг`}</div>
              </label>
              <div className="template-start">
                <button type="button" className="btn" onClick={startTemplate}>Default template-ээр эхлэх</button>
                <span>Файлгүйгээр шууд poster нээгээд бүх текст, үнэ, өдөр, хоол, зураг засна.</span>
              </div>
            </div>
          )}
          {busy && <div className="note" style={{ marginTop: 10, textAlign: "center" }}>⏳ {busy}</div>}
          {error && <div className="err" style={{ textAlign: "center" }}>⚠ {error}</div>}

          {trip && (
            <>
              <div className="studio-panel">
                <div className="studio-head">
                  <div>
                    <div className="eyebrow">Workspace</div>
                    <h2>{trip.title || "Untitled poster"}</h2>
                    <p>{source || "Live editable travel poster"} · {trip.days?.length || 0} өдөр · 1 export page</p>
                  </div>
                  <button className="btn ghost" type="button" onClick={startTemplate} disabled={!!busy}>
                    Шинэ default template
                  </button>
                </div>

                <div className="studio-actions">
                  <button type="button" onClick={addDeparture}>+ Огноо</button>
                  <button type="button" onClick={addDay}>+ Өдөр</button>
                  <button type="button" onClick={removeLastDay} disabled={(trip.days || []).length <= 1}>Сүүлийн өдөр устгах</button>
                  <button type="button" onClick={ensurePriceTable}>Үнийн хүснэгт асаах</button>
                  <button type="button" onClick={addPriceRow} disabled={!trip.price_table}>+ Үнэ мөр</button>
                  <button type="button" onClick={addPriceCol} disabled={!trip.price_table}>+ Үнэ багана</button>
                  <button type="button" onClick={toggleFlights}>{trip.flights ? "Нислэг нуух" : "Нислэг нэмэх"}</button>
                </div>

                <div className="edit-hints">
                  <span>Canvas маягаар: постер дээрх бичвэр дээр шууд дарж засна.</span>
                  <span>Зураг: нүүр зураг toolbar-аас, өдрийн зураг тухайн зурагны box дээр дарж орно.</span>
                  <span>Download/print үед editor товч, хоосон зурагны box автоматаар алга болно.</span>
                </div>
              </div>

              <div className="toolbar">
                <button className="btn" onClick={save} disabled={!!busy}>💾 Хадгалах</button>
                <button className="btn ghost" onClick={downloadPng} disabled={!!busy}>🖼 PNG (нэг poster)</button>
                <button className="btn ghost" onClick={downloadPdf} disabled={!!busy}>📑 PDF</button>
                <button className="btn ghost" onClick={downloadSplitImages} disabled={!!busy}>💬 Messenger Split</button>
                <button className="btn ghost" onClick={downloadSplitZip} disabled={!!busy}>🗜 Messenger ZIP</button>
                <span className="note" style={{ alignSelf: "center" }}>
                  Бичвэр дээр дарж засаарай · хоолны таглыг дарж асаах/унтраах · Messenger split: main poster-оос 1-2 зураг, хэт урт бол 3
                </span>
              </div>

              <div className="preview-shell" style={{ width: POSTER_WIDTH * scale, height: totalH * scale }}>
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
            </>
          )}
        </div>

        <div className="sidebar">
          <div className="card">
            <div className="hist-head">
              <h3>Түүх</h3>
              <span>{history.length}</span>
              {history.length > 0 && (
                <button
                  type="button"
                  className="btn ghost hist-export-btn"
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
                  ⬇ Татах
                </button>
              )}
            </div>
            <div className="hist-controls">
              <label className="hist-search">
                <span>Хайх</span>
                <input
                  value={historySearch}
                  onChange={(e) => setHistorySearch(e.target.value)}
                  placeholder="Нэрээр хайх..."
                />
              </label>
              <div className="hist-filters">
                <label>
                  Эрэмбэ
                  <select value={historySort} onChange={(e) => setHistorySort(e.target.value)}>
                    <option value="newest">Шинэ эхэнд</option>
                    <option value="oldest">Хуучин эхэнд</option>
                    <option value="title">Нэрээр</option>
                  </select>
                </label>
                <label>
                  Бүлэг
                  <select value={historyGroup} onChange={(e) => setHistoryGroup(e.target.value)}>
                    <option value="date">Огноогоор</option>
                    <option value="duplicate">Давхардлаар</option>
                    <option value="none">Бүлэггүй</option>
                  </select>
                </label>
              </div>
              {trip && currentDuplicateCount > (tripId ? 1 : 0) && (
                <div className="hist-warning">Ижил нэртэй хадгалсан аялал байна.</div>
              )}
            </div>
            <div className="hist">
              {history.length === 0 && <div className="note">Хадгалсан постер алга</div>}
              {history.length > 0 && visibleHistoryGroups.every((group) => group.items.length === 0) && (
                <div className="note">Хайлтад тохирох аялал алга</div>
              )}
              {visibleHistoryGroups.map((group) => (
                <div className="hist-group" key={group.label || "all"}>
                  {group.label && <div className="hist-group-title">{group.label}</div>}
                  {group.items.map((h, index) => {
                    const duplicateCount = historyTitleCounts.get(normalizeHistoryTitle(h.title)) || 0;
                    return (
                      <div className={"hist-item" + (duplicateCount > 1 ? " duplicate" : "")} key={h.id}>
                        <div className="hist-num">{index + 1}</div>
                        <button type="button" className="hist-open" onClick={() => openTrip(h.id)}>
                          <div className="t">{h.title}</div>
                          <div className="d">
                            {h.source_file && <span className="hist-src">{h.source_file}</span>}
                            {new Date(h.updated_at).toLocaleString()}
                          </div>
                          {duplicateCount > 1 && <div className="dup-badge">Ижил нэр x{duplicateCount}</div>}
                        </button>
                        <button
                          type="button"
                          className="hist-delete"
                          title="Постер устгах"
                          onClick={() => deleteTrip(h.id)}
                          disabled={!!busy}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
