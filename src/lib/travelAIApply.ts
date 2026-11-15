/**
 * Applying and rolling back a reviewed AI proposal. Split from travelAI.ts,
 * which had grown past the 2,000-line cap.
 *
 * Every write carries the trip's version: the action's expected_updated_at (the version the
 * proposal was built on) or, when an older proposal has none, the version read just before the
 * write. A trip edited in between is refused, never overwritten. Rollback puts back only the
 * fields the action wrote (recorded at apply time), behind the version the action left — an
 * edit made after the AI change is never rolled over. A departure day's state is rolled back
 * from the raw website rows recorded at apply (PAUSED included), only while those rows still
 * hold what the change left.
 *
 * Several actions on one trip in one proposal all carry the version the proposal saw; each later
 * one is checked against the version the previous action of this same save left (runActions), and
 * rolling them back newest first does the same in reverse (rollbackSnapshots). An archive, a
 * cancel or a status change records every website departure row of the trip: undoing it
 * re-activates the trip, which reopens every closed date in the website projection, so each date
 * is then put back to what it was before the change (unless someone changed it in between).
 */
import { logError, logWarn } from "./observability";
import { queryNeon } from "./neonDb";
import type { AIChangeProposal, AITripAction, DateSeatState, DepartureDateState, TravelTrip, TripMutationFields } from "./travelTypes";
import { ensureTravelSchema, listTrips, getTripById, upsertTrip, patchTrip, resolveTripIdByMatch, mapTripRow, normalizeProposal, isDateSeatState, sanitizeTripScheduleForCurrentDate } from "./travelDb";
import { instructionForbidsTripCreation, validateAIChangeProposal } from "./travelAIValidation";
import { attachPersistedPhotoSources, changeRequestId } from "./travelAI";
import { PUBLISH_PRICE_TEXT, publishPriceGap, withoutReviewOnly } from "./tripReview";
import { validateTripDataChange } from "./tripDataValidation";
import { DATE_STATE_WORDS, WEBSITE_STATUS_WORDS, dateStateProblem, dateStatusOf, isDepartureDateState, isTripEditVerb, partnerSourceUrl, planTripEdit, ulaanbaatarToday } from "./tripActionPlan";
import { MAX_TRIP_PHOTOS } from "./tripPhotoEdit";
import { mismatchedRowsText, syncPosterPriceTable } from "./poster/priceTableWrite";
import { pricingDays } from "./adminDatePricing";
import { normalizeExtra } from "./tripExtraSchema";
import { shortDay } from "./tripDatePrice";
import type { PosterWrite } from "./connectedTripStore";
import type { DepartureRowState, DepartureStateChange, DepartureStateRow } from "./websiteTripSync";
import { savedTripLinks, type SavedTripInput, type SavedTripLink } from "./savedTripLinks";
import { newWebsiteTripSlug } from "./websiteTripSlug";
import { unacknowledgedDamage } from "./tripDamage";

/** The first line of a save refused for unticked damage (tripDamage.ts); one line per trip follows. */
export const DAMAGE_REFUSED = "Энэ өөрчлөлт хадгалагдсан аяллыг эвдэнэ. Карт дээрх улаан хэсгийг уншаад, үнэхээр хүсвэл тэмдэглээд дахин хадгална уу.";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const records = (value: unknown): Row[] => (Array.isArray(value) ? value.map(record) : []);
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

// ─── what apply and rollback touch (replaced in tests) ──────────────────────

type PosterRow = { id: string; title: string; source_file?: string | null; data: unknown };
export type AIApplyDeps = {
  getTripById: (id: string) => Promise<TravelTrip | null>;
  patchTrip: (id: string, fields: TripMutationFields, syncPoster: boolean, posterWrite: PosterWrite | undefined, expectedUpdatedAt: string | undefined) => Promise<TravelTrip | null>;
  upsertTrip: (input: { id?: string; fields: TripMutationFields }) => Promise<TravelTrip | null>;
  resolveTripIdByMatch: (match: AITripAction["match"]) => Promise<{ id?: string | null; conflict?: string | null }>;
  getPoster: (id: string) => Promise<PosterRow | null>;
  changeDepartureState: (tripId: string, date: string, state: DepartureDateState) => Promise<DepartureStateChange>;
  restoreDepartureRows: (rows: DepartureStateRow[]) => Promise<{ restored: number; changedSince: string[] }>;
  /** Only for rolling back a snapshot saved before raw rows were recorded. */
  setDepartureSeatState: (tripId: string, date: string, state: DateSeatState) => Promise<boolean>;
  /** Every website departure row of the trip, raw; throws when the website is not connected. */
  readDepartureRows: (tripId: string) => Promise<{ slug: string | null; rows: DepartureRowState[] }>;
  /** True while the trip's latest save has not reached the website (its projection is queued). */
  websiteSyncPending: (tripId: string) => Promise<boolean>;
  notifyWebsite: (slugs: string[]) => Promise<void>;
  /** The website slug the sync stored for each trip, and whether a later save is still on its way. */
  readWebsiteSlugs: (tripIds: string[]) => Promise<Record<string, { slug: string | null; pending: boolean }>>;
  now: () => Date;
};

const defaultDeps: AIApplyDeps = {
  getTripById,
  patchTrip: (id, fields, syncPoster, posterWrite, expected) => patchTrip(id, fields, syncPoster, posterWrite, expected),
  upsertTrip: (input) => upsertTrip(input),
  resolveTripIdByMatch: (match) => resolveTripIdByMatch(match),
  getPoster: async (id) => (await import("./poster/db")).getPosterTrip(id),
  changeDepartureState: async (tripId, date, state) => (await import("./websiteTripSync")).changeDepartureState(tripId, date, state),
  restoreDepartureRows: async (rows) => (await import("./websiteTripSync")).restoreDepartureRows(rows),
  setDepartureSeatState: async (tripId, date, state) => (await import("./websiteTripSync")).setDepartureSeatState(tripId, date, state),
  readDepartureRows: async (tripId) => (await import("./websiteTripSync")).readDepartureRows(tripId),
  websiteSyncPending: async (tripId) => (await import("./websiteTripSync")).websiteSyncPending(tripId),
  notifyWebsite: async (slugs) => (await import("./websiteTripSync")).notifyWebsiteTripsChanged(slugs),
  readWebsiteSlugs: async (tripIds) => (await import("./websiteTripSync")).websiteSlugsFor(tripIds),
  now: () => new Date(),
};
let deps: AIApplyDeps = defaultDeps;

/** Tests replace the database and website edges; null puts the real ones back. */
export function setAIApplyDepsForTests(overrides: Partial<AIApplyDeps> | null): void {
  deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
}

