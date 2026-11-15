import test from "node:test";
import assert from "node:assert/strict";
import { applyTestEnv } from "./helpers/env";
import type { TravelTrip } from "../src/lib/travelTypes";

applyTestEnv();

// Invented trip sold on request until a deadline whose year is in its own name.
const trip = (fields: Partial<TravelTrip> = {}): TravelTrip => ({
  id: "t", route_name: "НОРВЕЛ - ХАМТ ОЛНЫ ЗАХИАЛГА - 2099-03-15-с өмнөх өдрүүдэд", operator_name: "", category: "", duration_text: "5 өдөр",
  adult_price: 2_000_000, child_price: 1_500_000, infant_price: null, currency: "MNT", departure_dates: ["3/15-аас өмнөх өдрүүдэд хамт олны захиалгаар"],
  seats_total: null, seats_left: null, has_food: null, status: "active", notes: "", hotel: "", source_description: "", photo_urls: [],
  created_at: "", updated_at: "", extra: {}, ...fields,
}) as TravelTrip;

test("a trip sold on request until a deadline stays live before it and closes itself after it, for good", async () => {
  const { requestWindowEnd, sanitizeTripScheduleForCurrentDate } = await import("../src/lib/tripScheduleMaintenance");
  assert.equal(requestWindowEnd(trip()), "2099-03-15");
  const before = sanitizeTripScheduleForCurrentDate(trip(), new Date("2099-03-15T04:00:00Z"));
  assert.equal(before.trip.status, "active");
  const after = sanitizeTripScheduleForCurrentDate(trip(), new Date("2099-03-16T04:00:00Z"));
  assert.equal(after.trip.status, "archived");
  assert.equal(after.trip.extra.archived_reason, "request_window_passed");
  // Read again later: it does not reopen by itself (the text is still there).
  assert.equal(sanitizeTripScheduleForCurrentDate(after.trip, new Date("2099-04-01T04:00:00Z")).trip.status, "archived");
});

test("a yearless deadline, or a trip with real dates, is never guessed", async () => {
  const { requestWindowEnd } = await import("../src/lib/tripScheduleMaintenance");
  assert.equal(requestWindowEnd(trip({ route_name: "НОРВЕЛ - ХАМТ ОЛНЫ ЗАХИАЛГА" })), null);
  assert.equal(requestWindowEnd(trip({ departure_dates: ["2099-03-01", "3/15-аас өмнөх өдрүүдэд"] })), null);
});
