import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { applyTestEnv } from "./helpers/env";

/**
 * Meta-app migration (docs/meta-app-migration.md): the old and the new app run against the
 * same Page and the same deployment until cutover. Nothing here touches a real app: all
 * ids, tokens and secrets are fixtures.
 */

const NEXT = {
  META_APP_SECRET_NEXT: "next-meta-secret",
  VERIFY_TOKEN_NEXT: "next-verify-token",
  META_APP_ID: "555000111",
};

async function freshEnv(overrides: Record<string, string | undefined> = {}) {
  applyTestEnv(overrides);
  const env = await import("../src/lib/env");
  env.resetEnvCacheForTests();
  return env;
}

test("FACEBOOK_PAGES_NEXT replaces that page's token and maps it to the new app's secret", async () => {
  const env = await freshEnv({ ...NEXT, FACEBOOK_PAGES_NEXT: "1234567890:next-page-token" });
  const parsed = env.getEnv();
  assert.deepEqual(parsed.facebookPages, [{ pageId: "1234567890", token: "next-page-token" }]);
  assert.deepEqual(parsed.facebookPagesNextIds, ["1234567890"]);
  // Staff alerts and the webhook fallback token follow the cutover too.
  assert.equal(parsed.tokenPage, "next-page-token");
  // appsecret_proof must be computed with the secret of the app that issued the token.
  assert.equal(env.appSecretForToken("next-page-token"), "next-meta-secret");
  assert.equal(env.appSecretForToken("test-page-token"), "test-meta-secret");
  assert.equal(env.appSecretForToken("a-token-nobody-issued"), "test-meta-secret");
});

test("a NEXT entry for an unknown page or without the new secret refuses to start", async () => {
  const unknown = await freshEnv({ ...NEXT, FACEBOOK_PAGES_NEXT: "999999:next-page-token" });
  assert.throws(() => unknown.getEnv(), /not in FACEBOOK_PAGES/);
  const missingSecret = await freshEnv({ FACEBOOK_PAGES_NEXT: "1234567890:next-page-token" });
  assert.throws(() => missingSecret.getEnv(), /requires META_APP_SECRET_NEXT/);
});

test("without any _NEXT variable the environment is exactly the old app's", async () => {
  const env = await freshEnv();
  const parsed = env.getEnv();
  assert.deepEqual(parsed.facebookPages, [{ pageId: "1234567890", token: "test-page-token" }]);
  assert.deepEqual(parsed.facebookPagesNextIds, []);
  assert.equal(parsed.tokenPage, "test-page-token");
  assert.equal(parsed.echoTakeoverMode, "observe");
  assert.deepEqual(parsed.echoHumanAppIds, []);
});

