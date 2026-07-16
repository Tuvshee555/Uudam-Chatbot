import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

async function loadProviderModule() {
  const envModule = await import("../src/lib/env");
  envModule.resetEnvCacheForTests();
  const resilienceModule = await import("../src/lib/resilience");
  resilienceModule.resetResilienceStateForTests();
  const providerModule = await import("../src/lib/openaiProvider");
  return { providerModule };
}

type OpenAIChatBody = {
  model?: string;
  messages?: Array<{
    role?: string;
    content?: string | Array<{ type?: string; text?: string }>;
  }>;
};

test("askOpenAI compatibility wrapper calls OpenAI and retries transient failures", async () => {
  applyTestEnv({
    OPENAI_MAX_RETRIES: "2",
    OPENAI_RETRY_BASE_DELAY_MS: "50",
    OPENAI_TIMEOUT_MS: "2000",
  });

  const { providerModule } = await loadProviderModule();
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);
    attempts += 1;
    if (url.includes("googleapis.com")) {
      throw new Error("Google AI provider must not be called");
    }
    if (attempts < 2) {
      return new Response("temporary error", { status: 503 });
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "Сайн байна уу" } }],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  try {
    const result = await providerModule.askOpenAI("hello", {
      source: "test.openai",
    });
    assert.equal(result.text.includes("Сайн байна уу"), true);
    assert.equal(result.usage.total_tokens, 17);
    assert.equal(attempts, 2);
    assert.ok(urls.every((url) => url.includes("api.openai.com")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("askOpenAI compatibility wrapper forwards systemInstruction and OpenAI model override", async () => {
  applyTestEnv({
    OPENAI_MAX_RETRIES: "0",
    OPENAI_TIMEOUT_MS: "2000",
  });

  const { providerModule } = await loadProviderModule();
  const originalFetch = globalThis.fetch;
  let capturedBody: OpenAIChatBody | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("googleapis.com")) {
      throw new Error("Google AI provider must not be called");
    }
    assert.ok(url.includes("api.openai.com"));
    capturedBody = JSON.parse(String(init?.body)) as OpenAIChatBody;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "REFER" } }],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  try {
    const result = await providerModule.askOpenAI("Тэнгэрийн хаалга хэд вэ?", {
      source: "test.openai",
      systemInstruction: "SYSTEM RULES: always answer in Mongolian, REFER if unknown.",
      openaiModel: "gpt-4o",
    });

    assert.equal(result.text, "REFER");
    assert.ok(capturedBody, "expected OpenAI to be called");
    const body = capturedBody as OpenAIChatBody;
    assert.equal(body.model, "gpt-4o");
    assert.ok(
      body.messages?.some(
        (message: NonNullable<OpenAIChatBody["messages"]>[number]) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.includes("SYSTEM RULES"),
      ),
      "expected the system prompt to be sent to OpenAI",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("askOpenAI compatibility wrapper fails fast on timeout when retries are disabled", async () => {
  applyTestEnv({
    OPENAI_MAX_RETRIES: "0",
    OPENAI_TIMEOUT_MS: "25",
  });

  const { providerModule } = await loadProviderModule();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      if (init?.signal) {
        init.signal.addEventListener("abort", () => {
          reject(init.signal?.reason ?? new Error("aborted"));
        });
      }
    })) as typeof fetch;

  try {
    await assert.rejects(
      () => providerModule.askOpenAI("hello timeout", { source: "test.openai" }),
      /OpenAI|timed out|timeout/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
