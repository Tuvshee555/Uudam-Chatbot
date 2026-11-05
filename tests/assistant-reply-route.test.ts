import assert from "node:assert/strict";
import test from "node:test";
import type { NextApiRequest, NextApiResponse } from "next";
import pg from "pg";
import { applyTestEnv } from "./helpers/env";

/**
 * The admin assistant route with a fixture catalogue: a clear instruction becomes an exact
 * proposal without a model call, a name shared by two trips becomes a question with both as
 * choices, and only an instruction the assistant does not understand reaches the model —
 * with the owner's rules and the likely trip in its prompt.
 */
type TestResponse = NextApiResponse & { statusCode: number; body: Record<string, unknown> };

function createResponse(): TestResponse {
  const response = {
    statusCode: 200,
    body: undefined as unknown as Record<string, unknown>,
    status(code: number) { this.statusCode = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; return this; },
    end() { return this; },
    setHeader() { return this; },
  };
  return response as unknown as TestResponse;
}

function request(body: Record<string, unknown>): NextApiRequest {
  return {
    method: "POST", url: "/api/admin/ai-change", query: {}, body,
    headers: { "x-admin-secret": "test-admin-secret", "x-forwarded-for": "203.0.113.7" },
    socket: { remoteAddress: "203.0.113.7" },
  } as unknown as NextApiRequest;
}

const row = (fields: Record<string, unknown> & { id: string }) => ({
  category: "", operator_name: "UUDAM TRAVEL AGENCY", duration_text: "8 өдөр 7 шөнө", adult_price: 4_290_000, child_price: 3_990_000, infant_price: 690_000,
  currency: "MNT", departure_dates: ["2098-12-27"], seats_total: null, seats_left: null, has_food: true, status: "active", notes: "", hotel: "",
  source_description: "", photo_urls: [], extra: {}, created_at: "2098-10-01T00:00:00Z", updated_at: "2098-10-01T00:00:00Z", ...fields,
});
const ROWS = [
  row({ id: "t-norvel", route_name: "ТУРШИЛТ – НОРВЕЛ ХОТЫН АЯЛАЛ" }),
  row({ id: "t-norvel-ny", route_name: "НОРВЕЛ – ШИНЭ ЖИЛИЙН АЯЛАЛ", departure_dates: ["2098-12-29"] }),
  row({ id: "t-velmor", route_name: "ВЭЛМОР АРЛЫН АЯЛАЛ", departure_dates: ["2098-11-18"] }),
];

