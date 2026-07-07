import assert from "node:assert/strict";
import test, { before } from "node:test";
import { applyTestEnv } from "./helpers/env";

// replyReasoning.ts and conversation.ts both transitively load env at module
// import time — env vars must be applied before the first import resolves.
let buildReasoningPrompt: typeof import("../src/lib/replyReasoning").buildReasoningPrompt;
let buildTripIndexLines: typeof import("../src/lib/replyReasoning").buildTripIndexLines;
let normalizeReasoningText: typeof import("../src/lib/replyReasoning").normalizeReasoningText;
let buildPrompt: typeof import("../src/lib/conversation").buildPrompt;

before(async () => {
  applyTestEnv();
  const reasoningModule = await import("../src/lib/replyReasoning");
  buildReasoningPrompt = reasoningModule.buildReasoningPrompt;
  buildTripIndexLines = reasoningModule.buildTripIndexLines;
  normalizeReasoningText = reasoningModule.normalizeReasoningText;
  const conversationModule = await import("../src/lib/conversation");
  buildPrompt = conversationModule.buildPrompt;
});

test("buildTripIndexLines formats trips compactly and skips empty names", () => {
  const lines = buildTripIndexLines([
    { route_name: "Бээжин шууд нислэгтэй аялал", category: "Шууд нислэгтэй", duration_text: "5 өдөр / 4 шөнө" },
    { route_name: "", category: "Газрын" },
    { route_name: "Хайнан Саньяа аялал" },
  ]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "- Бээжин шууд нислэгтэй аялал (Шууд нислэгтэй, 5 өдөр / 4 шөнө)");
  assert.equal(lines[1], "- Хайнан Саньяа аялал");
});

test("buildTripIndexLines caps the index so a huge catalog can't bloat the prompt", () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ route_name: `Аялал ${i}` }));
  assert.equal(buildTripIndexLines(many).length, 80);
});

test("buildReasoningPrompt includes memory, history, trips, and the labeled output contract", () => {
  const prompt = buildReasoningPrompt({
    customerMemory: "Trips/products discussed:\n- Хайнан Саньяа аялал (2026-07-02)",
    history: [
      { role: "user", text: "Хайнан аялал ямар үнэтэй вэ?" },
      { role: "assistant", text: "Том хүн 2,990,000₮." },
    ],
    userText: "Тэрийг маргааш захиалъя",
    tripIndexLines: ["- Хайнан Саньяа аялал"],
  });
  assert.match(prompt, /Persistent customer memory:/);
  assert.match(prompt, /Хайнан Саньяа аялал \(2026-07-02\)/);
  assert.match(prompt, /Recent conversation:/);
  assert.match(prompt, /User: Хайнан аялал ямар үнэтэй вэ\?/);
  assert.match(prompt, /Current message: Тэрийг маргааш захиалъя/);
  assert.match(prompt, /Known trips \(names only/);
  assert.match(prompt, /Intent: \.\.\./);
  assert.match(prompt, /Refers to: \.\.\./);
  assert.match(prompt, /Already explained: \.\.\./);
  assert.match(prompt, /Changed mind: \.\.\./);
  assert.match(prompt, /Never invent trips, prices, dates, or facts/);
  // It must produce analysis, not a customer reply.
  assert.match(prompt, /NOT a customer reply/);
});

test("buildReasoningPrompt keeps only the recent turns and truncates giant messages", () => {
  const history = Array.from({ length: 30 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    text: `msg-${i}`,
  }));
  history.push({ role: "user", text: "x".repeat(1000) });
  const prompt = buildReasoningPrompt({
    customerMemory: "",
    history,
    userText: "za",
    tripIndexLines: [],
  });
  // Older turns beyond the last 12 must be absent.
  assert.doesNotMatch(prompt, /msg-5\b/);
  // The giant message is truncated with an ellipsis, not included whole.
  assert.doesNotMatch(prompt, /x{500}/);
  assert.match(prompt, /x{100,}…/);
});

test("normalizeReasoningText strips code fences and caps runaway output", () => {
  assert.equal(normalizeReasoningText("```text\nIntent: price ask\n```"), "Intent: price ask");
  assert.equal(normalizeReasoningText("   \n  "), "");
  assert.equal(normalizeReasoningText("a".repeat(5000)).length, 1600);
});

test("buildPrompt injects the private analysis block and the follow-it rule when reasoning is provided", () => {
  const prompt = buildPrompt({
    systemPrompt: "You are a travel bot.",
    business: { name: "Uudam", knowledgeBase: "trips..." },
    history: [{ role: "user", text: "Сайн уу" }],
    customerMemory: "Preferences: далайн амралт",
    reasoning: "Intent: book the Hainan trip discussed earlier.\nRefers to: Хайнан Саньяа аялал",
    userText: "Тэрийг захиалъя",
  });
  assert.match(prompt, /Private pre-answer analysis \(never show to customer\):/);
  assert.match(prompt, /Refers to: Хайнан Саньяа аялал/);
  assert.match(prompt, /NEVER reveal, quote, or mention the analysis itself/);
  assert.match(prompt, /If the analysis conflicts with the trip data in Context, trust the Context/);
  // Memory block still present alongside it.
  assert.match(prompt, /Persistent customer memory:/);
});

test("buildPrompt without reasoning keeps the old silent-reasoning instruction and no analysis block", () => {
  const prompt = buildPrompt({
    systemPrompt: "You are a travel bot.",
    business: { name: "Uudam" },
    history: [],
    userText: "Сайн уу",
  });
  assert.doesNotMatch(prompt, /Private pre-answer analysis/);
  assert.match(prompt, /silently reason about the customer's intent/);
});
