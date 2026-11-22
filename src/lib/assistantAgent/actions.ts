/**
 * From the model's propose_changes call to a proposal the admin may save.
 *
 * The model chooses; this file decides what is allowed to reach the review card:
 *  - the trip must be a real one the agent opened with get_trip in this turn (or that a
 *    resolved link / tapped option preloaded) — never a name, never a guess; a price rule's
 *    named trips too (only the catalogue-wide rule covers trips nobody opened);
 *  - a trip link in the message wins: only the linked trip may be edited, and when the
 *    link could not be resolved nothing is edited at all (no fall back to the trip the
 *    conversation was about — bug B1);
 *  - a partner-synced trip never gets a price, date or per-date status edit (the 30-minute
 *    sync would undo it), with the reason in plain Mongolian;
 *  - a photo is only ever one on our Cloudinary (host_image result or a hosted attachment);
 *  - every action is planned by the same code that validates and applies it (tripActionPlan:
 *    dateStateProblem, planDatePrice, planTripEdit, expandFareChangeAll; dateSale.planDateSale), so the card never
 *    promises what save would refuse (B8), and its summary line is the card's own text;
 *  - every action carries trip_id, the trip version (expected_updated_at) and a short
 *    Mongolian summary; a change that is already so is not proposed.
 */
import { fareWarnings } from "../assistantBrain";
import { describeChange } from "../assistantActionText";
import { dateSaleActionFields, planDateSale } from "../dateSale";
import { dateStateProblem, dateStatusOf, expandFareChangeAll, fareChangeOf, partnerEditProblem, planTripEdit, sanitizeTripEditAction, tripDepartureDays } from "../tripActionPlan";
import { PARTNER_EDIT_REASON, partnerSourceUrl } from "../tripDatePrice";
import { isHostedPhotoUrl } from "../tripPhotoEdit";
import { notesHeadingOf, notesSectionText, numbersNotInSources } from "../tripNotesAppend";
import { rewritesSavedDay } from "./programCompare";
import { addDepartureDates, removeDepartureDates } from "../tripScheduleChange";
import { prunePastDepartureDates, type ResolvedDepartureDate } from "../travelDates";
import type { AIChangeProposal, AITripAction, ConflictItem, TravelTrip, TripMutationFields } from "../travelTypes";
import { tripDepartures, ubToday } from "./readTools";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export type ProposalContext = {
  trips: TravelTrip[];
  now: Date;
  /** trip_id → the version get_trip showed in this turn. */
  fetched: Map<string, string>;
  /** Trips the agent saw in this turn (tool results, resolved links, tapped tokens). */
  seen: Set<string>;
  /** Trips named by a link in the message; `linkUnresolved` when a trip link named none. */
  linkTrips: Set<string>;
  linkUnresolved: boolean;
  /** Photo URLs we host: host_image results and hosted attachments. */
  hosted: Set<string>;
  /** What a section added to a description may quote numbers from: the admin's words and his attached files. */
  sources?: string[];
  /** Where an age band's numbers may come from: his words and his files (not trip texts). */
  bandSources?: string[];
  /** The number of days of the attached program compared with a trip in this turn (compare_program), by trip. */
  comparedFileDays?: Map<string, number>;
  /** Credit lines of the photos find_photos returned in this turn, by url. */
  photoCredits?: Map<string, Record<string, unknown>>;
  /** The admin's own words (no option tags, no links), and the trips he picked by tapping an option. */
  adminText?: string;
  pinned?: Set<string>;
  /** Files are attached to this turn: a program day's saved wording is kept (programCompare rewritesSavedDay). */
  fileTurn?: boolean;
  /** The admin's own words ask to replace a day's text whole. */
  rewriteAsked?: boolean;
};

/** A stored action: the travelTypes contract, built as a plain record so new verbs need no cast at each site. */
type StoredAction = Row & { action: string; trip_id: string; summary: string; expected_updated_at?: string };

const PARTNER_VERBS = new Set(["set_date_state", "set_date_price", "change_dates"]);
const PLANNED_VERBS = new Set(["set_date_price", "set_visibility", "patch_itinerary_day", "set_age_bands", "replace_photo", "append_notes"]);
const PATCH_FIELDS = new Set(["route_name", "duration_text", "hotel", "has_food", "seats_total", "seats_left", "status", "notes"]);
const PATCH_STATUSES = new Set(["active", "paused", "sold_out", "draft"]);
const ALREADY = /аль хэдийн/u;

