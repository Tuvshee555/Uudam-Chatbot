/**
 * "Бүх аяллын мэдээлэл" PDF — a human-readable catalogue of every trip the bot
 * knows, built in the browser and downloaded as a single file.
 *
 * Why a real PDF and not a print view: the client is not technical and asked for
 * a file she can save, forward and open on a phone. Why an embedded font: the
 * jsPDF built-ins (and Liberation Sans) have no Ө/Ү/₮ glyphs, so Mongolian text
 * silently renders as blanks. Noto Sans (OFL, in /public/fonts) covers all of
 * them and is fetched only when the button is pressed.
 *
 * Every value comes from `trip.extra` — the admin API returns trips with the
 * structured fields still nested there, NOT flattened onto the row, even though
 * the client-side TravelTrip type lists them at the top level. Reading the top
 * level would produce a confident, empty catalogue.
 */

import type { jsPDF } from "jspdf";
import type { TravelTrip } from "./adminTypes";

/* ---------------------------------------------------------------- layout */

const PAGE_W = 210; // A4 mm
const PAGE_H = 297;
const MARGIN = 14;
const CONTENT_W = PAGE_W - MARGIN * 2;
const FOOTER_H = 12;
const BODY_BOTTOM = PAGE_H - FOOTER_H;
/** Vertical space one section heading consumes (gap + label + rule). */
const HEADING_H = 10.3;

const FONT = "NotoSans";
const BRAND: RGB = [15, 118, 110];
const INK: RGB = [23, 25, 26];
const INK_MUTED: RGB = [90, 97, 99];
const INK_SUBTLE: RGB = [141, 147, 149];
const LINE: RGB = [214, 217, 213];
const SOFT: RGB = [231, 244, 242];
const WARN: RGB = [138, 84, 20];

type RGB = [number, number, number];

/** Cloudinary derivative used for catalogue photos. Full-size posters are up to
 *  2160x8192; embedding those raw would produce a several-hundred-MB file. */
const PHOTO_TRANSFORM = "f_jpg,q_75,c_limit,w_1200,h_1600";

const STATUS_MN: Record<string, string> = {
  active: "Идэвхтэй",
  cancelled: "Цуцлагдсан",
  sold_out: "Суудал дүүрсэн",
  draft: "Ноорог",
  archived: "Архив",
};

/* ---------------------------------------------------------------- helpers */

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
}

function objList(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is Record<string, unknown> => !!v && typeof v === "object");
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value.replace(/[,\s]/g, ""));
    if (Number.isFinite(n) && value.trim() !== "") return n;
  }
  return null;
}

/** Money for humans: `1 850 000₮`. Never invents a zero for a missing price —
 *  an empty cell means "not set", which is not the same as free. */
function money(value: unknown, currency = "MNT"): string {
  const n = num(value);
  if (n == null) return "—";
  const grouped = Math.round(n).toLocaleString("mn-MN").replace(/,/g, " ");
  return currency === "MNT" || !currency ? `${grouped}₮` : `${grouped} ${currency}`;
}

/** `2026.07.26 14:30`. The API hands the browser an ISO string, but a direct
 *  DB read hands back a Date — accept either rather than printing raw. */
