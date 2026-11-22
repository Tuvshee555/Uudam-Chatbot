/**
 * The bot's AI calls on Claude (anthropicChat.ts), behind AI_PROVIDER=anthropic. A fake transport
 * answers in place of the API (streamed replies, as the SDK reads them): which Claude model each
 * OpenAI model becomes, the request shape (no temperature, cached rules, thinking off for customer
 * steps), JSON taken out of the reply, a decline as "no answer", Haiku when Sonnet is overloaded,
 * and OpenAI as the backup. No network, no key.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { applyTestEnv } from "./helpers/env";

applyTestEnv();

type Sent = { url: string; body: Record<string, unknown> };
type Reply = { text?: string; stop?: string; usage?: Record<string, number> } | { status: number; error: Record<string, unknown> };

/** One streamed Messages API reply as server-sent events. */
function sse(reply: { text?: string; stop?: string; usage?: Record<string, number> }, model: string): string {
  const usage = { input_tokens: 900, output_tokens: 0, cache_read_input_tokens: 8_000, cache_creation_input_tokens: 0, ...reply.usage };
  const events: Array<[string, Record<string, unknown>]> = [
    ["message_start", { type: "message_start", message: { id: "msg_t", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage } }],
  ];
  if (reply.text) {
    events.push(["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }]);
    events.push(["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply.text } }]);
    events.push(["content_block_stop", { type: "content_block_stop", index: 0 }]);
  }
  events.push(["message_delta", { type: "message_delta", delta: { stop_reason: reply.stop || "end_turn", stop_sequence: null }, usage: { output_tokens: 40 } }]);
  events.push(["message_stop", { type: "message_stop" }]);
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

function fakeClient(replies: Reply[]) {
  const sent: Sent[] = [];
  let index = 0;
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}"));
    sent.push({ url: String(url), body });
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    if ("status" in reply) {
      return new Response(JSON.stringify({ type: "error", error: reply.error }), { status: reply.status, headers: { "content-type": "application/json" } });
    }
    return new Response(sse(reply, String(body.model)), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { client: new Anthropic({ apiKey: "test-anthropic-key", fetch: fetchImpl as never, maxRetries: 0 }), sent };
}

async function withClaude<T>(env: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const names = ["AI_PROVIDER", "ANTHROPIC_API_KEY", "AI_OPENAI_BACKUP", "AI_CLAUDE_SMART_MODEL", "AI_CLAUDE_FAST_MODEL", "OPENAI_API_KEY", ...Object.keys(env)];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, { AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "test-anthropic-key" });
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  try {
    return await run();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    (await import("../src/lib/anthropicChat")).setClaudeClientForTests(null);
  }
}

test("the switch and the models: the mini steps go to Haiku, everything else to Sonnet; off unless AI_PROVIDER=anthropic and a key", async () => {
  const chat = await import("../src/lib/anthropicChat");
  await withClaude({}, async () => {
    assert.equal(chat.claudeEnabled(), true);
    assert.equal(chat.claudeModelFor("gpt-4o-mini"), "claude-haiku-5-5", "photo queries, health ping, chat memory");
    assert.equal(chat.claudeModelFor("gpt-4.1-nano"), "claude-haiku-5-5");
    assert.equal(chat.claudeModelFor("gpt-4.1"), "claude-sonnet-5-5", "customer replies");
    assert.equal(chat.claudeModelFor("gpt-4.1-mini"), "claude-sonnet-5-5", "which-trip understanding and customer images are not the place to save");
    assert.equal(chat.claudeModelFor("gpt-4o"), "claude-sonnet-5-5", "files and price photos");
    assert.equal(chat.claudeModelFor("claude-opus-5-5"), "claude-opus-5-5");
    assert.equal(chat.claudeModelFor("gpt-4o-mini", "travel.ops.ai_clarify"), "claude-sonnet-5-5", "the card rewrite names no model (the gpt-4o-mini default); it was sent to Haiku and cut off mid-JSON (2026-11-22)");
    assert.equal(chat.claudeModelFor("gpt-4o-mini", "travel.ops.file_parse"), "claude-sonnet-5-5", "admin file work is never a simple step");
    assert.equal(chat.claudeModelFor("gpt-4o-mini", "api.webhook.catalog_listing"), "claude-haiku-5-5", "the chat memory note stays on Haiku");
  });
  await withClaude({ AI_CLAUDE_SMART_MODEL: "claude-opus-5-5", AI_CLAUDE_FAST_MODEL: "claude-sonnet-5-5" }, async () => {
    assert.equal(chat.claudeModelFor("gpt-4.1"), "claude-opus-5-5");
    assert.equal(chat.claudeModelFor("gpt-4o-mini"), "claude-sonnet-5-5");
  });
  await withClaude({ AI_PROVIDER: "openai" }, async () => assert.equal(chat.claudeEnabled(), false));
  await withClaude({ ANTHROPIC_API_KEY: undefined }, async () => assert.equal(chat.claudeEnabled(), false, "no key: OpenAI keeps answering"));
});

test("call shape: customer steps answer at once (thinking off), admin file work thinks, Haiku is low effort", async () => {
  const { claudeCallShape } = await import("../src/lib/anthropicChat");
  assert.deepEqual(claudeCallShape("claude-sonnet-5-5", "api.webhook", 1_000), { thinking: { type: "between_tools" }, effort: "medium", maxTokens: 1_000 });
  assert.deepEqual(claudeCallShape("claude-sonnet-5-5", "trip_understanding", 600), { thinking: { type: "between_tools" }, effort: "medium", maxTokens: 600 });
  assert.deepEqual(claudeCallShape("claude-sonnet-5-5", "travel.ops.file_parse", 16_000), { thinking: { type: "adaptive" }, effort: "medium", maxTokens: 32_000 });
  assert.deepEqual(claudeCallShape("claude-haiku-5-5", "trip_photos.rank", 200), { thinking: { type: "disabled" }, effort: "low", maxTokens: 200 });
  assert.equal(claudeCallShape("claude-haiku-5-5", "travel.ops.file_parse", undefined).thinking.type, "disabled", "Haiku never thinks here");
  assert.equal(claudeCallShape("claude-sonnet-5-5", "api.webhook", undefined).maxTokens, 16_384, "no cap named: OpenAI's own limit was the cap");
  assert.equal(claudeCallShape("claude-sonnet-5-5", "travel.ops.ai_clarify", undefined).maxTokens, 32_384, "a whole card rewrite plus thinking");
});

test("a customer reply through the shared call: Sonnet, cached rules, no temperature, the text back and the usage recorded", async () => {
  const chat = await import("../src/lib/anthropicChat");
  const { askOpenAIChatParts } = await import("../src/lib/openaiFallback");
  await withClaude({}, async () => {
    const { client, sent } = fakeClient([{ text: "Альфа аялал 12/2-нд гарна." }]);
    chat.setClaudeClientForTests(client);
    const result = await askOpenAIChatParts([{ text: "альфа хэзээ гарах вэ" }], { source: "api.webhook", model: "gpt-4.1", systemText: "RULES", temperature: 0, maxOutputTokens: 1_000 });
    assert.equal(result?.text, "Альфа аялал 12/2-нд гарна.");
    assert.deepEqual(result?.usage, { prompt_tokens: 8_900, completion_tokens: 40, total_tokens: 8_940 });
    const body = sent[0].body;
    assert.match(sent[0].url, /\/v1\/messages/);
    assert.equal(body.model, "claude-sonnet-5-5");
    assert.equal(body.stream, true);
    assert.equal(body.max_tokens, 1_000);
    assert.equal("temperature" in body, false, "the models refuse sampling settings");
    assert.deepEqual(body.system, [{ type: "text", text: "RULES", cache_control: { type: "ephemeral", ttl: "1h" } }]);
    assert.deepEqual(body.thinking, { type: "between_tools" });
    assert.deepEqual(body.output_config, { effort: "medium" });
    assert.deepEqual(body.messages, [{ role: "user", content: [{ type: "text", text: "альфа хэзээ гарах вэ" }] }]);
  });
});

test("JSON mode, images and PDFs: the rule is added, the image and the PDF go as blocks, the object comes out of a fenced reply", async () => {
  const chat = await import("../src/lib/anthropicChat");
  await withClaude({}, async () => {
    const { client, sent } = fakeClient([{ text: "```json\n{\"photos\":[2]}\n```" }]);
    chat.setClaudeClientForTests(client);
    const result = await chat.askClaudeChatParts([
      { text: "rank" }, { inlineData: { mimeType: "image/png", data: "aW1n" } }, { inlineData: { mimeType: "application/pdf", data: "cGRm" } },
    ], { source: "trip_photos.rank", model: "gpt-4o-mini", jsonMode: true, maxOutputTokens: 200 });
    assert.equal(result?.text, "{\"photos\":[2]}");
    const body = sent[0].body;
    assert.equal(body.model, "claude-haiku-5-5");
    assert.match(String((body.system as Array<{ text: string }>)[0].text), /exactly one JSON object/);
    assert.deepEqual((body.messages as Array<{ content: unknown[] }>)[0].content, [
      { type: "text", text: "rank" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1n" } },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "cGRm" } },
    ]);
  });
});

test("which-trip understanding: the date and catalogue head is cached, the conversation after it is not", async () => {
  const { toClaudeContent } = await import("../src/lib/anthropicChat");
  const user = "Today: 2030-01-02\n\nCatalog (key | name | length | next departures):\nT1 | Альфа | 5 өдөр\n\nConversation so far:\nCustomer: сайн уу\n\nCustomer's new message: альфа";
  assert.deepEqual(toClaudeContent([{ text: user }], "\nConversation so far:"), [
    { type: "text", text: "Today: 2030-01-02\n\nCatalog (key | name | length | next departures):\nT1 | Альфа | 5 өдөр\n", cache_control: { type: "ephemeral" } },
    { type: "text", text: "\nConversation so far:\nCustomer: сайн уу\n\nCustomer's new message: альфа" },
  ]);
  assert.deepEqual(toClaudeContent([{ text: "no marker here" }], "\nConversation so far:"), [{ type: "text", text: "no marker here" }]);
});

test("a decline or an empty reply is no answer (REFER: silence and a staff lead), never an apology", async () => {
  const chat = await import("../src/lib/anthropicChat");
  await withClaude({}, async () => {
    chat.setClaudeClientForTests(fakeClient([{ stop: "refusal" }]).client);
    assert.equal((await chat.askClaudeChatParts([{ text: "x" }], { source: "api.webhook", model: "gpt-4.1" }))?.text, "REFER");
    chat.setClaudeClientForTests(fakeClient([{ text: "" }]).client);
    assert.equal((await chat.askClaudeChatParts([{ text: "x" }], { source: "api.webhook", model: "gpt-4.1" }))?.text, "REFER");
  });
});

test("overloaded Sonnet: Haiku answers instead of nobody; a rejected key is told to the caller and nothing else is tried", async () => {
  const chat = await import("../src/lib/anthropicChat");
  await withClaude({}, async () => {
    const busy = { status: 529, error: { type: "overloaded_error", message: "Overloaded" } };
    const overloaded = fakeClient([busy, busy, { text: "Тийм." }]);
    chat.setClaudeClientForTests(overloaded.client);
    const result = await chat.askClaudeChatParts([{ text: "x" }], { source: "api.webhook", model: "gpt-4.1" });
    assert.equal(result?.text, "Тийм.");
    assert.deepEqual(overloaded.sent.map((entry) => entry.body.model), ["claude-sonnet-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"], "the SDK's one retry, then Haiku");

    const rejected = fakeClient([{ status: 401, error: { type: "authentication_error", message: "invalid x-api-key" } }]);
    chat.setClaudeClientForTests(rejected.client);
    let told = "";
    const none = await chat.askClaudeChatParts([{ text: "x" }], { source: "api.webhook", model: "gpt-4.1", onFailure: (failure) => { told = failure.kind; } });
    assert.equal(none, null);
    assert.equal(told, "unauthorized");
    assert.equal(rejected.sent.length, 1, "a rejected key is not retried, and Haiku would be rejected too");
  });
});

test("Claude down: OpenAI answers as the backup while its key exists; AI_OPENAI_BACKUP=off means Claude only", async () => {
  const chat = await import("../src/lib/anthropicChat");
  const { askOpenAIChatParts } = await import("../src/lib/openaiFallback");
  const realFetch = globalThis.fetch;
  const openaiCalls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    openaiCalls.push(String(url));
    const body = JSON.parse(String(init?.body || "{}"));
    return new Response(JSON.stringify({ choices: [{ message: { content: `OpenAI ${body.model}` }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await withClaude({ OPENAI_API_KEY: "test-openai-key" }, async () => {
      chat.setClaudeClientForTests(fakeClient([{ status: 400, error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }]).client);
      const result = await askOpenAIChatParts([{ text: "x" }], { source: "api.webhook", model: "gpt-4.1" });
      assert.equal(result?.text, "OpenAI gpt-4.1", "the customer still gets an answer");
      assert.equal(openaiCalls.length, 1);
      assert.match(openaiCalls[0], /api\.openai\.com/);
    });
    await withClaude({ OPENAI_API_KEY: "test-openai-key", AI_OPENAI_BACKUP: "off" }, async () => {
      chat.setClaudeClientForTests(fakeClient([{ status: 400, error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }]).client);
      let told = "";
      const result = await askOpenAIChatParts([{ text: "x" }], { source: "api.webhook", model: "gpt-4.1", onFailure: (failure) => { told = failure.kind; } });
      assert.equal(result, null);
      assert.equal(told, "credits_exhausted");
      assert.equal(openaiCalls.length, 1, "OpenAI was not called");
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});
