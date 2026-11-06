/**
 * The assistant's change verbs, planned in code from the trip itself (no model involved here):
 *
 *   set_date_state   one departure day open / low / full / paused on the website
 *   set_date_price   one date's fares (tripDatePrice.ts)
 *   set_visibility   extra.customer_visible
 *   patch_itinerary_day  one program day (tripItineraryDayEdit.ts)
 *   set_age_bands    extra.age_rules (+ default-form tier and poster column labels)
 *   replace_photo    an exact photo swap / removal (tripPhotoEdit.ts)
 *   fare_change_all  a fare rule over many trips, expanded into one patch per trip
 *
 * Validation (travelAIValidation) plans every action to refuse what cannot be done, with the
 * reason in Mongolian; apply (travelAIApply) plans it again on the trip as it is at save time
 * and writes the plan through patchTrip with the trip's version. Pure.
 */
import { pricingDays } from "./adminDatePricing";
import { posterFareColumns } from "./poster/tripMapper";
import { deriveChildRules, withDerivedSummaryFields } from "./priceGroups";
import type { PriceGroup } from "./adminTypes";
import { applyFareChange, type FareChange, type FareIntent } from "./tripFareChange";
import { isInfantShapedAge } from "./travelFastPathsSearch";
import { planDatePrice, fareAmountOf, partnerSourceUrl, PARTNER_EDIT_REASON, shortDay } from "./tripDatePrice";
import { itineraryDayPatchOf, planItineraryDay } from "./tripItineraryDayEdit";
import { planPhotoEdit } from "./tripPhotoEdit";
import { TRIP_EDIT_VERBS, type AITripAction, type DepartureDateState, type TravelTrip, type TripEditVerb, type TripMutationFields } from "./travelTypes";

export { partnerSourceUrl, PARTNER_EDIT_REASON } from "./tripDatePrice";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const records = (value: unknown): Row[] => (Array.isArray(value) ? value.map(record) : []);
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export const DEPARTURE_DATE_STATES: DepartureDateState[] = ["open", "low", "full", "paused"];
export const DATE_STATE_WORDS: Record<DepartureDateState, string> = { open: "Нээлттэй", low: "Цөөн суудал", full: "Дүүрсэн", paused: "Түр хаасан" };
/** The website's raw departure status in the admin's words. */
export const WEBSITE_STATUS_WORDS: Record<string, string> = {
  OPEN: "Нээлттэй", ALMOST_FULL: "Цөөн суудал", SOLD_OUT: "Дүүрсэн", PAUSED: "Түр хаасан", CANCELLED: "Цуцлагдсан", DEPARTED: "Явсан",
};

export function isDepartureDateState(value: unknown): value is DepartureDateState {
  return typeof value === "string" && (DEPARTURE_DATE_STATES as string[]).includes(value);
}

export function isTripEditVerb(verb: string): verb is TripEditVerb {
  return (TRIP_EDIT_VERBS as readonly string[]).includes(verb);
}

/** Verbs a partner-synced trip refuses (the 30-minute sync would undo them). */
const PARTNER_REFUSED = new Set(["set_date_state", "set_date_price", "set_age_bands"]);
const PARTNER_FACT_FIELDS = ["adult_price", "child_price", "infant_price", "currency", "departure_dates", "seats_left", "seats_total"];
const PARTNER_FACT_EXTRA = ["price_groups", "departure_date_groups", "child_rules"];
/**
 * Everything else the partner run writes on every pass where it differs (partnerSync/tripPayload
 * buildTripFields, compared key by key in run.ts): the age bands, the description, the hotels,
 * what is included, the packages. A hand edit of any of them is undone within 30 minutes.
 */
const PARTNER_OWNED_FIELDS = ["duration_text", "hotel", "notes", "has_food"];
const PARTNER_OWNED_EXTRA = [
  "age_rules", "included_items", "excluded_items", "website_summary", "package_options", "departure_rule",
  "discounts", "discount_groups", "child_price_rules", "passenger_prices", "room_prices", "extra_fees", "recurring_schedule",
  "partner_departure_availability", "partner_sync",
];
/** The parts of a program day the partner owns; staff keep only the day's photo and meal note. */
const PARTNER_DAY_KEYS = ["title", "description", "hotel", "meals"];

