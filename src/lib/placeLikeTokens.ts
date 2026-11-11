/**
 * Does a message name a PLACE that no catalogue trip goes to?
 *
 * A date or holiday question is either about a trip already in the conversation ("2 сард явмаар
 * байна" under a trip card) or about a NEW destination ("Лондон 2 сард"). Telling them apart used to
 * be a whitelist of date words: any sentence with one unlisted word ("тааруулсан", "юмаа", a typo
 * of "оны") was read as a new destination and the customer got silence (live 2026-11-01).
 *
 * The test is inverted: a word counts as a place only when it is NOT
 *   - a number, a date, a holiday or a time word,
 *   - a passenger / party word,
 *   - a question, filler or particle,
 *   - a verb (a known verb stem with a verb ending, or a verb ending of its own: "-маар", "-аад",
 *     "-сан", "-даг", "-вал", "-х"),
 *   - a word of the catalogue itself (then it is a named destination, not an unknown one).
 * What is left is a word nothing else explains, and that is treated as an unknown place.
 *
 * The failure direction is the safe one: an ordinary word this module does not know reads as a
 * place and the customer is handed to staff in silence, exactly as before. It never makes the bot
 * answer about a trip the customer did not ask about.
 *
 * No place, trip or price lives here: places come from the catalogue only.
 */

import { CALENDAR_FOLLOWUP_WORDS } from "./dateWords";
import { withoutHolidayWords } from "./holidayCalendar";
import { getTripNameHaystack } from "./travelFastPathsSearch";
import { isHomeCityWord, phoneticLatinText } from "./travelTextNorm";
import type { TravelTrip } from "./travelTypes";

