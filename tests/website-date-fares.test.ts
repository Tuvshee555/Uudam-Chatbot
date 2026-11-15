import assert from "node:assert/strict";
import test from "node:test";
import { websiteTripPatchReport, websiteTripToCanonicalFields } from "../src/lib/websiteTripBridge";

// Shape of the 2026-11-02/03 saves: a consultant changed per-date fares in the website's
// date-pricing editor and the website said "saved", but the chatbot stored each save as an
// open conflict (32 of them on two trips) because the two stores never hold identical
// price-group lists, and the next projection showed the old fare again. Invented trip.
const ID = "norvel-dates";
const bands = (child: number, infant: number) => [
  { label: "Хүүхэд", age_range: "2-11 нас", price: child, currency: "MNT" },
  { label: "Нярай", age_range: "0-23 сар", price: infant, currency: "MNT" },
];
// The chatbot's own copy: no ids, no website-only keys.
const chatbotGroup = (date: string, adult: number, child: number, infant: number) => ({
  note: "", dates: [date], label: date, child_age: "2-11 нас", infant_age: "0-23 сар",
  date_keys: [date, `${Number(date.slice(5, 7))} сарын ${Number(date.slice(8))}`],
  adult_price: adult, child_price: child, infant_price: infant, display_dates: [date], passenger_prices: bands(child, infant),
});
// The website's copy of the same group.
const websiteGroup = (index: number, date: string, adult: number, child: number, infant: number) => ({
  ...chatbotGroup(date, adult, child, infant), id: `${ID}:price_group:${index}`, currency: "MNT",
  availability: "OPEN", adult_price_range: null,
});
const row = (date: string, price: number, childPrice: number, infantPrice: number) =>
  ({ startDate: `${date}T00:00:00.000Z`, status: "OPEN", seatsLeft: 9, price, childPrice, infantPrice });

function setup() {
  const departures = [row("2098-03-17", 1_734_000, 1_434_000, 334_000), row("2098-03-24", 1_734_000, 1_434_000, 334_000)];
  const previous = {
    sourceTripId: ID, title: "НОРВЕЛ ХОТЫН АЯЛАЛ", currency: "MNT", price: 1_734_000, childPrice: 1_434_000, infantPrice: 334_000,
    durationDays: 6, durationNights: 5, departures,
    sourceMetadata: { price_groups: [
      websiteGroup(1, "2098-03-17", 1_734_000, 1_434_000, 334_000),
      websiteGroup(2, "2098-03-24", 1_734_000, 1_434_000, 334_000),
      // An entry the website kept for a date that is not a departure.
      { id: `${ID}:price_group:3`, note: "", dates: ["2099-03-17"], label: "", adult_price: 1_634_000 },
    ] },
  };
  const canonical = {
    id: ID, ...websiteTripToCanonicalFields(previous).fields,
    extra: { price_groups: [chatbotGroup("2098-03-17", 1_734_000, 1_434_000, 334_000), chatbotGroup("2098-03-24", 1_734_000, 1_434_000, 334_000)] },
  };
  return { previous, canonical };
}

function edit(previous: ReturnType<typeof setup>["previous"], date: string, adult: number, child: number, infant: number) {
  const groups = previous.sourceMetadata.price_groups.map((group, index) =>
    group.dates[0] === date ? websiteGroup(index + 1, date, adult, child, infant) : group);
  return { ...previous, departures: previous.departures.map((dep) => dep.startDate.startsWith(date) ? row(date, adult, child, infant) : dep),
    sourceMetadata: { price_groups: groups } };
}

test("a per-date fare saved on the website reaches the chatbot instead of becoming a conflict", () => {
  const { previous, canonical } = setup();
  const report = websiteTripPatchReport(edit(previous, "2098-03-24", 1_834_000, 1_534_000, 334_000), previous, canonical,
    ["departures", "sourceMetadata.price_groups"]);
  const groups = report.fields.extra?.price_groups as Array<Record<string, unknown>>;
  assert.ok(groups, "the edited fare is applied");
  const byDate = Object.fromEntries(groups.map((group) => [(group.dates as string[])[0], group]));
  assert.equal(byDate["2098-03-24"].adult_price, 1_834_000);
  assert.equal(byDate["2098-03-24"].child_price, 1_534_000);
  assert.deepEqual((byDate["2098-03-24"].passenger_prices as Array<Record<string, unknown>>).map((band) => band.price), [1_534_000, 334_000]);
  assert.equal(byDate["2098-03-17"].adult_price, 1_734_000, "the other date keeps its fare");
  assert.equal(groups.length, 2, "the website's entry for a non-departure date is not imported");
  assert.equal(report.fields.extra?.shared_conflicts, undefined, "nothing both sides changed, so no conflict");
  assert.deepEqual(report.ignored, []);
});

test("a fare the chatbot also changed for the same date stays a visible conflict", () => {
  const { previous, canonical } = setup();
  const groups = canonical.extra.price_groups.map((group) => group.dates[0] === "2098-03-24" ? chatbotGroup("2098-03-24", 1_934_000, 1_434_000, 334_000) : group);
  const report = websiteTripPatchReport(edit(previous, "2098-03-24", 1_834_000, 1_434_000, 334_000), previous,
    { ...canonical, extra: { price_groups: groups } }, ["sourceMetadata.price_groups"]);
  assert.equal(report.fields.extra?.price_groups, undefined, "the chatbot's own edit is not overwritten");
  assert.deepEqual(report.conflicts.map(({ field, chatbot, website, base }) => ({ field, chatbot, website, base })),
    [{ field: "departure.2098-03-24.price", chatbot: 1_934_000, website: 1_834_000, base: 1_734_000 }]);
});

test("a departure added on the website with its fare becomes a per-date fare", () => {
  const { previous, canonical } = setup();
  const added = { ...previous, departures: [...previous.departures, row("2098-03-31", 1_884_000, 1_484_000, 334_000)],
    sourceMetadata: { price_groups: [...previous.sourceMetadata.price_groups, websiteGroup(4, "2098-03-31", 1_884_000, 1_484_000, 334_000)] } };
  const report = websiteTripPatchReport(added, previous, canonical, ["departures", "sourceMetadata.price_groups"]);
  const created = (report.fields.extra?.price_groups as Array<Record<string, unknown>>).find((group) => (group.dates as string[])[0] === "2098-03-31");
  assert.equal(created?.adult_price, 1_884_000);
  assert.equal(created?.id, undefined, "the website's group id stays on the website");
  assert.equal(report.fields.extra?.shared_conflicts, undefined);
});

test("the same save delivered twice changes nothing the second time", () => {
  const { previous, canonical } = setup();
  const incoming = edit(previous, "2098-03-24", 1_834_000, 1_534_000, 334_000);
  const first = websiteTripPatchReport(incoming, previous, canonical);
  const applied = { ...canonical, extra: { ...canonical.extra, ...first.fields.extra } };
  const again = websiteTripPatchReport(incoming, previous, applied);
  assert.equal(again.fields.extra?.price_groups, undefined);
  assert.equal(again.fields.extra?.shared_conflicts, undefined);
});
