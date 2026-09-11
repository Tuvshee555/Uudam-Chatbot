import assert from "node:assert/strict";
import test, { beforeEach, afterEach } from "node:test";
import { isMetaOutboundDisabled } from "../src/lib/metaOutboundKillSwitch";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.WEBHOOK_BOT_DISABLED;
  delete process.env.VERCEL_ENV;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

test("the bot is ON by default when WEBHOOK_BOT_DISABLED is unset, in every environment", () => {
  // Regression: the previous logic disabled outbound sends whenever
  // VERCEL_ENV === "production" AND the var was not the literal string "0" —
  // which includes the var simply being unset. That meant a fresh production
  // deploy with no WEBHOOK_BOT_DISABLED configured at all silenced the bot,
  // confirmed live 2026-09-11 (removing the var and redeploying did not
  // bring it back).
  process.env.VERCEL_ENV = "production";
  assert.equal(isMetaOutboundDisabled(), false);

  process.env.VERCEL_ENV = "preview";
  assert.equal(isMetaOutboundDisabled(), false);

  delete process.env.VERCEL_ENV;
  assert.equal(isMetaOutboundDisabled(), false);
});

test("WEBHOOK_BOT_DISABLED=1 disables outbound sends regardless of environment", () => {
  process.env.WEBHOOK_BOT_DISABLED = "1";
  process.env.VERCEL_ENV = "production";
  assert.equal(isMetaOutboundDisabled(), true);

  delete process.env.VERCEL_ENV;
  assert.equal(isMetaOutboundDisabled(), true);
});

test("WEBHOOK_BOT_DISABLED=true also disables outbound sends", () => {
  process.env.WEBHOOK_BOT_DISABLED = "true";
  assert.equal(isMetaOutboundDisabled(), true);
});

test("WEBHOOK_BOT_DISABLED=0 explicitly means enabled, in production too", () => {
  process.env.WEBHOOK_BOT_DISABLED = "0";
  process.env.VERCEL_ENV = "production";
  assert.equal(isMetaOutboundDisabled(), false);
});

test("an unrecognised value never accidentally disables the bot", () => {
  process.env.WEBHOOK_BOT_DISABLED = "yes";
  assert.equal(isMetaOutboundDisabled(), false);
});
