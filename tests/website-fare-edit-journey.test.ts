import assert from "node:assert/strict";
import test from "node:test";
import { conversationGateHarness, type FixtureTrip } from "./helpers/conversationGateHarness";
import { websiteTripPatchReport, websiteTripToCanonicalFields } from "../src/lib/websiteTripBridge";

// A consultant raises one departure's fare in the website's date-pricing editor. The
// website delivers the save through the bridge; the next customer who asks about that
// departure must hear the new fare, and nobody else's dates may move. Invented trip.
const DATE = "2098-03-17", OTHER = "2098-03-24";
const bands = (child: number) => [{ label: "Хүүхэд", age_range: "2-11 нас", price: child, currency: "MNT" }];
const chatbotGroup = (date: string, adult: number, child: number) => ({ dates: [date], label: date, adult_price: adult, child_price: child, child_age: "2-11 нас", passenger_prices: bands(child) });
const websiteGroup = (index: number, date: string, adult: number, child: number) => ({ ...chatbotGroup(date, adult, child), id: `norvel:price_group:${index}`, currency: "MNT", availability: "OPEN" });
const row = (date: string, price: number, childPrice: number) => ({ startDate: `${date}T00:00:00.000Z`, status: "OPEN", seatsLeft: 9, price, childPrice, infantPrice: null });

function websiteTrip(fare: number) {
  return {
    sourceTripId: "norvel-fare-journey", title: "НОРВЕЛ СЭЛВЭН АЯЛАЛ", currency: "MNT", price: 1_734_000, childPrice: 1_434_000, infantPrice: null,
    durationDays: 6, durationNights: 5, departures: [row(DATE, fare, 1_434_000), row(OTHER, 1_734_000, 1_434_000)],
    sourceMetadata: { price_groups: [websiteGroup(1, DATE, fare, 1_434_000), websiteGroup(2, OTHER, 1_734_000, 1_434_000)] },
  };
}

function fixture(): FixtureTrip {
  const previous = websiteTrip(1_734_000);
  const fields = websiteTripToCanonicalFields(previous).fields;
  return {
    id: previous.sourceTripId, category: "Аялал", operator_name: "Fixture agency", seats_total: 24, seats_left: 12, source_description: "",
    ...fields, status: "active", departure_dates: [DATE, OTHER],
    extra: { ...fields.extra, aliases: ["НОРВЕЛ"], customer_visible: true, age_rules: { adult: "12+ нас", child: "2-11 нас", infant: "0-23 сар" },
      price_groups: [chatbotGroup(DATE, 1_734_000, 1_434_000), chatbotGroup(OTHER, 1_734_000, 1_434_000)] },
  } as unknown as FixtureTrip;
}

test("a per-date fare raised on the website is what the bot quotes next, through the real webhook", async (context) => {
  const harness = await conversationGateHarness(context);
  try {
    const trip = fixture();
    harness.catalog([trip]);
    const words = `${Number(DATE.slice(5, 7))} сарын ${Number(DATE.slice(8))}`;
    const before = await harness.turn("fare-journey-before", `${trip.route_name} ${words} үнэ хэд вэ`, { tripId: trip.id, place: trip.route_name, date: DATE });
    assert.equal(before.status, 200);
    assert.equal(before.sends.length, 1, "the fixture holds the answer, so one grounded reply is sent");
    assert.ok(before.sends[0].text.includes("1,734,000"), `old fare quoted: ${before.sends[0].text}`);

    // The website save, delivered as the website delivers it: the trip, the baseline staff saw, the edited fields.
    const report = websiteTripPatchReport(websiteTrip(1_834_000), websiteTrip(1_734_000), trip, ["departures", "sourceMetadata.price_groups"]);
    assert.deepEqual(report.conflicts, []);
    assert.deepEqual(report.ignored, []);
    const synced = { ...trip, ...report.fields, extra: { ...trip.extra, ...report.fields.extra } } as FixtureTrip;
    assert.equal((synced.extra.price_groups as Array<Record<string, unknown>>).find((group) => (group.dates as string[])[0] === DATE)?.adult_price, 1_834_000);
    assert.equal((synced.extra.price_groups as Array<Record<string, unknown>>).find((group) => (group.dates as string[])[0] === OTHER)?.adult_price, 1_734_000, "the other date keeps its fare");
    harness.catalog([synced]);

    const after = await harness.turn("fare-journey-after", `${trip.route_name} ${words} үнэ хэд вэ`, { tripId: trip.id, place: trip.route_name, date: DATE });
    assert.equal(after.status, 200);
    assert.equal(after.sends.length, 1);
    assert.ok(after.sends[0].text.includes("1,834,000"), `new fare quoted: ${after.sends[0].text}`);
    assert.ok(!after.sends[0].text.includes("1,734,000"), "the replaced fare is gone from the answer");
  } finally {
    await harness.close();
  }
});