function shortDate(date: string): string {
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
}

/** `final` refusals are explained, not retried: the model cannot fix them with another look. */
type Built = { action?: StoredAction; refuse?: string; final?: boolean; already?: string; notes?: string[] };

function versionOf(trip: TravelTrip, ctx: ProposalContext): string {
  return ctx.fetched.get(trip.id) || trip.updated_at;
}

function base(verb: string, trip: TravelTrip, ctx: ProposalContext): StoredAction {
  return { action: verb, trip_id: trip.id, expected_updated_at: versionOf(trip, ctx), summary: "" };
}

/** The card's own line(s) for the action (assistantActionText), so the summary and the card agree. */
function cardLine(action: StoredAction, trip: TravelTrip, ctx: ProposalContext, fallback: string): string {
  try {
    const lines = describeChange(action as unknown as AITripAction, trip, ctx.now).lines.filter(Boolean);
    return lines.length ? lines.join("; ") : fallback;
  } catch {
    return fallback;
  }
}

function buildDateState(raw: Row, trip: TravelTrip, ctx: ProposalContext): Built {
  const date = text(raw.date);
  const state = text(raw.state);
  const problem = dateStateProblem(trip, date, state, ctx.now);
  // A day the trip really has (not yet on the website, cancelled, past) is explained; a wrong day is asked again.
  if (problem) return { refuse: problem, final: ISO.test(date) && tripDepartureDays(trip, ctx.now).includes(date) };
  const current = tripDepartures(trip, ctx.now).find((entry) => entry.date === date)?.state;
  if (current === state) return { already: `${shortDate(date)} аль хэдийн ийм төлөвтэй байна` };
  // The date's status as the admin saw it: apply refuses if a seat button changed it since.
  const action = { ...base("set_date_state", trip, ctx), date, state, observed_status: dateStatusOf(trip, date) };
  return { action: { ...action, summary: cardLine(action, trip, ctx, `${shortDate(date)}: ${state}`) } };
}

/**
 * A sale and/or «Онцлох» on one date (dateSale.ts): written on the website's departure row like a day's
 * state, the regular fare kept. The date must be one of the trip's departures on the website; a sale
 * not below the date's regular fare is refused (explained, not retried: the amount is his).
 */
function buildDateSale(raw: Row, trip: TravelTrip, ctx: ProposalContext): Built {
  const date = text(raw.date);
  const planned = planDateSale(trip, { date, sale: raw.sale, clear_sale: raw.clear_sale, featured: raw.featured, from_adult: raw.from_adult, from_child: raw.from_child }, ctx.now);
  if (!planned.ok) return { refuse: planned.reason, final: planned.final };
  if (planned.plan.already) return { already: planned.plan.already, notes: planned.plan.notes };
  // The date's regular fares and its sale/«Онцлох» as the admin saw them: apply refuses if a date button changed them since.
  const action: StoredAction = { ...base("set_date_sale", trip, ctx), ...(dateSaleActionFields(planned.plan) as Row) };
  return { action: { ...action, summary: cardLine(action, trip, ctx, `${shortDate(date)}: хямдрал`) }, notes: planned.plan.notes };
}

/** The model's fares ({fares:{adult:{delta}}} or top-level adult) as the stored set_date_price action. */
function datePriceAction(raw: Row, trip: TravelTrip, ctx: ProposalContext): StoredAction {
  const fares = record(raw.fares);
  const action: StoredAction = { ...base("set_date_price", trip, ctx), date: text(raw.date) };
  for (const kind of ["adult", "child", "infant", "single"]) {
    const amount = fares[kind] ?? raw[kind];
    if (amount !== undefined && amount !== null) action[kind] = amount;
  }
  for (const key of ["band", "hotel", "package_id"]) if (text(raw[key])) action[key] = text(raw[key]);
  return action;
}

