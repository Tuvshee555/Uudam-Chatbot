import assert from "node:assert/strict";
import test from "node:test";
import { auditTripCatalog, auditTripFacts, assertValidTripDataChange, TripDataValidationError, validateTripDataChange, type TripFactInput } from "../src/lib/tripDataValidation";
import { normalizeExtra, normalizeExtraPatch } from "../src/lib/tripExtraSchema";
import { applyTestEnv } from "./helpers/env";

const NOW = new Date("2026-10-02T00:00:00Z");
const group = (adult_price: number, fields: Record<string, unknown> = {}) => ({ dates: ["2026-11-01"], hotel: "Alpha Bay", adult_price, ...fields });
const trip = (groups: Record<string, unknown>[], extra: Record<string, unknown> = {}): TripFactInput => ({ id: "trip-1", currency: "MNT", status: "active", extra: { price_groups: groups, ...extra } });
const codes = (value: TripFactInput) => auditTripFacts(value, NOW).errors.map(issue => issue.code);

test("same hotel, date and passenger with different fares is actionable", () => {
  const result = auditTripFacts(trip([group(100), group(200)]), NOW);
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, "conflicting_price_groups");
  assert.deepEqual(result.errors[0].paths, ["extra.price_groups[0].adult_price", "extra.price_groups[1].adult_price"]);
  assert.match(result.errors[0].message, /100 \/ 200 MNT/);
});

test("hotel, date, currency and passenger alternatives stay distinct", () => {
  assert.deepEqual(codes(trip([group(100), group(200, { hotel: "Beta Bay" })])), []);
  assert.deepEqual(codes(trip([group(100), group(200, { dates: ["2027-11-01"] })])), []);
  assert.deepEqual(codes(trip([group(100, { passenger_prices: [{ label: "Child", age_range: "2-6 years", price: 50, currency: "USD" }] }),
    group(100, { passenger_prices: [{ label: "Child", age_range: "2-6 years", price: 100, currency: "MNT" }] })])), []);
});

test("hotel spelling case and whitespace do not hide a conflict", () => {
  assert.ok(codes(trip([group(100), group(200, { hotel: " ALPHA   BAY " })])).includes("conflicting_price_groups"));
});

test("explicit package, hotel IDs and group currencies distinguish offers", () => {
  assert.deepEqual(codes(trip([group(100, { package_id: "standard" }), group(200, { package_id: "premium" })])), []);
  assert.deepEqual(codes(trip([group(100, { hotel_id: "a" }), group(200, { hotel_id: "b" })])), []);
  assert.deepEqual(codes(trip([group(100, { currency: "USD" }), group(200, { currency: "MNT" })])), []);
});

test("generated yearless aliases do not conflate explicit years", () => {
  assert.deepEqual(codes(trip([
    group(100, { dates: [], date_keys: ["2026-11-01", "11/1", "11 сарын 1"] }),
    group(200, { dates: [], date_keys: ["2027-11-01", "11/1", "11 сарын 1"] }),
  ])), []);
});

test("legacy yearless groups match equivalent date formats", () => {
  assert.ok(codes(trip([group(100, { dates: ["11 сарын 1"] }), group(200, { dates: ["11/01"] })])).includes("conflicting_price_groups"));
});

test("explicit group years are checked without comparing different years", () => {
  assert.deepEqual(codes(trip([group(100, { dates: ["11/1"], year: 2026 }), group(200, { dates: ["11/1"], year: 2027 })])), []);
  assert.ok(codes(trip([group(100, { dates: ["2026-11-01"], year: 2027 })])).includes("conflicting_departure_year"));
  assert.ok(codes(trip([group(100, { dates: ["11/1"], year: 9999 })])).includes("invalid_year"));
});

test("write-time frozen years keep otherwise identical month/day groups distinct", () => {
  assert.deepEqual(codes(trip([
    group(100, { dates: ["11 сарын 1"] }), group(200, { dates: ["2027-11-01"] }),
  ], { departure_dates_resolved: [{ text: "11 сарын 1", ymd: "2026-11-01" }] })), []);
});