/** Whole words (exact match) that are never a place: time, party, question and filler words. */
const FUNCTION_WORDS = new Set<string>([
  // time and calendar
  "оны", "ионы", "оноос", "онд", "жил", "жилийн", "жилд", "жилээс", "сар", "сарын", "сард", "саруудад", "сараас", "сарыг", "сарынх",
  "хоног", "хоногт", "хоногийн", "өдөр", "өдрийн", "өдрүүд", "өдөрт", "шөнө", "шөнийн", "долоо", "хугацаа", "хугацаанд", "хугацаагаар",
  "улирал", "улиралд", "өвөл", "өвлийн", "хавар", "хаврын", "зун", "зуны", "намар", "намрын", "амралт", "амралтаар", "амралтанд",
  "хэзээ", "хэдэнд", "хэдний", "одоо", "удахгүй", "ойрд", "ойрын", "ирэх", "дараа", "дараах", "өмнө", "өмнөх", "хойш", "хүртэл",
  "хооронд", "эхээр", "эхэнд", "эхний", "дундуур", "дунд", "сүүлээр", "сүүлийн", "сүүлчийн", "орчим", "хавьцаа", "үеэр", "үед",
  "өнөөдөр", "маргааш", "нөгөөдөр", "энэ", "тэр", "тэдгээр", "ингээд", "тэгээд", "тэгвэл", "тэгэхээр", "тиймээс", "харин", "гэхдээ", "мөн", "бас", "болон", "эсвэл", "буюу",
  // party
  "хүн", "хүний", "хүнтэй", "хүүхэд", "хүүхдийн", "хүүхдүүд", "хүүхдүүдтэй", "хүүхэдтэй", "том", "томчууд", "томчуудын", "нярай", "нярайтай",
  "настай", "насны", "нас", "сартай", "гэр", "бүл", "бүлээрээ", "бүлтэйгээ", "найз", "найзууд", "найзуудтайгаа", "нөхөр", "эхнэр",
  "аав", "ээж", "ахтай", "эгчтэй", "дүүтэй", "өвөө", "эмээ", "хоёулаа", "гурвуулаа", "дөрвүүлээ", "ганцаараа", "хамт", "хамтдаа", "бид", "бидэнд", "намайг", "надад", "миний", "бидний",
  // questions, fillers, particles
  "юу", "уу", "үү", "вэ", "бэ", "билүү", "юмуу", "юмаа", "юм", "лээ", "шүү", "даа", "дээ", "аа", "байна", "байгаа", "байх", "байдаг", "байсан", "байвал", "байлаа", "байхгүй", "байгаагүй",
  "бна", "бнаа", "бнуу", "бга", "бгаа", "бгаюу", "бол", "болох", "болно", "болов", "боломжтой", "болзошгүй", "чадах", "чадна", "хэрэв", "хэрэг", "хэрэгтэй",
  "ямар", "хаашаа", "хаана", "хаанаас", "хэн", "хэнд", "яг", "аль", "хэд", "хэдэн", "хэрхэн", "яаж", "яагаад", "ийм", "иймэрхүү", "тийм", "ингэж", "тэгж", "гэж", "гээд", "гэсэн", "гэдэг", "нь", "ч", "л", "бээ", "сайн", "баярлалаа",
  "мэдээлэл", "мэдэх", "манай", "танай", "танд", "нийтдээ", "гадаад", "гадаадад", "гадаадын", "гадагшаа", "орон", "оронд", "улс", "улсад", "улсруу", "хот", "хотод", "газарт", "чиглэл", "чиглэлд", "чиглэлийн", "хөтөлбөр", "хөтөлбөртэй", "хуваарь", "хуваарьтай", "хуваарийг", "үнэ", "үнийн", "үнэтэй", "үнийг", "төлбөр", "төлбөрийг", "нийт", "төгрөг",
  "нислэг", "нислэгтэй", "шууд", "газрын", "газар", "хосолсон", "аялал", "аяллын", "аяллууд", "аялалууд", "аялалтай", "аялагч",
  "билет", "захиалга", "захиалах", "суудал", "сул", "багтах", "хэмжээнд", "маршрут", "зураг", "зургийг", "хямд", "хямдрал", "хямдхан",
  "хамгийн", "өөр", "бусад", "дахиад", "дахин", "бүх", "бүгд", "зарим", "олон", "цөөн", "бага", "маш", "арай", "илүү", "ойрхон", "холын", "урт", "богино", "удаан",
  "trip", "trips", "tour", "tours", "travel", "price", "cost", "info", "what", "where", "when", "have", "there", "about", "available", "going", "want", "would", "could", "like", "from", "with", "please", "thanks", "thank", "family", "children", "kids", "adults", "people", "month", "year", "next", "this", "that", "holiday", "vacation", "book", "booking", "schedule", "departure", "dates", "date", "awii", "avii", "avya", "avy", "awy", "awya", "aviya", "aviy", "avay", "avia", "ymar", "ymr", "marshrut", "hamgiin", "oor", "busad", "bugd", "buh", "hyamd", "hyamdral",
  // corrections and repeats: "үгүй 2 сарын 13", "dahin 2 sard" correct or repeat the date, they name no place
  "үгүй", "угүй", "үгуй", "үгэй", "буруу", "уучлаарай", "зүгээр", "дахиж", "дахиад", "ugui", "ugvi", "bish", "buruu", "uuchlaarai", "zugeer",
  "dahin", "dahiad", "dahij", "dahiin",
  // numbers in words
  "нэг", "хоёр", "гурав", "дөрөв", "тав", "зургаа", "найм", "ес", "арав", "арван",
  // Latin typing of the same words
  "oni", "ony", "jil", "jiliin", "sar", "sard", "sariin", "saraar", "saruud", "honog", "udur", "shunu", "hezee", "hedend", "odoo", "udahgui", "ireh", "daraa", "umnu", "hoish", "hurtel",
  "hooron", "eheer", "ehnii", "dundur", "suuleer", "orchim", "havicaa", "uyeer", "uyed", "ene", "ter", "ingeed", "tegeed", "tegvel", "tegehdee", "harin", "gehdee", "bas", "bolon", "esvel",
  "hun", "huuhed", "huuhdiin", "huuhduud", "tom", "nyarai", "nastai", "nas", "gerbul", "naiz", "naizuud", "hamt", "hamtdaa", "bid", "bidend", "namaig", "nadad", "minii",
  "hello", "sain", "haashaa", "haana", "hashaa", "gadaad", "gadagshaa", "ulsruu", "orond", "yu", "uu", "ve", "be", "bilu", "yum", "yumaa", "lee", "shuu", "daa", "dee", "baina", "baigaa", "baih", "baidag", "bna", "bnaa", "bnuu", "bga", "bgaa", "bol", "boloh", "bolno", "bolomjtoi",
  "yamar", "ali", "hed", "heden", "yaaj", "yagaad", "iim", "tiim", "gej", "geed", "gesen", "gedeg", "ni", "mdeelel", "medeelel", "medeelliig", "huvaari", "une", "vne", "unetei", "tulbur", "niit", "tugrug",
  "aylal", "ayalal", "aylaliin", "aylaluud", "ayaluud", "aylaltai", "nisleg", "nislegtei", "shuud", "gazar", "gazriin", "hosolson", "tsagaan", "uyeer", "bayar", "bayaraar",
  "neg", "nig", "hoyor", "hoyr", "gurav", "dorov", "tav", "zurgaa", "naim", "yes", "arav", "arvan",
]);

