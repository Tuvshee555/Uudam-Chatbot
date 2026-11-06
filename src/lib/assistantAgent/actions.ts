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
 *    dateStateProblem, planDatePrice, planTripEdit, expandFareChangeAll), so the card never
 *    promises what save would refuse (B8), and its summary line is the card's own text;
 *  - every action carries trip_id, the trip version (expected_updated_at) and a short
 *    Mongolian summary; a change that is already so is not proposed.
 */
import { fareWarnings } from "../assistantBrain";
import { describeChange } from "../assistantActionText";
import { dateStateProblem, dateStatusOf, expandFareChangeAll, fareChangeOf, partnerEditProblem, planTripEdit, sanitizeTripEditAction, tripDepartureDays } from "../tripActionPlan";
import { PARTNER_EDIT_REASON, partnerSourceUrl } from "../tripDatePrice";
import { isHostedPhotoUrl } from "../tripPhotoEdit";
import { addDepartureDates, removeDepartureDates } from "../tripScheduleChange";
import type { AIChangeProposal, AITripAction, ConflictItem, TravelTrip, TripMutationFields } from "../travelTypes";
import { tripDepartures } from "./readTools";

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
};

/** A stored action: the travelTypes contract, built as a plain record so new verbs need no cast at each site. */
type StoredAction = Row & { action: string; trip_id: string; summary: string; expected_updated_at?: string };

const PARTNER_VERBS = new Set(["set_date_state", "set_date_price", "change_dates"]);
const PLANNED_VERBS = new Set(["set_date_price", "set_visibility", "patch_itinerary_day", "set_age_bands", "replace_photo"]);
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

function itineraryDayAction(raw: Row, trip: TravelTrip, ctx: ProposalContext): StoredAction {
  const action: StoredAction = { ...base("patch_itinerary_day", trip, ctx), day: raw.day };
  for (const key of ["title", "description", "hotel", "meal_note"]) if (typeof raw[key] === "string" && text(raw[key])) action[key] = text(raw[key]);
  const meals = record(raw.meals);
  const mealPatch: Row = {};
  for (const key of ["breakfast", "lunch", "dinner"]) if (key in meals && (meals[key] === true || meals[key] === false || meals[key] === null)) mealPatch[key] = meals[key];
  if (Object.keys(mealPatch).length) action.meals = mealPatch;
  return action;
}

function ageBandsAction(raw: Row, trip: TravelTrip, ctx: ProposalContext): StoredAction {
  const bands = record(raw.bands);
  const action: StoredAction = base("set_age_bands", trip, ctx);
  for (const key of ["infant", "child", "adult"]) if (text(bands[key] ?? raw[key])) action[key] = text(bands[key] ?? raw[key]);
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
  };
}

/** One part of one trip (price of a date, visibility, a program day, age bands, a photo), planned exactly as save will. */
function buildPlanned(verb: string, raw: Row, trip: TravelTrip, ctx: ProposalContext): Built {
  let action: StoredAction | string;
  if (verb === "set_date_price") action = datePriceAction(raw, trip, ctx);
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

/**
 * Why a trip may not be edited in this turn, or null: it must be a real trip, the one a pasted
 * link names (when there is one), seen in this turn and opened with get_trip. `fixable` when one
 * more look (search_trips, get_trip) could make it right.
 */
function targetProblem(trip: TravelTrip | undefined, verb: string, ctx: ProposalContext): { reason: string; fixable: boolean } | null {
  if (!trip) return { reason: `${verb || "өөрчлөлт"}: аялал тодорхойгүй — алгаслаа`, fixable: true };
  const name = `«${trip.route_name}»`;
  if (ctx.linkTrips.size && !ctx.linkTrips.has(trip.id)) return { reason: `${name}: таны илгээсэн холбоосын аялал биш тул хөндөхгүй`, fixable: false };
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
  const add = (Array.isArray(raw.add_dates) ? raw.add_dates : []).map(text).filter((date) => ISO.test(date));
  const remove = (Array.isArray(raw.remove_dates) ? raw.remove_dates : []).map(text).filter((date) => ISO.test(date));
  if (!add.length && !remove.length) return { refuse: "нэмэх, хасах огноо тодорхойгүй" };
  const fields: TripMutationFields = {};
  const parts: string[] = [];
  const notes: string[] = [];
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
  const items = Array.isArray(rawActions) ? rawActions.map(record) : [];
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
  // A day's state is written on the website and leaves the trip's version as it was; saved first,
  // it never makes a later edit of the same trip look "changed since the proposal".
  actions.sort((a, b) => Number(b.action === "set_date_state") - Number(a.action === "set_date_state"));
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
