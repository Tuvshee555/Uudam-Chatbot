import assert from "node:assert/strict";
import test from "node:test";
import { websiteTripPatchReport, websiteTripToCanonicalFields } from "../src/lib/websiteTripBridge";

// Shape of several live records (2026-11-04): the chatbot keeps its dates as Mongolian
// text ("10 сарын 8"), the website keeps calendar days, and a day added on the website
// never reached the bot. Invented trip.
const ID = "orvel-schedule";
const row = (date: string, price = 4_690_000) => ({ startDate: `${date}T00:00:00.000Z`, status: "OPEN", seatsLeft: 9, price, childPrice: null, infantPrice: null });
const text = (day: string) => `${Number(day.slice(5, 7))} сарын ${Number(day.slice(8))}`;
const DAYS = ["2098-10-08", "2098-10-17", "2098-11-07", "2098-11-21"];

function setup(options: { text?: boolean; resolved?: boolean } = {}) {
  const previous = {
    sourceTripId: ID, title: "Орвел - Сэлвэн аялал", currency: "MNT", price: 4_690_000, childPrice: null, infantPrice: null,
    durationDays: 8, durationNights: 7, departures: DAYS.map((day) => row(day)), sourceMetadata: {} as Record<string, unknown>,
  };
  const spelt = options.text === false ? DAYS : DAYS.map(text);
  const canonical = {
    id: ID, status: "active", ...websiteTripToCanonicalFields(previous).fields,
    departure_dates: spelt,
    extra: { ...(options.resolved === false ? {} : { departure_dates_resolved: DAYS.map((day, index) => ({ text: spelt[index], ymd: day })) }) },
  };
  return { previous, canonical };
}

test("the same schedule spelt as text on the chatbot and as days on the website is not a change", () => {
  const { previous, canonical } = setup();
  const report = websiteTripPatchReport({ ...previous, departures: [...previous.departures].reverse() }, previous, canonical, ["departures"]);
  assert.equal(report.fields.departure_dates, undefined);
  assert.deepEqual(report.conflicts, []);
  assert.deepEqual(report.ignored, []);
});

test("a departure added on the website reaches the chatbot's schedule, keeping its wording for the others", () => {
  const { previous, canonical } = setup();
  const added = { ...previous, departures: [...previous.departures, row("2098-12-26", 4_890_000)] };
  const report = websiteTripPatchReport(added, previous, canonical, ["departures"]);
  assert.deepEqual(report.fields.departure_dates, [...DAYS.map(text), "2098-12-26"]);
  assert.deepEqual(report.conflicts, []);
  assert.deepEqual(report.ignored, []);
});

test("a departure removed on the website leaves the chatbot's schedule too", () => {
  const { previous, canonical } = setup();
  const removed = { ...previous, departures: previous.departures.filter((dep) => !dep.startDate.startsWith("2098-10-17")) };
  const report = websiteTripPatchReport(removed, previous, canonical, ["departures"]);
  assert.deepEqual(report.fields.departure_dates, ["10 сарын 8", "11 сарын 7", "11 сарын 21"]);
  assert.deepEqual(report.conflicts, []);
});

test("without a stored resolution the text is still read as days", () => {
  const { previous, canonical } = setup({ resolved: false });
  // Explicit years, so the reading cannot depend on today's date.
  const spelt = DAYS.map((day) => `${day.slice(0, 4)} оны ${text(day)}`);
  const current = { ...canonical, departure_dates: spelt };
  const added = { ...previous, departures: [...previous.departures, row("2098-12-26")] };
  const report = websiteTripPatchReport(added, previous, current, ["departures"]);
  assert.deepEqual(report.fields.departure_dates, [...spelt, "2098-12-26"]);
});

test("a weekly rule ('Пүрэв гараг бүр') is the chatbot's to keep: no conflict, and the website is told", () => {
  const { previous, canonical } = setup();
  const ruled = { ...canonical, departure_dates: ["Пүрэв гараг бүр"], extra: { departure_dates_resolved: [{ text: "Пүрэв гараг бүр", ymd: null }] } };
  const added = { ...previous, departures: [...previous.departures, row("2098-12-26")] };
  const report = websiteTripPatchReport(added, previous, ruled, ["departures"]);
  assert.equal(report.fields.departure_dates, undefined);
  assert.deepEqual(report.conflicts, []);
  assert.deepEqual(report.ignored, [{ field: "departures", reason: "recurring_schedule" }]);
});