/** Verb stems (a verb is a stem plus an ending, see VERB_ENDING). Cyrillic and Latin typing. */
const VERB_STEMS = [
  "гар", "яв", "оч", "ир", "ав", "хий", "үз", "мэд", "сонирх", "хүс", "тохир", "тааруул", "төлөвл", "бод", "шийд", "захиал", "бүртг", "асуу", "хэл", "өг", "илгээ",
  "явуул", "харуул", "аял", "байр", "сана", "хүр", "зөвш", "дурл", "таар", "хар", "эхл", "эхэл", "дуус", "буц", "ирэ", "очи", "очо", "үзэ", "авъ", "хүлээ", "бич", "авч", "тод",
  "yav", "gar", "och", "ir", "av", "hiy", "uz", "med", "sonirh", "hus", "tohir", "taaruul", "bod", "shiid", "zahial", "burtg", "asuu", "hel", "og", "ilgee", "ayal", "ehl", "buc", "bich", "huleel",
];
const VERB_ENDING = /^(?:х|ах|ох|эх|өх|үх|на|нэ|но|нө|ана|эна|с(?:ан|эн|он|өн)\p{L}*|сны\p{L}*|сний\p{L}*|аад|ээд|оод|өөд|даг|дэг|дог|дөг|вал|вэл|бал|бэл|маар|мээр|моор|мөөр|хаар|хээр|хоор|хөөр|ъя|ье|яа|ч|ж|аж|иж|ыж|ээ|оо|өө|аа|лаа|лээ|лоо|лөө|уул|үүл|аарай|ээрэй|оорой|өөрэй|гүй|ах\p{L}*|эх\p{L}*|ох\p{L}*|өх\p{L}*|h|ah|eh|oh|uh|aad|eed|ood|san|sen|dag|deg|val|vel|bal|bel|maar|meer|moor|muur|haar|heer|ya|ye|j|ch|aaraai|eerei|gui)$/u;

/** A word that carries a verb ending by itself: "явмаар", "тааруулсан", "гараад", "tegvel". */
const BARE_VERB_ENDING = /(?:маар|мээр|моор|мөөр|хаар|хээр|аад|ээд|оод|өөд|сан|сэн|сон|сөн|даг|дэг|дог|дөг|вал|вэл|лаа|лээ|aad|eed|ood|maar|meer|moor|san|sen|dag|deg|val|vel)$/u;
/** Comitative / reflexive endings of party words: "хүүхдүүдтэйгээ", "гэр бүлээрээ", "найзуудтайгаа". */
const REFLEXIVE_ENDING = /(?:(?:тай|тэй|той|төй)(?:гаа|гээ|гоо|гөө)|аараа|ээрээ|оороо|өөрөө|тайгаа|тэйгээ)$/u;
const COMITATIVE_ENDING = /(?:тай|тэй|той|төй|tai|tei)$/u;

