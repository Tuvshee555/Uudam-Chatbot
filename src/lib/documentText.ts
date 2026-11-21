/**
 * A file the admin attached to an instruction about SAVED trips, as plain text for the assistant's
 * agent (assistantAgent rule 13): Word (.docx, .doc), Excel, CSV, PDF with a text layer and text
 * files through the file reader (fileParse.ts, no model); a picture — a price and schedule table,
 * a photographed page — transcribed word for word by one vision call.
 *
 * The agent only reads this text; the new-trip reader is not involved. Nothing here writes.
 */
import { parseUpload } from "./fileParse";
import { askOpenAIChatParts } from "./openaiFallback";

export type DocumentText = { name: string; text: string; kind: "text" | "image" };
type Ask = typeof askOpenAIChatParts;

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&nbsp;": " " };
const decode = (value: string) => value.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity] ?? entity);

/**
 * The Excel reader's HTML tables as rows of text ("a | b | c"), one per line; everything else as it
 * is. A cell's own line breaks become " / "; a merged cell repeated across a row is written once.
 */
export function plainDocumentText(text: string): string {
  const source = String(text || "");
  if (!/<table[\s>]/i.test(source)) return source.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const out: string[] = [];
  const pieces = source.split(/(<h3[^>]*>[\s\S]*?<\/h3>|<tr[^>]*>[\s\S]*?<\/tr>)/gi);
  for (const piece of pieces) {
    const heading = /^<h3[^>]*>([\s\S]*?)<\/h3>$/i.exec(piece);
    if (heading) { out.push("", `# ${decode(heading[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()}`); continue; }
    if (!/^<tr[\s>]/i.test(piece)) {
      const loose = decode(piece.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
      if (loose) out.push(loose);
      continue;
    }
    const cells = [...piece.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map((cell) => decode(cell[1].replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")).split(/\n+/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).join(" / "));
    const row = cells.filter((cell, index) => cell && cell !== cells[index - 1]);
    if (row.length) out.push(row.join(" | "));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const TRANSCRIBE_PROMPT = [
  "Transcribe every piece of text in this image exactly as written, in reading order, as plain text.",
  "- A table: one line per row, the cells left to right separated by ' | ', the heading row first. Never merge two rows; never repeat the row above.",
  "- Copy every number, date, currency mark and unit digit for digit (1234 юань, 987,000 төг, 3/14).",
  "- Keep the language and spelling of the image. Do not translate, summarise, explain, correct or add anything.",
  "- Text you cannot read: write [уншигдахгүй] in its place.",
  "- Output the transcription only.",
].join("\n");

const isImage = (filename: string, mimeType: string) => mimeType.toLowerCase().startsWith("image/") || /\.(png|jpe?g|webp|gif|heic|heif)$/i.test(filename.trim());

/**
 * The text of one uploaded file. Throws with a plain Mongolian reason when nothing can be read
 * (an unsupported type, a scanned PDF, a picture the model could not transcribe).
 */
export async function documentTextOf(upload: { filename: string; mimeType?: string; dataBase64: string }, options: { ask?: Ask } = {}): Promise<DocumentText> {
  const name = upload.filename.trim() || "Файл";
  const parsed = await parseUpload({ filename: name, mimeType: upload.mimeType || "", dataBase64: upload.dataBase64 });
  if (!parsed.inline) {
    const text = plainDocumentText(parsed.text);
    if (!text) throw new Error(`«${name}» файлд уншигдах текст алга.`);
    return { name, text, kind: "text" };
  }
  if (!isImage(name, parsed.inline.mimeType)) throw new Error(`«${name}»: энэ төрлийн файлыг текст болгон уншиж чадахгүй.`);
  const ask = options.ask || askOpenAIChatParts;
  const result = await ask([{ text: TRANSCRIBE_PROMPT }, { inlineData: parsed.inline }], {
    model: "gpt-4o", temperature: 0, maxOutputTokens: 3_000, timeoutMs: 60_000, imageDetail: "high", source: "assistant.file_text.image",
  });
  const text = String(result?.text || "").replace(/^```[a-z]*\n?|\n?```$/gi, "").trim();
  if (!text) throw new Error(`«${name}» зургийг уншиж чадсангүй. Дахин оролдох эсвэл доторх мэдээллийг бичиж илгээнэ үү.`);
  return { name, text, kind: "image" };
}
