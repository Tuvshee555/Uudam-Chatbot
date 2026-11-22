/**
 * The admin assistant on Claude (anthropicTools.ts), behind ASSISTANT_PROVIDER=anthropic. A fake
 * transport answers in place of the API: the request shape, the message conversion, the model's own
 * blocks sent back unchanged, the usage, the failures, and the loop's last round. No network, no key.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { applyTestEnv } from "./helpers/env";
import { agentDeps, NOW, TRIPS } from "./helpers/agentFixtures";
import type { ChatMessage, ToolDefinition } from "../src/lib/assistantAgent/types";

applyTestEnv();

type Sent = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

/** A client whose transport answers each request with the next of `replies` (a Messages API body or an HTTP error). */
function fakeClient(replies: Array<Record<string, unknown> | { status: number; error: Record<string, unknown> }>) {
  const sent: Sent[] = [];
  let index = 0;
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers as HeadersInit).forEach((value, key) => { headers[key] = value; });
    sent.push({ url: String(url), headers, body: JSON.parse(String(init?.body || "{}")) });
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    if ("status" in reply && typeof reply.status === "number" && "error" in reply) {
      return new Response(JSON.stringify({ type: "error", error: reply.error }), { status: reply.status, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new Anthropic({ apiKey: "test-anthropic-key", fetch: fetchImpl as never, maxRetries: 0 });
  return { client, sent };
}

const message = (content: Array<Record<string, unknown>>, stop = "tool_use", usage: Record<string, number> = {}) => ({
  id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content, stop_reason: stop, stop_sequence: null,
  usage: { input_tokens: 1_200, output_tokens: 80, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 300, ...usage },
});

const TOOLS: ToolDefinition[] = [{ type: "function", function: { name: "get_trip", description: "One trip.", parameters: { type: "object", properties: { trip_id: { type: "string" } }, required: ["trip_id"] } } }];

test("the loop's messages become a Messages API request: one system, alternating turns, tool results together, the model's own blocks unchanged", async () => {
  const { toAnthropicMessages, toAnthropicTools } = await import("../src/lib/assistantAgent/anthropicTools");
  const thinking = { type: "thinking", thinking: "", signature: "sig-1" };
  const history: ChatMessage[] = [
    { role: "system", content: "RULES" },
    { role: "user", content: "альфа аяллыг шалга" },
    { role: "assistant", content: null, tool_calls: [{ id: "toolu_1", type: "function", function: { name: "get_trip", arguments: "{\"trip_id\":\"t-alpha\"}" } }, { id: "toolu_2", type: "function", function: { name: "get_trip", arguments: "{\"trip_id\":\"t-beta\"}" } }],
      raw: [thinking, { type: "tool_use", id: "toolu_1", name: "get_trip", input: { trip_id: "t-alpha" } }, { type: "tool_use", id: "toolu_2", name: "get_trip", input: { trip_id: "t-beta" } }] },
    { role: "tool", tool_call_id: "toolu_1", content: "{\"id\":\"t-alpha\"}" },
    { role: "tool", tool_call_id: "toolu_2", content: "{\"id\":\"t-beta\"}" },
    { role: "user", content: "Энэ бол сүүлийн ээлж" },
    { role: "assistant", content: "Бэлэн.", tool_calls: [{ id: "toolu_3", type: "function", function: { name: "reply", arguments: "not json" } }] },
  ];
  const converted = toAnthropicMessages(history);
  assert.equal(converted.system, "RULES");
  assert.deepEqual(converted.messages.map((entry) => entry.role), ["user", "assistant", "user", "assistant"], "the two tool results and the note are ONE user turn");
  assert.deepEqual(converted.messages[1].content, history[2].role === "assistant" ? history[2].raw : null, "the model's blocks go back exactly as it sent them, thinking first");
  assert.deepEqual(converted.messages[2].content, [
    { type: "tool_result", tool_use_id: "toolu_1", content: "{\"id\":\"t-alpha\"}" },
    { type: "tool_result", tool_use_id: "toolu_2", content: "{\"id\":\"t-beta\"}" },
    { type: "text", text: "Энэ бол сүүлийн ээлж" },
  ]);
  assert.deepEqual(converted.messages[3].content, [{ type: "text", text: "Бэлэн." }, { type: "tool_use", id: "toolu_3", name: "reply", input: {} }], "a turn without raw blocks is rebuilt; unreadable arguments become {}");
  assert.deepEqual(toAnthropicTools(TOOLS), [{ name: "get_trip", description: "One trip.", input_schema: { type: "object", properties: { trip_id: { type: "string" } }, required: ["trip_id"] } }]);
});

test("one call: auto tool choice, medium effort, the cached prefix, the fallback on a decline; the reply's calls, blocks and usage come back", async () => {
  const { anthropicChatWith } = await import("../src/lib/assistantAgent/anthropicTools");
  const blocks = [{ type: "thinking", thinking: "", signature: "sig-2" }, { type: "tool_use", id: "toolu_9", name: "get_trip", input: { trip_id: "t-alpha" } }];
  const { client, sent } = fakeClient([message(blocks)]);
  const result = await anthropicChatWith(client)({
    messages: [{ role: "system", content: "RULES" }, { role: "user", content: "альфа" }], tools: TOOLS, toolChoice: "required", timeoutMs: 20_000, model: "claude-sonnet-5-5", maxOutputTokens: 4_000,
  });
  const body = sent[0].body;
  assert.match(sent[0].url, /\/v1\/messages/);
  assert.equal(body.model, "claude-sonnet-5-5");
  assert.equal(body.max_tokens, 16_000, "room for thinking as well as the reply");
  assert.equal(body.system, "RULES");
  assert.deepEqual(body.tool_choice, { type: "auto" }, "forced tool choice is a 400 on this model");
  assert.deepEqual(body.output_config, { effort: "medium" });
  assert.deepEqual(body.cache_control, { type: "ephemeral" });
  assert.equal(body.fallbacks, "default");
  assert.match(sent[0].headers["anthropic-beta"] || "", /server-side-fallback-2026-07-01/);
  assert.deepEqual(result.message.tool_calls, [{ id: "toolu_9", type: "function", function: { name: "get_trip", arguments: "{\"trip_id\":\"t-alpha\"}" } }]);
  assert.deepEqual(result.message.raw, blocks);
  assert.equal(result.message.content, null);
  assert.deepEqual(result.usage, { prompt_tokens: 10_500, completion_tokens: 80, total_tokens: 10_580, cached_tokens: 9_000 });
});

test("failures keep the loop's kinds: a rejected key, a rate limit, an empty balance, a decline the fallback could not rescue", async () => {
  const { anthropicChatWith, anthropicFailure } = await import("../src/lib/assistantAgent/anthropicTools");
  const { AgentModelError } = await import("../src/lib/assistantAgent/openaiTools");
  const call = (reply: Parameters<typeof fakeClient>[0][number]) => anthropicChatWith(fakeClient([reply]).client)({ messages: [{ role: "user", content: "x" }], tools: TOOLS, timeoutMs: 5_000, model: "claude-sonnet-5-5" });
  const kindOf = async (reply: Parameters<typeof fakeClient>[0][number]) => {
    try { await call(reply); return "no error"; } catch (error) { assert.ok(error instanceof AgentModelError); return (error as InstanceType<typeof AgentModelError>).kind; }
  };
  assert.equal(await kindOf({ status: 401, error: { type: "authentication_error", message: "invalid x-api-key" } }), "unauthorized");
  assert.equal(await kindOf({ status: 429, error: { type: "rate_limit_error", message: "slow down" } }), "quota");
  assert.equal(await kindOf({ status: 400, error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }), "credits_exhausted");
  assert.equal(await kindOf(message([], "refusal")), "other");
  assert.equal(anthropicFailure(new Error("boom")).kind, "other");
});

test("the agent on Claude: the model's blocks travel to the next call, and the last round keeps every tool and is told to finish", async () => {
  const { runAgent } = await import("../src/lib/assistantAgent/agent");
  const { anthropicChatWith } = await import("../src/lib/assistantAgent/anthropicTools");
  const thinking = { type: "thinking", thinking: "", signature: "sig-3" };
  const { client, sent } = fakeClient([
    message([thinking, { type: "tool_use", id: "toolu_a", name: "search_trips", input: { query: "альфа" } }]),
    message([{ type: "tool_use", id: "toolu_b", name: "reply", input: { text: "Альфа аялал 12/2-нд гарна." } }], "tool_use"),
  ]);
  const result = await runAgent({ instruction: "альфа хэзээ гарах вэ", trips: TRIPS, today: NOW, maxRounds: 2,
    deps: { ...agentDeps(anthropicChatWith(client)), defaultModel: "claude-sonnet-5-5", stableTools: true } });
  assert.deepEqual(result.outcome, { kind: "note", text: "Альфа аялал 12/2-нд гарна.", reason: "reply" });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].body.model, "claude-sonnet-5-5", "the Claude model, not the OpenAI default");
  const names = (body: Record<string, unknown>) => (body.tools as Array<{ name: string }>).map((tool) => tool.name);
  assert.deepEqual(names(sent[1].body), names(sent[0].body), "the tool list never changes within a turn");
  const second = sent[1].body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  assert.deepEqual(second[1], { role: "assistant", content: [thinking, { type: "tool_use", id: "toolu_a", name: "search_trips", input: { query: "альфа" } }] }, "the thinking block goes back unchanged");
  assert.equal(second[2].role, "user");
  assert.equal(second[2].content[0].type, "tool_result");
  assert.match(String(second[2].content.at(-1)?.text), /сүүлийн ээлж/);
});