/** Chat typing doubles letters ("үеээр", "байнаа") and drops vowels ("ямр", "бн"): compare on a collapsed form. */
const collapseRuns = (word: string) => word.replace(/(\p{L})\1+/gu, "$1");
const VOWELS = /[аэиоуөүыеёюяaeiou]/gu;
const skeleton = (word: string) => word.charAt(0) + word.slice(1).replace(VOWELS, "");
const COLLAPSED_FUNCTION_WORDS = new Set([...FUNCTION_WORDS, ...CALENDAR_FOLLOWUP_WORDS].map(collapseRuns));
const FUNCTION_SKELETONS = new Set([...FUNCTION_WORDS, ...CALENDAR_FOLLOWUP_WORDS].filter((word) => word.length >= 3).map(skeleton));

/** A typed variant of a known function word: same word with doubled letters, or with its vowels left out. */
function isTypedFunctionWord(word: string): boolean {
  const collapsed = collapseRuns(word);
  if (COLLAPSED_FUNCTION_WORDS.has(collapsed)) return true;
  // Vowel-dropped typing only when the customer really dropped them (at most one vowel left), so a
  // real place name full of vowels is never mistaken for a filler word.
  const vowels = (collapsed.slice(1).match(VOWELS) || []).length;
  return vowels <= 1 && collapsed.length <= 6 && FUNCTION_SKELETONS.has(skeleton(collapsed));
}

export function isVerbOrFunctionWord(word: string): boolean {
  if (FUNCTION_WORDS.has(word) || CALENDAR_FOLLOWUP_WORDS.has(word)) return true;
  if (isTypedFunctionWord(word)) return true;
  // A light verb in any form ("болгооч", "өгөөч", "bolgooch") is a verb, never a place.
  if (LIGHT_VERB.test(word)) return true;
  // "аялал" in any case ("аяллыг", "аялалд") and its Latin spellings: the word for a trip is never a place.
  if (/^(?:аял|ayal|ayl)/u.test(word)) return true;
  if (BARE_VERB_ENDING.test(word) && word.length >= 5) return true;
  if (REFLEXIVE_ENDING.test(word)) return true;
  // "хөтөлбөртэй", "хүүхэдтэй", "нислэгтэй": a thing the trip HAS, not a place.
  if (COMITATIVE_ENDING.test(word) && word.length >= 5) return true;
  for (const stem of VERB_STEMS) {
    if (word.length > stem.length && word.startsWith(stem) && VERB_ENDING.test(word.slice(stem.length))) return true;
  }
  return false;
}

/** Words of the catalogue: any word inside a trip's name or aliases (a place the customer may name). */
function catalogueWords(trips: TravelTrip[]): { cyrillic: string[]; phonetic: string[] } {
  const cyrillic = new Set<string>();
  const phonetic = new Set<string>();
  for (const trip of trips) {
    for (const word of getTripNameHaystack(trip).split(" ")) {
      if (word.length < 3) continue;
      cyrillic.add(word);
      const latin = phoneticLatinText(word);
      if (latin.length >= 3) phonetic.add(latin);
    }
  }
  return { cyrillic: [...cyrillic], phonetic: [...phonetic] };
}

function stem(word: string): string {
  return word.slice(0, Math.max(4, word.length - 2));
}

function inCatalogue(word: string, words: ReturnType<typeof catalogueWords>): boolean {
  const prefix = stem(word);
  if (words.cyrillic.some((known) => known.startsWith(prefix) || (known.length >= 5 && word.startsWith(known.slice(0, Math.max(4, known.length - 2)))))) return true;
  const latin = phoneticLatinText(word);
  if (latin.length < 4) return false;
  const latinPrefix = stem(latin);
  return words.phonetic.some((known) => known.startsWith(latinPrefix) || latin.startsWith(stem(known)));
}

