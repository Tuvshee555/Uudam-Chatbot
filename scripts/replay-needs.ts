/**
 * Read-only, no AI calls: runs the need classifier (src/lib/messageNeed.ts) over the distinct real customer texts of
 * the last 60 days and prints how many it names and which ones, so a person can judge false positives before the
 * rules change. Test senders (`demo:`) are excluded. Nothing is written; no trip, place or price is in this file.
 *
 *   node --env-file-if-exists=.env.local --import tsx scripts/replay-needs.ts
 */
import { closeNeonPool, queryNeon } from "../src/lib/neonDb";
import { classifyMessageNeed } from "../src/lib/messageNeed";

async function main() {
  const rows = ((await queryNeon(
    `SELECT DISTINCT ON (text) text FROM travel_conversations
     WHERE role = 'user' AND created_at > now() - interval '60 days' AND length(text) BETWEEN 2 AND 1500
       AND text NOT LIKE '[%' AND sender_id NOT LIKE 'demo:%'`,
  ))?.rows || []) as Array<{ text: string }>;
  const hits: Array<{ key: string; text: string; signals: string[] }> = [];
  for (const { text } of rows) {
    const hit = classifyMessageNeed(text, { lastBotReply: "Үнэ 1,000,000₮." });
    if (hit) hits.push({ key: hit.need + (hit.social ? `:${hit.social}` : ""), text, signals: hit.signals });
  }
  const counts: Record<string, number> = {};
  for (const hit of hits) counts[hit.key] = (counts[hit.key] || 0) + 1;
  console.log(`Distinct real texts: ${rows.length}; named by the need gate: ${hits.length} ${JSON.stringify(counts)}`);
  for (const key of Object.keys(counts).sort()) {
    console.log(`\n## ${key} (${counts[key]})`);
    for (const hit of hits.filter((entry) => entry.key === key).slice(0, 40)) {
      console.log(`  - ${JSON.stringify(hit.text.replace(/\s+/g, " ").slice(0, 150))} ${JSON.stringify(hit.signals)}`);
    }
  }
  await closeNeonPool();
}

main().catch((error) => { console.error(error); process.exit(1); });