/**
 * What would stop each new trip from being saved, found before anything is
 * written. A proposal with several trips used to save the first ones and fail
 * on a later one, and saving again then created the first ones twice.
 */
export function newTripSaveProblems(proposal: AIChangeProposal): string[] {
  const problems: string[] = [];
  for (const action of proposal.actions) {
    // After validation every upsert without a trip id is a create (a matched one was turned into a patch).
    if (String(action.action || "").toLowerCase() !== "upsert" || action.trip_id?.trim() || !action.fields) continue;
    const fields = withoutReviewOnly(action.fields as Record<string, unknown>);
    const name = String(fields.route_name || "").trim();
    for (const issue of validateTripDataChange(fields).introducedErrors) problems.push(name ? `«${name}»: ${issue.message}` : issue.message);
    // Owner's rule (2026-11-06): published only with the adult and the child fare; a draft may wait.
    // Checked here too, so no page or script can publish a new trip without them.
    if (publishesNewTrip(fields)) {
      const gap = publishPriceGap(fields, deps.now());
      if (gap.adult || gap.child) problems.push(name ? `«${name}»: ${PUBLISH_PRICE_TEXT}` : PUBLISH_PRICE_TEXT);
    }
  }
  return problems;
}

/** A new trip saved visible (no or an unknown status is saved as active: travelDb coerceTripStatus); a draft, archived or cancelled one is not. */
function publishesNewTrip(fields: Row): boolean {
  return !["draft", "archived", "cancelled"].includes(text(fields.status).toLowerCase());
}

type ActionResult = { ok: boolean; message: string; snapshot?: AIActionSnapshot };

/** One action applied; a thrown save error becomes a failed result instead of a 500 with half the proposal saved. */
async function applyActionSafely(action: AITripAction): Promise<ActionResult> {
  try {
    return await applyAIAction(action);
  } catch (error) {
    logError("travel.ai.apply_action_failed", { message: error instanceof Error ? error.message : String(error) });
    return { ok: false as const, message: error instanceof Error ? error.message : "Хадгалахад алдаа гарлаа.", snapshot: undefined };
  }
}

/** The values one action replaced, keyed as patchTrip takes them: only these are put back on rollback. */
type FieldRestore = { columns: Row; extra: Row };

export type AIActionSnapshot = {
  action: AITripAction;
  trip_id: string;
  before: TravelTrip | null;
  after: TravelTrip | null;
  /** Legacy (before 2026-11-06): the day's state as the overlay read it. */
  date_state_before?: DateSeatState | null;
  /**
   * set_date_state: every website row the change wrote, with its raw earlier and later status.
   * delete / cancel / a status patch: every website row of the trip before and after the write.
   */
  departure_rows?: DepartureStateRow[];
  website_slug?: string | null;
  restore?: FieldRestore;
  /** The trip version the action left; rollback is refused once the trip moved on from it. */
  version_after?: string;
  /** The poster keys the action rewrote, with their earlier values. */
  poster_restore?: { id: string; keys: string[]; values: Row };
  /** An upsert that created the trip: rollback archives it. */
  created?: boolean;
};

function sameVersion(a: string | undefined | null, b: string | undefined | null): boolean {
  const left = new Date(String(a || "")).getTime();
  const right = new Date(String(b || "")).getTime();
  return Number.isFinite(left) && Number.isFinite(right) && left === right;
}

/**
 * True when the trip was edited after the proposal was built (its updated_at moved). The
 * change is then refused instead of overwriting the other edit; the admin re-sends the
 * instruction and gets a proposal built on the current trip.
 */
function changedSinceProposal(before: TravelTrip | null, action: AITripAction): boolean {
  if (!before || !action.expected_updated_at) return false;
  return !sameVersion(action.expected_updated_at, before.updated_at);
}

function changedSinceMessage(before: TravelTrip | null): string {
  return `«${before?.route_name || "Аялал"}» энэ саналыг гаргаснаас хойш өөрчлөгдсөн байна (өөр админ эсвэл сайт). Зааврыг дахин бичвэл одоогийн байдлаар нь шинэ санал гаргана.`;
}

function changedSinceRollbackMessage(trip: TravelTrip | null): string {
  return `«${trip?.route_name || "Аялал"}» энэ өөрчлөлтөөс хойш дахин засагдсан тул буцаасангүй — сүүлийн засварыг дарахгүйн тулд. Буцаах зүйлээ «Аяллууд» хэсгээс гараар засна уу.`;
}

/** Keys the read path lays over a trip (from the website) or that are commands, never stored values. */
const NOT_RESTORED_EXTRA = new Set(["website_departure_availability", "website_slug", "website_published", "website_details", "website_details_patch"]);

function restoreFor(before: TravelTrip, written: TripMutationFields): FieldRestore {
  const columns: Row = {};
  const extra: Row = {};
  for (const key of Object.keys(written)) {
    if (key === "extra") continue;
    columns[key] = (before as unknown as Row)[key] ?? null;
  }
  for (const key of Object.keys(record(written.extra))) {
    if (NOT_RESTORED_EXTRA.has(key)) continue;
    extra[key] = key in before.extra ? before.extra[key] : null;
  }
  return { columns, extra };
}

function fieldsWithMergedPhotoUrls(
  fields: AITripAction["fields"] | undefined,
  before: TravelTrip | null,
): AITripAction["fields"] {
  const next = { ...(fields || {}) };
  if (!Array.isArray(next.photo_urls) || next.photo_urls.length === 0) return next;
  const existing = Array.isArray(before?.photo_urls) ? before.photo_urls : [];
  next.photo_urls = Array.from(
    new Set(
      [...existing, ...next.photo_urls]
        .filter((url): url is string => typeof url === "string")
        .map((url) => url.trim())
        .filter((url) => url.startsWith("https://")),
    ),
  ).slice(0, MAX_TRIP_PHOTOS);
  return next;
}

/**
 * A fare patch rewrites the trip's price rows; the poster's price table must follow in the
 * same write or the next Poster-tab save puts the old fares back (operations.md §2).
 */
