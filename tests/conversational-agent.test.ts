import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test, { before } from "node:test";
import type { TravelTrip } from "../src/lib/travelTypes";
import { applyTestEnv } from "./helpers/env";

// Invented trips only (AGENTS.md): no real names, places, prices or dates.
let agent: typeof import("../src/lib/conversationalAgent");

before(async () => {
  applyTestEnv({ NEON_DATABASE_URL: undefined });
  agent = await import("../src/lib/conversationalAgent");
});

function trip(id: string, name: string, extra: Record<string, unknown> = {}): TravelTrip {
  return { id, route_name: name, category: "Шууд нислэгтэй", operator_name: "Invented", duration_text: "7 өдөр 6 шөнө",
    adult_price: 731_000, child_price: 512_000, infant_price: null, currency: "MNT", departure_dates: ["2098-03-03", "2098-03-17"],
    seats_total: null, seats_left: null, has_food: null, status: "active", notes: "", hotel: "", source_description: "",
    photo_urls: [], extra, created_at: "", updated_at: "" };
}

const north = trip("velmor-north", "ВЭЛМОР ХОЙД АЯЛАЛ", { website_slug: "velmor-north", website_published: true });
const south = trip("velmor-south", "ВЭЛМОР ӨМНӨД АЯЛАЛ");
const knowledgeBase = [
  "Modules:",
  `- ${north.route_name} | duration: 7 өдөр 6 шөнө | price: 731000 | Child price: 512000 | Departure dates: 3/3, 3/17 | description: invented`,
  `- ${south.route_name} | duration: 9 өдөр 8 шөнө | price: 640000 | Departure dates: 3/10 | description: invented`,
  "",
].join("\n");
const essay = `Энэ чиглэлээр хэд хэдэн сонголт байна 😊\n${"• ВЭЛМОР ХОЙД АЯЛАЛ — 7 өдөр · том хүн 731,000₮ · гарах: 3/3, 3/17\n".repeat(8)}Аль аяллыг нь сонирхож байна вэ?`;

test("the prompt carries the style contract, the catalog and trip links, and clips old essay replies", () => {
  const { system, user } = agent.buildAgentPrompt({
    knowledgeBase, trips: [north, south], userText: "хэдүүлээ явбал хэд вэ",
    history: [{ role: "user", text: "Вэлмор хойд аялал" }, { role: "assistant", text: essay }],
    now: new Date("2098-02-01T04:00:00.000Z"),
  });
  assert.match(system, /ONE QUESTION AT A TIME/);
  assert.match(system, /never more than 420 characters/);
  assert.match(user, /ВЭЛМОР ХОЙД АЯЛАЛ \| duration/);
  assert.match(user, /ВЭЛМОР ХОЙД АЯЛАЛ: https:\/\/uudamtravel\.mn\/trips\/velmor-north/);
  const replayed = user.split("\n").find((line) => line.startsWith("You: "))!;
  assert.ok(replayed.length < 300, "an old catalog dump is not replayed in full");
  assert.ok(user.trim().endsWith("Customer: хэдүүлээ явбал хэд вэ"));
});

test("the style check rejects essays, double questions, long lists and markdown", () => {
  assert.equal(agent.agentStyleProblem("Сайн байна уу 😊 2 аялал бий. Хэзээ явахаар төлөвлөж байна вэ?"), null);
  assert.match(agent.agentStyleProblem(essay)!, /characters/);
  assert.match(agent.agentStyleProblem("Хэзээ явах вэ? Хэдүүлээ явах вэ?")!, /more than one question/);
  assert.match(agent.agentStyleProblem("Сонголтууд:\n• А\n• Б\n• В\n• Г")!, /more than 3/);
  assert.match(agent.agentStyleProblem("**Үнэ** 731,000₮")!, /markdown/);
  // A link does not count against the length budget.
  assert.equal(agent.agentStyleProblem(`Хөтөлбөрийг эндээс харна уу: https://uudamtravel.mn/trips/${"x".repeat(500)}`), null);
});

test("the model's JSON is read into catalog trips, short buttons and an explicit hand-off", () => {
  const turn = agent.parseAgentTurn('```json\n{"reply":"Том хүн 731,000₮. Хэдүүлээ явах вэ?","buttons":["2 хүн","Гэр бүлээрээ явна, хүүхэдтэй"],"trips":["вэлмор хойд аялал","Unknown"],"handoff":false,"send_photos":true}\n```', [north, south]);
  assert.deepEqual(turn?.trips.map((t) => t.id), [north.id]);
  assert.deepEqual(turn?.buttons, ["2 хүн"]);
  assert.equal(turn?.sendPhotos, true);
  const handoff = agent.parseAgentTurn('{"reply":"Мэдэхгүй байна","handoff":true}', [north]);
  assert.equal(handoff?.handoff, true);
  assert.equal(handoff?.reply, "");
  assert.equal(agent.parseAgentTurn("Сайн байна уу", [north]), null);
  assert.equal(agent.parseAgentTurn('{"reply":""}', [north]), null);
});