test("a delivery signed by either app's secret verifies; anything else does not", async () => {
  const { verifyMetaSignatureAny } = await import("../src/lib/webhookSecurity");
  const body = Buffer.from(JSON.stringify({ object: "page", entry: [] }));
  const sign = (secret: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const secrets = ["old-secret", "next-secret"];
  assert.equal(verifyMetaSignatureAny(body, sign("old-secret"), secrets), true);
  assert.equal(verifyMetaSignatureAny(body, sign("next-secret"), secrets), true);
  assert.equal(verifyMetaSignatureAny(body, sign("wrong-secret"), secrets), false);
  assert.equal(verifyMetaSignatureAny(body, undefined, secrets), false);
  // An unset next secret never widens the check (and never verifies an unsigned delivery).
  assert.equal(verifyMetaSignatureAny(body, sign(""), ["old-secret", ""]), false);
  assert.equal(verifyMetaSignatureAny(body, sign("old-secret"), ["old-secret", ""]), true);
});

test("the webhook handshake accepts either app's verify token", async () => {
  await freshEnv(NEXT);
  const { verifyToken } = await import("../src/lib/webhookDedup");
  assert.equal(verifyToken("test-verify-token"), true);
  assert.equal(verifyToken("next-verify-token"), true);
  assert.equal(verifyToken("some-other-token"), false);
  assert.equal(verifyToken(""), false);
});

test("events with a Meta mid are remembered 48 hours; button taps keep the short window", async () => {
  const { processedEventTtlMs, buildEventKey } = await import("../src/lib/webhookDedup");
  const midKey = buildEventKey("facebook", "fixture-sender", { message: { mid: "m_fixture_1", text: "x" } });
  const tapKey = buildEventKey("facebook", "fixture-sender", { message: { text: "Аялал үзэх" } });
  assert.equal(processedEventTtlMs(midKey), 48 * 60 * 60 * 1000);
  assert.equal(processedEventTtlMs(tapKey), 2 * 60 * 1000, "a repeated legitimate tap must be answerable again");
});

test("echo classification: own metadata or own app id is the bot; only listed app ids are human; everything else unknown", async () => {
  const env = await freshEnv({ ...NEXT, ECHO_HUMAN_APP_IDS: "777000333, 777000444" });
  env.getEnv();
  const { classifyEcho, echoEnforcementEnabled } = await import("../src/lib/echoObserver");
  const { BOT_MESSAGE_METADATA } = await import("../src/lib/messenger");
  assert.equal(classifyEcho({ appId: "", metadata: BOT_MESSAGE_METADATA }), "bot");
  assert.equal(classifyEcho({ appId: "555000111", metadata: "" }), "bot", "the bot's own app id");
  assert.equal(classifyEcho({ appId: "777000333", metadata: "" }), "human");
  assert.equal(classifyEcho({ appId: "777000444", metadata: "" }), "human");
  assert.equal(classifyEcho({ appId: "123456789", metadata: "" }), "unknown", "an unlisted app id is NEVER a consultant");
  assert.equal(classifyEcho({ appId: "", metadata: "" }), "unknown", "no app id at all is never a consultant");
  assert.equal(echoEnforcementEnabled(), false, "observe-only by default");
  // Enforcement is an explicit opt-in after the matrix is reviewed.
  const enforce = await freshEnv({ ...NEXT, ECHO_TAKEOVER_MODE: "enforce" });
  enforce.getEnv();
  assert.equal(echoEnforcementEnabled(), true);
  const invalid = await freshEnv({ ...NEXT, ECHO_TAKEOVER_MODE: "sometimes" });
  assert.throws(() => invalid.getEnv(), /ECHO_TAKEOVER_MODE/);
});

test("an old consultant reply does not count after staff handed the conversation back", async () => {
  const { latestStaffReply } = await import("../src/lib/staffTakeover");
  const now = new Date("2099-05-10T12:00:00Z");
  const page = (iso: string, text: string, id: string) => ({
    id, from: { id: "page-1" }, message: text, created_time: iso,
    tags: { data: [{ name: "inbox" }, { name: "source:web" }] },
  });
  const customer = (iso: string) => ({ from: { id: "cust" }, message: "Үнэ?", created_time: iso, tags: { data: [] } });
  const messages = [
    customer("2099-05-09T10:00:00Z"),
    page("2099-05-09T10:05:00Z", "Сайн байна уу, би зөвлөх байна", "m_staff1"),
  ];
  const context = { pageId: "page-1", recordingSince: Date.parse("2099-05-01T00:00:00Z"), botMids: new Set<string>() };
  assert.equal(latestStaffReply({ messages, now, ...context })?.origin, "staff_web", "before the release the consultant owns it");
  const releasedAt = Date.parse("2099-05-10T09:00:00Z");
  assert.equal(latestStaffReply({ messages, now, ...context, botReleasedAt: releasedAt }), null,
    "released to the bot: the same old reply no longer silences it");
  const newer = [...messages, customer("2099-05-10T10:00:00Z"), page("2099-05-10T10:30:00Z", "Би дахиад авлаа", "m_staff2")];
  assert.equal(latestStaffReply({ messages: newer, now, ...context, botReleasedAt: releasedAt })?.at.toISOString(),
    "2099-05-10T10:30:00.000Z", "a consultant replying AFTER the release takes over again");
});
