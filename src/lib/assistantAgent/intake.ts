/**
 * Taking stock of attached files, enforced in code (assistantAgent rule 14).
 *
 * Why (2026-11-21): told only in words to "ask what is open", the model proposed straight away.
 * On a replay of a real package (two saved programs, a schedule photo, a list of optional paid
 * items, one new trip) it asked nothing: the new trip went to the reader with only a yuan cost,
 * the archived trip the admin wanted active was never restored, and one sentence stood where a
 * list of dozens of priced items belonged.
 *
 * Now the model says what each file is (take_stock) and this module decides, from the files' own
 * text, the catalogue and the admin's words, which decisions are his alone; gives those questions
 * the same choices every time; reads his answers back as decisions; writes the note a new trip is
 * handed to the reader with; and names what a proposal still lacks. The agent loop (agent.ts)
 * does not finish around it. Pure: no model, no network, no database.
 */
import { distinctiveTokens, sharedDistinctive } from "../tripNameTokens";
import type { TravelTrip } from "../travelTypes";
import type { AgentDocument } from "./types";

export const FILE_KINDS = ["saved_program", "new_trip", "schedule", "extra_info", "other"] as const;
export type FileKind = (typeof FILE_KINDS)[number];
export const ASK_TOPICS = ["saved_or_new", "selling_price", "price_remark", "transport", "extras"] as const;
export type AskTopic = (typeof ASK_TOPICS)[number];

/** One attached file as the model classified it. `group`: new-trip files with the same number make ONE trip. */
export type StockFile = { file: string; kind: FileKind; trip_ids: string[]; group?: number };
export type MustAsk = { topic: AskTopic; file: string; trip_id?: string; why: string; quote?: string[] };
export type Asked = { topic: AskTopic | "other"; header: string; file?: string; trip_id?: string };
export type Choice = "update" | "new" | "draft" | "standard_train" | "as_file" | "list_priced" | "list_names" | "skip" | "said";
export type Decision = Asked & { choice: Choice; text: string };
export type Intake = { files: StockFile[]; asked: Asked[] };
export type FixedOption = { label: string; description: string; recommended?: boolean };
/** `options`: the system's choices instead of the model's; `append`: added after the model's own. */
export type FixedChoices = { options: FixedOption[]; append?: FixedOption[]; custom_label?: string; custom_placeholder?: string };
const LEAVE_PRICE: FixedOption = { label: "Одоохондоо хөндөхгүй", description: "Үнэ тодортол энэ аяллын үнийг өөрчлөхгүй; бусад өөрчлөлт хийгдэнэ." };

export type IntakeContext = {
  documents: AgentDocument[];
  byId: Map<string, TravelTrip>;
  /** The admin's own words: his message, and the first message when this one answers a question. */
  adminWords: string;
  /** This message answers the assistant's questions: nothing is asked twice. */
  answered: boolean;
  /** Trips his words name (or a link or a tapped option names): a file of such a trip is his to update. */
  named?: Set<string>;
};

/** The saved trips his words name: the distinctive words of a trip's name or alias (places, not "аялал", "хот"). */
export function tripsNamedIn(words: string, trips: TravelTrip[]): TravelTrip[] {
  const said = String(words || "");
  if (!distinctiveTokens(said).length) return [];
  return trips.filter((trip) => {
    if (trip.status === "draft" || trip.status === "cancelled") return false;
    const aliases = Array.isArray(trip.extra?.aliases) ? (trip.extra.aliases as unknown[]).filter((alias): alias is string => typeof alias === "string") : [];
    return [trip.route_name, ...aliases].some((name) => {
      const own = distinctiveTokens(name).length;
      return own > 0 && sharedDistinctive(name, said) >= Math.min(2, own);
    });
  });
}

/** His words ask for a change made with the files (update, restore, add), not a question about them. */
export function asksForChange(words: string): boolean {
  return /шинэчил|шинэчлэ|сэргээ|идэвхжүүл|идэвхтэй\s+болго|нэм|оруул|солих|сольж|засаад|засч|update|shinechil|shinechle|sergee|idevh?juul|(?:^|[^a-z])(?:nem|oruul)/iu.test(String(words || ""));
}

/**
 * The files must be taken stock of before the turn ends: several documents, or files the page sent
 * for a check, or one file with a change asked but no saved trip named ("аяллын хөтөлбөрийг энэ
 * файлаар шинэчил"). Not when he only says the files are a new trip, asks a question about them,
 * answers the assistant's questions, or revises a card.
 */
export function intakeNeeded(input: { documents: number; words: string; flagged: boolean; named: number; answering: boolean; revising: boolean }): boolean {
  if (!input.documents || input.answering || input.revising) return false;
  const said = adminFacts(input.words);
  if (said.fresh && !said.update && !said.activate) return false;
  if (input.flagged || input.documents >= 2) return true;
  return input.named === 0 && asksForChange(input.words);
}

export const squashName = (value: string) => String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const clean = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/* ---------------------------------------------------------------- */
/* What a file's own text shows                                     */
/* ---------------------------------------------------------------- */

export type DocumentFacts = {
  /** Program day rows ("Өдөр 3", "3-р өдөр"). */
  days: number;
  /** A tugrug selling price is written (an amount of 100,000 or more). */
  tugrug: boolean;
  /** Yuan amounts are written (a partner's cost, or prices paid on the spot). */
  yuan: boolean;
  /** Lines beside a price table that say what a price includes or adds. */
  remarks: string[];
  /** One of those lines reads two ways ("нэмэгдэнэ эсвэл үнэгүй"). */
  remarkTwoWays: boolean;
  /** The line saying the program starts or ends at the border ("" when none). */
  borderLine: string;
  /** Table rows that carry a small price of their own (a list of paid items). */
  pricedRows: number;
};

