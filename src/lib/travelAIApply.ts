/**
 * Applying and rolling back a reviewed AI proposal. Split from travelAI.ts,
 * which had grown past the 2,000-line cap.
 */
import { logError } from "./observability";
import { queryNeon } from "./neonDb";
import type { AIChangeProposal, AITripAction, TravelTrip } from "./travelTypes";
import { ensureTravelSchema, listTrips, getTripById, upsertTrip, patchTrip, deleteTrip, resolveTripIdByMatch, mapTripRow, normalizeProposal } from "./travelDb";
import { instructionForbidsTripCreation, validateAIChangeProposal } from "./travelAIValidation";
import { attachPersistedPhotoSources } from "./travelAI";

type AIActionSnapshot = {
  action: AITripAction;
  trip_id: string;
  before: TravelTrip | null;
  after: TravelTrip | null;
};

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

async function applyAIAction(action: AITripAction) {
  if (!action || typeof action !== "object") {
    return { ok: false, message: "Invalid action payload." };
  }

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

  if (verb === "cancel") {
    const before = await getTripById(targetId);
    const updated = await patchTrip(targetId, {
      status: "cancelled",
      ...(action.fields || {}),
    });
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
    const updated = await patchTrip(
      targetId,
      fieldsWithMergedPhotoUrls(action.fields, before) || {},
    );
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

export async function applyAIRequest(requestId: number) {
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

  const proposal = normalizeProposal(row.proposal_json);
  attachPersistedPhotoSources(proposal);
  const trips = await listTrips({ limit: 250 });
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

  const results: string[] = [];
  const snapshots: AIActionSnapshot[] = [];
  let failed = false;

  for (const action of validation.proposal.actions) {
    const result = await applyAIAction(action);
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
        applied_at = CASE WHEN $2 = 'applied' THEN NOW() ELSE NULL END,
        reverted_at = NULL
      WHERE id = $1
    `,
    [requestId, status, JSON.stringify(snapshots)],
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

  const trips = await listTrips({ limit: 250 });
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
  const results: string[] = [];
  const snapshots: AIActionSnapshot[] = [];
  let failed = false;

  for (const action of normalised.actions) {
    const result = await applyAIAction(action);
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
    insertedRequestId = inserted?.rows?.[0]?.id ?? null;
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
      return {
        action:
          entry.action && typeof entry.action === "object"
            ? (entry.action as AITripAction)
            : { action: "unknown" },
        trip_id: tripId,
        before: entry.before
          ? mapTripRow(entry.before as unknown as Record<string, unknown>)
          : null,
        after: entry.after
          ? mapTripRow(entry.after as unknown as Record<string, unknown>)
          : null,
      };
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
