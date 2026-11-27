/**
 * What turns the model's reading of a file into a trip the website can show as if
 * staff had added it there: the standard Ulaanbaatar days for the trip's transport
 * type (tripTransitDays.ts), the website's transport tags, a clickable transport
 * choice in the proposal, and one photo per day (at least six, photosWantedFor) — the file's own, or
 * free ones found for the places the trip visits (tripPhotoFinder.ts), each with
 * its credit. Runs on every proposal: when it is first built and again after each
 * clarification answer, so choosing another transport rebuilds the days.
 */
import { MAX_TRIP_PHOTOS } from "./tripPhotoEdit";
import { pickLibraryPhotos, type LibraryPhoto } from "./tripPhotoLibrary";
import type { AIChangeProposal, AITripAction, ConflictItem, TravelTrip } from "./travelTypes";
import { askOpenAIChatParts } from "./openaiFallback";
import { logWarn } from "./observability";
import { uploadImageToCloudinary } from "./tripPhotoImport/upload";
import { describeImageBuffer, isSameImage, type ImageMarks } from "./tripPhotoImport/dedupePhotos";
import { withSuggestedHotelProfiles, withoutPlaceOnlyHotels } from "./tripHotelNames";
import { MIN_TRIP_PRICE_MNT, PARTNER_PRICE, PRICE_MISSING, PRICE_QUESTION_MARK, mentionsPartnerPrice, parseMntPrices, withoutPartnerPrices } from "./tripPriceRules";
import {
  collectPhotoCandidates, downloadPhoto, photoQueriesForTrip, photosWantedFor, rankPhotos, withoutSamePictures, type FoundPhoto,
} from "./tripPhotoFinder";
import {
  TRANSPORT_CHOICE, TRANSPORT_LABELS, detectTransportType, durationForDays, isTransitDay, isTransportType, withoutBusReturn,
  type ItineraryDay, type TransportType,
} from "./tripTransitDays";
import { DEPARTURE_CONFLICT, DEPARTURE_SHIFT, applyTransport, checkDeparture, dayMeals, departureDays, deriveHasFood, formatYmd } from "./tripReview";
import { liftDayStates, withPricedDaysOnCalendar } from "./tripDayStates";
import { pricingDates } from "./adminDatePricing";
import { sourceFileBase } from "./fileProposalGuards";

export { DEPARTURE_CONFLICT, DEPARTURE_SHIFT };

type Row = Record<string, unknown>;
type Trace = { requestId?: string; correlationId?: string };
export type PhotoDeps = {
  ask?: typeof askOpenAIChatParts;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  upload?: (buffer: Buffer, fileName: string, mimeType: string) => Promise<string>;
  /** Stop looking for more photos after this long (the parse route has a 180 s budget). */
  budgetMs?: number;
};

const PHOTO_PROVIDER = "Wikimedia Commons";
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? value as Row : {});
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const sameRoute = (a: unknown, b: unknown) => text(a).toLowerCase().replace(/\s+/g, " ") === text(b).toLowerCase().replace(/\s+/g, " ");

function routeName(action: AITripAction): string {
  return text(action.fields?.route_name) || text(action.match?.route_name);
}

/** The actions that create a trip (not a patch of an existing one). */
export function newTripActions(proposal: AIChangeProposal): AITripAction[] {
  return proposal.actions.filter((action) => action.action === "upsert" && !text(action.trip_id) && action.fields);
}

/**
 * The transport the admin clicked, carried in the answer as `(transport_type=…)`, applied
 * to the named trip (or every new trip when none is named). True when something changed.
 */
export function applyTransportChoice(clarification: string, proposal: AIChangeProposal): boolean {
  const match = /transport_type=(land_flight|direct_flight|land|cruise)/.exec(clarification || "");
  if (!match) return false;
  const transport = match[1] as TransportType;
  const quoted = /[«"]([^»"]+)[»"]/.exec(clarification)?.[1];
  const targets = newTripActions(proposal).filter((action) => !quoted || sameRoute(routeName(action), quoted));
  for (const action of targets) {
    const fields = action.fields as Row;
    const extra = record(fields.extra);
    // Marked as the admin's own choice: it beats the program reading (tripTransitDays detectTransportType). Review only.
    fields.extra = { ...extra, transport_type: transport, transport_chosen: true };
  }
  return targets.length > 0;
}

function dropConflictItem(proposal: AIChangeProposal, type: string, route: string) {
  proposal.conflict_items = (proposal.conflict_items || []).filter((entry) => !(entry.type === type && sameRoute(record(entry.data).route_name, route)));
}

/**
 * A program day never states seat availability (that is each departure's state). "суудал бүрэн дүүрсэн" in a day's
 * text is a misreading — a poster's garbled closing line ("… аялал өндөрлөнө") read as "seats fully booked" (dry
 * run 2026-11-20) — and customers would read the trip as full. Only the phrase goes; the rest of the day stays.
 */
const SEAT_STATE_IN_PROGRAM = /\s*суудал\p{L}*(?:\s+(?:бүрэн|бүгд))?\s+(?:дүүрсэн|дууссан)(?!\p{L})/giu;
export function withoutSeatState(description: string): string {
  return description.replace(SEAT_STATE_IN_PROGRAM, "").replace(/[ \t]{2,}/g, " ");
}

type MealKey = "breakfast" | "lunch" | "dinner";
const MEAL_WORDS: Array<[MealKey, RegExp]> = [
  ["breakfast", /өглөөний\s+(?:цай|хоол)/iu], ["lunch", /(?:өдрийн|үдийн)\s+хоол/iu], ["dinner", /оройн\s+хоол/iu],
];
/**
 * Meals the admin's note says every day includes ("Оройн хоол орой бүр багтсан"). The model applied such a note on
 * one reading and dropped it on the next (dry runs 2026-11-20), so the admin's own words are applied by code.
 */