function itineraryDayAction(raw: Row, trip: TravelTrip, ctx: ProposalContext): StoredAction | string {
  const action: StoredAction = { ...base("patch_itinerary_day", trip, ctx), day: raw.day };
  for (const key of ["title", "description", "hotel", "meal_note"]) if (typeof raw[key] === "string" && text(raw[key])) action[key] = text(raw[key]);
  const meals = record(raw.meals);
  const mealPatch: Row = {};
  for (const key of ["breakfast", "lunch", "dinner"]) if (key in meals && (meals[key] === true || meals[key] === false || meals[key] === null)) mealPatch[key] = meals[key];
  if (Object.keys(mealPatch).length) action.meals = mealPatch;
  // With a file attached, a day's text is built on the saved wording. A patch that throws it away is the
  // file's raw text pasted over what staff wrote (the first real program update, 2026-11-21: three days
  // would have been overwritten, typos and all). The admin's own "бүхэлд нь соль" lifts this.
  if (ctx.fileTurn && !ctx.rewriteAsked && typeof action.description === "string") {
    const days = Array.isArray(trip.extra?.itinerary_days) ? (trip.extra.itinerary_days as unknown[]) : [];
    const saved = text(record(days[Number(raw.day) - 1]).description);
    if (saved && rewritesSavedDay(saved, action.description)) {
      return `${Number(raw.day)}-р өдөр: хадгалсан тайлбарыг файлын үгээр бүхэлд нь солихгүй — compare_program-ийн хариугаар хадгалсан өгүүлбэрүүдийг хэвээр үлдээж зөвхөн шинэ өгүүлбэрийг нэм; өөрчлөгдөөгүй өдрийг бүү хөнд`;
    }
  }
  return action;
}

/**
 * A band keeps only the parts whose numbers the admin (or his file) wrote: asked for «нярай (2024–2026
 * онд төрсөн)», the model added «0-23 сар» of its own (2026-11-22) — a band he never set, and one that
 * contradicts his (a child born in early 2024 is almost three at a winter departure).
 */
function ownBandParts(band: string, sources: string[]): string {
  const said = new Set(sources.join(" ").match(/\d+/g) || []);
  const parts = band.split(/\s*[,;]\s*/).filter(Boolean);
  const kept = parts.filter((part) => (part.match(/\d+/g) || []).every((number) => said.has(number)));
  return kept.length && kept.length < parts.length ? kept.join(", ") : band;
}

function ageBandsAction(raw: Row, trip: TravelTrip, ctx: ProposalContext): StoredAction {
  const bands = record(raw.bands);
  const action: StoredAction = base("set_age_bands", trip, ctx);
  const sources = ctx.bandSources?.length ? ctx.bandSources : [ctx.adminText || ""];
  for (const key of ["infant", "child", "adult"]) if (text(bands[key] ?? raw[key])) action[key] = ownBandParts(text(bands[key] ?? raw[key]), sources);
  return action;
}

function photoAction(raw: Row, trip: TravelTrip, ctx: ProposalContext): StoredAction | string {
  const remove = raw.remove === true;
  const newUrl = text(raw.new_url);
  if (!remove && !newUrl) return "шинэ зураг алга";
  // Only a photo already on our Cloudinary: anything else is fetched downstream without a guard.
  if (!remove && (!isHostedPhotoUrl(newUrl) || !ctx.hosted.has(newUrl))) return "шинэ зураг манай сервер дээр байршаагүй (эхлээд host_image)";
  const targets = [text(raw.old_url) ? 1 : 0, typeof raw.position === "number" ? 1 : 0, typeof raw.day === "number" ? 1 : 0].reduce((a, b) => a + b, 0);
  if (targets !== 1) return "аль зургийг солихыг (байрлал, өдөр эсвэл зураг) нэг утгаар заана";
  return {
    ...base("replace_photo", trip, ctx),
    ...(text(raw.old_url) ? { old_url: text(raw.old_url) } : {}),
    ...(typeof raw.position === "number" ? { position: Math.trunc(raw.position) } : {}),
    ...(typeof raw.day === "number" ? { day: Math.trunc(raw.day) } : {}),
    ...(remove ? { remove: true } : { new_url: newUrl }),
    // A photo find_photos brought keeps its credit line (a Wikimedia photo's author and licence).
    ...(!remove && ctx.photoCredits?.get(newUrl) ? { credit: ctx.photoCredits.get(newUrl) } : {}),
  };
}

/**
 * A section for the trip's description. Every number in it (a price, a count) must stand in the admin's
 * message or in a file he attached: a list re-typed by the model is checked digit by digit, never trusted.
 */
