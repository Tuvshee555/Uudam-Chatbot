import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test, { type TestContext } from "node:test";
import { applyTestEnv } from "./helpers/env";

// UUDAM's Instagram account behind the Ursgal hub (src/lib/ursgalHub.ts): the hub forwards the
// Instagram events signed with the route's own secret and lends the Page token for the replies.
// Invented ids, secrets and trips only.
const HUB_ENV = {
  URSGAL_HUB_ROUTE_ID: "0123456789abcdef",
  URSGAL_HUB_SECRET: "test-route-secret-5d2c8e1a9f7b3d6c-0a4e8c2f6b1d9a3e",
  URSGAL_HUB_URL: "https://hub.example.test",
};
const IG_ACCOUNT = "ig-account-test";
const LENT_TOKEN = "lent-page-token-test";
const LENT_PROOF = "ab".repeat(32);
const TRIP_QUESTION = "3 сарын эхний 7 хоногт гарах аялал байна уу";

type Captured = { url: string; body: Record<string, unknown> };

async function setup(context: TestContext, options: { env?: Record<string, string>; tokenStatus?: number; instagramId?: string } = {}) {
  applyTestEnv({ NEON_DATABASE_URL: "postgres://test:test@127.0.0.1:1/ursgal-hub-fixture", TRIP_UNDERSTANDING: "off", ...(options.env ?? HUB_ENV) });
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2098-02-01T04:00:00.000Z") });
  const { Pool } = await import("pg");
  const rows = [7, 14].map((day) => ({
    id: `hub-week-${day}`, route_name: `ХАЙРХАН ${day} АЯЛАЛ`, currency: "MNT", status: "active", duration_text: "8 өдөр",
    departure_dates: [`2098-03-${String(day).padStart(2, "0")}`], photo_urls: [], extra: {},
  }));
  const query = async (sql: string) => {
    if (/SELECT[\s\S]*FROM travel_trip_entries/i.test(sql)) return { rows, rowCount: rows.length };
    return { rows: [], rowCount: 0 };
  };
  context.mock.method(Pool.prototype, "query", query as unknown as typeof Pool.prototype.query);
  context.mock.method(Pool.prototype, "connect", (async () => ({ query, release() {} })) as unknown as typeof Pool.prototype.connect);
  const sends: Captured[] = [];
  const tokenRequests: Array<{ headers: Record<string, string>; body: string }> = [];
  context.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === `${HUB_ENV.URSGAL_HUB_URL}/api/meta/page-token`) {
      tokenRequests.push({ headers: init?.headers as Record<string, string>, body: String(init?.body ?? "") });
      if (options.tokenStatus && options.tokenStatus !== 200) return new Response(JSON.stringify({ error: "unauthorized" }), { status: options.tokenStatus });
      return new Response(JSON.stringify({ token: LENT_TOKEN, instagramId: options.instagramId ?? IG_ACCOUNT, appsecretProof: LENT_PROOF }), { status: 200 });
    }
    if (url.includes("api.openai.com")) return new Response(JSON.stringify({ choices: [{ message: { content: "REFER" } }] }), { status: 200 });
    if (url.includes("/messages")) {
      sends.push({ url, body: JSON.parse(String(init?.body || "{}")) });
      return new Response(JSON.stringify({ recipient_id: "x", message_id: `m-${sends.length}` }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
  const env = await import("../src/lib/env");
  env.resetEnvCacheForTests();
  const { clearPageTokenCache } = await import("../src/lib/ursgalHubClient");
  const { forgetLentTokens } = await import("../src/lib/lentPageTokens");
  clearPageTokenCache();
  forgetLentTokens();
  const webhook = await import("../src/pages/api/webhook");
  webhook.resetWebhookStateForTests();
  const { closeNeonPool } = await import("../src/lib/neonDb");
  context.after(async () => {
    clearPageTokenCache();
    forgetLentTokens();
    await closeNeonPool();
  });
  return { webhook, sends, tokenRequests };
}

async function post(webhook: { default: (req: never, res: never) => Promise<unknown> }, raw: Buffer, headers: Record<string, string>) {
  const req = {
    method: "POST", url: "/api/webhook", query: {},
    headers: { "content-type": "application/json", "content-length": String(raw.length), ...headers },
    async *[Symbol.asyncIterator]() { yield raw; },
  };
  let status = 200;
  const res = { status(code: number) { status = code; return res; }, json() { return res; }, send() { return res; }, end() { return res; }, setHeader() {}, get statusCode() { return status; } };
  await webhook.default(req as never, res as never);
  return status;
}

async function hubHeaders(raw: Buffer, secret = HUB_ENV.URSGAL_HUB_SECRET, routeId = HUB_ENV.URSGAL_HUB_ROUTE_ID, now = Date.now()) {
  const { signHubRequest } = await import("../src/lib/ursgalHubClient");
  return signHubRequest(routeId, secret, raw, now);
}

const instagramMessage = (id: string, text = TRIP_QUESTION) =>
  Buffer.from(JSON.stringify({ object: "instagram", entry: [{ id: IG_ACCOUNT, messaging: [{ sender: { id: `ig-customer-${id}` }, recipient: { id: IG_ACCOUNT }, message: { mid: `ig-mid-${id}`, text } }] }] }));

async function settle(check: () => boolean, ms = 4000) {
  const until = performance.now() + ms;
  while (!check() && performance.now() < until) await new Promise((resolve) => setImmediate(resolve));
}

test("a hub-signed Instagram message is answered with the Page token the hub lends, and the hub's proof", async (context) => {
  const { webhook, sends, tokenRequests } = await setup(context);
  const status = await post(webhook, instagramMessage("1"), await hubHeaders(instagramMessage("1")));
  assert.equal(status, 200, "the hub is answered at once");
  await settle(() => sends.length > 0);
  assert.equal(tokenRequests.length, 1, "the token is asked for once");
  assert.deepEqual(JSON.parse(tokenRequests[0].body), { pageId: "1234567890" }, "the UUDAM Page connected at the hub");
  assert.equal(sends.length, 1);
  const sent = new URL(sends[0].url);
  assert.equal(sent.pathname.endsWith(`/${IG_ACCOUNT}/messages`), true, "sent as the Instagram account");
  assert.equal(sent.searchParams.get("access_token"), LENT_TOKEN, "never the UUDAM app's Messenger token");
  assert.equal(sent.searchParams.get("appsecret_proof"), LENT_PROOF, "the hub's proof, not one from this deployment's secret");
  assert.match(String((sends[0].body.message as { text?: string })?.text), /ХАЙРХАН 7 АЯЛАЛ/);
});

test("hub-signed Messenger events are acknowledged and dropped: the UUDAM app already delivers them", async (context) => {
  const { webhook, sends, tokenRequests } = await setup(context);
  const raw = Buffer.from(JSON.stringify({ object: "page", entry: [{ id: "1234567890", messaging: [{ sender: { id: "fb-customer" }, recipient: { id: "1234567890" }, message: { mid: "fb-mid-1", text: TRIP_QUESTION } }] }] }));
  assert.equal(await post(webhook, raw, await hubHeaders(raw)), 200);
  await settle(() => false, 200);
  assert.deepEqual(sends, []);
  assert.equal(tokenRequests.length, 0);
});

test("a hub delivery with another secret, another route, a changed body or an old signature is refused", async (context) => {
  const { webhook, sends } = await setup(context);
  const raw = instagramMessage("2");
  assert.equal(await post(webhook, raw, await hubHeaders(raw, "another-route-secret-0000000000000000000000")), 401);
  assert.equal(await post(webhook, raw, await hubHeaders(raw, HUB_ENV.URSGAL_HUB_SECRET, "fedcba9876543210")), 401);
  assert.equal(await post(webhook, instagramMessage("3"), await hubHeaders(raw)), 401);
  assert.equal(await post(webhook, raw, await hubHeaders(raw, HUB_ENV.URSGAL_HUB_SECRET, HUB_ENV.URSGAL_HUB_ROUTE_ID, Date.now() - 10 * 60 * 1000)), 401);
  await settle(() => false, 200);
  assert.deepEqual(sends, []);
});

test("without the route id and secret every hub delivery is refused; Meta's own deliveries are unchanged", async (context) => {
  const { webhook } = await setup(context, { env: {} });
  const raw = instagramMessage("4");
  assert.equal(await post(webhook, raw, await hubHeaders(raw)), 401);
  const metaSigned = { "x-hub-signature-256": `sha256=${createHmac("sha256", "test-meta-secret").update(raw).digest("hex")}` };
  assert.equal(await post(webhook, raw, metaSigned), 200);
});

test("no lent token, no reply: a refused token or one for another Instagram account sends nothing", async (context) => {
  for (const options of [{ tokenStatus: 401 }, { tokenStatus: 503 }, { instagramId: "another-ig-account" }]) {
    await context.test(JSON.stringify(options), async (inner) => {
      const { webhook, sends, tokenRequests } = await setup(inner, options);
      const raw = instagramMessage(`refused-${JSON.stringify(options).length}`);
      assert.equal(await post(webhook, raw, await hubHeaders(raw)), 200);
      await settle(() => tokenRequests.length > 0);
      await settle(() => false, 200);
      assert.deepEqual(sends, [], "never the Messenger token instead");
    });
  }
});

test("a lent token answers only for its Instagram account, with the hub's proof", async () => {
  applyTestEnv({});
  const env = await import("../src/lib/env");
  env.resetEnvCacheForTests();
  const lent = await import("../src/lib/lentPageTokens");
  lent.forgetLentTokens();
  const now = Date.now();
  lent.rememberLentToken(IG_ACCOUNT, LENT_TOKEN, LENT_PROOF, now);
  assert.equal(env.pageTokenForRecipient(IG_ACCOUNT, "someone"), LENT_TOKEN);
  assert.equal(env.pageTokenForRecipient("1234567890", "someone"), "test-page-token", "the Messenger Page keeps its own token");
  assert.equal(env.appsecretProofFor(LENT_TOKEN), LENT_PROOF);
  assert.equal(env.appsecretProofFor("test-page-token"), createHmac("sha256", "test-meta-secret").update("test-page-token").digest("hex"));
  assert.equal(lent.lentTokenFor(IG_ACCOUNT, now + lent.LENT_TOKEN_TTL_MS + 1), undefined, "a lent token expires with the hub client's cache");
  lent.forgetLentTokens();
});

test("half a hub setting stops the build preflight; none, or a complete one, passes", async () => {
  const { ursgalHubSettingsIssues } = await import("../src/lib/ursgalHub");
  assert.deepEqual(ursgalHubSettingsIssues({}), []);
  assert.deepEqual(ursgalHubSettingsIssues({ ...HUB_ENV }), []);
  assert.match(ursgalHubSettingsIssues({ URSGAL_HUB_ROUTE_ID: HUB_ENV.URSGAL_HUB_ROUTE_ID }).join(), /set together/);
  assert.match(ursgalHubSettingsIssues({ URSGAL_HUB_SECRET: HUB_ENV.URSGAL_HUB_SECRET }).join(), /set together/);
  assert.match(ursgalHubSettingsIssues({ ...HUB_ENV, URSGAL_HUB_ROUTE_ID: "route-1" }).join(), /16-character/);
  assert.match(ursgalHubSettingsIssues({ ...HUB_ENV, URSGAL_HUB_SECRET: "short" }).join(), /whole secret/);
  assert.match(ursgalHubSettingsIssues({ ...HUB_ENV, URSGAL_HUB_URL: "http://hub.example.test" }).join(), /https origin/);
  assert.match(ursgalHubSettingsIssues({ ...HUB_ENV, URSGAL_HUB_PAGE_ID: "uudam" }).join(), /numeric/);
});