const TUGRUG_AMOUNT = /(?:^|[^\d.,])(\d{1,3}(?:[.,'’ ]\d{3})+|\d{6,7})(?!\d)(\s*(?:₮|төг|mnt))?/giu;
const REMARK_SUBJECT = /үнэ|юань|¥|төлбөр|хураамж/iu;
const REMARK_TWO_WAYS = /эсвэл|нэмэгдэнэ|нэмэгдэх|нэмж\s+төл|тусдаа\s+төл/iu;
const REMARK_GROUP = /групп|хүнтэй/iu;
const BORDER_LINE = /эрээн\p{L}*\s+эх[лэ]|замын[\s-]*үүд\p{L}*\s+(?:дуус|төгс)|хил\p{L}*\s+(?:дээрээс\s+)?эхл|автобус\p{L}*\s+(?:\p{L}+\s+){0,3}буц/iu;
const DAY_ROW = /^\s*(?:өдөр\s*\d+|\d+\s*[-.]?\s*(?:р|дахь|дэх|дугаар)?\s*өдөр|day\s*\d+)/iu;
const PRICED_CELL = /^\d{2,5}(?:\s*(?:юань|¥|元))?$/u;

const pricedRow = (line: string) => line.split(" | ").some((cell) => PRICED_CELL.test(cell.trim()));
const sheetLine = (line: string) => /^#\s/.test(line);

/**
 * The group headings of a priced list as the file writes them: a row with no price that has priced
 * rows under it ("超声科检查Хэт авиан шинжилгээ", "放射科CT（不含片） / 价格" → its first cell, a
 * trailing "/ 价格" column title dropped). The sheet name and the title above the first group are not groups.
 */
export function listGroupHeadings(text: string): string[] {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !sheetLine(line));
  const out: string[] = [];
  lines.forEach((line, index) => {
    if (pricedRow(line) || !lines[index + 1] || !pricedRow(lines[index + 1])) return;
    const heading = line.split(" | ")[0].replace(/\s*\/\s*(?:价格|үнэ|price)\s*$/iu, "").trim();
    if (heading) out.push(heading.slice(0, 120));
  });
  return out;
}

export function hasTugrugAmount(text: string): boolean {
  const source = String(text || "");
  if (/\d+(?:[.,]\d+)?\s*сая/iu.test(source)) return true;
  for (const match of source.matchAll(TUGRUG_AMOUNT)) {
    const value = Number(match[1].replace(/\D/g, ""));
    if (value >= 100_000 && value < 100_000_000 && (/\D/.test(match[1]) || match[2])) return true;
  }
  return false;
}

export function documentFacts(text: string): DocumentFacts {
  const source = String(text || "");
  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const loose = lines.filter((line) => !line.includes(" | ") && line.length <= 240);
  const remarks = loose.filter((line) => REMARK_SUBJECT.test(line) && (REMARK_TWO_WAYS.test(line) || REMARK_GROUP.test(line))).slice(0, 4);
  return {
    days: new Set(lines.filter((line) => DAY_ROW.test(line)).map((line) => /\d+/.exec(line)?.[0])).size,
    tugrug: hasTugrugAmount(source),
    yuan: /\d\s*(?:¥|юань|yuan|元|rmb|cny)|(?:¥|юань)\s*\d/iu.test(source),
    remarks,
    remarkTwoWays: remarks.some((line) => REMARK_TWO_WAYS.test(line)),
    borderLine: loose.find((line) => BORDER_LINE.test(line)) || "",
    pricedRows: lines.filter((line) => line.includes(" | ") && line.split(" | ").some((cell) => PRICED_CELL.test(cell.trim()))).length,
  };
}

/** What the admin's own words already decide. */
export function adminFacts(words: string) {
  const text = String(words || "").toLowerCase();
  return {
    /** He typed a tugrug amount ("1,590,000", "1.2 сая", "100k"). */
    tugrug: hasTugrugAmount(text) || /\d+\s*(?:мянга|k|к)(?![a-zа-яөүё])/iu.test(text),
    draft: /ноорог|noorog|draft/iu.test(text),
    transport: /галт\s*тэр|автобус|galt\s*tereg|avtobus|файлд\s+бичсэн/iu.test(text),
    extras: /үнэтэй\s+нь|үнийг\s+нь|юан|нэрсийг|нэрийг\s+нь|нэмэхгүй/iu.test(text),
    update: /шинэчил|шинэчлэ|сэргээ|идэвхжүүл|идэвхтэй\s+болго|update|shinechil|shinechle|sergee|idevh?juul/iu.test(text),
    fresh: /шинэ\s+аял|шинээр|shine\s+ay?al|shineer/iu.test(text),
    activate: /сэргээ|идэвхжүүл|идэвхтэй\s+болго|sergee|idevh?juul|idevhtei\s+bolgo/iu.test(text),
  };
}

/* ---------------------------------------------------------------- */
/* The model's classification, checked                              */
/* ---------------------------------------------------------------- */

/** take_stock's `files` as the turn keeps them: every attached file once, with trips the catalogue has. */
export function stockFilesOf(raw: unknown, documents: AgentDocument[], byId: Map<string, TravelTrip>): { files: StockFile[] } | { error: string } {
  const names = documents.map((document) => document.name);
  const byKey = new Map(names.map((name) => [squashName(name), name]));
  const out = new Map<string, StockFile>();
  for (const item of Array.isArray(raw) ? raw : []) {
    const entry = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const key = squashName(clean(entry.file));
    const name = key ? byKey.get(key) ?? [...byKey.entries()].find(([known]) => known.includes(key) || key.includes(known))?.[1] : undefined;
    if (!name) return { error: `"${clean(entry.file)}" is not an attached file. The attached files: ${names.map((known) => `"${known}"`).join(", ")}.` };
    const kind = FILE_KINDS.find((known) => known === clean(entry.kind));
    if (!kind) return { error: `"${name}": kind must be one of ${FILE_KINDS.join(", ")}.` };
    const tripIds = [...new Set((Array.isArray(entry.trip_ids) ? entry.trip_ids : []).map(clean).filter(Boolean))];
    const unknown = tripIds.find((id) => !byId.has(id));
    if (unknown) return { error: `"${name}": trip_id ${unknown} is not in the catalogue (use ids search_trips returned).` };
    if ((kind === "saved_program" || kind === "schedule") && tripIds.length !== 1) return { error: `"${name}": a ${kind} belongs to exactly ONE saved trip (trip_ids: [its id]). A price table of a trip the catalogue does not have is part of that new trip: kind new_trip with the same group.` };
    if (kind === "extra_info" && !tripIds.length) return { error: `"${name}": say which saved trips this information is for (trip_ids). Information for a trip the catalogue does not have is part of that new trip: kind new_trip with the same group.` };
    const group = Number(entry.group);
    out.set(name, { file: name, kind, trip_ids: kind === "new_trip" || kind === "other" ? [] : tripIds, ...(kind === "new_trip" && Number.isInteger(group) && group > 0 ? { group } : {}) });
  }
  const missing = names.filter((name) => !out.has(name));
  if (missing.length) return { error: `Say what every attached file is. Missing: ${missing.map((name) => `"${name}"`).join(", ")}.` };
  return { files: names.map((name) => out.get(name)!) };
}

/** The new-trip files as trips: files sharing a group are one trip; ungrouped files are one trip when only one of them is a program. */
export function newTripGroups(files: StockFile[], decisions: Decision[], documents: AgentDocument[]): string[][] {
  const madeNew = new Set(decisions.filter((decision) => decision.topic === "saved_or_new" && decision.choice === "new" && decision.file).map((decision) => decision.file!));
  const fresh = files.filter((file) => file.kind === "new_trip" || madeNew.has(file.file));
  if (!fresh.length) return [];
  const grouped = new Map<number, string[]>();
  const loose: string[] = [];
  for (const file of fresh) {
    if (file.group) grouped.set(file.group, [...(grouped.get(file.group) || []), file.file]);
    else loose.push(file.file);
  }
  const textOf = (name: string) => documents.find((document) => document.name === name)?.text || "";
  const programs = loose.filter((name) => documentFacts(textOf(name)).days >= 2);
  const looseGroups = programs.length <= 1 ? (loose.length ? [loose] : []) : loose.map((name) => [name]);
  return [...grouped.values(), ...looseGroups];
}

/* ---------------------------------------------------------------- */
/* What only the admin can decide                                   */
/* ---------------------------------------------------------------- */

const hasPrice = (trip: TravelTrip | undefined) => typeof trip?.adult_price === "number" && trip.adult_price > 0;
const STATUS_WORDS: Record<string, string> = { active: "идэвхтэй", paused: "түр зогссон", sold_out: "дүүрсэн", draft: "ноорог", archived: "архивт", cancelled: "цуцалсан" };

export function mustAsk(files: StockFile[], context: IntakeContext): MustAsk[] {
  if (context.answered) return [];
  const said = adminFacts(context.adminWords);
  const out: MustAsk[] = [];
  for (const file of files) {
    const facts = documentFacts(context.documents.find((document) => document.name === file.file)?.text || "");
    const trip = context.byId.get(file.trip_ids[0] || "");
    // His words do not say update or new — or say "update" without naming the trip: the file's trip is
    // already saved (maybe live on the site), so he is told which one and asked (owner, 2026-11-21).
    const named = Boolean(trip && context.named?.has(trip.id));
    if (file.kind === "saved_program" && ((!said.update && !said.fresh) || !named)) {
      out.push({ topic: "saved_or_new", file: file.file, trip_id: trip?.id, why: named
        ? `the catalogue already has this trip (${trip?.status || "saved"}) and his words do not say whether to update it or add another`
        : `his words name no trip; the file is the program of a trip already saved (${trip?.status === "active" ? "LIVE on the site" : trip?.status || "saved"}): say which one, what compare_program found, and ask` });
    }
    if (file.kind === "new_trip") {
      if (facts.days >= 2 && !facts.tugrug && !said.tugrug && !said.draft) {
        out.push({ topic: "selling_price", file: file.file, why: facts.yuan ? "the file gives only yuan / «ланд» amounts (the partner's cost) and no tugrug selling price" : "the file gives no tugrug selling price" });
      }
      if (facts.borderLine && !said.transport) out.push({ topic: "transport", file: file.file, why: "the program starts or ends at the border", quote: [facts.borderLine] });
    }
    if (file.kind === "schedule") {
      if (facts.remarkTwoWays && !said.tugrug) {
        out.push({ topic: "price_remark", file: file.file, trip_id: trip?.id, why: "a remark beside the price table reads two ways: what are customers told?", quote: facts.remarks });
      } else if (trip && !hasPrice(trip) && !facts.tugrug && !said.tugrug && !said.draft) {
        out.push({ topic: "selling_price", file: file.file, trip_id: trip.id, why: "the trip has no saved price and the table gives no tugrug selling price" });
      }
    }
    // A priced list can be shown with or without its prices; a plain list has nothing to decide.
    if (file.kind === "extra_info" && !said.extras && facts.pricedRows >= 3) {
      out.push({ topic: "extras", file: file.file, why: `a list of ${facts.pricedRows} optional priced items` });
    }
  }
  return out;
}

/** The choices of a question the system knows: the same words every time (null: the model writes them). */
export function fixedChoices(topic: AskTopic | "other", trip?: TravelTrip): FixedChoices | null {
  if (topic === "saved_or_new") {
    const live = !trip || trip.status === "active";
    return { options: [
      live
        ? { label: "Одоо байгааг шинэчлэх", description: "Зөвхөн файлд өөрчлөгдсөн буудал, өгүүлбэр, огноог санал болгоно; хадгалсан үг хэллэг хэвээр.", recommended: true }
        : { label: "Сэргээж шинэчлэх", description: "Архиваас гаргаж, файлын ирэх огноо болон өөрчлөгдсөн зүйлийг санал болгоно; хадгалсан үг хэллэг хэвээр.", recommended: true },
      { label: "Шинэ аялал болгон нэмэх", description: "Тусдаа шинэ аялал үүснэ; одоо байгаа нь өөрчлөгдөхгүй." },
    ] };
  }
  if (topic === "selling_price") {
    return {
      options: [{ label: "Ноорог болгож хадгалах", description: "Үнэ тодортол сайт, ботод гарахгүй; үнээ нэмээд дараа нь нийтэлнэ." }],
      custom_label: "Зарах үнээ бичих", custom_placeholder: "том хүн …₮, хүүхэд …₮",
    };
  }
  if (topic === "transport") {
    return { options: [
      { label: "Стандарт галт тэрэгний өдрүүд", description: "Улаанбаатараас галт тэргээр гарч, галт тэргээр буцаж ирэх манай жишиг өдрүүдийг хөтөлбөрт нэмнэ.", recommended: true },
      { label: "Файлд бичсэнээр", description: "Хөтөлбөрийг файлд бичсэн чигээр нь оруулна (хил дээрээс эхэлж, хил дээр дуусна)." },
    ] };
  }
  if (topic === "extras") {
    return { options: [
      { label: "Үнэтэй нь жагсаах", description: "Зүйл бүрийг юанийн үнэтэй нь аяллын тайлбарт нэмнэ — хүсвэл газар дээрээ төлж хийлгэх нэмэлт гэж бичнэ.", recommended: true },
      { label: "Зөвхөн нэрсийг", description: "Зүйлсийг үнэ бичихгүйгээр жагсаана." },
      { label: "Нэмэхгүй", description: "Энэ жагсаалтыг аялалд оруулахгүй." },
    ] };
  }
  if (topic === "price_remark") return { options: [], append: [LEAVE_PRICE], custom_label: "Үнээ өөрөө бичих", custom_placeholder: "том хүн …₮, хүүхэд …₮" };
  return null;
}

/** A question the system writes itself when the model left a decision out. */
export function fallbackQuestion(must: MustAsk, context: IntakeContext): { header: string; text: string; options: FixedOption[] } {
  const trip = context.byId.get(must.trip_id || "");
  const facts = documentFacts(context.documents.find((document) => document.name === must.file)?.text || "");
  const quoted = (must.quote || []).map((line) => `«${line}»`).join("; ");
  if (must.topic === "saved_or_new") {
    return { header: "Аялал байна", options: [], text: `«${trip?.route_name || must.file}» аялал бүртгэлд аль хэдийн байна (${[STATUS_WORDS[trip?.status || ""] || "хадгалсан", clean(trip?.duration_text)].filter(Boolean).join(", ")}). «${must.file}» файлаар юу хийх вэ?` };
  }
  if (must.topic === "selling_price") {
    return { header: "Зарах үнэ", options: [], text: `«${trip?.route_name || must.file}»: файлд төгрөгийн зарах үнэ алга${facts.yuan ? " (зөвхөн юань / ланд үнэ байна — энэ бол хамтрагчийн өртөг)" : ""}. Зарах үнээ бичнэ үү (том хүн, хүүхэд).` };
  }
  if (must.topic === "transport") {
    return { header: "Тээвэр", options: [], text: `«${must.file}»: хөтөлбөр хил дээрээс эхэлж, хил дээр дуусна гэжээ${quoted ? ` (${quoted})` : ""}. Улаанбаатараас яаж явах вэ?` };
  }
  if (must.topic === "extras") {
    return { header: "Нэмэлт жагсаалт", options: [], text: `«${must.file}» нь нэмэлт (төлбөртэй) зүйлсийн жагсаалт байна${facts.pricedRows ? ` (${facts.pricedRows} мөр, юаниар)` : ""}. Аяллын тайлбарт яаж оруулах вэ?` };
  }
  return {
    header: "Үнийн тайлбар",
    text: `«${trip?.route_name || must.file}»: хуваарийн файлд ${quoted || "үнийн тайлбар"} гэсэн тайлбар байна. Үйлчлүүлэгчид ямар үнэ хэлэх вэ? Үнээ бичнэ үү (том хүн, хүүхэд).`,
    options: [],
  };
}

/* ---------------------------------------------------------------- */
/* His answers, read back as decisions                              */
/* ---------------------------------------------------------------- */

const LABEL_CHOICES: Array<[string, Choice]> = [
  ["Одоо байгааг шинэчлэх", "update"], ["Сэргээж шинэчлэх", "update"], ["Шинэ аялал болгон нэмэх", "new"], ["Ноорог болгож хадгалах", "draft"],
  [LEAVE_PRICE.label, "skip"], ["Стандарт галт тэрэгний өдрүүд", "standard_train"], ["Файлд бичсэнээр", "as_file"], ["Үнэтэй нь жагсаах", "list_priced"], ["Зөвхөн нэрсийг", "list_names"], ["Нэмэхгүй", "skip"],
];

/** Each answer of the dialog with the question it belongs to: a known choice, or what he said in his own words. */
export function decisionsOf(asked: Asked[], answers: string[]): Decision[] {
  return asked.flatMap((question, index) => {
    const raw = clean(answers[index]).replace(/\s*\[сонгосон аялал:[^\]]*\]/gu, "").trim();
    if (!raw) return [];
    const body = raw.startsWith(`${question.header}:`) ? raw.slice(question.header.length + 1).trim() : raw;
    const known = question.topic === "other" ? undefined : LABEL_CHOICES.find(([label]) => body === label || body.startsWith(`${label} —`));
    return [{ ...question, choice: known ? known[1] : "said", text: known ? known[0] : body }];
  });
}

export function packIntake(intake: Intake): string {
  return JSON.stringify({ v: 1, files: intake.files, asked: intake.asked }).slice(0, 6_000);
}

/** The classification echoed with an answer, accepted only where it still fits the files and the catalogue. */
export function unpackIntake(raw: unknown, documents: AgentDocument[], byId: Map<string, TravelTrip>): Intake | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let parsed: { files?: unknown; asked?: unknown };
  try { parsed = JSON.parse(raw) as { files?: unknown; asked?: unknown }; } catch { return null; }
  const stock = stockFilesOf(parsed.files, documents, byId);
  if ("error" in stock) return null;
  const names = new Set(stock.files.map((file) => file.file));
  const asked = (Array.isArray(parsed.asked) ? parsed.asked : []).slice(0, 6).flatMap((item): Asked[] => {
    const entry = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const header = clean(entry.header).slice(0, 40);
    if (!header) return [];
    const topic = ASK_TOPICS.find((known) => known === entry.topic) ?? "other";
    const file = clean(entry.file);
    const tripId = clean(entry.trip_id);
    return [{ topic, header, ...(names.has(file) ? { file } : {}), ...(byId.has(tripId) ? { trip_id: tripId } : {}) }];
  });
  return { files: stock.files, asked };
}