test("an essay or a failed fact check is rewritten once with the reason", async () => {
  const prompts: string[] = [];
  const answers = [
    JSON.stringify({ reply: essay, trips: [north.route_name] }),
    JSON.stringify({ reply: "3/3-нд гарна, том хүн 731,000₮. Хэдүүлээ явах вэ?", trips: [north.route_name] }),
  ];
  const turn = await agent.runConversationalAgent({
    ask: async ({ user }) => { prompts.push(user); return answers.shift()!; },
    knowledgeBase, trips: [north, south], history: [], userText: "Вэлмор хойд аялал",
  });
  assert.equal(turn?.reply, "3/3-нд гарна, том хүн 731,000₮. Хэдүүлээ явах вэ?");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /previous draft for this message was rejected: it was \d+ characters/);

  const checked: string[] = [];
  const second = await agent.runConversationalAgent({
    ask: async () => JSON.stringify({ reply: "Том хүн 999,000₮. Хэзээ явах вэ?", trips: [north.route_name] }),
    knowledgeBase, trips: [north], history: [], userText: "үнэ",
    check: (draft) => { checked.push(draft.reply); return "a price is not in the catalog."; },
  });
  assert.equal(checked.length, 2, "rewritten once, then left to the exit check");
  assert.equal(second?.reply, "Том хүн 999,000₮. Хэзээ явах вэ?");

  assert.equal(await agent.runConversationalAgent({
    ask: async () => { throw new Error("model down"); },
    knowledgeBase, trips: [north], history: [], userText: "үнэ",
  }), null);
});

test("the agent can be switched off from the environment or the bot settings", () => {
  assert.equal(agent.conversationalAgentEnabled({}, ""), true);
  assert.equal(agent.conversationalAgentEnabled({}, "off"), false);
  assert.equal(agent.conversationalAgentEnabled({ conversational_agent: false }, ""), false);
});

test("the webhook sends one short agent message, rewrites wrong facts, and hands off silently", async (context) => {
  applyTestEnv({ NEON_DATABASE_URL: "postgres://test:test@127.0.0.1:1/agent-fixture", TRIP_UNDERSTANDING: "off", CONVERSATIONAL_AGENT: "on" });
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2098-02-01T04:00:00.000Z") });
  const { Pool } = await import("pg");
  const rows = [north, south].map((t) => ({ ...t }));
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
  const modelReplies: string[] = [];
  const modelRequests: Array<{ response_format?: unknown; messages: Array<{ role: string; content: unknown }> }> = [];
  context.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("api.openai.com")) {
      const body = JSON.parse(String(init?.body || "{}"));
      modelRequests.push(body);
      const content = modelReplies.shift() ?? JSON.stringify({ reply: "", handoff: true });
      return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200 });
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
  let message = 0;
  const say = async (sender: string, text: string) => {
    webhook.resetWebhookStateForTests();
    sends.length = 0;
    modelRequests.length = 0;
    message++;
    const payload = { object: "instagram", entry: [{ id: "agent-page", messaging: [{ sender: { id: sender }, message: { mid: `agent-message-${message}`, text } }] }] };
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
  };
  try {
    // A bare destination gets a warm question, not a catalog dump.
    modelReplies.push(JSON.stringify({ reply: "Сайн байна уу 😊 Вэлмор руу 2 аялал бий. Хэзээ явахаар төлөвлөж байна вэ?", buttons: ["3 сард", "4 сард"], trips: [] }));
    await say("agent-a", "Вэлмор аялал");
    assert.deepEqual(sends, ["Сайн байна уу 😊 Вэлмор руу 2 аялал бий. Хэзээ явахаар төлөвлөж байна вэ?"]);
    assert.equal(modelRequests.length, 1);
    assert.deepEqual(modelRequests[0].response_format, { type: "json_object" });
    assert.match(JSON.stringify(modelRequests[0].messages.find((m) => m.role === "system")?.content), /ONE QUESTION AT A TIME/);

    // A catalog fare goes out; an invented one is rewritten first.
    modelReplies.push(
      JSON.stringify({ reply: "ВЭЛМОР ХОЙД АЯЛАЛ 3/3-нд гарна, том хүн 999,000₮. Хэдүүлээ явах вэ?", trips: [north.route_name] }),
      JSON.stringify({ reply: "ВЭЛМОР ХОЙД АЯЛАЛ 3/3-нд гарна, том хүн 731,000₮. Хэдүүлээ явах вэ?", trips: [north.route_name] }),
    );
    await say("agent-b", "Вэлмор хойд аялал үнэ хэд вэ");
    assert.equal(modelRequests.length, 2);
    assert.match(JSON.stringify(modelRequests[1].messages.find((m) => m.role === "user")?.content), /rejected: a price, date/);
    assert.deepEqual(sends, ["ВЭЛМОР ХОЙД АЯЛАЛ 3/3-нд гарна, том хүн 731,000₮. Хэдүүлээ явах вэ?"]);

    // A fare that stays wrong is never sent: staff get a lead instead.
    const leadsBefore = leads.length;
    modelReplies.push(
      JSON.stringify({ reply: "ВЭЛМОР ХОЙД АЯЛАЛ: том хүн 999,000₮. Хэдүүлээ явах вэ?", trips: [north.route_name] }),
      JSON.stringify({ reply: "ВЭЛМОР ХОЙД АЯЛАЛ: том хүн 999,000₮. Хэдүүлээ явах вэ?", trips: [north.route_name] }),
    );
    await say("agent-c", "Вэлмор хойд аялал үнэ хэд вэ");
    assert.deepEqual(sends, []);
    assert.equal(leads.length, leadsBefore + 1);

    // The model's own "the catalog cannot answer" is a silent hand-off too.
    modelReplies.push(JSON.stringify({ reply: "", handoff: true }));
    await say("agent-d", "Вэлмор хойд аялалд виз хэрэгтэй юу");
    assert.deepEqual(sends, []);
    assert.equal(leads.length, leadsBefore + 2);

    // A bare number reaches the agent, which reads it against the chat.
    modelReplies.push(JSON.stringify({ reply: "Ойлголоо, 2 хүн. Аль сард явах вэ?", trips: [] }));
    await say("agent-e", "2");
    assert.deepEqual(sends, ["Ойлголоо, 2 хүн. Аль сард явах вэ?"]);
  } finally {
    await closeNeonPool();
  }
});
