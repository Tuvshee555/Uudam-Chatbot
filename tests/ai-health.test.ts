import assert from "node:assert/strict";
import test from "node:test";
import { aiErrorCode, aiFailureKind } from "../src/lib/aiHealth";
import { UpstreamHttpError, TimeoutError } from "../src/lib/resilience";

const body = (code: string, type: string) => JSON.stringify({ error: { message: "x", type, code } });

test("an empty OpenAI balance is told apart from a passing rate limit", () => {
  assert.equal(aiFailureKind(new UpstreamHttpError("openai.chat", 429, body("credit_balance_exhausted", "insufficient_quota"))), "credits_exhausted");
  // A passing rate limit is its own kind (alerted only when it persists), never "credits".
  assert.equal(aiFailureKind(new UpstreamHttpError("openai.chat", 429, body("rate_limit_exceeded", "requests"))), "quota");
  assert.equal(aiErrorCode(new UpstreamHttpError("openai.chat", 429, body("insufficient_quota", "insufficient_quota"))), "insufficient_quota");
});

test("a rejected key, a provider failure and a timeout are each told apart", () => {
  assert.equal(aiFailureKind(new UpstreamHttpError("openai.chat", 401, body("invalid_api_key", "invalid_request_error"))), "unauthorized");
  assert.equal(aiFailureKind(new UpstreamHttpError("openai.chat", 503, "")), "provider");
  assert.equal(aiFailureKind(new TimeoutError("openai.chat", 15000)), "provider");
  assert.equal(aiFailureKind(new Error("boom")), "other");
});
