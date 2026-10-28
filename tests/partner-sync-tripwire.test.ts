// The tripwire is the only thing standing between a redesigned partner page and live fares being
// overwritten with garbage, so it is tested directly.
import test from "node:test";
import assert from "node:assert/strict";
import { tripwire } from "../src/lib/partnerSync/run";
import type { PartnerOffer, PartnerTour } from "../src/lib/partnerSync/globalTravel";

const offer = (date: string, adultPrice: number, hotelLabel = "Phoenix"): PartnerOffer =>
  ({ date, packageLabel: "Чөлөөт аялал", hotelLabel, adultPrice, currency: "MNT", inStock: true });

const tour = (offers: PartnerOffer[]): PartnerTour => ({
  sourceUrl: "https://global-travel.mn/tours/hainan-aylal",
  title: "ХАЙНАН Саняа аялал",
  description: "",
  heroImage: null,
  durationDays: 9,
  durationNights: 8,
  destinations: [],
  hotels: [],
  offers,
  dates: [...new Set(offers.map((o) => o.date))],
  packages: [],
  hotelOptions: [],
  days: [],
  includes: [],
  excludes: [],
  faq: [],
  dateModified: null,
  contentHash: "h",
});

const dates = ["2026-11-11", "2026-11-18", "2026-11-25", "2026-12-02", "2026-12-09", "2026-12-16", "2026-12-23", "2026-12-30", "2027-01-06", "2027-01-13"];
const baseline = tour(dates.map((date) => offer(date, 2990000)));

test("the first sync is always allowed: there is nothing to compare against", () => {
  assert.equal(tripwire(null, baseline), null);
});

test("an ordinary partner price change passes", () => {
  const after = tour(dates.map((date, index) => offer(date, index < 3 ? 3290000 : 2990000)));
  assert.equal(tripwire(baseline, after), null);
});

test("a single absurd price jump stops the run", () => {
  const after = tour(dates.map((date, index) => offer(date, index === 0 ? 29900000 : 2990000)));
  const blocked = tripwire(baseline, after);
  assert.ok(blocked, "a 10x price should be refused");
  assert.match(blocked!, /2026-11-11/);
  assert.match(blocked!, /хэт том өөрчлөлт/);
});

test("a page that repriced almost everything at once stops the run", () => {
  // A redesign that shifts the columns reads a different number into every row.
  const after = tour(dates.map((date) => offer(date, 3390000)));
  const blocked = tripwire(baseline, after);
  assert.ok(blocked, "a wholesale rewrite should be refused");
  assert.match(blocked!, /нэг дор өөрчлөгдсөн/);
});

test("a page that suddenly lists far fewer departures stops the run", () => {
  const after = tour(dates.slice(0, 3).map((date) => offer(date, 2990000)));
  const blocked = tripwire(baseline, after);
  assert.ok(blocked, "losing most departures should be refused");
  assert.match(blocked!, /болж буурсан/);
});

test("new dates and removed cells alone never trip the wire", () => {
  const after = tour([...baseline.offers, offer("2027-03-03", 2990000)]);
  assert.equal(tripwire(baseline, after), null);
});
