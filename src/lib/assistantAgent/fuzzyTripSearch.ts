/**
 * Sound-alike trip search for the admin assistant. The owner types names the way they sound,
 * often in Latin letters ("hailan chuhai" for «Макао – Жухай – Хайлин арал»), and the model may
 * turn them into Cyrillic its own way («Хайлан Чухай»). The customer matcher needs a known
 * spelling or alias, so the right trip was missed and a near-miss («Хайлаар …») was offered.
 *
 * Every word of the query and of each trip's name and aliases is folded to one Latin sound
 * skeleton (ж/ч/з/ц/j/zh/ch/c/ts/z → j, х/kh/h → h, ө/ү/у/o/u → u, double letters once …), and a
 * query word counts as matching a trip word when the skeletons are equal, or differ by one
 * letter for words of five letters or more. A trip matching two query words outranks one
 * matching a single word. Pure: no database, no model.
 */
import type { TravelTrip } from "../travelTypes";
import { isGenericWord } from "../tripNameTokens";

const CYRILLIC: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "j", з: "z", и: "i", й: "i", к: "k", л: "l", м: "m",
  н: "n", о: "o", ө: "u", п: "p", р: "r", с: "s", т: "t", у: "u", ү: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh",
  щ: "sh", ъ: "", ы: "i", ь: "", э: "e", ю: "yu", я: "ya",
};

/** Words that name no trip: "аялал", "нэр", "бич", their Latin spellings, common verbs. */
const STOP = new Set([
  "аялал", "аяллын", "аяллыг", "аялалд", "aylal", "ayalal", "aylaliin", "aylalin", "ayalaliin", "nerin", "нэрийн", "нэр", "ner",
  "ард", "ard", "бич", "bich", "гэсэн", "gesen", "болго", "bolgo", "өөрчил", "oorchil", "энэ", "ene", "the", "trip", "tour",
  "нэм", "nem", "хас", "has", "солих", "соль", "soli", "сайтаас", "saitaas", "нуу", "nuu",
]);

/** One Latin sound skeleton for a word in either script. */
export function soundSkeleton(word: string): string {
  const latin = Array.from(word.toLowerCase().normalize("NFKC")).map((ch) => CYRILLIC[ch] ?? ch).join("");
  return latin
    .replace(/[^a-z]/g, "")
    .replace(/zh|ch|ts|dz|j|z|c/g, "j")
    .replace(/kh|h/g, "h")
    .replace(/sh/g, "s")
    .replace(/[ou]+/g, "u")
    .replace(/[iy]+/g, "i")
    .replace(/(.)\1+/g, "$1");
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else { i += 1; j += 1; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function words(text: string): string[] {
  return text.split(/[^\p{L}\p{N}]+/u).map((word) => word.trim()).filter(Boolean);
}

/**
 * The query's words that can name a trip. A three-letter place counts ("Хөх"); the words every trip name
 * repeats do not ("шинэ жилийн … хотын аялал" matched «ХАЙНАН … ШИНЭ ЖИЛИЙН АЯЛАЛ» for a Hohhot trip, 2026-11-14).
 */
function queryWords(query: string): string[] {
  return [...new Set(words(query).filter((word) => word.length >= 3 && !STOP.has(word.toLowerCase()) && !isGenericWord(word))
    .map(soundSkeleton).filter((skeleton) => skeleton.length >= 3))];
}

function tripWords(trip: TravelTrip): string[] {
  const aliases = Array.isArray(trip.extra?.aliases) ? (trip.extra.aliases as unknown[]).filter((alias): alias is string => typeof alias === "string") : [];
  return [...new Set([trip.route_name, ...aliases].flatMap(words).map(soundSkeleton).filter((skeleton) => skeleton.length >= 3))];
}

function wordsMatch(query: string, word: string): boolean {
  if (query === word) return true;
  return query.length >= 5 && word.length >= 5 && editDistanceAtMostOne(query, word);
}

/** Trips whose name or aliases sound like the query's words, best first, with how many words matched. */
export function soundAlikeTrips(query: string, trips: TravelTrip[]): Array<{ trip: TravelTrip; matched: number }> {
  const wanted = queryWords(query);
  if (!wanted.length) return [];
  const scored = trips.map((trip) => {
    const own = tripWords(trip);
    const matched = wanted.filter((word) => own.some((candidate) => wordsMatch(word, candidate))).length;
    return { trip, matched };
  }).filter((entry) => entry.matched > 0);
  // A query word that fits most of the catalogue names nothing in particular.
  if (scored.length > Math.max(6, trips.length / 3)) return scored.filter((entry) => entry.matched >= 2).sort((a, b) => b.matched - a.matched);
  return scored.sort((a, b) => b.matched - a.matched);
}
