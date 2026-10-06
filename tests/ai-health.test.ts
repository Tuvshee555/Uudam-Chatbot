import assert from "node:assert/strict";
import test from "node:test";
import { aiFailureKind, aiOutageAlertText, waitingLeadsText } from "../src/lib/aiHealth";
import { UpstreamHttpError, TimeoutError } from "../src/lib/resilience";

const body = (code: string, type: string) => JSON.stringify({ error: { message: "x", type, code } });

test("an empty OpenAI balance is told apart from a passing rate limit", () => {
  assert.equal(aiFailureKind(new UpstreamHttpError("openai.chat", 429, body("credit_balance_exhausted", "insufficient_quota"))), "credits_exhausted");
  assert.equal(aiFailureKind(new UpstreamHttpError("openai.chat", 429, body("rate_limit_exceeded", "requests"))), "other");
});

test("a rejected key is reported, every other failure is not an outage", () => {
  assert.equal(aiFailureKind(new UpstreamHttpError("openai.chat", 401, body("invalid_api_key", "invalid_request_error"))), "unauthorized");
  assert.equal(aiFailureKind(new UpstreamHttpError("openai.chat", 503, "")), "other");
  assert.equal(aiFailureKind(new TimeoutError("openai.chat", 15000)), "other");
  assert.equal(aiFailureKind(new Error("boom")), "other");
});

test("outage and backlog alerts tell staff what to do and where the leads are", () => {
  assert.match(aiOutageAlertText("credits_exhausted"), /кредит дууссан[\s\S]*Billing[\s\S]*Хүсэлтүүд/);
  assert.match(aiOutageAlertText("unauthorized"), /OPENAI_API_KEY[\s\S]*Хүсэлтүүд/);
  assert.match(waitingLeadsText(37), /^37 хүсэлт 24 цагаас дээш/);
});