/** Light verbs that make a compound verb with the noun before them: болгох / өгөх / хүргэх (any ending, any script). */
const LIGHT_VERB = /^(?:болго|bolgo|өгө|өгч|өгөөч|ugu|ugch|ugooch|хүргэ|hurge)/iu;

/** A message longer than this is chatter, not a short place question: nothing in it is judged a place. */
const MAX_WORDS_FOR_PLACE_JUDGEMENT = 9;
/** Latin typing is far less predictable than Cyrillic: only a very short message is judged. */
const MAX_WORDS_FOR_LATIN_PLACE = 6;
const MAX_PLACE_CANDIDATES = 2;

/**
 * The words of the message that look like a place the catalogue does not hold.
 * `text` is the customer's words (trip names already removed is best, not required).
 *
 * Judged only when the message is short (a place question is: "Шинэ жилээр Лондон явах аялал байна уу")
 * and few words stay unexplained. A long, chatty message with several words this module cannot
 * place is left alone, and the caller treats it as it always did. `corroborated` skips that
 * confidence gate: a model already reported a place, this only checks that it is in the message.
 */
export function unknownPlaceTokens(text: string, trips: TravelTrip[], options: { corroborated?: boolean } = {}): string[] {
  const cleaned = withoutHolidayWords(text)
    // A year and its marker, however typed: "2027 оны", "2027 ионы", "2027 ioni" are a time, not a place.
    .replace(/(?<!\d)20\d{2}\s*(?:ионы|ионии|ioni|iony|ionii|оны|онд|ony|onii|он|жилийн|жил|jiliin|jil)?(?![\p{L}])/giu, " ")
    // A token that starts with a digit is a number, a date or a count: "30-нд", "2-р", "990k", "12/30".
    .replace(/(?<![\p{L}\d])\d[\p{L}\d./:-]*/gu, " ");
  const all = cleaned.split(/[^\p{L}]+/u).filter(Boolean);
  // A noun right before a light verb is half of a compound verb, never a place: "санал болгооч"
  // (recommend), "зөвлөгөө өгөөч", "sanal bolgooch" (live 2026-11-07: "Хамгийн хямд аялалыг санал
  // болгооч шинэ жилийн" went silent as an unknown place).
  const lightVerbObjects = new Set(all.filter((word, index) => LIGHT_VERB.test(all[index + 1] || "")).map((word) => word.toLowerCase()));
  const words = all.filter((word) => word.length >= 4 && !lightVerbObjects.has(word.toLowerCase()));
  if (!words.length) return [];
  const known = catalogueWords(trips);
  const found: string[] = [];
  for (const word of words) {
    if (isHomeCityWord(word) || isVerbOrFunctionWord(word) || inCatalogue(word, known)) continue;
    if (!found.includes(word)) found.push(word);
  }
  if (options.corroborated) return found;
  if (all.length > MAX_WORDS_FOR_PLACE_JUDGEMENT || found.length > MAX_PLACE_CANDIDATES) return [];
  const latin = found.some((word) => /^[a-z]+$/.test(word));
  return latin && all.length > MAX_WORDS_FOR_LATIN_PLACE ? [] : found;
}

/** True when `place` (a place a model reported) is still a word of the message after time words are set aside. */
export function reportedPlaceIsInMessage(place: string, text: string, trips: TravelTrip[]): boolean {
  const reported = unknownPlaceTokens(place, trips, { corroborated: true });
  if (!reported.length) return false;
  const present = unknownPlaceTokens(text, trips, { corroborated: true });
  return reported.some((token) => present.some((word) => word.startsWith(stem(token)) || token.startsWith(stem(word))));
}