function dateTime(value: unknown): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return text(value);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}.${p(date.getMonth() + 1)}.${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

function yesNo(value: unknown): string {
  if (value === true) return "Тийм";
  if (value === false) return "Үгүй";
  return "—";
}

/** Reads a structured field from `extra` first, then the flattened top level. */
function field(trip: TravelTrip, key: string): unknown {
  const extra = (trip.extra || {}) as Record<string, unknown>;
  if (key in extra) return extra[key];
  return (trip as unknown as Record<string, unknown>)[key];
}

function photoUrlFor(url: string): string {
  if (!url.startsWith("https://res.cloudinary.com/")) return url;
  if (!url.includes("/image/upload/")) return url;
  if (url.includes(`/image/upload/${PHOTO_TRANSFORM}/`)) return url;
  return url.replace("/image/upload/", `/image/upload/${PHOTO_TRANSFORM}/`);
}

function todayLabel(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fileStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ------------------------------------------------------- font + image i/o */

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000; // chunked — String.fromCharCode(...500k bytes) blows the stack
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

let fontCache: { regular: string; bold: string } | null = null;

async function loadFonts(): Promise<{ regular: string; bold: string }> {
  if (fontCache) return fontCache;
  const [regular, bold] = await Promise.all(
    ["/fonts/NotoSans-Regular.ttf", "/fonts/NotoSans-Bold.ttf"].map(async (path) => {
      const res = await fetch(path);
      if (!res.ok) throw new Error(`font_fetch_failed:${path}:${res.status}`);
      return toBase64(await res.arrayBuffer());
    }),
  );
  fontCache = { regular, bold };
  return fontCache;
}

export type LoadedPhoto = { dataUrl: string; width: number; height: number };

/** Fetches one photo as a data URL. Returns null instead of throwing: a dead
 *  Cloudinary link or a CORS refusal must not cost the client the whole file. */
async function loadPhoto(url: string): Promise<LoadedPhoto | null> {
  try {
    const res = await fetch(photoUrlFor(url), { mode: "cors", cache: "force-cache" });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.type.startsWith("image/")) return null;
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("read_failed"));
      reader.readAsDataURL(blob);
    });
    const size = await new Promise<{ width: number; height: number } | null>((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
    if (!size || !size.width || !size.height) return null;
    return { dataUrl, width: size.width, height: size.height };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- doc writer */

/** Thin cursor-based writer over jsPDF: tracks y, breaks pages, stamps footers. */
class Doc {
  readonly pdf: jsPDF;
  y = MARGIN;
  private section = "";

  constructor(pdf: jsPDF) {
    this.pdf = pdf;
  }

  setSection(label: string) {
    this.section = label;
  }

  font(weight: "normal" | "bold", size: number, color: RGB = INK) {
    this.pdf.setFont(FONT, weight);
    this.pdf.setFontSize(size);
    this.pdf.setTextColor(color[0], color[1], color[2]);
  }

  newPage() {
    this.pdf.addPage();
    this.y = MARGIN;
  }

  /** Breaks to a new page when `height` mm would not fit above the footer. */
  ensure(height: number) {
    if (this.y + height <= BODY_BOTTOM) return;
    this.newPage();
  }

  gap(mm: number) {
    this.y += mm;
  }

  /** Writes wrapped text at `x` and advances the cursor, splitting across pages. */
  write(
    value: string,
    opts: { x?: number; width?: number; size?: number; weight?: "normal" | "bold"; color?: RGB; lineHeight?: number } = {},
  ) {
    const x = opts.x ?? MARGIN;
    const width = opts.width ?? CONTENT_W;
    const size = opts.size ?? 9.5;
    const lh = opts.lineHeight ?? size * 0.42;
    this.font(opts.weight ?? "normal", size, opts.color ?? INK);
    const lines = this.pdf.splitTextToSize(value, width) as string[];
    for (const line of lines) {
      this.ensure(lh);
      this.pdf.text(line, x, this.y + lh * 0.75);
      this.y += lh;
    }
  }

  rule(color: RGB = LINE) {
    this.ensure(2);
    this.pdf.setDrawColor(color[0], color[1], color[2]);
    this.pdf.setLineWidth(0.2);
    this.pdf.line(MARGIN, this.y, PAGE_W - MARGIN, this.y);
    this.y += 2;
  }

  /**
   * Section heading inside a trip ("Үнэ", "Багцад багтсан" …). `reserve` is the
   * height of content that must fit under it, so a heading never ends up alone
   * at the foot of a page with its rows overleaf.
   */
  heading(label: string, reserve = 12) {
    this.ensure(11 + reserve);
    this.gap(2.5);
    this.font("bold", 10.5, BRAND);
    this.pdf.text(label, MARGIN, this.y + 3.6);
    this.y += 5.4;
    this.pdf.setDrawColor(BRAND[0], BRAND[1], BRAND[2]);
    this.pdf.setLineWidth(0.4);
    this.pdf.line(MARGIN, this.y, MARGIN + 14, this.y);
    this.y += 2.4;
  }

  /** `Нэр: утга` row with a fixed label column. */
  keyValue(label: string, value: string, labelW = 38) {
    if (!value || value === "—") return;
    const valueW = CONTENT_W - labelW;
    this.font("normal", 9.5, INK);
    const lines = this.pdf.splitTextToSize(value, valueW) as string[];
    const height = Math.max(lines.length * 4.2, 4.2);
    this.ensure(height);
    this.font("normal", 9.5, INK_MUTED);
    this.pdf.text(label, MARGIN, this.y + 3.1);
    this.font("normal", 9.5, INK);
    lines.forEach((line, i) => {
      this.pdf.text(line, MARGIN + labelW, this.y + 3.1 + i * 4.2);
    });
    this.y += height + 0.6;
  }

  bullets(items: string[], marker = "•") {
    for (const item of items) {
      const lines = this.pdf.splitTextToSize(item, CONTENT_W - 5) as string[];
      this.ensure(lines.length * 4.2);
      this.font("normal", 9.5, INK_MUTED);
      this.pdf.text(marker, MARGIN + 1, this.y + 3.1);
      this.font("normal", 9.5, INK);
      lines.forEach((line, i) => this.pdf.text(line, MARGIN + 5, this.y + 3.1 + i * 4.2));
      this.y += lines.length * 4.2 + 0.4;
    }
  }

  /**
   * Table with a repeating header. Column widths are mm and must sum to
   * CONTENT_W; rows wrap and never straddle a page break.
   */
  table(headers: string[], rows: string[][], widths: number[]) {
    if (rows.length === 0) return;
    const drawHeader = () => {
      this.ensure(7);
      this.pdf.setFillColor(SOFT[0], SOFT[1], SOFT[2]);
      this.pdf.rect(MARGIN, this.y, CONTENT_W, 6, "F");
      this.font("bold", 8.2, BRAND);
      let x = MARGIN + 1.6;
      headers.forEach((head, i) => {
        this.pdf.text(head, x, this.y + 4);
        x += widths[i];
      });
      this.y += 6;
    };

    drawHeader();

    rows.forEach((row, rowIndex) => {
      this.font("normal", 8.5, INK);
      const cells = row.map((cell, i) => this.pdf.splitTextToSize(cell || "—", widths[i] - 3.2) as string[]);
      const height = Math.max(...cells.map((c) => c.length)) * 3.8 + 2.4;

      if (this.y + height > BODY_BOTTOM) {
        this.newPage();
        drawHeader();
      }

      if (rowIndex % 2 === 1) {
        this.pdf.setFillColor(248, 249, 248);
        this.pdf.rect(MARGIN, this.y, CONTENT_W, height, "F");
      }

      let x = MARGIN + 1.6;
      cells.forEach((lines, i) => {
        this.font("normal", 8.5, i === 0 ? INK : INK_MUTED);
        lines.forEach((line, li) => this.pdf.text(line, x, this.y + 3.4 + li * 3.8));
        x += widths[i];
      });

      this.pdf.setDrawColor(LINE[0], LINE[1], LINE[2]);
      this.pdf.setLineWidth(0.15);
      this.pdf.line(MARGIN, this.y + height, PAGE_W - MARGIN, this.y + height);
      this.y += height;
    });

    this.y += 1.5;
  }

  /** Stamps "section — page n / total" on every page except the cover. */
  stampFooters(sectionByPage: Map<number, string>) {
    const total = this.pdf.getNumberOfPages();
    for (let page = 2; page <= total; page++) {
      this.pdf.setPage(page);
      this.pdf.setDrawColor(LINE[0], LINE[1], LINE[2]);
      this.pdf.setLineWidth(0.2);
      this.pdf.line(MARGIN, PAGE_H - FOOTER_H + 2, PAGE_W - MARGIN, PAGE_H - FOOTER_H + 2);
      this.pdf.setFont(FONT, "normal");
      this.pdf.setFontSize(7.5);
      this.pdf.setTextColor(INK_SUBTLE[0], INK_SUBTLE[1], INK_SUBTLE[2]);
      const label = sectionByPage.get(page) || "";
      if (label) {
        const clipped = this.pdf.splitTextToSize(label, CONTENT_W - 30)[0] as string;
        this.pdf.text(clipped, MARGIN, PAGE_H - FOOTER_H + 6.5);
      }
      this.pdf.text(`${page} / ${total}`, PAGE_W - MARGIN, PAGE_H - FOOTER_H + 6.5, { align: "right" });
    }
  }

  get currentSection() {
    return this.section;
  }
}

/* ----------------------------------------------------------- trip content */

function nextDeparture(trip: TravelTrip): string {
  const resolved = objList(field(trip, "departure_dates_resolved"))
    .map((r) => ({ text: text(r.text), ymd: text(r.ymd) }))
    .filter((r) => r.ymd);
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = resolved.filter((r) => r.ymd >= today).sort((a, b) => a.ymd.localeCompare(b.ymd));
  if (upcoming.length > 0) return upcoming[0].text || upcoming[0].ymd;
  const dates = strList(trip.departure_dates);
  return dates[0] || "—";
}

function writePriceGroups(doc: Doc, trip: TravelTrip) {
  const groups = objList(field(trip, "price_groups"));
  if (groups.length === 0) return;
  doc.heading("Огноогоор ялгаатай үнэ");
  doc.table(
    ["Багц / огноо", "Том хүн", "Хүүхэд", "Нярай", "Тайлбар"],
    groups.map((g) => {
      const dates = strList(g.display_dates).length > 0 ? strList(g.display_dates) : strList(g.dates);
      const title = [text(g.label), dates.join(", ")].filter(Boolean).join(" — ");
      const ages = [
        text(g.child_age) ? `хүүхэд ${text(g.child_age)}` : "",
        text(g.infant_age) ? `нярай ${text(g.infant_age)}` : "",
      ]
        .filter(Boolean)
        .join(", ");
      return [
        title || "—",
        money(g.adult_price, trip.currency),
        money(g.child_price, trip.currency),
        money(g.infant_price, trip.currency),
        [text(g.note), ages].filter(Boolean).join(" | ") || "—",
      ];
    }),
    [62, 27, 27, 27, 39],
  );

  // Per-passenger age bands, when the trip carries them.
  const withPassengers = groups.filter((g) => objList(g.passenger_prices).length > 0);
  for (const group of withPassengers) {
    const label = text(group.label) || strList(group.display_dates).join(", ") || "Үнийн багц";
    doc.write(label, { size: 8.8, weight: "bold", color: INK_MUTED });
    doc.table(
      ["Зорчигч", "Нас", "Үнэ"],
      objList(group.passenger_prices).map((p) => [
        text(p.label) || "—",
        text(p.age_range) || "—",
        money(p.price, text(p.currency) || trip.currency),
      ]),
      [80, 50, 52],
    );
  }
}

function writeTrip(doc: Doc, trip: TravelTrip, index: number, photos: Map<string, LoadedPhoto | null>) {
  doc.newPage();
  const routeName = text(trip.route_name) || "Нэргүй аялал";
  doc.setSection(`${index}. ${routeName}`);

  // ---- title block
  doc.pdf.setFillColor(BRAND[0], BRAND[1], BRAND[2]);
  doc.pdf.rect(0, 0, PAGE_W, 26, "F");
  doc.font("bold", 15, [255, 255, 255]);
  const titleLines = doc.pdf.splitTextToSize(`${index}. ${routeName}`, CONTENT_W) as string[];
  doc.pdf.text(titleLines.slice(0, 2), MARGIN, titleLines.length > 1 ? 11 : 13.5);
  doc.font("normal", 9, [214, 236, 233]);
  const subtitle = [
    text(trip.operator_name),
    text(trip.category),
    STATUS_MN[trip.status] || trip.status,
    trip.customer_visible === false ? "Үйлчлүүлэгчид харагдахгүй" : "",
  ]
    .filter(Boolean)
    .join("  ·  ");
  doc.pdf.text(subtitle, MARGIN, 21.5);
  doc.y = 32;

  if (field(trip, "needs_human_review") === true) {
    const reasons = strList(field(trip, "review_reasons"));
    doc.pdf.setFillColor(255, 246, 232);
    const boxH = 6 + (reasons.length ? reasons.length * 4 : 0);
    doc.pdf.rect(MARGIN, doc.y, CONTENT_W, boxH, "F");
    doc.font("bold", 8.8, WARN);
    doc.pdf.text("Хүн шалгах шаардлагатай", MARGIN + 2, doc.y + 4.2);
    doc.font("normal", 8.5, WARN);
    reasons.forEach((r, i) => doc.pdf.text(`• ${r}`, MARGIN + 2, doc.y + 8.2 + i * 4));
    doc.y += boxH + 3;
  }

  // ---- key facts
  doc.heading("Үндсэн мэдээлэл");
  doc.keyValue("Аяллын нэр", routeName);
  doc.keyValue("Оператор", text(trip.operator_name));
  doc.keyValue("Ангилал", text(trip.category));
  doc.keyValue("Хугацаа", text(trip.duration_text));
  doc.keyValue("Төлөв", STATUS_MN[trip.status] || trip.status);
  doc.keyValue("Зочид буудал", text(trip.hotel));
  doc.keyValue("Хоол", yesNo(trip.has_food));
  doc.keyValue("Нийт суудал", trip.seats_total == null ? "" : String(trip.seats_total));
  doc.keyValue("Үлдсэн суудал", trip.seats_left == null ? "" : String(trip.seats_left));
  doc.keyValue("Ойрын хөдөлгөөн", nextDeparture(trip));
  doc.keyValue("Сүүлд шинэчилсэн", dateTime(trip.updated_at));
  const aliases = strList(field(trip, "aliases"));
  if (aliases.length) doc.keyValue("Өөр нэрс", aliases.join(", "));

  // ---- prices
  doc.heading("Үнэ");
  doc.keyValue("Том хүн (үндсэн)", money(trip.adult_price, trip.currency));
  doc.keyValue("Хүүхэд (үндсэн)", money(trip.child_price, trip.currency));
  doc.keyValue("Валют", text(trip.currency));
  writePriceGroups(doc, trip);

  const discounts = objList(field(trip, "discounts"));
  if (discounts.length) {
    doc.heading("Хямдрал");
    doc.table(
      ["Хямдрал", "Огноо", "Том хүн", "Хүүхэд", "Нөхцөл"],
      discounts.map((d) => {
        const dates = strList(d.display_dates).length > 0 ? strList(d.display_dates) : strList(d.dates);
        return [
          text(d.label) || "—",
          dates.join(", ") || "—",
          money(d.adult_price, trip.currency),
          money(d.child_price, trip.currency),
          [text(d.condition), text(d.note)].filter(Boolean).join(" | ") || "—",
        ];
      }),
      [42, 42, 26, 26, 46],
    );
  }

  const childRules = objList(field(trip, "child_rules"));
  if (childRules.length) {
    doc.heading("Хүүхдийн үнийн журам");
    doc.table(
      ["Ангилал", "Нас", "Үнэ", "Тайлбар"],
      childRules.map((r) => [
        text(r.label) || "—",
        text(r.age_range) || "—",
        money(r.price, text(r.currency) || trip.currency),
        text(r.note) || "—",
      ]),
      [42, 32, 32, 76],
    );
  }

  const roomPrices = objList(field(trip, "room_prices"));
  if (roomPrices.length) {
    doc.heading("Өрөөний үнэ");
    doc.table(
      ["Өрөөний төрөл", "Үнэ", "Тайлбар"],
      roomPrices.map((r) => [
        text(r.room_type) || "—",
        money(r.price, text(r.currency) || trip.currency),
        text(r.note) || "—",
      ]),
      [60, 38, 84],
    );
  }

  const extraFees = objList(field(trip, "extra_fees"));
  if (extraFees.length) {
    doc.heading("Нэмэлт төлбөр");
    doc.table(
      ["Төлбөр", "Дүн", "Хамаарах", "Тайлбар"],
      extraFees.map((f) => [
        text(f.label) || "—",
        money(f.amount, text(f.currency) || trip.currency),
        text(f.applies_to) || "—",
        text(f.note) || "—",
      ]),
      [48, 32, 38, 64],
    );
  }

  // ---- schedule
  const dates = strList(trip.departure_dates);
  const departureRule = text(field(trip, "departure_rule"));
  const recurring = text(field(trip, "recurring_schedule"));
  if (dates.length || departureRule || recurring) {
    doc.heading("Хөдөлгөөний хуваарь");
    if (departureRule) doc.keyValue("Хөдлөх журам", departureRule);
    if (recurring) doc.keyValue("Давтамж", recurring);
    if (dates.length) {
      doc.write(`Гарах өдрүүд (${dates.length}):`, { size: 9, weight: "bold", color: INK_MUTED });
      doc.write(dates.join("   ·   "), { size: 9 });
      doc.gap(1);
    }
  }

  // ---- inclusions
  const included = strList(field(trip, "included_items"));
  const excluded = strList(field(trip, "excluded_items"));
  if (included.length) {
    doc.heading("Багцад багтсан");
    doc.bullets(included);
  }
  if (excluded.length) {
    doc.heading("Багцад багтаагүй");
    doc.bullets(excluded, "–");
  }

  // ---- terms
  const terms = (field(trip, "booking_terms") || {}) as Record<string, unknown>;
  const termRows: Array<[string, string]> = [
    ["Урьдчилгаа", text(terms.deposit)],
    ["Төлбөр", text(terms.payment)],
    ["Бичиг баримт", text(terms.documents)],
    ["Виз", text(terms.visa)],
    ["Цуцлалт / буцаалт", text(terms.cancellation)],
  ];
  if (termRows.some(([, value]) => value)) {
    doc.heading("Захиалгын нөхцөл");
    termRows.forEach(([label, value]) => doc.keyValue(label, value, 42));
  }

  // ---- notes
  const importantNotes = strList(field(trip, "important_notes"));
  if (importantNotes.length) {
    doc.heading("Чухал анхаарах зүйл");
    doc.bullets(importantNotes);
  }
  if (text(trip.notes)) {
    doc.heading("Тэмдэглэл");
    doc.write(text(trip.notes));
  }
  if (text(trip.source_description)) {
    doc.heading("Аяллын дэлгэрэнгүй (эх бичвэр)");
    doc.write(text(trip.source_description), { size: 9, color: INK_MUTED });
  }

  const sourceFile = text(field(trip, "source_file_name"));
  const brochure = text(field(trip, "brochure_pdf_url"));
  if (sourceFile || brochure) {
    doc.heading("Эх сурвалж");
    doc.keyValue("Файл", sourceFile);
    doc.keyValue("Хөтөлбөрийн PDF", brochure, 42);
  }

  // ---- photos
  const urls = strList(trip.photo_urls);
  if (urls.length) {
    /** Fits a photo into the full content width and whatever height is free.
     *  Posters are tall, so the height is what binds. */
    const fit = (photo: LoadedPhoto, availableH: number) => {
      const ratio = photo.height / photo.width;
      let w = CONTENT_W;
      let h = w * ratio;
      if (h > availableH) {
        h = availableH;
        w = h / ratio;
      }
      return { w, h };
    };

    // A full-page-tall poster can never sit under a heading, so require enough
    // room for a usefully large one — otherwise heading and photo both move to
    // the next page together and the photo takes whatever is left there.
    const MIN_PHOTO_H = 110;
    const CAPTION_H = 4;
    const PHOTO_PAD = 4;
    const spaceFor = (y: number) => BODY_BOTTOM - y - CAPTION_H - PHOTO_PAD;

    // The reserve must cover what heading() itself consumes, or the heading
    // fits and the photo underneath it does not.
    doc.heading(`Зурагнууд (${urls.length})`, MIN_PHOTO_H + CAPTION_H + PHOTO_PAD + HEADING_H);

    urls.forEach((url, i) => {
      const photo = photos.get(url);
      if (!photo) {
        doc.write(`${i + 1}. Зураг татагдсангүй — ${url}`, { size: 8, color: INK_SUBTLE });
        return;
      }
      if (spaceFor(doc.y) < MIN_PHOTO_H) doc.newPage();
      const { w, h } = fit(photo, spaceFor(doc.y));
      doc.font("normal", 7.5, INK_SUBTLE);
      doc.pdf.text(`Зураг ${i + 1} / ${urls.length}`, MARGIN, doc.y + 2.5);
      doc.y += CAPTION_H;
      const x = MARGIN + (CONTENT_W - w) / 2;
      doc.pdf.addImage(photo.dataUrl, "JPEG", x, doc.y, w, h, undefined, "FAST");
      doc.y += h + 4;
    });
  } else {
    doc.heading("Зурагнууд");
    doc.write("Энэ аялалд зураг оруулаагүй байна.", { size: 9, color: INK_SUBTLE });
  }
}

/* --------------------------------------------------------- cover + index */

function writeCover(doc: Doc, trips: TravelTrip[], businessName: string) {
  doc.pdf.setFillColor(BRAND[0], BRAND[1], BRAND[2]);
  doc.pdf.rect(0, 0, PAGE_W, 78, "F");
  doc.font("normal", 11, [190, 226, 221]);
  doc.pdf.text(businessName, MARGIN, 30);
  doc.font("bold", 24, [255, 255, 255]);
  doc.pdf.text("Аяллын бүрэн мэдээлэл", MARGIN, 46);
  doc.font("normal", 10.5, [214, 236, 233]);
  doc.pdf.text(`Чатботод бүртгэлтэй бүх аялал  ·  ${todayLabel()}`, MARGIN, 56);

  doc.y = 92;

  const counts = new Map<string, number>();
  for (const trip of trips) counts.set(trip.status, (counts.get(trip.status) || 0) + 1);
  const photoCount = trips.reduce((sum, t) => sum + strList(t.photo_urls).length, 0);

  doc.font("bold", 12, INK);
  doc.pdf.text(`Нийт ${trips.length} аялал`, MARGIN, doc.y);
  doc.y += 8;

  const summary: Array<[string, string]> = [
    ...Array.from(counts.entries()).map(
      ([status, count]) => [STATUS_MN[status] || status, `${count} аялал`] as [string, string],
    ),
    ["Нийт зураг", `${photoCount} ширхэг`],
    ["Үйлчлүүлэгчид нуусан", `${trips.filter((t) => t.customer_visible === false).length} аялал`],
  ];
  summary.forEach(([label, value]) => doc.keyValue(label, value, 52));

  doc.gap(6);
  doc.write(
    "Энэ баримт бичигт чатботын мэдэж байгаа бүх аяллын мэдээлэл — үнэ, огноо, багцад багтсан " +
      "болон багтаагүй зүйлс, нөхцөл, тэмдэглэл, зураг — бүрэн эхээрээ орсон болно. Аялал бүр " +
      "шинэ хуудаснаас эхэлнэ.",
    { size: 9.5, color: INK_MUTED },
  );
}

function writeIndex(doc: Doc, trips: TravelTrip[]) {
  doc.newPage();
  doc.setSection("Аяллын жагсаалт");
  doc.font("bold", 14, INK);
  doc.pdf.text("Аяллын жагсаалт", MARGIN, doc.y + 6);
  doc.y += 12;
  doc.table(
    ["#", "Аялал", "Оператор", "Хугацаа", "Том хүн", "Төлөв", "Зураг"],
    trips.map((trip, i) => [
      String(i + 1),
      text(trip.route_name) || "—",
      text(trip.operator_name) || "—",
      text(trip.duration_text) || "—",
      money(trip.adult_price, trip.currency),
      STATUS_MN[trip.status] || trip.status,
      String(strList(trip.photo_urls).length),
    ]),
    [8, 56, 32, 24, 26, 22, 14],
  );
}

/* ------------------------------------------------------------ public api */

export type TripCatalogProgress = (message: string) => void;

export type TripCatalogOptions = {
  businessName?: string;
  includePhotos?: boolean;
  onProgress?: TripCatalogProgress;
  /** Test seam: supply the TTFs directly instead of fetching /fonts/*. */
  fonts?: { regular: string; bold: string };
  /** Test seam: supply photo bytes instead of hitting Cloudinary. */
  photoLoader?: (url: string) => Promise<LoadedPhoto | null>;
};

export type TripCatalogResult = {
  fileName: string;
  tripCount: number;
  photoCount: number;
  failedPhotoCount: number;
};

export type BuiltTripCatalog = TripCatalogResult & { pdf: jsPDF };

/**
 * Lays out the whole catalogue and returns the document without saving it, so
 * a Node script can render it to disk and assert on the result. `onProgress`
 * reports Mongolian status text — photo fetching for a large catalogue is slow
 * enough that the button needs to say what it is doing.
 */
export async function buildTripCatalogPdf(
  trips: TravelTrip[],
  options: TripCatalogOptions = {},
): Promise<BuiltTripCatalog> {
  const { businessName = "Уудам Трэвэл", includePhotos = true, onProgress } = options;
  const report: TripCatalogProgress = onProgress || (() => {});

  report("Үсгийн фонт ачаалж байна…");
  const [{ jsPDF: JsPDF }, fonts] = await Promise.all([
    import("jspdf"),
    options.fonts ? Promise.resolve(options.fonts) : loadFonts(),
  ]);

  // Photos first: a network stall should surface before any layout work.
  const fetchPhoto = options.photoLoader || loadPhoto;
  const photos = new Map<string, LoadedPhoto | null>();
  const allUrls = includePhotos ? Array.from(new Set(trips.flatMap((t) => strList(t.photo_urls)))) : [];
  const CONCURRENCY = 4;
  for (let i = 0; i < allUrls.length; i += CONCURRENCY) {
    const batch = allUrls.slice(i, i + CONCURRENCY);
    report(`Зураг татаж байна… ${Math.min(i + batch.length, allUrls.length)} / ${allUrls.length}`);
    const loaded = await Promise.all(batch.map((url) => fetchPhoto(url)));
    batch.forEach((url, j) => photos.set(url, loaded[j]));
  }

  report("PDF бэлдэж байна…");
  const pdf = new JsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
  pdf.addFileToVFS("NotoSans-Regular.ttf", fonts.regular);
  pdf.addFont("NotoSans-Regular.ttf", FONT, "normal");
  pdf.addFileToVFS("NotoSans-Bold.ttf", fonts.bold);
  pdf.addFont("NotoSans-Bold.ttf", FONT, "bold");
  pdf.setFont(FONT, "normal");

  const doc = new Doc(pdf);
  const sectionByPage = new Map<number, string>();
  const markPages = (from: number, label: string) => {
    for (let page = from; page <= pdf.getNumberOfPages(); page++) {
      if (!sectionByPage.has(page)) sectionByPage.set(page, label);
    }
  };

  writeCover(doc, trips, businessName);

  let pageBefore = pdf.getNumberOfPages() + 1;
  writeIndex(doc, trips);
  markPages(pageBefore, "Аяллын жагсаалт");

  trips.forEach((trip, i) => {
    if (i % 3 === 0) report(`Аялал бичиж байна… ${i + 1} / ${trips.length}`);
    pageBefore = pdf.getNumberOfPages() + 1;
    writeTrip(doc, trip, i + 1, photos);
    markPages(pageBefore, doc.currentSection);
  });

  doc.stampFooters(sectionByPage);

  pdf.setProperties({
    title: `${businessName} — аяллын бүрэн мэдээлэл`,
    subject: `${trips.length} аялал, ${todayLabel()}`,
    creator: businessName,
  });

  const failedPhotoCount = Array.from(photos.values()).filter((p) => !p).length;
  return {
    pdf,
    fileName: `uudam-ayalal-medeelel-${fileStamp()}.pdf`,
    tripCount: trips.length,
    photoCount: photos.size - failedPhotoCount,
    failedPhotoCount,
  };
}

/** Builds the catalogue and hands it to the browser as a download. */
export async function downloadTripCatalogPdf(
  trips: TravelTrip[],
  options: TripCatalogOptions = {},
): Promise<TripCatalogResult> {
  const { pdf, ...result } = await buildTripCatalogPdf(trips, options);
  options.onProgress?.("Хадгалж байна…");
  pdf.save(result.fileName);
  return result;
}
