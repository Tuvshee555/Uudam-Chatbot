/**
 * A partner's updated program against the trip as it is saved (assistantAgent rule 13, the
 * `compare_program` tool).
 *
 * Why (2026-11-21, the first real "… аяллын хөтөлбөрийг энэ файлаар шинэчил"): asked to compare the
 * file with the saved days by reading, the model proposed to overwrite three days with the partner's
 * raw wording (typos and all) and missed that the hotels of four days had changed. So the model
 * only reads the file into days; what differs is worked out here, exactly: the hotel of each day,
 * its meals, and the sentences one side has and the other lacks. A second guard (rewritesSavedDay)
 * refuses a day patch that throws the saved wording away.
 *
 * Pure.
 */
import type { TravelTrip } from "../travelTypes";

type Row = Record<string, unknown>;
type MealKey = "breakfast" | "lunch" | "dinner";
const MEALS: MealKey[] = ["breakfast", "lunch", "dinner"];

const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const str = (value: unknown): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");

/** Words and numbers, lower case; a clock time or an amount stays one token ("07:20" → "0720"). */
function tokens(value: string): string[] {
  const joined = value.normalize("NFKC").toLowerCase().replace(/(\d)[:.,](?=\d)/g, "$1");
  return (joined.match(/[\p{L}\p{N}]+/gu) || []).filter((token) => token.length >= 3 || /^\d{2,}$/.test(token));
}

/** The same word in another case ending ("буудалдаа" / "буудалд", "хоол" / "хоолоо"). */
function alike(a: string, b: string): boolean {
  if (a === b) return true;
  if (/^\d/.test(a) || /^\d/.test(b)) return false;
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared += 1;
  return shared >= 4;
}

/** How much of `part` is said in `bag`: 0 none of its words, 1 all of them. */
function coverage(part: string[], bag: string[]): number {
  if (!part.length) return 1;
  return part.filter((token) => bag.some((other) => alike(token, other))).length / part.length;
}

/** Sentences of a day's text; "18.00" and "4–5 цаг" stay inside their sentence. */
export function sentencesOf(value: string): string[] {
  const guarded = String(value || "").replace(/(\d)\.(?=\d)/g, "$1․");
  return (guarded.match(/[^.!?\n]+(?:[.!?]+|$)/g) || [])
    .map((piece) => piece.replace(/․/g, ".").replace(/\s+/g, " ").trim())
    .filter((piece) => tokens(piece).length >= 1);
}