export const PARTNER_OWNED_REASON = "хамтрагчийн сайтаас 30 минут тутам автоматаар шинэчлэгддэг тул насны ангилал, хөтөлбөрийн өдрийн нэр, тайлбар, буудал, хоол, аяллын тайлбар, багтсан зүйлсийг гараар засахгүй (дараагийн шинэчлэлт буцааж дарна). Өдрийн зураг, хоолны тэмдэглэл, нэр, сайтад харагдах эсэхийг засаж болно; бусдыг хамтрагч талдаа засуулна уу.";

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** True when `days` changes a part of a program day the partner owns (a photo or meal note alone does not). */
function changesPartnerDays(trip: TravelTrip, days: unknown): boolean {
  if (!Array.isArray(days)) return days !== undefined;
  const current = records(trip.extra?.itinerary_days);
  if (days.length !== current.length) return true;
  return records(days).some((day, index) => {
    const own = current.find((entry) => Number(entry.day) === Number(day.day)) ?? current[index] ?? {};
    return PARTNER_DAY_KEYS.some((key) => !sameJson(day[key], own[key]));
  });
}

/**
 * The Mongolian refusal when `fields` would write what a partner-synced trip's 30-minute run
 * owns, or null. Price and date facts get the price reason; the program, bands and texts the
 * program one.
 */
export function partnerOwnedFieldsProblem(trip: TravelTrip, fields: unknown): string | null {
  if (!partnerSourceUrl(trip)) return null;
  const columns = record(fields);
  const extra = record(columns.extra);
  if (PARTNER_FACT_FIELDS.some((key) => key in columns) || PARTNER_FACT_EXTRA.some((key) => key in extra)) return `«${trip.route_name}» ${PARTNER_EDIT_REASON}`;
  const owned = PARTNER_OWNED_FIELDS.some((key) => key in columns && !sameJson(columns[key], (trip as unknown as Row)[key]))
    || PARTNER_OWNED_EXTRA.some((key) => key in extra && !sameJson(extra[key], trip.extra?.[key]))
    || ("itinerary_days" in extra && changesPartnerDays(trip, extra.itinerary_days));
  return owned ? `«${trip.route_name}» ${PARTNER_OWNED_REASON}` : null;
}

/** The Mongolian refusal for a partner trip, or null when the action may touch it. */
export function partnerEditProblem(trip: TravelTrip, action: Pick<AITripAction, "action" | "fields"> & Partial<Pick<AITripAction, "title" | "description" | "hotel" | "meals">>): string | null {
  if (!partnerSourceUrl(trip)) return null;
  const verb = String(action.action || "").toLowerCase();
  if (verb === "set_date_state" || verb === "set_date_price") return `«${trip.route_name}» ${PARTNER_EDIT_REASON}`;
  if (PARTNER_REFUSED.has(verb)) return `«${trip.route_name}» ${PARTNER_OWNED_REASON}`;
  // A program day: only its meal note may change (the photo has its own verb).
  if (verb === "patch_itinerary_day") {
    const patch = itineraryDayPatchOf(action as Parameters<typeof itineraryDayPatchOf>[0]);
    return PARTNER_DAY_KEYS.some((key) => key in patch) ? `«${trip.route_name}» ${PARTNER_OWNED_REASON}` : null;
  }
  return verb === "patch" || verb === "upsert" ? partnerOwnedFieldsProblem(trip, action.fields) : null;
}

/** Today in Ulaanbaatar (UTC+8, no daylight saving), YYYY-MM-DD. */
export function ulaanbaatarToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

type WebsiteDay = { date: string; status: string; seatsLeft: number | null };
export function websiteDays(trip: TravelTrip): WebsiteDay[] {
  return records(trip.extra?.website_departure_availability).map((row) => ({
    date: text(row.date), status: text(row.status).toUpperCase(), seatsLeft: typeof row.seatsLeft === "number" ? row.seatsLeft : null,
  })).filter((row) => ISO.test(row.date));
}

/**
 * One departure day's website status as the trip read shows it: its live rows' statuses
 * ("SOLD_OUT", or "OPEN|SOLD_OUT" when its rows differ), "" when the day has none. A
 * set_date_state action carries the value seen when it was proposed (observed_status); apply
 * refuses it once the day shows something else — the admin's seat buttons change a day without
 * moving the trip's version.
 */
export function dateStatusOf(trip: TravelTrip, date: string): string {
  const live = websiteDays(trip).filter((row) => row.date === date && row.status !== "CANCELLED" && row.status !== "DEPARTED");
  return [...new Set(live.map((row) => row.status))].sort().join("|");
}

