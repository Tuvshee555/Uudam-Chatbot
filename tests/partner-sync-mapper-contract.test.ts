/* eslint-disable @typescript-eslint/no-explicit-any -- these tests inspect loosely-typed poster JSON */
// The partner payload is only correct if the repo's own poster mapper reads it back correctly.
// These tests run the real mapper over the real payload, so a change to either side fails here
// instead of silently publishing a trip with a null price (which is what happened on 2026-10-28).
import test from "node:test";
import assert from "node:assert/strict";
import { buildPosterData } from "../src/lib/partnerSync/posterPayload";
import { mapPosterTripToFields } from "../src/lib/poster/tripMapper";
import type { PartnerOffer, PartnerTour } from "../src/lib/partnerSync/globalTravel";

const offer = (date: string, packageLabel: string, hotelLabel: string, adultPrice: number, inStock = true): PartnerOffer =>
  ({ date, packageLabel, hotelLabel, adultPrice, currency: "MNT", inStock });

const tour: PartnerTour = {
  sourceUrl: "https://global-travel.mn/tours/hainan-aylal",
  title: "ХАЙНАН Саняа аялал",
  description: "Хайнан арал руу шууд нислэгээр",
  heroImage: null,
  durationDays: 9,
  durationNights: 8,
  destinations: ["Sanya"],
  hotels: ["Phoenix Island Resort Sanya", "Grand Metropark Bay Hotel Sanya"],
  offers: [
    offer("2026-11-11", "Чөлөөт аялал", "Phoenix+Paxton", 2990000),
    offer("2026-11-11", "Хөтөлбөртэй аялал", "Phoenix+Paxton", 3290000),
    offer("2026-11-11", "Чөлөөт аялал", "Phoenix", 3490000),
    offer("2026-11-11", "Хөтөлбөртэй аялал", "Phoenix", 3790000),
    offer("2026-12-30", "Чөлөөт аялал", "Phoenix+Paxton", 3990000),
  ],
  dates: ["2026-11-11", "2026-12-30"],
  packages: ["Чөлөөт аялал", "Хөтөлбөртэй аялал"],
  hotelOptions: ["Phoenix+Paxton", "Phoenix"],
  days: [
    { day: 1, title: "Улаанбаатар - Саняа", lines: ["21:30 цагт цугларна", "23:50 нислэг"] },
    { day: 2, title: "Чөлөөт өдөр", lines: ["Далайн эрэг"] },
  ],
  includes: ["Бүх өдрийн Буфет өглөөний цай", "Аяллын даатгал"],
  excludes: ["Хувийн хэрэглээний зардал"],
  faq: [],
  dateModified: "2026-10-23",
  contentHash: "hash-contract",
};

const mapped = () => mapPosterTripToFields(buildPosterData(tour, "Global Travel Corporation") as never) as Record<string, any>;

test("the mapper reads a real adult price, never null, from the partner payload", () => {
  const trip = mapped();
  assert.equal(typeof trip.adult_price, "number");
  assert.equal(trip.adult_price, 2990000, "the cheapest published fare becomes the headline price");
});

test("every partner departure date survives the mapping, on the right day", () => {
  const dates: string[] = mapped().departure_dates ?? [];
  // A timezone slip would turn 2026-11-11 into 2026-11-10, which is how the first bad sync looked.
  assert.ok(dates.includes("2026-11-11"), `expected 2026-11-11 in ${JSON.stringify(dates)}`);
  assert.ok(dates.includes("2026-12-30"), `expected 2026-12-30 in ${JSON.stringify(dates)}`);
});

test("each package and hotel combination keeps its own price after mapping", () => {
  const groups: any[] = mapped().extra?.price_groups ?? [];
  assert.ok(groups.length >= 4, `expected one group per combination, got ${groups.length}`);
  const find = (date: string, hotel: string, price: number) =>
    groups.find((g) => (g.dates || []).includes(date) && String(g.hotel || "").includes(hotel) && g.adult_price === price);
  assert.ok(find("2026-11-11", "Phoenix+Paxton · Чөлөөт", 2990000), "11-11 Phoenix+Paxton free-package 2,990,000 missing");
  assert.ok(find("2026-11-11", "Phoenix · Чөлөөт", 3490000), "11-11 Phoenix free-package 3,490,000 missing");
  assert.ok(find("2026-11-11", "Phoenix+Paxton · Хөтөлбөртэй", 3290000), "11-11 Phoenix+Paxton programme 3,290,000 missing");
  assert.ok(find("2026-12-30", "Phoenix+Paxton · Чөлөөт", 3990000), "12-30 Phoenix+Paxton free-package 3,990,000 missing");
});

test("no child or infant fare is invented when the partner publishes none", () => {
  const trip = mapped();
  assert.equal(trip.child_price ?? null, null);
  assert.equal(trip.infant_price ?? null, null);
  for (const group of trip.extra?.price_groups ?? []) {
    assert.equal(group.child_price ?? null, null, `group ${group.label} gained a child price`);
  }
});

test("the included and excluded lists reach the mapped trip", () => {
  const trip = mapped();
  assert.deepEqual(trip.extra?.included_items, ["Бүх өдрийн Буфет өглөөний цай", "Аяллын даатгал"]);
  assert.deepEqual(trip.extra?.excluded_items, ["Хувийн хэрэглээний зардал"]);
});

test("the itinerary is written in the shape the poster mapper reads", () => {
  const data = buildPosterData(tour, "Global Travel Corporation") as Record<string, any>;
  assert.equal(data.days.length, 2);
  // PosterDay uses route/summary; title/lines alone are never read by the mapper or the poster UI.
  assert.equal(data.days[0].route, "Улаанбаатар - Саняа");
  assert.match(data.days[0].summary, /23:50 нислэг/);
  assert.equal(data.days[0].day, 1);
});
