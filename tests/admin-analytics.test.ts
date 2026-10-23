import assert from "node:assert/strict";
import test from "node:test";
import type { NextApiRequest, NextApiResponse } from "next";
import { analyticsWindow, collectAdminAnalytics, type AnalyticsQuery, type WebsiteDetailsReader } from "../src/lib/adminAnalytics";
import { applyTestEnv } from "./helpers/env";

const now = new Date("2098-01-01T17:00:00.000Z");
const noWebsite: WebsiteDetailsReader = async (trips) => trips;
const FAST_PATH = "Бот мэдээлэлгүй fast-path хариуг зөвлөхөд шилжүүлж, хэрэглэгчид хариу илгээсэнгүй: ";

// Newest first, as the overview reads them: one hand-off of each kind the bot records.
const SILENCES = [
  { context: `${FAST_PATH}answer_plan [booking_terms.visa]`, message: "Вэлмор аялалд виз хэрэгтэй юу? example@example.invalid" },
  { context: `${FAST_PATH}bare_number_without_context`, message: "1" },
  { context: "AI түр саатсан тул зөвлөхөд шилжүүлэв.", message: "Вэлмор аяллын хөтөлбөр" },
  { context: "", message: "Хүнтэй ярьмаар байна" },
  { context: `${FAST_PATH}answer_plan [weather.report]`, message: "Тэнд хүйтэн үү, хэзээ очих нь дээр вэ?" },
  { context: `${FAST_PATH}structured_trip_not_found`, message: "Хоол нь үнэдээ багтсан уу?" },
  { context: "Хэрэглэгч дуут мессеж илгээсэн — бот сонсож чадахгүй тул зөвлөх сонсоод хариулна уу.", message: "[Дуут мессеж]" },
  { context: "Бот мэдээлэлгүй асуулт тул зөвлөхөд шилжүүлэв.", message: "Сайн байна уу" },
].map((row, index) => ({ ...row, created_at: new Date(Date.parse("2098-01-01T12:00:00Z") - index * 3_600_000) }));

// Two active trips: one with a full program, hotel and deposit terms; one with only a
// fare group, a departure rule and photos (its visa text lives on the website page).
const ACTIVE_TRIPS = [
  { id: "trip-velmor", adult_price: "1000", hotel: "Вэлмор зочид буудал", departure_dates: ["2098-02-01"], photo_urls: [],
    extra: { itinerary_days: [{ title: "1-р өдөр" }], included_items: ["Хоол"], booking_terms: { deposit: "Урьдчилгаа тохиролцоно" } } },
  { id: "trip-orlan", adult_price: "0", hotel: "", departure_dates: [], photo_urls: ["https://res.cloudinary.com/fixture/orlan.jpg"],
    extra: { price_groups: [{ adult_price: 500 }], departure_rule: "Сар бүр" } },
];