export function noteMealsEveryDay(note: string | undefined): MealKey[] {
  const said = text(note);
  if (!said || !/(?:өдөр|орой|өглөө)\s+(?:бүр|болгон)|бүх\s+өдөр/iu.test(said) || !/багтсан|багтана|орсон|орно/iu.test(said)) return [];
  if (/багтаагүй|ороогүй|өөрсдөө|өөрийн\s+зардл/iu.test(said)) return [];
  return MEAL_WORDS.filter(([, word]) => word.test(said)).map(([key]) => key);
}

const BED_WORDS = /ортой|оргүй|ор\s*эзл|нэмэлт\s*ор|with(?:out)?\s*(?:a\s*)?bed|no\s*bed/iu;
/**
 * Child rows "with a bed / without a bed" that no source mentions are the reading template's own example
 * echoed back (a real file, 2026-11-21: one child fare became «Хүүхэд ортой» and «Хүүхэд ор эзлэхгүй 2-12 нас»,
 * both at the child price, as two columns of the price table). They go; the row's child fare stays.
 * `evidence` is the file's text with the admin's note; with none (a picture) nothing can be checked.
 */
export function withoutEchoedBedRows(fields: Row, evidence: string): Row {
  if (!evidence.trim() || BED_WORDS.test(evidence)) return fields;
  const extra = record(fields.extra);
  let changed = false;
  const clean = (rows: unknown) => (Array.isArray(rows) ? rows.map((row) => {
    const entry = record(row);
    if (!Array.isArray(entry.passenger_prices)) return row;
    const kept = entry.passenger_prices.filter((passenger) => !BED_WORDS.test(text(record(passenger).label)));
    if (kept.length === entry.passenger_prices.length) return row;
    changed = true;
    return { ...entry, passenger_prices: kept };
  }) : rows);
  const price_groups = clean(extra.price_groups);
  const departure_date_groups = clean(extra.departure_date_groups);
  return changed ? { ...fields, extra: { ...extra, price_groups, departure_date_groups } } : fields;
}
/**
 * The admin's note says the group rides the train ("галт тэрэгтэй", "2 талдаа галт тэргээр", "стандарт галт
 * тэрэгний өдрүүд"); "галт тэрэггүй" says the opposite.
 */
export function noteAsksTrain(note: string | undefined): boolean {
  return /галт\s*тэр(?:эг(?!гүй)|г)|(?:^|[^a-z])(?:galt\s*tereg(?!gui)|train(?![a-z]))/iu.test(text(note));
}
/** Every evening with a hotel night gets dinner, every morning after one breakfast, every full day lunch. */
function withNoteMeals(days: ItineraryDay[], meals: MealKey[]): ItineraryDay[] {
  if (!meals.length || !days.length) return days;
  const last = days.length - 1;
  return days.map((day, index) => {
    const applies = (meal: MealKey) => meal === "dinner" ? index < last : meal === "breakfast" ? index > 0 : index > 0 && index < last;
    const set = meals.filter(applies);
    return set.length ? { ...day, meals: { ...(day.meals || {}), ...Object.fromEntries(set.map((meal) => [meal, true])) } } : day;
  });
}

const PRICE_FIELDS = ["adult_price", "child_price", "infant_price"] as const;
const PARTNER_DURATION = /\d+\s*өдөр[\s/,]*\d+\s*шөнө|\d+\s*шөнө[\s/,]*\d+\s*өдөр/gi;
// The model's own remarks that the file has no tugrug price: the review's price field says it once.
// ("үнэ" declines to "үнийг", "үнийн": the stem is matched. A real file produced both
// "үнийг төгрөгөөр тодорхойгүй" as a warning and "…тодруулах шаардлагатай" as a blocker.)
const MODEL_PRICE_NOTICE = /үн[эи]\S*[^.]{0,40}төгрөг[^.]{0,40}(?:тодорхойгүй|байхгүй|алга|тодруул)|төгрөг[^.]{0,30}үн[эи]\S*[^.]{0,30}(?:тодорхойгүй|байхгүй|алга|тодруул)/i;
// A card summary must sell the places; one that only restates when the trip starts and ends is dropped.
const SCHEDULE_ONLY_SUMMARY = /\d{1,2}\s*-?\s*р?\s*сарын\s*\d{1,2}|эхэлж|эхэлнэ|дуусна|өндөрлөнө/i;

const foreignCurrency = (value: unknown) => { const code = text(value).toUpperCase(); return Boolean(code) && code !== "MNT" && code !== "₮"; };
// An infant fare can be small; anything under this is still a yuan amount misread.
const MIN_INFANT_PRICE_MNT = 10_000;
const misreadYuan = (key: string, value: unknown) => typeof value === "number" && value > 0 && value < (key === "infant_price" ? MIN_INFANT_PRICE_MNT : MIN_TRIP_PRICE_MNT);

/**
 * One row of a price table without the partner's figures. A row that IS the partner's price
 * (labelled so, or in another currency) goes; a row with a real tugrug fare stays and only
 * loses the yuan remark in its note. Until 2026-11-05 the whole row went when any of its
 * text mentioned yuan, so a selling price printed beside the land price was lost with it.
 */
