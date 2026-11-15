import type { ValidatedEnv } from "./env";
import { isUsableAdminApiToken, isWeakAdminKey } from "./adminSession";

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

export function getReadinessReport(env: ValidatedEnv, operationalIssues: ReadinessIssue[] = []): ReadinessReport {
  const production = isProductionRuntime();
  const issues: ReadinessIssue[] = [...operationalIssues];
  const add = (
    severity: ReadinessIssue["severity"],
    key: string,
    message: string,
  ) => issues.push({ severity, key, message });

  if (!env.neonDatabaseUrl) {
    add("critical", "neon", "Database is not configured; admin changes cannot persist.");
  }
  // Admin sign-in is Google only. ADMIN_SESSION_SECRET signs the session cookie and the
  // customer-file links: a guessable one lets anyone forge admin access, so while it is weak
  // sign-in is refused outright (adminSession.ts) — this says why nobody can get in.
  if (isWeakAdminKey(env.adminSessionSecret)) {
    add(
      "critical",
      "admin_session_secret_weak",
      "ADMIN_SESSION_SECRET тохируулаагүй эсвэл хэт богино байна. Энэ түлхүүр админы нэвтрэлтийн cookie-г баталгаажуулдаг — таамаглах боломжтой бол хэн ч админ эрх хуурамчаар үүсгэж чадна. Vercel дээр 48+ санамсаргүй тэмдэгттэй (Sensitive) утга тавиад redeploy хийнэ үү. Энэ утгыг хүн хэзээ ч гараар бичихгүй.",
    );
  }
  // There is no password any more: without Google nobody can open the admin.
  if (production && !env.googleSignInEnabled) {
    add(
      "critical",
      "admin_google_sign_in_off",
      "Google-ээр нэвтрэх тохиргоо дутуу (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / ADMIN_GOOGLE_EMAILS). Нууц үгээр нэвтрэх боломжгүй тул одоо хэн ч админд орж чадахгүй.",
    );
  }
  if (env.googleSignInEnabled && env.adminGoogleEmails.length === 1) {
    add(
      "warning",
      "admin_google_single_account",
      "Зөвхөн 1 Google хаяг нэвтрэх эрхтэй. Тэр хаяг алдагдвал админд хэн ч орж чадахгүй — дор хаяж 2 хаяг (эзэн + ажилтан) нэмнэ үү.",
    );
  }
  // The read-only machine token is optional; when set it must be as strong as the signing key
  // (and never the same value). A weak one is refused, so scripts get 401 until it is fixed.
  if (env.adminApiToken && !isUsableAdminApiToken(env.adminApiToken, env.adminSessionSecret)) {
    add(
      "critical",
      "admin_api_token_weak",
      "ADMIN_API_TOKEN хэт богино эсвэл ADMIN_SESSION_SECRET-тэй ижил байна. 48+ санамсаргүй тэмдэгттэй өөр утга тавина уу; тэр болтол скриптүүд админ мэдээлэл уншиж чадахгүй.",
    );
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