function notesAction(raw: Row, trip: TravelTrip, ctx: ProposalContext): StoredAction | string {
  const heading = notesHeadingOf(raw.heading);
  const body = notesSectionText(raw.text);
  if (!heading || !body) return "тайлбарт нэмэх хэсгийн гарчиг эсвэл мөр алга";
  const invented = numbersNotInSources([heading, body].join(" "), ctx.sources || []);
  if (invented.length) return `нэмэх хэсэгт таны мессеж, файлд байхгүй тоо байна (${invented.slice(0, 6).join(", ")}) — тоо бүрийг эх сурвалжаас яг хуулна`;
  return { ...base("append_notes", trip, ctx), heading, text: body };
}

/** One part of one trip (price of a date, visibility, a program day, age bands, a photo, a description section), planned exactly as save will. */
function buildPlanned(verb: string, raw: Row, trip: TravelTrip, ctx: ProposalContext): Built {
  let action: StoredAction | string;
  if (verb === "set_date_price") action = datePriceAction(raw, trip, ctx);
  else if (verb === "append_notes") action = notesAction(raw, trip, ctx);
  else if (verb === "set_visibility") action = typeof raw.visible === "boolean" ? { ...base(verb, trip, ctx), visible: raw.visible } : "харуулах эсвэл нуухыг заагаагүй";
  else if (verb === "patch_itinerary_day") action = itineraryDayAction(raw, trip, ctx);
  else if (verb === "set_age_bands") action = ageBandsAction(raw, trip, ctx);
  else action = photoAction(raw, trip, ctx);
  if (typeof action === "string") return { refuse: action };
  const clean = sanitizeTripEditAction(action as unknown as AITripAction) as unknown as StoredAction;
  const planned = planTripEdit(trip, clean as unknown as AITripAction, null, ctx.now);
  if (!planned.ok) return ALREADY.test(planned.reason) ? { already: planned.reason } : { refuse: planned.reason };
  return {
    action: { ...clean, summary: planned.plan.lines.join("; ") || cardLine(clean, trip, ctx, verb) },
    notes: planned.plan.warnings,
  };
}

/** Slips worth a second look on the trip-wide fares (42,900 for 42,900,000, a child above the adult). */
function fareWarningsFor(actions: StoredAction[], ctx: ProposalContext): string[] {
  return actions.flatMap((action) => {
    const trip = ctx.trips.find((entry) => entry.id === action.trip_id);
    return trip ? fareWarnings(trip, record(action.fields) as TripMutationFields).map((warning) => `«${trip.route_name}»: ${warning}`) : [];
  });
}

const nameKey = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const programDays = (value: string) => Number(/(\d+)\s*өдөр/iu.exec(value)?.[1] ?? NaN);
/** "7 өдөр 6 шөнийн", "7 өдрийн", "7 хоногийн" in the admin's words → 7; a date ("2-ны өдөр") or a program day ("3-р өдөр") is not a length. */
function statedDays(admin: string): number | null {
  const match = /(?:^|[^\d\p{L}/.-])(\d{1,2})\s+(?:өдөр|өдрийн|хоног\p{L}*|udur|udriin|odor|odriin|honog\p{L}*|days?)(?!\p{L})/iu.exec(admin);
  return match ? Number(match[1]) : null;
}
const STATE_WORDS: Record<string, string> = { active: "идэвхтэй", paused: "түр зогссон", sold_out: "дүүрсэн", draft: "ноорог", archived: "архив", cancelled: "цуцалсан" };

/**
 * Two saved trips under one name (a re-import, an older copy): the one meant is the one whose length
 * the admin said, else the only live one; otherwise he is asked. On 2026-11-21 «7 өдөр 6 шөнийн …
 * аяллыг сэргээ» was about to restore the 9-day copy of the same name. A tapped option or a pasted
 * link has already picked the trip.
 */
