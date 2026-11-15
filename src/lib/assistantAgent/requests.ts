/**
 * The stored change requests (travel_ai_change_requests) as the assistant's route needs them:
 * read one for a clarification, save its revised proposal, and expire what nobody saved.
 *
 * Every proposal is stored before review, so unsaved ones piled up (45 pending against 2
 * applied in 30 days, B12). A proposal older than a day was built on trip data that may have
 * moved since; it is marked "expired" and the route refuses to save it, so the admin asks again.
 */
import { queryNeon } from "../neonDb";
import { logWarn } from "../observability";
import { ensureTravelSchema, normalizeProposal } from "../travelDb";
import type { AIChangeProposal } from "../travelTypes";

export const PROPOSAL_TTL_HOURS = 24;
export const EXPIRED_PROPOSAL_MESSAGE = "Энэ санал 24 цагаас хуучирсан тул хадгалахгүй — аяллын мэдээлэл тэр хооронд өөрчлөгдсөн байж магадгүй. Зааврыг дахин илгээнэ үү.";
const SWEEP_EVERY_MS = 10 * 60 * 1000;

export type StoredChangeRequest = { id: number; instruction: string; proposal: AIChangeProposal; status: string; expired: boolean };

export type LoadedRequest = { ok: true; request: StoredChangeRequest } | { ok: false; message: string };

export async function loadChangeRequest(id: number): Promise<LoadedRequest> {
  const ready = await ensureTravelSchema().catch(() => false);
  if (!ready) return { ok: false, message: "Database is not configured." };
  const result = await queryNeon<{ id: unknown; instruction: string; proposal_json: AIChangeProposal; status: string; stale?: boolean | null }>(
    `SELECT id, instruction, proposal_json, status, (created_at < NOW() - make_interval(hours => $2)) AS stale
       FROM travel_ai_change_requests WHERE id = $1 LIMIT 1`,
    [id, PROPOSAL_TTL_HOURS],
  ).catch(() => null);
  const row = result?.rows?.[0];
  if (!row) return { ok: false, message: "Change request not found." };
  const status = String(row.status || "pending");
  return {
    ok: true,
    request: {
      id, instruction: String(row.instruction || ""), proposal: normalizeProposal(row.proposal_json), status,
      expired: status === "expired" || (status === "pending" && row.stale === true),
    },
  };
}

/** The proposal the admin is still reviewing, replaced by its revision (only while unsaved). */
export async function saveRevisedProposal(id: number, proposal: AIChangeProposal): Promise<boolean> {
  const result = await queryNeon(
    `UPDATE travel_ai_change_requests SET proposal_json = $2::jsonb, conflicts = $3::text[], needs_confirmation = $4
      WHERE id = $1 AND status = 'pending'`,
    [id, JSON.stringify(proposal), proposal.conflicts || [], proposal.needs_confirmation],
  ).catch((error) => {
    logWarn("assistant.revision_save_failed", { message: error instanceof Error ? error.message : String(error) });
    return null;
  });
  return Boolean(result);
}

/** A proposal file reading built (a new trip, photos found for it): its own reviser keeps its photos and choices. */
export function isFileProposal(proposal: AIChangeProposal): boolean {
  return Boolean(proposal.photo_sources?.length) || proposal.actions.some((action) => String(action.action || "").toLowerCase() === "upsert");
}

let lastSweepAt = 0;

/** Marks unsaved proposals older than a day as expired. At most once per 10 minutes per instance; never throws. */
export async function expireStaleProposals(nowMs = Date.now()): Promise<void> {
  if (nowMs - lastSweepAt < SWEEP_EVERY_MS) return;
  lastSweepAt = nowMs;
  await queryNeon(
    `UPDATE travel_ai_change_requests SET status = 'expired'
      WHERE status = 'pending' AND created_at < NOW() - make_interval(hours => $1)`,
    [PROPOSAL_TTL_HOURS],
  ).catch((error) => logWarn("assistant.expire_failed", { message: error instanceof Error ? error.message : String(error) }));
}

export function resetProposalSweepForTests(): void {
  lastSweepAt = 0;
}
