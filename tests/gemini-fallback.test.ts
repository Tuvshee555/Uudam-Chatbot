import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

// Kept in its own file: openaiFallback.ts caches `getEnv()` into a top-level
// const at first import, so OPENAI_API_KEY must be set before ANY module in
// this process has imported it. Sharing a file with tests that import
// gemini.ts (which imports openaiFallback.ts) without the key set first would
// permanently cache openaiApiKey=null for the rest of the process.
applyTestEnv({
  GEMINI_MAX_RETRIES: "0",
  GEMINI_TIMEOUT_MS: "2000",
  OPENAI_API_KEY: "test-openai-key",
});

type OpenAIChatBody = {
  model?: string;
  messages?: Array<{ role?: string; content?: string }>;
};

test("askGemini's internal OpenAI fallback forwards systemInstruction and the caller's model override", async () => {
  // Regression: on a Gemini outage/rate-limit, askGemini's own catch block
  // used to call askOpenAIFallbackParts without `model` or `systemText` —
  // silently dropping the persona/REFER/anti-injection system prompt and
  // downgrading to whatever OPENAI_MODEL defaults to, no matter what
  // stronger model or system prompt the caller asked for. The caller's own
  // try/catch fallback (in demo.ts/webhook.ts) never even ran because this
  // internal fallback already returned a "successful" (but ungrounded) reply.
  const geminiModule = await import("../src/lib/gemini");
  const originalFetch = globalThis.fetch;
  const captured: { body: OpenAIChatBody | null } = { body: null };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("generativelanguage.googleapis.com")) {
      return new Response("rate limited", { status: 429 });
    }
    if (url.includes("api.openai.com")) {
      captured.body = JSON.parse(String(init?.body)) as OpenAIChatBody;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "REFER" } }],
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
        }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;

  try {
    const result = await geminiModule.askGemini("Тэнгэрийн хаалга хэд вэ?", {
      source: "test.gemini.fallback",
      systemInstruction: "SYSTEM RULES: always answer in Mongolian, REFER if unknown.",
      openaiModel: "gpt-4o",
    });

    assert.equal(result.text, "REFER");
    const capturedBody = captured.body;
    assert.ok(capturedBody, "expected the OpenAI fallback to be called");
    assert.equal(capturedBody.model, "gpt-4o");
    assert.ok(
      capturedBody.messages?.some(
        (message) =>
          message.role === "system" && message.content?.includes("SYSTEM RULES"),
      ),
      "expected the system prompt to survive into the fallback call",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI primary falls back from gpt-4o to gpt-4o-mini when only the requested model is rate limited", async () => {
  const geminiModule = await import("../src/lib/gemini");
  const { resetResilienceStateForTests } = await import("../src/lib/resilience");
  resetResilienceStateForTests();
  const originalFetch = globalThis.fetch;
  const models: string[] = [];
  let geminiCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
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
    if (url.includes("generativelanguage.googleapis.com")) {
      geminiCalls += 1;
      return new Response("unexpected", { status: 500 });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;

  try {
    const result = await geminiModule.askGemini("parse this file", {
      source: "travel.ops.file_parse",
      preferOpenAI: true,
      openaiModel: "gpt-4o",
    });

    assert.equal(result.text, "mini worked");
    assert.ok(models.includes("gpt-4o"));
    assert.ok(models.includes("gpt-4o-mini"));
    assert.equal(geminiCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gemini rate limiting falls back from Pro to Flash before crossing providers", async () => {
  const geminiModule = await import("../src/lib/gemini");
  const { resetResilienceStateForTests } = await import("../src/lib/resilience");
  resetResilienceStateForTests();
  const originalFetch = globalThis.fetch;
  const geminiModels: string[] = [];
  let openAICalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("generativelanguage.googleapis.com")) {
      const model = decodeURIComponent(url).match(/models\/([^:]+):/)?.[1] || "";
      geminiModels.push(model);
      if (model === "gemini-2.5-pro") {
        return new Response("rate limited", { status: 429 });
      }
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "flash worked" }] } }],
          usageMetadata: {},
        }),
        { status: 200 },
      );
    }
    if (url.includes("api.openai.com")) {
      openAICalls += 1;
      return new Response("unexpected", { status: 500 });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;

  try {
    const result = await geminiModule.askGemini("parse this file", {
      source: "travel.ops.file_parse",
      model: "gemini-2.5-pro",
      maxRetries: 0,
    });

    assert.equal(result.text, "flash worked");
    assert.deepEqual(geminiModels, ["gemini-2.5-pro", "gemini-2.5-flash"]);
    assert.equal(openAICalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
