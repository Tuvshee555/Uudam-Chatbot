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
 * their full line. The model still knows every trip exists and can compare,
 * list and recommend by price, length and date.
 */

const MODULES_HEADER = "Modules:";
const RECENT_MESSAGES_FOR_FOCUS = 4;
// More matched trips than this is not a focus — keep the whole catalog.
const MAX_FOCUSED_TRIPS = 8;
// Fields a compact index line keeps; everything else (inclusions, per-date
// price tables, age-band detail, descriptions) waits until the customer is on
// that trip. Dates, hotel and meals stay: they are short, and replayed real
// chats asked about them with no trip named.
const SUMMARY_FIELDS = ["duration", "price", "Ангилал", "Child price", "Infant price", "Departure dates", "Hotel", "Food", "Өөр нэршил"];

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function moduleName(line: string): string {
  return line.slice(2).split(" | ")[0]?.trim() || "";
}

/** Trip names as they appear in the catalog's module lines. */
export function catalogTripNames(knowledgeBase: string): string[] {
  const names: string[] = [];
  let inModules = false;
  for (const line of knowledgeBase.split("\n")) {
    if (line.trim() === MODULES_HEADER) {
      inModules = true;
      continue;
    }
    if (inModules && !line.trim()) break;
    if (inModules && line.startsWith("- ")) names.push(moduleName(line));
  }
  return names.filter(Boolean);
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

function summaryLine(line: string): string {
  const [head, ...fields] = line.split(" | ");
  const kept = fields.filter((field) => SUMMARY_FIELDS.includes(field.split(":")[0].trim()));
  return [head, ...kept, "summary only"].join(" | ");
}

/**
 * The knowledge base with full detail only for `focusNames` and a compact
 * index line for every other trip. With no names, every trip is an index line.
 * Returns the input unchanged when too many trips are in focus to help.
 */
export function focusKnowledgeBase(knowledgeBase: string, focusNames: string[]): string {
  const wanted = new Set(focusNames.map(normalizeName).filter(Boolean));
  let inModules = false;
  let fullTrips = 0;
  const lines = knowledgeBase.split("\n").map((line) => {
    if (line.trim() === MODULES_HEADER) {
      inModules = true;
      return line;
    }
    if (inModules && !line.trim()) {
      inModules = false;
      return line;
    }
    if (!inModules || !line.startsWith("- ")) return line;
    if (wanted.has(normalizeName(moduleName(line)))) {
      fullTrips += 1;
      return line;
    }
    return summaryLine(line);
  });
  if (fullTrips > MAX_FOCUSED_TRIPS) return knowledgeBase;
  return lines.join("\n");
}