/* ---------------------------------------------------------------- */
/* After the decisions: the work, the hand-off, the gaps            */
/* ---------------------------------------------------------------- */

const decided = (decisions: Decision[], topic: AskTopic, file: string) => decisions.find((decision) => decision.topic === topic && decision.file === file);
const isNew = (file: StockFile, decisions: Decision[]) => file.kind === "new_trip" || decided(decisions, "saved_or_new", file.file)?.choice === "new";

/**
 * A fare the file itself writes as free for the youngest ("<YYYY>-<YYYY> он хүүхэд-үнэгүй", "нярай үнэгүй"):
 * said to the reader as an infant fare, which it keeps at 0. The real New Year file of 2026-11-21 put it
 * in a child row by birth year; the reader left the infant fare empty and the owner had to say "infant is free".
 */
export function freeInfantLine(text: string, now = new Date()): string {
  const year = Number(todayIso(now).slice(0, 4));
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!/үнэгүй/iu.test(line)) continue;
    if (/нярай|0\s*[-–]\s*2\s*нас|0\s*[-–]\s*23\s*сар/iu.test(line)) return `Нярай: үнэгүй (файлд «${line.trim().slice(0, 120)}»).`;
    const born = /(20\d{2})\s*[-–]\s*(20\d{2})\s*он/u.exec(line);
    if (born && Number(born[2]) >= year - 1 && Number(born[1]) >= year - 3) return `Нярай (${born[1]}–${born[2]} онд төрсөн): үнэгүй (файлд «${line.trim().slice(0, 120)}»).`;
  }
  return "";
}