async function posterFareFollow(trip: TravelTrip, fields: TripMutationFields): Promise<{ write?: PosterWrite; restore?: AIActionSnapshot["poster_restore"]; warning?: string }> {
  const groups = record(fields.extra).price_groups;
  const posterId = text(trip.extra?.poster_trip_id);
  if (!Array.isArray(groups) || !posterId) return {};
  const poster = await deps.getPoster(posterId);
  if (!poster) return {};
  const now = deps.now();
  const sync = syncPosterPriceTable(poster.data, records(groups), record(trip.extra), now);
  if (sync.problem) return { warning: `Постерын үнийн хүснэгт шинэчлэгдсэнгүй (${sync.problem}) — Постер табаас хадгалахаас өмнө хүснэгтийг шалгана уу.` };
  // A changed date no poster row follows comes back with its old fare on the next poster save.
  const hasRows = records(record(record(poster.data).price_table).rows).length > 0;
  const today = ulaanbaatarToday(now);
  const missed = hasRows
    ? changedFareDates(records(trip.extra?.price_groups), records(groups), now).filter((date) => date >= today && !sync.coveredDates.includes(date))
    : [];
  const warning = missed.length
    ? `Постерын үнийн хүснэгт ${missed.slice(0, 6).map(shortDay).join(", ")}${missed.length > 6 ? "…" : ""}-ны шинэ үнийг дагасангүй (${sync.mismatched?.length ? mismatchedRowsText(sync.mismatched) : "постерт тэр огнооны мөр алга"}) — Постер табаас хадгалбал хуучин үнэ буцна. Постерын хүснэгтийг тэнд гараар засна уу.`
    : undefined;
  if (!sync.table) return warning ? { warning } : {};
  return {
    write: { id: poster.id, title: poster.title, data: { ...record(poster.data), price_table: sync.table }, source_file: poster.source_file ?? null, note: "AI туслах: үнэ" },
    restore: { id: poster.id, keys: ["price_table"], values: { price_table: record(poster.data).price_table ?? null } },
    ...(warning ? { warning } : {}),
  };
}

const NOT_A_FARE = new Set(["label", "dates", "display_dates", "date_keys", "note"]);

/** The departure days whose fare rows differ between two price-row lists (both read as a save stores them). */
function changedFareDates(before: Row[], after: Row[], now: Date): string[] {
  const stored = (groups: Row[]) => records(normalizeExtra({ price_groups: groups }).extra.price_groups);
  const was = stored(before);
  const next = stored(after);
  const fares = (groups: Row[], date: string) => JSON.stringify(groups.filter((group) => pricingDays(group, now).includes(date))
    .map((group) => Object.fromEntries(Object.entries(group).filter(([key]) => !NOT_A_FARE.has(key)))));
  const days = new Set([...was, ...next].flatMap((group) => pricingDays(group, now)));
  return [...days].filter((date) => fares(was, date) !== fares(next, date)).sort();
}

/** patchTrip behind a version; a moved version comes back as the Mongolian "changed since" message. */
async function versionedPatch(id: string, fields: TripMutationFields, before: TravelTrip, expected: string | undefined, posterWrite?: PosterWrite): Promise<{ ok: true; trip: TravelTrip } | { ok: false; message: string }> {
  try {
    const trip = await deps.patchTrip(id, fields, true, posterWrite, expected || before.updated_at || undefined);
    return trip ? { ok: true, trip } : { ok: false, message: "Аяллыг хадгалж чадсангүй." };
  } catch (error) {
    if (error instanceof Error && error.message === "trip_edit_conflict") return { ok: false, message: changedSinceMessage(before) };
    throw error;
  }
}

// ─── a trip-level status change and the website's departure rows ────────────

/** True when the write moves the trip's status (archive, cancel, pause, sold out, publish). */
function movesStatus(before: TravelTrip, fields: TripMutationFields): boolean {
  return typeof fields.status === "string" && fields.status.trim() !== "" && fields.status.trim() !== before.status;
}

type WebsiteRows = { slug: string | null; rows: DepartureRowState[] };

/** The trip's raw website rows, or null when the website cannot be read (not connected, down). */
async function websiteRows(tripId: string): Promise<WebsiteRows | null> {
  try {
    return await deps.readDepartureRows(tripId);
  } catch {
    return null;
  }
}

/**
 * The rows a status write is about to rewrite: a non-active trip's projection closes every date
 * (PAUSED, CANCELLED or SOLD_OUT, with the trip's own seat count), and re-activating it reopens
 * them all, so its rollback needs each row's own earlier state. A partner trip's dates follow the
 * partner on every projection and are not recorded.
 */
async function rowsBeforeStatusWrite(before: TravelTrip, fields: TripMutationFields): Promise<WebsiteRows | null> {
  if (!movesStatus(before, fields) || partnerSourceUrl(before)) return null;
  const read = await websiteRows(before.id);
  return read?.rows.length ? read : null;
}

/** Each recorded row with what the write left on it (rows gone since are dropped). */
async function rowsAfterStatusWrite(tripId: string, earlier: WebsiteRows | null): Promise<Partial<AIActionSnapshot>> {
  if (!earlier) return {};
  const later = await websiteRows(tripId);
  if (!later) return {};
  const now = new Map(later.rows.map((row) => [row.id, row]));
  const rows: DepartureStateRow[] = earlier.rows.flatMap((row) => {
    const after = now.get(row.id);
    return after ? [{ id: row.id, date: row.date, status: row.status, seatsLeft: row.seatsLeft, after_status: after.status, after_seats_left: after.seatsLeft }] : [];
  });
  return rows.length ? { departure_rows: rows, website_slug: later.slug || earlier.slug } : {};
}

function snapshotOf(action: AITripAction, before: TravelTrip, after: TravelTrip, written: TripMutationFields, extra: Partial<AIActionSnapshot> = {}): AIActionSnapshot {
  return { action, trip_id: after.id, before, after, restore: restoreFor(before, written), version_after: after.updated_at, ...extra };
}

