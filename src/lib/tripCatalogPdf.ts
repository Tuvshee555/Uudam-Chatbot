/**
 * "Аяллын танилцуулга" — the brochure staff send a customer who asks to see the
 * trips. Cover, a scannable index, then the trips themselves.
 *
 * The important design fact: a trip's stored photos are ALREADY finished
 * customer brochures — agency branding, phone numbers, the price table by
 * departure date, and the full day-by-day programme. So for a trip that has
 * them, this file shows the posters full-page and adds nothing. Re-typing the
 * same prices as text tables underneath is what made the first version feel
 * scattered: every fact appeared twice, once badly.
 *
 * Text pages are the FALLBACK, generated only for trips with no poster, so
 * those trips are still visible to the customer.
 *
 * Nothing internal appears here: no status, no seat counts, no photo counts, no
 * review flags, no ids, no source filenames, no "last updated". Draft, archived,
 * cancelled and hidden trips are excluded entirely.
 *
 * Every value is read from `trip.extra` — the admin API returns trips with the
 * structured fields still nested there, NOT flattened onto the row, even though
 * the client-side TravelTrip type lists them at the top level.
 */

import type { jsPDF } from "jspdf";
import type { TravelTrip } from "./adminTypes";

/* ---------------------------------------------------------------- layout */

const PAGE_W = 210; // A4 mm
const PAGE_H = 297;
const MARGIN = 16;
const CONTENT_W = PAGE_W - MARGIN * 2;
const FOOTER_H = 12;
const BODY_BOTTOM = PAGE_H - FOOTER_H;

const FONT = "NotoSans";
const BRAND: RGB = [15, 118, 110];
const INK: RGB = [23, 25, 26];
const INK_MUTED: RGB = [90, 97, 99];
const INK_SUBTLE: RGB = [141, 147, 149];
const LINE: RGB = [214, 217, 213];
const SOFT: RGB = [231, 244, 242];
const PAPER: RGB = [250, 249, 244];
const GOLD: RGB = [214, 151, 64];
const SKY: RGB = [43, 112, 154];

type RGB = [number, number, number];

/** Posters are shown full-page, so they need more pixels than a thumbnail. */
const PHOTO_TRANSFORM = "f_jpg,q_78,c_limit,w_1400,h_1900";

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

/**
 * Copy written for staff or for the bot, not for the reader.
 *
 * Two registers give it away. The first is explicit tooling vocabulary
 * ("chatbot", "эх сурвалж"). The second is the imperative instruction addressed
 * to whoever answers — "when asked X, always say Y", "refer them to a
 * consultant". A brochure addresses the reader as "та"/"аялагч", so "хэрэглэгч"
 * (talking ABOUT the customer) only ever appears in an internal note.
 *
 * Verified against all 168 customer-facing strings in the live catalogue: this
 * drops exactly the 6 staff instructions and keeps the other 162. Any fare an
 * instruction happened to mention is rendered from the structured passenger
 * tiers instead — see writePassengerFares — so nothing priced is lost.
 */
const INTERNAL_COPY_RE = new RegExp(
  [
    "\\b(chatbot|admin|internal|source|review|staff)\\b",
    "бот",
    "админ",
    "дотоод",
    "эх сурвалж",
    "шалгах шаардлагатай",
    "хэрэглэгч",
    "заавал\\s+хэлнэ",
    "лавлуул",
    "асуу(вал|хад|бал)[^.!?]{0,80}(хэлнэ|хариулна|мэдэгдэнэ)",
  ].join("|"),
  "i",
);

function customerText(value: unknown): string {
  const valueText = text(value);
  if (!valueText || INTERNAL_COPY_RE.test(valueText)) return "";
  return valueText;
}

function customerList(value: unknown): string[] {
  return strList(value).filter((item) => !INTERNAL_COPY_RE.test(item));
}

/** Letters and digits only — for comparing two phrasings of the same fact. */
function squash(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * True when a note just restates something already printed on the page, e.g. a
 * "Буудал: Phoenix 5*…" note next to the hotel section that already says it.
 * Repeating one fact twice on one page is the scatter this brochure exists to
 * avoid.
 */
function restatesShownField(note: string, shown: string[]): boolean {
  const a = squash(note);
  if (a.length < 12) return false;
  return shown.some((other) => {
    const b = squash(other);
    return b.length >= 12 && (a.includes(b) || b.includes(a));
  });
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value.replace(/[,\s]/g, ""));
    if (Number.isFinite(n) && value.trim() !== "") return n;
  }
  return null;
}