/** The trip's own departure days (ISO), from its frozen dates and its price rows. */
export function tripDepartureDays(trip: TravelTrip, now: Date = new Date()): string[] {
  const resolved = records(trip.extra?.departure_dates_resolved).map((entry) => text(entry.ymd));
  const plain = (trip.departure_dates || []).map((value) => String(value).slice(0, 10));
  const rows = records(trip.extra?.price_groups).flatMap((group) => pricingDays(group, now));
  return [...new Set([...resolved, ...plain, ...rows].filter((value) => ISO.test(value)))].sort();
}

/**
 * Why one departure day's state cannot be set, or null when it can (B8: a day the website does
 * not have yet used to be promised "it will apply once published" and then failed at save).
 * The agent calls this before proposing; validation and apply call it again.
 */
export function dateStateProblem(trip: TravelTrip, date: string, state: unknown, now: Date = new Date()): string | null {
  if (!ISO.test(String(date || ""))) return "Огноог YYYY-MM-DD хэлбэрээр заана уу.";
  if (!isDepartureDateState(state)) return "Огнооны төлөв: нээлттэй, цөөн суудал, дүүрсэн эсвэл түр хаасан гэсний нэг байна.";
  if (partnerSourceUrl(trip)) return `«${trip.route_name}» ${PARTNER_EDIT_REASON}`;
  const day = shortDay(date);
  if (date < ulaanbaatarToday(now)) return `${day} өнгөрсөн өдөр тул төлвийг нь өөрчлөхгүй.`;
  const rows = websiteDays(trip).filter((row) => row.date === date);
  if (!rows.length) {
    return tripDepartureDays(trip, now).includes(date)
      ? `«${trip.route_name}» аяллын ${day}-ны гаралт вэбсайтад хараахан нийтлэгдээгүй тул энэ өдрийн төлвийг одоо өөрчлөх боломжгүй. Аялал сайтад гарсны дараа дахин хэлнэ үү.`
      : `«${trip.route_name}» аялалд ${day}-нд гаралт алга.`;
  }
  if (rows.every((row) => row.status === "CANCELLED" || row.status === "DEPARTED")) {
    return `${day}-ны гаралт ${rows[0].status === "DEPARTED" ? "явсан" : "цуцлагдсан"} тул төлвийг нь өөрчлөхгүй.`;
  }
  return null;
}

// ─── visibility, age bands ──────────────────────────────────────────────────

export type TripEditPlan = {
  fields: TripMutationFields;
  poster?: Row;
  posterKeys: string[];
  lines: string[];
  warnings: string[];
  thumbs?: { before?: string; after?: string };
};
export type TripEditOutcome = { ok: true; plan: TripEditPlan } | { ok: false; reason: string };

export function planVisibility(trip: TravelTrip, visible: unknown): TripEditOutcome {
  if (typeof visible !== "boolean") return { ok: false, reason: "Харуулах эсвэл нуухыг заагаагүй байна." };
  const now = trip.extra?.customer_visible !== false;
  if (now === visible) return { ok: false, reason: visible ? "Сайт, ботод аль хэдийн харагдаж байна." : "Аль хэдийн нуусан байна." };
  return {
    ok: true,
    plan: { fields: { extra: { customer_visible: visible } }, posterKeys: [], warnings: [], lines: [visible ? "Сайт, ботод харуулна" : "Сайт, ботоос нууна (бичлэг, үнэ, зураг хадгалагдана)"] },
  };
}

type BandKind = "infant" | "child" | "adult";
const BAND_KINDS: BandKind[] = ["infant", "child", "adult"];
const BAND_WORDS: Record<BandKind, string> = { infant: "Нярай", child: "Хүүхэд", adult: "Том хүн" };

/** A band as the admin writes it: "0-23 сар", "2-11 нас", "12+ нас" — a number in it, at most 40 characters. */
export function ageBandOf(value: unknown): string | null | "bad" {
  if (value === undefined || value === null) return null;
  const band = text(value).replace(/\s+/g, " ");
  if (!band) return null;
  return band.length <= 40 && /\d/.test(band) ? band : "bad";
}

const kindOfTier = (tier: Row): BandKind => (isInfantShapedAge(text(tier.label).toLowerCase(), text(tier.age_range)) ? "infant" : "child");