async function applyDateState(action: AITripAction, targetId: string): Promise<ActionResult> {
  const date = String(action.date || "").trim();
  const state = action.state;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isDepartureDateState(state)) {
    return { ok: false, message: "Огноо эсвэл төлөв буруу байна." };
  }
  const before = await deps.getTripById(targetId);
  if (!before) return { ok: false, message: "Target trip not found." };
  if (changedSinceProposal(before, action)) return { ok: false, message: changedSinceMessage(before) };
  const problem = dateStateProblem(before, date, state, deps.now());
  if (problem) return { ok: false, message: problem };
  // A seat button changes a day on the website without moving the trip's version: the day must
  // still show what the proposal saw, or that later change would be overwritten.
  const observed = text(action.observed_status);
  const showing = dateStatusOf(before, date);
  if (observed && showing !== observed) {
    const words = (value: string) => value.split("|").map((status) => WEBSITE_STATUS_WORDS[status] || status).join(" / ");
    return { ok: false, message: `«${before.route_name}» аяллын ${shortDay(date)}-ны төлөв энэ саналыг гаргаснаас хойш өөрчлөгдсөн байна (${words(observed)} → ${words(showing) || "—"}). Зааврыг дахин бичвэл одоогийн байдлаар нь шинэ санал гаргана.` };
  }
  let change: DepartureStateChange;
  try {
    change = await deps.changeDepartureState(targetId, date, state);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: /not configured/i.test(message)
      ? "Вэбсайтын өгөгдлийн сан холбогдоогүй тул огнооны төлвийг өөрчилж чадсангүй."
      : `Огнооны төлвийг өөрчилж чадсангүй: ${message}` };
  }
  if (!change.rows.length) {
    return { ok: false, message: `"${before.route_name}" аялалд ${date} гарах өдөр вэбсайтад олдсонгүй.` };
  }
  const slug = change.slug || text(before.extra?.website_slug) || null;
  // The trip page is cached for a day; its static parts would show the old state until then.
  if (slug) await deps.notifyWebsite([slug]).catch(() => undefined);
  const was = WEBSITE_STATUS_WORDS[change.rows[0].status] || change.rows[0].status;
  return {
    ok: true,
    message: `"${before.route_name}" — ${date}: ${was} → ${DATE_STATE_WORDS[state]}`,
    snapshot: { action, trip_id: targetId, before: null, after: null, departure_rows: change.rows, website_slug: slug },
  };
}

async function applyTripEdit(action: AITripAction, targetId: string): Promise<ActionResult> {
  const before = await deps.getTripById(targetId);
  if (!before) return { ok: false, message: "Target trip not found." };
  if (changedSinceProposal(before, action)) return { ok: false, message: changedSinceMessage(before) };
  const verb = String(action.action || "").toLowerCase();
  const posterId = text(before.extra?.poster_trip_id);
  const needsPoster = verb === "set_date_price" || verb === "replace_photo" || verb === "set_age_bands";
  const poster = needsPoster && posterId ? await deps.getPoster(posterId) : null;
  const planned = planTripEdit(before, action, poster?.data ?? null, deps.now());
  if (!planned.ok) return { ok: false, message: planned.reason.includes(before.route_name) ? planned.reason : `«${before.route_name}»: ${planned.reason}` };
  const { plan } = planned;
  const posterWrite: PosterWrite | undefined = plan.poster && poster
    ? { id: poster.id, title: poster.title, data: plan.poster, source_file: poster.source_file ?? null, note: `AI туслах: ${text(action.summary) || verb}`.slice(0, 300) }
    : undefined;
  const saved = await versionedPatch(targetId, plan.fields, before, action.expected_updated_at, posterWrite);
  if (!saved.ok) return { ok: false, message: saved.message };
  const posterRestore = posterWrite && poster
    ? { id: poster.id, keys: plan.posterKeys, values: Object.fromEntries(plan.posterKeys.map((key) => [key, record(poster.data)[key] ?? null])) }
    : undefined;
  const notes = plan.warnings.length ? ` (${plan.warnings.join(" ")})` : "";
  return {
    ok: true,
    message: `"${saved.trip.route_name}": ${plan.lines.join("; ")}${notes}`,
    snapshot: snapshotOf(action, before, saved.trip, plan.fields, posterRestore ? { poster_restore: posterRestore } : {}),
  };
}

/** Applies one validated action. Exported for the apply/rollback tests. */
export async function applyAIAction(input: AITripAction): Promise<ActionResult> {
  if (!input || typeof input !== "object") {
    return { ok: false, message: "Invalid action payload." };
  }
  // The review's own evidence (source quotes, the date beside each program day) is never saved.
  const action: AITripAction = input.fields ? { ...input, fields: withoutReviewOnly(input.fields as Record<string, unknown>) as AITripAction["fields"] } : input;

  const verb = String(action.action || "").trim().toLowerCase();
  if (!verb) return { ok: false, message: "Missing action verb." };

  if (verb === "upsert") {
    let targetId = action.trip_id?.trim() || "";
    if (!targetId && action.match) {
      const match = await deps.resolveTripIdByMatch(action.match);
      if (
        match.conflict &&
        !/matching trip not found|таарах аялал олдсонгүй/i.test(match.conflict)
      ) {
        return { ok: false, message: match.conflict };
      }
      targetId = match.id || "";
    }
    const before = targetId ? await deps.getTripById(targetId) : null;
    if (before) {
      // An upsert onto an existing trip is a patch, behind the trip's version like every patch.
      if (changedSinceProposal(before, action)) return { ok: false, message: changedSinceMessage(before) };
      const fields = fieldsWithMergedPhotoUrls(action.fields, before) || {};
      const watched = await rowsBeforeStatusWrite(before, fields);
      const saved = await versionedPatch(targetId, fields, before, action.expected_updated_at);
      if (!saved.ok) return { ok: false, message: saved.message };
      return {
        ok: true,
        message: `Шинэчилсэн: "${saved.trip.route_name}"`,
        snapshot: snapshotOf({ ...action, action: "patch" }, before, saved.trip, fields, await rowsAfterStatusWrite(targetId, watched)),
      };
    }
    const updated = await deps.upsertTrip({
      id: targetId || undefined,
      fields: action.fields || {},
    });
    if (!updated) return { ok: false, message: "Upsert failed." };
    return {
      ok: true,
      message: `Нэмсэн: "${updated.route_name}"`,
      snapshot: { action, trip_id: updated.id, before: null, after: updated, created: true, version_after: updated.updated_at },
    };
  }

  let targetId = action.trip_id?.trim() || "";
  if (!targetId) {
    const match = await deps.resolveTripIdByMatch(action.match);
    if (match.conflict) return { ok: false, message: match.conflict };
    targetId = match.id || "";
  }
  if (!targetId) return { ok: false, message: "Target trip not found." };

  if (verb === "set_date_state") return applyDateState(action, targetId);
  if (isTripEditVerb(verb)) return applyTripEdit(action, targetId);

  if (verb === "delete" || verb === "cancel" || verb === "patch") {
    const before = await deps.getTripById(targetId);
    if (!before) return { ok: false, message: "Target trip not found." };
    if (changedSinceProposal(before, action)) return { ok: false, message: changedSinceMessage(before) };
    // delete archives: hidden from the website and the bot, the record and its history kept.
    const fields: TripMutationFields = verb === "delete"
      ? { status: "archived", extra: { customer_visible: false } }
      : verb === "cancel"
        ? { status: "cancelled", ...(action.fields || {}) }
        : fieldsWithMergedPhotoUrls(action.fields, before) || {};
    const follow = verb === "patch" ? await posterFareFollow(before, fields) : {};
    const watched = await rowsBeforeStatusWrite(before, fields);
    const saved = await versionedPatch(targetId, fields, before, action.expected_updated_at, follow.write);
    if (!saved.ok) return { ok: false, message: saved.message };
    const word = verb === "delete" ? "Архивласан" : verb === "cancel" ? "Цуцалсан" : "Шинэчилсэн";
    const departures = await rowsAfterStatusWrite(targetId, watched);
    return {
      ok: true,
      message: `${word}: "${verb === "delete" ? before.route_name : saved.trip.route_name}"${follow.warning ? ` (${follow.warning})` : ""}`,
      snapshot: snapshotOf(action, before, saved.trip, fields, { ...(follow.restore ? { poster_restore: follow.restore } : {}), ...departures }),
    };
  }

  return { ok: false, message: `Unsupported action: ${verb}` };
}

