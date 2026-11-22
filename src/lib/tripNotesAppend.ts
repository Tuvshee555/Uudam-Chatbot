/**
 * "Энэ мэдээллийг аяллын тайлбарт нэм": one named section added to a trip's description (`notes`),
 * everything already written there kept as it is.
 *
 * Why (2026-11-21): a partner sent a price list of optional clinic tests for two check-up trips.
 * The assistant could only replace `notes` as a whole (the model re-typing 2,500 characters of an
 * existing test list to add 60 lines under it), so nobody could add it without the editor. The
 * action carries only the new section: a heading line and its lines. Saved again with the same
 * heading, the section is replaced, not repeated.
 *
 * The website shows a list pasted into the description as grouped cards when its heading reads
 * like one ("… шинжилгээ … хийх зүйлс": uudam-booking-web src/lib/healthCheckup.ts): group
 * headings end in ":", one item per line, "name: detail" puts the detail under the name.
 *
 * Pure.
 */
import type { TravelTrip, TripMutationFields } from "./travelTypes";

export type NotesAppendInput = { heading?: unknown; text?: unknown };
export type NotesAppendPlan = { fields: TripMutationFields; posterKeys: string[]; lines: string[]; warnings: string[] };

export const NOTES_SECTION_MAX_CHARS = 12_000;
const NOTES_MAX_CHARS = 30_000;
const HEADING_MAX_CHARS = 160;

const squash = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

/** The heading as one clean line, or "" when there is none. */
export function notesHeadingOf(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().replace(/[:：]+$/, "").trim().slice(0, HEADING_MAX_CHARS) : "";
}

/** The section's lines: each trimmed, markdown bullets and emphasis dropped, at most one blank line in a row. */
export function notesSectionText(value: unknown): string {
  if (typeof value !== "string") return "";
  const lines = value.replace(/\r\n?/g, "\n").split("\n")
    .map((line) => line.replace(/^\s*(?:[-•*·]\s+)/u, "").replace(/\*\*/g, "").replace(/[ \t]+/g, " ").trim());
  const out: string[] = [];
  for (const line of lines) {
    if (!line && (!out.length || !out[out.length - 1])) continue;
    // A group heading written on the line of its first item ("Эмэгтэйчүүдийн шинжилгээ: TCT шинжилгээ: 170 юань",
    // a real reading of 2026-11-21) is two lines: the site shows the heading as the group, the rest as its item.
    const glued = /^([^:：\d]{3,60})[:：]\s+([^:：]+[:：]\s*\d[\d\s.,]*\s*(?:юань|¥|₮|төг\S*)?)$/u.exec(line);
    if (glued) { out.push(`${glued[1].trim()}:`, glued[2].trim()); continue; }
    out.push(line);
  }
  while (out.length && !out[out.length - 1]) out.pop();
  return out.join("\n").slice(0, NOTES_SECTION_MAX_CHARS);
}

// A line that opens a list of its own on the website ("Эрэгтэйчүүдийн … шинжилгээ, үзлэгт хийх зүйлс").
const LIST_HEADING = /(шинжилгээ|үзлэг)\S*\s.*(хийх|багтсан|орох)\s+зүйл/iu;

/**
 * Where an earlier section under `heading` sits in `notes`: from its heading line to the next
 * list heading that follows a blank line, or to the end. Null when the heading is not there.
 */
function existingSection(notes: string, heading: string): { start: number; end: number } | null {
  const lines = notes.split("\n");
  const wanted = squash(heading);
  const at = lines.findIndex((line) => squash(line.replace(/[:：]+\s*$/, "")) === wanted);
  if (at < 0) return null;
  let until = lines.length;
  for (let index = at + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || lines[index - 1].trim()) continue;
    if (line.length <= 120 && LIST_HEADING.test(line) && squash(line.replace(/[:：]+\s*$/, "")) !== wanted) { until = index; break; }
  }
  const offset = (count: number) => lines.slice(0, count).join("\n").length + (count > 0 ? 1 : 0);
  return { start: offset(at), end: until >= lines.length ? notes.length : offset(until) };
}

export function planAppendNotes(trip: TravelTrip, input: NotesAppendInput): { ok: true; plan: NotesAppendPlan } | { ok: false; reason: string } {
  const heading = notesHeadingOf(input.heading);
  const body = notesSectionText(input.text);
  if (heading.length < 3) return { ok: false, reason: "Нэмэх хэсгийн гарчиг алга." };
  if (!body) return { ok: false, reason: `«${heading}» хэсэгт нэмэх мөр алга.` };
  const section = `${heading}\n${body}`;
  const notes = String(trip.notes || "").replace(/\r\n?/g, "\n").trimEnd();
  const count = body.split("\n").filter((line) => line.trim()).length;
  const old = existingSection(notes, heading);
  let next: string;
  let line: string;
  if (old) {
    const before = notes.slice(0, old.start).trimEnd();
    const after = notes.slice(old.end).trim();
    if (squash(notes.slice(old.start, old.end)) === squash(section)) return { ok: false, reason: `«${heading}» хэсэг тайлбарт аль хэдийн ийм байна.` };
    next = [before, section, after].filter(Boolean).join("\n\n");
    line = `Тайлбарын «${heading}» хэсгийг шинэчилнэ (${count} мөр)`;
  } else {
    next = notes ? `${notes}\n\n${section}` : section;
    line = `Тайлбарт «${heading}» хэсэг нэмнэ (${count} мөр); бусад тайлбар хэвээр`;
  }
  if (next.length > NOTES_MAX_CHARS) return { ok: false, reason: `Тайлбар хэт урт болно (${next.length} тэмдэгт). Хэсгийг богиносгоно уу.` };
  // The poster's description follows through patchTrip's own poster sync; nothing is written to it here.
  return { ok: true, plan: { fields: { notes: next }, posterKeys: [], lines: [line], warnings: [] } };
}

// "1,590,000", "1.590.000", "1'590'000" (and "1 590 000" when `spaces`) read as one number.
// No lookbehind: this file also loads in the admin page, and older Safari fails on one.
const joinThousands = (value: string, spaces: boolean) => value.replace(spaces ? /(\d)[\s,.'](?=\d{3}(?!\d))/g : /(\d)[,.'](?=\d{3}(?!\d))/g, "$1");
const numbersOf = (value: string) => value.match(/\d+(?:\.\d+)?/g) || [];

/** The numbers (two digits or more) a section states that none of the sources holds. */
export function numbersNotInSources(text: string, sources: string[]): string[] {
  const haystack = sources.join("\n");
  const found = new Set([...numbersOf(haystack), ...numbersOf(joinThousands(haystack, false)), ...numbersOf(joinThousands(haystack, true))]);
  const missingIn = (reading: string) => {
    const missing: string[] = [];
    for (const number of numbersOf(reading)) {
      if (number.replace(".", "").length < 2 || found.has(number) || missing.includes(number)) continue;
      missing.push(number);
    }
    return missing;
  };
  // Two neighbouring numbers ("175 335") are not one number: the reading with fewer strangers counts.
  const tight = missingIn(joinThousands(text, false));
  const loose = missingIn(joinThousands(text, true));
  return loose.length < tight.length ? loose : tight;
}