export function planAgeBands(trip: TravelTrip, input: Partial<Record<BandKind, unknown>>, posterData: unknown | null): TripEditOutcome {
  const current: Record<BandKind, string> = { infant: "", child: "", adult: "", ...Object.fromEntries(Object.entries(record(trip.extra?.age_rules)).map(([key, value]) => [key, text(value)])) } as Record<BandKind, string>;
  const wanted: Partial<Record<BandKind, string>> = {};
  for (const kind of BAND_KINDS) {
    const band = ageBandOf(input[kind]);
    if (band === "bad") return { ok: false, reason: `${BAND_WORDS[kind]}ийн насны ангилал «${text(input[kind])}» ойлгомжгүй (жишээ нь «0-23 сар», «2-11 нас», «12+ нас»).` };
    if (band && band !== current[kind]) wanted[kind] = band;
  }
  if (!Object.keys(wanted).length) return { ok: false, reason: "Насны ангилал аль хэдийн ийм байна (эсвэл шинэ ангиллыг заагаагүй)." };
  const ageRules = { infant: current.infant, child: current.child, adult: current.adult, ...wanted };
  const lines = (Object.keys(wanted) as BandKind[]).map((kind) => `${BAND_WORDS[kind]}: ${current[kind] || "—"} → ${wanted[kind]}`);
  const warnings: string[] = [];

  // A tier still in the plain default form ("Хүүхэд" or "Хүүхэд 2-11 нас", aged as the old
  // band) follows the new band; a tier named some other way is the admin's and stays.
  const relabel = (tier: Row): Row => {
    const kind = kindOfTier(tier);
    const band = wanted[kind];
    if (!band) return tier;
    const old = current[kind];
    const word = BAND_WORDS[kind];
    const label = text(tier.label).replace(/\s+/g, " ");
    const age = text(tier.age_range);
    const plain = label.toLowerCase() === word.toLowerCase() || (old && label.toLowerCase() === `${word} ${old}`.toLowerCase());
    if (!plain || age !== old) return tier;
    return { ...tier, age_range: band, label: label.toLowerCase() === word.toLowerCase() ? word : `${word} ${band}` };
  };
  let groupsChanged = false;
  const groups = records(trip.extra?.price_groups).map((group) => {
    const tiers = records(group.passenger_prices);
    if (!tiers.length) return group;
    const next = tiers.map(relabel);
    if (JSON.stringify(next) === JSON.stringify(tiers)) return group;
    groupsChanged = true;
    return withDerivedSummaryFields({ ...group, passenger_prices: next } as unknown as PriceGroup) as unknown as Row;
  });
  const extra: Row = { age_rules: ageRules };
  if (groupsChanged) {
    extra.price_groups = groups;
    extra.child_rules = deriveChildRules(groups as unknown as PriceGroup[], { child: trip.child_price === 0, infant: trip.infant_price === 0 });
    lines.push("Үнийн мөрийн насны ангиллын нэр шинэчлэгдэнэ.");
  }

  // The poster's column headers ("Хүүхэд 2-11 нас") are where a Poster-tab save reads the bands
  // back from: a header holding the old band follows, or the next poster save would undo this.
  let poster: Row | undefined;
  const posterKeys: string[] = [];
  const table = record(record(posterData).price_table);
  const columns = (Array.isArray(table.columns) ? table.columns : []).map((column) => String(column ?? ""));
  if (posterData && columns.length) {
    const fare = posterFareColumns(columns);
    const ofKind: Record<BandKind, number[]> = {
      adult: fare.adult,
      child: fare.passengers.filter((entry) => !entry.infant).map((entry) => entry.index),
      infant: fare.passengers.filter((entry) => entry.infant).map((entry) => entry.index),
    };
    const nextColumns = [...columns];
    for (const kind of Object.keys(wanted) as BandKind[]) {
      const old = current[kind];
      const holding = ofKind[kind].filter((index) => old && columns[index].includes(old));
      if (holding.length === 1) nextColumns[holding[0]] = columns[holding[0]].replace(old, wanted[kind] as string);
      else if (ofKind[kind].some((index) => /\d/.test(columns[index]))) {
        warnings.push(`Постерын «${ofKind[kind].map((index) => columns[index]).join("», «")}» баганын нэрэнд насны ангилал бичигдсэн — Постер табаас хадгалахаас өмнө тэнд ${wanted[kind]} болгож засна уу, эс бөгөөс ангилал буцна.`);
      }
    }
    if (JSON.stringify(nextColumns) !== JSON.stringify(columns)) {
      poster = { ...record(posterData), price_table: { ...table, columns: nextColumns } };
      posterKeys.push("price_table");
    }
  }
  return { ok: true, plan: { fields: { extra }, ...(poster ? { poster } : {}), posterKeys, lines, warnings } };
}

