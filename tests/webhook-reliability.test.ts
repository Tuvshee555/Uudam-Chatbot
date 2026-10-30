import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import test, { after, before, mock } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { applyTestEnv as applyBaseTestEnv } from "./helpers/env";

const execFileAsync = promisify(execFile);
const persistedLeadSenders = new Set<string>();

function applyTestEnv() {
  applyBaseTestEnv({ NEON_DATABASE_URL: "postgres://test:test@127.0.0.1:1/webhook-reliability-fixture" });
}

before(async () => {
  const { Pool } = await import("pg");
  const query = async (sql: string, params: unknown[] = []) => {
    if (/COUNT[\s\S]*FROM travel_leads/i.test(sql)) return { rows: [{ count: persistedLeadSenders.has(String(params[0])) ? "1" : "0" }], rowCount: 1 };
    if (/INSERT INTO travel_leads/i.test(sql)) {
      persistedLeadSenders.add(String(params[2]));
      return { rows: [{ id: persistedLeadSenders.size, kind: params[0], platform: params[1], sender_id: params[2], status: "new" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  mock.method(Pool.prototype, "query", query as unknown as typeof Pool.prototype.query);
  mock.method(Pool.prototype, "connect", (async () => ({ query, release() {} })) as unknown as typeof Pool.prototype.connect);
});

after(async () => {
  const { closeNeonPool } = await import("../src/lib/neonDb");
  await closeNeonPool();
  mock.restoreAll();
});

type WebhookHandler = (
  req: unknown,
  res: unknown,
) => Promise<unknown>;

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
  const headers = new Map<string, string>();

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
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    get statusCode() {
      return statusCode;
    },
  } as unknown;

  return {
    res,
    result: () => ({
      statusCode,
      body,
      headers: Object.fromEntries(headers),
    }),
  };
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

test("webhook retries transient send failure then dedupes completed event", async () => {
  applyTestEnv();
  const handler = await loadWebhookHandler();

  const originalFetch = globalThis.fetch;
  let sendAttempts = 0;
  let openaiAttempts = 0;

  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes("api.openai.com")) {
      openaiAttempts += 1;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "Sain baina uu?" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
        { status: 200 },
      );
    }

    if (url.includes("/messages")) {
      sendAttempts += 1;
      // Plain replies make one delivery attempt per signed event. Fail that
      // attempt so the outer retry and dedupe path is exercised.
      if (sendAttempts <= 1) {
        return new Response("temporary send failure", { status: 500 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const payload = {
      object: "instagram",
      entry: [
        {
          id: "ig-page-retry",
          messaging: [
            {
              sender: { id: "ig-user-retry" },
              message: { mid: "ig-mid-retry-1", text: "hello retry path" },
            },
          ],
        },
      ],
    };

    const first = await callWebhook(handler, payload);
    const second = await callWebhook(handler, payload);
    const openaiAttemptsBeforeDedupe = openaiAttempts;
    const third = await callWebhook(handler, payload);

    assert.equal(first.statusCode, 503);
    assert.equal(second.statusCode, 200);
    assert.equal(third.statusCode, 200);
    assert.equal(sendAttempts, 2);
    // This self-contained message needs only the answer call. Two real attempts
    // ran; the deduped third delivery must add no model calls at all.
    assert.equal(openaiAttempts, 2);
    assert.equal(openaiAttempts, openaiAttemptsBeforeDedupe);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("webhook keeps a greeting reply free of unsolicited operator buttons", async () => {
  applyTestEnv();
  const handler = await loadWebhookHandler();

  const originalFetch = globalThis.fetch;
  let quickReplyTitles: string[] = [];

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("api.openai.com")) {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "Тавтай морил! Аяллын талаар асуугаарай." } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200 },
      );
    }

    if (url.includes("/messages")) {
      const body = JSON.parse(String(init?.body || "{}")) as {
        message?: { quick_replies?: Array<{ title?: string }> };
      };
      quickReplyTitles = (body.message?.quick_replies || []).map((q) => q.title || "");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const payload = {
      object: "instagram",
      entry: [
        {
          id: "ig-page-operator-button",
          messaging: [
            {
              sender: { id: "ig-user-operator-button" },
              message: { mid: "ig-mid-operator-button-1", text: "сайн байна уу" },
            },
          ],
        },
      ],
    };

    const result = await callWebhook(handler, payload);

    assert.equal(result.statusCode, 200);
    assert.deepEqual(quickReplyTitles, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("webhook preserves reply order for concurrent same-user requests", async () => {
  applyTestEnv();
  const handler = await loadWebhookHandler();

  const originalFetch = globalThis.fetch;
  const sentTexts: string[] = [];

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("api.openai.com")) {
      const prompt = promptTextFromOpenAIRequest(init?.body);
      const matches = Array.from(prompt.matchAll(/User:\s*([^\n]+)\nAssistant:/gm));
      const userText = (matches[matches.length - 1]?.[1] || "unknown").trim();

      if (userText === "first") {
        await sleep(250);
      }

      return new Response(
        JSON.stringify({ choices: [{ message: { content: `reply:${userText}` } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
        { status: 200 },
      );
    }

    if (url.includes("/messages")) {
      const body = JSON.parse(String(init?.body || "{}")) as {
        message?: { text?: string };
      };
      sentTexts.push(String(body.message?.text || ""));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const firstPayload = {
      object: "instagram",
      entry: [
        {
          id: "ig-page-concurrency",
          messaging: [
            {
              sender: { id: "ig-user-concurrency" },
              message: { mid: "ig-mid-concurrency-1", text: "first" },
            },
          ],
        },
      ],
    };

    const secondPayload = {
      object: "instagram",
      entry: [
        {
          id: "ig-page-concurrency",
          messaging: [
            {
              sender: { id: "ig-user-concurrency" },
              message: { mid: "ig-mid-concurrency-2", text: "second" },
            },
          ],
        },
      ],
    };

    const firstPromise = callWebhook(handler, firstPayload);
    await sleep(20);
    const secondPromise = callWebhook(handler, secondPayload);

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.deepEqual(sentTexts, ["reply:first", "reply:second"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("webhook handles long OpenAI latency without dropping event", async () => {
  applyTestEnv();
  const handler = await loadWebhookHandler();

  const originalFetch = globalThis.fetch;
  let sendCount = 0;

  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes("api.openai.com")) {
      await sleep(700);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "slow reply" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200 },
      );
    }

    if (url.includes("/messages")) {
      sendCount += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const payload = {
      object: "instagram",
      entry: [
        {
          id: "ig-page-slow",
          messaging: [
            {
              sender: { id: "ig-user-slow" },
              message: { mid: "ig-mid-slow-1", text: "long latency test" },
            },
          ],
        },
      ],
    };

    const started = Date.now();
    const result = await callWebhook(handler, payload);
    const durationMs = Date.now() - started;

    assert.equal(result.statusCode, 200);
    assert.ok(durationMs >= 650);
    assert.equal(sendCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("webhook stays silent when the model refers unknown data to staff", async () => {
  applyTestEnv();
  const handler = await loadWebhookHandler();

  const originalFetch = globalThis.fetch;
  let sendCount = 0;
  let sentBody = "";

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("api.openai.com")) {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "REFER" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200 },
      );
    }

    if (url.includes("/messages")) {
      sendCount += 1;
      sentBody = String(init?.body || "");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const payload = {
      object: "instagram",
      entry: [
        {
          id: "ig-page-refer",
          messaging: [
            {
              sender: { id: "ig-user-refer" },
              message: { mid: "ig-mid-refer-1", text: "энэ байхгүй аяллын зураг байна уу" },
            },
          ],
        },
      ],
    };

    const result = await callWebhook(handler, payload);

    assert.equal(result.statusCode, 200);
    assert.equal(sendCount, 0, "an unknown answer is met with silence, not a notice");
    assert.equal(sentBody, "");
    assert.ok(persistedLeadSenders.has("ig-user-refer"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("webhook stays silent when a reply is suppressed as no-data", async () => {
  applyTestEnv();
  const handler = await loadWebhookHandler();

  const originalFetch = globalThis.fetch;
  let sendCount = 0;
  let sentBody = "";

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("api.openai.com")) {
      // Not the REFER token — a real sentence that matches the no-data
      // suppression patterns in reply.ts, exercising the OTHER silent
      // branch (shouldSilenceNoDataReply), not the isReferReply one.
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "Уучлаарай, энэ талаарх мэдээлэл одоогоор тодорхойгүй байна." } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200 },
      );
    }

    if (url.includes("/messages")) {
      sendCount += 1;
      sentBody = String(init?.body || "");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const payload = {
      object: "instagram",
      entry: [
        {
          id: "ig-page-suppressed",
          messaging: [
            {
              sender: { id: "ig-user-suppressed" },
              message: { mid: "ig-mid-suppressed-1", text: "Гэрэл гэгээний аялал хэдэн төгрөг вэ" },
            },
          ],
        },
      ],
    };

    const result = await callWebhook(handler, payload);

    // Missing data stays silent, with a durable request available to staff.
    assert.equal(result.statusCode, 200);
    assert.equal(sendCount, 0, "a suppressed no-data reply must not be replaced by a notice");
    assert.equal(sentBody, "");
    assert.ok(persistedLeadSenders.has("ig-user-suppressed"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("webhook acknowledges Messenger file-only attachments without waiting on extraction", async () => {
  applyTestEnv();
  const handler = await loadWebhookHandler();

  const originalFetch = globalThis.fetch;
  const sentTexts: string[] = [];
  let fileDownloads = 0;

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("cdn.example.test/customer-receipt.pdf")) {
      fileDownloads += 1;
      return new Response(Buffer.from("%PDF-1.4\n% test"), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    }

    if (url.includes("api.openai.com/v1/responses")) {
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            category: "travel_document",
            confidence: 0.7,
            summary: "PDF file sent by customer",
            passport: {},
            trip: {},
            payment: {},
            booking: {},
            visible_text: "customer-receipt.pdf",
            needs_human_review: true,
            warnings: [],
          }),
        }),
        { status: 200 },
      );
    }

    if (url.includes("/messages")) {
      const body = JSON.parse(String(init?.body || "{}")) as {
        message?: { text?: string };
      };
      if (body.message?.text) sentTexts.push(body.message.text);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const payload = {
      object: "page",
      entry: [
        {
          id: "1234567890",
          messaging: [
            {
              sender: { id: "fb-user-file-only" },
              message: {
                mid: "fb-mid-file-only-1",
                attachments: [
                  {
                    type: "file",
                    payload: { url: "https://cdn.example.test/customer-receipt.pdf" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const result = await callWebhook(handler, payload);
    await sleep(50);

    assert.equal(result.statusCode, 200);
    assert.equal(sentTexts.length, 1);
    assert.ok(fileDownloads >= 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("webhook keeps image-only unknown attachments silent while background processing runs", async () => {
  applyTestEnv();
  const handler = await loadWebhookHandler();

  const originalFetch = globalThis.fetch;
  const sentTexts: string[] = [];

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("cdn.example.test/random-screenshot.jpg")) {
      return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }

    if (url.includes("/messages")) {
      const body = JSON.parse(String(init?.body || "{}")) as {
        message?: { text?: string };
      };
      if (body.message?.text) sentTexts.push(body.message.text);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const payload = {
      object: "page",
      entry: [
        {
          id: "1234567890",
          messaging: [
            {
              sender: { id: "fb-user-image-only" },
              message: {
                mid: "fb-mid-image-only-1",
                attachments: [
                  {
                    type: "image",
                    payload: { url: "https://cdn.example.test/random-screenshot.jpg" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const result = await callWebhook(handler, payload);
    await sleep(50);

    assert.equal(result.statusCode, 200);
    assert.deepEqual(sentTexts, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("redis disconnect in replay/conversation mode fails closed with 503", async () => {
  const script = `
    (async () => {
      const { createHmac } = await import("node:crypto");

      process.env.OPENAI_API_KEY = "test-openai-key";
      process.env.VERIFY_TOKEN = "test-verify-token";
      process.env.TOKEN_PAGE = "test-page-token";
      process.env.FACEBOOK_PAGE_ID = "1234567890";
      process.env.META_APP_SECRET = "test-meta-secret";
      process.env.ADMIN_SECRET = "test-admin-secret";
      process.env.TRUST_PROXY_HEADERS = "true";
      process.env.ALLOW_ADMIN_SECRET_QUERY = "false";
      process.env.REDIS_STATE_ENABLED = "true";
      process.env.REDIS_REPLAY_ENABLED = "true";
      process.env.REDIS_CONVERSATION_ENABLED = "true";
      process.env.REDIS_RATE_LIMIT_ENABLED = "false";
      process.env.REDIS_PAUSE_ENABLED = "false";
      process.env.REDIS_URL = "redis://127.0.0.1:6399";
      process.env.REDIS_CONNECT_TIMEOUT_MS = "100";
      process.env.REDIS_COMMAND_TIMEOUT_MS = "100";
      delete process.env.NEON_DATABASE_URL;

      const envModule = (await import("./src/lib/env")).default;
      const rateLimitModule = (await import("./src/lib/rateLimit")).default;
      const resilienceModule = (await import("./src/lib/resilience")).default;
      const redisStateModule = (await import("./src/lib/redisState")).default;
      const webhookBundle = (await import("./src/pages/api/webhook")).default;
      const webhookHandler = webhookBundle.default;

      envModule.resetEnvCacheForTests();
      rateLimitModule.resetRateLimitForTests();
      resilienceModule.resetResilienceStateForTests();
      redisStateModule.resetRedisStateForTests();
      webhookBundle.resetWebhookStateForTests();

      globalThis.fetch = async () => {
        return new Response("unexpected", { status: 500 });
      };

      const payload = {
        object: "instagram",
        entry: [
          {
            id: "ig-page-redis",
            messaging: [
              {
                sender: { id: "ig-user-redis" },
                message: { mid: "ig-mid-redis-1", text: "redis check" }
              }
            ]
          }
        ]
      };

      const raw = Buffer.from(JSON.stringify(payload), "utf8");
      const signature = "sha256=" + createHmac("sha256", process.env.META_APP_SECRET).update(raw).digest("hex");

      const req = {
        method: "POST",
        url: "/api/webhook",
        query: {},
        headers: {
          "content-length": String(raw.length),
          "x-hub-signature-256": signature,
          "content-type": "application/json",
        },
        async *[Symbol.asyncIterator]() {
          yield raw;
        },
      };

      let statusCode = 200;
      let body = null;
      const headers = new Map();
      const res = {
        status(code) { statusCode = code; return res; },
        json(value) { body = value; return res; },
        send(value) { body = value; return res; },
        end(value) { body = value; return res; },
        setHeader(name, value) { headers.set(String(name).toLowerCase(), String(value)); },
        get statusCode() { return statusCode; },
      };

      await webhookHandler(req, res);
      console.log("RESULT:" + JSON.stringify({ statusCode, body, headers: Object.fromEntries(headers) }));
      process.exit(0);
    })().catch((error) => {
      console.error("SCRIPT_ERROR:" + (error instanceof Error ? error.message : String(error)));
      process.exit(1);
    });
  `;

  const { stdout } = await execFileAsync(
    "node",
    ["--import", "tsx", "-e", script],
    {
      cwd: process.cwd(),
      env: { ...process.env },
      timeout: 20_000,
    },
  );

  const line = stdout
    .split(/\r?\n/)
    .find((entry) => entry.startsWith("RESULT:"));

  assert.ok(line, "Missing RESULT output from redis fail-closed subprocess");
  const result = JSON.parse(String(line).slice("RESULT:".length)) as {
    statusCode: number;
    body?: { error?: string };
  };
  assert.equal(result.statusCode, 503);
  assert.equal(result.body?.error, "retryable_failure");
});

test("webhook stays silent to the customer when OpenAI is down (outage is never announced)", async () => {
  applyTestEnv();
  const handler = await loadWebhookHandler();

  const originalFetch = globalThis.fetch;
  let openAiCalls = 0;
  const sends: string[] = [];

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("api.openai.com")) {
      openAiCalls += 1;
      return new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), {
        status: 500,
      });
    }

    if (url.includes("/messages")) {
      sends.push(String(init?.body || ""));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const payload = {
      object: "instagram",
      entry: [
        {
          id: "ig-page-outage",
          messaging: [
            {
              sender: { id: "ig-user-outage" },
              message: { mid: "ig-mid-outage-1", text: "ai outage check" },
            },
          ],
        },
      ],
    };

    const result = await callWebhook(handler, payload);

    assert.equal(result.statusCode, 200);
    assert.ok(openAiCalls >= 1, "the model must actually have been tried");
    assert.deepEqual(
      sends,
      [],
      "an AI outage must not send the customer any message (no apology, no hand-off notice)",
    );
    assert.ok(persistedLeadSenders.has("ig-user-outage"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function runInstagramText(senderId: string, mid: string, text: string, aiReply = "REFER") {
  applyTestEnv();
  const handler = await loadWebhookHandler();
  const originalFetch = globalThis.fetch;
  const sends: string[] = [];
  let openAiCalls = 0;

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("api.openai.com")) {
      openAiCalls += 1;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: aiReply } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200 },
      );
    }
    if (url.includes("/messages")) {
      sends.push(String(init?.body || ""));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const result = await callWebhook(handler, {
      object: "instagram",
      entry: [{ id: `ig-page-${senderId}`, messaging: [{ sender: { id: senderId }, message: { mid, text } }] }],
    });
    assert.equal(result.statusCode, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
  return { sends, openAiCalls };
}

test("a bare price question with no trip named asks which trip, instead of handing off to staff", async () => {
  for (const [index, text] of ["Үнэ", "Vne", "Хэд хоногийн аялал хэдэн төг вээ"].entries()) {
    const { sends } = await runInstagramText(`ig-user-generic-${index}`, `ig-mid-generic-${index}`, text);
    assert.equal(sends.length, 1, `"${text}" must get exactly one reply`);
    assert.match(sends[0], /Аль аялал вэ\?/, `"${text}" must ask which trip`);
    assert.doesNotMatch(sends[0], /зөвлөхөд дамжууллаа/, `"${text}" must not be handed off as no-data`);
  }
});

test("a bare thank-you gets a short friendly reply and never a trip list", async () => {
  const { sends, openAiCalls } = await runInstagramText("ig-user-thanks", "ig-mid-thanks-1", "Баярлалаа");
  assert.equal(sends.length, 1);
  assert.match(sends[0], /Зүгээр ээ/);
  assert.doesNotMatch(sends[0], /сонголт байна|₮/);
  assert.equal(openAiCalls, 0, "a thank-you must not need the model (works during an AI outage)");
});

test("a typed greeting variant is answered as a greeting, not handed off", async () => {
  const { sends } = await runInstagramText("ig-user-greet-typo", "ig-mid-greet-typo-1", "сайн сайн байна уу?");
  assert.equal(sends.length, 1);
  assert.match(sends[0], /Ямар аялал сонирхож байна\?/);
  assert.doesNotMatch(sends[0], /зөвлөхөд дамжууллаа/);
});


test("when the AI itself answers REFER (does not know), the customer gets nothing", async () => {
  const { sends, openAiCalls } = await runInstagramText("ig-user-ai-refer", "ig-mid-ai-refer-1", "ai refer check");
  assert.ok(openAiCalls >= 1, "the model must actually have been asked");
  assert.deepEqual(sends, [], "REFER means silence: no reply, no hand-off notice");
  assert.ok(persistedLeadSenders.has("ig-user-ai-refer"));
});

test("the model saying it lacks the information is treated as no-data and never sent", async () => {
  const { shouldSilenceNoDataReply } = await import("../src/lib/reply");
  for (const reply of [
    "Тэр мэдээлэл миний мэдээлэлд байхгүй байна. Та зөвлөхтэй холбогдоно уу. 😊",
    "Уучлаарай, би энэ талаар мэдэхгүй байна.",
    "Уучлаарай, энэ талаар туслах боломжгүй байна.",
  ]) {
    assert.equal(shouldSilenceNoDataReply(reply), true, reply);
  }
  // A normal answer with a consultant tail is still sent.
  assert.equal(
    shouldSilenceNoDataReply("Лумиа аялал 6 өдөр 5 шөнө, том хүн 2,901,000₮. Дэлгэрэнгүйг зөвлөхөөс авна уу."),
    false,
  );
});

test("a bare number with no numbered question pending gets no reply (not a welcome, not a '5 million' search)", async () => {
  for (const [index, text] of ["55", "5", "3."].entries()) {
    const { sends, openAiCalls } = await runInstagramText(`ig-user-bare-number-${index}`, `ig-mid-bare-number-${index}`, text);
    assert.deepEqual(sends, [], `"${text}" must be met with silence`);
    assert.equal(openAiCalls, 0, `"${text}" must not be sent to the model to be guessed at`);
  }
});

test("catalog maintenance status text is logged but not answered as a customer question", async () => {
  const { sends, openAiCalls } = await runInstagramText(
    "ig-user-catalog-note",
    "ig-mid-catalog-note-1",
    "10 сарын 8-ны лумиа суудал дүүрсэн - 5 шөнө 6 өдөртэйй",
  );
  assert.deepEqual(sends, [], "catalog/status notes must not get a customer-facing reply");
  assert.equal(openAiCalls, 0, "catalog/status notes must not be sent to the model");
  assert.ok(persistedLeadSenders.has("ig-user-catalog-note"));
});

test("a typed 'Get started' gets no bot reply (Meta's own greeting covers it) and never reaches the model", async () => {
  const { sends, openAiCalls } = await runInstagramText("ig-user-get-started-text", "ig-mid-get-started-text-1", "Get started");
  assert.deepEqual(sends, [], "the bot must not stack its greeting on Meta's");
  assert.equal(openAiCalls, 0);
});

// 2026-10-18 chats: the ad's pre-filled question got the model's refusal ("Уучлаарай, энэ талаар
// мэдээлэл өгөх боломжгүй…"), which no guard caught.
const REFUSAL = "Уучлаарай, энэ талаар мэдээлэл өгөх боломжгүй байна. Та манай аяллын зөвлөхтэй холбогдож дэлгэрэнгүй мэдээлэл авах боломжтой.";

test("the ad's pre-filled question asks which trip even when the model writes a refusal", async () => {
  const { sends } = await runInstagramText("ig-user-ad-prefill-refusal", "ig-mid-ad-prefill-refusal-1", "Can you tell me more about your ad?", REFUSAL);
  assert.equal(sends.length, 1);
  assert.doesNotMatch(sends[0], /боломжгүй/);
});

test("a model refusal to a real question is never sent", async () => {
  const { sends } = await runInstagramText("ig-user-refusal-site", "ig-mid-refusal-site-1", "вэбсайт чинь хаана байна",
    "Уучлаарай, вэбсайтын хаяг өгөх боломжгүй байна. Та манай аяллын зөвлөхтэй холбогдоно уу. 😊");
  assert.ok(sends.every((body) => !/боломжгүй/.test(body)), "the refusal must not reach the customer");
  assert.ok(persistedLeadSenders.has("ig-user-refusal-site"));
});

test("Messenger's 'Is anyone available to chat?' is a request for a person", async () => {
  const { isHandoffRequest } = await import("../src/lib/handoffDetection");
  assert.equal(isHandoffRequest("Is anyone available to chat?", []), true);
  assert.equal(isHandoffRequest("Can I talk to a real person?", []), true);
  assert.equal(isHandoffRequest("Бета аялал хэд вэ", []), false);
});

test("refusals in other words are no-data; real answers and the not-in-catalog answer are not", async () => {
  const { shouldSilenceNoDataReply } = await import("../src/lib/reply");
  for (const reply of [
    REFUSAL,
    "Уучлаарай, PDF баримт шууд илгээх боломжгүй байна.",
    "Уучлаарай, би QR код унших боломжгүй байна.",
    "Альфа газар нислэг хосолсон аялалын талаар мэдээлэл харагдахгүй байна. Та манай аяллын зөвлөхтэй холбогдоорой.",
    "Уучлаарай, энэ асуулт аялалтай холбоогүй байна.",
    "Истанбул хотыг багтаасан аялал одоогоор Context-д байхгүй байна.",
  ]) assert.equal(shouldSilenceNoDataReply(reply), true, reply);
  for (const reply of [
    "Альфа аялал 6 өдөр 5 шөнө, том хүн 2,901,000₮. Утасны дугаараа үлдээвэл манай аяллын зөвлөх тан руу шууд залгана 🙌",
  ]) assert.equal(shouldSilenceNoDataReply(reply), false, reply);
});

test("tapping the phone-number button again right away does not resend the same numbers", async () => {
  const { isRepeatOfLastReply } = await import("../src/lib/contactReplies");
  const now = 1_000_000;
  assert.equal(isRepeatOfLastReply({ text: "Манай утас", timestamp: now - 5_000 }, "Манай утас", now), true);
  assert.equal(isRepeatOfLastReply({ text: "Манай утас", timestamp: now - 600_000 }, "Манай утас", now), false, "asked again later: answer");
  assert.equal(isRepeatOfLastReply({ text: "Манай хаяг", timestamp: now - 5_000 }, "Манай утас", now), false);
  assert.equal(isRepeatOfLastReply(null, "Манай утас", now), false);
});

test("no apology for a failure or a missing place ever reaches a customer", async () => {
  const { shouldSilenceNoDataReply } = await import("../src/lib/reply");
  for (const reply of [
    "Уучлаарай, «Альфа» чиглэлийн аялал одоогоор манайд байхгүй байна.",
    "Уучлаарай, систем түр алдаатай байна.",
    "Уучлаарай, мессеж илгээхэд алдаа гарлаа.",
    "Уучлаарай, яг одоо цаг агаарын мэдээг татаж чадсангүй.",
  ]) assert.equal(shouldSilenceNoDataReply(reply), true, reply);
  // A real answer from the data that happens to apologise is still sent.
  assert.equal(shouldSilenceNoDataReply("Уучлаарай, энэ гаралтын суудал дүүрсэн байна.\nДараагийн гарах өдрийг санал болгоё."), false);
});

test("'ask our consultant' with nothing from the data is not an answer", async () => {
  const { shouldSilenceNoDataReply } = await import("../src/lib/reply");
  assert.equal(shouldSilenceNoDataReply("Хувиараа явах гэж байгаа бол аяллын зөвлөхтэй холбогдож дэлгэрэнгүй мэдээлэл авахыг зөвлөж байна. Утасны дугаараа үлдээвэл манай аяллын зөвлөх тан руу шууд залгана 🙌"), true);
  assert.equal(shouldSilenceNoDataReply("Группын аялалд хямдрал авах боломжтой эсэхийг мэдэхийн тулд манай аяллын зөвлөхтэй холбогдоорой."), true);
  // A fact with the same tail is still an answer.
  assert.equal(shouldSilenceNoDataReply("Альфа аялал 7 өдөр 6 шөнө, том хүн 1,390,000₮. Дэлгэрэнгүйг аяллын зөвлөхтэй холбогдож тодруулаарай."), false);
  assert.equal(shouldSilenceNoDataReply("АЛЬФА АЯЛАЛ нь газрын аялал тул нислэг ороогүй. Нислэгтэйг аяллын зөвлөхтэй холбогдож тодруулаарай."), false);
});