function twinProblem(trip: TravelTrip, ctx: ProposalContext): string | null {
  if (ctx.pinned?.has(trip.id) || ctx.linkTrips.has(trip.id)) return null;
  const twins = ctx.trips.filter((other) => nameKey(other.route_name) === nameKey(trip.route_name));
  if (twins.length < 2) return null;
  // The length he said; or, when a program file was compared with one of them, that file's own length.
  const fromFile = twins.map((entry) => ctx.comparedFileDays?.get(entry.id)).find((days): days is number => typeof days === "number" && days > 0) ?? null;
  const stated = statedDays(ctx.adminText || "") ?? fromFile;
  const live = (entry: TravelTrip) => !["archived", "cancelled", "draft"].includes(entry.status);
  let meant = stated ? twins.filter((entry) => programDays(entry.duration_text) === stated) : twins.filter(live);
  // Two of the stated length: the live one is the one on sale.
  if (meant.length > 1 && meant.some(live)) meant = meant.filter(live);
  if (meant.length === 1) {
    return meant[0].id === trip.id ? null : `ижил нэртэй ${twins.length} аялал байна; ${stated ? `${stated} өдрийнх нь` : "идэвхтэй нь"} trip_id=${meant[0].id} — түүнийг get_trip хийгээд ашигла`;
  }
  const described = twins.map((entry) => `${entry.duration_text || "хугацаа бичээгүй"}, ${STATE_WORDS[entry.status] || entry.status} (trip_id=${entry.id})`).join("; ");
  return `ижил нэртэй ${twins.length} аялал байна: ${described} — аль нь болохыг ask_user-ээр асуу (сонголт бүрт хугацаа, төлөвийг бич)`;
}

/**
 * Why a trip may not be edited in this turn, or null: it must be a real trip, the one a pasted
 * link names (when there is one), seen in this turn and opened with get_trip. `fixable` when one
 * more look (search_trips, get_trip) could make it right.
 */
function targetProblem(trip: TravelTrip | undefined, verb: string, ctx: ProposalContext): { reason: string; fixable: boolean } | null {
  if (!trip) return { reason: `${verb || "өөрчлөлт"}: аялал тодорхойгүй — алгаслаа`, fixable: true };
  const name = `«${trip.route_name}»`;
  if (ctx.linkTrips.size && !ctx.linkTrips.has(trip.id)) return { reason: `${name}: таны илгээсэн холбоосын аялал биш тул хөндөхгүй`, fixable: false };
  const twin = twinProblem(trip, ctx);
  if (twin) return { reason: `${name}: ${twin}`, fixable: true };
  if (!ctx.seen.has(trip.id)) return { reason: `${name}: энэ мессежээс тодорхойлогдоогүй аялал тул хөндөхгүй`, fixable: true };
  // Every edit is built on the trip as get_trip showed it (its version, dates, rows, photos).
  if (!ctx.fetched.has(trip.id)) return { reason: `${name}: мэдээллийг нь шалгаагүй тул хөндөхгүй (эхлээд get_trip)`, fixable: true };
  return null;
}

type FareChangeBuilt = { expanded: StoredAction[]; notes: string[]; refusals: string[]; fixable: boolean };

/**
 * "Бүх аяллын үнийг +100k" / "энэ аяллын бүх үнийг …": one versioned patch per trip, the skipped
 * ones with their reasons. Named trips pass the same checks as every other edit (a real trip the
 * turn opened with get_trip); only the catalogue-wide rule (all_active) covers trips nobody opened.
 */
function buildFareChangeAll(raw: Row, ctx: ProposalContext): FareChangeBuilt {
  const none = (reason: string, fixable: boolean): FareChangeBuilt => ({ expanded: [], notes: [], refusals: [reason], fixable });
  const change = fareChangeOf(raw.change);
  if (!change) return none("үнийн өөрчлөлт тодорхойгүй", true);
  const filter = record(raw.filter);
  const ids = [...new Set([...(Array.isArray(raw.trip_ids) ? raw.trip_ids : []), ...(Array.isArray(filter.trip_ids) ? filter.trip_ids : []), raw.trip_id].map(text).filter(Boolean))];
  const allActive = raw.all_active === true || filter.all_active === true;
  if (!ids.length && !allActive) return none("аль аяллуудын үнэ болохыг заагаагүй", true);
  const refusals: string[] = [];
  let fixable = false;
  const allowed = ids.filter((id) => {
    const problem = targetProblem(ctx.trips.find((trip) => trip.id === id), "үнийн өөрчлөлт", ctx);
    if (problem) { refusals.push(problem.reason); fixable ||= problem.fixable; }
    return !problem;
  });
  if (ids.length && !allowed.length) return { expanded: [], notes: [], refusals, fixable };
  const expansion = expandFareChangeAll(ctx.trips, change, ids.length ? { trip_ids: allowed } : { all_active: true });
  const expanded = expansion.actions.map((action) => {
    const trip = ctx.trips.find((entry) => entry.id === action.trip_id)!;
    return { ...(action as unknown as StoredAction), expected_updated_at: versionOf(trip, ctx) };
  });
  const notes = [
    ...expansion.notes,
    ...expansion.skipped.map((skip) => `«${skip.route_name}» алгасагдсан: ${skip.reason}`),
    ...fareWarningsFor(expanded, ctx),
  ];
  if (!expanded.length) return { expanded: [], notes: [], refusals: [...refusals, notes.join(" ") || "өөрчлөгдөх үнэ алга"], fixable };
  return { expanded, notes, refusals, fixable };
}