// ─── one dispatcher ─────────────────────────────────────────────────────────

/**
 * The exact change one action makes to `trip` (and its poster, when one is given). Validation
 * passes no poster (the poster part is planned again at save time); a refusal is a Mongolian
 * sentence for the admin.
 */
export function planTripEdit(trip: TravelTrip, action: AITripAction, posterData: unknown | null, now: Date = new Date()): TripEditOutcome {
  const partner = partnerEditProblem(trip, action);
  if (partner) return { ok: false, reason: partner };
  const planned = planTripEditUnchecked(trip, action, posterData, now);
  // Whatever the verb, a plan that writes what the partner run owns is refused (it would be undone).
  const owned = planned.ok ? partnerOwnedFieldsProblem(trip, planned.plan.fields) : null;
  return owned ? { ok: false, reason: owned } : planned;
}

function planTripEditUnchecked(trip: TravelTrip, action: AITripAction, posterData: unknown | null, now: Date): TripEditOutcome {
  const verb = String(action.action || "").toLowerCase();
  if (verb === "set_date_price") {
    const planned = planDatePrice(trip, action, posterData, now);
    return planned.ok ? { ok: true, plan: planned.plan } : planned;
  }
  if (verb === "set_visibility") return planVisibility(trip, action.visible);
  if (verb === "patch_itinerary_day") return planItineraryDay(trip, action);
  if (verb === "set_age_bands") return planAgeBands(trip, { infant: action.infant, child: action.child, adult: action.adult }, posterData);
  if (verb === "replace_photo") {
    const planned = planPhotoEdit(trip, action, posterData);
    return planned.ok ? { ok: true, plan: planned.plan } : planned;
  }
  return { ok: false, reason: `«${verb}» гэсэн өөрчлөлтийг энд төлөвлөхгүй.` };
}

const KEEP = (keys: string[]) => (action: Row) => Object.fromEntries(keys.filter((key) => action[key] !== undefined).map((key) => [key, action[key]]));
const BASE_KEYS = ["action", "trip_id", "match", "expected_updated_at", "summary"];
const VERB_KEYS: Record<string, (action: Row) => Row> = {
  set_date_state: (action) => {
    const kept = KEEP([...BASE_KEYS, "date", "state"])(action);
    // Only the shape dateStatusOf writes ("OPEN", "OPEN|SOLD_OUT").
    if (typeof action.observed_status === "string" && /^[A-Z_]+(?:\|[A-Z_]+)*$/.test(action.observed_status.trim())) kept.observed_status = action.observed_status.trim();
    return kept;
  },
  set_date_price: (action) => {
    const kept = KEEP([...BASE_KEYS, "date"])(action);
    for (const kind of ["adult", "child", "infant", "single"]) {
      const amount = fareAmountOf(action[kind]);
      if (amount && amount !== "bad") kept[kind] = amount;
      else if (amount === "bad") kept[kind] = action[kind];
    }
    for (const key of ["band", "hotel", "package_id"]) if (text(action[key])) kept[key] = text(action[key]);
    return kept;
  },
  set_visibility: KEEP([...BASE_KEYS, "visible"]),
  patch_itinerary_day: (action) => ({ ...KEEP([...BASE_KEYS, "day"])(action), ...itineraryDayPatchOf(action) }),
  set_age_bands: (action) => {
    const kept = KEEP(BASE_KEYS)(action);
    for (const kind of BAND_KINDS) if (typeof action[kind] === "string" && text(action[kind])) kept[kind] = text(action[kind]);
    return kept;
  },
  replace_photo: (action) => {
    const kept = KEEP(BASE_KEYS)(action);
    if (text(action.old_url)) kept.old_url = text(action.old_url);
    for (const key of ["position", "day"]) if (typeof action[key] === "number" && Number.isFinite(action[key])) kept[key] = Math.trunc(action[key] as number);
    if (action.remove === true) kept.remove = true;
    else if (text(action.new_url)) kept.new_url = text(action.new_url);
    return kept;
  },
};

