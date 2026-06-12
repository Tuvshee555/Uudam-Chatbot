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

/**
 * Stubs Gemini + Graph send. Captures the access_token used on each /messages
 * call and the prompt text Gemini received (so we can assert conversation
 * isolation by page).
 */
function stubFetch(record: {
  sendTokens: string[];
  geminiPrompts: string[];
}) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes(":generateContent")) {
      const body = JSON.parse(String(init?.body || "{}")) as {
        contents?: { parts?: { text?: string }[] }[];
      };
      record.geminiPrompts.push(body.contents?.[0]?.parts?.[0]?.text ?? "");
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "Сайн байна уу" }] } }],
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
  const record = { sendTokens: [] as string[], geminiPrompts: [] as string[] };
  const restore = stubFetch(record);
  try {
    const a = await callWebhook(
      handler,
      pageMessage(PAGE_A, "customer-1", "mid-a-1", "сайн уу"),
    );
    const b = await callWebhook(
      handler,
      pageMessage(PAGE_B, "customer-2", "mid-b-1", "сайн уу"),
    );
    assert.equal(a.statusCode, 200);
    assert.equal(b.statusCode, 200);
    // Each page triggers a typing indicator + the reply, both on /messages — so
    // there are two sends per page. Every send must use that page's own token.
    const tokensForA = record.sendTokens.slice(0, 2);
    const tokensForB = record.sendTokens.slice(2);
    assert.ok(record.sendTokens.length >= 2, "page A should have sent at least once");
    assert.ok(record.sendTokens.length >= 4, "page B should have sent at least once");
    assert.ok(
      tokensForA.every((t) => t === TOKEN_A),
      "all page A sends must use page A's token",
    );
    assert.ok(
      tokensForB.every((t) => t === TOKEN_B),
      "all page B sends must use page B's token",
    );
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
  const record = { sendTokens: [] as string[], geminiPrompts: [] as string[] };
  const restore = stubFetch(record);
  try {
    // Same PSID messages page A, then page B. The page-B prompt must NOT contain
    // the page-A message — histories are isolated by page id.
    await callWebhook(
      handler,
      pageMessage(PAGE_A, "shared-sender", "mid-1", "only-on-page-A"),
    );
    await callWebhook(
      handler,
      pageMessage(PAGE_B, "shared-sender", "mid-2", "only-on-page-B"),
    );

    assert.equal(record.geminiPrompts.length, 2);
    const pageBPrompt = record.geminiPrompts[1];
    assert.ok(
      pageBPrompt.includes("only-on-page-B"),
      "page B prompt should contain page B's message",
    );
    assert.ok(
      !pageBPrompt.includes("only-on-page-A"),
      "page B prompt must not leak page A's history",
    );
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
  const record = { sendTokens: [] as string[], geminiPrompts: [] as string[] };
  const restore = stubFetch(record);
  try {
    const res = await callWebhook(
      handler,
      pageMessage("999999999999999", "stranger", "mid-x", "сайн уу"),
    );
    // Webhook still acknowledges (200) but never replies to an unknown page.
    assert.equal(res.statusCode, 200);
    assert.equal(record.sendTokens.length, 0);
    assert.equal(record.geminiPrompts.length, 0);
  } finally {
    restore();
  }
});
