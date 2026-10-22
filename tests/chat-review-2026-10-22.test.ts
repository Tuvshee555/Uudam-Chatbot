import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

// Real chats 10-19..22, replayed with invented trips through the webhook handler.
test("chat review 10-22: date window under a list, emoji, question marks, an impatient customer", async (context) => {
  applyTestEnv({ NEON_DATABASE_URL: "postgres://test:test@127.0.0.1:1/review-1022-fixture", TRIP_UNDERSTANDING: "off" });
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2098-02-01T04:00:00.000Z") });
  const { Pool } = await import("pg");
  const rows = [
    { id: "r-a", route_name: "ВЭЛМОР ХОЙД АЯЛАЛ", departure_dates: ["2098-03-05", "2098-03-26"] },
    { id: "r-b", route_name: "ВЭЛМОР ӨМНӨД АЯЛАЛ", departure_dates: ["2098-03-12", "2098-03-28"] },
  ].map((row) => ({ ...row, currency: "MNT", status: "active", duration_text: "8 өдөр", adult_price: 1_000_000, photo_urls: [], extra: {} }));
  const leads: unknown[][] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    if (/SELECT[\s\S]*FROM travel_trip_entries/i.test(sql)) return { rows, rowCount: rows.length };
    if (/INSERT INTO travel_leads/i.test(sql)) {
      leads.push(params);
      return { rows: [{ id: leads.length, kind: params[0], platform: params[1], sender_id: params[2], customer_message: params[3], status: "new" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  context.mock.method(Pool.prototype, "query", query as unknown as typeof Pool.prototype.query);
  context.mock.method(Pool.prototype, "connect", (async () => ({ query, release() {} })) as unknown as typeof Pool.prototype.connect);
  const sends: string[] = [];
  let aiCalls = 0;
  context.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("api.openai.com")) {
      aiCalls++;
      return new Response(JSON.stringify({ choices: [{ message: { content: "Та ВЭЛМОР ХОЙД АЯЛАЛ-ын талаар асууж байна уу?" } }] }), { status: 200 });
    }
    if (url.includes("/messages")) {
      const body = JSON.parse(String(init?.body || "{}"));
      if (body.message?.text) sends.push(body.message.text);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
  const env = await import("../src/lib/env");
  env.resetEnvCacheForTests();
  const webhook = await import("../src/pages/api/webhook");
  const { closeNeonPool } = await import("../src/lib/neonDb");
  let mid = 0;
  const send = async (sender: string, text: string) => {
    sends.length = 0;
    const payload = { object: "instagram", entry: [{ id: "review-page", messaging: [{ sender: { id: sender }, message: { mid: `review-${++mid}`, text } }] }] };
    const raw = Buffer.from(JSON.stringify(payload));
    const req = {
      method: "POST", url: "/api/webhook", query: {},
      headers: { "content-type": "application/json", "content-length": String(raw.length), "x-hub-signature-256": `sha256=${createHmac("sha256", "test-meta-secret").update(raw).digest("hex")}` },
      async *[Symbol.asyncIterator]() { yield raw; },
    };
    let status = 200;
    const res = { status(code: number) { status = code; return res; }, json() { return res; }, send() { return res; }, end() { return res; }, setHeader() {}, get statusCode() { return status; } };
    await webhook.default(req as never, res as never);
    assert.equal(status, 200);
    return [...sends];
  };
  try {
    // "<two trips listed>" then "3 сарын эхний 2 долоо хоногт сонирхож байна": the listed trips' dates in that window.
    webhook.resetWebhookStateForTests();
    const list = await send("rv-window", "ВЭЛМОР аялал");
    assert.equal(list.length, 1);
    assert.match(list[0], /ВЭЛМОР ХОЙД АЯЛАЛ/);
    const window = await send("rv-window", "3 сарын эхний 2 долоо хоногт сонирхож байна");
    assert.equal(window.length, 1, "the window gets an answer, not a hand-off");
    assert.match(window[0], /3 сарын 5/);
    assert.match(window[0], /3 сарын 12/);
    assert.doesNotMatch(window[0], /3 сарын (?:26|28)/);

    // A lone emoji: nothing sent, the model never asked (it guessed a trip from memory).
    const aiBefore = aiCalls;
    assert.deepEqual(await send("rv-emoji", "😊"), []);
    // Question marks only: nothing sent, staff get a lead.
    const leadsBefore = leads.length;
    assert.deepEqual(await send("rv-qmarks", "????"), []);
    assert.equal(leads.length, leadsBefore + 1);
    assert.equal(aiCalls, aiBefore, "emoji and question marks never reach the model");

    // "Hariu ugnu uu" (please answer): a person takes over.
    const impatient = await send("rv-impatient", "Hariu ugnu uu");
    assert.equal(impatient.length, 1);
    assert.match(impatient[0], /ажилтан|зөвлөх/);
  } finally {
    await closeNeonPool();
  }
});

test("a restated window is not a departure, but a wrong date under it is still caught", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2098-02-01T04:00:00.000Z") });
  const { verifyTripReply } = await import("../src/lib/tripReplyVerification");
  const trips = [{ id: "w-a", route_name: "ВЭЛМОР ХОЙД АЯЛАЛ", departure_dates: ["2098-03-05"], currency: "MNT", status: "active",
    duration_text: "8 өдөр", adult_price: 1_000_000, child_price: null, infant_price: null, photo_urls: [], extra: {} }] as never[];
  const good = "Тийм ээ, 3 сарын 1–14-ны хооронд гарах аяллууд байна 😊\n\n• ВЭЛМОР ХОЙД АЯЛАЛ\n  📅 3 сарын 5";
  assert.equal(verifyTripReply({ reply: good, trips }), good);
  assert.equal(verifyTripReply({ reply: good.replace("3 сарын 5", "3 сарын 9"), trips }), "REFER");
});