test("top-level fares, legacy mirrors and child summaries are compatibility data", () => {
  const value = { ...trip([group(100), group(200, { dates: ["2026-11-02"] })], {
    departure_date_groups: [group(900)],
    child_rules: [{ label: "Child", age_range: "2-11 years", price: 50 }, { label: "Child", age_range: "2-11 years", price: 60 }],
  }), adult_price: 900 };
  assert.deepEqual(codes(value), []);
});

test("legacy groups are audited when no canonical groups exist", () => {
  assert.ok(codes({ extra: { departure_date_groups: [group(100), group(200)] } }).includes("conflicting_price_groups"));
});

test("passenger prices conflict by explicit age band even when labels differ", () => {
  const passengers = (price: number, label: string) => ({ passenger_prices: [{ label, age_range: "2-11 years", price }] });
  assert.ok(codes(trip([group(100, passengers(50, "Child")), group(100, passengers(60, "Children"))])).includes("conflicting_price_groups"));
});

test("scalar child and infant summaries do not duplicate explicit passenger bands", () => {
  assert.deepEqual(codes(trip([group(100, { child_price: 50, child_age: "2-11 years", infant_price: 0, infant_age: "0-23 months",
    passenger_prices: [{ label: "Child", age_range: "2-11 years", price: 50 }, { label: "Infant", age_range: "0-23 months", price: 0 }],
  })])), []);
});

test("a broad child scalar is a compatible summary of specific passenger bands", () => {
  assert.deepEqual(codes(trip([group(100, { child_price: 70, child_age: "2-11 years", infant_price: 0, infant_age: "0-23 months",
    passenger_prices: [{ label: "Younger child", age_range: "2-5 years", price: 50 }, { label: "Older child", age_range: "6-11 years", price: 70 }, { label: "Infant", age_range: "0-23 months", price: 0 }],
  }), group(100, { passenger_prices: [{ label: "Younger child", age_range: "2-5 years", price: 50 }, { label: "Older child", age_range: "6-11 years", price: 70 }] })], {
    age_rules: { child: "2-11 years" }, child_rules: [{ label: "Child summary", age_range: "2-11 years", price: 70 },
      { label: "Younger child", age_range: "2-5 years", price: 50 }, { label: "Older child", age_range: "6-11 years", price: 70 }],
  })), []);
});

test("infant 0-2 and child 2+ is a staff-review warning without guessing inclusivity", () => {
  const result = auditTripFacts({ extra: { age_rules: { infant: "0-2 years", child: "2-11 years", adult: "12+ years" } } }, NOW);
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some(issue => issue.code === "overlapping_age_categories" && /Staff must confirm/.test(issue.message)));
});

test("different age tiers and free infants remain valid", () => {
  assert.deepEqual(codes(trip([group(100, { passenger_prices: [
    { label: "Infant", age_range: "0-23 months", price: 0 }, { label: "Child", age_range: "2-6 years", price: 50 }, { label: "Older child", age_range: "7-11 years", price: 70 },
  ] })], { age_rules: { infant: "0-23 months", child: "2-11 years", adult: "12+ years" } })), []);
});

test("overlapping explicit age categories and reversed ranges fail", () => {
  assert.ok(codes({ extra: { age_rules: { infant: "0-4 years", child: "2-11 years", adult: "12+ years" } } }).includes("overlapping_age_categories"));
  assert.ok(codes({ extra: { age_rules: { child: "11-2 years" } } }).includes("invalid_age_range"));
  assert.ok(codes(trip([group(100, { passenger_prices: [{ label: "Child", age_range: "2-8 years", price: 50 }] }),
    group(100, { passenger_prices: [{ label: "Child", age_range: "7-11 years", price: 60 }] })])).includes("overlapping_age_categories"));
});

