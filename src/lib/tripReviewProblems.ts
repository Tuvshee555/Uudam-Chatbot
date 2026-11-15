/**
 * Everything the new-trip review must say before a save, as ONE list for the bar at its top: what
 * stops a publish or a save (red) and what deserves a look (amber), each with the place in the
 * review that fixes it, so a click on the problem opens that place.
 *
 * Why: until 2026-11-11 the review was a long form and these sentences sat beside their fields, all
 * 40 of them on screen; the owner had to scroll the whole form to find the two that mattered. The
 * review is now a preview of the trip page and the problems are listed once, at the top.
 *
 * The red list is the save gate's own (tripReview.reviewIssues): the same checks, only the missing
 * fares are said per price row («12/10 Пү: хүүхдийн үнэ оруулаагүй») instead of as one count.
 *
 * Pure: no database, no model, no React.
 */
import { checkDeparture, checkDuration, departureDays, formatYmd, itineraryOf, reviewIssues } from "./tripReview";
import { bandProblems, dayLabel, priceModel, type PriceCard } from "./tripReviewPrices";

type Row = Record<string, unknown>;

/**
 * The place a problem is fixed in:
 *   name · calendar · prices · duration · transport · program — a part of the review;
 *   card:<key> — one price row of the dates-and-prices table («all» or «g<n>», tripReviewPrices.ts).
 */
export type ReviewTarget = "name" | "calendar" | "prices" | "duration" | "transport" | "program" | `card:${string}`;

export type ReviewProblem = {
  /** Stable while the problem lasts (a React key). */
  id: string;
  text: string;
  /** "save": nothing can be saved; "publish": a draft can; null: only worth a look. */
  blocks: "save" | "publish" | null;
  /** Where it is fixed; null for a note the review cannot point at (the assistant's own doubts). */
  target: ReviewTarget | null;
  /** The box to put the cursor in once the place is open (a fare: "adult", "child", "bands"). */
  field?: string;
};

export type ReviewProblems = { blocking: ReviewProblem[]; warnings: ReviewProblem[] };

export const cardTarget = (key: string): ReviewTarget => `card:${key}`;

const AGE_SPAN = /(\d{1,3})\s*[-–—]\s*(\d{1,3})/;

/**
 * The bands of a price row whose age range runs backwards («12 – 2 нас»): the save refuses it
 * (invalid_age_range), so the row says which band and the problem opens that row.
 */
export function invertedBands(card: Pick<PriceCard, "bands">): number[] {
  return card.bands.filter((band) => {
    const span = AGE_SPAN.exec(typeof band.row.age_range === "string" ? band.row.age_range : "");
    return span ? Number(span[1]) > Number(span[2]) : false;
  }).map((band) => band.index);
}

export const INVERTED_BAND_TEXT = "Насны хүрээний доод хязгаар нь дээд хязгаараас их байна. Жишээ нь «2-12 нас» гэж бичнэ.";

/**
 * «12/10 Пү, 12/17 Пү +2»: which price row a problem is about, in a few words. The hotel or package is
 * added only when the days do not tell the row apart (no day, or another row for the same days).
 */
export function cardWhere(card: PriceCard, showYear = false, cards: PriceCard[] = []): string {
  const days = [...card.days.map((day) => dayLabel(day, showYear)), ...card.other];
  const shown = days.length > 3 ? `${days.slice(0, 3).join(", ")} +${days.length - 3}` : days.join(", ");
  const shared = cards.some((other) => other !== card && other.days.some((day) => card.days.includes(day)));
  const name = !shown || shared ? [card.hotel, card.packageId].filter(Boolean).join(" · ") : "";
  const fallback = card.kind === "all" || card.everyDate ? "Бүх гарах өдөр" : "";
  return [shown || fallback, name].filter(Boolean).join(" · ") || "Үнэ";
}

function missingFares(card: PriceCard): string {
  if (card.missing.adult && card.missing.child) return "том хүн, хүүхдийн үнэ оруулаагүй.";
  return card.missing.adult ? "том хүний үнэ оруулаагүй." : "хүүхдийн үнэ оруулаагүй.";
}

/**
 * The review's problems for a trip's fields. `notes` are the assistant's own doubts about this trip
 * (ProposalCard): they join the amber list as they are, without a place to open.
 */
