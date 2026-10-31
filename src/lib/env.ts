import { logStartupDiagnostics } from "./observability";

export type ValidatedEnv = {
  openaiApiKey: string;
  verifyToken: string;
  tokenPage: string;
  facebookPageId: string;
  facebookPages: Array<{ pageId: string; token: string }>;
  metaAppSecret: string;
  /** Meta-app migration (docs/meta-app-migration.md): the new app's secret, verify token and
   * page tokens run NEXT to the old app's until cutover. All optional; absent = old app only. */
  metaAppSecretNext: string;
  verifyTokenNext: string;
  /** Page ids whose roster token was replaced from FACEBOOK_PAGES_NEXT (cutover switch). */
  facebookPagesNextIds: string[];
  /** The app the bot itself sends through, to recognise its own message echoes. */
  metaAppId: string;
  /** Echo-based takeover stays observe-only until real echoes prove the classification. */
  echoTakeoverMode: "observe" | "enforce";
  /** App ids proven to be a human inbox surface; only these may ever count as a consultant. */
  echoHumanAppIds: string[];
  adminSecret: string;
  adminOpenAccess: boolean;
  allowAdminSecretQuery: boolean;
  trustProxyHeaders: boolean;
  neonDatabaseUrl: string | null;
  redisStateEnabled: boolean;
  redisRateLimitEnabled: boolean;
  redisReplayEnabled: boolean;
  redisConversationEnabled: boolean;
  redisPauseEnabled: boolean;
  redisUrl: string | null;
  redisKeyPrefix: string;
  redisConnectTimeoutMs: number;
  redisCommandTimeoutMs: number;
  redisLockTtlMs: number;
  observabilityLogSinkUrl: string | null;
  observabilityErrorSinkUrl: string | null;
  observabilitySinkToken: string | null;
  observabilitySinkTimeoutMs: number;
  observabilitySinkBatchSize: number;
  demoMaxTextChars: number;
  demoGlobalRateLimit: number;
  adminAuthRateLimit: number;
  webhookMaxBodyBytes: number;
  rateLimitMaxBuckets: number;
  rateLimitSweepInterval: number;
  conversationMaxSessions: number;
  pauseMaxSenders: number;
  openaiTimeoutMs: number;
  openaiMaxRetries: number;
  openaiRetryBaseDelayMs: number;
  openaiCircuitFailureThreshold: number;
  openaiCircuitCooldownMs: number;
  metaApiTimeoutMs: number;
  metaSubscribeMaxRetries: number;
  metaRetryBaseDelayMs: number;
  webhookMaxPendingConversations: number;
  staffNotifyPsids: string[];
  // Optional Telegram fallback for staff lead alerts. Telegram has no 24h
  // messaging window, so it delivers even when the Messenger RESPONSE-type
  // staff ping is blocked by Meta's policy. Off unless both are set.
  telegramBotToken: string | null;
  telegramStaffChatIds: string[];
  googleDriveSyncEnabled: boolean;
  googleDriveFolderId: string | null;
  googleDriveServiceAccountEmail: string | null;
  googleDrivePrivateKey: string | null;
  googleDriveSyncIntervalMinutes: number;
  googleDriveSyncFileLimit: number;
  cloudinaryCloudName: string | null;
  cloudinaryApiKey: string | null;
  cloudinaryApiSecret: string | null;
  // Mass broadcast to past leads. OFF by default: sending RESPONSE-type
  // messages to recipients outside Meta's 24h window violates policy and can
  // get the page suspended. Only enable when the audience/compliance is understood.
  broadcastEnabled: boolean;
  qpayEnabled: boolean;
  qpayBaseUrl: string | null;
  qpayUsername: string | null;
  qpayPassword: string | null;
  qpayInvoiceCode: string | null;
};

let cachedEnv: ValidatedEnv | null = null;

