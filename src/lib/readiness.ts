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