function fixtureQuery(fail?: "core" | "activity" | "faq" | "errors" | "overview"): AnalyticsQuery {
  return async (sql, params) => {
    if (sql.includes("/* overview:")) {
      assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER)\b|SELECT \*/i);
      if (fail === "overview") throw new Error("Fixture overview unavailable");
      if (sql.includes("overview:people_daily")) return { rows: [{ date: "2098-01-02", customers: "4", answered: "3" }] };
      if (sql.includes("overview:people")) return { rows: [{ customers: "5", previous_customers: "4", answered: "4" }] };
      if (sql.includes("overview:leads_daily")) return { rows: [{ date: "2098-01-02", handed_off: "1" }] };
      if (sql.includes("overview:leads")) return { rows: [{ handed_off: "2", phone_leads: "1", bookings: "1" }] };
      if (sql.includes("overview:silences")) {
        assert.match(sql, /kind='handoff'/);
        return { rows: SILENCES };
      }
      if (sql.includes("overview:coverage")) {
        assert.match(sql, /status='active'/);
        return { rows: ACTIVE_TRIPS };
      }
      if (sql.includes("overview:outages")) return { rows: [{ outages: "2", last_outage: "2098-01-01T09:00:00Z" }] };
      if (sql.includes("overview:trip_demand")) return { rows: [{ trip: "ВЭЛМОР АЯЛАЛ", customers: "3" }] };
      throw new Error("Unexpected overview query");
    }
    assert.match(sql, /^SELECT /);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER)\b|\btrip_name\b|SELECT \*/i);
    if (sql.includes("FROM travel_leads")) {
      if (fail === "core") throw new Error("Fixture missing database");
      if (sql.includes("AS pending_handoffs")) return { rows: [{ total: "8", new: "5", bookings: "2", contacts: "6",
        pending_handoffs: "4", oldest_handoff: "2097-12-28T03:00:00Z", new_bookings: "1" }] };
      if (sql.includes("GROUP BY lead_status,kind")) return { rows: [
        { lead_status: "new_lead", kind: "handoff", count: "4" }, { lead_status: "new_lead", kind: "booking", count: "1" },
        { lead_status: "contacted", kind: "handoff", count: "2" }, { lead_status: "booked", kind: "booking", count: "1" },
      ] };
      assert.deepEqual(params, ["2097-12-26T16:00:00.000Z", now.toISOString()]);
      return { rows: [{ date: "2098-01-02", count: "2" }] };
    }
    if (sql.includes("FROM travel_trip_entries")) return { rows: [{ total: "3", active: "2" }] };
    if (sql.includes("FROM travel_conversations")) {
      if (fail === "activity") throw new Error("Fixture activity unavailable");
      assert.match(sql, /sender_id NOT LIKE 'demo:%'/, "test bot sessions must not inflate customer activity");
      assert.deepEqual(params, ["2097-12-26T16:00:00.000Z", now.toISOString()]);
      if (sql.includes("AS conversations")) {
        assert.match(sql, /DISTINCT \(platform,sender_id\)/);
        return { rows: [{ inbound: "11", assistant: "7", conversations: "5" }] };
      }
      assert.match(sql, /AT TIME ZONE 'Asia\/Ulaanbaatar'/);
      return { rows: [{ date: "2098-01-02", inbound: "11", assistant: "7" }] };
    }
    if (sql.includes("FROM travel_messages")) {
      if (fail === "faq") throw new Error("Fixture FAQ unavailable");
      if (sql.includes("ARRAY_AGG")) return { rows: [
        { question: "Холбоо барих дугаар 😊", count: "9" }, { question: "[phone]", count: "4" }, { question: "hi", count: "3" },
        { question: "Вэлмор аялал үнэ? example@example.invalid access_token=fixture-secret", count: "3" },
      ] };
      return { rows: [{ count: "9" }] };
    }
    if (sql.includes("FROM travel_error_logs")) {
      if (fail === "errors") throw new Error("Fixture logs unavailable");
      return { rows: [
        { event: "staff_alert.no_channel_configured", level: "error", count: "2", last_seen: now },
        { event: "webhook.staff_takeover_detected", level: "warn", count: "4", last_seen: now },
        { event: "openai.request_failed", level: "error", count: "1", last_seen: now },
      ] };
    }
    throw new Error("Unexpected fixture query");
  };
}

test("overview aggregates actual schema counts and fills local calendar gaps without reading customer records", async () => {
  const result = await collectAdminAnalytics(fixtureQuery(), 7, now, noWebsite);
  assert.equal(result.stats.totalLeads, 8);
  assert.equal(result.stats.newLeads, 5);
  assert.equal(result.stats.bookingLeads, 2, "booking requests are not completed bookings");
  assert.deepEqual({ ...result.stats.leadsByStatus }, { new_lead: 5, contacted: 2, booked: 1 });
  assert.equal(result.stats.leadsByDay.length, 7);
  assert.deepEqual(result.stats.leadsByDay.at(-1), { date: "2098-01-02", count: 2 });
  assert.equal(result.activity?.activeConversations, 5);
  assert.equal(result.activity?.inboundMessages, 11);
  assert.equal(result.activity?.assistantMessages, 7);
  assert.deepEqual(result.activity?.daily[0], { date: "2097-12-27", inboundMessages: 0, assistantMessages: 0 });
  assert.equal(result.attention?.pendingHandoffs, 4);
  assert.equal(result.attention?.newBookingRequests, 1);
  assert.equal(result.attention?.errors24h, 1, "staff replying and the unused alert channel are not failures");
  assert.deepEqual(result.attention?.recentIssues.map((issue) => issue.event), ["openai.request_failed"]);
  assert.equal(result.attention?.oldestPendingHandoffAt, "2097-12-28T03:00:00.000Z");
  assert.deepEqual(result.warnings, []);
  assert.match(result.faq!.week[0].question, /Вэлмор аялал/);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|example@example/);
});

