import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

test("configured text replies share grounding and paused customers retain inbound evidence", async context => {
  applyTestEnv({ NEON_DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/reply-boundary",
    BOOKING_DATABASE_URL: undefined, TRIP_UNDERSTANDING: "off", STAFF_NOTIFY_PSIDS: undefined,
    TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_STAFF_CHAT_IDS: undefined });
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2098-02-01T04:00:00Z") });
  const history: Array<{ sender: string; role: string; text: string; attachments: unknown[] }> = [];
  const paused = new Set<string>();
  const leads = new Set<string>();
  const leadKinds = new Set<string>();
  const sends: string[] = [];
  let pagePaused = false;
  let contactPhones = "1111 2222";
  let officeAddress = "ВЭЛМОР АЯЛАЛ";
  let quickInfoReply = "ВЭЛМОР АЯЛАЛ — 1,731,000₮";
  let legacyReply = quickInfoReply;
  let graphReply = quickInfoReply;
  let failPartAttempts = 0;
  let acceptedPartBeforeFailure = 0;
  let failStorage = false;
  let goodbyeClaims = 0;
  let modelCalls = 0;
  let imageSends = 0;
  let bookingLeads = 0;
  let eventSerial = 0;
  const result = (rows: unknown[] = []) => ({ rows, rowCount: rows.length });
  const query = async (sql: string, params: unknown[] = []) => {
    const sender = String(params[0] || "");
    if (/SELECT[\s\S]*FROM travel_trip_entries/i.test(sql)) return result([{ id: "velmor", route_name: "ВЭЛМОР АЯЛАЛ",
      status: "active", duration_text: "5 өдөр", departure_dates: ["2098-03-17"], adult_price: 1_731_000,
      currency: "MNT", photo_urls: [], extra: {} }]);
    if (/SELECT[\s\S]*FROM travel_bot_settings/i.test(sql)) return result([{ business_name: "Fixture agency",
      handoff_enabled: true, handoff_keywords: [], quick_info_keywords: ["товч мэдээлэл", "ВЭЛМОР АЯЛАЛ товч мэдээлэл"],
      quick_info_reply: quickInfoReply, chat_buttons: [],
      extra: { contact_phones: contactPhones, office_address: officeAddress,
        greeting: { enabled: false }, goodbye: { enabled: true, text: "Зөвлөхийн холбоо: 1111 2222" }, reminder_enabled: false,
        flowDocs: [{ id: "fixture-graph", name: "Fixture graph", enabled: true, nodes: [
          { id: "start", position: { x: 0, y: 0 }, data: { kind: "trigger", triggerType: "keyword", keywords: ["граф", "ВЭЛМОР АЯЛАЛ граф"], matchType: "exact" } },
          { id: "first", position: { x: 0, y: 1 }, data: { kind: "message", text: graphReply, quickReplies: ["Сонгох"], imageUrls: ["https://fixture.invalid/graph.png"] } },
          { id: "second", position: { x: 0, y: 2 }, data: { kind: "message", text: "Дараагийн мессеж" } },
          { id: "action", position: { x: 0, y: 3 }, data: { kind: "action", actions: [{ type: "capture_lead" }, { type: "notify_owner", ownerMessage: "Fixture notification" }] } },
          { id: "ai", position: { x: 0, y: 4 }, data: { kind: "ai_step" } },
        ], edges: [{ id: "e1", source: "start", target: "first" }, { id: "e2", source: "first", target: "second" },
          { id: "e3", source: "second", target: "action" }, { id: "e4", source: "action", target: "ai" }] }],
        flows: [{ id: "fixture-rule", keywords: "урсгал", reply: legacyReply, buttons: [] }] } }]);
    if (/SELECT[\s\S]*FROM travel_bot_control/i.test(sql)) return result([{ bot_paused: false, photo_only: false }]);
    if (/SELECT[\s\S]*FROM travel_page_control/i.test(sql)) return result([{ bot_paused: pagePaused }]);
    if (/SELECT paused, expires_at FROM travel_senders/i.test(sql)) return result(paused.has(sender)
      ? [{ paused: true, expires_at: "2098-02-03T04:00:00Z" }] : []);
    if (/INSERT INTO travel_senders \(sender_id, platform,/i.test(sql)) return result([{
      msg_count: sender.includes("-paused") || sender === "staff-return" ? 2 : 1,
      prev_msg_at: "2098-01-31T04:00:00Z", get_started_at: null }]);
    if (/INSERT INTO travel_senders \(sender_id, paused,/i.test(sql)) { paused.add(sender); return result(); }
    if (/SET goodbye_sent_at/i.test(sql)) { goodbyeClaims++; return result([{ claimed: true }]); }
    if (/COUNT[\s\S]*FROM travel_leads/i.test(sql)) return result([{ count: leadKinds.has(`${sender}:${params[1]}`) ? "1" : "0" }]);
    if (/INSERT INTO travel_leads/i.test(sql)) {
      if (params[0] === "booking") bookingLeads++;
      leads.add(String(params[2])); leadKinds.add(`${params[2]}:${params[0]}`);
      return result([{ id: leads.size, kind: params[0], platform: params[1], sender_id: params[2], status: "new" }]);
    }
    if (/INSERT INTO travel_conversations/i.test(sql)) {
      if (failStorage) throw new Error("fixture inbound storage unavailable");
      history.push({ sender, role: String(params[1]), text: String(params[2]), attachments: JSON.parse(String(params[3] || "[]")) });
    }
    return result();
  };
  const { Pool } = await import("pg");
  context.mock.method(Pool.prototype, "query", query as unknown as typeof Pool.prototype.query);
  context.mock.method(Pool.prototype, "connect", (async () => ({ query, release() {} })) as unknown as typeof Pool.prototype.connect);
  context.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("api.openai.com")) { modelCalls++; throw new Error("Unexpected model call"); }
    assert.match(url, /^https:\/\/graph\.(?:facebook|instagram)\.com\//);
    if (url.includes("/conversations?")) return new Response(JSON.stringify({ data: [{ messages: { data: url.includes("staff-return")
      ? [{ from: { id: "1234567890" }, created_time: "2098-02-01T03:00:00Z", tags: { data: [{ name: "source:mobile" }] } }] : [] } }] }), { status: 200 });
    const body = JSON.parse(String(init?.body || "{}"));
    if (body.message?.attachment) imageSends++;
    if (body.message?.text) {
      if (acceptedPartBeforeFailure > 0) acceptedPartBeforeFailure--;
      else if (failPartAttempts > 0) { failPartAttempts--; return new Response("fixture part delivery failure", { status: 503 }); }
      sends.push(body.message.text);
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  const webhook = await import("../src/pages/api/webhook");
  const { closeNeonPool } = await import("../src/lib/neonDb");
  const call = async (sender: string, text: string, options: { facebook?: boolean; event?: string; attachments?: unknown[] } = {}) => {
    context.mock.timers.tick(6_000);
    const payload = { object: options.facebook ? "page" : "instagram", entry: [{ id: options.facebook ? "1234567890" : "boundary-page",
      messaging: [{ sender: { id: sender }, message: { mid: options.event || `fixture-event-${++eventSerial}`, text, attachments: options.attachments } }] }] };
    const raw = Buffer.from(JSON.stringify(payload));
    const req = { method: "POST", url: "/api/webhook", query: {}, headers: { "content-type": "application/json", "content-length": String(raw.length),
      "x-hub-signature-256": `sha256=${createHmac("sha256", "test-meta-secret").update(raw).digest("hex")}` },
      async *[Symbol.asyncIterator]() { yield raw; } };
    let status = 200;
    const res = { status(code: number) { status = code; return res; }, json() { return res; }, send() { return res; }, end() { return res; },
      setHeader() {}, get statusCode() { return status; } };
    const before = sends.length;
    await webhook.default(req as never, res as never);
    return { status, sends: sends.slice(before) };
  };
  try {
    for (const [label, text] of [["quick-info", "товч мэдээлэл"], ["legacy-flow", "урсгал"], ["address", "Манай хаяг"]]) {
      await context.test(`${label} cannot name an unrelated trip`, async () => {
        const response = await call(label, text);
        assert.equal(response.status, 200);
        assert.deepEqual(response.sends, []);
        assert.ok(leads.has(label), "withheld answer must leave a durable staff lead");
        assert.ok(history.some(row => row.sender === label && row.role === "user" && row.text === text));
      });
    }
    for (const [label, text] of [["grounded-quick", "ВЭЛМОР АЯЛАЛ товч мэдээлэл"], ["grounded-flow", "ВЭЛМОР АЯЛАЛ урсгал"]]) {
      await context.test(`${label} still sends configured facts with customer evidence`, async () => {
        const response = await call(label, text);
        assert.equal(response.status, 200);
        assert.deepEqual(response.sends, ["ВЭЛМОР АЯЛАЛ — 1,731,000₮"]);
      });
    }
    for (const facebook of [false, true]) {
      await context.test(`${facebook ? "Messenger" : "Instagram"} graph stops text, media, actions and AI after a withheld reply`, async () => {
        const sender = facebook ? "facebook-graph" : "instagram-graph";
        const beforeImages = imageSends, beforeBookings = bookingLeads;
        const response = await call(sender, "граф", { facebook });
        assert.equal(response.status, 200);
        assert.deepEqual(response.sends, []);
        assert.ok(leads.has(sender));
        assert.equal(imageSends, beforeImages);
        assert.equal(bookingLeads, beforeBookings, "a rejected graph must not capture an unrelated booking");
        const { getFlowState } = await import("../src/lib/flowEngine");
        assert.equal(await getFlowState(sender, facebook ? "facebook" : "instagram"), null);
      });
    }
    await context.test("configured fares must match current catalog facts even when the customer named the trip", async () => {
      quickInfoReply = legacyReply = graphReply = "ВЭЛМОР АЯЛАЛ — 9,999,999₮";
      for (const [sender, text] of [["stale-quick", "ВЭЛМОР АЯЛАЛ товч мэдээлэл"],
        ["stale-legacy", "ВЭЛМОР АЯЛАЛ урсгал"], ["stale-graph", "ВЭЛМОР АЯЛАЛ граф"]]) {
        const response = await call(sender, text);
        assert.equal(response.status, 200);
        assert.deepEqual(response.sends, []);
        assert.ok(leads.has(sender), "stale configured facts require a staff handoff");
      }
      quickInfoReply = legacyReply = graphReply = "ВЭЛМОР АЯЛАЛ — 1,731,000₮";
    });
    await context.test("an unsupported starting city cannot be answered with trips merely visiting it", async () => {
      const response = await call("unsupported-origin", "ВЭЛМОР хотоос эхлэх аялал");
      assert.equal(response.status, 200);
      assert.deepEqual(response.sends, []);
      assert.ok(leads.has("unsupported-origin"));
    });
    await context.test("booking collection records each presented reply once through the shared exit", async () => {
      const sender = "booking-shared-exit";
      const { getCollectState } = await import("../src/lib/bookingCollect");
      for (const text of ["Захиалах", "89110000", "ВЭЛМОР АЯЛАЛ"]) {
        const beforeReplies = history.filter(row => row.sender === sender && row.role === "assistant").length;
        const response = await call(sender, text);
        assert.equal(response.status, 200);
        assert.equal(response.sends.length, 1);
        const replies = history.filter(row => row.sender === sender && row.role === "assistant");
        assert.equal(replies.length, beforeReplies + 1, "the collector and shared exit cannot duplicate assistant history");
        assert.equal(replies.at(-1)?.text, response.sends[0], "history must contain the exact presented reply");
      }
      assert.ok(leadKinds.has(`${sender}:booking`));
      assert.equal(await getCollectState(sender), null);
    });
    await context.test("withheld booking confirmation clears the collector without recording an unsent confirmation", async () => {
      const sender = "booking-ungrounded-exit";
      const { getCollectState, setCollectState, startCollectState } = await import("../src/lib/bookingCollect");
      await setCollectState(sender, startCollectState("Захиалах", "ВЭЛМОР АЯЛАЛ"));
      const response = await call(sender, "89110000");
      assert.equal(response.status, 200);
      assert.deepEqual(response.sends, []);
      assert.ok(leadKinds.has(`${sender}:handoff`));
      assert.equal(await getCollectState(sender), null);
      assert.equal(history.filter(row => row.sender === sender && row.role === "assistant").length, 0);
    });
    await context.test("booking prompt delivery failures preserve retryable state until the reply succeeds", async () => {
      const sender = "booking-prompt-retry";
      const { getCollectState } = await import("../src/lib/bookingCollect");
      failPartAttempts = 2;
      const failed = await call(sender, "Захиалах", { event: "booking-prompt-event" });
      assert.equal(failed.status, 503);
      assert.deepEqual(failed.sends, []);
      assert.equal((await getCollectState(sender))?.step, "phone");
      const retry = await call(sender, "Захиалах", { event: "booking-prompt-event" });
      assert.equal(retry.status, 200);
      assert.equal(retry.sends.length, 1);
      assert.equal(history.filter(row => row.sender === sender && row.role === "assistant").length, 1);
      assert.deepEqual((await call(sender, "Захиалах", { event: "booking-prompt-event" })).sends, []);
    });
    await context.test("business contact request gives the business number without requesting the customer's number", async () => {
      const response = await call("business-phone", "Холбоо барих дугаар");
      assert.equal(response.status, 200);
      assert.equal(response.sends.length, 1);
      assert.match(response.sends[0], /1111 2222/);
      assert.doesNotMatch(response.sends[0], /дугаараа|холбогдоно/);
    });
    await context.test("missing saved contact facts stay silent and create staff handoffs", async () => {
      officeAddress = "";
      assert.deepEqual((await call("unknown-office", "Манай хаяг")).sends, []);
      assert.ok(leads.has("unknown-office"));
      contactPhones = "";
      assert.deepEqual((await call("unknown-phone", "Холбоо барих дугаар")).sends, []);
      assert.ok(leads.has("unknown-phone"));
      contactPhones = "1111 2222";
      officeAddress = "ВЭЛМОР АЯЛАЛ";
    });
    await context.test("long configured reply resumes across signed event retries without repeating the accepted prefix", async () => {
      quickInfoReply = "ВЭЛМОР АЯЛАЛ\n" + "Хөтөлбөрийн баталгаатай тайлбар. ".repeat(180);
      const { presentAssistantReply } = await import("../src/lib/chatbotReplyPolicy");
      const expected = presentAssistantReply({ reply: quickInfoReply, userText: "ВЭЛМОР АЯЛАЛ товч мэдээлэл" });
      acceptedPartBeforeFailure = 1;
      failPartAttempts = 2;
      const first = await call("long-configured", "ВЭЛМОР АЯЛАЛ товч мэдээлэл", { facebook: true, event: "long-event" });
      assert.equal(first.status, 503);
      assert.equal(first.sends.length, 1, "quick send and its fallback cannot repeat the accepted first part");
      const retry = await call("long-configured", "ВЭЛМОР АЯЛАЛ товч мэдээлэл", { facebook: true, event: "long-event" });
      assert.equal(retry.status, 200);
      assert.equal([...first.sends, ...retry.sends].join(""), expected);
      assert.ok([...first.sends, ...retry.sends].every(part => part.length <= 2_000));
      assert.deepEqual((await call("long-configured", "ВЭЛМОР АЯЛАЛ товч мэдээлэл", { facebook: true, event: "long-event" })).sends, []);
      const repeatedQuestion = await call("long-configured", "ВЭЛМОР АЯЛАЛ товч мэдээлэл", { facebook: true, event: "new-long-event" });
      assert.equal(repeatedQuestion.status, 200);
      assert.equal(repeatedQuestion.sends.join(""), expected, "a fresh inbound question may request the same complete answer again");
      quickInfoReply = "ВЭЛМОР АЯЛАЛ — 1,731,000₮";
    });
    for (const mode of ["sender", "page", "staff"] as const) {
      await context.test(`${mode} pause retains inbound text without sending reengagement contact`, async () => {
        const sender = mode === "staff" ? "staff-return" : `${mode}-paused`;
        if (mode === "sender") paused.add(sender);
        pagePaused = mode === "page";
        const beforeClaims = goodbyeClaims;
        const response = await call(sender, "Зөвлөхөд үлдээсэн асуулт", { facebook: true, event: `${sender}-event` });
        assert.equal(response.status, 200);
        assert.deepEqual(response.sends, []);
        assert.equal(goodbyeClaims, beforeClaims, "paused senders cannot claim or send reengagement messages");
        assert.equal(history.filter(row => row.sender === sender && row.role === "user").length, 1);
        assert.equal((await call(sender, "Зөвлөхөд үлдээсэн асуулт", { facebook: true, event: `${sender}-event` })).status, 200);
        assert.equal(history.filter(row => row.sender === sender && row.role === "user").length, 1, "event retries cannot duplicate the retained message");
        pagePaused = false;
      });
    }
    await context.test("paused attachments retain image and voice links without extraction or replies", async () => {
      const sender = "paused-evidence";
      paused.add(sender);
      const response = await call(sender, "", { attachments: [{ type: "image", payload: { url: "https://fixture.invalid/poster.png" } },
        { type: "audio", payload: { url: "https://fixture.invalid/note.mp3" } }] });
      assert.equal(response.status, 200);
      assert.deepEqual(response.sends, []);
      assert.deepEqual(history.find(row => row.sender === sender)?.attachments, [
        { type: "image", url: "https://fixture.invalid/poster.png" }, { type: "file", url: "https://fixture.invalid/note.mp3" }]);
    });
    await context.test("paused inbound storage failure leaves the event retryable", async () => {
      const sender = "paused-retry";
      paused.add(sender);
      failStorage = true;
      assert.equal((await call(sender, "Зөвлөхийн асуулт", { event: "paused-storage-event" })).status, 503);
      assert.equal(history.filter(row => row.sender === sender).length, 0);
      failStorage = false;
      assert.equal((await call(sender, "Зөвлөхийн асуулт", { event: "paused-storage-event" })).status, 200);
      assert.equal(history.filter(row => row.sender === sender).length, 1);
    });
    assert.equal(modelCalls, 0);
  } finally { await closeNeonPool(); }
});