function readRequiredString(
  name: string,
  source: NodeJS.ProcessEnv,
  errors: string[],
): string {
  const raw = source[name];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    errors.push(`${name} is required and must be a non-empty string`);
    return "";
  }
  return raw.trim();
}

function readOptionalString(
  name: string,
  source: NodeJS.ProcessEnv,
): string | null {
  const raw = source[name];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length ? trimmed : null;
}

function buildRedisUrlFromUpstashRest(
  source: NodeJS.ProcessEnv,
  errors: string[],
): string | null {
  const restUrl = readOptionalString("UPSTASH_REDIS_REST_URL", source);
  const restToken = readOptionalString("UPSTASH_REDIS_REST_TOKEN", source);
  if (!restUrl && !restToken) return null;

  if (!restUrl || !restToken) {
    errors.push(
      "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set together",
    );
    return null;
  }

  try {
    const parsed = new URL(restUrl);
    if (parsed.protocol !== "https:") {
      errors.push("UPSTASH_REDIS_REST_URL must start with https://");
      return null;
    }
    const host = parsed.hostname;
    if (!host) {
      errors.push("UPSTASH_REDIS_REST_URL must include a host");
      return null;
    }
    const encodedToken = encodeURIComponent(restToken);
    return `rediss://default:${encodedToken}@${host}:6379`;
  } catch {
    errors.push("UPSTASH_REDIS_REST_URL must be a valid URL");
    return null;
  }
}

function readRequiredStringFromNames(
  names: string[],
  source: NodeJS.ProcessEnv,
  errors: string[],
): string {
  for (const name of names) {
    const raw = source[name];
    if (typeof raw === "string" && raw.trim().length > 0) {
      return raw.trim();
    }
  }

  const primary = names[0];
  const aliases = names.slice(1);
  if (aliases.length) {
    errors.push(
      `${primary} is required and must be a non-empty string (accepted aliases: ${aliases.join(", ")})`,
    );
  } else {
    errors.push(`${primary} is required and must be a non-empty string`);
  }
  return "";
}

/**
 * Builds the roster of Facebook pages this deployment serves. One deployment can
 * serve several pages, each with its own page-access token.
 *
 * Preferred format: `FACEBOOK_PAGES=pageId1:token1,pageId2:token2`. Tokens may
 * themselves contain `:`, so each entry is split on the FIRST colon only.
 *
 * Back-compat: when `FACEBOOK_PAGES` is absent, fall back to the legacy single
 * pair `FACEBOOK_PAGE_ID` + `TOKEN_PAGE`. At least one page must resolve, or this
 * pushes a validation error.
 */
function parseFacebookPages(
  source: NodeJS.ProcessEnv,
  legacyPageId: string,
  legacyToken: string,
  errors: string[],
): Array<{ pageId: string; token: string }> {
  const raw = readOptionalString("FACEBOOK_PAGES", source);
  const pages: Array<{ pageId: string; token: string }> = [];
  const seen = new Set<string>();

  if (raw) {
    for (const entry of raw.split(",")) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const sep = trimmed.indexOf(":");
      if (sep <= 0) {
        errors.push(
          `FACEBOOK_PAGES entry "${trimmed}" must be in the form pageId:token`,
        );
        continue;
      }
      const pageId = trimmed.slice(0, sep).trim();
      const token = trimmed.slice(sep + 1).trim();
      if (!pageId || !token) {
        errors.push(
          `FACEBOOK_PAGES entry "${trimmed}" must have a non-empty pageId and token`,
        );
        continue;
      }
      if (seen.has(pageId)) {
        // Last definition wins; keep the roster unique by page id.
        const existing = pages.findIndex((p) => p.pageId === pageId);
        if (existing >= 0) pages[existing] = { pageId, token };
        continue;
      }
      seen.add(pageId);
      pages.push({ pageId, token });
    }
  }

  // Legacy single-page fallback / supplement: include the legacy pair if it is set
  // and not already represented by FACEBOOK_PAGES.
  if (legacyPageId && legacyToken && !seen.has(legacyPageId)) {
    seen.add(legacyPageId);
    pages.push({ pageId: legacyPageId, token: legacyToken });
  }

  if (!pages.length) {
    errors.push(
      "At least one Facebook page must be configured via FACEBOOK_PAGES (pageId:token,...) or the legacy TOKEN_PAGE + FACEBOOK_PAGE_ID pair",
    );
  }

  return pages;
}

