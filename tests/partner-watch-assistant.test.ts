import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { applyTestEnv } from "./helpers/env";
import { agentDeps, htmlResponse, scriptedChat } from "./helpers/agentFixtures";
import { duplicateLinkAsk, partnerCheckReply, watchCheckTripId, withoutWatchTags, withSourceUrl } from "../src/lib/partnerWatch/assistant";
import { cleanSourceUrl, sourceUrlKey, tripsFromPage } from "../src/lib/partnerWatch/sourceUrl";
import { normalizeExtra, normalizeExtraPatch } from "../src/lib/tripExtraSchema";
import type { AIChangeProposal, TravelTrip } from "../src/lib/travelTypes";

/**
 * The partner watch inside the admin assistant, on invented trips and pages: a new trip read
 * from a link keeps the link, the same link pasted again is asked about in code (no model), and
 * «Хуваарь, суудлыг шинэчлэх» shows the page's changes as a proposal to review.
 */

const NOW = new Date("2098-11-20T04:00:00Z");
const VERSION = "2098-11-01T00:00:00.000Z";
const URL = "https://partner.example/tours/norvel";

function trip(fields: Partial<TravelTrip> & Pick<TravelTrip, "id" | "route_name">): TravelTrip {
  return {
    category: "", operator_name: "UUDAM TRAVEL AGENCY", duration_text: "8 өдөр 7 шөнө", adult_price: 2_590_000, child_price: 2_490_000, infant_price: 0,
    currency: "MNT", departure_dates: [], seats_total: null, seats_left: null, has_food: true, status: "active", notes: "", hotel: "",
    source_description: "", photo_urls: [], extra: {}, created_at: VERSION, updated_at: VERSION, ...fields,
  };
}

const NORVEL = trip({
  id: "t-watch-norvel", route_name: "ТУРШИЛТ – НОРВЕЛ ХОТЫН АЯЛАЛ", departure_dates: ["2098-12-05", "2098-12-12"],
  extra: {
    source_url: URL,
    price_groups: [
      { label: "", dates: ["2098-12-05"], adult_price: 2_590_000, child_price: 2_490_000 },
      { label: "", dates: ["2098-12-12"], adult_price: 2_890_000, child_price: 2_790_000 },
    ],
    website_departure_availability: [{ date: "2098-12-05", status: "OPEN", seatsLeft: null }, { date: "2098-12-12", status: "OPEN", seatsLeft: null }],
  },
});
const SYNCED = trip({ id: "t-watch-synced", route_name: "ТУРШИЛТ – ВЭЛМОР SYNC", extra: { partner_sync: { source_url: "https://partner.example/tours/velmor" } } });
const ARCHIVED = trip({ id: "t-watch-archived", route_name: "ТУРШИЛТ – ЗЭНИТ ХУУЧИН", status: "archived", extra: { source_url: "https://partner.example/tours/zenit" } });

const td = (cells: string[]) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
const schedule = (rows: string[][]) => `<html><head><title>Норвел</title></head><body><table>${[["Бүртгэл", "Аялал гарах өдөр", "Том хүн", "Хүүхэд"], ...rows].map(td).join("")}</table></body></html>`;
const CHANGED_PAGE = schedule([
  ["бүртгэж байна", "12 сарын 05", "2,690,000 төг", "2,490,000 төг"],
  ["дүүрсэн", "12 сарын 12", "2,890,000 төг", "2,790,000 төг"],
  ["бүртгэж байна", "12 сарын 19", "2,990,000 төг", "2,890,000 төг"],
]);

test("one partner page, however the link is written", () => {
  assert.equal(cleanSourceUrl("https://partner.example/tours/norvel/?utm_source=fb&fbclid=1#prices"), "https://partner.example/tours/norvel/");
  assert.equal(cleanSourceUrl("http://partner.example/x"), "", "only https is stored");
  assert.equal(sourceUrlKey("https://www.Partner.example/tours/norvel/?utm_source=fb"), sourceUrlKey("partner.example/tours/norvel"));
  assert.notEqual(sourceUrlKey("https://partner.example/tour?id=1"), sourceUrlKey("https://partner.example/tour?id=2"), "a query that names the tour is kept");
  assert.deepEqual(tripsFromPage([NORVEL, SYNCED, ARCHIVED], "www.partner.example/tours/norvel/").map((entry) => entry.id), ["t-watch-norvel"]);
});

