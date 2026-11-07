/**
 * Every word the catalogue feature says to a customer or writes on a staff lead.
 *
 * Rules the copy keeps (owner's, AGENTS.md): short natural Mongolian, no emoji, never a promise of
 * availability, a price or a booking (people confirm those), and nothing that the bot's own
 * "no data" filter (reply.ts shouldSilenceNoDataReply) would read as a refusal and silence — the
 * wording below is checked against that filter in tests/catalogue-send.test.ts.
 */
import type { CatalogueEdition } from "./types";

const ASK_FOR_QUOTE =
  "Сонирхсон аяллынхаа код, хэдэн хүн, хэдэн сард аялахаа бичвэл манай ажилтан үнийн санал бэлтгэж өгнө.";

// Wording approved by the owner for launch (2026-11-07). The emoji is the owner's own.
const CAPTION_BODY =
  "Доорх PDF файлыг утсандаа татаж аваад интернэтгүй үед ч үзэж, хамт олонтойгоо хуваалцах боломжтой.\n\n"
  + "Сонирхсон аяллын код, аялах хүний тоо, хүссэн сараа бичвэл манай ажилтан танд тохирсон үнийн санал гаргаж өгнө.";

const CAPTION: Record<"quick" | "complete", string> = {
  quick: "Сайн байна уу! Манай байгууллага, хамт олны аяллын сонголтуудыг нэг каталогт багтаалаа. 📖\n\n" + CAPTION_BODY,
  complete: "Сайн байна уу! Манай бүх аяллын сонголтуудыг нэг каталогт нэгтгэлээ. 📖\n\n" + CAPTION_BODY,
};

/** The one short text that comes with the PDF. The preview edition (a sample) reads as the quick one. */
export function catalogueCaption(edition: CatalogueEdition): string {
  return edition === "complete" ? CAPTION.complete : CAPTION.quick;
}

/** True when `text` is one of the captions above: how a later "дахин явуул" finds the edition it repeats. */
export function catalogueEditionOfCaption(text: string): "quick" | "complete" | null {
  // The bot's presenter drops a leading "Сайн байна уу!" when the customer did not greet, so the stored
  // history line may lack it: compare without the greeting.
  const bare = (value: string) => value.trim().replace(/^Сайн байна уу!\s*/, "");
  const value = bare(String(text || ""));
  if (value === bare(CAPTION.quick)) return "quick";
  if (value === bare(CAPTION.complete)) return "complete";
  return null;
}

/** Only the link could be given (Instagram, or Meta would not take the file): one text with the file link. */
export function catalogueLinkOnlyText(edition: CatalogueEdition, url: string): string {
  const what = edition === "complete" ? "Манай аяллын каталогийг" : "Байгууллага, хамт олны аяллын каталогийг";
  return `${what} доорх холбоосоор нээж, утсандаа татаж аваарай:\n${url}\n${ASK_FOR_QUOTE}`;
}

/**
 * The caption was delivered but the file would not go after it: the link, once, in place of the file.
 * It says the file did not arrive (it does not say "if the file does not open", which tells the
 * customer a file is in the chat): the caption above it already spoke of a file below.
 */
export function catalogueLinkFollowupText(url: string): string {
  return `Файл дамжихгүй байна. Каталогийг энэ холбоосоор татаж аваарай:\n${url}`;
}

/**
 * The customer asks again after the catalogue already reached them: ONE short pointer, never a
 * second file. `linkOnly` = what they got before was the link (Instagram, or Meta refused the file).
 */
export function catalogueRepeatText(input: { url: string; linkOnly: boolean }): string {
  if (input.linkOnly) return `Каталогийн холбоосыг өмнө нь илгээсэн. Энэ холбоосоор дахин нээж, утсандаа татаж аваарай:\n${input.url}`;
  const open = "Каталогийн файлыг өмнө нь илгээсэн, чатынхаа дээд талаас нээнэ үү.";
  const link = input.url ? ` Нээгдэхгүй бол энэ холбоосоор татаж аваарай:\n${input.url}\n` : " ";
  return `${open}${link}Дахин илгээлгэхийг хүсвэл «дахин явуул» гэж бичээрэй.`;
}

/** Neither the file nor a link could be given after the caption: staff send it themselves. */
export const CATALOGUE_STAFF_WILL_SEND_TEXT = "Каталогийн файл дамжихгүй байна. Манай ажилтан тантай холбогдож каталогийг илгээнэ.";

/** The published file is out of date: no file, the live site, and a person follows up. */
export function catalogueStaleText(siteUrl: string): string {
  return `Каталогийг одоо шинэчилж байна. Одоогийн аяллуудыг манай вэбсайтаас үзнэ үү: ${siteUrl}\nМанай ажилтан тантай холбогдож сонголтуудыг илгээнэ.`;
}

