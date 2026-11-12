import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

applyTestEnv({
  OPENAI_MAX_RETRIES: "0",
  OPENAI_TIMEOUT_MS: "2000",
  OPENAI_API_KEY: "test-openai-key",
});

/**
 * Cost (2026-11-12): every model call asks the provider to keep the shared prompt prefix (rules +
 * catalogue) cached for 24 h, so repeated input is billed at the cached rate. It must never cost an
 * answer: if the provider refuses the parameters, the same call goes out again without them.
 */
type Body = { model?: string; prompt_cache_retention?: string; prompt_cache_key?: string };
const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200 });

test("model calls carry 24 h prompt-cache retention and a per-source key; a refusal retries without them", async () => {
  const { askOpenAIChatParts } = await import("../src/lib/openaiFallback");
  const { resetResilienceStateForTests } = await import("../src/lib/resilience");
  const { customerImageModel } = await import("../src/lib/customerDocuments");
  resetResilienceStateForTests();
  const originalFetch = globalThis.fetch;
  const bodies: Body[] = [];
  let refuse = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (!url.includes("api.openai.com")) throw new Error(`unexpected fetch to ${url}`);
    const body = JSON.parse(String(init?.body)) as Body;
    bodies.push(body);
    if (refuse && body.prompt_cache_retention) {
      return new Response(JSON.stringify({ error: { message: "Unknown parameter: 'prompt_cache_retention'." } }), { status: 400 });
    }
    return ok();
  }) as typeof fetch;
  try {
    const first = await askOpenAIChatParts([{ text: "hello" }], { source: "trip_understanding", model: "gpt-4.1" });
    assert.equal(first?.text, "ok");
    assert.equal(bodies[0].prompt_cache_retention, "24h");
    assert.equal(bodies[0].prompt_cache_key, "uudam:trip_understanding:gpt-4.1");
    // Calls of one kind share a key whatever their sub-route: "api.webhook.reply_fallback" -> "api.webhook".
    await askOpenAIChatParts([{ text: "hello" }], { source: "api.webhook.reply_fallback", model: "gpt-4.1" });
    assert.equal(bodies[1].prompt_cache_key, "uudam:api.webhook:gpt-4.1");

    // The provider refuses the parameters: the customer still gets the answer, without them.
    refuse = true;
    bodies.length = 0;
    const retried = await askOpenAIChatParts([{ text: "hello" }], { source: "trip_understanding", model: "gpt-4.1" });
    assert.equal(retried?.text, "ok", "the call is repeated, not lost");
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].prompt_cache_retention, "24h");
    assert.equal(bodies[1].prompt_cache_retention, undefined);
    // Once refused, later calls in this process do not send them again.
    bodies.length = 0;
    await askOpenAIChatParts([{ text: "hello" }], { source: "trip_understanding", model: "gpt-4.1" });
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].prompt_cache_retention, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
  // Customer images are read by the model that bills a picture at a fraction of gpt-4o-mini's tokens.
  assert.equal(customerImageModel(), "gpt-4.1-mini");
});
