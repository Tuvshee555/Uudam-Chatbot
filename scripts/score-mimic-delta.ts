/**
 * Quantifies how much closer Mimic Myself gets bot replies to her actual
 * voice, versus the baseline (toggle OFF) bot. For the same real customer
 * questions: generates ON and OFF bot replies, then has a model score each
 * one's TONE/STYLE closeness to her real historical answer (1-10, style
 * only — not factual correctness, since OFF/ON share the same catalog data
 * and only differ in phrasing).
 */
import { readFileSync } from "fs";
import { resolve } from "path";

function loadEnvFile(path: string) {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    if (!key || process.env[key] != null) continue;
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
loadEnvFile(resolve(process.cwd(), ".env.local"));
loadEnvFile(resolve(process.cwd(), ".env"));

const GRAPH_VERSION = "v19.0";
type GraphMessage = { message?: string; from?: { id?: string }; created_time?: string };
type GraphConversation = { id: string; messages?: { data?: GraphMessage[] } };

async function graphGet<T>(url: string): Promise<T | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

const META_BOILERPLATE_RE =
  /(https?:\/\/|responding to a user comment|replied to an ad\.?$|please let us know how we can help you)/i;

async function main() {
  const { getEnv } = await import("../src/lib/env");
  const { dbGetRecentAdminMessages } = await import("../src/lib/travelDb");
  const { buildPromptParts } = await import("../src/lib/conversation");
  const { askOpenAI } = await import("../src/lib/openaiProvider");
  const { readBusinessData } = await import("../src/lib/businessData");

  const env = getEnv();
  const page = env.facebookPages[0];
  if (!page) return;

  const url =
    `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(page.pageId)}/conversations` +
    `?fields=${encodeURIComponent("participants,messages.limit(15){message,from,created_time}")}` +
    `&limit=25&access_token=${encodeURIComponent(page.token)}`;
  const result = await graphGet<{ data: GraphConversation[] }>(url);
  const conversations = result?.data || [];

  type Pair = { question: string; answer: string };
  const pairs: Pair[] = [];
  const seen = new Set<string>();
  for (const conv of conversations) {
    const msgs = (conv.messages?.data || []).slice().reverse();
    for (let i = 1; i < msgs.length; i++) {
      const cur = msgs[i];
      const prev = msgs[i - 1];
      if (cur.from?.id !== page.pageId) continue;
      if (prev.from?.id === page.pageId) continue;
      const answer = (cur.message || "").trim();
      const question = (prev.message || "").trim();
      if (answer.length < 15 || question.length < 6) continue;
      if (META_BOILERPLATE_RE.test(answer) || META_BOILERPLATE_RE.test(question)) continue;
      const key = answer.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ question, answer });
    }
  }
  const sample = pairs.slice(0, 8);

  const { business } = await readBusinessData();
  const toneExamples = await dbGetRecentAdminMessages(8);
  console.log("Current tone examples in use:");
  toneExamples.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
  console.log("");

  async function generate(question: string, withTone: boolean): Promise<string> {
    const parts = buildPromptParts({
      systemPrompt: "Чи Уудам травелийн туслах бот. Дулаан, найрсаг хариул.",
      business: business || {},
      history: [],
      userText: question,
      toneExamples: withTone ? toneExamples : undefined,
    });
    try {
      const r = await askOpenAI(parts.user, {
        systemInstruction: parts.system,
        source: "mimic_delta_score",
        openaiModel: process.env.OPENAI_REPLY_MODEL || "gpt-4o",
        preferOpenAI: true,
      });
      return r.text.trim();
    } catch (e) {
      return `(ERROR: ${(e as Error).message})`;
    }
  }

  async function scoreStyleCloseness(herAnswer: string, candidate: string): Promise<number> {
    const prompt = [
      "You are scoring STYLE/TONE closeness only — ignore factual content, ignore whether prices or details are present.",
      "Real agent's actual reply (the target style):",
      herAnswer,
      "",
      "Candidate reply to score:",
      candidate,
      "",
      "On a scale of 1-10, how close is the candidate's WRITING STYLE (warmth, phrasing choices, sentence rhythm, formality level, use of filler/closing phrases) to the real agent's? 10 = could have been written by the same person. 1 = completely different register (e.g. robotic vs casual).",
      "Output ONLY the number, nothing else.",
    ].join("\n");
    try {
      const r = await askOpenAI(prompt, {
        source: "mimic_delta_judge",
        temperature: 0,
        maxOutputTokens: 10,
        timeoutMs: 8000,
        maxRetries: 0,
        preferOpenAI: true,
      });
      const n = parseInt(r.text.trim(), 10);
      return Number.isFinite(n) ? n : NaN;
    } catch {
      return NaN;
    }
  }

  let onTotal = 0;
  let offTotal = 0;
  let counted = 0;

  for (const pair of sample) {
    const [onReply, offReply] = await Promise.all([
      generate(pair.question, true),
      generate(pair.question, false),
    ]);
    const [onScore, offScore] = await Promise.all([
      scoreStyleCloseness(pair.answer, onReply),
      scoreStyleCloseness(pair.answer, offReply),
    ]);

    console.log("========================================");
    console.log(`Q: ${pair.question}`);
    console.log(`HER REAL:  ${pair.answer}`);
    console.log(`OFF (${isNaN(offScore) ? "?" : offScore}/10): ${offReply}`);
    console.log(`ON  (${isNaN(onScore) ? "?" : onScore}/10): ${onReply}`);

    if (!isNaN(onScore) && !isNaN(offScore)) {
      onTotal += onScore;
      offTotal += offScore;
      counted++;
    }
  }

  console.log("\n=== SUMMARY ===");
  console.log(`Pairs scored: ${counted}`);
  console.log(`Average OFF style-closeness: ${counted ? (offTotal / counted).toFixed(2) : "n/a"} / 10`);
  console.log(`Average ON  style-closeness: ${counted ? (onTotal / counted).toFixed(2) : "n/a"} / 10`);
  console.log(`Delta (ON - OFF): ${counted ? ((onTotal - offTotal) / counted).toFixed(2) : "n/a"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