test("the trip's extra keeps the page through normalization (no unknown-key warning)", () => {
  const { extra, warnings } = normalizeExtra({ source_url: "https://partner.example/tours/norvel", source_checked_at: "2098-11-01T03:00:00Z" });
  assert.equal(extra.source_url, "https://partner.example/tours/norvel");
  assert.equal(extra.source_checked_at, "2098-11-01T03:00:00.000Z");
  assert.ok(!warnings.some((warning) => /source_url|source_checked_at/.test(warning)), warnings.join(" | "));
  assert.deepEqual(normalizeExtraPatch({ source_url: "javascript:alert(1)" }), {}, "only an https link is kept");
  assert.deepEqual(normalizeExtraPatch({ source_url: URL }), { source_url: URL });
});

test("a reading made from a page: every new trip keeps the page, an edit of an existing trip does not", () => {
  const proposal = {
    summary: "", needs_confirmation: true, important_reason: "", conflicts: [], conflict_items: [],
    actions: [
      { action: "upsert", fields: { route_name: "ТУРШИЛТ – ШИНЭ", extra: { aliases: ["Шинэ"] } } },
      { action: "patch", trip_id: "t-watch-norvel", fields: { notes: "x" } },
    ],
  } as unknown as AIChangeProposal;
  const stamped = withSourceUrl(proposal, "https://partner.example/tours/new#top", "2098-11-20T04:00:00.000Z");
  assert.deepEqual(stamped.actions[0].fields?.extra, { aliases: ["Шинэ"], source_url: "https://partner.example/tours/new", source_checked_at: "2098-11-20T04:00:00.000Z" });
  assert.deepEqual(stamped.actions[1], proposal.actions[1]);
  assert.equal(withSourceUrl(proposal, undefined, "x"), proposal, "a pasted program has no page");
});

test("the review save keeps the page on the new trip (only review-only keys are dropped)", async () => {
  const { reviewedFields } = await import("../src/lib/tripReview");
  const saved = reviewedFields({ route_name: "ТУРШИЛТ – ШИНЭ", departure_dates: [], extra: { source_url: URL, source_checked_at: "2098-11-20T04:00:00.000Z", source_evidence: { x: 1 } } }, "draft", NOW);
  const extra = saved.extra as Record<string, unknown>;
  assert.equal(extra.source_url, URL);
  assert.equal(extra.source_checked_at, "2098-11-20T04:00:00.000Z");
  assert.equal("source_evidence" in extra, false);
});

test("a link a trip was already made from: one question, check now or add again", () => {
  const ask = duplicateLinkAsk(`${URL}/ энэ аяллыг манайд нэм`, [NORVEL, SYNCED, ARCHIVED], NOW);
  assert.ok(ask);
  assert.equal(ask.text, "Энэ холбоосын аялал аль хэдийн нэмэгдсэн: «ТУРШИЛТ – НОРВЕЛ ХОТЫН АЯЛАЛ»");
  assert.deepEqual(ask.options.map((option) => option.label), ["Хуваарь, суудлыг шинэчлэх", "Шинэ аялал болгон дахин нэмэх"]);
  assert.equal(watchCheckTripId(ask.options[0].answer), "t-watch-norvel");
  assert.equal(duplicateLinkAsk(ask.options[1].answer, [NORVEL], NOW), null, "«add again» is not asked twice");
  assert.equal(withoutWatchTags(ask.options[1].answer), `${URL}/ энэ аяллыг манайд нэм`);
  // Partner-synced and archived trips are named, but only «add again» is offered.
  const synced = duplicateLinkAsk("https://partner.example/tours/velmor", [SYNCED], NOW);
  assert.match(String(synced?.text), /30 минут тутам/);
  assert.deepEqual(synced?.options.map((option) => option.label), ["Шинэ аялал болгон дахин нэмэх"]);
  assert.deepEqual(duplicateLinkAsk("https://partner.example/tours/zenit", [ARCHIVED], NOW)?.options.map((option) => option.label), ["Шинэ аялал болгон дахин нэмэх"]);
  assert.equal(duplicateLinkAsk("https://partner.example/tours/other", [NORVEL], NOW), null);
});