/**
 * Per trip, the versions this save itself wrote over or left, and the latest one. Every action
 * of a proposal carries the version the proposal saw; once an earlier action of the same save has
 * moved it, that version still stands for "as the proposal saw it" and the later action is checked
 * against the version the earlier one left. An edit by anyone else in between moves the version
 * past that and is still refused.
 */
type VersionChain = Map<string, { known: string[]; latest: string }>;

function chainedAction(action: AITripAction, chain: VersionChain): AITripAction {
  const id = text(action.trip_id);
  const link = id ? chain.get(id) : undefined;
  if (!link || !action.expected_updated_at) return action;
  return link.known.some((version) => sameVersion(version, action.expected_updated_at))
    ? { ...action, expected_updated_at: link.latest }
    : action;
}

function rememberVersion(chain: VersionChain, snapshot: AIActionSnapshot): void {
  const left = snapshot.version_after;
  if (!left || !snapshot.before) return;
  const link = chain.get(snapshot.trip_id) || { known: [], latest: left };
  for (const version of [snapshot.before.updated_at, left]) if (version) link.known.push(version);
  link.latest = left;
  chain.set(snapshot.trip_id, link);
}

async function runActions(actions: AITripAction[]) {
  const results: string[] = [];
  const snapshots: AIActionSnapshot[] = [];
  const chain: VersionChain = new Map();
  let failed = false;
  for (const action of actions) {
    const result = await applyActionSafely(chainedAction(action, chain));
    results.push(result.message);
    if (result.ok && result.snapshot) {
      snapshots.push(result.snapshot);
      rememberVersion(chain, result.snapshot);
    }
    if (!result.ok) failed = true;
  }
  return { results, snapshots, failed };
}

/**
 * The public page of every trip the save wrote, read after the save and its website sync
 * (savedTripLinks.ts), for the admin's "saved" bar. Never fails a save: without the website
 * connection there are simply no links.
 */
