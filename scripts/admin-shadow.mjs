// Admin shadow: what did staff do in the two admin panels, and does each of those
// actions still work? Strictly read-only against production.
//
//   1. Reads Vercel request logs for the chatbot admin (uudam-chatbot) and the
//      website admin (uudam-booking-web) and keeps only real staff browsers
//      (scripts, headless browsers, curl and crawlers are dropped).
//   2. Prints what they did: sessions, sections opened, every save, every error
//      they were shown, failed sign-ins, password resets.
//   3. Shadows each action without repeating it:
//        - a website trip save  → checks in the DB that it landed, reached the
//          chatbot (no queued/ignored/conflicting fields) and that the website
//          and chatbot quote the same per-date prices; its public page answers.
//        - an AI file parse     → flags a parse that was never saved.
//        - every chatbot admin screen they opened → is requested again with the
//          read-only machine token (GET only; the server refuses it for anything
//          else; website-sync is skipped because its GET flushes the queue) and
//          must answer 200 in reasonable time.
//
//   node scripts/admin-shadow.mjs [--since 24h] [--no-replay]
//   The replay reads ADMIN_API_TOKEN from .env.local (the same value as in Vercel
//   production; it can only read). ADMIN_SHADOW_TOKEN overrides it. Without one the
//   replay is skipped with a warning; the log and DB checks still run.
//   Needs the Vercel CLI login (npx vercel@latest) and NEON_DATABASE_URL in .env.local.
//   Writes tmp/admin-shadow/<timestamp>.md and exits 1 when a check fails.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import pg from "pg";

const args = process.argv.slice(2);
const since = args.includes("--since") ? args[args.indexOf("--since") + 1] : "24h";
const replay = !args.includes("--no-replay");
const TEAM = "tuvshinsaihans-projects";
const BOT = { project: "uudam-chatbot", base: "https://uudam-chatbot.vercel.app" };
const WEB = { project: "uudam-booking-web", base: "https://uudamtravel.mn" };
const env = parseEnv(readFileSync(".env.local", "utf8"));
const ubTime = (iso) => new Date(Date.parse(iso) + 8 * 3600e3).toISOString().slice(5, 16).replace("T", " ");

const out = [];
const failures = [];
const log = (line = "") => { out.push(line); console.log(line); };
const fail = (line) => { failures.push(line); log(`- ❌ ${line}`); };
const pass = (line) => log(`- ✅ ${line}`);

function requests(project, query) {
  const win = process.platform === "win32";
  // npx is a .cmd on Windows, which needs a shell, so every argument is quoted for it.
  const argv = ["-y", "vercel@latest", "logs", "requests", "-p", project, "--scope", TEAM, "-e", "production",
    "--since", since, "-n", "10000", "--json", "-q", query].map((arg) => (win ? `"${arg}"` : arg));
  const raw = execFileSync(win ? "npx.cmd" : "npx", argv,
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"], shell: win });
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    .filter((row) => row.type === "request").map((row) => row.data).reverse();
}

const NOT_STAFF = /HeadlessChrome|^node$|curl\/|PowerShell|bot\/|Googlebot|bingbot|python|axios|undici|vercel/i;
const isStaff = (row) => row.clientUserAgent && !NOT_STAFF.test(row.clientUserAgent);
const isWrite = (row) => !["GET", "HEAD", "OPTIONS"].includes(row.requestMethod);
const device = (ua) => /iPhone|Android/.test(ua) ? "phone" : /Windows/.test(ua) ? "Windows PC" : /Mac OS/.test(ua) ? "Mac" : "other";
const POLLS = new Set(["/api/admin/leads", "/api/admin/summary", "/api/pause", "/api/admin/session", "/api/admin/customer-image", "/api/admin/conversation-attachment"]);

log(`# Admin shadow — last ${since} (generated ${ubTime(new Date().toISOString())} UB)`);

const bot = requests(BOT.project, "requestPath:/api/admin* OR requestPath:/admin*").filter(isStaff).map((r) => ({ ...r, app: "chatbot" }));
const web = requests(WEB.project, "requestPath:/mn/admin* OR requestPath:/api/admin* OR requestPath:/api/users* OR requestPath:/api/trips* OR requestPath:/api/departures* OR requestPath:/api/settings*")
  .filter(isStaff).filter((r) => r.requestPath.includes("/admin") || isWrite(r)).map((r) => ({ ...r, app: "website" }));
const all = [...bot, ...web].sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));