function buildChangeDates(raw: Row, trip: TravelTrip, ctx: ProposalContext): Built {
  // A departure that has already left is never added: a schedule table lists the whole season, and a
  // trip brought back with only past days is archived again the moment it is read (2026-11-21).
  const today = ubToday(ctx.now);
  const asked = (Array.isArray(raw.add_dates) ? raw.add_dates : []).map(text).filter((date) => ISO.test(date));
  const add = asked.filter((date) => date >= today);
  const past = asked.filter((date) => date < today);
  const remove = (Array.isArray(raw.remove_dates) ? raw.remove_dates : []).map(text).filter((date) => ISO.test(date));
  if (!add.length && !remove.length) return { refuse: past.length ? `${past.map(shortDate).join(", ")} аль хэдийн өнгөрсөн тул нэмэхгүй — ирэх өдрүүдийг заана уу` : "нэмэх, хасах огноо тодорхойгүй" };
  const fields: TripMutationFields = {};
  const parts: string[] = [];
  const notes: string[] = [];
  if (past.length) notes.push(`${past.map(shortDate).join(", ")} аль хэдийн өнгөрсөн тул нэмээгүй.`);
  const added = add.length ? addDepartureDates(trip, add, ctx.now) : null;
  if (added?.added.length) { Object.assign(fields, added.fields); parts.push(`${added.added.map(shortDate).join(", ")} гаралт нэмнэ`); }
  notes.push(...(added?.notes ?? []));
  if (remove.length) {
    const after = removeDepartureDates({ ...trip, departure_dates: fields.departure_dates ?? trip.departure_dates, extra: { ...trip.extra, ...(fields.extra || {}) } }, remove, ctx.now);
    if (after.removed.length) { Object.assign(fields, after.fields); parts.push(`${after.removed.map(shortDate).join(", ")} гаралтыг хасна`); }
    notes.push(...after.notes);
  }
  if (!parts.length) return { already: notes.join(" ") || "огноонд өөрчлөх зүйл алга" };
  return { action: { ...base("patch", trip, ctx), summary: parts.join("; "), fields }, notes };
}

function buildPatch(raw: Row, trip: TravelTrip, ctx: ProposalContext): Built {
  const fields = record(raw.fields);
  const out: Row = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!PATCH_FIELDS.has(key)) { dropped.push(key); continue; }
    if (key === "status" && !PATCH_STATUSES.has(text(value))) { dropped.push(key); continue; }
    if ((key === "seats_total" || key === "seats_left") && !(typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10_000)) { dropped.push(key); continue; }
    if (key === "has_food" && typeof value !== "boolean") { dropped.push(key); continue; }
    if (["route_name", "duration_text", "hotel", "notes"].includes(key) && !(typeof value === "string" && value.trim())) { dropped.push(key); continue; }
    const current = (trip as unknown as Row)[key];
    if (current === value) continue;
    out[key] = typeof value === "string" ? value.trim() : value;
  }
  // "Идэвхжүүл" / "сэргээ" on a hidden trip (archived, or hidden with "идэвхгүй болго") means
  // live again: the same save shows it on the site and in the bot, or it would stay hidden.
  if (text(fields.status) === "active" && trip.extra?.customer_visible === false) out.extra = { customer_visible: true };
  if (!Object.keys(out).length) return dropped.length ? { refuse: "энэ өөрчлөлтийг ингэж хийхгүй (үнэ, зураг, огноонд тусгай үйлдэл бий)" } : { already: "аль хэдийн ийм байна" };
  if (typeof out.route_name === "string") {
    const aliases = Array.isArray(trip.extra?.aliases) ? (trip.extra.aliases as unknown[]).filter((alias): alias is string => typeof alias === "string") : [];
    out.extra = { ...record(out.extra), aliases: aliases.includes(trip.route_name) ? aliases : [...aliases, trip.route_name] };
  }
  const notes = dropped.length ? [`Үл хамаарах талбар орхигдлоо: ${dropped.join(", ")}.`] : [];
  const action = { ...base("patch", trip, ctx), fields: out };
  return { action: { ...action, summary: text(raw.summary) || cardLine(action, trip, ctx, "Аяллын мэдээлэл шинэчлэгдэнэ") }, notes };
}