export async function linksForSnapshots(snapshots: AIActionSnapshot[]): Promise<SavedTripLink[]> {
  try {
    const saved: SavedTripInput[] = [];
    const read = new Map<string, TravelTrip | null>();
    for (const snapshot of snapshots) {
      let trip = snapshot.after;
      if (!trip) {
        if (!read.has(snapshot.trip_id)) read.set(snapshot.trip_id, await deps.getTripById(snapshot.trip_id));
        trip = read.get(snapshot.trip_id) ?? null;
      }
      // As the trip stands once its dates are checked: a trip whose dates have all passed is archived on
      // read, and its link would lead to a page that is not there.
      if (trip) saved.push({ trip: sanitizeTripScheduleForCurrentDate(trip).trip, created: snapshot.created, slugHint: snapshot.website_slug });
    }
    if (!saved.length) return [];
    const synced = await deps.readWebsiteSlugs(saved.map((entry) => entry.trip.id)).catch(() => ({}));
    return savedTripLinks(saved, synced, newWebsiteTripSlug);
  } catch (error) {
    logWarn("travel.ai.saved_links_failed", { message: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

/** Exported for the apply/rollback tests: a whole proposal's actions in order, as a save runs them. */
export const runActionsForTests = runActions;

/**
 * Saves a stored proposal. `reviewed` is the proposal as the admin left it on
 * the review page; it is what gets saved. Until 2026-11-05 only the request id
 * travelled, so every correction made in the review (a price, a date, a name)
 * was dropped and the assistant's first reading was saved instead.
 */
export async function applyAIRequest(requestId: number, reviewed?: AIChangeProposal) {
  const ready = await ensureTravelSchema();
  if (!ready) {
    return { ok: false, message: "Database is not configured." };
  }

  const reqResult = await queryNeon<{
    id: number;
    instruction: string;
    proposal_json: AIChangeProposal;
    needs_confirmation: boolean;
    status: string;
  }>(
    `
      SELECT id, instruction, proposal_json, needs_confirmation, status
      FROM travel_ai_change_requests
      WHERE id = $1
      LIMIT 1
    `,
    [requestId],
  );
  const row = reqResult?.rows?.[0];
  if (!row) return { ok: false, message: "Change request not found." };
  if (row.status === "applied") {
    return {
      ok: true,
      message: "Request already applied.",
      results: [] as string[],
      request_id: requestId,
    };
  }

  const proposal = normalizeProposal(reviewed ?? row.proposal_json);
  // A reviewed proposal already holds exactly the photos the admin kept.
  if (!reviewed) attachPersistedPhotoSources(proposal);
  const trips = await listTrips({ limit: 250, includeArchived: true });
  const validation = validateAIChangeProposal(proposal, trips, {
    forbidCreate: instructionForbidsTripCreation(row.instruction),
  });
  if (validation.blocking_conflicts.length > 0) {
    await queryNeon(
      `
        UPDATE travel_ai_change_requests
        SET
          proposal_json = $2::jsonb,
          conflicts = $3::text[],
          needs_confirmation = TRUE,
          status = 'error'
        WHERE id = $1
      `,
      [
        requestId,
        JSON.stringify(validation.proposal),
        validation.proposal.conflicts,
      ],
    );
    return {
      ok: false,
      message: "Proposal failed validation before saving.",
      results: validation.blocking_conflicts,
      proposal: validation.proposal,
    };
  }

  // Nothing is written while any new trip would be refused: the request stays
  // pending, so the admin corrects the review and saves again.
  const problems = newTripSaveProblems(validation.proposal);
  if (problems.length > 0) {
    return { ok: false, message: "Хадгалахын өмнө засах зүйл байна.", results: problems, proposal: validation.proposal, retry: true };
  }
  // A change that would break a saved trip (renamed, off the website, prices or program gone) is
  // written only once the admin ticked it on the card — checked against the trip as it is now.
  const unticked = unacknowledgedDamage(validation.proposal.actions, trips);
  if (unticked.length > 0) {
    return { ok: false, message: DAMAGE_REFUSED, results: [DAMAGE_REFUSED, ...unticked], proposal: validation.proposal, retry: true, damage: true };
  }

  // One save at a time: a second tab, or a repeat press while the first save is still running,
  // is refused instead of applying the same changes twice. A claim older than 5 minutes is a
  // save that crashed, so a request can never stay stuck.
  const claim = await queryNeon<{ id: number }>(
    `
      UPDATE travel_ai_change_requests
      SET applying_at = NOW()
      WHERE id = $1 AND status <> 'applied'
        AND (applying_at IS NULL OR applying_at < NOW() - INTERVAL '5 minutes')
      RETURNING id
    `,
    [requestId],
  );
  if (claim && Array.isArray(claim.rows) && claim.rows.length === 0) {
    return {
      ok: false,
      message: "Энэ саналыг яг одоо хадгалж байна (өөр цонх эсвэл өмнөх дарсан). Хэдэн минутын дараа шалгана уу.",
      results: [] as string[],
      request_id: requestId,
      in_progress: true,
    };
  }

  let outcome: Awaited<ReturnType<typeof runActions>>;
  try {
    outcome = await runActions(validation.proposal.actions);
  } catch (error) {
    await queryNeon(`UPDATE travel_ai_change_requests SET applying_at = NULL WHERE id = $1`, [requestId]);
    throw error;
  }
  const { results, snapshots, failed } = outcome;

  const status = failed ? "error" : "applied";
  await queryNeon(
    `
      UPDATE travel_ai_change_requests
      SET
        status = $2,
        rollback_json = $3::jsonb,
        proposal_json = $4::jsonb,
        applied_at = CASE WHEN $2 = 'applied' THEN NOW() ELSE NULL END,
        reverted_at = NULL,
        applying_at = NULL
      WHERE id = $1
    `,
    [requestId, status, JSON.stringify(snapshots), JSON.stringify(validation.proposal)],
  );

  return {
    ok: !failed,
    message: failed
      ? "Some actions failed. Review results."
      : "All actions applied successfully.",
    results,
    proposal: validation.proposal,
    request_id: requestId,
    // A half-saved request keeps the snapshots of what was saved: rollback can undo that part.
    saved: snapshots.length,
    undo_available: snapshots.length > 0,
    links: await linksForSnapshots(snapshots),
  };
}

export async function applyAIProposalDirect(
  proposal: AIChangeProposal,
  instruction: string,
) {
  const ready = await ensureTravelSchema();
  if (!ready) {
    return { ok: false, message: "Database is not configured.", results: [] as string[] };
  }

  const trips = await listTrips({ limit: 250, includeArchived: true });
  attachPersistedPhotoSources(proposal);
  const validation = validateAIChangeProposal(proposal, trips, {
    forbidCreate: instructionForbidsTripCreation(instruction),
  });
  const normalised = validation.proposal;
  if (validation.blocking_conflicts.length > 0) {
    return {
      ok: false,
      message: "Proposal failed validation before saving.",
      results: validation.blocking_conflicts,
      proposal: normalised,
    };
  }
  const problems = newTripSaveProblems(normalised);
  if (problems.length > 0) {
    return { ok: false, message: "Хадгалахын өмнө засах зүйл байна.", results: problems, proposal: normalised, retry: true };
  }
  const unticked = unacknowledgedDamage(normalised.actions, trips);
  if (unticked.length > 0) {
    return { ok: false, message: DAMAGE_REFUSED, results: [DAMAGE_REFUSED, ...unticked], proposal: normalised, retry: true, damage: true };
  }
  const { results, snapshots, failed } = await runActions(normalised.actions);

  const status = failed ? "error" : "applied";
  let insertedRequestId: number | null = null;
  try {
    const inserted = await queryNeon<{ id: number }>(
      `
        INSERT INTO travel_ai_change_requests (
          instruction, proposal_json, conflicts, needs_confirmation, status, applied_at, rollback_json
        )
        VALUES ($1, $2::jsonb, $3::text[], $4, $5, CASE WHEN $5 = 'applied' THEN NOW() ELSE NULL END, $6::jsonb)
        RETURNING id
      `,
      [
        instruction,
        JSON.stringify(normalised),
        normalised.conflicts,
        normalised.needs_confirmation,
        status,
        JSON.stringify(snapshots),
      ],
    );
    insertedRequestId = changeRequestId(inserted?.rows?.[0]);
  } catch (insertError) {
    logError("travel.ai.direct_apply_insert_failed", {
      message:
        insertError instanceof Error ? insertError.message : String(insertError),
    });
  }

  return {
    ok: !failed,
    message: failed
      ? "Some actions failed. Review results."
      : "All actions applied successfully.",
    results,
    proposal: normalised,
    request_id: insertedRequestId,
    saved: snapshots.length,
    undo_available: snapshots.length > 0 && insertedRequestId !== null,
    links: await linksForSnapshots(snapshots),
  };
}

function normalizeActionSnapshots(value: unknown): AIActionSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const entry = item as Partial<AIActionSnapshot>;
      const tripId = String(entry.trip_id || "").trim();
      if (!tripId) return null;
      const rows = Array.isArray(entry.departure_rows)
        ? entry.departure_rows.map(record).filter((row) => text(row.id) && text(row.status) && text(row.after_status)).map((row) => ({
          id: text(row.id), status: text(row.status), seatsLeft: typeof row.seatsLeft === "number" ? row.seatsLeft : null,
          after_status: text(row.after_status), after_seats_left: typeof row.after_seats_left === "number" ? row.after_seats_left : null,
          ...(/^\d{4}-\d{2}-\d{2}$/.test(text(row.date)) ? { date: text(row.date) } : {}),
        }))
        : undefined;
      const restore = entry.restore && typeof entry.restore === "object"
        ? { columns: record((entry.restore as Row).columns), extra: record((entry.restore as Row).extra) }
        : undefined;
      const posterRestore = entry.poster_restore && typeof entry.poster_restore === "object" && text((entry.poster_restore as Row).id)
        ? { id: text((entry.poster_restore as Row).id), keys: (Array.isArray((entry.poster_restore as Row).keys) ? (entry.poster_restore as Row).keys as unknown[] : []).map(String), values: record((entry.poster_restore as Row).values) }
        : undefined;
      const snapshot: AIActionSnapshot = {
        action:
          entry.action && typeof entry.action === "object"
            ? (entry.action as AITripAction)
            : ({ action: "unknown" } as unknown as AITripAction),
        trip_id: tripId,
        before: entry.before
          ? mapTripRow(entry.before as unknown as Record<string, unknown>)
          : null,
        after: entry.after
          ? mapTripRow(entry.after as unknown as Record<string, unknown>)
          : null,
        date_state_before: isDateSeatState(entry.date_state_before) ? entry.date_state_before : null,
        ...(rows ? { departure_rows: rows } : {}),
        ...(typeof entry.website_slug === "string" ? { website_slug: entry.website_slug } : {}),
        ...(restore ? { restore } : {}),
        ...(typeof entry.version_after === "string" ? { version_after: entry.version_after } : {}),
        ...(posterRestore ? { poster_restore: posterRestore } : {}),
        ...(entry.created === true ? { created: true } : {}),
      };
      return snapshot;
    })
    .filter((item): item is AIActionSnapshot => Boolean(item));
}

/** What an action wrote, for a snapshot saved before `restore` was recorded. */
function legacyRestore(snapshot: AIActionSnapshot): FieldRestore | null {
  const before = snapshot.before;
  if (!before) return null;
  const verb = String(snapshot.action?.action || "").toLowerCase();
  const fields = record(snapshot.action?.fields) as TripMutationFields;
  const written: TripMutationFields = verb === "delete"
    ? { status: "archived", extra: { customer_visible: false } }
    : verb === "cancel" ? { status: "cancelled", ...fields } : fields;
  return Object.keys(written).length ? restoreFor(before, written) : null;
}

async function rollbackDateState(snapshot: AIActionSnapshot): Promise<{ ok: boolean; message: string }> {
  const date = String(snapshot.action.date || "");
  const rows = snapshot.departure_rows || [];
  if (rows.length) {
    const outcome = await deps.restoreDepartureRows(rows);
    if (outcome.changedSince.length) {
      return { ok: false, message: `${date}-ны төлвийг энэ өөрчлөлтөөс хойш өөр хүн (эсвэл сайт) өөрчилсөн тул буцаасангүй.` };
    }
    if (snapshot.website_slug) await deps.notifyWebsite([snapshot.website_slug]).catch(() => undefined);
    const was = WEBSITE_STATUS_WORDS[rows[0].status] || rows[0].status;
    return { ok: true, message: `Restored ${snapshot.trip_id} ${date} → ${was}` };
  }
  // A snapshot saved before raw rows were recorded (B10: it used to be skipped and the request
  // still marked reverted).
  const previous = snapshot.date_state_before;
  if (!previous || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, message: `${date}-ны өмнөх төлөв бүртгэгдээгүй тул автоматаар буцааж чадсангүй — «Аяллууд» хэсгээс гараар тохируулна уу.` };
  }
  const restored = await deps.setDepartureSeatState(snapshot.trip_id, date, previous);
  return restored
    ? { ok: true, message: `Restored ${snapshot.trip_id} ${date} → ${DATE_STATE_WORDS[previous]}` }
    : { ok: false, message: `Failed to restore ${snapshot.trip_id} ${date}` };
}