test("«Хуваарь, суудлыг шинэчлэх»: the page's seat and fare changes as a proposal; new dates as lines", async () => {
  const persisted: Array<{ instruction: string; proposal: AIChangeProposal }> = [];
  const recorded: unknown[] = [];
  const reply = await partnerCheckReply("t-watch-norvel", [NORVEL], {
    now: NOW,
    fetchPage: async (url) => ({ ok: true, url, title: "Норвел", text: (await import("../src/lib/assistantAgent/webPage")).htmlToText(CHANGED_PAGE).text, truncated: false, data_notice: "" }),
    persist: async (instruction, proposal) => { persisted.push({ instruction, proposal }); return 91; },
    record: async (event) => { recorded.push(event); },
  });
  assert.equal(reply.kind, "proposal", JSON.stringify(reply));
  if (reply.kind !== "proposal") return;
  assert.equal(reply.request_id, 91);
  assert.deepEqual(reply.proposal.actions.map((action) => [action.action, action.date, action.trip_id]), [
    ["set_date_state", "2098-12-12", "t-watch-norvel"],
    ["set_date_price", "2098-12-05", "t-watch-norvel"],
  ]);
  assert.ok(reply.proposal.actions.every((action) => action.expected_updated_at === VERSION), "version-stamped like every agent action");
  assert.ok(reply.proposal.conflicts.some((line) => /12\/19: хамтрагчийн хуудсанд шинэ гаралт/.test(line)), reply.proposal.conflicts.join(" | "));
  assert.equal(persisted[0].instruction, "«ТУРШИЛТ – НОРВЕЛ ХОТЫН АЯЛАЛ» хамтрагчийн хуудастай тулгах");
  assert.equal(recorded.length, 1, "the check is recorded for the «Тойм» card");

  const same = await partnerCheckReply("t-watch-norvel", [NORVEL], {
    now: NOW,
    fetchPage: async (url) => ({ ok: true, url, title: "", text: (await import("../src/lib/assistantAgent/webPage")).htmlToText(schedule([
      ["бүртгэж байна", "12 сарын 05", "2,590,000 төг", "2,490,000 төг"], ["бүртгэж байна", "12 сарын 12", "2,890,000 төг", "2,790,000 төг"],
    ])).text, truncated: false, data_notice: "" }),
    persist: async () => { throw new Error("nothing to store"); },
    record: async () => undefined,
  });
  assert.deepEqual(same, { kind: "note", text: "«ТУРШИЛТ – НОРВЕЛ ХОТЫН АЯЛАЛ» хамтрагчийн хуудастай таарч байна — хуваарь, суудал, үнэд өөрчлөлт алга." });
  const down = await partnerCheckReply("t-watch-norvel", [NORVEL], { now: NOW, fetchPage: async (url) => ({ ok: false, url, error: "Хуудас 10 секундэд нээгдсэнгүй." }), record: async () => undefined });
  assert.equal(down.kind, "note");
  assert.match(down.kind === "note" ? down.text : "", /Хуудас 10 секундэд нээгдсэнгүй\. Юу ч өөрчлөөгүй\./);
});

/* ---------------------------------------------------------------- */
/* Through the assistant router (database and model mocked)        */
/* ---------------------------------------------------------------- */

const asRow = (value: TravelTrip) => ({ ...value, created_at: new Date(value.created_at), updated_at: new Date(value.updated_at) });

