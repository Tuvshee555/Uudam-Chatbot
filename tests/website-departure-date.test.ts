import assert from "node:assert/strict";
import test from "node:test";
import { websiteDepartureDateKey } from "../src/lib/websiteDepartureDate";
import { WebsiteTripPayloadError, websiteTripPatch, websiteTripToCanonicalFields } from "../src/lib/websiteTripBridge";
import { applyTestEnv } from "./helpers/env";

test("SQL and serialized website timestamps share the website's business day", () => {
  for (const timestamp of ["2098-03-16T16:00:00", "2098-03-16T16:00:00.000", "2098-03-16 16:00:00",
    "2098-03-16T16:00:00.000Z", "2098-03-17T00:00:00+08:00", new Date("2098-03-16T16:00:00Z")]) {
    assert.equal(websiteDepartureDateKey(timestamp), "2098-03-17");
  }
  assert.equal(websiteDepartureDateKey("2098-03-17"), "2098-03-17", "a date-only value already names the business day");
  assert.equal(websiteDepartureDateKey("2098-03-16T15:59:59.999Z"), "2098-03-16");
  assert.equal(websiteDepartureDateKey("2098-12-31T16:00:00Z"), "2099-01-01");
});

test("invalid dates and timestamps are rejected without normalization into another day", () => {
  for (const value of ["2098-02-30", "2098-02-30T16:00:00Z", "2098-03-16T24:00:00Z", "2098-03-16T16:60:00Z",
    "2098-03-16T16:00:60Z", "2098-03-16suffix", "2098-03-16T16:00:00+99:00", null, 123, new Date(NaN)]) {
    assert.equal(websiteDepartureDateKey(value), "", String(value));
  }
});

const departure = { id: "velmor-current", startDate: "2098-03-16T16:00:00.000Z", status: "OPEN", seatsLeft: 9, price: 1_234_567 };
const website = (departures: unknown[]) => ({ sourceTripId: "velmor-trip", title: "Вэлмор аялал", currency: "MNT", departures });

test("the bridge maps database JSON and API JSON to identical dates, fares and availability", () => {
  const sqlJson = website([{ ...departure, startDate: "2098-03-16T16:00:00" }]);
  const apiJson = JSON.parse(JSON.stringify(website([{ ...departure, startDate: new Date(departure.startDate) }])));
  const sqlFields = websiteTripToCanonicalFields(sqlJson).fields;
  assert.deepEqual(sqlFields, websiteTripToCanonicalFields(apiJson).fields);
  assert.deepEqual(sqlFields.departure_dates, ["2098-03-17"]);
  assert.deepEqual(sqlFields.extra?.website_departure_availability, [{ date: "2098-03-17", status: "OPEN", seatsLeft: 9 }]);
  assert.deepEqual(sqlFields.extra?.price_groups, [{ dates: ["2098-03-17"], adult_price: departure.price, child_price: null, infant_price: null }]);
});

test("identical retained historical departures collapse without changing their source rows", () => {
  const old = { ...departure, id: "velmor-history-a", status: "CANCELLED" };
  const history = [old, { ...old, id: "velmor-history-b" }];
  const input = website(history);
  const before = structuredClone(input);
  const { fields } = websiteTripToCanonicalFields(input);
  assert.deepEqual(fields.departure_dates, ["2098-03-17"]);
  assert.deepEqual(fields.extra?.website_departure_availability, [{ date: "2098-03-17", status: "CANCELLED", seatsLeft: 9 }]);
  assert.equal((fields.extra?.price_groups as unknown[]).length, 1);
  assert.deepEqual(input, before);
  const current = { id: input.sourceTripId, ...fields };
  assert.deepEqual(websiteTripPatch({ sourceTripId: input.sourceTripId, description: "Шинэ тайлбар" }, input, current), { notes: "Шинэ тайлбар" });
});

test("one current departure wins over retained cancelled history for the same business day", () => {
  const input = website([{ ...departure, id: "velmor-history", status: "CANCELLED", seatsLeft: 0, price: 1_111_111 }, departure]);
  const { fields } = websiteTripToCanonicalFields(input);
  assert.deepEqual(fields.extra?.website_departure_availability, [{ date: "2098-03-17", status: "OPEN", seatsLeft: 9 }]);
  assert.equal((fields.extra?.price_groups as Array<{ adult_price: number }>)[0].adult_price, departure.price);
});

test("competing current departures and conflicting historical facts remain explicit errors", () => {
  for (const departures of [[departure, { ...departure, id: "velmor-other" }],
    [{ ...departure, status: "CANCELLED" }, { ...departure, status: "CANCELLED", price: 1_876_543 }]]) {
    assert.throws(() => websiteTripToCanonicalFields(website(departures)), WebsiteTripPayloadError);
  }
});

test("website availability reads preserve the business day on a server in another timezone", async (context) => {
  applyTestEnv({ BOOKING_DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/website-day-fixture" });
  const previousTimezone = process.env.TZ;
  process.env.TZ = "Etc/GMT-12";
  const { Pool, types } = await import("pg");
  const sqlTimestamp = "2098-03-16 16:00:00";
  const query = async (sql: string) => {
    if (/JOIN "Departure"/.test(sql)) {
      const startDate = sql.includes('"startDate"::text') ? sqlTimestamp : types.getTypeParser(1114)(sqlTimestamp);
      return { rows: [{ sourceTripId: "velmor-trip", startDate, status: "OPEN", seatsLeft: 9 }], rowCount: 1 };
    }
    return { rows: [{ sourceTripId: "velmor-trip", slug: "velmor", isPublished: true, sourceMetadata: {} }], rowCount: 1 };
  };
  context.mock.method(Pool.prototype, "query", query as unknown as typeof Pool.prototype.query);
  const sync = await import("../src/lib/websiteTripSync");
  try {
    const source = { id: "velmor-trip", extra: {} } as Parameters<typeof sync.withWebsiteDepartureAvailability>[0][number];
    const [trip] = await sync.withWebsiteDepartureAvailability([source]);
    assert.deepEqual(trip.extra.website_departure_availability, [{ date: "2098-03-17", status: "OPEN", seatsLeft: 9 }]);
  } finally {
    await sync.closeBookingPool();
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});
