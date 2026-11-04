import type { queryNeon as QueryNeon } from "./neonDb";
import { logError, logWarn } from "./observability";
import type { ReadinessIssue } from "./readiness";
import { UpstreamHttpError } from "./resilience";

// Loaded on first use: neonDb validates the whole server env at import, and the
// OpenAI client (which imports this module) must stay importable without it.
const queryNeon: typeof QueryNeon = async (...args) => (await import("./neonDb")).queryNeon(...args);

export type AiFailureKind = "credits_exhausted" | "unauthorized" | "quota" | "provider" | "other";

/**
 * OpenAI answers both a passing rate limit and an empty balance with 429; only
 * the body tells them apart. An empty balance silenced every customer for
 * three days in 2026-10 while the logs said nothing but "returned 429".
 * Billing, a rejected key, a sustained rate limit and an unreachable provider are
 * all told apart so the administrator is told what to fix.
 */
export function aiFailureKind(error: unknown): AiFailureKind {
  if (error instanceof UpstreamHttpError) {
    if (/insufficient_quota|credit_balance_exhausted|billing_hard_limit/.test(error.bodySnippet)) return "credits_exhausted";
    if (error.status === 401 || error.status === 403) return "unauthorized";
    if (error.status === 429) return "quota";
    if (error.status >= 500) return "provider";
    return "other";
  }
  // Timeouts, aborted requests and network failures: the provider could not be reached.
  if (error instanceof Error && /abort|time(?:d)?\s*out|timeout|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket/i.test(`${error.name} ${error.message}`)) return "provider";
  return "other";
}

/** The provider's own error code from a failed response ("insufficient_quota"), for the logs. */
export function aiErrorCode(error: unknown): string | undefined {
  if (!(error instanceof UpstreamHttpError)) return undefined;
  return /"code"\s*:\s*"([a-z_]+)"/.exec(error.bodySnippet)?.[1] || /"type"\s*:\s*"([a-z_]+)"/.exec(error.bodySnippet)?.[1];
}

/** Billing and a rejected key stop every answer at once; they are recorded on the first failure. */
const IMMEDIATE_KINDS = new Set<AiFailureKind>(["credits_exhausted", "unauthorized"]);
/** A rate limit or an unreachable provider is recorded once it persists (not for one blip). */
const SUSTAINED_FAILURES = 3;
const SUSTAINED_WINDOW_MINUTES = 10;
const REPORT_INTERVAL_MINUTES = 60;

const lastReportAtMs = new Map<AiFailureKind, number>();

/**
 * Records that the bot cannot use AI. Billing and key problems are recorded on the first
 * failure, a rate limit or provider failure once it persists; each kind at most hourly per
 * instance. The admin system check (getOperationalIssues below) shows the outage as a critical
 * issue; there is no realtime staff alert. Never throws.
 */
export async function reportAiOutage(kind: AiFailureKind): Promise<void> {
  if (kind === "other") return;
  try {
    const now = Date.now();
    if (now - (lastReportAtMs.get(kind) ?? 0) < REPORT_INTERVAL_MINUTES * 60_000) return;
    if (!IMMEDIATE_KINDS.has(kind)) {
      const failures = (await queryNeon<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM travel_error_logs
          WHERE event = 'openai.fallback_failed' AND fields->>'failure_kind' = $1
            AND created_at > NOW() - make_interval(mins => $2)`,
        [kind, SUSTAINED_WINDOW_MINUTES],
      ))?.rows[0]?.n ?? 0;
      if (failures + 1 < SUSTAINED_FAILURES) return;
    }
    lastReportAtMs.set(kind, now);
    logWarn("ai_outage.reported", { kind });
  } catch (error) {
    logError("ai_outage.report_failed", { message: error instanceof Error ? error.message : String(error) });
  }
}

type AiFailureSummary = { failures: number; minutes_since_last: number | null; credits: boolean; unauthorized: boolean; quota: boolean };

/** Problems an operator must act on, shown in the admin system check. */
export async function getOperationalIssues(): Promise<ReadinessIssue[]> {
  const issues: ReadinessIssue[] = [];
  try {
    const failures = (await queryNeon<AiFailureSummary>(
      `SELECT COUNT(*)::int AS failures,
              (EXTRACT(EPOCH FROM NOW() - MAX(created_at)) / 60)::int AS minutes_since_last,
              COALESCE(BOOL_OR(fields::text LIKE '%credits_exhausted%'), FALSE) AS credits,
              COALESCE(BOOL_OR(fields::text LIKE '%"unauthorized"%'), FALSE) AS unauthorized,
              COALESCE(BOOL_OR(fields->>'failure_kind' = 'quota'), FALSE) AS quota
         FROM travel_error_logs
        WHERE event = 'openai.fallback_failed' AND created_at > NOW() - INTERVAL '2 hours'
          -- Deployed code only: a local script's failures (no revision) must not raise the alarm.
          AND fields ? 'deploymentRevision'`,
    ))?.rows[0];
    const ongoing = failures && failures.minutes_since_last !== null && failures.minutes_since_last <= 30;
    if (ongoing && (failures.credits || failures.unauthorized || failures.failures >= 3)) {
      const cause = failures.credits
        ? "OpenAI-ийн кредит дууссан — platform.openai.com → Billing."
        : failures.unauthorized
          ? "OpenAI түлхүүр хүчингүй — OPENAI_API_KEY-г шалгана уу."
          : failures.quota
            ? "OpenAI хүсэлтийн хязгаарт хүрсэн (rate limit) — platform.openai.com → Limits."
            : "OpenAI хариу өгөхгүй байна — status.openai.com.";
      issues.push({
        severity: "critical",
        key: "ai_outage",
        message: `Бот хэрэглэгчдэд хариулж чадахгүй байна (сүүлийн 2 цагт ${failures.failures} алдаа). ${cause}`,
      });
    }
  } catch (error) {
    logError("operational_issues.query_failed", { message: error instanceof Error ? error.message : String(error) });
  }
  // Spend over the daily production budget is the warning that comes before an empty balance.
  issues.push(...await (await import("./aiUsage")).getAiSpendIssues());
  // Passports and payment slips are kept only in the private store: a broken store is critical.
  // Only where customer images actually arrive (the deployed webhook): a local admin has no
  // store token on purpose and showed a false critical "store not working" (2026-11-04).
  if (process.env.VERCEL) {
    issues.push(...await (await import("./customerImageStorage")).customerImageStorageIssues().catch(() => []));
  }
  // A purge whose file could not be deleted is retried daily; until then it is visible here.
  issues.push(...await (await import("./customerDocumentPurge")).storageDeletionIssues().catch(() => []));
  return issues;
}
