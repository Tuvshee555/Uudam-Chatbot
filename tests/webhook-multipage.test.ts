import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

type WebhookHandler = (req: unknown, res: unknown) => Promise<unknown>;

const PAGE_A = "1010493442437235";
const PAGE_B = "596733917653582";
const TOKEN_A = "tokenForPageA";
const TOKEN_B = "tokenForPageB";

function signPayload(rawBody: Buffer, appSecret: string) {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
}

function createWebhookRequest(payload: unknown, appSecret: string) {
  const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
  const signature = signPayload(rawBody, appSecret);
  return {
    method: "POST",
    url: "/api/webhook",
    query: {},
    headers: {
      "content-length": String(rawBody.length),
      "x-hub-signature-256": signature,
      "content-type": "application/json",
    },
    async *[Symbol.asyncIterator]() {
      yield rawBody;
    },
  } as unknown;
}

function createWebhookResponse() {
  let statusCode = 200;
  let body: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(value: unknown) {
      body = value;
      return res;
    },
    send(value: unknown) {
      body = value;
      return res;
    },
    end(value?: unknown) {
      body = value;
      return res;
    },
    setHeader() {},
    get statusCode() {
      return statusCode;
    },
  } as unknown;
  return { res, result: () => ({ statusCode, body }) };
}

async function loadWebhookHandler(): Promise<WebhookHandler> {
  const envModule = await import("../src/lib/env");
  const rateLimitModule = await import("../src/lib/rateLimit");
  const resilienceModule = await import("../src/lib/resilience");
  const redisStateModule = await import("../src/lib/redisState");
  const webhookModule = await import("../src/pages/api/webhook");

  envModule.resetEnvCacheForTests();
  rateLimitModule.resetRateLimitForTests();
  resilienceModule.resetResilienceStateForTests();
  redisStateModule.resetRedisStateForTests();
  webhookModule.resetWebhookStateForTests();

  return webhookModule.default as WebhookHandler;
}

async function callWebhook(handler: WebhookHandler, payload: unknown) {
  const appSecret = process.env.META_APP_SECRET || "test-meta-secret";
  const req = createWebhookRequest(payload, appSecret);
  const { res, result } = createWebhookResponse();
  await handler(req, res);
  return result();
}

function pageMessage(pageId: string, senderId: string, mid: string, text: string) {
  return {
    object: "page",
    entry: [
      {
        id: pageId,
        messaging: [{ sender: { id: senderId }, message: { mid, text } }],
      },
    ],
  };
}

function promptTextFromOpenAIRequest(rawBody: unknown) {
  const body = JSON.parse(String(rawBody || "{}")) as {
    messages?: Array<{
      content?: string | Array<{ type?: string; text?: string }>;
    }>;
  };
  const userMessage = body.messages?.findLast((message) =>
    Array.isArray(message.content),
  );
  if (!Array.isArray(userMessage?.content)) return "";
  return userMessage.content
    .filter((part) => part.type === "text")
    .map((part) => part.text || "")
    .join("\n");
}

function stubFetch(record: {
  sendTokens: string[];
  openaiPrompts: string[];
}) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("api.openai.com")) {
      record.openaiPrompts.push(promptTextFromOpenAIRequest(init?.body));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "Sain baina uu" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200 },
      );
    }
    if (url.includes("/messages")) {
      const match = url.match(/access_token=([^&]+)/);
      record.sendTokens.push(match ? match[1] : "");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("webhook replies to each page with that page's own token", async () => {
  applyTestEnv({
    FACEBOOK_PAGES: `${PAGE_A}:${TOKEN_A},${PAGE_B}:${TOKEN_B}`,
    TOKEN_PAGE: undefined,
    FACEBOOK_PAGE_ID: undefined,
  });
  const handler = await loadWebhookHandler();
  const record = { sendTokens: [] as string[], openaiPrompts: [] as string[] };
  const restore = stubFetch(record);
  try {
    const a = await callWebhook(
      handler,
      pageMessage(PAGE_A, "customer-1", "mid-a-1", "sain uu"),
    );
    const b = await callWebhook(
      handler,
      pageMessage(PAGE_B, "customer-2", "mid-b-1", "sain uu"),
    );
    assert.equal(a.statusCode, 200);
    assert.equal(b.statusCode, 200);
    const tokensForA = record.sendTokens.slice(0, 2);
    const tokensForB = record.sendTokens.slice(2);
    assert.ok(record.sendTokens.length >= 2, "page A should have sent at least once");
    assert.ok(record.sendTokens.length >= 4, "page B should have sent at least once");
    assert.ok(tokensForA.every((token) => token === TOKEN_A));
    assert.ok(tokensForB.every((token) => token === TOKEN_B));
  } finally {
    restore();
  }
});

test("webhook keeps the same sender's history separate per page", async () => {
  applyTestEnv({
    FACEBOOK_PAGES: `${PAGE_A}:${TOKEN_A},${PAGE_B}:${TOKEN_B}`,
    TOKEN_PAGE: undefined,
    FACEBOOK_PAGE_ID: undefined,
  });
  const handler = await loadWebhookHandler();
  const record = { sendTokens: [] as string[], openaiPrompts: [] as string[] };
  const restore = stubFetch(record);
  try {
    await callWebhook(
      handler,
      pageMessage(PAGE_A, "shared-sender", "mid-1", "only-on-page-A"),
    );
    const promptCountAfterPageA = record.openaiPrompts.length;
    assert.ok(promptCountAfterPageA >= 1, "page A message should reach OpenAI");

    await callWebhook(
      handler,
      pageMessage(PAGE_B, "shared-sender", "mid-2", "only-on-page-B"),
    );

    const pageBPrompts = record.openaiPrompts.slice(promptCountAfterPageA);
    assert.ok(pageBPrompts.length >= 1, "page B message should reach OpenAI");
    for (const pageBPrompt of pageBPrompts) {
      assert.ok(pageBPrompt.includes("only-on-page-B"));
      assert.ok(!pageBPrompt.includes("only-on-page-A"));
    }
  } finally {
    restore();
  }
});

test("webhook drops messages for a page not in the roster", async () => {
  applyTestEnv({
    FACEBOOK_PAGES: `${PAGE_A}:${TOKEN_A}`,
    TOKEN_PAGE: undefined,
    FACEBOOK_PAGE_ID: undefined,
  });
  const handler = await loadWebhookHandler();
  const record = { sendTokens: [] as string[], openaiPrompts: [] as string[] };
  const restore = stubFetch(record);
  try {
    const res = await callWebhook(
      handler,
      pageMessage("999999999999999", "stranger", "mid-x", "sain uu"),
    );
    assert.equal(res.statusCode, 200);
    assert.equal(record.sendTokens.length, 0);
    assert.equal(record.openaiPrompts.length, 0);
  } finally {
    restore();
  }
});
