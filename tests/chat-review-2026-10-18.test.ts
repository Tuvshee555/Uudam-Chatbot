import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { TravelTrip } from "../src/lib/travelTypes";

// Regressions from the 2026-10-16..18 Messenger review. Invented trips only — never the
// real catalogue.

function trip(fields: Partial<TravelTrip>): TravelTrip {
  return {
    id: fields.route_name || "trip", category: "", operator_name: "Uudam", route_name: "Trip",
    duration_text: "8 өдөр 7 шөнө", adult_price: null, child_price: null, infant_price: null, currency: "MNT",
    departure_dates: [], seats_total: null, seats_left: null, has_food: null, status: "active",
    notes: "", hotel: "", source_description: "", photo_urls: [], extra: {}, created_at: "", updated_at: "",
    ...fields,
  };
}

async function lib() {
  applyTestEnv();
  return {
    paths: await import("../src/lib/travelFastPaths"),
    search: await import("../src/lib/travelFastPathsSearch"),
    dates: await import("../src/lib/travelDates"),
    verify: await import("../src/lib/tripReplyVerification"),
  };
}

// ── Sold-out answer silenced by a stale top-level price ─────────────────────────────

test("a sold-out trip's alternatives quote the real fare, and the whole answer passes the checker", async () => {
  const { paths, verify } = await lib();
  const soldOut = trip({ route_name: "ЗАНДАН – ХАРСАЙ ХОСОЛСОН АЯЛАЛ", status: "sold_out", adult_price: 1_500_000,
    departure_dates: ["2099-03-10"] });
  // The open sibling's top-level adult_price is stale; its per-date fare is the real one.
  const sibling = trip({ route_name: "ЗАНДАН ХОТЫН АЯЛАЛ – ТАЛАЙГААС НИСЛЭГТЭЙ", adult_price: 2_190_000,
    departure_dates: ["2099-03-12"],
    extra: { price_groups: [{ dates: ["2099-03-12"], date_keys: ["2099-03-12"], adult_price: 2_290_000 }] } });
  const trips = [soldOut, sibling];

  const reply = paths.buildSoldOutPrecedenceReply("Зандан-Харсай", trips);
  assert.ok(reply, "naming the sold-out trip gets the sold-out answer");
  assert.match(reply!, /2,290,000₮/, "the alternative shows its real fare");
  assert.doesNotMatch(reply!, /2,190,000₮/, "never the stale top-level price");
  const scope = trips.filter((t) => reply!.includes(t.route_name));
  assert.equal(verify.verifyTripReply({ reply: reply!, trips: scope, selection: null }), reply,
    "the checker must not turn the sold-out answer into silence");
});

// ── "the first week of <month>" is a date span, not a trip length ─────────────────────

test("a calendar-week phrase is never read as a trip length", async () => {
  const { search } = await lib();
  for (const text of ["Зандан аялал 11 сарын эхний 7 хоногт байгаа юу", "сүүлийн 7 хоногт гарах", "ирэх долоо хоногт", "11 sariin ehnii 7 honogt", "2 дахь 7 хоногт"]) {
    assert.equal(search.isCalendarWeekPhrase(text), true, text);
    assert.equal(search.queryRequestsDurationDays(text), null, text);
  }
  // A real length request still is one.
  assert.deepEqual(search.queryRequestsDurationDays("7 хоногийн аялал"), [7, 7]);
  assert.deepEqual(search.queryRequestsDurationDays("5-6 хоногт боломж байдаг уу"), [5, 6]);
  assert.equal(search.isCalendarWeekPhrase("7 хоногийн аялал"), false);
});

// ── "from <date> to <date>" ranges ──────────────────────────────────────────────────

test("'M/D-ээс M/D' is a range, not the second date alone", async () => {
  const { paths, dates } = await lib();
  // Built from today: the range is read against the real calendar.
  const now = new Date();
  const at = (days: number) => new Date(now.getTime() + days * 86_400_000);
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const md = (d: Date) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  const [from, inA, inB, to, outside] = [at(20), at(22), at(25), at(25), at(40)];
  const early = trip({ route_name: "ЗАНДАН ХОТЫН АЯЛАЛ", adult_price: 1_000_000, departure_dates: [ymd(inA)] });
  const late = trip({ route_name: "ХАРСАЙ ДАЛАЙН АЯЛАЛ", adult_price: 1_200_000, departure_dates: [ymd(inB)] });
  const after = trip({ route_name: "ТАЛАЙ УУЛЫН АЯЛАЛ", adult_price: 900_000, departure_dates: [ymd(outside)] });
  const trips = [early, late, after];
  const text = `${md(from)}-ээс ${md(to)} аялал`;
  assert.equal(dates.requestsDateWindow(text), true, text);
  const reply = paths.buildDateQuestionReply(text, text, trips) || "";
  assert.match(reply, /ЗАНДАН ХОТЫН АЯЛАЛ/, `${text}: a departure inside the range is listed`);
  assert.match(reply, /ХАРСАЙ ДАЛАЙН АЯЛАЛ/, `${text}: the range's last day is inside it`);
  assert.doesNotMatch(reply, /ТАЛАЙ УУЛЫН АЯЛАЛ/, `${text}: a later departure is outside`);
  assert.equal(dates.requestsDateWindow(`${md(to)}-нд аялал байна уу`), false, "a single date is not a window");
});

// ── The ad's pre-filled message ─────────────────────────────────────────────────────

test("Messenger's ad pre-fill names no trip and is a generic information request", async () => {
  const { search } = await lib();
  for (const text of ["Can you tell me more about your ad?", "Hello! Can I get more info on this?", "Is this still available?", "I'm interested in this.", "Tell me more"]) {
    assert.equal(search.isAdPrefillMessage(text), true, text);
    assert.equal(search.isGenericTripRequest(text), true, text);
  }
  for (const text of ["Can you tell me more about the Zandan trip price?", "Зандан аялал"]) {
    assert.equal(search.isAdPrefillMessage(text), false, text);
  }
});
