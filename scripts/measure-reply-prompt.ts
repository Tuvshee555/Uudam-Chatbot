/**
 * How big the reply model's prompt is, part by part, with the live catalog — and how much
 * of it is identical from one message to the next (what OpenAI's prompt cache can reuse).
 * Calls no model.
 *
 *   node --env-file=.env.local --import tsx scripts/measure-reply-prompt.ts
 */
import { readBusinessData } from "../src/lib/businessData";
import { buildPromptParts } from "../src/lib/conversation";
import { closeNeonPool } from "../src/lib/neonDb";

type Parts = { system: string; user: string };
const sharedPrefix = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
};
// Rough token estimate for mixed Mongolian/English text; the ratio, not the absolute, matters here.
const tokens = (chars: number) => Math.round(chars / 2.6);

async function main() {
  const data = await readBusinessData();
  const kb = String(data.business.knowledgeBase || "");
  const build = (userText: string, extra: Partial<Parameters<typeof buildPromptParts>[0]> = {}): Parts => buildPromptParts({
    systemPrompt: data.systemPrompt, business: data.business, history: [], userText,
    pinnedButtonLabels: data.pinnedButtonLabels, ...extra,
  });
  const a = build("Сайн байна уу, аялал сонирхож байна");
  const b = build("хүүхэдтэй явахад ямар аялал байна", { phoneRequested: true,
    history: [{ role: "user", text: "сайн уу" }, { role: "assistant", text: "Сайн байна уу! Ямар аялал сонирхож байна вэ?" }] });
  console.log(`knowledge base (full): ${kb.length} chars ≈ ${tokens(kb.length)} tokens`);
  for (const [name, parts] of [["A", a], ["B", b]] as const) {
    console.log(`message ${name}: system ${parts.system.length} chars ≈ ${tokens(parts.system.length)}, user ${parts.user.length} ≈ ${tokens(parts.user.length)}`);
  }
  const whole = (parts: Parts) => `${parts.system}\n${parts.user}`;
  const shared = sharedPrefix(whole(a), whole(b));
  console.log(`identical prefix between two different messages: ${shared} chars ≈ ${tokens(shared)} tokens of ≈ ${tokens(whole(b).length)}`);
  console.log(`system identical up to char ${sharedPrefix(a.system, b.system)} of ${a.system.length}; user identical up to ${sharedPrefix(a.user, b.user)} of ${a.user.length}`);
  // Where the user part's size goes: each block headed by a line ending in ":" (not a bullet).
  console.log("\nuser part by block (message B):");
  const blocks: Array<{ head: string; chars: number; lines: number }> = [];
  for (const line of b.user.split("\n")) {
    const isHeader = /^[^-\s].*:$/.test(line) && line.length < 60;
    if (isHeader || blocks.length === 0) blocks.push({ head: isHeader ? line : "(start)", chars: 0, lines: 0 });
    const block = blocks[blocks.length - 1];
    block.chars += line.length + 1;
    block.lines += 1;
  }
  for (const block of blocks.sort((x, y) => y.chars - x.chars).slice(0, 12)) {
    console.log(`  ${String(block.chars).padStart(6)} chars ≈ ${String(tokens(block.chars)).padStart(5)} tokens, ${String(block.lines).padStart(4)} lines  ${block.head}`);
  }
  const moduleLines = b.user.split("\n").filter((line) => line.startsWith("- ") && line.includes(" | "));
  const longest = [...moduleLines].sort((x, y) => y.length - x.length)[0] || "";
  console.log(`\nmodule lines: ${moduleLines.length}, full-detail (no 'summary only'): ${moduleLines.filter((line) => !line.endsWith("summary only")).length}`);
  console.log(`longest module line: ${longest.length} chars; its fields: ${longest.split(" | ").map((field) => `${field.split(":")[0].trim().slice(0, 24)}=${field.length}`).join(", ")}`);
  // How the Modules section is laid out: the trimmer (aiTripContext.ts) assumes one line per
  // trip and a blank line only at the section's end.
  const kbLines = kb.split("\n");
  const start = kbLines.indexOf("Modules:");
  const end = kbLines.indexOf("Special offers:");
  let entries = 0, continuation = 0, blanks = 0;
  const samples: string[] = [];
  for (let i = start + 1; i < (end < 0 ? kbLines.length : end); i += 1) {
    const line = kbLines[i];
    if (line.startsWith("- ") && line.includes(" | ")) entries += 1;
    else if (!line.trim()) { blanks += 1; if (samples.length < 8) samples.push(`${i}: <blank> (next: ${(kbLines[i + 1] || "").slice(0, 40)})`); }
    else { continuation += 1; if (samples.length < 8) samples.push(`${i}: ${line.slice(0, 60)}`); }
  }
  console.log(`\nModules section lines ${start + 1}..${end}: ${entries} trip entries, ${continuation} continuation lines, ${blanks} blank lines`);
  for (const sample of samples) console.log("  " + sample);
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => closeNeonPool().catch(() => {}));