function scrubPriceRow(entry: unknown): Row | null {
  const row = { ...record(entry) };
  if (foreignCurrency(row.currency) || mentionsPartnerPrice(row.label)) return null;
  for (const key of PRICE_FIELDS) if (misreadYuan(key, row[key])) row[key] = null;
  for (const key of ["note", "notes", "label"]) if (typeof row[key] === "string") row[key] = withoutPartnerPrices(row[key]);
  if (Array.isArray(row.passenger_prices)) {
    row.passenger_prices = row.passenger_prices.filter((band) => {
      const fare = record(band);
      const amounts = Object.values(fare).filter((value): value is number => typeof value === "number" && value > 0);
      return !foreignCurrency(fare.currency) && !PARTNER_PRICE.test(text(fare.label)) && !amounts.some((amount) => amount < MIN_INFANT_PRICE_MNT);
    });
  }
  const fares = (Array.isArray(row.passenger_prices) ? row.passenger_prices.length : 0) + PRICE_FIELDS.filter((key) => typeof row[key] === "number").length;
  return fares > 0 ? row : null;
}

/** Words of a trip title that say nothing about which trip it is. */
const TITLE_FILLER = /^(?:аялал|аяллын|аялалын|хөтөлбөр|хөтөлбөрийн|тур|tour|trip|хот|хотын|\d+.*|[a-zа-яөү]?\d.*)$/iu;
const titleWords = (title: string) => title.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word && !TITLE_FILLER.test(word));

/**
 * The document's own title is only "<place> аялал" ("Шанхай аялал /5ш6ө/") while the file is named more
 * precisely ("№УБ-Шанхай хямдралтай аялал.pdf"): the file's name. A trip named just "Шанхай аялал" is the
 * whole of what a customer types about every Shanghai trip, and it took those questions (2026-11-25).
 * Null when the title already says more than its place, or the file name adds nothing.
 */
