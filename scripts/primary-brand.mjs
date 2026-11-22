// Runs a node command as the PRIMARY brand (src/lib/brand.ts). The build-time checks (prebuild) and
// the test suites describe the primary's replies, so a secondary brand's deployment (BRAND=magnai)
// still runs them as the primary; the secondary's own behaviour has its own tests
// (tests/brand-secondary.test.ts), which set BRAND themselves.
// Usage: node scripts/primary-brand.mjs <node arguments…>
import { spawnSync } from "node:child_process";

const env = { ...process.env };
for (const key of Object.keys(env)) if (/^BRAND(?:_|$)/.test(key)) delete env[key];
const result = spawnSync(process.execPath, process.argv.slice(2), { stdio: "inherit", env });
process.exit(result.status ?? 1);