log("\n## Who");
const devices = {};
for (const row of all) devices[`${row.app} · ${device(row.clientUserAgent)} · ${row.clientIpCountry}`] = (devices[`${row.app} · ${device(row.clientUserAgent)} · ${row.clientIpCountry}`] || 0) + 1;
for (const [key, count] of Object.entries(devices)) log(`- ${key}: ${count} requests`);
if (!all.length) log("- No staff activity in this window.");

// Sessions: activity separated by 30+ minutes of silence (background polls don't count).
log("\n## What they did (UB time)");
let lastAt = 0; let lastLine = "";
for (const row of all) {
  const path = row.requestPath.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id");
  if (POLLS.has(row.requestPath) && !isWrite(row) && row.httpStatus < 400) continue;
  if (/\/edit$/.test(row.requestPath) && !isWrite(row)) continue; // mostly link prefetches
  const at = Date.parse(row.timestamp);
  if (at - lastAt > 30 * 60e3) log(`\n**Session ${ubTime(row.timestamp)}**`);
  lastAt = at;
  const line = `${row.app} ${row.requestMethod} ${path} → ${row.httpStatus}`;
  if (line === lastLine) continue;
  lastLine = line;
  const flag = row.httpStatus >= 400 ? " ⚠️" : isWrite(row) ? " ✏️" : "";
  log(`- ${ubTime(row.timestamp)} ${line}${flag}`);
}

log("\n## Errors staff were shown");
const errors = {};
for (const row of all) if (row.httpStatus >= 400) {
  const key = `${row.app} ${row.requestMethod} ${row.requestPath.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id")} ${row.httpStatus}`;
  (errors[key] ||= []).push(ubTime(row.timestamp));
}
const wrongPassword = (key) => /POST \/api\/admin\/session 401|POST \/api\/users\/login 401/.test(key);
for (const [key, times] of Object.entries(errors)) {
  const text = `${key} ×${times.length} (${times.slice(0, 4).join(", ")}${times.length > 4 ? ", …" : ""})`;
  if (wrongPassword(key)) log(`- 🔑 wrong password: ${text}`);
  // A GET 401 is a tab whose sign-in ran out; it is a problem only when it repeats for long.
  else if (/ GET .* 401$/.test(key) && times.length < 30) log(`- 🔑 signed out (session ran out): ${text}`);
  else fail(text);
}
if (!Object.keys(errors).length) pass("none");
const resets = web.filter((r) => r.requestPath === "/api/users/forgot-password");
if (resets.length) log(`- 🔑 asked for a password reset ${resets.length}× (${resets.map((r) => ubTime(r.timestamp)).join(", ")}) — reset link used: ${web.some((r) => r.requestPath === "/api/users/reset-password" && isWrite(r)) ? "yes" : "no"}`);