export function specificFileTitle(fields: Row): string | null {
  const title = text(fields.route_name);
  const extra = record(fields.extra);
  const own = titleWords(title);
  if (!title || own.length > 1) return null;
  const file = sourceFileBase(extra.source_file_name).replace(/\.(?:pdf|docx?|xlsx?|txt|jpe?g|png)$/i, "").replace(/^[\s№#]+/u, "").trim();
  const words = titleWords(file);
  if (words.length <= own.length || !own.every((word) => words.includes(word))) return null;
  return file;
}

/** "Жилийг бичээгүй", "Аль жилийн аялал вэ?": a note that the file gives no year. */
const YEAR_NOTE = /жил(?:ийг|ийн|ээ)?\s+(?:бичээгүй|дурдаагүй|заагаагүй|тодорхойгүй)|аль\s+жилийн/iu;
/** YYYY-MM-DD in Mongolia (UTC+8). */
const mongoliaYmd = (at: Date) => new Date(at.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);

/**
 * The file names its days without a year («12сар5/10/12») and every day falls within the coming year: the coming
 * date is the only reading. The reader's «the year is not written — which year?» became a blocking question whose
 * answers did not even name a year (2026-11-25). Such a note goes; a day further off keeps it.
 */
export function dropYearOnlyNotes(proposal: AIChangeProposal, fields: Row, route: string, now: Date): void {
  const days = departureDays(fields.departure_dates, now).days;
  const today = mongoliaYmd(now);
  const yearOut = mongoliaYmd(new Date(now.getTime() + 365 * 86_400_000));
  if (!days.length || !days.every((day) => day >= today && day <= yearOut)) return;
  const about = (value: string) => !route || value.includes(route) || !/[«"].+[»"]/u.test(value);
  proposal.conflict_items = (proposal.conflict_items || []).filter((item) => !(YEAR_NOTE.test(item.text) && about(item.text) && (!item.type || item.type === "date_based_pricing")));
  proposal.conflicts = (proposal.conflicts || []).filter((item) => !(YEAR_NOTE.test(item) && about(item)));
}

/** "12сар5/10/12", "12 сарын 5, 10, 12", "12-р сар 5/10": one month and the days listed after it. */
const MONTH_DAY_LIST = /(?<!\d)(1[0-2]|0?[1-9])\s*(?:-?\s*р)?\s*сар(?:ын|д)?\s*((?:[0-3]?\d\s*[/,]\s*)*[0-3]?\d)(?!\d)/giu;

/**
 * A new trip the reader left without departures, while the departure line it quoted from the file
 * (source_evidence.departure, found in the file's text) lists them in a short form the reader skipped
 * ("12сар5/10/12" = 12/5, 12/10, 12/12; 2026-11-25). Only that verified line is read; [] otherwise.
 */
export function daysFromDepartureLine(fields: Row, sourceText: string | undefined, now: Date): string[] {
  if (Array.isArray(fields.departure_dates) && fields.departure_dates.some((date) => text(date))) return [];
  const line = text(record(record(fields.extra).source_evidence).departure);
  if (!line || !sourceText) return [];
  const squashed = sourceText.replace(/\s+/g, " ");
  const at = squashed.indexOf(line.replace(/\s+/g, " "));
  if (at < 0) return [];
  // The quoted line is the table's header («№ Гарах сар/өдөр Тээш Үнэ/том…»): the dates are on the row under it.
  const header = /гарах|огноо|хөдлөх/iu.test(line) && !MONTH_DAY_LIST.test(line);
  MONTH_DAY_LIST.lastIndex = 0;
  const read = header ? squashed.slice(at + line.length, at + line.length + 160) : line;
  const written = [...read.matchAll(MONTH_DAY_LIST)].flatMap((match) => match[2].split(/\s*[/,]\s*/).map((day) => `${Number(match[1])} сарын ${Number(day)}`));
  return departureDays(written, now).days;
}

/**
 * Owner's rule (tripPriceRules.ts): no yuan or land price on a new trip — not as its fare,
 * not in its notes, summary or price table, not in the proposal's one-line summary. A fare
 * in another currency, or a "₮" figure too small to be a trip (a yuan amount misread), is
 * cleared; the admin is then asked for the tugrug price.
 */
export function scrubPartnerPrices(proposal: AIChangeProposal): void {
  if (typeof proposal.summary === "string" && proposal.summary.trim()) {
    proposal.summary = withoutPartnerPrices(proposal.summary) || "Файлаас аяллын мэдээлэл уншлаа.";
  }
  const actions = newTripActions(proposal);
  if (!actions.length) return;
  for (const action of actions) {
    const fields = action.fields as Row;
    const currency = text(fields.currency).toUpperCase();
    const foreign = Boolean(currency) && currency !== "MNT" && currency !== "₮";
    for (const key of PRICE_FIELDS) {
      const value = fields[key];
      if (typeof value === "number" && (foreign ? value !== 0 : misreadYuan(key, value))) fields[key] = null;
    }
    if (foreign) fields.currency = "MNT";
    for (const key of ["notes", "source_description"]) if (typeof fields[key] === "string") fields[key] = withoutPartnerPrices(fields[key]);
    const extra = record(fields.extra);
    if (Object.keys(extra).length) {
      const next: Row = { ...extra };
      for (const key of ["website_summary", "description"]) if (typeof next[key] === "string") next[key] = withoutPartnerPrices(next[key]);
      // A list line that is a partner's price (a settlement price among the notes) is not a condition of the trip.
      for (const key of ["important_notes", "included_items", "excluded_items"]) {
        if (Array.isArray(next[key])) next[key] = (next[key] as unknown[]).filter((line) => !mentionsPartnerPrice(line));
      }
      // A row priced only in yuan goes, but its departure days stay: «12сар5/10/12 | 3450юань» lost its dates
      // with its price and the new trip came with no departure at all (2026-11-25).
      const rowDays: string[] = [];
      for (const key of ["price_groups", "departure_date_groups"]) {
        if (Array.isArray(next[key])) next[key] = (next[key] as unknown[]).flatMap((group) => {
          const kept = scrubPriceRow(group);
          if (!kept) rowDays.push(...departureDays(pricingDates(record(group))).days);
          return kept ? [kept] : [];
        });
      }
      if (rowDays.length) {
        const listed = Array.isArray(fields.departure_dates) ? fields.departure_dates.map((date) => text(date)).filter(Boolean) : [];
        fields.departure_dates = [...new Set([...listed, ...rowDays])];
      }
      // The reader writes per-date fares under the older key, which is saved without its child
      // bands (tripExtraSchema.ts). Under the canonical key every column of the row survives.
      if (Array.isArray(next.departure_date_groups) && next.departure_date_groups.length && !(Array.isArray(next.price_groups) && next.price_groups.length)) {
        next.price_groups = next.departure_date_groups;
        next.departure_date_groups = [];
      }
      fields.extra = next;
    }
  }
  // The model's own "no tugrug price" notes and partner-price remarks: the price question replaces them.
  proposal.conflict_items = (proposal.conflict_items || []).filter((item) => item.type === PRICE_MISSING
    || !(MODEL_PRICE_NOTICE.test(item.text) || (item.severity !== "blocker" && mentionsPartnerPrice(item.text))));
  proposal.conflicts = (proposal.conflicts || []).filter((item) => !MODEL_PRICE_NOTICE.test(item) && !mentionsPartnerPrice(item));
}

/**
 * The tugrug price typed into the price question ("«trip» аяллын төгрөгийн үнийг бичнэ үү … →
 * 3,290,000 / 2,590,000"): first amount adult, second child. True when a fare was set.
 */
export function applyPriceAnswer(clarification: string, proposal: AIChangeProposal): boolean {
  let changed = false;
  const actions = newTripActions(proposal);
  for (const line of String(clarification || "").split(/\n/)) {
    if (!line.includes(PRICE_QUESTION_MARK)) continue;
    const arrow = line.lastIndexOf("→");
    if (arrow < 0) continue;
    const prices = parseMntPrices(line.slice(arrow + 1));
    if (!prices.length) continue;
    const route = /«([^»]+)»/.exec(line.slice(0, arrow))?.[1];
    let targets = actions.filter((action) => route && sameRoute(routeName(action), route));
    if (!targets.length && actions.length === 1) targets = actions;
    for (const action of targets) {
      const fields = action.fields as Row;
      fields.adult_price = prices[0];
      if (prices[1] != null) fields.child_price = prices[1];
      fields.currency = "MNT";
      changed = true;
    }
  }
  return changed;
}

function setConflictItem(proposal: AIChangeProposal, item: ConflictItem, route: string) {
  const items = (proposal.conflict_items || []).filter((entry) => !(entry.type === item.type && sameRoute(record(entry.data).route_name, route)));
  proposal.conflict_items = [...items, item];
}

/**
 * Credits and day photos the previous proposal held, restored onto the revised one
 * (the model never sees photo data, so a revision comes back without them).
 */
export function carryOverPhotoExtras(previous: AIChangeProposal, revised: AIChangeProposal): void {
  const previousTrips = newTripActions(previous);
  const revisedTrips = newTripActions(revised);
  for (const action of revisedTrips) {
    // A rename ("нэрийг … болго") is still the same card: one new trip before and after is that trip.
    const before = previousTrips.find((candidate) => sameRoute(routeName(candidate), routeName(action)))
      ?? (previousTrips.length === 1 && revisedTrips.length === 1 ? previousTrips[0] : undefined);
    if (!before) continue;
    const fields = action.fields as Row;
    // The card's photos: a revision came back without them and the trip was saved with an empty gallery (2026-11-25).
    const previousPhotos = Array.isArray(before.fields?.photo_urls) ? (before.fields.photo_urls as unknown[]).filter((url) => text(url)) : [];
    if (!(Array.isArray(fields.photo_urls) && fields.photo_urls.some((url) => text(url))) && previousPhotos.length) fields.photo_urls = previousPhotos;
    const extra = { ...record(fields.extra) };
    const previousExtra = record(before.fields?.extra);
    if (!Object.keys(record(extra.photo_credits)).length && Object.keys(record(previousExtra.photo_credits)).length) {
      extra.photo_credits = previousExtra.photo_credits;
    }
    const previousDays = Array.isArray(previousExtra.itinerary_days) ? previousExtra.itinerary_days.map(record) : [];
    if (Array.isArray(extra.itinerary_days) && previousDays.length) {
      extra.itinerary_days = extra.itinerary_days.map((entry) => {
        const day = record(entry);
        if (text(day.photo)) return day;
        const match = previousDays.find((old) => text(old.photo) && sameRoute(old.title, day.title));
        return match ? { ...day, photo: match.photo } : day;
      });
    }
    fields.extra = extra;
  }
}

function countPhotos(fields: Row, days: ItineraryDay[]): number {
  const urls = new Set((Array.isArray(fields.photo_urls) ? fields.photo_urls : []).filter((url): url is string => typeof url === "string"));
  for (const day of days) if (text(day.photo)) urls.add(text(day.photo));
  return urls.size;
}

/**
 * The agency's own photos first: a program day with no photo takes the house photo of the same place
 * (another saved trip's day photo, tripPhotoLibrary.ts). Returns the days with those photos and how many.
 */
function withHousePhotos(fields: Row, days: ItineraryDay[], library: LibraryPhoto[] | undefined): { days: ItineraryDay[]; added: number } {
  if (!library?.length) return { days, added: 0 };
  const existing = (Array.isArray(fields.photo_urls) ? fields.photo_urls : []).filter((url): url is string => typeof url === "string");
  const picks = pickLibraryPhotos(library, days, { exclude: existing });
  if (!picks.length) return { days, added: 0 };
  const byDay = new Map(picks.map((pick) => [pick.day, pick.url]));
  const next = days.map((day, index) => {
    const url = byDay.get(typeof day.day === "number" ? day.day : index + 1);
    return url && !text(day.photo) ? { ...day, photo: url } : day;
  });
  fields.photo_urls = Array.from(new Set([...existing, ...picks.map((pick) => pick.url)])).slice(0, MAX_TRIP_PHOTOS);
  fields.extra = { ...record(fields.extra), itinerary_days: next };
  return { days: next, added: picks.length };
}

export type SavedTripPhoto = { day: number; url: string; source: "house" | "web"; from?: string; credit?: Row };

/**
 * A photo for each program day of a SAVED trip that has none (the assistant's find_photos): the
 * agency's own photos of the same places first; with `web`, the Wikimedia search for the days
 * still empty. Nothing is written: the caller proposes each as a day photo.
 */
export async function photosForSavedTrip(trip: TravelTrip, options: { library: LibraryPhoto[]; web?: boolean; photos?: PhotoDeps; trace?: Trace }): Promise<SavedTripPhoto[]> {
  const before = (Array.isArray(trip.extra?.itinerary_days) ? trip.extra.itinerary_days : []).map((entry, index) => ({ ...(record(entry) as ItineraryDay), day: index + 1 }));
  if (!before.length) return [];
  const fields: Row = { route_name: trip.route_name, photo_urls: [...(trip.photo_urls || [])], extra: { ...(trip.extra || {}), itinerary_days: before } };
  const library = options.library.filter((photo) => photo.trip_id !== trip.id);
  await fillPhotos({ action: { action: "upsert", fields } as unknown as AITripAction, route: trip.route_name, days: before, deps: options.photos || {}, trace: options.trace, library, webSearch: options.web === true });
  const after = (record(fields.extra).itinerary_days as ItineraryDay[]) || [];
  const credits = record(record(fields.extra).photo_credits);
  const houseUrls = new Map(library.map((photo) => [photo.url, photo]));
  return after.flatMap((day, index) => {
    const url = text(day.photo);
    if (!url || text(before[index]?.photo)) return [];
    const house = houseUrls.get(url);
    const credit = record(credits[url]);
    return [{ day: index + 1, url, source: house ? "house" as const : "web" as const, ...(house ? { from: house.trip_name } : {}), ...(Object.keys(credit).length ? { credit } : house?.credit ? { credit: house.credit } : {}) }];
  });
}

async function fillPhotos(input: { action: AITripAction; route: string; days: ItineraryDay[]; deps: PhotoDeps; trace?: Trace; library?: LibraryPhoto[];
  /** false = the agency's own photos only, no search on the web. */ webSearch?: boolean }): Promise<{ added: number; message: string | null }> {
  const { action, route, deps } = input;
  const fields = action.fields as Row;
  const house = withHousePhotos(fields, input.days, input.library);
  const days = house.days;
  const houseLine = house.added ? `«${route}»: манай бусад аяллын ижил газрын зургаас ${house.added} өдөрт зураг тавив.` : null;
  const extra = record(fields.extra);
  const have = countPhotos(fields, days);
  // One photo per day, never fewer than six (photosWantedFor).
  const missing = photosWantedFor(days.length) - have;
  if (missing <= 0 || input.webSearch === false) return { added: house.added, message: houseLine };
  const startedAt = Date.now();
  const budgetMs = deps.budgetMs ?? 60_000;
  const upload = deps.upload || uploadImageToCloudinary;
  const programDays = days.filter((day) => !isTransitDay(day));
  const destinations = Array.isArray(extra.destinations) ? extra.destinations.map(String) : undefined;
  const queries = await photoQueriesForTrip({ title: route, days: programDays, destinations, wanted: missing, ask: deps.ask, trace: input.trace });
  if (!queries.length) return { added: house.added, message: houseLine };
  const dayOfQuery = new Map(queries.map((query) => [query.query, query.day]));
  const subject = (list: Array<{ query: string }>) => `${route}: ${list.map((query) => query.query).join(", ")}`;
  const candidates = await collectPhotoCandidates(queries.map((query) => query.query), { perQuery: 6, fetchImpl: deps.fetchImpl });
  const chosen = await rankPhotos(candidates, { subject: subject(queries), count: missing, reserve: 3, fetchImpl: deps.fetchImpl, ask: deps.ask, trace: input.trace });
  // Too few qualified: one broader search of the destination cities themselves.
  if (chosen.length < missing && Date.now() - startedAt < budgetMs / 2) {
    const cities = Array.from(new Set(queries.filter((query) => query.day === null).map((query) => query.query.replace(/\s+(skyline|famous landmark)$/i, "")))).slice(0, 3);
    const broader = cities.flatMap((city) => [`${city} old town`, `${city} park`, `${city} panorama`, `${city} at night`]).map((query) => ({ query, day: null }));
    if (broader.length) {
      const seen = new Set(candidates.map((photo) => photo.url));
      // Another file of a picture already chosen is no new photo (samePicture).
      const more = withoutSamePictures((await collectPhotoCandidates(broader.map((query) => query.query), { perQuery: 4, fetchImpl: deps.fetchImpl })).filter((photo) => !seen.has(photo.url)), chosen);
      chosen.push(...withoutSamePictures(await rankPhotos(more, { subject: subject(broader), count: missing - chosen.length, fetchImpl: deps.fetchImpl, ask: deps.ask, trace: input.trace }), chosen));
    }
  }
  const credits = { ...record(extra.photo_credits) };
  const placed: Array<{ photo: FoundPhoto; url: string }> = [];
  const marks: ImageMarks[] = [];
  // Three at a time: nine photos one by one took most of the reading's time budget. Only as many
  // as are still missing are taken; the reserves behind them are used when a file fails to download
  // or turns out to be the same picture as one already placed (found under another name).
  for (let index = 0; index < chosen.length && placed.length < missing;) {
    if (Date.now() - startedAt > budgetMs) break;
    const take = Math.min(3, missing - placed.length);
    const batch = chosen.slice(index, index + take);
    index += take;
    const files = (await Promise.all(batch.map(async (photo) => {
      const file = await downloadPhoto(photo, deps.fetchImpl);
      return file ? { photo, file, mark: await describeImageBuffer(file.buffer) } : null;
    }))).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    const fresh = files.filter((entry) => {
      if (marks.some((other) => isSameImage(other, entry.mark))) return false;
      marks.push(entry.mark);
      return true;
    });
    const uploaded = await Promise.all(fresh.map(async ({ photo, file }) => {
      try {
        const url = await upload(file.buffer, `${photo.title.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 60) || "photo"}.jpg`, file.mimeType);
        return { photo, url };
      } catch (error) {
        logWarn("trip_photos.upload_failed", { route, message: error instanceof Error ? error.message : String(error) });
        return null;
      }
    }));
    for (const entry of uploaded) if (entry) placed.push(entry);
  }
  if (!placed.length) return { added: house.added, message: houseLine };
  for (const { photo, url } of placed) credits[url] = { title: photo.title, author: photo.author, license: photo.license, page: photo.pageUrl, provider: PHOTO_PROVIDER };
  const urls = placed.map((entry) => entry.url);
  const existing = (Array.isArray(fields.photo_urls) ? fields.photo_urls : []).filter((url): url is string => typeof url === "string");
  fields.photo_urls = Array.from(new Set([...existing, ...urls])).slice(0, MAX_TRIP_PHOTOS);
  // Each photo goes onto the day whose sight it shows; the rest fill the program days still
  // without one, in order. Standard train days never get one.
  const withPhotos = days.map((day) => ({ ...day }));
  const unplaced: string[] = [];
  for (const { photo, url } of placed) {
    const dayNumber = dayOfQuery.get(photo.query);
    const day = withPhotos.find((entry) => entry.day === dayNumber && !isTransitDay(entry) && !text(entry.photo));
    if (day) day.photo = url; else unplaced.push(url);
  }
  for (const day of withPhotos) {
    if (!unplaced.length) break;
    if (!isTransitDay(day) && !text(day.photo)) day.photo = unplaced.shift();
  }
  fields.extra = { ...extra, itinerary_days: withPhotos, photo_credits: credits };
  return { added: urls.length + house.added, message: `${houseLine ? `${houseLine} ` : ""}«${route}»: ${PHOTO_PROVIDER}-оос ${urls.length} зураг нэмэв (зохиогч, лицензийг хадгалсан).` };
}

const squash = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * The short quotes the model gives for where it read the departure, the duration and the
 * meals. Only a quote that really is in the source survives, so the review never shows
 * an invented "the file says".
 */
export function keptEvidence(raw: unknown, sourceText?: string): { source_evidence?: Row } {
  const quotes = record(raw);
  const source = sourceText ? squash(sourceText) : "";
  const kept: Row = {};
  for (const key of ["departure", "duration", "meals"]) {
    const quote = text(quotes[key]).slice(0, 200);
    if (quote.length < 4 || mentionsPartnerPrice(quote)) continue;
    if (source && !source.includes(squash(quote))) continue;
    kept[key] = quote;
  }
  return Object.keys(kept).length ? { source_evidence: kept } : {};
}

/**
 * Finalises every new trip in the proposal. `photos` turns on the photo search (the
 * initial proposal); a revision passes nothing and keeps the photos it carried over.
 */
const MEAL_NAMES: Record<MealKey, string> = { breakfast: "өглөөний цай", lunch: "өдрийн хоол", dinner: "оройн хоол" };

export async function finalizeNewTripActions(proposal: AIChangeProposal, options: { photos?: PhotoDeps; trace?: Trace; sourceText?: string; now?: Date; /** The admin's note sent with the file. */ note?: string;
  /** A revision of a card already read (no file text here). */ revision?: boolean;
  /** The agency's own day photos by place (tripPhotoLibrary.ts), read only when a trip needs photos. */ loadLibrary?: () => Promise<LibraryPhoto[]> } = {}): Promise<void> {
  let library: LibraryPhoto[] | undefined;
  scrubPartnerPrices(proposal);
  for (const action of newTripActions(proposal)) {
    const fields = action.fields as Row;
    const specific = specificFileTitle(fields);
    if (specific) fields.route_name = specific;
    const route = routeName(action);
    // The hotels the file names are the trip's hotels from the start (name only): until
    // 2026-11-06 each was a «+» suggestion the admin had to click, or it was never saved.
    const withHotels = withSuggestedHotelProfiles(fields);
    if (withHotels !== fields) fields.extra = withHotels.extra;
    const withoutCityHotels = withoutPlaceOnlyHotels(fields);
    if (withoutCityHotels !== fields) Object.assign(fields, { hotel: withoutCityHotels.hotel, extra: withoutCityHotels.extra });
    const withoutEcho = withoutEchoedBedRows(fields, [text(options.sourceText), text(options.note)].filter(Boolean).join("\n"));
    if (withoutEcho !== fields) fields.extra = withoutEcho.extra;
    // Every priced row's day is on the calendar, and each day's seat state (full / few seats)
    // moves off the rows so the review shows it per day (tripDayStates.ts; put back on save).
    const scheduled = liftDayStates(withPricedDaysOnCalendar(fields, options.now ?? new Date()), options.now ?? new Date());
    if (scheduled !== fields) Object.assign(fields, { departure_dates: scheduled.departure_dates, extra: scheduled.extra });
    const evidenceDays = daysFromDepartureLine(fields, options.sourceText, options.now ?? new Date());
    if (evidenceDays.length) fields.departure_dates = evidenceDays;
    dropYearOnlyNotes(proposal, fields, route, options.now ?? new Date());
    const extra = record(fields.extra);
    const days = (Array.isArray(extra.itinerary_days) ? extra.itinerary_days : []).map((entry) => record(entry) as ItineraryDay);
    if (!days.length || !route) continue;
    try {
      const detected = detectTransportType({ title: route, route: text(extra.route), notes: text(fields.notes), days,
        transportType: isTransportType(extra.transport_type) ? extra.transport_type : undefined, chosen: extra.transport_chosen === true, transport: extra.transport });
      // "Галт тэрэгтэй" in the admin's note: the file's "by bus back to Ulaanbaatar" gives way to the standard train return.
      if (detected.transport !== "direct_flight" && noteAsksTrain(options.note)) {
        fields.extra = { ...record(fields.extra), itinerary_days: withoutBusReturn(days) };
      }
      const rebuilt = applyTransport(fields, detected.transport);
      Object.assign(fields, rebuilt.fields);
      // Every day's meals as included / own cost / not stated, and the trip-level flag from them.
      const built = { days: withNoteMeals((record(fields.extra).itinerary_days as ItineraryDay[]).map((day) => ({ ...day, meals: dayMeals(day),
        ...(typeof day.description === "string" ? { description: withoutSeatState(day.description) } : {}) })), noteMealsEveryDay(options.note)), added: rebuilt.added };
      // A meal "at your own cost" read from a picture cannot be checked against any text: twice a poster that never
      // said it came back with "Өдрийн хоол өөрсдөө" (dry runs 2026-11-20). The admin is asked to look.
      const ownCost = text(options.sourceText) ? [] : built.days.flatMap((day, index) =>
        (["breakfast", "lunch", "dinner"] as const).filter((meal) => day.meals?.[meal] === false).map((meal) => `${index + 1}-р өдөр ${MEAL_NAMES[meal]}`));
      // A revision is finalised without the file's text: its meals were checked on the first reading, and a
      // PDF's «Өглөө Орой» came back as «read from a picture» (2026-11-25). The first reading's note stays as it is.
      if (!options.revision) dropConflictItem(proposal, "meals_check", route);
      if (!options.revision && ownCost.length) setConflictItem(proposal, { text: `«${route}»: зурагнаас «өөрсдөө төлнө» гэж уншсан: ${ownCost.join(", ")}. Зурагт ингэж бичсэн эсэхийг шалгаад, бичээгүй бол хоосон үлдээнэ үү.`,
        severity: "warning", type: "meals_check", data: { route_name: route } }, route);
      const { source_evidence: _unverified, ...withoutEvidence } = record(fields.extra);
      void _unverified;
      fields.extra = { ...withoutEvidence, itinerary_days: built.days, ...keptEvidence(extra.source_evidence, options.sourceText) };
      const hasFood = deriveHasFood(built.days);
      if (hasFood !== null) fields.has_food = hasFood;
      const duration = durationForDays(built.days.length);
      const programDuration = text(record(fields.extra).program_duration_text) || `${rebuilt.programDays} өдөр`;
      if (built.added > 0) {
        // The partner's own length ("7 өдөр 6 шөнө") left in the summaries would contradict the
        // door-to-door duration the trip now has (seen on a real file, 2026-11-04).
        const current = record(fields.extra);
        if (typeof current.website_summary === "string") fields.extra = { ...current, website_summary: current.website_summary.replace(PARTNER_DURATION, duration.duration_text) };
        if (typeof proposal.summary === "string") proposal.summary = proposal.summary.replace(PARTNER_DURATION, duration.duration_text);
      }
      if (SCHEDULE_ONLY_SUMMARY.test(text(record(fields.extra).website_summary))) fields.extra = { ...record(fields.extra), website_summary: "" };
      // A condition listed under "Анхаарах зүйлс" is not repeated as the trip's note.
      const important = new Set((Array.isArray(record(fields.extra).important_notes) ? record(fields.extra).important_notes as unknown[] : []).map((line) => squash(String(line))));
      if (important.size && typeof fields.notes === "string") {
        fields.notes = fields.notes.split(/\n/).filter((line) => !line.trim() || !important.has(squash(line))).join("\n").trim();
      }
      // A line listed under "Үнэд багтсан / багтаагүй" is not repeated as a condition (a real file, 2026-11-21).
      const afterNotes = record(fields.extra);
      const listed = new Set([afterNotes.included_items, afterNotes.excluded_items].flatMap((list) => (Array.isArray(list) ? list : [])).map((line) => squash(String(line))));
      if (listed.size && Array.isArray(afterNotes.important_notes)) {
        fields.extra = { ...afterNotes, important_notes: afterNotes.important_notes.filter((line) => !listed.has(squash(String(line)))) };
      }
      setConflictItem(proposal, {
        text: `«${route}» — тээвэр: ${TRANSPORT_LABELS[detected.transport]}.${built.added > 0 ? ` Файлын хөтөлбөр (${programDuration}) дээр Улаанбаатараас гарах, буцах өдрүүд нэмэгдэж нийт ${duration.duration_text} болсон.` : ""}`,
        severity: "info",
        type: TRANSPORT_CHOICE,
        data: { route_name: route, transport_type: detected.transport, sure: detected.sure, added: built.added, program_days: rebuilt.programDays },
      }, route);
      // Nothing here stops the admin from saving; it only keeps an automatic import
      // (Drive sync) from saving a trip nobody looked at.
      // A trip priced per date (a schedule table) has its prices on the rows; the trip-wide fare is
      // derived from them on save. Saying "no tugrug price" there was false (2026-11-11, 6 partner pages).
      const rowPriced = (["price_groups", "departure_date_groups"] as const).some((key) => {
        const list = record(fields.extra)[key];
        return Array.isArray(list) && list.some((row) => typeof record(row).adult_price === "number" && (record(row).adult_price as number) >= MIN_TRIP_PRICE_MNT);
      });
      const unpriced = typeof fields.adult_price !== "number" && !rowPriced;
      if (built.added > 0 || !detected.sure || unpriced) proposal.needs_confirmation = true;
      // What is still missing is said once, beside the field it belongs to (tripReview.ts).
      if (unpriced) {
        setConflictItem(proposal, { text: `«${route}»: файлд төгрөгийн зарах үнэ алга (юань, ландын үнийг үнэ гэж авахгүй). Нийтлэхийн өмнө том хүн, хүүхдийн үнийг оруулна.`, severity: "info", type: PRICE_MISSING, data: { route_name: route } }, route);
      } else {
        dropConflictItem(proposal, PRICE_MISSING, route);
      }
      const dates = Array.isArray(fields.departure_dates) ? fields.departure_dates.filter((date) => text(date)) : [];
      for (const type of ["dates_missing", "dates_check", DEPARTURE_SHIFT, DEPARTURE_CONFLICT]) dropConflictItem(proposal, type, route);
      if (!dates.length) {
        // Said in full: a trip saved without a departure is archived at once (tripScheduleMaintenance
        // "no_departure_dates") and is on neither the website nor the bot until a date is added — the
        // "it saved but is not on the site" surprise of 2026-10-23.
        setConflictItem(proposal, { text: `«${route}»: гарах өдөр файлд олдсонгүй — календариас сонгоно уу. Гарах өдөргүй хадгалсан аялал вэбсайт, ботод харагдахгүй (архивт орно); өдөр нэмэхэд автоматаар нийтлэгдэнэ.`, severity: "info", type: "dates_missing", data: { route_name: route } }, route);
      } else {
        // The dates the source writes beside its own days decide whether the departure is the
        // day the train leaves Ulaanbaatar or the partner's first day at the border. Until
        // 2026-11-05 every partner file got a "check the date" warning, right or not.
        const check = checkDeparture(departureDays(dates, options.now).days, built.days);
        if (check.kind === "shift") {
          setConflictItem(proposal, { text: `«${route}»: файлд ${formatYmd(check.departure, options.now)} нь хөтөлбөрийн эхний өдөр (хил дээр). Улаанбаатараас галт тэргээр ${formatYmd(check.suggested, options.now)}-нд гарна — гарах өдрөө сонгоно уу.`,
            severity: "info", type: DEPARTURE_SHIFT, data: { route_name: route, departure: check.departure, suggested: check.suggested } }, route);
        } else if (check.kind === "conflict") {
          setConflictItem(proposal, { text: `«${route}»: гарах өдөр ${formatYmd(check.departure, options.now)} боловч файлд хөтөлбөрийн эхний өдрийг ${formatYmd(check.programStart, options.now)} гэж бичсэн (${formatYmd(check.expected, options.now)} байх ёстой). Аль нь зөвийг шалгана уу.`,
            severity: "warning", type: DEPARTURE_CONFLICT, data: { route_name: route, departure: check.departure, program_start: check.programStart, expected: check.expected } }, route);
        }
      }
      if (options.photos) {
        library ??= options.loadLibrary ? await options.loadLibrary().catch(() => []) : [];
        const result = await fillPhotos({ action, route, days: built.days, deps: options.photos, trace: options.trace, library });
        if (result.message) setConflictItem(proposal, { text: result.message, severity: "info", type: "photos_found", data: { route_name: route, added: result.added } }, route);
      }
    } catch (error) {
      logWarn("trip_proposal.finalize_failed", { route, message: error instanceof Error ? error.message : String(error) });
    }
  }
}
