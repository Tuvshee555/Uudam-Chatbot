import assert from "node:assert/strict";
import test from "node:test";
import type { NextApiRequest, NextApiResponse } from "next";
import { applyTestEnv } from "./helpers/env";

type TestResponse = NextApiResponse & {
  statusCode: number;
  body: Record<string, unknown>;
  headers: Record<string, string | number | readonly string[]>;
};

function createResponse() {
  const response = {
    statusCode: 200,
    headers: {} as Record<string, string | number | readonly string[]>,
    body: undefined as unknown as Record<string, unknown>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      this.body = body;
      return this;
    },
    end() {
      return this;
    },
    setHeader(name: string, value: string | number | readonly string[]) {
      this.headers[name.toLowerCase()] = value;
    },
  };
  return response as unknown as TestResponse;
}

function createAdminJsonRequest(
  path: string,
  body: Record<string, unknown>,
  ip: string,
) {
  return {
    method: "POST",
    url: path,
    headers: {
      "x-admin-secret": "test-admin-secret",
      "x-forwarded-for": ip,
    },
    query: {},
    body,
    socket: { remoteAddress: ip },
  } as unknown as NextApiRequest;
}

async function prepareEnvironment() {
  applyTestEnv({
    DATABASE_URL: undefined,
    NEON_DATABASE_URL: undefined,
  });
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    summary: "No changes",
                    needs_confirmation: false,
                    important_reason: "",
                    conflicts: [],
                    actions: [],
                  }),
                },
              ],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 1,
          candidatesTokenCount: 1,
          totalTokenCount: 2,
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  const envModule = await import("../src/lib/env");
  envModule.resetEnvCacheForTests();
  const rateLimitModule = await import("../src/lib/rateLimit");
  rateLimitModule.resetRateLimitForTests();
}

test("ai-change catches unhandled errors and returns 500", async () => {
  await prepareEnvironment();
  const { default: handler } = await import("../src/pages/api/admin/ai-change");
  const res = createResponse();

  await handler(
    {
      get method() {
        throw new Error("unexpected request failure");
      },
      url: "/api/admin/ai-change",
      headers: { "x-admin-secret": "test-admin-secret" },
      query: {},
      body: {},
      socket: { remoteAddress: "203.0.113.99" },
    } as unknown as NextApiRequest,
    res,
  );

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, "ai_change_failed");
  assert.match(String(res.body.message), /unexpected request failure/i);
});

test("ai-change rejects oversized clarification text", async () => {
  await prepareEnvironment();
  const { default: handler } = await import("../src/pages/api/admin/ai-change");
  const res = createResponse();

  await handler(
    createAdminJsonRequest(
      "/api/admin/ai-change",
      { request_id: 1, clarification: "x".repeat(4_001) },
      "203.0.113.20",
    ),
    res,
  );

  assert.equal(res.statusCode, 413);
  assert.equal(res.body.error, "clarification_too_long");
  assert.equal(res.body.max_chars, 4_000);
});
