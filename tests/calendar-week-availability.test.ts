import assert from "node:assert/strict";
import test from "node:test";
import { buildDepartureDateAvailabilityReply, hasDepartureDateAvailabilityIntent, requestsDateWindow, resolveRequestedDate } from "../src/lib/travelDates";
import { isReferReply } from "../src/lib/reply";
import { isCalendarWeekPhrase, queryRequestsDurationDays } from "../src/lib/travelFastPathsSearch";
import type { TravelTrip } from "../src/lib/travelTypes";

const now = new Date("2098-02-01T04:00:00.000Z");

function trip(day: number): TravelTrip {
  return {
    id: `velmor-${day}`, route_name: `Вэлмор ${day} аялал`, category: "", operator_name: "", duration_text: "8 өдөр",
    adult_price: null, child_price: null, infant_price: null, currency: "MNT", departure_dates: [`2098-03-${String(day).padStart(2, "0")}`],
    seats_total: null, seats_left: null, has_food: null, status: "active", notes: "", hotel: "", source_description: "",
    photo_urls: [], extra: {}, created_at: "", updated_at: "",
  };
}

function reply(text: string): string {
  return buildDepartureDateAvailabilityReply({ userText: text, now, trips: [1, 7, 8, 10, 14, 15, 25, 31].map(trip) }) || "";
}

test("the first calendar week includes days one through seven only", () => {
  const answer = reply("3 сарын эхний 7 хоногт гарах аялал байна уу");
  assert.match(answer, /3 сарын 1–7/);
  assert.match(answer, /Вэлмор 1 аялал/);
  assert.match(answer, /Вэлмор 7 аялал/);
  assert.doesNotMatch(answer, /Вэлмор (?:8|10|14|15|25|31) аялал/);
});

test("a date follow-up asking for the first two weeks keeps the full fourteen-day window", () => {
  const text = "3 сарын эхний 2 долоо хоногт сонирхож байна";
  assert.equal(hasDepartureDateAvailabilityIntent(text, now), true);
  assert.equal(isCalendarWeekPhrase(text), true);
  assert.equal(queryRequestsDurationDays(text), null);
  const answer = reply(text);
  assert.match(answer, /3 сарын 1–14/);
  assert.match(answer, /Вэлмор 14 аялал/);
  assert.doesNotMatch(answer, /Вэлмор (?:15|25|31) аялал/);
});

test("ordinal and last weeks stay within their calendar boundaries", () => {
  assert.equal(resolveRequestedDate("3 сарын 2 дахь долоо хоногт", now), null);
  const second = reply("3 сарын 2 дахь долоо хоногт аялал байна уу");
  assert.match(second, /3 сарын 8–14/);
  assert.match(second, /Вэлмор 8 аялал/);
  assert.doesNotMatch(second, /Вэлмор (?:1|7|15|25|31) аялал/);
  const last = reply("3 сарын сүүлийн долоо хоногт гарах аялал байна уу");
  assert.match(last, /3 сарын 25–31/);
  assert.match(last, /Вэлмор 31 аялал/);
  assert.doesNotMatch(last, /Вэлмор (?:1|7|8|10|14|15) аялал/);
});

test("romanized calendar-week requests keep the same boundaries", () => {
  const answer = reply("3 sariin ehnii 2 doloo honogt aylal baina uu");
  assert.match(answer, /3 сарын 1–14/);
  assert.match(answer, /Вэлмор 14 аялал/);
  assert.doesNotMatch(answer, /Вэлмор 15 аялал/);
  assert.deepEqual(queryRequestsDurationDays("7 хоногийн аялал"), [7, 7]);
});

test("calendar-week preferences do not consume price questions or invent missing departures", () => {
  assert.equal(hasDepartureDateAvailabilityIntent("3 сарын эхний 2 долоо хоногт үнэ хэд вэ", now), false);
  assert.equal(hasDepartureDateAvailabilityIntent("3 сарын эхний 7 хоног эсвэл 4 сарын эхний 7 хоногт үнэ хэд вэ", now), false);
  assert.equal(buildDepartureDateAvailabilityReply({ userText: "3 сарын эхний 7 хоногт аялал байна уу", now, trips: [] }), "REFER");
});

test("last-week bounds follow the actual month length and explicit year", () => {
  const trips = [21, 22, 29].map((day) => ({ ...trip(day), departure_dates: [`2096-02-${day}`] }));
  const answer = buildDepartureDateAvailabilityReply({
    userText: "2096 оны 2 сарын сүүлийн 7 хоногт аялал байна уу", now: new Date("2096-01-01T04:00:00.000Z"), trips,
  }) || "";
  assert.match(answer, /2 сарын 23–29/);
  assert.match(answer, /Вэлмор 29 аялал/);
  assert.doesNotMatch(answer, /Вэлмор (?:21|22) аялал/);
});

test("negated and compound week preferences hand off instead of answering an incomplete window", () => {
  for (const text of [
    "3 сарын эхний 7 хоногт биш 3 сарын сүүлийн 7 хоногт аялал байна уу",
    "3 сарын эхний 7 хоног эсвэл 4 сарын эхний 7 хоногт аялал байна уу",
    "3 сарын эхний 7 хоног эсвэл сүүлийн 7 хоногт аялал байна уу",
    "3 сарын эхний 7 хоногт биш",
    "3 сарын эхний 7 хоногт явахгүй",
    "3 сарын эхний 7 хоногоос бусад үед аялал байна уу",
    "3 sariin ehnii 7 honogt bish suuliin 7 honogt aylal baina uu",
    "3 сарын эхний 7 хоног эсвэл 4 сарын сүүлээр аялал байна уу",
    "3 сарын эхний 7 хоног эсвэл 4/15-нд аялал байна уу",
    "3 сарын эхний 7 хоногт 5-наас хойш аялал байна уу",
    "3 сарын эхний 5 долоо хоногт аялал байна уу",
    "3 сарын 0 дахь долоо хоногт аялал байна уу",
  ]) {
    assert.equal(hasDepartureDateAvailabilityIntent(text, now), true, text);
    assert.equal(requestsDateWindow(text, now), true, text);
    const answer = reply(text);
    assert.equal(answer, "REFER", text);
    assert.equal(isReferReply(answer), true, "the delivery boundary must create a silent staff handoff");
  }
});