async function harness(context: import("node:test").TestContext) {
  applyTestEnv({ NEON_DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/assistant", BOOKING_DATABASE_URL: undefined });
  const inserted: Array<{ instruction: string; proposal: Record<string, unknown> }> = [];
  const modelCalls: Array<{ guide: string; user: string }> = [];
  const query = async (sql: string, params: unknown[] = []) => {
    if (/SELECT[\s\S]*FROM travel_trip_entries/i.test(sql)) {
      if (/WHERE id\s*=\s*\$1/i.test(sql)) { const found = ROWS.filter((r) => r.id === params[0]); return { rows: found, rowCount: found.length }; }
      return { rows: ROWS, rowCount: ROWS.length };
    }
    if (/INSERT INTO travel_ai_change_requests/i.test(sql)) {
      inserted.push({ instruction: String(params[0]), proposal: JSON.parse(String(params[1])) });
      // The real driver returns the BIGSERIAL id as a string.
      return { rows: [{ id: String(70 + inserted.length) }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  context.mock.method(pg.Pool.prototype, "query", query as unknown as typeof pg.Pool.prototype.query);
  context.mock.method(pg.Pool.prototype, "connect", (async () => ({ query, release() {} })) as unknown as typeof pg.Pool.prototype.connect);
  context.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("api.openai.com")) {
      const body = JSON.parse(String(init?.body || "{}"));
      const content = body.messages?.[body.messages.length - 1]?.content || [];
      modelCalls.push({ guide: String(content[0]?.text || ""), user: String(content[1]?.text || "") });
      const proposal = { summary: "Хөтөлбөрийг шинэчилнэ.", needs_confirmation: true, important_reason: "", conflicts: [], conflict_items: [],
        actions: [{ action: "patch", trip_id: "t-velmor", fields: { notes: "Шинэ хөтөлбөр" } }] };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(proposal) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  });
  const { resetEnvCacheForTests } = await import("../src/lib/env");
  resetEnvCacheForTests();
  const { resetRateLimitForTests } = await import("../src/lib/rateLimit");
  resetRateLimitForTests();
  const { default: handler } = await import("../src/pages/api/admin/ai-change");
  const post = async (body: Record<string, unknown>) => { const res = createResponse(); await handler(request(body), res); return res; };
  return { post, inserted, modelCalls };
}

test("a clear instruction becomes an exact saved proposal with no model call", async (context) => {
  const { post, inserted, modelCalls } = await harness(context);
  const res = await post({ instruction: "«ТУРШИЛТ – НОРВЕЛ ХОТЫН АЯЛАЛ» хоолгүй", session_id: "session-assistant-1" });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const proposal = res.body.proposal as { actions: unknown[]; summary: string; needs_confirmation: boolean };
  assert.deepEqual(proposal.actions, [{ action: "patch", trip_id: "t-norvel", fields: { has_food: false } }]);
  assert.match(proposal.summary, /хоол багтаагүй/);
  assert.equal(proposal.needs_confirmation, true);
  assert.equal(res.body.request_id, 71, "the proposal is saved as a change request and its id reaches the page as a number");
  assert.equal(inserted.length, 1);
  assert.equal(modelCalls.length, 0, "the model was not asked");
});

test("a name two trips share comes back as a question with both trips as choices", async (context) => {
  const { post, inserted, modelCalls } = await harness(context);
  const res = await post({ instruction: "норвел цуцал", session_id: "session-assistant-2" });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const ask = res.body.ask as { text: string; options: Array<{ label: string; answer: string }> };
  assert.ok(ask, "the reply is a question");
  assert.deepEqual(ask.options.map((option) => option.label).sort(), ["НОРВЕЛ – ШИНЭ ЖИЛИЙН АЯЛАЛ", "ТУРШИЛТ – НОРВЕЛ ХОТЫН АЯЛАЛ"]);
  assert.equal(res.body.proposal, undefined);
  assert.equal(inserted.length, 0, "nothing is saved until the trip is known");
  assert.equal(modelCalls.length, 0);
  // Tapping a choice sends its answer; the answer carries the trip and yields the proposal.
  const chosen = ask.options.find((option) => option.label === "НОРВЕЛ – ШИНЭ ЖИЛИЙН АЯЛАЛ")!;
  const next = await post({ instruction: chosen.answer, session_id: "session-assistant-2" });
  const proposal = next.body.proposal as { actions: Array<{ action: string; trip_id: string }> };
  assert.deepEqual(proposal.actions, [{ action: "cancel", trip_id: "t-norvel-ny" }]);
});

test("an instruction the assistant does not understand goes to the model, with the house rules and the likely trip", async (context) => {
  const { post, modelCalls } = await harness(context);
  const res = await post({ instruction: "Вэлмор аяллын хөтөлбөрийн 3 дахь өдрийг дахин бич", session_id: "session-assistant-3" });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(modelCalls.length, 1);
  assert.match(modelCalls[0].guide, /УУДАМ ТРЭВЭЛ-ИЙН ДҮРЭМ/, "the owner's rules are in the prompt");
  assert.match(modelCalls[0].guide, /Холбогдох аяллын дэлгэрэнгүй/);
  assert.match(modelCalls[0].guide, /"id":"t-velmor"/, "the trip the instruction concerns is given in full");
  assert.match(modelCalls[0].guide, /set_date_state/, "the per-date action is offered");
  const proposal = res.body.proposal as { actions: Array<{ trip_id: string }> };
  assert.equal(proposal.actions[0].trip_id, "t-velmor");
});