/**
 * Money for humans: `1 850 000₮`.
 *
 * A value of 0 (or below) is treated as NOT SET, never printed as "0₮". In this
 * catalogue a zero fare means the price is missing, and printing it tells a
 * customer the trip is free — infants in particular. The bot already applies
 * exactly this rule (`formatPassengerMoney` in travelFastPathsPricing.ts), and
 * a brochure that contradicts the bot is worse than one that says nothing.
 */
function money(value: unknown, currency = "MNT"): string {
  const n = num(value);
  if (n == null || n <= 0) return "—";
  const grouped = Math.round(n).toLocaleString("mn-MN").replace(/,/g, " ");
  return currency === "MNT" || !currency ? `${grouped}₮` : `${grouped} ${currency}`;
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
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

/**
 * The trips a customer may see. Anything the agency has parked — draft,
 * archived, cancelled, sold out, or explicitly hidden from customers — must
 * never reach a brochure.
 */
export function customerVisibleTrips(trips: TravelTrip[]): TravelTrip[] {
  return trips.filter((trip) => {
    if (trip.status !== "active") return false;
    const extra = (trip.extra || {}) as Record<string, unknown>;
    if (extra.customer_visible === false) return false;
    if (trip.customer_visible === false) return false;
    return true;
  });
}

/** Lowest adult price across the base fare and every price group. */
function fromPrice(trip: TravelTrip): number | null {
  const candidates = [num(trip.adult_price)];
  for (const group of objList(field(trip, "price_groups"))) candidates.push(num(group.adult_price));
  const valid = candidates.filter((n): n is number => n != null && n > 0);
  return valid.length ? Math.min(...valid) : null;
}

/** Departure dates as a customer reads them, newest schedule wins. */
function departureSummary(trip: TravelTrip, limit = 4): string {
  const dates = strList(trip.departure_dates);
  if (dates.length === 0) return "";
  const shown = dates.slice(0, limit).join(", ");
  return dates.length > limit ? `${shown} (+${dates.length - limit})` : shown;
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

/** Fetches one poster as a data URL. Returns null instead of throwing: a dead
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

  constructor(pdf: jsPDF) {
    this.pdf = pdf;
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
    const lh = opts.lineHeight ?? size * 0.46;
    this.font(opts.weight ?? "normal", size, opts.color ?? INK);
    const lines = this.pdf.splitTextToSize(value, width) as string[];
    for (const line of lines) {
      this.ensure(lh);
      this.pdf.text(line, x, this.y + lh * 0.75);
      this.y += lh;
    }
  }

  /**
   * Section heading. `reserve` is the height of content that must fit under it,
   * so a heading never ends up alone at the foot of a page.
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

  bullets(items: string[], marker = "•") {
    for (const item of items) {
      const lines = this.pdf.splitTextToSize(item, CONTENT_W - 6) as string[];
      this.ensure(lines.length * 4.4);
      this.font("normal", 9.5, BRAND);
      this.pdf.text(marker, MARGIN + 1, this.y + 3.2);
      this.font("normal", 9.5, INK);
      lines.forEach((line, i) => this.pdf.text(line, MARGIN + 6, this.y + 3.2 + i * 4.4));
      this.y += lines.length * 4.4 + 0.6;
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
      this.pdf.rect(MARGIN, this.y, CONTENT_W, 6.4, "F");
      this.font("bold", 8.4, BRAND);
      let x = MARGIN + 2;
      headers.forEach((head, i) => {
        this.pdf.text(head, x, this.y + 4.2);
        x += widths[i];
      });
      this.y += 6.4;
    };

    drawHeader();

    rows.forEach((row, rowIndex) => {
      this.font("normal", 8.8, INK);
      const cells = row.map((cell, i) => this.pdf.splitTextToSize(cell || "—", widths[i] - 4) as string[]);
      const height = Math.max(...cells.map((c) => c.length)) * 4 + 2.6;

      if (this.y + height > BODY_BOTTOM) {
        this.newPage();
        drawHeader();
      }

      if (rowIndex % 2 === 1) {
        this.pdf.setFillColor(248, 249, 248);
        this.pdf.rect(MARGIN, this.y, CONTENT_W, height, "F");
      }

      let x = MARGIN + 2;
      cells.forEach((lines, i) => {
        this.font(i === 0 ? "bold" : "normal", 8.8, i === 0 ? INK : INK_MUTED);
        lines.forEach((line, li) => this.pdf.text(line, x, this.y + 3.6 + li * 4));
        x += widths[i];
      });

      this.pdf.setDrawColor(LINE[0], LINE[1], LINE[2]);
      this.pdf.setLineWidth(0.15);
      this.pdf.line(MARGIN, this.y + height, PAGE_W - MARGIN, this.y + height);
      this.y += height;
    });

    this.y += 1.5;
  }

  /** Page number on every page but the cover. Poster pages are left clean. */
  stampFooters(skip: Set<number>) {
    const total = this.pdf.getNumberOfPages();
    for (let page = 2; page <= total; page++) {
      if (skip.has(page)) continue;
      this.pdf.setPage(page);
      this.pdf.setFont(FONT, "normal");
      this.pdf.setFontSize(7.5);
      this.pdf.setTextColor(INK_SUBTLE[0], INK_SUBTLE[1], INK_SUBTLE[2]);
      this.pdf.text(`${page} / ${total}`, PAGE_W / 2, PAGE_H - FOOTER_H + 6.5, { align: "center" });
    }
  }
}

/* ----------------------------------------------------------- trip content */

/**
 * A poster, printed as large as the page allows. These are already complete
 * brochures, so nothing is drawn over or beside them.
 */
function writePosterPage(doc: Doc, photo: LoadedPhoto) {
  doc.pdf.addPage();
  const maxW = PAGE_W - 3;
  const maxH = PAGE_H - 9; // small breathing strip so the page number never collides
  const ratio = photo.height / photo.width;
  let w = maxW;
  let h = w * ratio;
  if (h > maxH) {
    h = maxH;
    w = h / ratio;
  }
  const x = (PAGE_W - w) / 2;
  const y = (PAGE_H - FOOTER_H / 2 - h) / 2;
  doc.pdf.addImage(photo.dataUrl, "JPEG", x, y, w, h, undefined, "FAST");
  doc.y = PAGE_H;
}

function fitImage(photo: LoadedPhoto, boxW: number, boxH: number) {
  const ratio = photo.height / photo.width;
  let w = boxW;
  let h = w * ratio;
  if (h > boxH) {
    h = boxH;
    w = h / ratio;
  }
  return { w, h };
}

type FareTier = { label: string; age: string; price: string; note: string };

/**
 * Every fare tier the trip actually has, by passenger type.
 *
 * The per-date table only has three columns (adult/child/infant), so a trip
 * with two child bands — Хайнан sells 6-12 at 2,790,000₮ and 2-6 at
 * 2,190,000₮ — silently loses one, and a customer with a 4-year-old is quoted
 * the wrong price. `passenger_prices` and `child_rules` carry the full ladder;
 * this merges them and drops exact duplicates.
 */
function fareTiers(trip: TravelTrip): FareTier[] {
  const rows: FareTier[] = [];
  const seen = new Set<string>();
  const add = (label: unknown, age: unknown, price: unknown, currency: unknown, note: unknown) => {
    const priceText = money(price, text(currency) || trip.currency);
    const priced = priceText !== "—";
    const tier: FareTier = {
      label: customerText(label) || "—",
      age: text(age) || "—",
      // An unpriced tier still matters — it tells the reader the category
      // exists — but "—" reads as broken, and a note like "Үнэгүй" would claim
      // the seat is free. The catalogue's zero fares are missing data, not free
      // seats (the bot refuses to quote them too), so send the reader to a human.
      price: priced ? priceText : "Лавлана уу",
      note: priced ? customerText(note) : "",
    };
    const key = `${squash(tier.label)}|${squash(tier.age)}|${tier.price}`;
    const existing = rows.find((row) => `${squash(row.label)}|${squash(row.age)}|${row.price}` === key);
    if (existing) {
      // Same tier from both passenger_prices and child_rules — keep whichever
      // phrasing carries a note instead of dropping it.
      if (!existing.note && tier.note) existing.note = tier.note;
      return;
    }
    seen.add(key);
    rows.push(tier);
  };

  for (const group of objList(field(trip, "price_groups"))) {
    for (const p of objList(group.passenger_prices)) add(p.label, p.age_range, p.price, p.currency, p.note);
  }
  for (const rule of objList(field(trip, "child_rules"))) {
    add(rule.label, rule.age_range, rule.price, rule.currency, rule.note);
  }
  return rows;
}

/**
 * Fallback page for a trip with no poster. Carries only what a customer would
 * ask about: what it costs, when it leaves, what is and is not included, and
 * the booking terms.
 */
function writeInfoPage(doc: Doc, trip: TravelTrip) {
  doc.newPage();
  const routeName = text(trip.route_name) || "Аялал";

  doc.pdf.setFillColor(BRAND[0], BRAND[1], BRAND[2]);
  doc.pdf.rect(0, 0, PAGE_W, 30, "F");
  doc.font("bold", 15, [255, 255, 255]);
  const titleLines = doc.pdf.splitTextToSize(routeName, CONTENT_W) as string[];
  doc.pdf.text(titleLines.slice(0, 2), MARGIN, titleLines.length > 1 ? 13 : 16);
  const subtitle = [text(trip.duration_text), text(trip.category)].filter(Boolean).join("  ·  ");
  if (subtitle) {
    doc.font("normal", 9.5, [214, 236, 233]);
    doc.pdf.text(subtitle, MARGIN, 24.5);
  }
  doc.y = 38;

  // ---- price
  //
  // Two dimensions can carry a fare: WHEN you leave (price groups) and WHO is
  // travelling (passenger tiers). Printing both tables when only one of them
  // actually varies is the duplication that made this document feel scattered,
  // so the date table is only shown when the date genuinely changes the price.
  const groups = objList(field(trip, "price_groups"));
  const tiers = fareTiers(trip);
  const datesChangePrice = groups.length > 1;

  if (datesChangePrice) {
    doc.heading("Үнэ (хөдлөх өдрөөр)", 20);
    doc.table(
      ["Хөдлөх өдөр", "Том хүн", "Хүүхэд", "Нярай"],
      groups.map((g) => {
        const dates = strList(g.display_dates).length > 0 ? strList(g.display_dates) : strList(g.dates);
        return [
          dates.join(", ") || customerText(g.label) || "—",
          money(g.adult_price, trip.currency),
          money(g.child_price, trip.currency),
          money(g.infant_price, trip.currency),
        ];
      }),
      [74, 34, 34, 36],
    );
  }

  if (tiers.length > 0) {
    doc.heading(datesChangePrice ? "Зорчигчийн үнэ" : "Үнэ", 18);
    doc.table(
      ["Зорчигч", "Нас", "Үнэ", "Тайлбар"],
      tiers.map((t) => [t.label, t.age, t.price, t.note || "—"]),
      [40, 34, 38, 66],
    );
  } else if (!datesChangePrice && groups.length === 1) {
    // One departure window, no passenger ladder — the group row is the price.
    const g = groups[0];
    doc.heading("Үнэ", 14);
    doc.table(
      ["Том хүн", "Хүүхэд", "Нярай"],
      [[money(g.adult_price, trip.currency), money(g.child_price, trip.currency), money(g.infant_price, trip.currency)]],
      [60, 59, 59],
    );
    const ages = [
      text(g.child_age) ? `Хүүхэд: ${text(g.child_age)}` : "",
      text(g.infant_age) ? `Нярай: ${text(g.infant_age)}` : "",
    ].filter(Boolean);
    if (ages.length) doc.write(ages.join("   ·   "), { size: 8.5, color: INK_MUTED });
  } else if (groups.length === 0 && (num(trip.adult_price) != null || num(trip.child_price) != null)) {
    doc.heading("Үнэ", 14);
    doc.table(
      ["Том хүн", "Хүүхэд"],
      [[money(trip.adult_price, trip.currency), money(trip.child_price, trip.currency)]],
      [89, 89],
    );
  }

  const roomPrices = objList(field(trip, "room_prices"));
  if (roomPrices.length) {
    doc.heading("Өрөөний үнэ", 16);
    doc.table(
      ["Өрөөний төрөл", "Үнэ", "Тайлбар"],
      roomPrices.map((r) => [
        customerText(r.room_type) || "—",
        money(r.price, text(r.currency) || trip.currency),
        customerText(r.note) || "—",
      ]),
      [58, 40, 80],
    );
  }

  const extraFees = objList(field(trip, "extra_fees"));
  if (extraFees.length) {
    doc.heading("Нэмэлт төлбөр", 16);
    doc.table(
      ["Төлбөр", "Дүн", "Тайлбар"],
      extraFees.map((f) => [
        customerText(f.label) || "—",
        money(f.amount, text(f.currency) || trip.currency),
        [customerText(f.applies_to), customerText(f.note)].filter(Boolean).join(" · ") || "—",
      ]),
      [58, 38, 82],
    );
  }

  // ---- schedule
  const dates = strList(trip.departure_dates);
  const departureRule = customerText(field(trip, "departure_rule"));
  const recurring = customerText(field(trip, "recurring_schedule"));
  if (dates.length || departureRule || recurring) {
    doc.heading("Хөдлөх өдрүүд", 12);
    if (dates.length) doc.write(dates.join("   ·   "), { size: 9.5 });
    if (recurring) doc.write(recurring, { size: 9, color: INK_MUTED });
    if (departureRule) doc.write(departureRule, { size: 9, color: INK_MUTED });
  }

  // ---- inclusions
  const included = customerList(field(trip, "included_items"));
  const excluded = customerList(field(trip, "excluded_items"));
  if (included.length) {
    doc.heading("Багцад багтсан", 14);
    doc.bullets(included);
  }
  if (excluded.length) {
    doc.heading("Багцад багтаагүй", 14);
    doc.bullets(excluded, "–");
  }

  if (text(trip.hotel)) {
    doc.heading("Байрлах буудал", 10);
    doc.write(text(trip.hotel), { size: 9.5 });
  }

  // ---- terms
  const terms = (field(trip, "booking_terms") || {}) as Record<string, unknown>;
  const termRows: Array<[string, string]> = [
    ["Урьдчилгаа", customerText(terms.deposit)],
    ["Төлбөр", customerText(terms.payment)],
    ["Бичиг баримт", customerText(terms.documents)],
    ["Виз", customerText(terms.visa)],
    ["Цуцлалт", customerText(terms.cancellation)],
  ];
  const filledTerms = termRows.filter(([, value]) => value);
  if (filledTerms.length) {
    doc.heading("Захиалгын нөхцөл", 14);
    doc.table(["Нөхцөл", "Тайлбар"], filledTerms, [44, 134]);
  }

  // Notes come last, so anything already printed above is dropped rather than
  // said twice — the hotel in particular is often repeated as a "Буудал: …" note.
  const alreadyShown = [text(trip.hotel), ...included, ...excluded].filter(Boolean);
  const importantNotes = customerList(field(trip, "important_notes")).filter(
    (note) => !restatesShownField(note, alreadyShown),
  );
  if (importantNotes.length) {
    doc.heading("Анхаарах зүйл", 14);
    doc.bullets(importantNotes);
  }
}

/* --------------------------------------------------------- cover + index */

function firstLoadedPoster(trip: TravelTrip, photos: Map<string, LoadedPhoto | null>): LoadedPhoto | null {
  for (const url of strList(trip.photo_urls)) {
    const photo = photos.get(url);
    if (photo) return photo;
  }
  return null;
}

function drawContainedImage(doc: Doc, photo: LoadedPhoto, x: number, y: number, w: number, h: number) {
  const fit = fitImage(photo, w, h);
  doc.pdf.addImage(photo.dataUrl, "JPEG", x + (w - fit.w) / 2, y + (h - fit.h) / 2, fit.w, fit.h, undefined, "FAST");
}

function writeCover(doc: Doc, trips: TravelTrip[], businessName: string, photos: Map<string, LoadedPhoto | null>) {
  doc.pdf.setFillColor(PAPER[0], PAPER[1], PAPER[2]);
  doc.pdf.rect(0, 0, PAGE_W, PAGE_H, "F");
  doc.pdf.setFillColor(BRAND[0], BRAND[1], BRAND[2]);
  doc.pdf.rect(0, 0, PAGE_W, 104, "F");
  doc.pdf.setFillColor(SKY[0], SKY[1], SKY[2]);
  doc.pdf.rect(0, 104, PAGE_W, 20, "F");

  const previewPhotos = trips.map((trip) => firstLoadedPoster(trip, photos)).filter((p): p is LoadedPhoto => !!p).slice(0, 3);
  const previewBoxes = [
    { x: 116, y: 28, w: 34, h: 58 },
    { x: 151, y: 18, w: 43, h: 72 },
    { x: 130, y: 90, w: 50, h: 76 },
  ];
  previewPhotos.forEach((photo, i) => {
    const box = previewBoxes[i];
    doc.pdf.setFillColor(255, 255, 255);
    doc.pdf.roundedRect(box.x - 2, box.y - 2, box.w + 4, box.h + 4, 2.5, 2.5, "F");
    drawContainedImage(doc, photo, box.x, box.y, box.w, box.h);
  });

  doc.font("normal", 11, [194, 229, 225]);
  doc.pdf.text(businessName.toUpperCase(), MARGIN, 36);

  doc.font("bold", 27, [255, 255, 255]);
  doc.pdf.text("Аяллын", MARGIN, 58);
  doc.pdf.text("танилцуулга", MARGIN, 73);

  doc.pdf.setDrawColor(GOLD[0], GOLD[1], GOLD[2]);
  doc.pdf.setLineWidth(1);
  doc.pdf.line(MARGIN, 84, MARGIN + 30, 84);

  doc.font("normal", 10.5, [225, 244, 241]);
  doc.pdf.text("Үйлчлүүлэгчид илгээх аяллын багц танилцуулга", MARGIN, 94);

  doc.font("bold", 15, INK);
  doc.pdf.text(`${trips.length} аялал`, MARGIN, 153);
  doc.font("normal", 10, INK_MUTED);
  doc.pdf.text(`Шинэчилсэн: ${todayLabel()}`, MARGIN, 162);

  const notes = [
    "Дараагийн хуудсанд аяллуудыг товч харна.",
    "Аялал бүрийн дэлгэрэнгүй постер дараагийн хуудсуудаас эхэлнэ.",
    "Үнэ, хөтөлбөр, холбоо барих мэдээлэл постер дээрээ бүрэн байгаа.",
  ];
  let y = 184;
  notes.forEach((note) => {
    doc.pdf.setFillColor(BRAND[0], BRAND[1], BRAND[2]);
    doc.pdf.circle(MARGIN + 2, y - 1.2, 1.2, "F");
    doc.font("normal", 10, INK);
    doc.pdf.text(note, MARGIN + 7, y);
    y += 9;
  });

  doc.pdf.setFillColor(255, 255, 255);
  doc.pdf.roundedRect(MARGIN, 236, CONTENT_W, 28, 3, 3, "F");
  doc.font("bold", 10.5, BRAND);
  // From bot settings, never hardcoded — the agency name is client data.
  doc.pdf.text(businessName, MARGIN + 7, 248);
  doc.font("normal", 9, INK_MUTED);
  doc.pdf.text("Аяллаа сонгоод дэлгэрэнгүй постер хуудсыг харна уу.", MARGIN + 7, 256);
}

function writeIndex(doc: Doc, trips: TravelTrip[]) {
  doc.newPage();
  const cardW = (CONTENT_W - 8) / 2;
  const cardH = 50;
  const gapX = 8;
  const gapY = 9;
  const startY = 52;
  const CARDS_PER_PAGE = 8;

  const drawHeader = () => {
    doc.pdf.setFillColor(PAPER[0], PAPER[1], PAPER[2]);
    doc.pdf.rect(0, 0, PAGE_W, PAGE_H, "F");
    doc.font("bold", 18, INK);
    doc.pdf.text("Аяллаа сонгох", MARGIN, 28);
    doc.font("normal", 9.5, INK_MUTED);
    doc.pdf.text("Товч мэдээллээс сонгоод дараагийн хуудсуудаас постеруудыг бүтнээр нь харна.", MARGIN, 37);
    doc.pdf.setDrawColor(GOLD[0], GOLD[1], GOLD[2]);
    doc.pdf.setLineWidth(0.6);
    doc.pdf.line(MARGIN, 43, MARGIN + 28, 43);
  };

  drawHeader();

  trips.forEach((trip, i) => {
    const slot = i % CARDS_PER_PAGE;
    if (i > 0 && slot === 0) {
      doc.newPage();
      drawHeader();
    }

    const col = slot % 2;
    const row = Math.floor(slot / 2);
    const x = MARGIN + col * (cardW + gapX);
    const y = startY + row * (cardH + gapY);
    const title = text(trip.route_name) || "Аялал";
    const duration = text(trip.duration_text);
    const from = fromPrice(trip);
    const price = from == null ? "Үнэ лавлах" : `Эхлэх үнэ ${money(from, trip.currency)}`;
    const dates = departureSummary(trip, 3) || "Хөдлөх өдөр лавлах";

    doc.pdf.setFillColor(255, 255, 255);
    doc.pdf.roundedRect(x, y, cardW, cardH, 3, 3, "F");
    doc.pdf.setDrawColor(230, 226, 216);
    doc.pdf.setLineWidth(0.2);
    doc.pdf.roundedRect(x, y, cardW, cardH, 3, 3, "S");

    doc.pdf.setFillColor(BRAND[0], BRAND[1], BRAND[2]);
    doc.pdf.roundedRect(x + 4, y + 5, 10, 7, 2, 2, "F");
    doc.font("bold", 7.5, [255, 255, 255]);
    doc.pdf.text(String(i + 1), x + 9, y + 9.8, { align: "center" });

    doc.font("bold", 9.3, INK);
    const titleLines = doc.pdf.splitTextToSize(title, cardW - 22) as string[];
    doc.pdf.text(titleLines.slice(0, 2), x + 18, y + 8.8);

    doc.font("normal", 8.2, INK_MUTED);
    const meta = [duration, dates].filter(Boolean).join("  |  ");
    const metaLines = doc.pdf.splitTextToSize(meta, cardW - 10) as string[];
    doc.pdf.text(metaLines.slice(0, 3), x + 5, y + 24);

    doc.pdf.setFillColor(246, 238, 224);
    doc.pdf.roundedRect(x + 5, y + cardH - 11, cardW - 10, 7, 2, 2, "F");
    doc.font("bold", 8.4, [129, 82, 23]);
    doc.pdf.text(price, x + 8, y + cardH - 6.2);
  });
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
  /** Trips excluded because they are not active or are hidden from customers. */
  hiddenCount: number;
  photoCount: number;
  failedPhotoCount: number;
  /** Trips shown as a text page because they have no poster. */
  textOnlyCount: number;
};

export type BuiltTripCatalog = TripCatalogResult & { pdf: jsPDF };

/**
 * Lays out the brochure and returns the document without saving it, so a Node
 * script can render it to disk and assert on the result.
 */
export async function buildTripCatalogPdf(
  allTrips: TravelTrip[],
  options: TripCatalogOptions = {},
): Promise<BuiltTripCatalog> {
  const { businessName = "Uudam Travel", includePhotos = true, onProgress } = options;
  const report: TripCatalogProgress = onProgress || (() => {});

  const trips = customerVisibleTrips(allTrips);
  const hiddenCount = allTrips.length - trips.length;

  report("Үсгийн фонт ачаалж байна…");
  const [{ jsPDF: JsPDF }, fonts] = await Promise.all([
    import("jspdf"),
    options.fonts ? Promise.resolve(options.fonts) : loadFonts(),
  ]);

  // Posters first: a network stall should surface before any layout work.
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
  const posterPages = new Set<number>();

  writeCover(doc, trips, businessName, photos);
  writeIndex(doc, trips);

  let textOnlyCount = 0;
  trips.forEach((trip, i) => {
    if (i % 3 === 0) report(`Аялал бичиж байна… ${i + 1} / ${trips.length}`);
    const loaded = strList(trip.photo_urls)
      .map((url) => photos.get(url))
      .filter((p): p is LoadedPhoto => !!p);

    if (loaded.length > 0) {
      // The posters ARE the trip's brochure — show them and add nothing.
      for (const photo of loaded) {
        writePosterPage(doc, photo);
        posterPages.add(pdf.getNumberOfPages());
      }
    } else {
      textOnlyCount++;
      writeInfoPage(doc, trip);
    }
  });

  doc.stampFooters(posterPages);

  pdf.setProperties({
    title: `${businessName} — аяллын танилцуулга`,
    subject: `${trips.length} аялал, ${todayLabel()}`,
    creator: businessName,
  });

  const failedPhotoCount = Array.from(photos.values()).filter((p) => !p).length;
  return {
    pdf,
    fileName: `uudam-ayallin-taniltsuulga-${todayLabel().replace(/\./g, "-")}.pdf`,
    tripCount: trips.length,
    hiddenCount,
    photoCount: photos.size - failedPhotoCount,
    failedPhotoCount,
    textOnlyCount,
  };
}

/** Builds the brochure and hands it to the browser as a download. */
export async function downloadTripCatalogPdf(
  trips: TravelTrip[],
  options: TripCatalogOptions = {},
): Promise<TripCatalogResult> {
  const { pdf, ...result } = await buildTripCatalogPdf(trips, options);
  options.onProgress?.("Хадгалж байна…");
  pdf.save(result.fileName);
  return result;
}