/**
 * Cutover switch for the Meta-app migration: `FACEBOOK_PAGES_NEXT=pageId:token,...` replaces
 * that page's roster token with the NEW app's page token — every send, thread lookup and cron
 * for that page moves to the new app in one deploy. A page id that is not already in the
 * roster is a configuration mistake (a typo would silently leave the old token live), so it
 * fails validation instead of being ignored. Requires META_APP_SECRET_NEXT, because
 * `appsecret_proof` must be computed with the secret of the app that issued the token.
 */
function applyFacebookPagesNext(
  source: NodeJS.ProcessEnv,
  pages: Array<{ pageId: string; token: string }>,
  metaAppSecretNext: string,
  errors: string[],
): string[] {
  const raw = readOptionalString("FACEBOOK_PAGES_NEXT", source);
  if (!raw) return [];
  const overridden: string[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(":");
    const pageId = sep > 0 ? trimmed.slice(0, sep).trim() : "";
    const token = sep > 0 ? trimmed.slice(sep + 1).trim() : "";
    if (!pageId || !token) {
      errors.push(`FACEBOOK_PAGES_NEXT entry "${trimmed.slice(0, 20)}…" must be in the form pageId:token`);
      continue;
    }
    const existing = pages.findIndex((page) => page.pageId === pageId);
    if (existing < 0) {
      errors.push(`FACEBOOK_PAGES_NEXT page ${pageId} is not in FACEBOOK_PAGES / the legacy pair; refusing a token for an unknown page`);
      continue;
    }
    pages[existing] = { pageId, token };
    overridden.push(pageId);
  }
  if (overridden.length && !metaAppSecretNext) {
    errors.push("FACEBOOK_PAGES_NEXT requires META_APP_SECRET_NEXT (appsecret_proof must use the new app's secret)");
  }
  return overridden;
}

/**
 * The app secret that matches this page token (`appsecret_proof` = HMAC(secret, token) is only
 * valid with the secret of the app that issued the token). Unknown tokens get the primary
 * secret; never throws, so pure classification tests run without a full environment.
 */
const tokenSecrets = new Map<string, string>();
export function appSecretForToken(token: string): string {
  try {
    const env = getEnv();
    return tokenSecrets.get(token) || env.metaAppSecret;
  } catch {
    return "";
  }
}

function readBoolean(
  name: string,
  source: NodeJS.ProcessEnv,
  defaultValue: boolean,
  errors: string[],
): boolean {
  const raw = source[name];
  if (typeof raw !== "string" || raw.trim().length === 0) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  errors.push(`${name} must be "true" or "false"`);
  return defaultValue;
}

function readPositiveInt(
  name: string,
  source: NodeJS.ProcessEnv,
  defaultValue: number,
  min: number,
  max: number,
  errors: string[],
): number {
  const raw = source[name];
  if (typeof raw !== "string" || raw.trim().length === 0) return defaultValue;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    errors.push(`${name} must be an integer`);
    return defaultValue;
  }
  if (parsed < min) {
    errors.push(`${name} must be >= ${min}`);
    return defaultValue;
  }
  if (parsed > max) {
    errors.push(`${name} must be <= ${max}`);
    return defaultValue;
  }
  return parsed;
}

function readPositiveIntFromNames(
  names: string[],
  source: NodeJS.ProcessEnv,
  defaultValue: number,
  min: number,
  max: number,
  errors: string[],
): number {
  for (const name of names) {
    const raw = source[name];
    if (typeof raw === "string" && raw.trim().length > 0) {
      return readPositiveInt(name, source, defaultValue, min, max, errors);
    }
  }
  return defaultValue;
}

