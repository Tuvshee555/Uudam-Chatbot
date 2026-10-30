import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

function collectTestFiles(rootDir) {
  const files = [];

  function walk(currentDir) {
    for (const entry of readdirSync(currentDir)) {
      const absolutePath = join(currentDir, entry);
      const stats = statSync(absolutePath);

      if (stats.isDirectory()) {
        walk(absolutePath);
        continue;
      }

      if (entry.endsWith(".test.ts")) {
        files.push(relative(process.cwd(), absolutePath));
      }
    }
  }

  walk(rootDir);
  return files.sort();
}

const testFiles = collectTestFiles(join(process.cwd(), "tests"));

if (testFiles.length === 0) {
  console.error("No test files were found under tests/.");
  process.exit(1);
}

// Routine tests run on mocked model responses only. Real credentials are removed and a fake key
// set, so a test that escapes its mock fails instead of spending credit (the production balance ran
// out on 2026-10-30). Live-model evaluation is a separate, approved run (scripts/lib/evalGuard.mjs).
// Real databases and delivery channels are removed too, as the conversation gate does: a test
// that escapes its mocks must fail, never write test rows into the production tables (fixture
// page rows reached travel_page_control from runs with production settings loaded).
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/OPENAI|ANTHROPIC|GEMINI|^EVAL_|^LIVE_REPLAY_/i.test(key)) delete env[key];
  if (/DATABASE_URL|^NEON_|^BOOKING_|^REDIS_URL|^UPSTASH|^KV_|^STAFF_NOTIFY|^TELEGRAM_/i.test(key)) delete env[key];
}
env.OPENAI_API_KEY = "test-openai-key-mocked";
env.AI_USAGE_ENVIRONMENT = "test";

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...testFiles],
  {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
  },
);

if (typeof result.status === "number") {
  process.exit(result.status);
}

process.exit(1);
