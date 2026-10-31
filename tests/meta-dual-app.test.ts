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

test("holding the new app's token changes nothing: the old app keeps every send until META_NEXT_SEND", async () => {
  const env = await freshEnv({ ...NEXT, FACEBOOK_PAGES_NEXT: "1234567890:next-page-token" });
  const parsed = env.getEnv();
  assert.equal(parsed.metaNextSend, "off");
  assert.deepEqual(parsed.facebookPages, [{ pageId: "1234567890", token: "test-page-token" }]);
  assert.deepEqual(parsed.facebookPagesNext, [{ pageId: "1234567890", token: "next-page-token" }]);
  assert.deepEqual(parsed.facebookPagesNextIds, []);
  assert.equal(parsed.tokenPage, "test-page-token");
  assert.equal(env.pageTokenForRecipient("1234567890", "1000000001"), "test-page-token");
  // appsecret_proof must be computed with the secret of the app that issued the token.
  assert.equal(env.appSecretForToken("next-page-token"), "next-meta-secret");
  assert.equal(env.appSecretForToken("test-page-token"), "test-meta-secret");
  assert.equal(env.appSecretForToken("a-token-nobody-issued"), "test-meta-secret");
});

test("META_NEXT_SEND=testers: only listed role users go through the new app", async () => {
  const env = await freshEnv({ ...NEXT, FACEBOOK_PAGES_NEXT: "1234567890:next-page-token",
    META_NEXT_SEND: "testers", META_NEXT_TESTER_IDS: "1000000001, 1000000002" });
  const parsed = env.getEnv();
  assert.equal(parsed.metaNextSend, "testers");
  assert.deepEqual(parsed.metaMigrationIssues, []);
  assert.equal(env.pageTokenForRecipient("1234567890", "1000000001"), "next-page-token");
  assert.equal(env.pageTokenForRecipient("1234567890", "1000000002"), "next-page-token");
  assert.equal(env.pageTokenForRecipient("1234567890", "9999999999"), "test-page-token", "a customer keeps the old app");
  // Crons, alerts and broadcasts read the roster: unchanged in tester mode.
  assert.deepEqual(parsed.facebookPages, [{ pageId: "1234567890", token: "test-page-token" }]);
  assert.equal(parsed.tokenPage, "test-page-token");
});

test("META_NEXT_SEND=all (the cutover) moves the page's roster, alerts and fallback token to the new app", async () => {
  const env = await freshEnv({ ...NEXT, FACEBOOK_PAGES_NEXT: "1234567890:next-page-token", META_NEXT_SEND: "all" });
  const parsed = env.getEnv();
  assert.deepEqual(parsed.facebookPages, [{ pageId: "1234567890", token: "next-page-token" }]);
  assert.deepEqual(parsed.facebookPagesNextIds, ["1234567890"]);
  assert.equal(parsed.tokenPage, "next-page-token", "staff alerts and the webhook fallback follow the cutover");
  assert.equal(env.pageTokenForRecipient("1234567890", "9999999999"), "next-page-token");
  assert.equal(env.appSecretForToken("next-page-token"), "next-meta-secret");
});

test("a second page without a NEXT token stays on the old app even at cutover", async () => {
  const env = await freshEnv({ ...NEXT, FACEBOOK_PAGES: "1234567890:test-page-token,2222222222:second-page-token",
    FACEBOOK_PAGES_NEXT: "1234567890:next-page-token", META_NEXT_SEND: "all" });
  const parsed = env.getEnv();
  assert.deepEqual(parsed.facebookPages.find((page) => page.pageId === "2222222222"), { pageId: "2222222222", token: "second-page-token" });
  assert.equal(env.appSecretForToken("second-page-token"), "test-meta-secret");
  assert.deepEqual(parsed.facebookPagesNextIds, ["1234567890"]);
});