test("unavailable optional data stays explicitly unknown while healthy metrics survive", async () => {
  for (const section of ["activity", "faq", "errors"] as const) {
    const result = await collectAdminAnalytics(fixtureQuery(section), 7, now, noWebsite);
    assert.equal(result.stats.totalLeads, 8);
    assert.equal(result.warnings.length, 1);
    if (section === "errors") assert.equal(result.attention?.errors24h, null);
    else assert.equal(result[section], null);
    assert.doesNotMatch(JSON.stringify(result), /Fixture .*unavailable/);
  }
});

test("missing core records and absent configuration cannot become an all-zero success", async () => {
  await assert.rejects(collectAdminAnalytics(fixtureQuery("core"), 7, now, noWebsite));
  await assert.rejects(collectAdminAnalytics(async () => null, 7, now, noWebsite));
  await assert.rejects(collectAdminAnalytics(async () => ({ rows: [] }), 7, now, noWebsite));
});

test("period windows cross month/year boundaries at agency midnight rather than host midnight", () => {
  const before = analyticsWindow(new Date("2098-01-01T15:59:59Z"), 7);
  const after = analyticsWindow(new Date("2098-01-01T16:00:00Z"), 30);
  assert.equal(before.dates.at(-1), "2098-01-01");
  assert.equal(after.dates.at(-1), "2098-01-02");
  assert.equal(after.dates.length, 30);
  assert.equal(after.start, "2097-12-03T16:00:00.000Z");
});

function response() {
  return { statusCode: 200, body: undefined as unknown, headers: {} as Record<string, unknown>,
    status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { this.body = body; return this; },
    end() { return this; }, setHeader(name: string, value: unknown) { this.headers[name] = value; } };
}