/** Only the keys a verb reads, cleaned (a model's extra keys never reach apply or the stored proposal). */
export function sanitizeTripEditAction(action: AITripAction): AITripAction {
  const verb = String(action.action || "").toLowerCase();
  const keep = VERB_KEYS[verb];
  const kept = keep ? keep({ ...(action as unknown as Row), action: verb }) : { ...(action as unknown as Row) };
  if (typeof kept.trip_id === "string") kept.trip_id = kept.trip_id.trim();
  if (typeof kept.date === "string") kept.date = kept.date.trim();
  return kept as unknown as AITripAction;
}

// ─── a fare rule over many trips ────────────────────────────────────────────

export type FareChangeAllSkip = { trip_id: string; route_name: string; reason: string };
export type FareChangeAllExpansion = { actions: AITripAction[]; skipped: FareChangeAllSkip[]; notes: string[] };

function fareIntentOf(value: unknown): FareIntent | null | "bad" {
  if (value === undefined || value === null) return null;
  const row = record(value);
  const pick = (key: string) => (typeof row[key] === "number" && Number.isFinite(row[key]) ? Math.round(row[key] as number) : undefined);
  const intent: FareIntent = { set: pick("set"), delta: pick("delta"), belowAdult: pick("belowAdult") ?? pick("below_adult") };
  const given = Object.values(intent).filter((entry) => entry !== undefined) as number[];
  if (given.length !== 1 || (intent.set ?? 0) < 0 || (intent.belowAdult ?? 0) < 0 || Math.abs(given[0]) > 200_000_000) return "bad";
  return Object.fromEntries(Object.entries(intent).filter(([, entry]) => entry !== undefined)) as FareIntent;
}

/** The change as applyFareChange takes it, or null when it is not one. */
export function fareChangeOf(value: unknown): FareChange | null {
  const raw = record(value);
  const change: FareChange = {};
  for (const kind of ["adult", "child", "infant"] as const) {
    const intent = fareIntentOf(raw[kind]);
    if (intent === "bad") return null;
    if (intent) change[kind] = intent;
  }
  if (typeof raw.everyone === "number" && Number.isFinite(raw.everyone) && raw.everyone !== 0 && Math.abs(raw.everyone) <= 200_000_000) change.everyone = Math.round(raw.everyone);
  return Object.keys(change).length ? change : null;
}

/**
 * "Бүх аяллын үнийг 100 мянгаар нэм": one patch per trip (each with that trip's version and the
 * same writer the brain uses, applyFareChange), and every trip left out with its reason —
 * partner trips, non-tugrik trips, trips missing a fare the rule needs, trips already so.
 * `filter.trip_ids` names the trips; `filter.all_active` takes every active trip.
 */
export function expandFareChangeAll(trips: TravelTrip[], change: FareChange, filter: { trip_ids?: string[]; all_active?: boolean } = {}): FareChangeAllExpansion {
  const ids = (filter.trip_ids || []).map((id) => String(id || "").trim()).filter(Boolean);
  const pool = ids.length ? ids.map((id) => trips.find((trip) => trip.id === id)).filter((trip): trip is TravelTrip => Boolean(trip))
    : filter.all_active ? trips.filter((trip) => trip.status === "active") : [];
  const actions: AITripAction[] = [];
  const skipped: FareChangeAllSkip[] = [];
  const notes: string[] = [];
  for (const id of ids.filter((entry) => !trips.some((trip) => trip.id === entry))) skipped.push({ trip_id: id, route_name: id, reason: "аялал бүртгэлд алга" });
  for (const trip of pool) {
    const skip = (reason: string) => skipped.push({ trip_id: trip.id, route_name: trip.route_name, reason });
    if (partnerSourceUrl(trip)) { skip(PARTNER_EDIT_REASON); continue; }
    if ((trip.currency || "MNT").toUpperCase() !== "MNT") { skip(`үнэ ${trip.currency}-ээр бичигдсэн; зарах үнэ зөвхөн төгрөгөөр`); continue; }
    const result = applyFareChange(trip, change);
    if (result.missing.length) { skip("өөрчлөхөд шаардлагатай үнэ бүртгэлгүй"); continue; }
    if (!result.changed) { skip("өөрчлөгдөх үнэ алга"); continue; }
    actions.push({
      action: "patch", trip_id: trip.id, expected_updated_at: trip.updated_at,
      summary: `«${trip.route_name}» — ${result.lines.join(", ")}`, fields: result.fields,
    });
    notes.push(...result.notes.map((note) => `«${trip.route_name}»: ${note}`));
  }
  return { actions, skipped, notes };
}