test("a day both sides changed differently is still a visible conflict, stated in days", () => {
  const { previous, canonical } = setup();
  const chatbotChanged = { ...canonical, departure_dates: [...DAYS.map(text), "12 сарын 19"],
    extra: { departure_dates_resolved: [...DAYS.map((day) => ({ text: text(day), ymd: day })), { text: "12 сарын 19", ymd: "2098-12-19" }] } };
  const websiteChanged = { ...previous, departures: [...previous.departures, row("2098-12-26")] };
  const report = websiteTripPatchReport(websiteChanged, previous, chatbotChanged, ["departures"]);
  assert.equal(report.fields.departure_dates, undefined);
  assert.equal(report.conflicts.length, 1);
  assert.equal(report.conflicts[0].field, "departure_dates");
  assert.deepEqual(report.conflicts[0].chatbot, [...DAYS, "2098-12-19"]);
  assert.deepEqual(report.conflicts[0].website, [...DAYS, "2098-12-26"]);
});

test("a past day the chatbot already dropped does not count as a website change", () => {
  const { previous, canonical } = setup();
  const pruned = { ...canonical, departure_dates: DAYS.slice(1).map(text), extra: { departure_dates_resolved: DAYS.slice(1).map((day) => ({ text: text(day), ymd: day })) } };
  const past = { ...previous, departures: [row("2020-01-05"), ...previous.departures.slice(1)] };
  const report = websiteTripPatchReport(past, { ...previous, departures: [row("2020-01-05"), ...previous.departures.slice(1)] }, pruned, ["departures"]);
  assert.equal(report.fields.departure_dates, undefined);
  assert.deepEqual(report.conflicts, []);
});

// The fare table: a save that changes no fare must not become a conflict.
const bands = (child: number) => [{ label: "Хүүхэд", age_range: "2-11 нас", price: child, currency: "MNT" }];
const chatbotGroup = (date: string, adult: number, child: number) => ({ dates: [date], label: date, adult_price: adult, child_price: child, passenger_prices: bands(child) });
const websiteGroup = (index: number, date: string, adult: number, child: number) => ({ ...chatbotGroup(date, adult, child), id: `${ID}:price_group:${index}`, currency: "MNT", availability: "OPEN" });

function faresSetup() {
  const departures = [row("2098-10-08", 1_734_000), row("2098-10-17", 1_734_000)];
  const previous = {
    sourceTripId: ID, title: "Орвел - Сэлвэн аялал", currency: "MNT", price: 1_734_000, childPrice: 1_434_000, infantPrice: null,
    durationDays: 6, durationNights: 5, departures,
    sourceMetadata: { price_groups: [websiteGroup(1, "2098-10-08", 1_734_000, 1_434_000), websiteGroup(2, "2098-10-17", 1_734_000, 1_434_000)] },
  };
  const canonical = { id: ID, status: "active", ...websiteTripToCanonicalFields(previous).fields,
    extra: { price_groups: [chatbotGroup("2098-10-08", 1_734_000, 1_434_000), chatbotGroup("2098-10-17", 1_734_000, 1_434_000)],
      shared_conflicts: [{ field: "extra.price_groups", chatbot: [], website: [], base: null, at: "2098-01-01T00:00:00.000Z" }] } };
  return { previous, canonical };
}

test("renaming a passenger band or reordering the fare table changes no fare: no conflict, nothing ignored, even beside an old open conflict", () => {
  const { previous, canonical } = faresSetup();
  const relabelled = { ...previous, sourceMetadata: { price_groups: [
    { ...websiteGroup(2, "2098-10-17", 1_734_000, 1_434_000), passenger_prices: [{ label: "Хүүхэд 2-11 нас", age_range: "2-11 нас", price: 1_434_000, currency: "MNT" }] },
    websiteGroup(1, "2098-10-08", 1_734_000, 1_434_000),
  ] } };
  const report = websiteTripPatchReport(relabelled, previous, canonical, ["sourceMetadata.price_groups"]);
  assert.equal(report.fields.extra?.price_groups, undefined);
  assert.deepEqual(report.conflicts, []);
  assert.deepEqual(report.ignored, [], "a save that changed no fare is not 'not taken' and not 'blocked by an open conflict'");
});

test("a real fare edit still applies beside an unrelated old open conflict", () => {
  const { previous, canonical } = faresSetup();
  const edited = { ...previous, departures: [row("2098-10-08", 1_734_000), row("2098-10-17", 1_834_000)],
    sourceMetadata: { price_groups: [websiteGroup(1, "2098-10-08", 1_734_000, 1_434_000), websiteGroup(2, "2098-10-17", 1_834_000, 1_434_000)] } };
  const report = websiteTripPatchReport(edited, previous, canonical, ["departures", "sourceMetadata.price_groups"]);
  const groups = report.fields.extra?.price_groups as Array<Record<string, unknown>>;
  assert.equal(groups.find((group) => (group.dates as string[])[0] === "2098-10-17")?.adult_price, 1_834_000);
  assert.deepEqual(report.ignored, []);
});