/** A group quotation was asked for: what staff need, nothing promised. */
export function groupQuoteText(known: { groupSize: number | null; month: number | null }): string {
  const missing: string[] = [];
  if (known.groupSize === null) missing.push("хэдэн хүн");
  if (known.month === null) missing.push("хэдэн сард");
  missing.push("ямар чиглэл эсвэл каталогийн код");
  const ask = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(", ")} болон ${missing[missing.length - 1]}`;
  return `Бүлэг, байгууллагын үнийн саналыг манай ажилтан бэлтгэнэ. ${ask} гэдгээ бичнэ үү. `
    + "Аяллын сонголтуудыг каталогоор үзэхийг хүсвэл «каталог» гэж бичээрэй.";
}

/** One acknowledgement for a "A01, 25 хүн, 1-р сар" reply. States what was understood, promises nothing. */
export function tripCodeAckText(input: { code: string; title: string; groupSize: number | null; month: number | null }): string {
  const parts: string[] = [];
  if (input.groupSize !== null) parts.push(`${input.groupSize} хүн`);
  if (input.month !== null) parts.push(`${input.month}-р сар`);
  const head = `${input.code} · ${input.title}${parts.length ? ` (${parts.join(", ")})` : ""} гэж бүртгэлээ.`;
  const missing: string[] = [];
  if (input.groupSize === null) missing.push("хэдэн хүн");
  if (input.month === null) missing.push("хэдэн сард");
  const next = missing.length
    ? `${missing.join(", ")} аялахаа бичвэл манай ажилтан үнийн санал бэлтгэж өгнө.`
    : "Манай ажилтан үнийн санал бэлтгэж, тантай холбогдоно.";
  return `${head} ${next}`;
}

// ── Staff-facing lead text ────────────────────────────────────────────────────────────────────

const EDITION_LABEL: Record<CatalogueEdition, string> = { quick: "Хурдан каталог", complete: "Бүрэн каталог", preview: "Жишиг каталог" };

/** Why a catalogue request reached staff instead of the customer, in words a consultant reads. */
export function catalogueLeadContext(input: {
  edition: CatalogueEdition;
  reason: string;
  customerText: string;
  versionNo?: number | null;
  detail?: string | null;
}): string {
  const lines = [
    `Байгууллагын каталог хүссэн (${EDITION_LABEL[input.edition]}): ${input.reason}.`,
    input.versionNo ? `Нийтлэгдсэн хувилбар: v${input.versionNo}.` : "",
    input.detail ? input.detail : "",
    `Хэрэглэгчийн бичсэн: ${input.customerText.replace(/\s+/g, " ").trim().slice(0, 200)}`,
  ];
  return lines.filter(Boolean).join("\n");
}

/** Staff-facing reasons by delivery status (the log holds the machine-readable one). */
export const CATALOGUE_BLOCK_REASON_TEXT: Record<string, string> = {
  blocked_staff_owned: "ажилтан энэ харилцааг эзэмшиж байгаа тул бот файл илгээгээгүй",
  blocked_paused: "бот түр зогссон тул файл илгээгээгүй",
  blocked_window: "Messenger-ийн 24 цагийн хугацаа дууссан тул файл илгээгээгүй",
  blocked_killswitch: "Meta-д илгээх асаалт хаалттай тул файл илгээгээгүй",
  no_published_version: "нийтлэгдсэн каталог байхгүй тул юу ч илгээгээгүй",
  stale_fallback: "нийтлэгдсэн каталог хуучирсан тул файл илгээгээгүй, вэбсайтын холбоос явуулсан",
  duplicate_suppressed: "хэрэглэгч каталогийг дахин хүссэн, өмнө нь илгээсэн тул дахин илгээгээгүй",
  failed: "файл илгээж чадаагүй",
  sent_link_fallback: "файлыг Meta хүлээн аваагүй тул холбоос явуулсан",
};

/** A trip-code reply as one structured lead: staff read the lines, the last line is for tools. */
export function tripCodeLeadContext(input: {
  code: string;
  tripTitle: string | null;
  tripId: string | null;
  groupSize: number | null;
  month: number | null;
  note?: string | null;
  customerText: string;
}): string {
  const lines = [
    "Байгууллагын каталогоос үнийн санал хүссэн.",
    `Код: ${input.code}`,
    input.tripTitle ? `Аялал: ${input.tripTitle}` : "Аялал: олдсонгүй",
    `Хүний тоо: ${input.groupSize ?? "бичээгүй"}`,
    `Сар: ${input.month !== null ? `${input.month}-р сар` : "бичээгүй"}`,
    input.note ? input.note : "",
    `Хэрэглэгчийн бичсэн: ${input.customerText.replace(/\s+/g, " ").trim().slice(0, 200)}`,
    JSON.stringify({ source: "catalogue_code", code: input.code, tripId: input.tripId, groupSize: input.groupSize, month: input.month }),
  ];
  return lines.filter(Boolean).join("\n");
}

/** A group quotation asked for in words, with what is known so far. */
export function groupQuoteLeadContext(input: { groupSize: number | null; month: number | null; customerText: string }): string {
  return [
    "Бүлэг/байгууллагын үнийн санал хүссэн.",
    `Хүний тоо: ${input.groupSize ?? "бичээгүй"}`,
    `Сар: ${input.month !== null ? `${input.month}-р сар` : "бичээгүй"}`,
    `Хэрэглэгчийн бичсэн: ${input.customerText.replace(/\s+/g, " ").trim().slice(0, 200)}`,
    JSON.stringify({ source: "catalogue_group_quote", groupSize: input.groupSize, month: input.month }),
  ].join("\n");
}
