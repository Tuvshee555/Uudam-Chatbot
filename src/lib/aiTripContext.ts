/**
 * The catalog the reply model reads, cut down to what this message needs.
 *
 * Every AI reply used to carry the full catalog — every trip's whole
 * description, ~9,000 tokens of the ~15,000 in each call. That was most of the
 * OpenAI bill, and it made wrong-trip answers easier: the model had twenty-odd
 * similar trips to pick from. The AI step is only reached when the rule-based
 * paths could not answer — greetings, general or open questions — so it rarely
 * needs every trip's full detail.
 *
 * Every trip is sent as a compact index line (name, category, duration, prices,
 * departures, hotel, meals, other names), so the model still knows every trip
 * exists and can compare, list and recommend by price, length and date. The
 * trips this message is about (the matcher's picks first, then trips named in
 * the last few messages; at most MAX_FOCUSED_TRIPS) are repeated in full in a
 * "Trips in focus" section placed AFTER the whole catalogue.
 *
 * Layout matters for cost (2026-11-02): the index and the rest of the catalogue
 * are byte-identical from one message to the next, so the provider's automatic
 * prompt caching reuses them (cached input is billed at a fraction of the
 * price). Full detail written in place, between index lines, broke that prefix
 * at the first focused trip.
 */

const MODULES_HEADER = "Modules:";
export const FOCUS_HEADER = "Trips in focus (full detail):";
const RECENT_MESSAGES_FOR_FOCUS = 4;
// Full detail for at most this many trips. The matcher's picks come first; a trip list in the
// last messages adds the rest. Over the cap the remaining trips stay index lines — before
// 2026-11-02 a ninth named trip sent the WHOLE catalogue in full (about 38,000 tokens).
const MAX_FOCUSED_TRIPS = 4;
// Fields a compact index line keeps; everything else (inclusions, per-date
// price tables, age-band detail, descriptions) waits until the customer is on
// that trip. Dates, hotel and meals stay: they are short, and replayed real
// chats asked about them with no trip named.
const SUMMARY_FIELDS = ["duration", "price", "Ангилал", "Child price", "Infant price", "Departure dates", "Hotel", "Food", "Өөр нэршил"];
// Per-date / per-hotel price tables are most of a focused trip's tokens (53% of the catalogue;
// one trip alone was 9,600 tokens). The answer planner prices any date from the full data
// before the model is reached, so the model sees the nearest rows and is told the rest exist.
const PRICE_TABLE_FIELDS = new Set(["Огноо тус бүрийн үнэ", "Price groups", "Discount groups", "Хямдрал"]);
const MAX_PRICE_TABLE_CHARS = 2_400;

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function moduleName(line: string): string {
  return line.slice(2).split(" | ")[0]?.trim() || "";
}

/** The Modules section: its line range and its trip lines (continuation lines joined to their trip). */
function modulesSection(lines: string[]): { start: number; end: number; modules: string[] } | null {
  const start = lines.findIndex((line) => line.trim() === MODULES_HEADER);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && lines[end].trim()) end += 1;
  const modules: string[] = [];
  for (const line of lines.slice(start + 1, end)) {
    if (line.startsWith("- ")) modules.push(line);
    // A description that still carries a line break belongs to the trip above it.
    else if (modules.length) modules[modules.length - 1] += ` / ${line.trim()}`;
  }
  return { start, end, modules };
}

/** Trip names as they appear in the catalog's module lines. */
export function catalogTripNames(knowledgeBase: string): string[] {
  const section = modulesSection(knowledgeBase.split("\n"));
  return section ? section.modules.map(moduleName).filter(Boolean) : [];
}

/** Catalog trips whose full name appears in the latest messages of the chat. */
export function tripsNamedInRecentMessages(
  knowledgeBase: string,
  messages: Array<{ text: string }>,
): string[] {
  const recent = normalizeName(messages.slice(-RECENT_MESSAGES_FOR_FOCUS).map((m) => m.text).join(" \n "));
  if (!recent) return [];
  return catalogTripNames(knowledgeBase).filter((name) => {
    const normalized = normalizeName(name);
    return normalized.length >= 6 && recent.includes(normalized);
  });
}

// The index shows a trip's next few departures; the rest are counted, never dropped silently.
// Departure dates were a third of the index (2,400 of 7,500 tokens, 2026-11-02). Date questions
// are answered from the data before the model is reached, and a focused trip keeps every date.
const INDEX_DEPARTURES = 6;

function summaryField(field: string): string {
  if (field.split(":")[0].trim() !== "Departure dates") return field;
  const dates = field.slice(field.indexOf(":") + 1).trim().split(/,\s+/);
  if (dates.length <= INDEX_DEPARTURES) return field;
  return `Departure dates: ${dates.slice(0, INDEX_DEPARTURES).join(", ")} (+${dates.length - INDEX_DEPARTURES} more dates)`;
}

function summaryLine(line: string): string {
  const [head, ...fields] = line.split(" | ");
  const kept = fields.filter((field) => SUMMARY_FIELDS.includes(field.split(":")[0].trim())).map(summaryField);
  return [head, ...kept, "summary only"].join(" | ");
}

/** A focused trip's full line with each price table cut at a row boundary. */
function focusedLine(line: string): string {
  return line.split(" | ").map((field) => {
    const key = field.split(":")[0].trim();
    if (!PRICE_TABLE_FIELDS.has(key) || field.length <= MAX_PRICE_TABLE_CHARS) return field;
    const rows = field.split("; [");
    let kept = rows[0];
    let count = 1;
    while (count < rows.length && kept.length + rows[count].length + 3 <= MAX_PRICE_TABLE_CHARS) kept += `; [${rows[count++]}`;
    const omitted = rows.length - count;
    return omitted > 0 ? `${kept}; … ${omitted} more price rows are not shown here: for a date or hotel not shown, output REFER` : kept;
  }).join(" | ");
}

/**
 * The knowledge base with every trip as an index line, followed by full detail
 * for `focusNames` (in the order given, at most MAX_FOCUSED_TRIPS). With no
 * names, every trip is an index line and no focus section is added.
 */
export function focusKnowledgeBase(knowledgeBase: string, focusNames: string[]): string {
  const lines = knowledgeBase.split("\n");
  const section = modulesSection(lines);
  if (!section) return knowledgeBase;
  const byName = new Map(section.modules.map((line) => [normalizeName(moduleName(line)), line]));
  const focused = [...new Set(focusNames.map(normalizeName).filter((name) => byName.has(name)))].slice(0, MAX_FOCUSED_TRIPS);
  const catalogue = [
    ...lines.slice(0, section.start + 1),
    ...section.modules.map(summaryLine),
    ...lines.slice(section.end),
  ].join("\n");
  if (!focused.length) return catalogue;
  return `${catalogue}\n\n${FOCUS_HEADER}\n${focused.map((name) => focusedLine(byName.get(name)!)).join("\n")}`;
}
