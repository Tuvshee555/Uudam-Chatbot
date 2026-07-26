import type { ValidatedEnv } from "./env";

export type ReadinessIssue = {
  key: string;
  severity: "critical" | "warning";
  message: string;
};

export type ReadinessReport = {
  score: number;
  production: boolean;
  issues: ReadinessIssue[];
};

function isProductionRuntime() {
  return (
    process.env.VERCEL_ENV === "production" ||
    process.env.NODE_ENV === "production"
  );
}

export function getReadinessReport(env: ValidatedEnv): ReadinessReport {
  const production = isProductionRuntime();
  const issues: ReadinessIssue[] = [];
  const add = (
    severity: ReadinessIssue["severity"],
    key: string,
    message: string,
  ) => issues.push({ severity, key, message });

  if (!env.neonDatabaseUrl) {
    add("critical", "neon", "Database is not configured; admin changes cannot persist.");
  }
  if (env.adminOpenAccess) {
    add("critical", "admin_open_access", "Admin open access must never be enabled.");
  }
  if (env.allowAdminSecretQuery) {
    add("warning", "admin_secret_query", "Admin secret in query strings can leak via logs/history.");
  }
  // Only meaningful in production: local dev intentionally leaves the cron
  // endpoint open (see api/cron/reminder.ts), so a missing secret is fine there.
  const isProduction =
    process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
  if (isProduction && !process.env.CRON_SECRET) {
    add(
      "warning",
      "cron_secret",
      "CRON_SECRET тохируулаагүй тул сануулгын автомат илгээлт (cron) ажиллахгүй байна.",
    );
  }

  // Every Redis-backed feature silently falls back to a per-process Map when
  // its flag is off. That is fine for one long-lived local server, but the
  // production target is Vercel, where several serverless instances answer the
  // same page concurrently and share nothing: webhook replay protection stops
  // deduping across instances (a customer gets the same reply twice), staff
  // pause set on one instance is not seen by another, and rate-limit buckets
  // are counted per instance. Warn rather than block — a single-instance
  // deployment is a legitimate choice, it just needs to be a deliberate one.
  if (production) {
    const memoryOnly = [
      !env.redisReplayEnabled && "webhook replay protection",
      !env.redisConversationEnabled && "conversation state",
      !env.redisPauseEnabled && "staff pause",
      !env.redisRateLimitEnabled && "rate limiting",
    ].filter((value): value is string => typeof value === "string");
    if (memoryOnly.length > 0) {
      add(
        "warning",
        "redis_state",
        `Running on per-instance memory for: ${memoryOnly.join(", ")}. ` +
          "Configure REDIS_URL (or the UPSTASH_REDIS_REST_* pair) and enable the " +
          "matching REDIS_*_ENABLED flags so state is shared across instances.",
      );
    }
  }

  if (env.googleDriveSyncEnabled) {
    if (!env.googleDriveFolderId) {
      add("critical", "drive_folder", "Google Drive sync is enabled without a folder ID.");
    }
    if (!env.googleDriveServiceAccountEmail || !env.googleDrivePrivateKey) {
      add(
        "critical",
        "drive_service_account",
        "Google Drive sync is enabled without full service account credentials.",
      );
    }
  }

  const score = Math.max(
    0,
    10 -
      issues.filter((issue) => issue.severity === "critical").length * 2 -
      issues.filter((issue) => issue.severity === "warning").length,
  );

  return { score, production, issues };
}