test("the switch: gpt-4.1 unless ASSISTANT_PROVIDER=anthropic; then Claude Sonnet 5.5 with the stable tool list, and no key is a plain failure", async () => {
  const { assistantProvider, defaultAgentDeps } = await import("../src/lib/assistantAgent/deps");
  const saved = { provider: process.env.ASSISTANT_PROVIDER, key: process.env.ANTHROPIC_API_KEY, model: process.env.ASSISTANT_ANTHROPIC_MODEL };
  try {
    delete process.env.ASSISTANT_PROVIDER;
    assert.equal(assistantProvider(), "openai");
    assert.equal(defaultAgentDeps().defaultModel, undefined);
    process.env.ASSISTANT_PROVIDER = "anthropic";
    delete process.env.ASSISTANT_ANTHROPIC_MODEL;
    const deps = defaultAgentDeps();
    assert.equal(deps.defaultModel, "claude-sonnet-5-5");
    assert.equal(deps.stableTools, true);
    delete process.env.ANTHROPIC_API_KEY;
    await assert.rejects(deps.chat({ messages: [{ role: "user", content: "x" }], tools: [], timeoutMs: 1_000, model: "claude-sonnet-5-5" }), (error: Error & { kind?: string }) => error.kind === "no_key");
  } finally {
    for (const [key, value] of [["ASSISTANT_PROVIDER", saved.provider], ["ANTHROPIC_API_KEY", saved.key], ["ASSISTANT_ANTHROPIC_MODEL", saved.model]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