test("birth-year tiers are not guessed as ages", () => {
  assert.deepEqual(codes({ extra: { age_rules: { infant: "2024-2026 он", child: "2015-2023 он", adult: "12+ years" } } }), []);
});

test("discounts and undocumented date scope are audit warnings, not factual blockers", () => {
  const result = auditTripFacts(trip([group(100, { dates: [] }), group(200)], { discounts: [group(50)] }), NOW);
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some(issue => issue.code === "ambiguous_price_scope"));
});

test("a documented adult range and an included scalar fare stay compatible", () => {
  assert.deepEqual(codes(trip([group(100, { adult_price_range: { min: 100, max: 200 } }), group(150)])), []);
  assert.ok(codes(trip([group(100, { adult_price_range: { min: 100, max: 200 } }), group(250)])).includes("conflicting_price_groups"));
});

test("impossible dates, malformed years and frozen mismatches fail", () => {
  for (const date of ["2026-02-29", "2026-04-31", "13 сарын 1", "2 сарын 30", "2026-00-10"]) {
    assert.ok(codes({ departure_dates: [date] }).includes("invalid_date"), date);
  }
  for (const date of ["026-11-01", "9999-11-01", "20260-11-01"]) assert.ok(codes({ departure_dates: [date] }).includes("invalid_year"), date);
  assert.ok(codes({ extra: { departure_dates_resolved: [{ text: "2026-11-01", ymd: "2027-11-01" }] } }).includes("resolved_date_mismatch"));
});

test("valid leap days, multi-date lists, recurring schedules and historic dates are preserved", () => {
  const value = { departure_dates: ["2028-02-29", "2 сарын 29", "11 сарын 1, 2", "11 сарын 1-3", "Пүрэв гараг бүр", "2023-11-01"] };
  const copy = structuredClone(value);
  const result = auditTripFacts(value, NOW);
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some(issue => issue.code === "past_departure"));
  assert.deepEqual(value, copy);
});

test("seat totals, whole counts and status are validated together", () => {
  assert.ok(codes({ seats_total: 10, seats_left: 11 }).includes("seats_exceed_total"));
  for (const value of [-1, 1.5, "4", NaN]) assert.ok(codes({ seats_left: value }).includes("invalid_seat_count"));
  assert.ok(codes({ status: "available" }).includes("invalid_seat_status"));
  assert.ok(codes({ status: "sold_out", seats_left: 3 }).includes("sold_out_with_seats"));
  assert.deepEqual(codes({ status: "paused", seats_total: null, seats_left: null }), []);
  assert.deepEqual(codes({ status: "active", seats_left: 0 }), []);
});

test("website departure seat state is audited", () => {
  const result = codes({ extra: { website_departure_availability: [{ date: "2026-11-01", status: "SOLD_OUT", seatsLeft: 2 },
    { date: "2026-11-02", status: "TYPO", seatsLeft: -2 }] } });
  assert.ok(result.includes("sold_out_with_seats"));
  assert.ok(result.includes("invalid_seat_status"));
  assert.ok(result.includes("invalid_seat_count"));
});

test("reordered legacy seat states and standalone passenger prices are handled", () => {
  const values = [{ date: "2026-11-01", status: "TYPO", seatsLeft: -2 }, { date: "2026-11-02", status: "OPEN", seatsLeft: 4 }];
  assert.equal(validateTripDataChange({ extra: { website_departure_availability: [...values].reverse() } }, { extra: { website_departure_availability: values } }, NOW).valid, true);
  assert.ok(codes({ extra: { child_rules: [{ label: "Child", age_range: "2-11 years", price: 50 }, { label: "Child", age_range: "2-11 years", price: 60 }] } }).includes("conflicting_price_groups"));
});

test("unchanged legacy problems allow unrelated updates and reordered arrays", () => {
  const previous = trip([group(100), group(200)]);
  const effective = { ...previous, route_name: "New name", extra: { price_groups: [group(200), group(100)], brochure_pdf_url: "https://example.com/trip.pdf" } };
  const result = validateTripDataChange(effective, previous, NOW);
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 1);
  assert.deepEqual(result.introducedErrors, []);
});

