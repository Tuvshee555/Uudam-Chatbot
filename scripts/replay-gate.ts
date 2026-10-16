/**
 * Pre-deploy gate, read-only, no AI calls. Run before pushing any change to how the bot
 * matches trips or decides to answer:
 *   npm run gate              # compare with the saved baseline
 *   npm run gate -- --save    # accept the current behaviour as the new baseline
 *
 * 1. Every real customer message of the last 60 days is resolved to a trip (or none) and
 *    compared with the baseline: each change is printed for a person to judge.
 * 2. Sentences that name no trip must resolve to no trip.
 * 3. Real bot replies of the last 60 days that talk about a trip the conversation never
 *    pointed to are counted (the exit check would now hold them back).
 * 4. The bot's own answers about the live catalogue must pass its own checker.
 *
 * The baseline holds customer text, so it lives in tmp/ (gitignored). No trip, place or
 * price is written in this file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { listTrips } from "../src/lib/travelDb";
import { closeNeonPool, queryNeon } from "../src/lib/neonDb";
import { resolveTripFromUserMessage } from "../src/lib/travelFastPathsSearch";
import { resolveDateQuestionScope } from "../src/lib/travelFastPaths";
import { ungroundedTripInReply } from "../src/lib/tripGrounding";
import { checkSelfConsistency } from "../src/lib/selfConsistency";

const BASELINE = "tmp/replay-gate-baseline.json";
const TRIPLESS = [
  "10.20-23-ны хооронд эхлэх аялал бнуу", "11 сарын 1-ээс 11 сарын 10 хүртэл аялал байна уу", "10 сарын 25-аас хойш гарах аялал",
  "Энэ сарын сүүлээр гарах аялал байна уу", "Найзуудтайгаа хамт явах аялал", "Гэр бүлээрээ явах аялал байна уу",
  "Дулаан газар явмаар байна", "Удаан биш богино аялал", "Уулын аялал", "Амралтын өдрүүдээр", "Оюутан хөнгөлөлт",
  "Хямдхан аялал байна уу", "Шинэ аялал гарсан уу", "Ойрхон газар", "Хоёулаа явна", "vne", "aylal", "medeelel avii",
  "10 сарын аялал", "11/3 naar baina uu?", "Маргааш хийе", "Баярлалаа", "Зураг үзэх", "Хөтөлбөр үзэх",
];

async function main() {
  const save = process.argv.includes("--save");
  const trips = await listTrips();
  const active = trips.filter((trip) => trip.status === "active");
  let failed = false;

  // 1. Real messages → trip decision, against the baseline.
  const messages = ((await queryNeon(`SELECT DISTINCT text FROM travel_conversations WHERE role='user'
    AND created_at > now() - interval '60 days' AND length(text) BETWEEN 2 AND 200 AND text NOT LIKE '[%'`))?.rows || []) as Array<{ text: string }>;
  const decisions: Record<string, string> = {};
  for (const { text } of messages) {
    const r = resolveTripFromUserMessage(text, active, { allowLooseFallback: false });
    decisions[text] = r.status === "verified" ? `trip:${r.trip?.route_name}` : r.status === "ambiguous" ? `list:${r.candidates.length}` : "none";
  }
  if (save || !existsSync(BASELINE)) {
    mkdirSync("tmp", { recursive: true });
    writeFileSync(BASELINE, JSON.stringify(decisions, null, 1));
    console.log(`1. Baseline saved: ${Object.keys(decisions).length} real messages.`);
  } else {
    const before = JSON.parse(readFileSync(BASELINE, "utf8")) as Record<string, string>;
    const changed = Object.keys(decisions).filter((text) => text in before && before[text] !== decisions[text]);
    console.log(`1. Real messages: ${Object.keys(decisions).length}; decisions changed since baseline: ${changed.length}`);
    for (const text of changed.slice(0, 60)) console.log(`   ${JSON.stringify(text.slice(0, 80))}: ${before[text]} → ${decisions[text]}`);
  }

  // 2. Trip-less sentences pick no trip.
  const picked = TRIPLESS.filter((text) => {
    const r = resolveTripFromUserMessage(text, active, { allowLooseFallback: false });
    return r.status === "verified" || resolveDateQuestionScope(text, active).focusTrip;
  });
  console.log(`2. Trip-less sentences that picked a trip: ${picked.length}/${TRIPLESS.length}`);
  for (const text of picked) console.log(`   ✗ ${text}`);
  if (picked.length) failed = true;

  // 3. Past replies the exit check would hold back.
  const rows = ((await queryNeon(`SELECT sender_id, role, text FROM travel_conversations
    WHERE created_at > now() - interval '60 days' ORDER BY sender_id, created_at`))?.rows || []) as Array<{ sender_id: string; role: "user" | "assistant"; text: string }>;
  let held = 0;
  let checked = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].role !== "assistant") continue;
    let u = i - 1;
    while (u >= 0 && rows[u].sender_id === rows[i].sender_id && rows[u].role !== "user") u--;
    if (u < 0 || rows[u].sender_id !== rows[i].sender_id) continue;
    let start = u;
    while (start > 0 && rows[start - 1].sender_id === rows[i].sender_id) start--;
    checked++;
    if (ungroundedTripInReply(String(rows[i].text || ""), {
      customerText: String(rows[u].text || ""), trips,
      history: rows.slice(start, u).map((row) => ({ role: row.role, text: String(row.text || "") })),
    })) held++;
  }
  console.log(`3. Past replies about a trip the conversation never named: ${held}/${checked}`);

  // 4. Self-consistency.
  const report = checkSelfConsistency(trips);
  console.log(`4. Own answers rejected by the checker: ${report.failures.length}/${report.answers}`);
  if (report.failures.length) failed = true;

  if (failed) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 2;
  })
  .finally(() => closeNeonPool().catch(() => {}));
