/**
 * Replays a package of files against a catalogue SNAPSHOT with the real model and writes nothing:
 * the assistant's agent runs as /api/admin/ai-change runs it, but the catalogue comes from a JSON
 * file and no proposal is stored. The config (real files, a catalogue snapshot, his answers) lives
 * outside git (uudam-eval/assistant-walk/replay-1121.json): this script holds no trip data.
 * Spends model credit: through evalGuard (EVAL_RUN_APPROVED=1, capped, one run at a time).
 *
 *   EVAL_RUN_APPROVED=1 node --env-file-if-exists=.env.local --import tsx scripts/assistant-intake-replay.ts <config.json> dry|ask|answer
 *
 * config: { out, catalogue, before?, remove?: [ids], message, files: [{ path, text? }], picks?: { <topic or header>: { option } | { text } } }
 * dry = the files' text and the page's route, no model; ask = turn 1 (take stock, the dialog);
 * answer = turn 2 with `picks` as his answers (turn 1's saved output is read back).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { requireApprovedEvaluation } from "../scripts/lib/evalGuard.mjs";
import { attachmentRoute, dialogAnswer } from "../src/components/admin/assistantChatLogic";
import type { AssistantAskMsg } from "../src/components/admin/assistantChatTypes";
import type { AttachedFile } from "../src/lib/adminTypes";
import { runAgent } from "../src/lib/assistantAgent/agent";
import { defaultAgentDeps } from "../src/lib/assistantAgent/deps";
import type { AgentDocument, AgentOutcome, AnswerTo, ChatFn } from "../src/lib/assistantAgent/types";
import { processAiTotals } from "../src/lib/aiUsage";
import { documentTextOf } from "../src/lib/documentText";
import { markTripDamage } from "../src/lib/tripDamage";
import type { TravelTrip } from "../src/lib/travelTypes";

type Config = {
  out: string; catalogue: string; before?: string; remove?: string[]; message: string;
  files: Array<{ path: string; text?: string }>; picks?: Record<string, { option?: number; text?: string }>;
};

const MIME: Record<string, string> = { doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", pdf: "application/pdf" };
const MAX_CALLS = 12;

function catalogueOf(config: Config): TravelTrip[] {
  const full = JSON.parse(readFileSync(config.catalogue, "utf8")) as TravelTrip[];
  const before = config.before ? (JSON.parse(readFileSync(config.before, "utf8")) as TravelTrip[]) : [];
  const old = new Map(before.map((trip) => [trip.id, trip]));
  const removed = new Set(config.remove || []);
  return full.filter((trip) => !removed.has(trip.id)).map((trip) => old.get(trip.id) ?? trip);
}

async function documentsOf(config: Config): Promise<AgentDocument[]> {
  const out: AgentDocument[] = [];
  for (const file of config.files) {
    const name = basename(file.path);
    if (file.text) { out.push({ name, text: readFileSync(file.text, "utf8").trim() }); continue; }
    const extension = name.split(".").pop()!.toLowerCase();
    // Documents are read without a model; a picture must come with its saved transcription (text).
    if (/^(jpe?g|png|webp)$/.test(extension)) throw new Error(`${name}: a picture needs "text" (its saved transcription)`);
    const read = await documentTextOf({ filename: name, mimeType: MIME[extension] || "", dataBase64: readFileSync(file.path).toString("base64") });
    out.push({ name: read.name, text: read.text });
  }
  return out;
}

function printOutcome(outcome: AgentOutcome, trips: TravelTrip[]) {
  const nameOf = (id: unknown) => trips.find((trip) => trip.id === id)?.route_name || String(id || "");
  if (outcome.kind === "ask") {
    const ask = outcome.ask;
    console.log("\n=== ASK ===");
    if (!ask.questions?.length) {
      console.log(ask.text);
      for (const option of ask.options || []) console.log("  •", option.label, "→", option.answer);
    }
    for (const [index, question] of (ask.questions || []).entries()) {
      console.log(`\n[${index + 1}] ${question.header}\n    ${question.text}`);
      for (const option of question.options) console.log(`      ○ ${option.label}${option.recommended ? " (Санал болгож буй)" : ""}\n          ${option.description || ""}`);
      console.log("      ○ Өөр …");
    }
    if (ask.memo) console.log("\nmemo:", ask.memo);
    return;
  }
  if (outcome.kind === "proposal") {
    markTripDamage(outcome.proposal.actions, trips, new Date());
    console.log("\n=== PROPOSAL ===\nreply:", outcome.proposal.summary || "");
    for (const action of outcome.proposal.actions) {
      const { summary, ...rest } = action as unknown as Record<string, unknown>;
      const clipped = JSON.stringify(rest, (key, value) => (typeof value === "string" && value.length > 260 ? `${value.slice(0, 260)}… [${value.length}]` : value));
      console.log(`\n- «${nameOf(rest.trip_id)}»  ${String(rest.action)}  ::  ${String(summary || "")}\n  ${clipped.slice(0, 1500)}`);
    }
    for (const line of outcome.proposal.conflicts || []) console.log("  ! ", line);
  }
  if (outcome.kind === "proposal" || outcome.kind === "handoff") {
    for (const handoff of outcome.handoffs || []) console.log(`\n=== NEW TRIP HAND-OFF === files: ${handoff.files.join(", ")}\nnote:\n${handoff.note}`);
  }
  if (outcome.kind === "note") console.log("\n=== NOTE ===", outcome.reason || "", "\n", outcome.text);
  if (outcome.kind === "trip_source") console.log("\n=== TRIP SOURCE ===", outcome.label, outcome.note);
}

async function main() {
  const [, , configPath, step] = process.argv;
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Config;
  mkdirSync(config.out, { recursive: true });
  const trips = catalogueOf(config);
  const documents = await documentsOf(config);
  const files = config.files.map((file): AttachedFile => ({ id: basename(file.path), name: basename(file.path), mimeType: MIME[basename(file.path).split(".").pop()!.toLowerCase()] || "", sizeBytes: 1, file: {} as File }));
  const route = attachmentRoute(config.message, files);
  console.log(`catalogue: ${trips.length} trips | documents: ${documents.map((document) => `${document.name} (${document.text.length})`).join(", ")}`);
  console.log(`page route: ${route.kind}${route.kind === "agent_files" ? ` (${route.reason})` : ""}`);
  if (route.kind !== "agent_files") throw new Error("the page would not send these files to the assistant");
  if (step === "dry") {
    for (const document of documents) console.log(`--- ${document.name}\n${document.text.slice(0, 260).split("\n").slice(0, 6).join("\n")}`);
    for (const id of process.argv.slice(4)) { const trip = trips.find((entry) => entry.id === id); console.log(id, "→", trip ? trip.status + " | " + trip.duration_text + " | " + (trip.departure_dates || []).join(",") + " | " + trip.adult_price + "/" + trip.child_price : "NOT IN SNAPSHOT"); }
    return;
  }

  requireApprovedEvaluation({ name: `assistant intake replay (${step})`, estimatedModelCalls: 7 });
  const base = defaultAgentDeps();
  let calls = 0;
  const usage = { prompt: 0, cached: 0, completion: 0 };
  const transcript: unknown[] = [];
  const chat: ChatFn = async (input) => {
    calls += 1;
    if (calls > MAX_CALLS) throw new Error(`replay cap: more than ${MAX_CALLS} model calls`);
    const result = await base.chat(input);
    const used = result.usage as { prompt_tokens?: number; completion_tokens?: number; cached_tokens?: number } | undefined;
    usage.prompt += used?.prompt_tokens || 0; usage.cached += used?.cached_tokens || 0; usage.completion += used?.completion_tokens || 0;
    transcript.push({ call: calls, tools: (result.message.tool_calls || []).map((call) => ({ name: call.function.name, args: call.function.arguments })) });
    console.log(`  model call ${calls}: ${(result.message.tool_calls || []).map((call) => call.function.name).join(", ") || "(text)"}`);
    return result;
  };
  // Reads only: the catalogue is the snapshot; nothing is hosted, stored or sent.
  const deps = { ...base, chat, budget: async () => ({ exceeded: false, message: "" }), hostImage: async () => { throw new Error("replay: no uploads"); } };

  let instruction = config.message;
  let answerTo: AnswerTo | null = null;
  if (step === "answer") {
    const first = JSON.parse(readFileSync(`${config.out}/turn1.json`, "utf8")) as { outcome: AgentOutcome };
    if (first.outcome.kind !== "ask" || !first.outcome.ask.questions?.length) throw new Error("turn 1 was not a dialog");
    const ask = first.outcome.ask;
    const message = { questions: ask.questions } as Pick<AssistantAskMsg, "questions">;
    // His answers by decision (the order of the questions is the model's).
    const asked = (ask.intake ? (JSON.parse(ask.intake) as { asked?: Array<{ topic: string }> }).asked : []) || [];
    const picks = Object.fromEntries((ask.questions || []).map((question, index) => [question.id, config.picks?.[asked[index]?.topic || ""] || config.picks?.[question.header] || {}]));
    const answer = dialogAnswer(message, picks);
    if (!answer) throw new Error("config.picks does not answer every question");
    console.log("\nanswers sent:\n" + answer.instruction);
    instruction = answer.instruction;
    answerTo = { id: "agent", question: ask.text, instruction: config.message, ...(ask.memo ? { memo: ask.memo } : {}), answers: answer.answers, ...(ask.intake ? { intake: ask.intake } : {}) };
  }
  const startedAt = Date.now();
  const run = await runAgent({ instruction, trips, documents, answerTo, deps });
  console.log(`\ntools: ${run.tools.join(" → ")} | rounds ${run.rounds} | ${Math.round((Date.now() - startedAt) / 1000)} s`);
  printOutcome(run.outcome, trips);
  const file = `${config.out}/${step === "answer" ? "turn2" : "turn1"}.json`;
  writeFileSync(file, JSON.stringify({ instruction, answerTo, outcome: run.outcome, tools: run.tools, transcript, usage }, null, 1));
  const totals = processAiTotals();
  console.log(`\nsaved ${existsSync(file) ? file : "(failed)"}\nspend: ${totals.calls} calls, prompt ${usage.prompt} (cached ${usage.cached}), completion ${usage.completion}, about $${totals.costUsd.toFixed(3)}`);
  await new Promise((resolve) => setTimeout(resolve, 2500));
}

main().catch((error) => { console.error("REPLAY FAILED:", error instanceof Error ? error.message : error); process.exitCode = 1; });
