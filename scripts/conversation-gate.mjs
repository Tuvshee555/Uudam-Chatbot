import { spawnSync } from "node:child_process";

// The gate never loads .env files. The child uses only inert credentials and
// mocked PG/provider transports; inherited production endpoints are removed.
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/TOKEN|SECRET|API_KEY|DATABASE_URL|^NEON_|^REDIS|^UPSTASH|^VERCEL|^BOOKING_|^STAFF_|^TELEGRAM_|_SINK_|^GOOGLE_DRIVE_|^FACEBOOK_PAGES$/i.test(key)) delete env[key];
}
Object.assign(env, { NODE_ENV: "test", OPENAI_API_KEY: "conversation-fixture-key", VERIFY_TOKEN: "conversation-fixture-token",
  TOKEN_PAGE: "conversation-fixture-token", FACEBOOK_PAGE_ID: "1234567890", META_APP_SECRET: "test-meta-secret",
  ADMIN_SECRET: "conversation-fixture-secret", REDIS_STATE_ENABLED: "false", REDIS_RATE_LIMIT_ENABLED: "false",
  REDIS_REPLAY_ENABLED: "false", REDIS_CONVERSATION_ENABLED: "false", REDIS_PAUSE_ENABLED: "false" });
// Customer journeys come first: each is the shape of real conversations that failed in production
// (docs/chatbot-forensic-audit.md). This gate runs in CI and in the Vercel prebuild, so a change that
// breaks a journey cannot deploy.
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-reporter=spec",
  "tests/conversation-journeys.test.ts", "tests/forensic-regressions.test.ts", "tests/conversation-followups.test.ts",
  "tests/list-card-dates.test.ts", "tests/inbound-visibility.test.ts",
  "tests/webhook-conversations.test.ts", "tests/demo-conversation-parity.test.ts", "tests/webhook-durable-handoff.test.ts", "tests/website-chat-webhook.test.ts",
  "tests/staff-takeover-journeys.test.ts"],
{ cwd: process.cwd(), env, stdio: "inherit" });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
