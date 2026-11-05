/**
 * Applying and rolling back a reviewed AI proposal. Split from travelAI.ts,
 * which had grown past the 2,000-line cap.
 */
import { logError } from "./observability";
import { queryNeon } from "./neonDb";
import type { AIChangeProposal, AITripAction, DateSeatState, TravelTrip } from "./travelTypes";
import { ensureTravelSchema, listTrips, getTripById, upsertTrip, patchTrip, deleteTrip, resolveTripIdByMatch, mapTripRow, normalizeProposal, isDateSeatState } from "./travelDb";
import { instructionForbidsTripCreation, validateAIChangeProposal } from "./travelAIValidation";
import { attachPersistedPhotoSources, changeRequestId } from "./travelAI";
import { withoutReviewOnly } from "./tripReview";
import { validateTripDataChange } from "./tripDataValidation";

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
  }
  return problems;
}

/** One action applied; a thrown save error becomes a failed result instead of a 500 with half the proposal saved. */
async function applyActionSafely(action: AITripAction) {
  try {
    return await applyAIAction(action);
  } catch (error) {
    logError("travel.ai.apply_action_failed", { message: error instanceof Error ? error.message : String(error) });
    return { ok: false as const, message: error instanceof Error ? error.message : "Хадгалахад алдаа гарлаа.", snapshot: undefined };
  }
}

type AIActionSnapshot = {
  action: AITripAction;
  trip_id: string;
  before: TravelTrip | null;
  after: TravelTrip | null;
  /** set_date_state: the day's state before the change, so rollback can put it back. */
  date_state_before?: DateSeatState | null;
};

/**
 * True when the trip was edited after the proposal was built (its updated_at moved). The
 * change is then refused instead of overwriting the other edit; the admin re-sends the
 * instruction and gets a proposal built on the current trip.
 */
function changedSinceProposal(before: TravelTrip | null, action: AITripAction): boolean {
  if (!before || !action.expected_updated_at) return false;
  const expected = new Date(action.expected_updated_at).getTime();
  const actual = new Date(before.updated_at).getTime();
  return Number.isFinite(expected) && Number.isFinite(actual) && expected !== actual;
}

function changedSinceMessage(before: TravelTrip | null): string {
  return `«${before?.route_name || "Аялал"}» энэ саналыг гаргаснаас хойш өөрчлөгдсөн байна (өөр админ эсвэл сайт). Зааврыг дахин бичвэл одоогийн байдлаар нь шинэ санал гаргана.`;
}

const DATE_STATE_WORDS: Record<DateSeatState, string> = { open: "нээлттэй", low: "цөөн суудал", full: "дүүрсэн" };

/** The website's current state for one departure day, read from the availability overlay. */
function departureSeatStateOf(trip: TravelTrip, date: string): DateSeatState | null {
  const rows = Array.isArray(trip.extra?.website_departure_availability) ? trip.extra.website_departure_availability : [];
  for (const raw of rows) {
    const row = raw as { date?: unknown; status?: unknown; seatsLeft?: unknown };
    if (row.date !== date) continue;
    const status = String(row.status || "").toUpperCase();
    if (status === "ALMOST_FULL") return "low";
    if (status === "SOLD_OUT" || row.seatsLeft === 0) return "full";
    return "open";
  }
  return null;
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
  ).slice(0, 20);
  return next;
}

