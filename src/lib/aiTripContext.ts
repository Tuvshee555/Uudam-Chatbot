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
 * Now every trip is sent as a compact index line (name, category, duration,
 * prices, departures, hotel, meals, other names), and only the trips this message is
 * about (the matcher's picks, plus trips named in the last few messages) keep
 * their full text. The model still knows every trip exists and can compare,
 * list and recommend by price, length and date.
 *
 * A trip's text can run over several lines, blank lines included (a checkup
 * trip's test list). The trip list ends at the next section header, never at a
 * blank line: reading a blank line as the end sent every later trip in full on
 * every message — 33 of 36 trips, ~27k of the ~37k tokens per reply (2026-11-04).
 */

const MODULES_HEADER = "Modules:";
// The section headers formatKnowledgeBase (businessData.ts) writes, in its order.
const SECTION_HEADERS = new Set(["Trip categories:", MODULES_HEADER, "Special offers:", "Discount policies:", "Verified credentials:", "FAQ:"]);
const RECENT_MESSAGES_FOR_FOCUS = 4;
// More matched trips than this is not a focus — keep the whole catalog.
const MAX_FOCUSED_TRIPS = 8;
// Fields a compact index line keeps; everything else (inclusions, per-date
// price tables, age-band detail, descriptions) waits until the customer is on
// that trip. Dates, hotel and meals stay: they are short, and replayed real
// chats asked about them with no trip named.
const SUMMARY_FIELDS = ["duration", "price", "Ангилал", "Child price", "Infant price", "Departure dates", "Hotel", "Food", "Өөр нэршил"];

/** One trip of the list: its "- name | field | …" line and the lines its text runs on to. */
type Entry = { name: string; lines: string[] };

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function moduleName(line: string): string {
  return line.slice(2).split(" | ")[0]?.trim() || "";
}

/** Every trip line has at least "- name | price: …"; a bullet inside a trip's notes has no " | ". */
function isEntryStart(line: string): boolean {
  return line.startsWith("- ") && line.includes(" | ");
}

/** The text before the trip list, the trips, and the sections after them. */
function splitModules(knowledgeBase: string): { before: string[]; entries: Entry[]; after: string[] } {
  const lines = knowledgeBase.split("\n");
  const start = lines.findIndex((line) => line.trim() === MODULES_HEADER);
  if (start < 0) return { before: lines, entries: [], after: [] };
  const before = lines.slice(0, start + 1);
  const entries: Entry[] = [];
  let index = start + 1;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (SECTION_HEADERS.has(line.trim())) break;
    if (isEntryStart(line)) entries.push({ name: moduleName(line), lines: [line] });
    else if (entries.length) entries[entries.length - 1].lines.push(line);
    else before.push(line);
  }
  const after = lines.slice(index);
  // The blank line that separates the list from the next section is not part of the last trip.
  const last = entries[entries.length - 1];
  while (last && last.lines.length > 1 && !last.lines[last.lines.length - 1].trim()) after.unshift(last.lines.pop()!);
  return { before, entries, after };
}

/** Trip names as they appear in the catalog's module lines. */
export function catalogTripNames(knowledgeBase: string): string[] {
  return splitModules(knowledgeBase).entries.map((entry) => entry.name).filter(Boolean);
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

/** One line: the kept fields, each collapsed onto that line. */
function summaryLine(entry: Entry): string {
  const [head, ...fields] = entry.lines.join("\n").split(" | ");
  const kept = fields
    .filter((field) => SUMMARY_FIELDS.includes(field.split(":")[0].trim()))
    .map((field) => field.replace(/\s+/g, " ").trim());
  return [head.trim(), ...kept, "summary only"].join(" | ");
}

/**
 * The knowledge base with full text only for `focusNames` and a compact
 * index line for every other trip. With no names, every trip is an index line.
 * Returns the input unchanged when too many trips are in focus to help.
 */
export function focusKnowledgeBase(knowledgeBase: string, focusNames: string[]): string {
  const wanted = new Set(focusNames.map(normalizeName).filter(Boolean));
  const { before, entries, after } = splitModules(knowledgeBase);
  if (!entries.length) return knowledgeBase;
  const focused = new Set(entries.filter((entry) => wanted.has(normalizeName(entry.name))));
  if (focused.size > MAX_FOCUSED_TRIPS) return knowledgeBase;
  const body = entries.flatMap((entry) => (focused.has(entry) ? entry.lines : [summaryLine(entry)]));
  return [...before, ...body, ...after].join("\n");
}