/** What the new-trip reader is told with a handed-off file: the admin's own decisions about THAT trip, in plain words. */
export function handoffNote(files: string[], decisions: Decision[], adminWords: string, fileText = "", now = new Date()): string {
  const mine = decisions.filter((decision) => decision.file && files.includes(decision.file));
  if (!mine.length) return clean(adminWords).slice(0, 2_000);
  const lines = ["Шинэ аялал болгон нэм."];
  for (const decision of mine) {
    if (decision.topic === "selling_price") lines.push(decision.choice === "draft" ? "Зарах үнэ одоогоор тодорхойгүй: үнэгүйгээр, ноорог болгож хадгална." : `Зарах үнэ: ${decision.text}`);
    else if (decision.topic === "transport") lines.push(decision.choice === "standard_train" ? "Тээвэр: стандарт галт тэрэгний өдрүүд — Улаанбаатараас галт тэргээр гарч, галт тэргээр буцна." : decision.choice === "as_file" ? "Тээвэр: файлд бичсэнээр (галт тэрэгний өдөр нэмэхгүй)." : `Тээвэр: ${decision.text}`);
    else if (decision.topic !== "saved_or_new") lines.push(`${decision.header}: ${decision.text}`);
  }
  // Typed fares leave the youngest out; a free infant fare the file states is kept.
  const typedPrice = mine.some((decision) => decision.topic === "selling_price" && decision.choice === "said");
  const infant = typedPrice && !/нярай|infant/iu.test(mine.map((decision) => decision.text).join(" ")) ? freeInfantLine(fileText, now) : "";
  if (infant) lines.push(infant);
  return lines.join("\n").slice(0, 2_000);
}