function buildStatusVerb(verb: "cancel" | "delete", trip: TravelTrip, ctx: ProposalContext, summary: string): Built {
  if (verb === "delete" && trip.status === "archived") return { already: "аль хэдийн архивт байна" };
  if (verb === "cancel" && trip.status === "cancelled") return { already: "аль хэдийн цуцлагдсан" };
  return { action: { ...base(verb, trip, ctx), summary: summary || (verb === "delete" ? "Архивлана — сайт, ботоос харагдахаа болино (буцааж болно)" : "Аяллыг цуцлана") } };
}

/**
 * The proposal for the model's actions, or a note when nothing may be proposed. Never
 * throws; every refused part is said once, plainly, on the card or in the note. `fixable`
 * says whether the model could repair it with one more look (a missing get_trip, a wrong
 * date or row) rather than only explain it (a partner trip, a link to another trip).
 */
export function buildAgentProposal(rawActions: unknown, replyText: string, ctx: ProposalContext): { proposal: AIChangeProposal } | { note: string; fixable: boolean } {
  // One section for several trips ("both check-up trips") is written once and planned per trip.
  const items = (Array.isArray(rawActions) ? rawActions.map(record) : []).flatMap((raw) => {
    if (text(raw.action) !== "append_notes" || !Array.isArray(raw.trip_ids)) return [raw];
    const ids = [...new Set([text(raw.trip_id), ...raw.trip_ids.map(text)].filter(Boolean))];
    return ids.length ? ids.map((id) => ({ ...raw, trip_id: id, trip_ids: undefined })) : [raw];
  });
  const byId = new Map(ctx.trips.map((trip) => [trip.id, trip]));
  const actions: StoredAction[] = [];
  const conflicts: ConflictItem[] = [];
  const refusals: string[] = [];
  const already: string[] = [];
  let fixable = false;
  if (ctx.linkUnresolved && !ctx.linkTrips.size && items.length) {
    return { note: "Холбоосоос аль аялал болохыг олж чадсангүй, тиймээс юу ч өөрчлөхгүй. Аяллын нэрийг бичих эсвэл uudamtravel.mn дээрх хуудасных нь холбоосыг дахин хуулж оруулна уу.", fixable: false };
  }
  for (const raw of items.slice(0, 40)) {
    const verb = text(raw.action);
    if (verb === "fare_change_all") {
      const built = buildFareChangeAll(raw, ctx);
      const allowed = built.expanded.filter((action) => !ctx.linkTrips.size || ctx.linkTrips.has(action.trip_id));
      refusals.push(...built.refusals);
      fixable ||= built.fixable;
      actions.push(...allowed);
      for (const note of built.notes) conflicts.push({ text: note, severity: "info", type: "fare_note" });
      continue;
    }
    const trip = byId.get(text(raw.trip_id));
    const problem = targetProblem(trip, verb, ctx);
    if (problem || !trip) { refusals.push(problem!.reason); fixable ||= problem!.fixable; continue; }
    const name = `«${trip.route_name}»`;
    if (partnerSourceUrl(trip) && PARTNER_VERBS.has(verb)) {
      refusals.push(`${name} ${PARTNER_EDIT_REASON}`);
      continue;
    }
    // A patch on a partner trip: the planner's own reason (prices/dates vs other partner-owned facts).
    const partnerPatch = partnerSourceUrl(trip) && verb === "patch" ? partnerEditProblem(trip, { action: "patch", fields: record(raw.fields) as TripMutationFields }) : null;
    if (partnerPatch) {
      refusals.push(partnerPatch);
      continue;
    }
    let built: Built;
    if (verb === "set_date_state") built = buildDateState(raw, trip, ctx);
    else if (verb === "set_date_sale") built = buildDateSale(raw, trip, ctx);
    else if (PLANNED_VERBS.has(verb)) built = buildPlanned(verb, raw, trip, ctx);
    else if (verb === "change_dates") built = buildChangeDates(raw, trip, ctx);
    else if (verb === "patch") built = buildPatch(raw, trip, ctx);
    else if (verb === "cancel" || verb === "delete") built = buildStatusVerb(verb, trip, ctx, text(raw.summary));
    else built = { refuse: `«${verb}» гэсэн үйлдэл байхгүй` };
    if (built.refuse) { refusals.push(built.refuse.startsWith(name) ? built.refuse : `${name}: ${built.refuse}`); fixable ||= !built.final; }
    if (built.already) already.push(built.already.startsWith(name) ? built.already : `${name}: ${built.already}`);
    if (built.action) {
      const action = { ...built.action, summary: `${name} — ${built.action.summary}` };
      if (!actions.some((existing) => JSON.stringify(existing) === JSON.stringify(action))) actions.push(action);
    }
    for (const note of built.notes || []) conflicts.push({ text: `${name}: ${note}`, severity: "info", type: "agent_note" });
  }
  // A show/hide beside a patch of the same trip rides in that patch: one save, one version.
  for (const visibility of actions.filter((action) => action.action === "set_visibility")) {
    const patch = actions.find((action) => action.action === "patch" && action.trip_id === visibility.trip_id);
    const extra = record(record(patch?.fields).extra);
    if (!patch || ("customer_visible" in extra && extra.customer_visible !== visibility.visible)) continue;
    if (!("customer_visible" in extra)) patch.summary = `${patch.summary}; ${visibility.visible ? "Сайт, ботод харуулна" : "Сайт, ботоос нууна"}`;
    patch.fields = { ...record(patch.fields), extra: { ...extra, customer_visible: visibility.visible } };
    actions.splice(actions.indexOf(visibility), 1);
  }
  // Going live needs a departure still ahead: a trip whose dates have all passed is archived again
  // the moment it is read (tripScheduleMaintenance), and the admin was told "saved" with a link to a
  // page that never came back (2026-11-11). Dates added in the same message count.
  for (const action of [...actions]) {
    const fields = record(action.fields);
    const activates = action.action === "patch" && (text(fields.status) === "active" || record(fields.extra).customer_visible === true);
    const trip = byId.get(action.trip_id);
    if (!activates || !trip || (trip.status === "active" && text(fields.status) !== "active")) continue;
    const dated = actions.filter((other) => other.trip_id === trip.id).map((other) => record(other.fields).departure_dates).find(Array.isArray) as string[] | undefined;
    const dates = dated ?? trip.departure_dates;
    const resolved = dated ? undefined : (trip.extra?.departure_dates_resolved as ResolvedDepartureDate[] | undefined);
    if (dates.length && prunePastDepartureDates(dates, ctx.now, resolved).dates.length) continue;
    actions.splice(actions.indexOf(action), 1);
    const last = dates.length ? ` (сүүлийн огноо: ${dates.slice(-3).join(", ")})` : "";
    refusals.push(`«${trip.route_name}»: гарах өдөр нь бүгд өнгөрсөн${last} тул идэвхжүүлбэл систем шууд дахин архивлана. Эхлээд шинэ огноо нэмээрэй, ж: «${trip.route_name} 12/5, 12/12-нд гарна» — тэгвэл өөрөө идэвхжиж сайтад гарна.`);
  }
  // A day's state or sale is written on the website and leaves the trip's version as it was; saved
  // first, it never makes a later edit of the same trip look "changed since the proposal".
  const websiteDay = (action: StoredAction) => Number(action.action === "set_date_state" || action.action === "set_date_sale");
  actions.sort((a, b) => websiteDay(b) - websiteDay(a));
  if (!actions.length) {
    const lines = [...refusals, ...already];
    return { note: lines.length ? `Өөрчлөх зүйл алга. ${lines.join(" ")}` : (text(replyText) || "Өөрчлөх зүйл олдсонгүй."), fixable: fixable && refusals.length > 0 };
  }
  for (const refusal of refusals) conflicts.push({ text: refusal, severity: "warning", type: "agent_refused" });
  for (const line of already) conflicts.push({ text: line, severity: "info", type: "already" });
  const proposal: AIChangeProposal = {
    summary: text(replyText) || actions.map((action) => action.summary).join(" "),
    needs_confirmation: true,
    important_reason: actions.some((action) => action.action === "delete") ? "Архивласан аялал сайт, ботоос харагдахаа болино; бичлэг, зураг, түүх хадгалагдана, буцааж болно." : "",
    conflicts: conflicts.map((item) => item.text),
    conflict_items: conflicts,
    actions: actions as unknown as AITripAction[],
  };
  return { proposal };
}