// ── Shadow checks ────────────────────────────────────────────────────────────
log("\n## Shadow checks (nothing is changed)");
const url = new URL(env.NEON_DATABASE_URL || env.DATABASE_URL);
url.searchParams.set("sslmode", "verify-full");
const pool = new pg.Pool({ connectionString: url.toString(), max: 1, statement_timeout: 30000 });
const db = await pool.connect();
await db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
try {
  const saves = web.filter((r) => /^\/api\/trips\/[0-9a-f-]{36}$/.test(r.requestPath) && ["PUT", "PATCH"].includes(r.requestMethod));
  const savedIds = [...new Set(saves.map((r) => r.requestPath.split("/").pop()))];
  log(`\n### Website trip saves: ${saves.length} saves of ${savedIds.length} trips`);
  for (const id of savedIds) {
    const times = saves.filter((r) => r.requestPath.endsWith(id));
    const trip = (await db.query(`SELECT id, slug, title, "isPublished", "sourceTripId", "sourceMetadata" m FROM "Trip" WHERE id=$1`, [id])).rows[0];
    if (!trip) { fail(`${id}: saved ${times.length}× but the trip no longer exists`); continue; }
    const name = `«${trip.title.slice(0, 50)}» (${times.length}× ${times.map((r) => ubTime(r.timestamp).slice(6)).join(", ")})`;
    const problems = [];
    const notes = [];
    // Saving the same trip again and again within minutes = staff could not see their edit take.
    for (let i = 0; i + 2 < times.length; i += 1) {
      const spanMin = (Date.parse(times[i + 2].timestamp) - Date.parse(times[i].timestamp)) / 60e3;
      if (spanMin < 5) { notes.push(`⚠️ saved ${times.length}× in bursts — staff probably did not see the edit take`); break; }
    }
    if (times.some((r) => r.httpStatus >= 400)) problems.push(`a save answered ${times.find((r) => r.httpStatus >= 400).httpStatus}`);
    const pending = trip.m?.websiteSyncPending;
    if (pending) problems.push(`still queued for the chatbot (attempts ${pending.attempts ?? "?"}, ${pending.lastError?.code || "no error yet"})`);
    const report = trip.m?.websiteSyncReport;
    const open = Array.isArray(trip.m?.contentConflicts) ? trip.m.contentConflicts : [];
    if (open.length) problems.push(`${open.length} website↔chatbot conflict(s) still open: ${[...new Set(open.map((x) => x.field))].join(", ")} — staff must pick a side in the editor`);
    // A delivery report is overwritten only by the next save; once nothing is open it is history.
    const said = [...(report?.ignored || []).map((x) => `ignored ${x.field} (${x.reason})`), ...(report?.conflicts?.length ? [`conflict on ${report.conflicts.map((x) => x.field).join(", ")}`] : [])];
    if (said.length) (open.length ? problems : notes).push(`last delivery ${report.at?.slice(5, 16) || ""} UTC: chatbot ${said.join("; ")}${open.length ? "" : " — since resolved"}`);
    if (trip.sourceTripId) {
      const entry = (await db.query("SELECT status, adult_price, extra FROM travel_trip_entries WHERE id=$1", [trip.sourceTripId])).rows[0];
      if (!entry) problems.push(`its chatbot record ${trip.sourceTripId} is missing`);
      else {
        const deps = (await db.query(`SELECT to_char("startDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Ulaanbaatar','YYYY-MM-DD') ymd, price, status FROM "Departure" WHERE "tripId"=$1 AND "startDate" > now()`, [id])).rows;
        const groups = Array.isArray(entry.extra?.price_groups) ? entry.extra.price_groups : [];
        const botPrice = (ymd) => groups.find((g) => (g.dates || []).includes(ymd))?.adult_price ?? null;
        const mismatched = deps.filter((d) => d.status !== "SOLD_OUT" && d.price != null && groups.length && botPrice(d.ymd) != null && Number(botPrice(d.ymd)) !== Number(d.price));
        if (mismatched.length) problems.push(`per-date price differs: ${mismatched.map((d) => `${d.ymd} web ${d.price} / bot ${botPrice(d.ymd)}`).join("; ")}`);
        if (trip.isPublished && entry.status !== "active" && deps.length) problems.push(`website shows it but the chatbot has it ${entry.status}`);
      }
    }
    if (trip.isPublished) {
      const page = await fetch(`${WEB.base}/mn/trips/${encodeURIComponent(trip.slug)}`, { redirect: "manual" }).catch(() => null);
      if (!page || page.status !== 200) problems.push(`public page answered ${page?.status ?? "nothing"}`);
    }
    const extra = notes.length ? ` · ${notes.join(" · ")}` : "";
    if (problems.length) fail(`${name}: ${problems.join(" · ")}${extra}`);
    else pass(`${name}: landed, in sync with the chatbot${report?.applied?.length ? ` (took ${report.applied.join(", ")})` : ""}, prices agree${trip.isPublished ? ", page live" : ", unpublished"}${extra}`);
  }
  if (!savedIds.length) log("- no trip saves");

  const parses = bot.filter((r) => r.requestPath === "/api/admin/parse-file" && r.requestMethod === "POST");
  if (parses.length) {
    log(`\n### AI file → trip (AI туслах): ${parses.length}`);
    for (const parse of parses) {
      const after = all.filter((r) => isWrite(r) && r.timestamp > parse.timestamp && Date.parse(r.timestamp) - Date.parse(parse.timestamp) < 45 * 60e3
        && /trips|poster|ai-change|trips-bulk/.test(r.requestPath));
      if (parse.httpStatus >= 400) fail(`${ubTime(parse.timestamp)} file parse answered ${parse.httpStatus}`);
      else if (!after.length) log(`- ⚠️ ${ubTime(parse.timestamp)} a file was read into a trip draft but nothing was saved within 45 min (abandoned, or the draft was not usable)`);
      else pass(`${ubTime(parse.timestamp)} file parsed and saved (${after.map((r) => r.requestPath).join(", ")})`);
    }
  }

  const stuck = (await db.query(`SELECT title, "sourceMetadata"->'websiteSyncPending' p FROM "Trip" WHERE "sourceMetadata" ? 'websiteSyncPending'`)).rows;
  const botQueue = (await db.query("SELECT trip_id, attempts, last_error FROM trip_website_sync WHERE synced_revision IS DISTINCT FROM revision OR last_error IS NOT NULL")).rows;
  log("\n### Sync queues");
  if (stuck.length) fail(`website → chatbot: ${stuck.length} edit(s) waiting: ${stuck.map((s) => s.title.slice(0, 40)).join(", ")}`); else pass("website → chatbot: empty");
  if (botQueue.length) fail(`chatbot → website: ${botQueue.length} waiting: ${botQueue.map((s) => `${s.trip_id} (${s.last_error || "pending"})`).join(", ")}`); else pass("chatbot → website: empty");
} finally {
  await db.query("ROLLBACK").catch(() => {});
  db.release();
  await pool.end();
}