/** The work each file means once everything is decided: for the model (take_stock's result, the answer turn's message). */
export function todoLines(intake: Intake, decisions: Decision[], context: IntakeContext): string[] {
  const said = adminFacts(context.adminWords);
  const lines: string[] = [];
  for (const file of intake.files) {
    const trip = context.byId.get(file.trip_ids[0] || "");
    const name = trip ? `«${trip.route_name}» (trip_id ${trip.id}, ${trip.status})` : "";
    const facts = documentFacts(context.documents.find((document) => document.name === file.file)?.text || "");
    if (isNew(file, decisions)) { lines.push(`"${file.file}": a NEW trip. The system hands it to the new-trip reader with his answers about it; do not edit any saved trip for it.`); continue; }
    const restore = trip && (trip.status === "archived" || trip.status === "paused") && (said.activate || decided(decisions, "saved_or_new", file.file)?.choice === "update");
    if (file.kind === "saved_program") {
      lines.push(`"${file.file}": the program of ${name}. get_trip, compare_program, then patch ONLY what its result lists (a difference that is only spelling or punctuation of the same hotel is not a change).${restore ? ` The trip is ${trip!.status} and must become active: patch {fields:{status:"active"}} with change_dates {add_dates: every coming departure its schedule gives} and his fares in the same proposal.` : ""}`);
    } else if (file.kind === "schedule") {
      const price = decided(decisions, "price_remark", file.file) ?? decided(decisions, "selling_price", file.file);
      const priceLine = price?.choice === "skip" ? " He chose to leave the prices for now: no fare change." : price ? ` His answer about the price: "${price.text}" — amounts he typed are the selling price (fare_change_all {adult:{set}, child:{set}}); a chosen reading: use that reading's tugrug figures.` : " Prices: his typed amounts, else the file's tugrug selling price; never yuan.";
      lines.push(`"${file.file}": departures and prices of ${name}: change_dates {add_dates: the coming days it lacks, never a past day}; an age range or bed condition written in the price heading → set_age_bands.${priceLine}${restore ? ` The trip is ${trip!.status}: also patch {fields:{status:"active"}}.` : ""}`);
    } else if (file.kind === "extra_info") {
      const choice = decided(decisions, "extras", file.file);
      const trips = file.trip_ids.map((id) => `«${context.byId.get(id)?.route_name}» (${id})`).join(", ");
      if (choice?.choice === "skip") lines.push(`"${file.file}": he chose NOT to add this list. Leave it out.`);
      else if (choice?.choice === "list_names") lines.push(`"${file.file}": append_notes {trip_ids: [${file.trip_ids.join(", ")}], heading, text} for ${trips}: EVERY one of its ${facts.pricedRows || "listed"} items, one per line, names only (no amounts).`);
      else lines.push(`"${file.file}": append_notes {trip_ids: [${file.trip_ids.join(", ")}], heading, text} for ${trips}: EVERY one of its ${facts.pricedRows || "listed"} priced rows as its own line "name: 123 юань", under its group heading; a summary sentence instead of the list is refused.${choice?.choice === "said" ? ` His words: "${choice.text}".` : ""}`);
    }
  }
  return lines;
}