test("an invalid NEXT setting fails SAFE: ignored as a whole, old tokens keep serving, issue listed, never quoted", async () => {
  // Even with the cutover switch on, a bad setting never reaches a send.
  const all = { ...NEXT, META_NEXT_SEND: "all" };
  const cases: Array<[Record<string, string>, RegExp]> = [
    [{ ...all, FACEBOOK_PAGES_NEXT: "999999:next-page-token" }, /page 999999 is not in FACEBOOK_PAGES/],
    [{ META_NEXT_SEND: "all", FACEBOOK_PAGES_NEXT: "1234567890:next-page-token" }, /requires META_APP_SECRET_NEXT/],
    // A bare token pasted without the page id: must not be applied, and must never be echoed.
    [{ ...all, FACEBOOK_PAGES_NEXT: "EAAGsecretlookingtokenvalue" }, /entry #1 is not in the form pageId:token/],
    // One good entry next to a bad one: all or nothing.
    [{ ...all, FACEBOOK_PAGES_NEXT: "1234567890:next-page-token,999999:other" }, /page 999999/],
    [{ ...all }, /META_NEXT_SEND=all needs a valid FACEBOOK_PAGES_NEXT/],
    [{ ...NEXT, FACEBOOK_PAGES_NEXT: "1234567890:next-page-token", META_NEXT_SEND: "everyone" }, /META_NEXT_SEND must be/],
    [{ ...NEXT, FACEBOOK_PAGES_NEXT: "1234567890:next-page-token", META_NEXT_SEND: "testers" }, /needs META_NEXT_TESTER_IDS/],
    [{ ...NEXT, ECHO_TAKEOVER_MODE: "sometimes" }, /ECHO_TAKEOVER_MODE/],
    [{ ...NEXT, META_APP_ID: "uudam-v2" }, /META_APP_ID must be the numeric app id/],
  ];
  for (const [vars, issue] of cases) {
    const env = await freshEnv(vars);
    const parsed = env.getEnv(); // never throws: a throw here would fail every webhook request
    assert.deepEqual(parsed.facebookPages, [{ pageId: "1234567890", token: "test-page-token" }], JSON.stringify(vars));
    assert.deepEqual(parsed.facebookPagesNextIds, []);
    assert.equal(parsed.tokenPage, "test-page-token", "staff alerts stay on the working token");
    assert.equal(parsed.echoTakeoverMode, "observe");
    assert.ok(parsed.metaMigrationIssues.some((text) => issue.test(text)), `${issue}: ${parsed.metaMigrationIssues.join(" | ")}`);
    const issueText = parsed.metaMigrationIssues.join(" ");
    for (const secretish of ["next-page-token", "EAAGsecret", "other"]) assert.ok(!issueText.includes(secretish), "never quotes a token");
  }
  const valid = await freshEnv({ ...NEXT, FACEBOOK_PAGES_NEXT: "1234567890:next-page-token" });
  assert.deepEqual(valid.getEnv().metaMigrationIssues, []);
  // An invalid send mode never sends through the new app, for anyone.
  const typo = await freshEnv({ ...NEXT, FACEBOOK_PAGES_NEXT: "1234567890:next-page-token", META_NEXT_SEND: "everyone" });
  assert.equal(typo.getEnv().metaNextSend, "off");
  assert.equal(typo.pageTokenForRecipient("1234567890", "1000000001"), "test-page-token");
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
  // Which app signed it is named, for the receipt trail.
  const { matchMetaSignature } = await import("../src/lib/webhookSecurity");
  const labelled: Array<["current" | "next", string]> = [["current", "old-secret"], ["next", "next-secret"]];
  assert.equal(matchMetaSignature(body, sign("old-secret"), labelled), "current");
  assert.equal(matchMetaSignature(body, sign("next-secret"), labelled), "next");
  assert.equal(matchMetaSignature(body, sign("wrong-secret"), labelled), null);
  assert.equal(matchMetaSignature(body, sign(""), [["current", "old-secret"], ["next", ""]]), null);
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
  // A typo never turns enforcement on.
  const invalid = await freshEnv({ ...NEXT, ECHO_TAKEOVER_MODE: "Enforce!" });
  invalid.getEnv();
  assert.equal(echoEnforcementEnabled(), false);
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
