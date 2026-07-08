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
  let capturedBody: any = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("generativelanguage.googleapis.com")) {
      return new Response("rate limited", { status: 429 });
    }
    if (url.includes("api.openai.com")) {
      capturedBody = JSON.parse(String(init?.body));
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
    assert.ok(capturedBody, "expected the OpenAI fallback to be called");
    assert.equal(capturedBody.model, "gpt-4o");
    assert.ok(
      capturedBody.messages.some(
        (m: { role: string; content: string }) =>
          m.role === "system" && m.content.includes("SYSTEM RULES"),
      ),
      "expected the system prompt to survive into the fallback call",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
