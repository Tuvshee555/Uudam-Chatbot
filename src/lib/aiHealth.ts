import type { ValidatedEnv } from "./env";
import type { queryNeon as QueryNeon } from "./neonDb";
import { logError, logWarn } from "./observability";
import type { ReadinessIssue } from "./readiness";
import { UpstreamHttpError } from "./resilience";

// Loaded on first use: neonDb and the staff-alert sender validate the whole
// server env at import, and the OpenAI client (which imports this module) must
// stay importable without it.
const queryNeon: typeof QueryNeon = async (...args) => (await import("./neonDb")).queryNeon(...args);

export type AiFailureKind = "credits_exhausted" | "unauthorized" | "other";

/**
 * OpenAI answers both a passing rate limit and an empty balance with 429; only
 * the body tells them apart. An empty balance silenced every customer for
 * three days in 2026-10 while the logs said nothing but "returned 429".
 */
export function aiFailureKind(error: unknown): AiFailureKind {
  if (!(error instanceof UpstreamHttpError)) return "other";
  if (/insufficient_quota|credit_balance_exhausted/.test(error.bodySnippet)) return "credits_exhausted";
  if (error.status === 401) return "unauthorized";
  return "other";
}

const ALERT_INTERVAL_HOURS = 6;
const LEADS_PATH = "Энэ хооронд ирсэн хүсэлтүүд админ самбарын «Хүсэлтүүд» хэсэгт хадгалагдаж байна.";

export function aiOutageAlertText(kind: Exclude<AiFailureKind, "other">): string {
  return kind === "credits_exhausted"
    ? `⚠️ Чатбот хэрэглэгчдэд хариулахаа больсон: OpenAI-ийн кредит дууссан.\nplatform.openai.com → Billing хэсэгт кредит нэмнэ үү. ${LEADS_PATH}`
    : `⚠️ Чатбот хэрэглэгчдэд хариулахаа больсон: OpenAI түлхүүр хүчингүй байна.\nOPENAI_API_KEY-г шалгана уу. ${LEADS_PATH}`;
}

let lastAlertAtMs = 0;

/** Tells staff nobody is being answered — at most once per six hours across instances. Never throws. */
export async function reportAiOutage(kind: AiFailureKind): Promise<void> {
  if (kind === "other") return;
  try {
    const now = Date.now();
    if (now - lastAlertAtMs < ALERT_INTERVAL_HOURS * 3_600_000) return;
    lastAlertAtMs = now;
    const recent = await queryNeon(
      `SELECT 1 FROM travel_error_logs
        WHERE event = 'ai_outage.staff_alerted' AND created_at > NOW() - make_interval(hours => $1) LIMIT 1`,
      [ALERT_INTERVAL_HOURS],
    );
    if (recent?.rows.length) return;
    logWarn("ai_outage.staff_alerted", { kind });
    await (await import("./staffAlerts")).notifyStaff(aiOutageAlertText(kind), "ai_outage");
  } catch (error) {
    logError("ai_outage.report_failed", { message: error instanceof Error ? error.message : String(error) });
  }
}

type AiFailureSummary = { failures: number; minutes_since_last: number | null; credits: boolean; unauthorized: boolean };
type WaitingLeads = { waiting: number };

/** Problems an operator must act on, shown in the admin system check. */
export async function getOperationalIssues(env: ValidatedEnv): Promise<ReadinessIssue[]> {
  const issues: ReadinessIssue[] = [];
  try {
    const failures = (await queryNeon<AiFailureSummary>(
      `SELECT COUNT(*)::int AS failures,
              (EXTRACT(EPOCH FROM NOW() - MAX(created_at)) / 60)::int AS minutes_since_last,
              COALESCE(BOOL_OR(fields::text LIKE '%credits_exhausted%'), FALSE) AS credits,
              COALESCE(BOOL_OR(fields::text LIKE '%"unauthorized"%'), FALSE) AS unauthorized
         FROM travel_error_logs
        WHERE event = 'openai.fallback_failed' AND created_at > NOW() - INTERVAL '2 hours'`,
    ))?.rows[0];
    const ongoing = failures && failures.minutes_since_last !== null && failures.minutes_since_last <= 30;
    if (ongoing && (failures.credits || failures.unauthorized || failures.failures >= 3)) {
      const cause = failures.credits
        ? "OpenAI-ийн кредит дууссан — platform.openai.com → Billing."
        : failures.unauthorized
          ? "OpenAI түлхүүр хүчингүй — OPENAI_API_KEY-г шалгана уу."
          : "OpenAI хариу өгөхгүй байна.";
      issues.push({
        severity: "critical",
        key: "ai_outage",
        message: `Бот хэрэглэгчдэд хариулж чадахгүй байна (сүүлийн 2 цагт ${failures.failures} алдаа). ${cause}`,
      });
    }
    const waiting = await countWaitingLeads();
    if (waiting > 0) {
      issues.push({ severity: "warning", key: "waiting_leads", message: waitingLeadsText(waiting) });
    }
  } catch (error) {
    logError("operational_issues.query_failed", { message: error instanceof Error ? error.message : String(error) });
  }
  if (!(await import("./staffAlerts")).hasStaffAlertChannel(env)) {
    issues.push({
      severity: "critical",
      key: "staff_alert_channel",
      message:
        "Шинэ хүсэлт ирэх эсвэл бот зогсоход хэнд ч мэдэгдэл очихгүй байна. " +
        "TELEGRAM_BOT_TOKEN болон TELEGRAM_STAFF_CHAT_IDS тохируулна уу.",
    });
  }
  return issues;
}

export function waitingLeadsText(waiting: number): string {
  return `${waiting} хүсэлт 24 цагаас дээш хугацаанд нээгдээгүй байна — админ самбарын «Хүсэлтүүд» хэсгийг шалгана уу.`;
}

/** Unopened leads older than a day, within the last month (older ones are history, not a backlog). */
export async function countWaitingLeads(): Promise<number> {
  const row = (await queryNeon<WaitingLeads>(
    `SELECT COUNT(*)::int AS waiting FROM travel_leads
      WHERE status = 'new' AND created_at < NOW() - INTERVAL '24 hours' AND created_at > NOW() - INTERVAL '30 days'`,
  ))?.rows[0];
  return row?.waiting ?? 0;
}