test("changing an existing conflict or adding a new conflict is blocked", () => {
  const previous = trip([group(100), group(200)]);
  assert.equal(validateTripDataChange(trip([group(100), group(300)]), previous, NOW).valid, false);
  assert.equal(validateTripDataChange(trip([group(100), group(200), group(400)]), previous, NOW).valid, false);
  assert.equal(validateTripDataChange(trip([group(100)]), previous, NOW).valid, true);
});

test("effective merge catches a seat-only patch against the saved total", () => {
  const previous = { seats_total: 10, seats_left: 4, status: "active" };
  assert.equal(validateTripDataChange({ ...previous, seats_left: 11 }, previous, NOW).valid, false);
  assert.equal(validateTripDataChange({ ...previous, route_name: "Rename" }, previous, NOW).valid, true);
});

test("base passenger fares and legacy durations are audited while typed durations take precedence", () => {
  for (const key of ["adult_price", "child_price", "infant_price"]) {
    for (const value of [-1, 1.5, NaN, Infinity, "invalid"]) assert.ok(codes({ [key]: value }).includes("invalid_base_price"));
  }
  assert.deepEqual(codes({ adult_price: 1000000, child_price: null, infant_price: 0, duration_text: "8 days / 7 nights" }), []);
  assert.ok(codes({ duration_text: "0 days / 7 nights" }).includes("invalid_legacy_duration"));
  assert.ok(codes({ duration_text: 8 }).includes("invalid_duration_text"));
  assert.deepEqual(codes({ duration_text: "0 days", extra: { duration_days: 8 } }), []);
  const previous = { adult_price: -1, duration_text: "0 days" };
  assert.equal(validateTripDataChange({ ...previous, route_name: "New label" }, previous, NOW).valid, true);
});

test("normalized partial extra preserves typed facts and unrelated stored fields", () => {
  const typed = { destinations: ["Alpha", "Beta"], transport_type: "land_flight", duration_days: 8, duration_nights: 7 };
  assert.equal(auditTripFacts({ extra: typed }, NOW).valid, true);
  for (const normalize of [normalizeExtraPatch, (value: Record<string, unknown>) => normalizeExtra(value).extra]) {
    const result = normalize(typed);
    for (const key of Object.keys(typed)) assert.deepEqual(result[key], typed[key as keyof typeof typed]);
  }
  const previous = { extra: { ...typed, price_groups: [group(100)] } };
  const effective = { ...previous, extra: { ...previous.extra, ...normalizeExtraPatch({ duration_days: 9 }) } };
  assert.equal(validateTripDataChange(effective, previous, NOW).valid, true);
  assert.equal(effective.extra.transport_type, "land_flight");
  assert.deepEqual(effective.extra.destinations, ["Alpha", "Beta"]);
});

test("structured fields are validated by their values without guessing from names", () => {
  const valid = { route_name: "Direct flight 15 days", extra: { destinations: ["Alpha"], transport_type: "land", duration_days: 8 } };
  assert.equal(auditTripFacts(valid, NOW).valid, true);
  for (const extra of [{ duration_days: 0 }, { duration_days: "8" }, { duration_days: 2.5 }, { duration_nights: -1 },
    { duration_days: 8, duration_nights: 8 }, { transport_type: "plane" }, { destinations: "Alpha" }, { destinations: [""] }]) {
    assert.equal(auditTripFacts({ extra }, NOW).valid, false, JSON.stringify(extra));
  }
  assert.equal(auditTripFacts({ extra: { duration_days: null, transport_type: null, destinations: [] } }, NOW).valid, true);
});