export function getEnv(): ValidatedEnv {
  if (cachedEnv) return cachedEnv;

  const source = process.env;
  const errors: string[] = [];

  const openaiApiKey = readRequiredString("OPENAI_API_KEY", source, errors);
  const verifyToken = readRequiredString("VERIFY_TOKEN", source, errors);
  // Legacy single-page vars are now OPTIONAL — they feed the multi-page roster
  // below as a fallback. parseFacebookPages enforces "at least one page".
  const legacyTokenPage = readOptionalString("TOKEN_PAGE", source) || "";
  const legacyFacebookPageId = readOptionalString("FACEBOOK_PAGE_ID", source) || "";
  const facebookPages = parseFacebookPages(
    source,
    legacyFacebookPageId,
    legacyTokenPage,
    errors,
  );
  const metaAppSecret = readRequiredStringFromNames(
    ["META_APP_SECRET", "FACEBOOK_APP_SECRET", "INSTAGRAM_APP_SECRET_KEY"],
    source,
    errors,
  );
  const metaAppSecretNext = readOptionalString("META_APP_SECRET_NEXT", source) || "";
  const verifyTokenNext = readOptionalString("VERIFY_TOKEN_NEXT", source) || "";
  const metaAppId = readOptionalString("META_APP_ID", source) || "";
  // Which tokens belong to which app, before the NEXT override rewrites the roster.
  tokenSecrets.clear();
  for (const page of facebookPages) tokenSecrets.set(page.token, metaAppSecret);
  if (legacyTokenPage) tokenSecrets.set(legacyTokenPage, metaAppSecret);
  const facebookPagesNextIds = applyFacebookPagesNext(source, facebookPages, metaAppSecretNext, errors);
  for (const page of facebookPages) {
    if (facebookPagesNextIds.includes(page.pageId)) tokenSecrets.set(page.token, metaAppSecretNext || metaAppSecret);
  }
  const echoTakeoverModeRaw = (readOptionalString("ECHO_TAKEOVER_MODE", source) || "observe").toLowerCase();
  if (echoTakeoverModeRaw !== "observe" && echoTakeoverModeRaw !== "enforce") {
    errors.push('ECHO_TAKEOVER_MODE must be "observe" or "enforce"');
  }
  const echoTakeoverMode: "observe" | "enforce" = echoTakeoverModeRaw === "enforce" ? "enforce" : "observe";
  const echoHumanAppIds = (readOptionalString("ECHO_HUMAN_APP_IDS", source) || "")
    .split(",").map((id) => id.trim()).filter(Boolean);
  // Keep the singular fields populated (back-compat consumers, IG fallback, tests). The roster
  // (NEXT override included) wins for the primary page's token, so staff alerts and the webhook
  // fallback token follow the cutover; the legacy var only covers a page outside the roster.
  const primaryPage = facebookPages[0];
  const facebookPageId = legacyFacebookPageId || primaryPage?.pageId || "";
  const tokenPage =
    facebookPages.find((page) => page.pageId === facebookPageId)?.token ||
    legacyTokenPage || primaryPage?.token || "";
  const adminSecret = readRequiredString("ADMIN_SECRET", source, errors);
  const adminOpenAccess = readBoolean(
    "ADMIN_OPEN_ACCESS",
    source,
    false,
    errors,
  );
  const neonDatabaseUrl =
    readOptionalString("NEON_DATABASE_URL", source) ||
    readOptionalString("DATABASE_URL", source);

  const trustProxyHeaders = readBoolean(
    "TRUST_PROXY_HEADERS",
    source,
    Boolean(source.VERCEL),
    errors,
  );
  const allowAdminSecretQuery = readBoolean(
    "ALLOW_ADMIN_SECRET_QUERY",
    source,
    false,
    errors,
  );
  const redisConfigured = Boolean(
    source.REDIS_URL ||
      (source.UPSTASH_REDIS_REST_URL && source.UPSTASH_REDIS_REST_TOKEN),
  );
  const redisStateEnabled = readBoolean(
    "REDIS_STATE_ENABLED",
    source,
    redisConfigured,
    errors,
  );
  const redisRateLimitEnabled = readBoolean(
    "REDIS_RATE_LIMIT_ENABLED",
    source,
    redisStateEnabled,
    errors,
  );
  const redisReplayEnabled = readBoolean(
    "REDIS_REPLAY_ENABLED",
    source,
    redisStateEnabled,
    errors,
  );
  const redisConversationEnabled = readBoolean(
    "REDIS_CONVERSATION_ENABLED",
    source,
    redisStateEnabled,
    errors,
  );
  const redisPauseEnabled = readBoolean(
    "REDIS_PAUSE_ENABLED",
    source,
    redisStateEnabled,
    errors,
  );
  const redisUrl =
    readOptionalString("REDIS_URL", source) ||
    buildRedisUrlFromUpstashRest(source, errors);
  const redisKeyPrefix =
    readOptionalString("REDIS_KEY_PREFIX", source) || "uudamtravelbot";

  const redisConnectTimeoutMs = readPositiveInt(
    "REDIS_CONNECT_TIMEOUT_MS",
    source,
    1500,
    100,
    30000,
    errors,
  );
  const redisCommandTimeoutMs = readPositiveInt(
    "REDIS_COMMAND_TIMEOUT_MS",
    source,
    750,
    50,
    10000,
    errors,
  );
  const redisLockTtlMs = readPositiveInt(
    "REDIS_LOCK_TTL_MS",
    source,
    30000,
    5000,
    300000,
    errors,
  );

  const observabilityLogSinkUrl = readOptionalString(
    "OBSERVABILITY_LOG_SINK_URL",
    source,
  );
  const observabilityErrorSinkUrl = readOptionalString(
    "OBSERVABILITY_ERROR_SINK_URL",
    source,
  );
  const observabilitySinkToken = readOptionalString(
    "OBSERVABILITY_SINK_TOKEN",
    source,
  );
  const observabilitySinkTimeoutMs = readPositiveInt(
    "OBSERVABILITY_SINK_TIMEOUT_MS",
    source,
    2000,
    100,
    10000,
    errors,
  );
  const observabilitySinkBatchSize = readPositiveInt(
    "OBSERVABILITY_SINK_BATCH_SIZE",
    source,
    20,
    1,
    200,
    errors,
  );

  const demoMaxTextChars = readPositiveInt(
    "DEMO_MAX_TEXT_CHARS",
    source,
    1000,
    1,
    10000,
    errors,
  );
  const demoGlobalRateLimit = readPositiveInt(
    "DEMO_GLOBAL_RATE_LIMIT",
    source,
    240,
    1,
    100000,
    errors,
  );
  const adminAuthRateLimit = readPositiveInt(
    "ADMIN_AUTH_RATE_LIMIT",
    source,
    20,
    1,
    100000,
    errors,
  );
  const webhookMaxBodyBytes = readPositiveInt(
    "WEBHOOK_MAX_BODY_BYTES",
    source,
    1024 * 1024,
    64 * 1024,
    4 * 1024 * 1024,
    errors,
  );
  const rateLimitMaxBuckets = readPositiveInt(
    "RATE_LIMIT_MAX_BUCKETS",
    source,
    20000,
    1000,
    200000,
    errors,
  );
  const rateLimitSweepInterval = readPositiveInt(
    "RATE_LIMIT_SWEEP_INTERVAL",
    source,
    200,
    1,
    100000,
    errors,
  );
  const conversationMaxSessions = readPositiveInt(
    "CONVERSATION_MAX_SESSIONS",
    source,
    5000,
    100,
    50000,
    errors,
  );
  const pauseMaxSenders = readPositiveInt(
    "PAUSE_MAX_SENDERS",
    source,
    5000,
    100,
    50000,
    errors,
  );
  const openaiTimeoutMs = readPositiveIntFromNames(
    ["OPENAI_TIMEOUT_MS"],
    source,
    15_000,
    1_000,
    120_000,
    errors,
  );
  const openaiMaxRetries = readPositiveIntFromNames(
    ["OPENAI_MAX_RETRIES"],
    source,
    2,
    0,
    5,
    errors,
  );
  const openaiRetryBaseDelayMs = readPositiveIntFromNames(
    ["OPENAI_RETRY_BASE_DELAY_MS"],
    source,
    300,
    50,
    10_000,
    errors,
  );
  const openaiCircuitFailureThreshold = readPositiveIntFromNames(
    ["OPENAI_CIRCUIT_FAILURE_THRESHOLD"],
    source,
    5,
    1,
    50,
    errors,
  );
  const openaiCircuitCooldownMs = readPositiveIntFromNames(
    ["OPENAI_CIRCUIT_COOLDOWN_MS"],
    source,
    30_000,
    1_000,
    300_000,
    errors,
  );
  const metaApiTimeoutMs = readPositiveInt(
    "META_API_TIMEOUT_MS",
    source,
    12_000,
    1_000,
    60_000,
    errors,
  );
  const metaSubscribeMaxRetries = readPositiveInt(
    "META_SUBSCRIBE_MAX_RETRIES",
    source,
    1,
    0,
    5,
    errors,
  );
  const metaRetryBaseDelayMs = readPositiveInt(
    "META_RETRY_BASE_DELAY_MS",
    source,
    300,
    50,
    10_000,
    errors,
  );
  const webhookMaxPendingConversations = readPositiveInt(
    "WEBHOOK_MAX_PENDING_CONVERSATIONS",
    source,
    5000,
    100,
    100_000,
    errors,
  );
  const staffNotifyPsids = (readOptionalString("STAFF_NOTIFY_PSIDS", source) || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const telegramBotToken = readOptionalString("TELEGRAM_BOT_TOKEN", source);
  // TELEGRAM_CHAT_ID is the name Production has used since the start (the partner-sync notices
  // went there until 2026-10-28); TELEGRAM_STAFF_CHAT_IDS, when set, takes precedence.
  const telegramStaffChatIds = (readOptionalString("TELEGRAM_STAFF_CHAT_IDS", source) || readOptionalString("TELEGRAM_CHAT_ID", source) || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const googleDriveSyncEnabled = readBoolean(
    "GOOGLE_DRIVE_SYNC_ENABLED",
    source,
    false,
    errors,
  );
  const googleDriveFolderId = readOptionalString("GOOGLE_DRIVE_FOLDER_ID", source);
  const googleDriveServiceAccountEmail = readOptionalString(
    "GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL",
    source,
  );
  const googleDrivePrivateKey = readOptionalString(
    "GOOGLE_DRIVE_PRIVATE_KEY",
    source,
  );
  const googleDriveSyncIntervalMinutes = readPositiveInt(
    "GOOGLE_DRIVE_SYNC_INTERVAL_MINUTES",
    source,
    30,
    1,
    24 * 60,
    errors,
  );
  const googleDriveSyncFileLimit = readPositiveInt(
    "GOOGLE_DRIVE_SYNC_FILE_LIMIT",
    source,
    500,
    1,
    5_000,
    errors,
  );

  const cloudinaryCloudName = readOptionalString("CLOUDINARY_CLOUD_NAME", source);
  const cloudinaryApiKey = readOptionalString("CLOUDINARY_API_KEY", source);
  const cloudinaryApiSecret = readOptionalString("CLOUDINARY_API_SECRET", source);

  const broadcastEnabled = readBoolean("BROADCAST_ENABLED", source, false, errors);

  // QPay (optional, OFF by default). The feature only activates when
  // QPAY_ENABLED=true AND all credentials are present (see qpay.ts isQPayConfigured).
  const qpayEnabled = readBoolean("QPAY_ENABLED", source, false, errors);
  const qpayBaseUrl = readOptionalString("QPAY_BASE_URL", source);
  const qpayUsername = readOptionalString("QPAY_USERNAME", source);
  const qpayPassword = readOptionalString("QPAY_PASSWORD", source);
  const qpayInvoiceCode = readOptionalString("QPAY_INVOICE_CODE", source);

  const anyRedisFeatureEnabled =
    redisRateLimitEnabled ||
    redisReplayEnabled ||
    redisConversationEnabled ||
    redisPauseEnabled;
  if (anyRedisFeatureEnabled && !redisUrl) {
    errors.push(
      "REDIS_URL is required when any REDIS_*_ENABLED feature flag is true",
    );
  }
  if (adminOpenAccess && source.NODE_ENV === "production") {
    errors.push(
      "ADMIN_OPEN_ACCESS cannot be true in production. Set ADMIN_OPEN_ACCESS=false and require authenticated admin access.",
    );
  }
  if (
    googleDriveSyncEnabled &&
    (!googleDriveFolderId ||
      !googleDriveServiceAccountEmail ||
      !googleDrivePrivateKey)
  ) {
    errors.push(
      "GOOGLE_DRIVE_SYNC_ENABLED requires GOOGLE_DRIVE_FOLDER_ID, GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL, and GOOGLE_DRIVE_PRIVATE_KEY",
    );
  }

  if (errors.length) {
    throw new Error(
      `Invalid server environment configuration:\n- ${errors.join("\n- ")}`,
    );
  }

  cachedEnv = {
    openaiApiKey,
    verifyToken,
    tokenPage,
    facebookPageId,
    facebookPages,
    metaAppSecret,
    metaAppSecretNext,
    verifyTokenNext,
    facebookPagesNextIds,
    metaAppId,
    echoTakeoverMode,
    echoHumanAppIds,
    adminSecret,
    adminOpenAccess,
    allowAdminSecretQuery,
    trustProxyHeaders,
    neonDatabaseUrl,
    redisStateEnabled,
    redisRateLimitEnabled,
    redisReplayEnabled,
    redisConversationEnabled,
    redisPauseEnabled,
    redisUrl,
    redisKeyPrefix,
    redisConnectTimeoutMs,
    redisCommandTimeoutMs,
    redisLockTtlMs,
    observabilityLogSinkUrl,
    observabilityErrorSinkUrl,
    observabilitySinkToken,
    observabilitySinkTimeoutMs,
    observabilitySinkBatchSize,
    demoMaxTextChars,
    demoGlobalRateLimit,
    adminAuthRateLimit,
    webhookMaxBodyBytes,
    rateLimitMaxBuckets,
    rateLimitSweepInterval,
    conversationMaxSessions,
    pauseMaxSenders,
    openaiTimeoutMs,
    openaiMaxRetries,
    openaiRetryBaseDelayMs,
    openaiCircuitFailureThreshold,
    openaiCircuitCooldownMs,
    metaApiTimeoutMs,
    metaSubscribeMaxRetries,
    metaRetryBaseDelayMs,
    webhookMaxPendingConversations,
    staffNotifyPsids,
    telegramBotToken,
    telegramStaffChatIds,
    googleDriveSyncEnabled,
    googleDriveFolderId,
    googleDriveServiceAccountEmail,
    googleDrivePrivateKey,
    googleDriveSyncIntervalMinutes,
    googleDriveSyncFileLimit,
    cloudinaryCloudName,
    cloudinaryApiKey,
    cloudinaryApiSecret,
    broadcastEnabled,
    qpayEnabled,
    qpayBaseUrl,
    qpayUsername,
    qpayPassword,
    qpayInvoiceCode,
  };

  logStartupDiagnostics("env", {
    trustProxyHeaders: cachedEnv.trustProxyHeaders,
    allowAdminSecretQuery: cachedEnv.allowAdminSecretQuery,
    facebookPageCount: cachedEnv.facebookPages.length,
    facebookPageIds: cachedEnv.facebookPages.map((p) => p.pageId),
    // Meta-app migration state (names and flags only, never values).
    facebookPagesNextIds: cachedEnv.facebookPagesNextIds,
    metaAppSecretNextSet: Boolean(cachedEnv.metaAppSecretNext),
    verifyTokenNextSet: Boolean(cachedEnv.verifyTokenNext),
    metaAppIdSet: Boolean(cachedEnv.metaAppId),
    echoTakeoverMode: cachedEnv.echoTakeoverMode,
    echoHumanAppIdCount: cachedEnv.echoHumanAppIds.length,
    redisStateEnabled: cachedEnv.redisStateEnabled,
    redisRateLimitEnabled: cachedEnv.redisRateLimitEnabled,
    redisReplayEnabled: cachedEnv.redisReplayEnabled,
    redisConversationEnabled: cachedEnv.redisConversationEnabled,
    redisPauseEnabled: cachedEnv.redisPauseEnabled,
    redisConfigured: Boolean(cachedEnv.redisUrl),
    redisKeyPrefix: cachedEnv.redisKeyPrefix,
    redisConnectTimeoutMs: cachedEnv.redisConnectTimeoutMs,
    redisCommandTimeoutMs: cachedEnv.redisCommandTimeoutMs,
    redisLockTtlMs: cachedEnv.redisLockTtlMs,
    observabilityLogSinkEnabled: Boolean(cachedEnv.observabilityLogSinkUrl),
    observabilityErrorSinkEnabled: Boolean(cachedEnv.observabilityErrorSinkUrl),
    observabilitySinkTimeoutMs: cachedEnv.observabilitySinkTimeoutMs,
    observabilitySinkBatchSize: cachedEnv.observabilitySinkBatchSize,
    webhookMaxBodyBytes: cachedEnv.webhookMaxBodyBytes,
    rateLimitMaxBuckets: cachedEnv.rateLimitMaxBuckets,
    conversationMaxSessions: cachedEnv.conversationMaxSessions,
    pauseMaxSenders: cachedEnv.pauseMaxSenders,
    openaiTimeoutMs: cachedEnv.openaiTimeoutMs,
    openaiMaxRetries: cachedEnv.openaiMaxRetries,
    metaApiTimeoutMs: cachedEnv.metaApiTimeoutMs,
    metaSubscribeMaxRetries: cachedEnv.metaSubscribeMaxRetries,
    webhookMaxPendingConversations: cachedEnv.webhookMaxPendingConversations,
    googleDriveSyncEnabled: cachedEnv.googleDriveSyncEnabled,
    googleDriveFolderConfigured: Boolean(cachedEnv.googleDriveFolderId),
    googleDriveServiceAccountConfigured: Boolean(
      cachedEnv.googleDriveServiceAccountEmail &&
        cachedEnv.googleDrivePrivateKey,
    ),
    googleDriveSyncIntervalMinutes: cachedEnv.googleDriveSyncIntervalMinutes,
    googleDriveSyncFileLimit: cachedEnv.googleDriveSyncFileLimit,
    runtime: {
      nodeEnv: source.NODE_ENV || null,
      vercel: Boolean(source.VERCEL),
      vercelEnv: source.VERCEL_ENV || null,
    },
    adminOpenAccess: cachedEnv.adminOpenAccess,
    neonDbConfigured: Boolean(cachedEnv.neonDatabaseUrl),
  });

  return cachedEnv;
}

export function resetEnvCacheForTests() {
  cachedEnv = null;
  tokenSecrets.clear();
}