async function applyAIAction(input: AITripAction) {
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
      const match = await resolveTripIdByMatch(action.match);
      if (
        match.conflict &&
        !/matching trip not found|таарах аялал олдсонгүй/i.test(match.conflict)
      ) {
        return { ok: false, message: match.conflict };
      }
      targetId = match.id || "";
    }
    const before = targetId ? await getTripById(targetId) : null;
    if (before) {
      const updated = await patchTrip(
        targetId,
        fieldsWithMergedPhotoUrls(action.fields, before) || {},
      );
      if (!updated) return { ok: false, message: "Existing trip update failed." };
      return {
        ok: true,
        message: `Шинэчилсэн: "${updated.route_name}"`,
        snapshot: {
          action: { ...action, action: "patch" },
          trip_id: updated.id,
          before,
          after: updated,
        } satisfies AIActionSnapshot,
      };
    }
    const updated = await upsertTrip({
      id: targetId || undefined,
      fields: action.fields || {},
    });
    if (!updated) return { ok: false, message: "Upsert failed." };
    return {
      ok: true,
      message: `Нэмсэн: "${updated.route_name}"`,
      snapshot: {
        action,
        trip_id: updated.id,
        before,
        after: updated,
      } satisfies AIActionSnapshot,
    };
  }

  let targetId = action.trip_id?.trim() || "";
  if (!targetId) {
    const match = await resolveTripIdByMatch(action.match);
    if (match.conflict) return { ok: false, message: match.conflict };
    targetId = match.id || "";
  }
  if (!targetId) return { ok: false, message: "Target trip not found." };

  if (verb === "set_date_state") {
    const date = String(action.date || "").trim();
    const state = action.state;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isDateSeatState(state)) {
      return { ok: false, message: "Огноо эсвэл төлөв буруу байна." };
    }
    const before = await getTripById(targetId);
    if (!before) return { ok: false, message: "Target trip not found." };
    const previous = departureSeatStateOf(before, date);
    const { setDepartureSeatState } = await import("./websiteTripSync");
    let updated = false;
    try {
      updated = await setDepartureSeatState(targetId, date, state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: /not configured/i.test(message)
        ? "Вэбсайтын өгөгдлийн сан холбогдоогүй тул огнооны төлвийг өөрчилж чадсангүй."
        : `Огнооны төлвийг өөрчилж чадсангүй: ${message}` };
    }
    if (!updated) {
      return { ok: false, message: `"${before.route_name}" аялалд ${date} гарах өдөр вэбсайтад олдсонгүй.` };
    }
    return {
      ok: true,
      message: `"${before.route_name}" — ${date}: ${DATE_STATE_WORDS[state]}`,
      snapshot: {
        action,
        trip_id: targetId,
        before: null,
        after: null,
        date_state_before: previous,
      } satisfies AIActionSnapshot,
    };
  }

  if (verb === "delete") {
    const before = await getTripById(targetId);
    if (!before) return { ok: false, message: "Target trip not found." };
    if (changedSinceProposal(before, action)) return { ok: false, message: changedSinceMessage(before) };
    const archived = await deleteTrip(targetId);
    if (!archived) return { ok: false, message: "Archive failed." };
    const after = await getTripById(targetId);
    return {
      ok: true,
      message: `Архивласан: "${before.route_name}"`,
      snapshot: { action, trip_id: targetId, before, after } satisfies AIActionSnapshot,
    };
  }

  if (verb === "cancel") {
    const before = await getTripById(targetId);
    if (changedSinceProposal(before, action)) return { ok: false, message: changedSinceMessage(before) };
    let updated: TravelTrip | null;
    try {
      updated = await patchTrip(targetId, { status: "cancelled", ...(action.fields || {}) }, true, undefined, action.expected_updated_at || undefined);
    } catch (error) {
      if (error instanceof Error && error.message === "trip_edit_conflict") return { ok: false, message: changedSinceMessage(before) };
      throw error;
    }
    if (!updated) return { ok: false, message: "Cancel update failed." };
    return {
      ok: true,
      message: `Цуцалсан: "${updated.route_name}"`,
      snapshot: {
        action,
        trip_id: updated.id,
        before,
        after: updated,
      } satisfies AIActionSnapshot,
    };
  }

  if (verb === "patch") {
    const before = await getTripById(targetId);
    if (changedSinceProposal(before, action)) return { ok: false, message: changedSinceMessage(before) };
    let updated: TravelTrip | null;
    try {
      updated = await patchTrip(targetId, fieldsWithMergedPhotoUrls(action.fields, before) || {}, true, undefined, action.expected_updated_at || undefined);
    } catch (error) {
      if (error instanceof Error && error.message === "trip_edit_conflict") return { ok: false, message: changedSinceMessage(before) };
      throw error;
    }
    if (!updated) return { ok: false, message: "Patch update failed." };
    return {
      ok: true,
      message: `Шинэчилсэн: "${updated.route_name}"`,
      snapshot: {
        action,
        trip_id: updated.id,
        before,
        after: updated,
      } satisfies AIActionSnapshot,
    };
  }

  return { ok: false, message: `Unsupported action: ${verb}` };
}

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

  const results: string[] = [];
  const snapshots: AIActionSnapshot[] = [];
  let failed = false;

  for (const action of validation.proposal.actions) {
    const result = await applyActionSafely(action);
    results.push(result.message);
    if (result.ok && result.snapshot) snapshots.push(result.snapshot);
    if (!result.ok) failed = true;
  }

  const status = failed ? "error" : "applied";
  await queryNeon(
    `
      UPDATE travel_ai_change_requests
      SET
        status = $2,
        rollback_json = $3::jsonb,
        proposal_json = $4::jsonb,
        applied_at = CASE WHEN $2 = 'applied' THEN NOW() ELSE NULL END,
        reverted_at = NULL
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
  const results: string[] = [];
  const snapshots: AIActionSnapshot[] = [];
  let failed = false;

  for (const action of normalised.actions) {
    const result = await applyActionSafely(action);
    results.push(result.message);
    if (result.ok && result.snapshot) snapshots.push(result.snapshot);
    if (!result.ok) failed = true;
  }

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
      };
      return snapshot;
    })
    .filter((item): item is AIActionSnapshot => Boolean(item));
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

  const results: string[] = [];
  let failed = false;

  for (const snapshot of [...snapshots].reverse()) {
    // A day's availability is put back to what it was; it must never fall through to the
    // "no before → remove the trip" branch below, which would archive a live trip.
    if (String(snapshot.action?.action || "") === "set_date_state") {
      const date = String(snapshot.action.date || "");
      const previous = snapshot.date_state_before;
      if (!previous || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        results.push(`Skipped ${snapshot.trip_id} ${date}: no earlier state recorded`);
        continue;
      }
      try {
        const { setDepartureSeatState } = await import("./websiteTripSync");
        const restored = await setDepartureSeatState(snapshot.trip_id, date, previous);
        if (restored) results.push(`Restored ${snapshot.trip_id} ${date} → ${DATE_STATE_WORDS[previous]}`);
        else { failed = true; results.push(`Failed to restore ${snapshot.trip_id} ${date}`); }
      } catch (error) {
        failed = true;
        results.push(`Failed to restore ${snapshot.trip_id} ${date}: ${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }
    if (snapshot.before) {
      const restored = await upsertTrip({
        id: snapshot.trip_id,
        fields: snapshot.before,
      });
      if (restored) {
        results.push(`Restored ${snapshot.trip_id}`);
      } else {
        failed = true;
        results.push(`Failed to restore ${snapshot.trip_id}`);
      }
      continue;
    }

    const deleted = await deleteTrip(snapshot.trip_id);
    if (deleted) {
      results.push(`Removed AI-created trip ${snapshot.trip_id}`);
    } else {
      results.push(`AI-created trip ${snapshot.trip_id} was already absent`);
    }
  }

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
