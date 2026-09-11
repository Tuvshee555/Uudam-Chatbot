import test from "node:test";
import assert from "node:assert/strict";
import { expandRecurringWeekday, recurringWeekdayIndex } from "../src/lib/connectedTripMapping";
import { parseTripCalendar } from "../src/components/admin/TripCalendarTab";
import type { TravelTrip } from "../src/lib/travelTypes";

const trip: TravelTrip = { id:"fixture",route_name:"Trip",operator_name:"Uudam",category:"",duration_text:"3 өдөр 2 шөнө",
  adult_price:1230000,child_price:990000,infant_price:null,currency:"MNT",departure_dates:[],seats_total:null,seats_left:null,
  has_food:null,status:"active",notes:"",hotel:"",source_description:"",photo_urls:[],extra:{},created_at:"",updated_at:"" };

test("recurringWeekdayIndex recognises every real catalog phrasing", () => {
  assert.equal(recurringWeekdayIndex("Пүрэв гараг бүр"), 4);
  assert.equal(recurringWeekdayIndex("Ням гараг бүр"), 0);
  assert.equal(recurringWeekdayIndex("Баасан гараг бүр"), 5);
});

test("recurringWeekdayIndex rejects a specific calendar date and free text", () => {
  assert.equal(recurringWeekdayIndex("7 сарын 6"), -1);
  assert.equal(recurringWeekdayIndex("Хугацаа тодорхойгүй"), -1);
  assert.equal(recurringWeekdayIndex(""), -1);
});

test("expandRecurringWeekday returns 12 upcoming occurrences starting today or later", () => {
  const dates = expandRecurringWeekday("Пүрэв гараг бүр", new Date("2026-09-09T23:00:00Z"));
  assert.equal(dates.length, 12);
  assert.equal(dates[0], "2026-09-10");
  assert.equal(dates[1], "2026-09-17");
});

test("expandRecurringWeekday returns nothing for a non-recurring text", () => {
  assert.deepEqual(expandRecurringWeekday("Хугацаа тодорхойгүй"), []);
});

test("parseTripCalendar puts a recurring-weekday trip on the grid, not just the sidebar list", () => {
  // Regression: "Пүрэв гараг бүр" used to fail every date pattern and fall
  // straight into `rules` (the admin's "check this" sidebar), so a real
  // weekly trip never showed up on the calendar grid at all.
  const result = parseTripCalendar({ ...trip, departure_dates: ["Пүрэв гараг бүр"] });
  assert.equal(result.rules.length, 0);
  assert.ok(result.days.length > 0, "expected at least one expanded calendar day");
  for (const day of result.days) {
    assert.ok(day.month >= 1 && day.month <= 12);
    assert.ok(day.day >= 1 && day.day <= 31);
  }
});

test("parseTripCalendar still falls back to the sidebar for genuinely unparseable text", () => {
  const result = parseTripCalendar({ ...trip, departure_dates: ["Хугацаа тодорхойгүй"] });
  assert.equal(result.days.length, 0);
  assert.equal(result.rules.length, 1);
});

test("parseTripCalendar still parses an explicit Mongolian date range", () => {
  const result = parseTripCalendar({ ...trip, departure_dates: ["7 сарын 6, 7 сарын 13"] });
  assert.equal(result.rules.length, 0);
  assert.deepEqual(result.days.map((d) => d.day).sort((a, b) => a - b), [6, 13]);
  assert.ok(result.days.every((d) => d.month === 7));
});