const squash = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** A hotel name as a name: "zhaojun /shanghua" → "Zhaojun/Shanghua". */
export function cleanHotelName(value: string): string {
  return str(value).replace(/\s*\/\s*/g, "/").replace(/\s*,\s*/g, ", ")
    .replace(/(^|[\s/,(])([a-z])/g, (_match, lead: string, letter: string) => `${lead}${letter.toUpperCase()}`);
}

type SavedDay = { day: number; title: string; description: string; hotel: string; meals: Row };

function savedDays(trip: TravelTrip): SavedDay[] {
  const days = Array.isArray(trip.extra?.itinerary_days) ? (trip.extra.itinerary_days as unknown[]) : [];
  return days.map((entry, index) => {
    const day = record(entry);
    return { day: index + 1, title: str(day.title), description: typeof day.description === "string" ? day.description.trim() : "", hotel: str(day.hotel), meals: record(day.meals) };
  });
}

export type FileDay = { day: number; title: string; hotel: string; meals: Row; text: string };

/** The model's reading of the file's days, cleaned; a day with no text is dropped. */
export function fileDaysOf(value: unknown): FileDay[] {
  const out: FileDay[] = [];
  for (const entry of Array.isArray(value) ? value.slice(0, 40) : []) {
    const day = record(entry);
    const text = typeof day.text === "string" ? day.text.trim().slice(0, 6_000) : "";
    if (!text && !str(day.title)) continue;
    out.push({ day: out.length + 1, title: str(day.title).slice(0, 300), hotel: str(day.hotel).slice(0, 300), meals: record(day.meals), text });
  }
  return out;
}

/**
 * The trip's own hotel line ("Галт тэрэг; Хөх хот: A/B; Саун амралтын цогцолбор; Эрээн: C/D") after the days'
 * hotels changed: each old name gives way to the new one, and a part that then only repeats another
 * (a stay the program no longer has) goes. "" when nothing changes.
 */
export function hotelLineAfter(line: string, changes: Array<{ saved: string; write: string }>): string {
  const before = str(line);
  if (!before || !changes.length) return "";
  let parts = before.split(";").map((part) => part.trim()).filter(Boolean);
  for (const change of changes) {
    if (!change.saved || !change.write) continue;
    parts = parts.map((part) => {
      const at = part.toLowerCase().indexOf(change.saved.toLowerCase());
      return at < 0 ? part : `${part.slice(0, at)}${change.write}${part.slice(at + change.saved.length)}`;
    });
  }
  const kept = parts.filter((part, index) => !parts.some((other, otherIndex) => otherIndex !== index && squash(other).includes(squash(part)) && (squash(other) !== squash(part) || otherIndex < index)));
  const after = kept.join("; ");
  return after && after !== before ? after : "";
}
/** Nights on the train and the arrival morning carry the house's own wording: their sentences are not compared. */
const TRAIN_NIGHT = /галт\s*тэр/iu;

export type DayDifference = {
  saved_day: number;
  file_day: number;
  title: string;
  hotel?: { saved: string; file: string; write: string };
  meals_differ?: Array<{ meal: MealKey; saved: boolean | null; file: boolean }>;
  new_in_file?: string[];
  only_in_saved?: string[];
};

export type ProgramComparison =
  | { ok: false; reason: string }
  | {
    ok: true;
    alignment: string;
    days: DayDifference[];
    /** The trip's own hotel line rewritten for the days' new hotels, when it changes. */
    trip_hotel_line?: { saved: string; write: string };
    unchanged_days: number[];
    file_days_beyond_saved: number[];
    saved_days_not_in_file: number[];
    not_in_file_text: number[];
    apply: string;
  };

const APPLY = [
  "Build the proposal from this result only.",
  "hotel → patch_itinerary_day {day: saved_day, hotel: hotel.write}. trip_hotel_line → also patch {fields:{hotel: trip_hotel_line.write}} exactly as given.",
  "new_in_file → patch_itinerary_day {day: saved_day, description: the SAVED description exactly as get_trip shows it + these sentences added at the right place, in clean Mongolian}. Never replace saved sentences with the file's wording.",
  "only_in_saved → leave the day as it is (staff wrote it); say it in reply_text only when it matters.",
  "meals_differ → do NOT change meals; list them in reply_text so the admin can decide (the saved meals may be a staff decision).",
  "A day not listed in `days` already matches: never patch it. file_days_beyond_saved / saved_days_not_in_file → say so in reply_text and ask before adding or removing a day.",
].join(" ");

/**
 * What differs between the file's days (as the model read them) and the saved program.
 * `documentText` is the files' own text: a day whose text is not there was not copied from the file.
 */
/**
 * The file names the hotel the saved day already names: the same letters, or the saved day says more
 * ("«Alpha Park» амралтын цогцолбор" for "Alpha Park", "<city>: A / B" for "A/B"). Only spelling would
 * change, and staff wording is kept (a real run proposed both as "new hotels", 2026-11-21).
 */
function sameHotel(saved: string, file: string): boolean {
  const a = squash(saved);
  const b = squash(file);
  return a === b || (b.length >= 5 && a.includes(b));
}

export function compareProgram(trip: TravelTrip, fileDaysInput: unknown, documentText: string): ProgramComparison {
  const saved = savedDays(trip);
  const file = fileDaysOf(fileDaysInput);
  if (saved.length < 1) return { ok: false, reason: "The saved trip has no day-by-day program to compare with." };
  if (file.length < 2) return { ok: false, reason: "file_days must hold every day of the file's program (title, hotel, meals, text copied from the file)." };
  // Does the file start at the border while the saved trip starts with the train from Ulaanbaatar?
  const score = (offset: number) => file.reduce((sum, day, index) => {
    const target = saved[index + offset];
    return target ? sum + coverage(tokens(`${day.title} ${day.text}`), tokens(`${target.title} ${target.description}`)) : sum;
  }, 0);
  const offsets = [0, 1, 2, -1].filter((offset) => file.length + offset >= 1);
  const offset = offsets.reduce((best, candidate) => (score(candidate) > score(best) + 0.2 ? candidate : best), 0);
  const source = squash(documentText);
  const days: DayDifference[] = [];
  const unchanged: number[] = [];
  const beyond: number[] = [];
  const unverified: number[] = [];
  file.forEach((day, index) => {
    const target = saved[index + offset];
    if (!target) { beyond.push(day.day); return; }
    if (source && day.text && !source.includes(squash(day.text).slice(0, 60))) unverified.push(day.day);
    const difference: DayDifference = { saved_day: target.day, file_day: day.day, title: target.title };
    const fileHotel = cleanHotelName(day.hotel);
    if (fileHotel && !sameHotel(target.hotel, fileHotel)) difference.hotel = { saved: target.hotel, file: day.hotel, write: fileHotel };
    const meals = MEALS.filter((meal) => typeof day.meals[meal] === "boolean" && typeof target.meals[meal] === "boolean" && day.meals[meal] !== target.meals[meal])
      .map((meal) => ({ meal, saved: target.meals[meal] as boolean, file: day.meals[meal] as boolean }));
    if (meals.length) difference.meals_differ = meals;
    const houseWording = TRAIN_NIGHT.test(target.hotel) || target.day === saved.length;
    if (!houseWording) {
      const savedBag = tokens(`${target.title} ${target.description}`);
      const fileBag = tokens(`${day.title} ${day.text}`);
      const fresh = sentencesOf(day.text).filter((sentence) => tokens(sentence).length >= 2 && coverage(tokens(sentence), savedBag) < 0.25);
      const gone = sentencesOf(target.description).filter((sentence) => tokens(sentence).length >= 3 && coverage(tokens(sentence), fileBag) < 0.25);
      if (fresh.length) difference.new_in_file = fresh;
      if (gone.length) difference.only_in_saved = gone;
    }
    if (difference.hotel || difference.meals_differ || difference.new_in_file || difference.only_in_saved) days.push(difference);
    else unchanged.push(target.day);
  });
  const hotelLine = hotelLineAfter(String(trip.hotel || ""), days.flatMap((day) => (day.hotel ? [{ saved: day.hotel.saved, write: day.hotel.write }] : [])));
  // Most of the "file days" are not in the file: the model wrote them itself, so nothing here can be trusted.
  if (unverified.length > file.length / 2) return { ok: false, reason: "file_days[].text must be copied from the attached file word for word (most of these days are not in the file's text)." };
  // Saved days after the file's last day. The house's own return days (the train night, the arrival
  // morning) after a file that ends at the border are not a difference; the days before the file's
  // first day are the train from Ulaanbaatar.
  const afterFile = saved.filter((day) => day.day > file.length + offset)
    .filter((day) => !(TRAIN_NIGHT.test(`${day.hotel} ${day.description}`) || day.day === saved.length))
    .map((day) => day.day);
  return {
    ok: true,
    alignment: offset === 0 ? "file day N = saved day N" : offset > 0 ? `file day N = saved day N+${offset} (the saved trip starts with the train from Ulaanbaatar)` : `file day N = saved day N${offset}`,
    days,
    ...(hotelLine ? { trip_hotel_line: { saved: str(trip.hotel), write: hotelLine } } : {}),
    unchanged_days: unchanged,
    file_days_beyond_saved: beyond,
    saved_days_not_in_file: afterFile,
    not_in_file_text: unverified,
    apply: APPLY,
  };
}

/**
 * True when `next` throws the saved day's wording away: fewer than half of the saved sentences are
 * still there (word for word, small spacing and punctuation aside). Adding or cutting a sentence
 * keeps the rest, so it passes.
 */
export function rewritesSavedDay(saved: string, next: string): boolean {
  const before = sentencesOf(saved).filter((sentence) => tokens(sentence).length >= 3);
  if (before.length < 2) return false;
  const after = squash(next);
  const kept = before.filter((sentence) => after.includes(squash(sentence))).length;
  return kept / before.length < 0.5;
}
