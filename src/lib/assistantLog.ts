import { queryNeon } from "./neonDb";
import { logWarn } from "./observability";

export type AssistantLogKind = "instruction" | "clarification" | "quick_action" | "proposal" | "ask" | "note" | "applied" | "rolled_back" | "error";

const MAX_TEXT_CHARS = 4000;
// A working session with the owner: the last dozen turns of the same page session, within
// six hours (he comes back to a thread after lunch). The page keeps its session id across
// reloads, so "энэ аялал" still means the trip he was editing.
const CONTEXT_WINDOW_MINUTES = 6 * 60;
const CONTEXT_TURNS = 12;
const TURN_TEXT_CHARS = 600;

export type AssistantTurn = { role: "admin" | "assistant"; text: string };

let schemaReady: Promise<boolean> | null = null;

function ensureLogTable(): Promise<boolean> {
  schemaReady ||= (async () => {
    const created = await queryNeon(`
      CREATE TABLE IF NOT EXISTS travel_assistant_log (
        id BIGSERIAL PRIMARY KEY,
        session_id TEXT,
        request_id BIGINT NULL,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    if (!created) return false;
    await queryNeon(`CREATE INDEX IF NOT EXISTS idx_travel_assistant_log_session ON travel_assistant_log (session_id, created_at DESC)`);
    return true;
  })().catch(() => {
    schemaReady = null;
    return false;
  });
  return schemaReady;
}

/** Saves one turn of the AI-assistant conversation for later reference. Never throws and is never shown in the admin. */
export async function logAssistantEvent(event: {
  sessionId?: unknown;
  requestId?: number | null;
  role: "admin" | "assistant";
  kind: AssistantLogKind;
  text: string;
}): Promise<void> {
  try {
    const text = String(event.text || "").trim().slice(0, MAX_TEXT_CHARS);
    if (!text || !(await ensureLogTable())) return;
    const session = typeof event.sessionId === "string" && /^[\w-]{8,64}$/.test(event.sessionId) ? event.sessionId : null;
    await queryNeon(
      `INSERT INTO travel_assistant_log (session_id, request_id, role, kind, text) VALUES ($1, $2, $3, $4, $5)`,
      [session, event.requestId ?? null, event.role, event.kind, text],
    );
  } catch (error) {
    logWarn("assistant_log.write_failed", { message: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * The last turns of this admin's conversation, oldest first, so a follow-up such as
 * "same for the other one" or "make it 2.5 million" is read in context. Only turns of
 * the same session within the window count; none is an empty list.
 */
export async function recentAssistantTurns(sessionId: unknown): Promise<AssistantTurn[]> {
  try {
    if (typeof sessionId !== "string" || !/^[\w-]{8,64}$/.test(sessionId) || !(await ensureLogTable())) return [];
    const rows = (await queryNeon<{ role: string; kind: string; text: string }>(
      `SELECT role, kind, text FROM (
         SELECT id, role, kind, text FROM travel_assistant_log
          WHERE session_id = $1 AND created_at > NOW() - make_interval(mins => $2)
            AND kind IN ('instruction', 'clarification', 'quick_action', 'proposal', 'ask', 'note', 'applied', 'rolled_back')
          ORDER BY id DESC LIMIT $3
       ) recent ORDER BY id`,
      [sessionId, CONTEXT_WINDOW_MINUTES, CONTEXT_TURNS],
    ))?.rows || [];
    return rows.map((row) => ({ role: row.role === "admin" ? "admin" as const : "assistant" as const, text: String(row.text || "").slice(0, TURN_TEXT_CHARS) }));
  } catch {
    return [];
  }
}

/** The same turns as one text block ("Админ: …" / "AI: …"), as the brain reads them. */
export function assistantContextText(turns: AssistantTurn[]): string {
  return turns.map((turn) => `${turn.role === "admin" ? "Админ" : "AI"}: ${turn.text}`).join("\n");
}

export async function recentAssistantContext(sessionId: unknown): Promise<string> {
  return assistantContextText(await recentAssistantTurns(sessionId));
}