/** True when the trip already holds every value a rollback would put back (a rollback run twice). */
function alreadyRestored(current: TravelTrip, restore: FieldRestore): boolean {
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return Object.entries(restore.columns).every(([key, value]) => same((current as unknown as Row)[key], value))
    && Object.entries(restore.extra).every(([key, value]) => same(current.extra[key], value));
}

/**
 * Per trip, the versions this rollback run wrote and the version each stands for (the one the
 * undone action had written over). Undoing a newer action of the same request moves the trip's
 * version; an older action's own "version I left" is then that stand-in, not a later edit.
 */
type RollbackVersions = Map<string, Array<{ version: string; standsFor: string }>>;

function rememberRollback(produced: RollbackVersions, tripId: string, version: string | undefined, standsFor: string | undefined): void {
  if (!version || !standsFor) return;
  produced.set(tripId, [...(produced.get(tripId) || []), { version, standsFor }]);
}

/** The dates (with their state before the change) the admin is asked to check by hand. */
function datesToCheck(rows: DepartureStateRow[]): string {
  const today = ulaanbaatarToday(deps.now());
  return rows.filter((row) => !row.date || row.date >= today)
    .map((row) => `${row.date ? shortDay(row.date) : row.id} ${WEBSITE_STATUS_WORDS[row.status] || row.status}`).join(", ");
}

/**
 * After a status rollback re-activated the trip (its projection reopens every closed date), each
 * recorded website row goes back to what it was before the AI change. A row someone changed while
 * the change was in place keeps that later state instead. A past date, and a date the projection
 * now has as cancelled (gone from the schedule), are left as the projection has them. Every write
 * is guarded on the row still holding what the re-activation left.
 */
async function restoreDaysAfterUndo(snapshot: AIActionSnapshot, recorded: DepartureStateRow[], beforeUndo: WebsiteRows | null): Promise<{ ok: boolean; note: string }> {
  const check = `«Аяллууд» хэсгээс огноонуудыг шалгана уу: ${datesToCheck(recorded)}`;
  if (!beforeUndo) return { ok: false, note: `сайтын огноонуудыг уншиж чадсангүй — ${check}` };
  if (await deps.websiteSyncPending(snapshot.trip_id).catch(() => false)) {
    return { ok: false, note: `сайт шинэчлэгдэж дуусаагүй тул огнооны төлвийг буцааж чадсангүй — ${check}` };
  }
  const afterUndo = await websiteRows(snapshot.trip_id);
  if (!afterUndo) return { ok: false, note: `сайтын огноонуудыг уншиж чадсангүй — ${check}` };
  const was = new Map(beforeUndo.rows.map((row) => [row.id, row]));
  const now = new Map(afterUndo.rows.map((row) => [row.id, row]));
  const today = ulaanbaatarToday(deps.now());
  const writes: DepartureStateRow[] = [];
  const kept: string[] = [];
  for (const row of recorded) {
    const before = was.get(row.id);
    const after = now.get(row.id);
    if (!before || !after) continue;
    const date = row.date || after.date;
    if (date && date < today) continue;
    if (after.status === "CANCELLED" || after.status === "DEPARTED") continue;
    const untouched = before.status === row.after_status && before.seatsLeft === row.after_seats_left;
    const target = untouched ? { status: row.status, seatsLeft: row.seatsLeft } : { status: before.status, seatsLeft: before.seatsLeft };
    if (!untouched && (before.status !== row.status || before.seatsLeft !== row.seatsLeft)) kept.push(date ? shortDay(date) : row.id);
    if (after.status === target.status && after.seatsLeft === target.seatsLeft) continue;
    writes.push({ id: row.id, status: target.status, seatsLeft: target.seatsLeft, after_status: after.status, after_seats_left: after.seatsLeft, ...(date ? { date } : {}) });
  }
  const keptNote = kept.length ? `${kept.join(", ")}-ны төлвийг энэ хооронд өөрчилсөн тул тэр хэвээр нь үлдээлээ` : "";
  if (!writes.length) return { ok: true, note: keptNote };
  const outcome = await deps.restoreDepartureRows(writes);
  if (outcome.changedSince.length) return { ok: false, note: `буцаах зуур огноо өөрчлөгдсөн тул огнооны төлвийг буцаасангүй — ${check}` };
  const slug = afterUndo.slug || snapshot.website_slug;
  if (slug) await deps.notifyWebsite([slug]).catch(() => undefined);
  return { ok: true, note: keptNote };
}

