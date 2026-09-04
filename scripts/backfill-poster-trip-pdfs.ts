import { createHash } from "crypto";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { closeNeonPool, queryNeon } from "../src/lib/neonDb";

type PosterRow = {
  id: string;
  title: string;
  source_file: string | null;
  data: Record<string, unknown>;
};

type PosterDay = {
  day?: number;
  route?: string;
  summary?: string;
  hotel?: string | null;
  meals?: { breakfast?: boolean; lunch?: boolean; dinner?: boolean };
};

const CLOUDINARY_FOLDER = "uudam-travel-trips";
const PAGE_WIDTH = 1080;
const PAGE_HEIGHT = 1528;
const LEFT = 72;
const RIGHT = PAGE_WIDTH - 72;

function escapeXml(value: unknown): string {
  return String(value ?? "")
    .replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD]/g, "")
    .replace(/[\uFFFE\uFFFF]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function wrapText(text: string, maxChars: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (!line) {
      line = word;
    } else if (`${line} ${word}`.length <= maxChars) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function textNode(input: {
  x: number;
  y: number;
  size: number;
  color?: string;
  weight?: number;
  lines: string[];
  lineHeight?: number;
}) {
  const lineHeight = input.lineHeight ?? Math.round(input.size * 1.35);
  const [first, ...rest] = input.lines;
  return `<text x="${input.x}" y="${input.y}" font-size="${input.size}" font-weight="${input.weight ?? 500}" fill="${input.color ?? "#15211b"}">
    <tspan x="${input.x}">${escapeXml(first)}</tspan>
    ${rest.map((line) => `<tspan x="${input.x}" dy="${lineHeight}">${escapeXml(line)}</tspan>`).join("")}
  </text>`;
}

function formatMeal(day: PosterDay): string {
  const meals = day.meals || {};
  const parts = [
    meals.breakfast ? "Өглөөний цай" : "",
    meals.lunch ? "Өдрийн хоол" : "",
    meals.dinner ? "Оройн хоол" : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "";
}

function formatPriceTable(data: Record<string, unknown>): string[] {
  const table = data.price_table && typeof data.price_table === "object"
    ? data.price_table as Record<string, unknown>
    : {};
  const columns = asArray(table.columns).map(String).filter(Boolean);
  const rows = asArray(table.rows).slice(0, 4);
  if (!columns.length || !rows.length) return [];
  return rows.map((row) => {
    const record = row && typeof row === "object" ? row as Record<string, unknown> : {};
    const dates = asText(record.dates);
    const cells = asArray(record.cells).map(String).filter(Boolean);
    const cellsText = cells
      .map((cell, index) => `${columns[index] || `Үнэ ${index + 1}`}: ${cell}`)
      .join("  |  ");
    return [dates, cellsText].filter(Boolean).join(" - ");
  });
}

function buildBlocks(poster: PosterRow): Array<{ label: string; lines: string[] }> {
  const data = poster.data || {};
  const departures = asArray(data.departures)
    .map((item) => item && typeof item === "object" ? asText((item as Record<string, unknown>).date) : "")
    .filter(Boolean);
  const days = asArray(data.days).filter((item): item is PosterDay =>
    Boolean(item && typeof item === "object"),
  );
  const durationDays = typeof data.duration_days === "number" ? data.duration_days : null;
  const durationNights = typeof data.duration_nights === "number" ? data.duration_nights : null;
  const duration = [durationDays ? `${durationDays} өдөр` : "", durationNights ? `${durationNights} шөнө` : ""]
    .filter(Boolean)
    .join(" ");

  const blocks: Array<{ label: string; lines: string[] }> = [];
  if (duration || departures.length) {
    blocks.push({
      label: "Аяллын товч",
      lines: [
        duration ? `Хугацаа: ${duration}` : "",
        departures.length ? `Гарах өдрүүд: ${departures.join(", ")}` : "",
      ].filter(Boolean),
    });
  }
  const prices = formatPriceTable(data);
  if (prices.length) blocks.push({ label: "Үнэ", lines: prices });

  for (const [index, day] of days.entries()) {
    const dayNumber = typeof day.day === "number" ? day.day : index + 1;
    const meal = formatMeal(day);
    blocks.push({
      label: `Өдөр ${dayNumber}`,
      lines: [
        asText(day.route),
        asText(day.summary),
        day.hotel ? `Зочид буудал: ${day.hotel}` : "",
        meal ? `Хоол: ${meal}` : "",
      ].filter(Boolean),
    });
  }

  const includes = asArray(data.includes).map(String).filter(Boolean);
  const excludes = asArray(data.excludes).map(String).filter(Boolean);
  if (includes.length) blocks.push({ label: "Үүнд багтсан", lines: includes });
  if (excludes.length) blocks.push({ label: "Үүнд багтаагүй", lines: excludes });
  return blocks;
}

function measureBlock(block: { label: string; lines: string[] }) {
  const wrappedCount = block.lines.reduce(
    (sum, line) => sum + wrapText(line, 68).length,
    0,
  );
  return 54 + wrappedCount * 28 + 24;
}

function paginate(blocks: Array<{ label: string; lines: string[] }>) {
  const pages: Array<Array<{ label: string; lines: string[] }>> = [[]];
  let y = 300;
  for (const block of blocks) {
    const height = measureBlock(block);
    if (pages[pages.length - 1].length > 0 && y + height > PAGE_HEIGHT - 80) {
      pages.push([]);
      y = 160;
    }
    pages[pages.length - 1].push(block);
    y += height;
  }
  return pages;
}

function renderSvgPage(
  poster: PosterRow,
  blocks: Array<{ label: string; lines: string[] }>,
  pageIndex: number,
  totalPages: number,
) {
  const titleLines = wrapText(asText(poster.data.title) || poster.title, 28).slice(0, 3);
  let y = pageIndex === 0 ? 276 : 136;
  const content = blocks.map((block) => {
    const lineMarkup: string[] = [];
    let localY = y + 72;
    for (const line of block.lines) {
      const wrapped = wrapText(line, 70);
      lineMarkup.push(textNode({
        x: LEFT + 30,
        y: localY,
        size: 25,
        weight: 500,
        color: "#1f2a25",
        lines: wrapped,
        lineHeight: 32,
      }));
      localY += wrapped.length * 32 + 10;
    }
    const height = Math.max(92, localY - y + 20);
    const markup = `
      <rect x="${LEFT}" y="${y}" width="${RIGHT - LEFT}" height="${height}" rx="18" fill="#ffffff" stroke="#d7e3dc" stroke-width="2"/>
      <rect x="${LEFT}" y="${y}" width="14" height="${height}" rx="7" fill="#147a55"/>
      ${textNode({ x: LEFT + 30, y: y + 42, size: 28, weight: 800, color: "#147a55", lines: [block.label] })}
      ${lineMarkup.join("")}
    `;
    y += height + 24;
    return markup;
  }).join("");

  return `
  <svg width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}" viewBox="0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}" fill="#f3f7f2"/>
    <rect x="0" y="0" width="${PAGE_WIDTH}" height="${pageIndex === 0 ? 228 : 92}" fill="#123d31"/>
    ${pageIndex === 0
      ? `${textNode({ x: LEFT, y: 78, size: 28, weight: 800, color: "#a8e3c4", lines: ["UUDAM TRAVEL AGENCY"] })}
         ${textNode({ x: LEFT, y: 138, size: 48, weight: 900, color: "#ffffff", lines: titleLines, lineHeight: 56 })}`
      : textNode({ x: LEFT, y: 58, size: 30, weight: 800, color: "#ffffff", lines: [poster.title] })}
    ${content}
    <text x="${RIGHT}" y="${PAGE_HEIGHT - 34}" text-anchor="end" font-size="20" font-weight="700" fill="#587066">PDF ${pageIndex + 1}/${totalPages}</text>
  </svg>`;
}

async function buildPosterPdf(poster: PosterRow): Promise<Buffer> {
  const pages = paginate(buildBlocks(posterWithSafeData(poster)));
  const pdf = await PDFDocument.create();
  for (let index = 0; index < pages.length; index += 1) {
    const svg = renderSvgPage(poster, pages[index], index, pages.length);
    const jpeg = await sharp(Buffer.from(svg)).jpeg({ quality: 78, mozjpeg: true }).toBuffer();
    const image = await pdf.embedJpg(jpeg);
    const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    page.drawImage(image, { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT });
  }
  return Buffer.from(await pdf.save({ useObjectStreams: true }));
}

function posterWithSafeData(poster: PosterRow): PosterRow {
  return {
    ...poster,
    data: poster.data && typeof poster.data === "object" ? poster.data : {},
  };
}

function sanitizeFileName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "poster";
}

async function uploadPdf(buffer: Buffer, fileName: string): Promise<string> {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error("Cloudinary config is missing");
  }
  const timestamp = Math.round(Date.now() / 1000);
  const paramsToSign = `folder=${CLOUDINARY_FOLDER}&timestamp=${timestamp}`;
  const signature = createHash("sha256").update(paramsToSign + apiSecret).digest("hex");
  const formData = new FormData();
  formData.append("file", new Blob([new Uint8Array(buffer)], { type: "application/pdf" }), fileName);
  formData.append("api_key", apiKey);
  formData.append("timestamp", String(timestamp));
  formData.append("signature", signature);
  formData.append("folder", CLOUDINARY_FOLDER);
  const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/raw/upload`, {
    method: "POST",
    body: formData,
  });
  const json = await response.json() as { secure_url?: string; error?: { message?: string } };
  if (!response.ok || !json.secure_url) {
    throw new Error(json.error?.message || `Cloudinary upload failed (${response.status})`);
  }
  return json.secure_url;
}

async function main() {
  const postersResult = await queryNeon<PosterRow>(
    `SELECT p.id, p.title, p.source_file, p.data
       FROM poster_trips p
       JOIN travel_trip_entries t ON t.extra->>'poster_trip_id' = p.id
      WHERE COALESCE(t.extra->>'brochure_pdf_url', '') = ''
        AND COALESCE(t.extra->>'source_file_attachment_id', '') = ''
      ORDER BY p.updated_at DESC`,
  );
  const posters = postersResult?.rows ?? [];
  let uploaded = 0;
  for (const poster of posters) {
    const pdf = await buildPosterPdf(posterWithSafeData(poster));
    const fileName = `${sanitizeFileName(poster.title)}-${poster.id}.pdf`;
    const url = await uploadPdf(pdf, fileName);
    const patch = {
      brochure_pdf_url: url,
      brochure_pdf_required: true,
      brochure_pdf_missing: false,
      brochure_pdf_generated_at: new Date().toISOString(),
      brochure_pdf_source: "poster_generator_backfill",
    };
    await queryNeon(
      `UPDATE travel_trip_entries
          SET photo_urls = '[]'::jsonb,
              extra = COALESCE(extra, '{}'::jsonb) || $1::jsonb,
              updated_at = NOW()
        WHERE extra->>'poster_trip_id' = $2`,
      [JSON.stringify(patch), poster.id],
    );
    uploaded += 1;
    console.log(`${uploaded}/${posters.length} ${poster.title} -> ${url} (${Math.round(pdf.length / 1024)} KB)`);
  }
  console.log(JSON.stringify({ posters: posters.length, uploaded }, null, 2));
}

main()
  .finally(() => closeNeonPool())
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
