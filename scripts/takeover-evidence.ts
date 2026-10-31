/**
 * READ-ONLY evidence for a live take-over test (or any window): what each echo was judged, which
 * customers a consultant took over and from where, whether the bot wrote to them afterwards, and
 * which Meta app delivered the window's messages. Customers appear as short hashes; no text.
 *
 *   node --env-file=.env.local --import tsx scripts/takeover-evidence.ts --since=2026-11-01T02:00:00Z [--until=…]
 *
 * A passing take-over shows: the consultant's echo with verdict "human", the customer paused
 * "operator_reply" with the right source (staff_mobile / staff_web) and "until released", and
 * 0 bot replies after it until «Ботод буцаах» (bot_released_at).
 */
import { createHash } from "node:crypto";
import { closeNeonPool, queryNeon } from "../src/lib/neonDb";
import { UNTIL_RELEASED_AT } from "../src/lib/travelSessionDb";

const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const since = arg("since");
const until = arg("until") || new Date().toISOString();
if (!since || Number.isNaN(Date.parse(since))) throw new Error("--since=<ISO time> is required");
const hash = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 8);
const hhmmss = (value: unknown) => (value ? new Date(String(value)).toISOString().slice(11, 19) : "");
type Row = Record<string, unknown>;
const rows = async (sql: string, params: unknown[]) => ((await queryNeon<Row>(sql, params))?.rows ?? []);

async function main() {
  console.log(`window ${since} → ${until} (UTC)\n\nEchoes (Page messages) and what they were judged:`);
  const echoes = await rows(`SELECT created_at, recipient_id, app_id, classification, verdict, delivered_by, text_length, attachment_types
    FROM travel_echo_events WHERE created_at BETWEEN $1 AND $2 ORDER BY created_at`, [since, until]);
  console.table(echoes.map((e) => ({ at: hhmmss(e.created_at), customer: hash(String(e.recipient_id)), app: e.app_id, class: e.classification,
    verdict: e.verdict, via: e.delivered_by, chars: e.text_length, attachments: e.attachment_types })));

  console.log("Take-overs in the window (pause state now):");
  const owners = await rows(`SELECT sender_id, paused, pause_reason, paused_at, expires_at, takeover_source, last_staff_reply_at, bot_released_at
    FROM travel_senders WHERE (paused_at BETWEEN $1 AND $2) OR (last_staff_reply_at BETWEEN $1 AND $2) OR (bot_released_at BETWEEN $1 AND $2)
    ORDER BY COALESCE(paused_at, last_staff_reply_at)`, [since, until]);
  console.table(owners.map((o) => ({ customer: hash(String(o.sender_id)), paused: o.paused, reason: o.pause_reason, source: o.takeover_source,
    pausedAt: hhmmss(o.paused_at), until: o.expires_at && new Date(String(o.expires_at)).toISOString() === UNTIL_RELEASED_AT ? "until released" : hhmmss(o.expires_at),
    consultantAt: hhmmss(o.last_staff_reply_at), releasedAt: hhmmss(o.bot_released_at) })));

  console.log("Bot replies sent AFTER each take-over and before any release (must be 0):");
  for (const o of owners.filter((owner) => owner.last_staff_reply_at)) {
    const end = o.bot_released_at && Date.parse(String(o.bot_released_at)) > Date.parse(String(o.last_staff_reply_at)) ? o.bot_released_at : until;
    const [count] = await rows(`SELECT COUNT(*)::int AS n FROM travel_conversations WHERE sender_id=$1 AND role='assistant' AND created_at > $2 AND created_at < $3`,
      [o.sender_id, o.last_staff_reply_at, end]);
    console.log(`  ${hash(String(o.sender_id))}: ${count?.n ?? "?"}`);
  }

  console.log("\nWhich Meta app delivered the window's customer messages (current = Uudam-chatbot, next = uudam-v2):");
  const receipts = await rows(`SELECT fields->>'eventKeyHash' AS k, array_agg(DISTINCT fields->>'deliveredBy') AS via FROM travel_error_logs
    WHERE event='webhook.inbound_received' AND created_at BETWEEN $1 AND $2 GROUP BY 1`, [since, until]);
  const tally: Record<string, number> = {};
  for (const r of receipts) { const key = [...(r.via as string[])].sort().join("+"); tally[key] = (tally[key] ?? 0) + 1; }
  console.log(" ", receipts.length, "messages", JSON.stringify(tally));
  await closeNeonPool();
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