type ProposedAction = { action?: unknown; trip_id?: unknown; trip_ids?: unknown; fields?: unknown; text?: unknown; add_dates?: unknown };
/** A missing piece: `model` sends the model back with what to add; `admin` is said on the card if it is still missing. */
export type ProposalGap = { model: string; admin: string };

const todayIso = (now: Date) => new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
/** Departures from today on (ISO days only; a yearless or worded date is not counted). */
function comingDays(dates: unknown, now: Date): string[] {
  const today = todayIso(now);
  return (Array.isArray(dates) ? dates : []).filter((value): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= today);
}
const STATUS_MN: Record<string, string> = { archived: "архивт", paused: "түр зогссон" };

/** The child age band a price table writes ("хүүхэд 2-11 нас оргүй" → "2-11 нас, ор эзлэхгүй"); null when none. */
export function childBandOf(text: string): { range: string; text: string } | null {
  const match = /хүүхэд\S*\s*\(?\s*(\d{1,2})\s*[-–]\s*(\d{1,2})\s*нас\S*\s*(оргүй|ор\s+эзлэхгүй)?/iu.exec(String(text || ""));
  if (!match) return null;
  const range = `${match[1]}-${match[2]}`;
  return { range, text: `${range} нас${match[3] ? ", ор эзлэхгүй" : ""}` };
}

/**
 * What a proposal still lacks against the files and his decisions. Read on the model's actions (one
 * per trip once `trip_ids` is spread) or on built ones: change_dates as add_dates or the new
 * departure list, fares as fare_change_all / set_date_price or the new prices.
 */
export function proposalGaps(input: { intake: Intake; decisions: Decision[]; actions: ProposedAction[]; context: IntakeContext; compared: Set<string>; now?: Date }): ProposalGap[] {
  const { intake, decisions, context } = input;
  const now = input.now ?? new Date();
  const actions = input.actions.flatMap((action) => {
    const ids = Array.isArray(action.trip_ids) ? action.trip_ids.filter((id): id is string => typeof id === "string") : [];
    return ids.length ? ids.map((id) => ({ ...action, trip_id: id })) : [action];
  });
  const said = adminFacts(context.adminWords);
  const gaps: ProposalGap[] = [];
  const mine = (tripId: string) => actions.filter((action) => action.trip_id === tripId);
  const goesLive = (tripId: string) => mine(tripId).some((action) => action.action === "patch" && (action.fields as { status?: unknown } | undefined)?.status === "active");
  const fieldsOf = (action: ProposedAction) => (action.fields || {}) as { departure_dates?: unknown; adult_price?: unknown; extra?: { price_groups?: unknown } };
  const restored = new Set<string>();
  for (const file of intake.files) {
    if (isNew(file, decisions)) continue;
    const trip = context.byId.get(file.trip_ids[0] || "");
    if (file.kind === "saved_program" && trip && !input.compared.has(trip.id)) {
      gaps.push({
        model: `"${file.file}" is the program of «${trip.route_name}»: get_trip and compare_program {trip_id: "${trip.id}"} first, then patch what its result lists.`,
        admin: `«${trip.route_name}»: файлын хөтөлбөрийг хадгалсан хөтөлбөртэй тулгаж амжаагүй — өдрүүдийн өөрчлөлтийг дахин шалгуулна уу.`,
      });
    }
    const wanted = (file.kind === "saved_program" || file.kind === "schedule") && trip && (trip.status === "archived" || trip.status === "paused")
      && (said.activate || decided(decisions, "saved_or_new", file.file)?.choice === "update");
    if (wanted && trip && !restored.has(trip.id) && !goesLive(trip.id)) {
      restored.add(trip.id);
      gaps.push({
        model: `«${trip.route_name}» is ${trip.status} and the admin wants it active: add patch {trip_id: "${trip.id}", fields:{status:"active"}} together with change_dates {add_dates: its coming departures from the schedule file} and his fares. If no coming date is known, ask_user for the dates instead.`,
        admin: `«${trip.route_name}» ${STATUS_MN[trip.status] || trip.status} хэвээр — идэвхжүүлэх өөрчлөлт саналд ороогүй.`,
      });
    }
    // A trip brought back needs a coming departure and a price, or it goes straight back to the archive / sells at nothing.
    if (trip && (file.kind === "schedule" || wanted) && !restored.has(trip.id) && goesLive(trip.id)) {
      restored.add(trip.id);
      const dated = comingDays(trip.departure_dates, now).length > 0
        || mine(trip.id).some((action) => comingDays(fieldsOf(action).departure_dates, now).length > 0 || (action.action === "change_dates" && comingDays(action.add_dates, now).length > 0));
      const priced = (typeof trip.adult_price === "number" && trip.adult_price > 0)
        || mine(trip.id).some((action) => action.action === "fare_change_all" || action.action === "set_date_price" || typeof fieldsOf(action).adult_price === "number" || Array.isArray(fieldsOf(action).extra?.price_groups));
      if (!dated) gaps.push({
        model: `«${trip.route_name}» goes live with no coming departure: change_dates {trip_id: "${trip.id}", add_dates: the coming days of the schedule} (never a past day).`,
        admin: `«${trip.route_name}» ирэх гаралтгүйгээр идэвхжих гэж байна — гарах өдрөө нэмнэ үү, эс бөгөөс дахин архивт орно.`,
      });
      const leftPrice = decided(decisions, "price_remark", file.file)?.choice === "skip" || decided(decisions, "selling_price", file.file)?.choice === "skip";
      if (!priced && !leftPrice) gaps.push({
        model: `«${trip.route_name}» has no saved price: fare_change_all {trip_ids: ["${trip.id}"], change: {adult:{set}, child:{set}}} with his answer's amounts (or the file's tugrug selling price).`,
        admin: `«${trip.route_name}»-д үнэ алга — том хүн, хүүхдийн үнийг нэмнэ үү.`,
      });
    }
    // The child band a schedule writes beside its fares ("хүүхэд 2-11 нас оргүй") goes on the trip with them.
    if (file.kind === "schedule" && trip) {
      const band = childBandOf(context.documents.find((document) => document.name === file.file)?.text || "");
      const saved = String((trip.extra?.age_rules as { child?: unknown } | undefined)?.child ?? "").replace(/–/g, "-");
      if (band && !saved.includes(band.range) && !mine(trip.id).some((action) => action.action === "set_age_bands")) {
        gaps.push({
          model: `"${file.file}" writes the child fare for "${band.text}": set_age_bands {trip_id: "${trip.id}", bands: {child: "${band.text}"}} with the fares.`,
          admin: `«${trip.route_name}»: файлд хүүхдийн нас «${band.text}» гэж байна — насны ангилалд оруулаагүй.`,
        });
      }
    }
    if (file.kind === "extra_info") {
      const choice = decided(decisions, "extras", file.file)?.choice;
      if (choice === "skip") continue;
      const fileText = context.documents.find((document) => document.name === file.file)?.text || "";
      const rows = documentFacts(fileText).pricedRows;
      const groups = listGroupHeadings(fileText);
      for (const id of file.trip_ids) {
        const note = mine(id).find((action) => action.action === "append_notes");
        const name = context.byId.get(id)?.route_name || id;
        if (!note) {
          gaps.push({ model: `"${file.file}" must be added to «${name}»: append_notes {trip_ids: [..., "${id}"], heading, text} with every item.`, admin: `«${file.file}» жагсаалт «${name}»-д нэмэгдээгүй.` });
          continue;
        }
        const lines = clean(note.text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const items = lines.filter((line) => !line.endsWith(":") && !/^жич/iu.test(line));
        const headings = lines.filter((line) => line.endsWith(":") && !/\d\s*(?:юань|¥|₮)/iu.test(line)).length;
        const listed = choice === "list_names" ? items.length : items.filter((line) => /\d/.test(line)).length;
        const short = rows >= 5 && listed < Math.ceil(rows * 0.85);
        // The file's own groups stay: on 2026-11-22 a reading kept all 54 items as one flat list (the site shows each group as a block).
        const flat = groups.length >= 3 && headings < Math.ceil(groups.length * 0.7);
        if (short || flat) {
          gaps.push({
            model: [
              short ? `The section for «${name}» lists ${listed} items, but "${file.file}" has ${rows} priced rows: write EVERY row as its own line (${choice === "list_names" ? "the name only" : "\"name: 123 юань\""}).` : "",
              flat ? `The section for «${name}» has ${headings} group headings, but "${file.file}" sorts its items under ${groups.length}: ${groups.map((group) => `«${group}»`).join(", ")}. Put each group's heading in Mongolian on its own line ending with ":" right before its items (a heading the file mistranslates is worded from its Chinese).` : "",
              "Write the section once with trip_ids for all the trips.",
            ].filter(Boolean).join(" "),
            admin: short
              ? `«${name}»: жагсаалтын ${rows} мөрөөс ${listed} нь л саналд орсон — бүгдийг нь оруулахыг дахин хүснэ үү.`
              : `«${name}»: жагсаалтын бүлгийн гарчгууд (${groups.length}) орхигдсон — бүлэг бүрийн гарчгийг нэмэхийг дахин хүснэ үү.`,
          });
          break;
        }
      }
    }
  }
  return gaps;
}

/* ---------------------------------------------------------------- */
/* The classification checked against the files' own titles         */
/* ---------------------------------------------------------------- */

const daysOfTrip = (trip: TravelTrip) => Number(/(\d+)\s*өдөр/u.exec(clean(trip.duration_text))?.[1] || 0);

/**
 * The saved trips a file's title names: the distinctive words of its first three lines shared with a
 * trip's name (two at least), most first, live first. On the real package of 2026-11-21 the trip with
 * the most shared words (then the same number of days, then the live one) was the right trip for each
 * program and for the price photo; the model, untold, picked an archived copy and a look-alike trip.
 */
export function titleMatches(text: string, trips: TravelTrip[]): Array<{ trip: TravelTrip; shared: number }> {
  const head = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 3).join(" ").slice(0, 400);
  if (!head) return [];
  return trips.filter((trip) => trip.status !== "draft" && trip.status !== "cancelled")
    .map((trip) => ({ trip, shared: sharedDistinctive(trip.route_name, head) }))
    .filter((entry) => entry.shared >= 2)
    .sort((a, b) => b.shared - a.shared || Number(b.trip.status === "active") - Number(a.trip.status === "active"));
}

/** What is wrong with take_stock's answer, for the model to fix (empty: accepted). */
export function stockProblems(files: StockFile[], input: { documents: AgentDocument[]; trips: TravelTrip[]; byId: Map<string, TravelTrip>; compared: Set<string> }): string[] {
  const problems: string[] = [];
  const textOf = (name: string) => input.documents.find((document) => document.name === name)?.text || "";
  const describe = (trip: TravelTrip) => `«${trip.route_name}» (trip_id ${trip.id}, ${trip.status}, ${clean(trip.duration_text) || "?"})`;
  const programTrips: string[] = [];
  for (const file of files) {
    const text = textOf(file.file);
    const facts = documentFacts(text);
    if ((file.kind === "extra_info" || file.kind === "schedule") && facts.days >= 3) {
      problems.push(`"${file.file}" is a day-by-day program (${facts.days} days), not ${file.kind}: saved_program (compare_program it with the trip it matches) or new_trip.`);
      continue;
    }
    if (file.kind !== "saved_program" && file.kind !== "schedule") continue;
    const chosen = input.byId.get(file.trip_ids[0] || "");
    if (!chosen) continue;
    const matches = titleMatches(text, input.trips);
    if (matches.length) {
      const top = matches[0].shared;
      const best = matches.filter((entry) => entry.shared === top);
      const days = file.kind === "saved_program" ? facts.days : 0;
      const fitting = days ? best.filter((entry) => daysOfTrip(entry.trip) === days) : best;
      const pool = fitting.length ? fitting : best;
      const preferred = pool.find((entry) => entry.trip.status === "active") ?? pool[0];
      const mine = matches.find((entry) => entry.trip.id === chosen.id);
      if (!mine || mine.shared < top) {
        problems.push(`"${file.file}": its title matches ${pool.map((entry) => describe(entry.trip)).join(" or ")} better than «${chosen.route_name}». Use ${pool.length > 1 ? "the right one of them" : "it"}${file.kind === "saved_program" ? " (compare_program shows which)" : ""}, or new_trip if the file is none of these trips.`);
      } else if (days && daysOfTrip(chosen) && daysOfTrip(chosen) !== days && fitting.length) {
        problems.push(`"${file.file}" has ${days} program days; «${chosen.route_name}» is ${clean(chosen.duration_text)}. ${fitting.map((entry) => describe(entry.trip)).join(" or ")} has the same length: use it.`);
      } else if (chosen.status !== "active" && preferred.trip.status === "active" && preferred.trip.id !== chosen.id) {
        problems.push(`"${file.file}": ${describe(preferred.trip)} is LIVE and matches this file as well as «${chosen.route_name}» (${chosen.status}). The site shows the live one: use it, unless the file is clearly the ${chosen.status} copy.`);
      }
    }
    if (file.kind === "saved_program") {
      if (!input.compared.has(chosen.id)) problems.push(`"${file.file}": call compare_program {trip_id: "${chosen.id}"} first: it shows whether the file is that trip's program and what changed.`);
      programTrips.push(chosen.id);
    }
  }
  // A list sent with programs is for the trips of those programs (2026-11-21: a look-alike trip without
  // the check-up got the check-up price list).
  const packageTrips = [...new Set([...programTrips, ...files.filter((entry) => entry.kind === "schedule").flatMap((entry) => entry.trip_ids)])];
  if (packageTrips.length) {
    for (const file of files.filter((entry) => entry.kind === "extra_info")) {
      const outside = file.trip_ids.filter((id) => !packageTrips.includes(id));
      if (outside.length) {
        problems.push(`"${file.file}" names ${outside.map((id) => `«${input.byId.get(id)?.route_name}» (trip_id ${id})`).join(", ")}, but the attached programs and schedules belong to ${packageTrips.map((id) => `«${input.byId.get(id)?.route_name}» (trip_id ${id})`).join(", ")}. Use those trips, unless the list is really for that other trip as well.`);
      }
    }
  }
  // A schedule sent with the program of the same trip belongs to that trip.
  for (const file of files.filter((entry) => entry.kind === "schedule")) {
    const matches = titleMatches(textOf(file.file), input.trips);
    const top = matches[0]?.shared ?? 0;
    const sibling = programTrips.find((id) => matches.some((entry) => entry.trip.id === id && entry.shared === top));
    if (sibling && file.trip_ids[0] !== sibling) {
      problems.push(`"${file.file}" is the schedule of the same trip as its program file: «${input.byId.get(sibling)?.route_name}» (trip_id ${sibling}), not «${input.byId.get(file.trip_ids[0] || "")?.route_name}».`);
    }
  }
  return [...new Set(problems)];
}
