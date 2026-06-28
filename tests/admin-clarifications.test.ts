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
                    summary: "Revised",
                    needs_confirmation: false,
                    important_reason: "",
                    conflicts: [],
                    actions: [
                      {
                        action: "patch",
                        trip_id: "trip-1",
                        fields: { seats_left: 5 },
                      },
                    ],
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

test("ai-change requires a non-empty clarification for request_id path", async () => {
  await prepareEnvironment();
  const { default: handler } = await import("../src/pages/api/admin/ai-change");

  const emptyRes = createResponse();
  await handler(
    createAdminJsonRequest(
      "/api/admin/ai-change",
      { request_id: 1, clarification: "   " },
      "203.0.113.30",
    ),
    emptyRes,
  );
  assert.equal(emptyRes.statusCode, 400);
  assert.equal(emptyRes.body.error, "instruction is required");
});

test("ai-change clarification on persisted request falls back when DB is unavailable", async () => {
  await prepareEnvironment();
  const { default: handler } = await import("../src/pages/api/admin/ai-change");
  const res = createResponse();

  await handler(
    createAdminJsonRequest(
      "/api/admin/ai-change",
      { request_id: 1, clarification: "Only keep the first departure date" },
      "203.0.113.31",
    ),
    res,
  );

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.ok, false);
  assert.match(String(res.body.message), /database is not configured/i);
});

test("ai-change direct apply requires confirm flag and proposal", async () => {
  await prepareEnvironment();
  const { default: handler } = await import("../src/pages/api/admin/ai-change");

  const noConfirmRes = createResponse();
  await handler(
    createAdminJsonRequest(
      "/api/admin/ai-change",
      {
        apply: true,
        instruction: "[File] price.xlsx",
        proposal_direct: {
          summary: "Update",
          needs_confirmation: false,
          important_reason: "",
          conflicts: [],
          actions: [
            {
              action: "patch",
              trip_id: "trip-1",
              fields: { adult_price: 1_000_000 },
            },
          ],
        },
      },
      "203.0.113.32",
    ),
    noConfirmRes,
  );
  assert.equal(noConfirmRes.statusCode, 400);
  assert.equal(noConfirmRes.body.error, "confirmation_required");

  const noInstructionRes = createResponse();
  await handler(
    createAdminJsonRequest(
      "/api/admin/ai-change",
      {
        apply: true,
        confirm: true,
        proposal_direct: {
          summary: "Update",
          needs_confirmation: false,
          important_reason: "",
          conflicts: [],
          actions: [
            {
              action: "patch",
              trip_id: "trip-1",
              fields: { adult_price: 1_000_000 },
            },
          ],
        },
      },
      "203.0.113.33",
    ),
    noInstructionRes,
  );
  assert.equal(noInstructionRes.statusCode, 400);
  assert.equal(noInstructionRes.body.error, "instruction is required");
});