async function harness(context: import("node:test").TestContext, reader: Array<Record<string, unknown>> = []) {
  applyTestEnv({ NEON_DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/watch", BOOKING_DATABASE_URL: undefined, AI_USAGE_ENVIRONMENT: "test" });
  const inserted: Array<{ instruction: string; proposal: AIChangeProposal }> = [];
  const events: unknown[][] = [];
  const openai: string[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    if (/SELECT[\s\S]*FROM travel_trip_entries/i.test(sql)) return { rows: [asRow(NORVEL)], rowCount: 1 };
    if (/INSERT INTO travel_ai_change_requests/i.test(sql)) {
      inserted.push({ instruction: String(params[0]), proposal: JSON.parse(String(params[1])) });
      return { rows: [{ id: String(80 + inserted.length) }], rowCount: 1 };
    }
    if (/INSERT INTO partner_watch_events/i.test(sql)) { events.push(params); return { rows: [], rowCount: 1 }; }
    if (/FROM travel_ai_usage/i.test(sql)) return { rows: [{ cost: 0 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  context.mock.method(pg.Pool.prototype, "query", query as unknown as typeof pg.Pool.prototype.query);
  context.mock.method(pg.Pool.prototype, "connect", (async () => ({ query, release() {} })) as unknown as typeof pg.Pool.prototype.connect);
  context.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("api.openai.com")) {
      openai.push(url);
      const proposal = { summary: "Хуудсыг уншлаа.", needs_confirmation: true, important_reason: "", conflicts: [], conflict_items: [], actions: reader };
      void init;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(proposal) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  });
  const { resetEnvCacheForTests } = await import("../src/lib/env");
  resetEnvCacheForTests();
  const { resetPartnerWatchSchemaForTests } = await import("../src/lib/partnerWatch/store");
  resetPartnerWatchSchemaForTests();
  const { generateAssistantReply } = await import("../src/lib/assistantReply");
  return { generateAssistantReply, inserted, events, openai };
}

test("the router: a known link is asked about before any model runs; the tapped check proposes without one", async (context) => {
  const { generateAssistantReply, inserted, events, openai } = await harness(context);
  const script = scriptedChat([]);
  const asked = await generateAssistantReply("https://www.partner.example/tours/norvel/ энэ аяллыг нэм", { now: NOW, agentDeps: agentDeps(script.chat) });
  assert.equal(asked.kind, "ask", JSON.stringify(asked));
  if (asked.kind !== "ask") return;
  assert.equal(asked.ask.text, "Энэ холбоосын аялал аль хэдийн нэмэгдсэн: «ТУРШИЛТ – НОРВЕЛ ХОТЫН АЯЛАЛ»");
  assert.equal(script.calls, 0, "no model call for the question");

  const fetched: string[] = [];
  const checked = await generateAssistantReply(asked.ask.options[0].answer, {
    now: NOW, agentDeps: agentDeps(script.chat, { safeFetch: async (url) => { fetched.push(url); return htmlResponse(CHANGED_PAGE, url); } }),
  });
  assert.equal(checked.kind, "proposal", JSON.stringify(checked));
  if (checked.kind !== "proposal") return;
  assert.equal(checked.source, "agent");
  assert.deepEqual(fetched, [URL], "the trip's own stored page is read");
  assert.deepEqual(checked.proposal.actions.map((action) => action.action), ["set_date_state", "set_date_price"]);
  assert.equal(inserted.length, 1, "stored as a change request to review");
  assert.equal(events.length, 1, "the check is recorded");
  assert.equal(script.calls + openai.length, 0, "no model call at all");
});

test("the router: «Шинэ аялал болгон дахин нэмэх» reads the page as a new trip, which keeps the page", async (context) => {
  const reader = [{ action: "upsert", fields: { route_name: "ТУРШИЛТ – НОРВЕЛ ШИНЭ", operator_name: "UUDAM TRAVEL AGENCY", currency: "MNT", duration_text: "2 өдөр 1 шөнө",
    photo_urls: Array.from({ length: 6 }, (_, index) => `https://res.cloudinary.com/demo-cloud/image/upload/v1/norvel-${index + 1}.jpg`),
    extra: { itinerary_days: [{ day: 1, title: "Хот", description: "Хотын аялал." }, { day: 2, title: "Буцах өдөр", description: "Буцна." }] } } }];
  const { generateAssistantReply, inserted } = await harness(context, reader);
  const script = scriptedChat([
    () => [{ name: "read_web_page", args: { url: URL } }],
    () => [{ name: "read_trip_source", args: { url: URL } }],
  ]);
  const again = duplicateLinkAsk(`${URL} энэ аяллыг нэм`, [NORVEL], NOW)!.options[1].answer;
  const reply = await generateAssistantReply(again, { now: NOW, agentDeps: agentDeps(script.chat, { safeFetch: async (url) => htmlResponse(CHANGED_PAGE, url) }) });
  assert.equal(reply.kind, "proposal", JSON.stringify(reply));
  if (reply.kind !== "proposal") return;
  assert.equal(reply.source, "file");
  assert.equal(script.calls, 2, "the agent read the page");
  assert.doesNotMatch(JSON.stringify(script.inputs[0].messages), /\[шинэ аялал\]/, "the option's tag never reaches the model");
  const created = (inserted.at(-1)?.proposal.actions || []).find((action) => action.action === "upsert" && !action.trip_id);
  assert.equal(created?.fields?.extra?.source_url, URL, "the new trip keeps the page it was read from");
  assert.match(String(created?.fields?.extra?.source_checked_at), /^\d{4}-\d{2}-\d{2}T/);
});