test("analytics API protects access, rejects invalid periods and reports unavailable data honestly", async (context) => {
  applyTestEnv({ ADMIN_SECRET: "analytics-fixture-secret", NEON_DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/analytics-fixture" });
  const { Pool } = await import("pg");
  let reads = 0;
  context.mock.method(Pool.prototype, "query", async () => { reads++; throw new Error("Fixture DB failure"); });
  const { default: handler } = await import("../src/pages/api/admin/analytics");
  const request = (days?: unknown, authorized = true, method = "GET") => ({ method, headers: authorized ? { "x-admin-secret": "analytics-fixture-secret" } : {}, query: days === undefined ? {} : { days }, socket: {} }) as NextApiRequest;
  const run = async (req: NextApiRequest) => { const res = response(); await handler(req, res as unknown as NextApiResponse); return res; };
  try {
    assert.equal((await run(request(undefined, false))).statusCode, 401);
    for (const invalid of ["1", "all", ["7", "30"]]) assert.equal((await run(request(invalid))).statusCode, 400);
    assert.equal((await run(request("7", true, "POST"))).statusCode, 405);
    assert.equal(reads, 0, "invalid requests never touch customer data");
    const result = await run(request("30"));
    assert.equal(result.statusCode, 503);
    assert.equal((result.body as { ok: boolean }).ok, false);
    assert.equal(result.headers["Cache-Control"], "private, no-store");
    assert.doesNotMatch(JSON.stringify(result.body), /Fixture|postgres|fixture-secret/);
  } finally {
    const { closeNeonPool } = await import("../src/lib/neonDb");
    await closeNeonPool();
  }
});

test("the overview leads with this period's people and drops button taps from the questions", async () => {
  const result = await collectAdminAnalytics(fixtureQuery(), 7, now, noWebsite);
  const overview = result.overview!;
  assert.equal(overview.customers, 5);
  assert.equal(overview.previousCustomers, 4);
  assert.equal(overview.answeredCustomers, 4);
  assert.equal(overview.handedOff, 2);
  assert.equal(overview.phoneLeads, 1);
  assert.equal(overview.bookingRequests, 1);
  assert.deepEqual(overview.daily.at(-1), { date: "2098-01-02", customers: 4, answered: 3, handedOff: 1 });
  assert.deepEqual(overview.daily[0], { date: "2097-12-27", customers: 0, answered: 0, handedOff: 0 });
  assert.deepEqual(overview.tripDemand, [{ trip: "ВЭЛМОР АЯЛАЛ", customers: 3 }]);
  assert.equal(overview.aiOutages24h, 2);
  assert.equal(overview.lastAiOutageAt, "2098-01-01T09:00:00.000Z");
  assert.equal(result.faq!.week.length, 1, "button taps, placeholders and greetings are not questions");
  assert.match(result.faq!.week[0].question, /Вэлмор аялал/);
  const degraded = await collectAdminAnalytics(fixtureQuery("overview"), 7, now, noWebsite);
  assert.equal(degraded.overview, null);
  assert.equal(degraded.warnings.length, 1);
});

test("the overview says why the bot stayed silent and lists the questions it could not answer", async () => {
  const overview = (await collectAdminAnalytics(fixtureQuery(), 7, now, noWebsite)).overview!;
  assert.deepEqual(overview.silenceReasons, [
    { reason: "no_data", count: 3 }, { reason: "unclear_trip", count: 1 }, { reason: "ai_outage", count: 1 },
    { reason: "asked_person", count: 1 }, { reason: "not_found", count: 1 }, { reason: "media", count: 1 },
  ]);
  // A bare number and a greeting are not questions; outages, media and requests for a person
  // are not questions the trip data failed to answer.
  assert.deepEqual(overview.unanswered.map(({ question, reason, topic }) => ({ question, reason, topic })), [
    { question: "Вэлмор аялалд виз хэрэгтэй юу? [email]", reason: "no_data", topic: "documents" },
    // The bot recorded a weather fact as missing: its words ("хэзээ") do not make it a dates question.
    { question: "Тэнд хүйтэн үү, хэзээ очих нь дээр вэ?", reason: "no_data", topic: null },
    { question: "Хоол нь үнэдээ багтсан уу?", reason: "not_found", topic: "includes" },
  ]);
  assert.equal(overview.unanswered[0].at, "2098-01-01T12:00:00.000Z");
  assert.doesNotMatch(JSON.stringify(overview), /example@example/);
});

test("coverage counts the topics each active trip can answer, website page included", async () => {
  const fromStore = (await collectAdminAnalytics(fixtureQuery(), 7, now, noWebsite)).overview!;
  const byTopic = (overview: typeof fromStore) => Object.fromEntries(overview.coverage.map(({ topic, trips, asked }) => [topic, [trips, asked]]));
  assert.equal(fromStore.activeTrips, 2);
  assert.deepEqual(byTopic(fromStore), {
    price: [2, 0], dates: [2, 0], program: [1, 0], hotel: [1, 0], includes: [1, 1], documents: [0, 1], terms: [1, 0], photos: [1, 0],
  });
  const seen: string[] = [];
  const withWebsite = (await collectAdminAnalytics(fixtureQuery(), 7, now, async (trips) => trips.map((trip) => {
    seen.push(trip.id);
    return trip.id === "trip-orlan" ? { ...trip, extra: { ...trip.extra, website_details: { requirements: "Гадаад паспорт" } } } : trip;
  }))).overview!;
  assert.deepEqual(seen, ["trip-velmor", "trip-orlan"]);
  assert.deepEqual(byTopic(withWebsite).documents, [1, 1], "the website page's requirements answer document questions");
});