// Replay the chatbot admin screens staff opened, as GETs with the read-only machine token
// (`Authorization: Bearer <ADMIN_API_TOKEN>`): no sign-in, no session, never a write.
if (replay && bot.length) {
  log("\n### Chatbot admin screens, opened again");
  const QUERIES = { "/api/admin/leads": "?summary=1", "/api/admin/trips": "?search=&status=&limit=300", "/api/admin/analytics": "?days=7", "/api/admin/customer-documents": "?stats=1" };
  const SKIP = new Set(["/api/admin/website-sync", "/api/admin/session", "/api/admin/customer-image", "/api/admin/conversation-attachment", "/api/admin/conversation", "/api/admin/google/start", "/api/admin/google/callback"]);
  const paths = [...new Set(bot.filter((r) => !isWrite(r) && r.requestPath.startsWith("/api/admin/")).map((r) => r.requestPath))].filter((p) => !SKIP.has(p));
  const token = (process.env.ADMIN_SHADOW_TOKEN || env.ADMIN_API_TOKEN || "").trim();
  const headers = { authorization: `Bearer ${token}` };
  // One cheap check first, so a missing or wrong token is one warning, not a failure per screen.
  const probe = token ? await fetch(`${BOT.base}/api/admin/system`, { headers }).catch(() => null) : null;
  const probeBody = probe?.ok ? await probe.json().catch(() => null) : null;
  if (!token) log("- ⚠️ replay skipped: set ADMIN_API_TOKEN in .env.local (read-only, same value as in Vercel)");
  else if (!probeBody?.authorized) log(`- ⚠️ replay skipped: the chatbot refused ADMIN_API_TOKEN (${probe?.status ?? "no answer"}); check it matches Vercel and is 32+ characters`);
  else {
    for (const path of paths) {
      const started = Date.now();
      const res = await fetch(`${BOT.base}${path}${QUERIES[path] || ""}`, { headers }).catch(() => null);
      const ms = Date.now() - started;
      if (!res || res.status !== 200) fail(`${path} answered ${res?.status ?? "nothing"}`);
      else if (ms > 15000) fail(`${path} took ${(ms / 1000).toFixed(1)} s`);
      else pass(`${path} ${ms} ms`);
    }
  }
}

log(`\n## Result: ${failures.length ? `${failures.length} problem(s)` : "everything staff did works"}`);
mkdirSync("tmp/admin-shadow", { recursive: true });
const file = `tmp/admin-shadow/${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.md`;
writeFileSync(file, out.join("\n") + "\n");
console.log(`\nSaved ${file}`);
process.exit(failures.length ? 1 : 0);