export function reviewProblems(fields: Row, notes: string[] = [], now = new Date()): ReviewProblems {
  const blocking: ReviewProblem[] = [];
  const warnings: ReviewProblem[] = [];
  const model = priceModel(fields, now);
  const years = model.spansYears;

  for (const issue of reviewIssues(fields, now)) {
    if (issue.key === "name") blocking.push({ id: "name", text: issue.text, blocks: issue.blocks, target: "name" });
    else if (issue.key === "dates" || issue.key === "past_dates") blocking.push({ id: issue.key, text: issue.text, blocks: issue.blocks, target: "calendar" });
    else if (issue.key === "price") {
      const cards = model.cards.filter((card) => card.missing.adult || card.missing.child);
      // Said per price row, so the click opens the row that lacks the fare; the gate's own sentence when no row can be named.
      if (cards.length) {
        for (const card of cards) {
          blocking.push({ id: `price:${card.key}`, text: `${cardWhere(card, years, model.cards)}: ${missingFares(card)}`, blocks: issue.blocks,
            target: cardTarget(card.key), field: card.missing.adult ? "adult" : "child" });
        }
      } else blocking.push({ id: "price", text: issue.text, blocks: issue.blocks, target: "prices" });
    } else if (issue.key === "fares") {
      // The row the save would stop on: a band running backwards, two bands of one name, one day priced twice.
      const banded = model.cards.find((entry) => invertedBands(entry).length > 0) ?? model.cards.find((entry) => bandProblems(entry).length > 0);
      const card = banded ?? model.cards.find((entry) => entry.clash.length > 0);
      // A partner table repeats a backwards range on every row: say how many rows hold it.
      const backwards = model.cards.filter((entry) => invertedBands(entry).length > 0).length;
      const rows = backwards > 1 && issue.text.includes("доод хязгаар") ? ` ${backwards} мөрөнд.` : "";
      blocking.push({ id: `fares:${issue.text}`, text: `${issue.text}${rows} Засаагүй бол ноорог ч хадгалагдахгүй.`, blocks: issue.blocks,
        target: card ? cardTarget(card.key) : "prices", ...(banded ? { field: "bands" } : {}) });
    } else if (issue.key === "boundary") blocking.push({ id: "boundary", text: issue.text, blocks: issue.blocks, target: "program" });
    else if (issue.key === "program") warnings.push({ id: "program", text: issue.text, blocks: null, target: "program" });
  }

  const duration = checkDuration(fields);
  // Only a program LONGER than the stated length is a problem; a shorter one skips free days (shown as a note).
  if (duration.kind === "mismatch" && duration.programDays > duration.writtenDays) {
    warnings.push({ id: "duration", target: "duration", blocks: null,
      text: `Файлд «${duration.written}» гэж бичсэн ч хөтөлбөрт ${duration.programDays} өдөр байна.` });
  }
  const departures = departureDays(fields.departure_dates, now).days;
  const check = checkDeparture(departures, itineraryOf(fields));
  if (check.kind === "shift") {
    warnings.push({ id: "departure_shift", target: "calendar", blocks: null,
      text: `Файлд ${formatYmd(check.departure, now)} нь хөтөлбөрийн эхний өдөр (хил дээр). Улаанбаатараас өмнөх орой нь гарах эсэхийг сонгоно уу.` });
  } else if (check.kind === "conflict") {
    warnings.push({ id: "departure_conflict", target: "calendar", blocks: null,
      text: `Гарах өдөр ${formatYmd(check.departure, now)} боловч файлд хөтөлбөрийн эхний өдрийг ${formatYmd(check.programStart, now)} гэж бичсэн (${formatYmd(check.expected, now)} байх ёстой).` });
  }

  const strays = Array.from(new Set(model.cards.flatMap((card) => card.strays))).sort();
  if (strays.length) {
    warnings.push({ id: "strays", target: "prices", blocks: null,
      text: `Календарьт сонгоогүй өдрийн үнэ байна: ${strays.map((day) => dayLabel(day, years)).join(", ")}.` });
  }
  const savesRefused = blocking.some((problem) => problem.id.startsWith("fares:"));
  for (const card of model.cards) {
    const where = cardWhere(card, years, model.cards);
    // A clash the save refuses is already red above.
    if (card.clash.length && !savesRefused) {
      warnings.push({ id: `clash:${card.key}`, target: cardTarget(card.key), blocks: null,
        text: `${card.clash.map((day) => dayLabel(day, years)).join(", ")}: ижил буудал, багцтай хоёр үнэтэй.` });
    }
    if (card.adult !== null && card.child !== null && card.child > card.adult) {
      warnings.push({ id: `child_above:${card.key}`, target: cardTarget(card.key), field: "child", blocks: null,
        text: `${where}: хүүхдийн үнэ том хүнийхээс өндөр байна.` });
    }
    if (bandProblems(card).length && !savesRefused) {
      warnings.push({ id: `bands:${card.key}`, target: cardTarget(card.key), field: "bands", blocks: null,
        text: `${where}: нэмэлт ангиллын нэр эсвэл насны хүрээ дутуу.` });
    }
  }

  for (const note of notes) {
    const value = note.trim();
    if (value) warnings.push({ id: `note:${value}`, text: value, blocks: null, target: null });
  }
  return { blocking, warnings };
}
