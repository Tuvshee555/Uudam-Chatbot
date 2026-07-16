import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

applyTestEnv({
  OPENAI_MAX_RETRIES: "0",
  OPENAI_TIMEOUT_MS: "2000",
  OPENAI_API_KEY: "test-openai-key",
});

type OpenAIChatBody = {
  model?: string;
  messages?: Array<{ role?: string; content?: string }>;
};

test("OpenAI primary falls back from gpt-4o to gpt-4o-mini when only the requested model is rate limited", async () => {
  const providerModule = await import("../src/lib/openaiProvider");
  const { resetResilienceStateForTests } = await import("../src/lib/resilience");
  resetResilienceStateForTests();
  const originalFetch = globalThis.fetch;
  const models: string[] = [];
  let googleCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("googleapis.com")) {
      googleCalls += 1;
      throw new Error("Google AI provider must not be called");
    }
    if (url.includes("api.openai.com")) {
      const body = JSON.parse(String(init?.body)) as OpenAIChatBody;
      models.push(body.model || "");
      if (body.model === "gpt-4o") {
        return new Response("rate limited", { status: 429 });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "mini worked" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;

  try {
    const result = await providerModule.askOpenAI("parse this file", {
      source: "travel.ops.file_parse",
      preferOpenAI: true,
      openaiModel: "gpt-4o",
    });

    assert.equal(result.text, "mini worked");
    assert.deepEqual(models, ["gpt-4o", "gpt-4o-mini"]);
    assert.equal(googleCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
