import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

/**
 * The agent's one OpenAI call (function calling): what is sent, how tool calls come back,
 * and how failures are told apart — a fast 5xx is retried once, a timeout never is (one
 * slow call must not eat the whole 60 s turn), a rejected key is reported as such.
 */

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

async function setup(context: import("node:test").TestContext, responder: (body: Record<string, unknown>, attempt: number) => Promise<Response> | Response) {
  applyTestEnv({ AI_USAGE_ENVIRONMENT: "test" });
  const bodies: Array<Record<string, unknown>> = [];
  context.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}"));
    bodies.push(body);
    const signal = init?.signal;
    const answer = responder(body, bodies.length);
    return signal ? Promise.race([answer, new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)))]) : answer;
  });
  const { resetEnvCacheForTests } = await import("../src/lib/env");
  resetEnvCacheForTests();
  const { resetResilienceStateForTests } = await import("../src/lib/resilience");
  resetResilienceStateForTests();
  const { openAIToolChat, AgentModelError } = await import("../src/lib/assistantAgent/openaiTools");
  const { AGENT_TOOLS } = await import("../src/lib/assistantAgent/tools");
  const call = (timeoutMs = 2_000) => openAIToolChat({ messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }], tools: AGENT_TOOLS, toolChoice: "required", timeoutMs, model: "gpt-4.1" });
  return { bodies, call, AgentModelError };
}

test("the request carries the tools, temperature 0 and the model; tool calls and usage come back", async (context) => {
  const { bodies, call } = await setup(context, () => ok({
    choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "search_trips", arguments: "{\"query\":\"альфа\"}" } }] }, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 6_500, completion_tokens: 40, total_tokens: 6_540, prompt_tokens_details: { cached_tokens: 6_144 } },
  }));
  const result = await call();
  assert.deepEqual(result.message.tool_calls, [{ id: "c1", type: "function", function: { name: "search_trips", arguments: "{\"query\":\"альфа\"}" } }]);
  assert.equal(result.usage.cached_tokens, 6_144);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].model, "gpt-4.1");
  assert.equal(bodies[0].temperature, 0);
  assert.equal(bodies[0].tool_choice, "required");
  assert.equal((bodies[0].tools as unknown[]).length, 9);
});

test("a fast 5xx is retried once; a rejected key is not retried and says so", async (context) => {
  const flaky = await setup(context, (_body, attempt) => (attempt === 1
    ? new Response("{\"error\":{\"code\":\"server_error\"}}", { status: 502 })
    : ok({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })));
  const result = await flaky.call();
  assert.equal(result.message.content, "ok");
  assert.equal(flaky.bodies.length, 2);
});

test("a rejected key fails at once as 'unauthorized'", async (context) => {
  const denied = await setup(context, () => new Response("{\"error\":{\"code\":\"invalid_api_key\"}}", { status: 401 }));
  await assert.rejects(denied.call(), (error: unknown) => error instanceof denied.AgentModelError && error.kind === "unauthorized");
  assert.equal(denied.bodies.length, 1);
});

test("a timeout is never retried", async (context) => {
  const slow = await setup(context, () => new Promise<Response>(() => {}));
  await assert.rejects(slow.call(150), (error: unknown) => error instanceof slow.AgentModelError && error.kind === "timeout");
  assert.equal(slow.bodies.length, 1);
});