async function rollbackTripSnapshot(snapshot: AIActionSnapshot, produced: RollbackVersions): Promise<{ ok: boolean; message: string }> {
  const current = await deps.getTripById(snapshot.trip_id);
  if (!current) return { ok: false, message: `Failed to restore ${snapshot.trip_id}: аялал олдсонгүй` };
  const created = snapshot.created || (!snapshot.before && String(snapshot.action?.action || "").toLowerCase() === "upsert");
  const restore = created ? null : snapshot.restore || legacyRestore(snapshot);
  if (created && current.status === "archived") return { ok: true, message: `AI-created trip ${snapshot.trip_id} was already archived` };
  const left = snapshot.version_after || snapshot.after?.updated_at;
  // The trip still at the version this action left, or at one this run wrote while undoing a newer
  // action of the same request (which stands for the version this action left).
  const atLeft = Boolean(left) && (sameVersion(left, current.updated_at)
    || (produced.get(snapshot.trip_id) || []).some((entry) => sameVersion(entry.version, current.updated_at) && sameVersion(entry.standsFor, left)));
  if (restore && alreadyRestored(current, restore)) {
    if (atLeft) rememberRollback(produced, snapshot.trip_id, current.updated_at, snapshot.before?.updated_at);
    return { ok: true, message: `Already restored ${snapshot.trip_id}` };
  }
  if (left && !atLeft) return { ok: false, message: changedSinceRollbackMessage(current) };
  let fields: TripMutationFields;
  if (created) {
    fields = { status: "archived", extra: { customer_visible: false } };
  } else {
    if (!restore) return { ok: false, message: `Failed to restore ${snapshot.trip_id}: буцаах өгөгдөл бүртгэгдээгүй` };
    fields = { ...(restore.columns as TripMutationFields), ...(Object.keys(restore.extra).length ? { extra: restore.extra } : {}) };
  }
  let posterWrite: PosterWrite | undefined;
  if (snapshot.poster_restore) {
    const poster = await deps.getPoster(snapshot.poster_restore.id);
    if (poster) {
      posterWrite = {
        id: poster.id, title: poster.title, source_file: poster.source_file ?? null, note: "AI туслах: буцаалт",
        data: { ...record(poster.data), ...Object.fromEntries(snapshot.poster_restore.keys.map((key) => [key, snapshot.poster_restore?.values[key] ?? null])) },
      };
    }
  }
  // An archive, cancel or status change recorded the trip's website rows: read them as they are now,
  // before this rollback's projection re-activates the trip.
  const recorded = !created && snapshot.departure_rows?.length ? snapshot.departure_rows : null;
  const beforeUndo = recorded ? await websiteRows(snapshot.trip_id) : null;
  try {
    const restored = await deps.patchTrip(snapshot.trip_id, fields, true, posterWrite, current.updated_at);
    if (!restored) return { ok: false, message: `Failed to restore ${snapshot.trip_id}` };
    rememberRollback(produced, snapshot.trip_id, restored.updated_at, snapshot.before?.updated_at);
  } catch (error) {
    if (error instanceof Error && error.message === "trip_edit_conflict") return { ok: false, message: changedSinceRollbackMessage(current) };
    throw error;
  }
  if (recorded) {
    const days = await restoreDaysAfterUndo(snapshot, recorded, beforeUndo);
    const message = `Restored ${snapshot.trip_id}${days.note ? ` (${days.note})` : ""}`;
    return { ok: days.ok, message };
  }
  return { ok: true, message: created ? `Archived AI-created trip ${snapshot.trip_id}` : `Restored ${snapshot.trip_id}` };
}

/** Rolls back applied actions, newest first. Exported for the apply/rollback tests. */
export async function rollbackSnapshots(snapshots: AIActionSnapshot[]): Promise<{ failed: boolean; results: string[] }> {
  const results: string[] = [];
  const produced: RollbackVersions = new Map();
  let failed = false;
  for (const snapshot of [...snapshots].reverse()) {
    try {
      // A day's availability is put back from its own website rows; it never falls through to
      // the trip branch (a snapshot with no "before" there would archive a live trip).
      const outcome = String(snapshot.action?.action || "") === "set_date_state"
        ? await rollbackDateState(snapshot)
        : await rollbackTripSnapshot(snapshot, produced);
      results.push(outcome.message);
      if (!outcome.ok) failed = true;
    } catch (error) {
      failed = true;
      results.push(`Failed to restore ${snapshot.trip_id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { failed, results };
}

export async function rollbackAIRequest(requestId: number) {
  const ready = await ensureTravelSchema();
  if (!ready) {
    return { ok: false, message: "Database is not configured.", results: [] as string[] };
  }

  const reqResult = await queryNeon<{
    id: number;
    status: string;
    rollback_json: unknown;
  }>(
    `
      SELECT id, status, rollback_json
      FROM travel_ai_change_requests
      WHERE id = $1
      LIMIT 1
    `,
    [requestId],
  );
  const row = reqResult?.rows?.[0];
  if (!row) {
    return { ok: false, message: "Change request not found.", results: [] as string[] };
  }
  if (row.status === "reverted") {
    return { ok: true, message: "Request is already rolled back.", results: [] as string[] };
  }

  const snapshots = normalizeActionSnapshots(row.rollback_json);
  if (snapshots.length === 0) {
    return {
      ok: false,
      message: "No rollback snapshot is available for this request.",
      results: [] as string[],
    };
  }

  const { failed, results } = await rollbackSnapshots(snapshots);

  if (!failed) {
    await queryNeon(
      `
        UPDATE travel_ai_change_requests
        SET status = 'reverted', reverted_at = NOW()
        WHERE id = $1
      `,
      [requestId],
    );
  }

  return {
    ok: !failed,
    message: failed
      ? "Rollback finished with errors. Review results."
      : "Rollback completed successfully.",
    results,
  };
}

/** For tests: snapshots as rollback reads them back from rollback_json. */
export const readStoredSnapshotsForTests = normalizeActionSnapshots;
