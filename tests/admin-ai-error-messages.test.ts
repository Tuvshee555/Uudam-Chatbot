import assert from "node:assert/strict";
import test from "node:test";
import { STALE_BUNDLE_MESSAGE, apiErrorMessage, emptyChunkResult, isStaleBundleError } from "../src/lib/adminPageUtils";

test("an exhausted OpenAI balance is named as billing, with the place to fix it", () => {
  const byCode = apiErrorMessage({ error: "ai_credits_exhausted" }, "fallback");
  assert.match(byCode, /кредит дууссан/);
  assert.match(byCode, /Billing/);
  const byText = apiErrorMessage({ error: "OpenAI credit balance exhausted (insufficient_quota)" }, "fallback");
  assert.equal(byText, byCode);
});

test("a rejected key and an unreadable file keep their own messages", () => {
  assert.match(apiErrorMessage({ error: "ai_unauthorized" }, "fallback"), /OPENAI_API_KEY/);
  const unreadable = apiErrorMessage({ error: "file_unreadable", message: "«scan.pdf»: уншигдах текст, зураг олдсонгүй." }, "fallback");
  assert.match(unreadable, /scan\.pdf/);
});

test("a failed upload unit carries the reason as a blocker instead of 'recheck this part'", () => {
  const result = emptyChunkResult("poster.pdf", "AI сервер хариу өгсөнгүй.");
  assert.equal(result.proposal.actions.length, 0);
  assert.equal(result.proposal.needs_confirmation, true);
  assert.match(result.proposal.conflicts[0], /poster\.pdf/);
  assert.match(result.proposal.conflicts[0], /AI сервер хариу өгсөнгүй/);
  assert.equal(result.proposal.conflict_items?.[0]?.severity, "blocker");
});

test("a reader that vanished after a deploy is recognised and explained", () => {
  assert.equal(isStaleBundleError(new TypeError("Failed to fetch dynamically imported module: /_next/static/chunks/123.js")), true);
  assert.equal(isStaleBundleError(Object.assign(new Error("Loading chunk 42 failed"), { name: "ChunkLoadError" })), true);
  assert.equal(isStaleBundleError(new Error("Word файлд текст олдсонгүй.")), false);
  assert.match(STALE_BUNDLE_MESSAGE, /дахин ачаал/);
});