test("validation errors serialize into the existing actionable API error pattern", () => {
  assert.throws(() => assertValidTripDataChange(trip([group(100), group(200)])), error => {
    assert.ok(error instanceof TripDataValidationError);
    assert.equal(error.statusCode, 422);
    assert.equal(error.toResponse().code, "trip_data_conflict");
    assert.match(error.toResponse().error, /Correct the fare/);
    assert.equal(error.toResponse().issues.length, 1);
    assert.match(error.toResponse().message, /Correct the fare/);
    return true;
  });
});

test("catalog audit exposes legacy issues without mutations", () => {
  const input = [trip([group(100), group(200)]), { id: "old", departure_dates: ["2023-11-01"] }];
  const before = structuredClone(input);
  const result = auditTripCatalog(input, NOW);
  assert.equal(result.total, 2);
  assert.equal(result.tripsWithErrors, 1);
  assert.equal(result.tripsWithWarnings, 1);
  assert.deepEqual(input, before);
});

test("DB save boundary rejects conflicts before writes and preserves unrelated legacy updates", async context => {
  applyTestEnv({ NEON_DATABASE_URL: "postgres://test:test@127.0.0.1:1/test" });
  const { Pool } = await import("pg");
  const stored = {
    id: "trip-1", route_name: "Legacy trip", currency: "MNT", status: "active", hotel: "",
    adult_price: -1, child_price: 500000, infant_price: 0, duration_text: "8 days / 7 nights",
    departure_dates: ["2023-11-01"], seats_total: 10, seats_left: 4,
    updated_at: new Date("2026-10-05T00:00:00.000Z"),
    extra: { price_groups: [group(100), group(200)], duration_days: 8, duration_nights: 7,
      transport_type: "land_flight", destinations: ["Alpha", "Beta"],
      departure_dates_resolved: [{ text: "2023-11-01", ymd: "2023-11-01" }] },
  };
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const queries: string[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    queries.push(sql);
    if (sql === "SELECT * FROM travel_trip_entries ORDER BY id") return { rows: [structuredClone(stored)], rowCount: 1 };
    if (/^SELECT (?:\*(?:, updated_at::text AS write_version)?|id) FROM travel_trip_entries WHERE id=\$1/.test(sql)) return { rows: [{ ...structuredClone(stored), write_version: "2026-10-05 00:00:00+00" }], rowCount: 1 };
    if (/^\s*(?:UPDATE|INSERT INTO) travel_trip_entries/.test(sql)) {
      writes.push({ sql, params });
      return { rows: [structuredClone(stored)], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  context.mock.method(Pool.prototype, "query", query as unknown as typeof Pool.prototype.query);
  context.mock.method(Pool.prototype, "connect", (async () => ({ query, release() {} })) as unknown as typeof Pool.prototype.connect);
  const db = await import("../src/lib/travelDb");
  const { closeNeonPool } = await import("../src/lib/neonDb");
  try {
    const unchanged = await db.patchTrip("trip-1", {}, false, undefined, stored.updated_at.toISOString());
    assert.equal(unchanged?.id, stored.id);
    assert.equal(writes.length, 0);
    await assert.rejects(db.patchTrip("trip-1", {}, false, undefined, "2026-10-04T00:00:00.000Z"), /trip_edit_conflict/);
    assert.deepEqual(db.cleanFields({ departure_dates: ["2028 оны 11 сарын 1"] }, true).departure_dates, ["2028 оны 11 сарын 1"]);
    await assert.rejects(db.patchTrip("trip-1", { seats_left: 11 }, false), TripDataValidationError);
    await assert.rejects(db.upsertTrip({ id: "trip-1", fields: { seats_left: 11 }, syncPoster: false }), TripDataValidationError);
    await assert.rejects(db.upsertTrip({ id: " trip-1 ", fields: { seats_left: 11 }, syncPoster: false }), TripDataValidationError);
    await assert.rejects(db.upsertTrip({ fields: { route_name: "Invalid", departure_dates: ["2026-02-31"] }, syncPoster: false }), TripDataValidationError);
    await assert.rejects(db.patchTrip("trip-1", { child_price: -5 }, false), TripDataValidationError);
    assert.equal(writes.length, 0);

    await db.patchTrip("trip-1", { notes: "Updated brochure text" }, false);
    assert.equal(writes.length, 1);
    assert.ok(writes[0].params.includes("Updated brochure text"));
    assert.doesNotMatch(writes[0].sql, /extra =/);

    await db.patchTrip("trip-1", { extra: { duration_days: 9 } }, false);
    const extraParam = writes[1].params.find(value => typeof value === "string" && value.startsWith("{"));
    assert.deepEqual(JSON.parse(String(extraParam)), { duration_days: 9 });
    assert.match(writes[1].sql, /COALESCE\(extra/);

    await db.patchTrip("trip-1", { departure_dates: ["2023-11-01"] }, false);
    assert.ok(writes[2].params.some(value => Array.isArray(value) && value[0] === "2023-11-01"));
    assert.doesNotMatch(writes[2].sql, /extra =/);

    const fields = { departure_dates: ["2027-11-01"], extra: { duration_days: 9 } };
    const before = structuredClone(fields);
    await db.patchTrip("trip-1", fields, false);
    assert.deepEqual(fields, before);

    const { default: handler } = await import("../src/pages/api/admin/trips");
    const request = (method: string, body: unknown = {}, secret = "test-admin-secret") => ({
      method, body, query: { action: "fact-audit" }, headers: { "x-admin-secret": secret },
      url: "/api/admin/trips?action=fact-audit", socket: { remoteAddress: "203.0.113.70" },
    }) as unknown as import("next").NextApiRequest;
    const response = () => ({ statusCode: 200, body: undefined as unknown,
      status(code: number) { this.statusCode = code; return this; },
      json(body: unknown) { this.body = body; return this; }, end() { return this; }, setHeader() {} });
    queries.length = 0;
    const unauthorized = response();
    await handler(request("GET", {}, "wrong-secret"), unauthorized as never);
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(queries.length, 0);

    const audited = response();
    await handler(request("GET"), audited as never);
    assert.equal(audited.statusCode, 200);
    assert.equal((audited.body as { factAudit: { total: number; tripsWithErrors: number } }).factAudit.total, 1);
    assert.equal((audited.body as { factAudit: { tripsWithErrors: number } }).factAudit.tripsWithErrors, 1);
    assert.deepEqual((audited.body as { factAudit: unknown }).factAudit, auditTripCatalog([stored]));
    assert.ok((audited.body as { factAudit: { results: Array<{ errors: Array<{ code: string }> }> } }).factAudit.results[0].errors.some(issue => issue.code === "invalid_base_price"));
    assert.equal(queries.length, 1);
    assert.match(queries[0], /^SELECT /);
    assert.doesNotMatch(queries[0], /CREATE|ALTER|UPDATE|INSERT|DELETE/);

    const rejected = response();
    const count = writes.length;
    await handler(request("PATCH", { id: "trip-1", fields: { seats_left: 11 }, confirmIncomplete: true }), rejected as never);
    assert.equal(rejected.statusCode, 422);
    assert.match((rejected.body as { error: string }).error, /seats_left.*exceeds/);
    assert.equal(writes.length, count);

    const { default: posterHandler } = await import("../src/pages/api/admin/poster/trips");
    const posterRejected = response();
    await posterHandler(request("POST", { title: "Conflicting poster", data: { title: "Conflicting poster",
      departures: [{ date: "2027-11-01" }], price_table: { columns: ["Том хүн"], rows: [
        { dates: "2027-11-01", cells: ["1000000"] }, { dates: "2027-11-01", cells: ["2000000"] },
      ] } } }), posterRejected as never);
    assert.equal(posterRejected.statusCode, 422);
    assert.match((posterRejected.body as { error: string }).error, /different fares/);
    assert.equal(writes.length, count);
  } finally {
    await closeNeonPool();
  }
});
