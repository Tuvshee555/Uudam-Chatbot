/* eslint-disable @typescript-eslint/no-explicit-any -- these tests inspect loosely-typed poster JSON */
import test from "node:test";
import assert from "node:assert/strict";
import { buildPosterData, buildPriceGroups, buildPriceTable, describeChanges, lowestAdultPrice } from "../src/lib/partnerSync/posterPayload";
import type { PartnerOffer, PartnerTour } from "../src/lib/partnerSync/globalTravel";

const offer = (date: string, packageLabel: string, hotelLabel: string, adultPrice: number, inStock = true): PartnerOffer =>
  ({ date, packageLabel, hotelLabel, adultPrice, currency: "MNT", inStock });

const tour = (overrides: Partial<PartnerTour> = {}): PartnerTour => ({
  sourceUrl: "https://global-travel.mn/tours/hainan-aylal",
  title: "ХАЙНАН Саняа аялал",
  description: "Тайлбар",
  heroImage: null,
  durationDays: 9,
  durationNights: 8,
  destinations: ["Sanya"],
  hotels: ["Phoenix Island Resort Sanya"],
  offers: [
    offer("2026-11-11", "Чөлөөт аялал", "Phoenix+Paxton", 2990000),
    offer("2026-11-11", "Хөтөлбөртэй аялал", "Phoenix+Paxton", 3290000),
    offer("2026-11-11", "Чөлөөт аялал", "Phoenix", 3490000),
    offer("2026-11-18", "Чөлөөт аялал", "Phoenix+Paxton", 2990000),
  ],
  dates: ["2026-11-11", "2026-11-18"],
  packages: ["Чөлөөт аялал", "Хөтөлбөртэй аялал"],
  hotelOptions: ["Phoenix+Paxton", "Phoenix"],
  days: [{ day: 1, title: "Улаанбаатар - Саняа", lines: ["23:50 нислэг"] }],
  includes: ["Буфет өглөөний цай"],
  excludes: ["Хувийн хэрэглээний зардал"],
  faq: [{ question: "Үнэ хэд вэ?", answer: "2,990,000₮-с." }],
  dateModified: "2026-10-23",
  contentHash: "hash-a",
  ...overrides,
});

test("the price table uses the columns the poster mapper understands", () => {
  const table = buildPriceTable(tour());
  assert.deepEqual(table.columns, ["Явах огноо", "Буудал", "Том хүний үнэ"]);
  // one row per date x package x hotel, because a row carries a single adult price
  assert.equal(table.rows.length, 4);
  assert.deepEqual(table.rows[0].cells, ["2026-11-11", "Phoenix+Paxton · Чөлөөт аялал", "2,990,000₮"]);
  assert.equal(table.rows[0].dates, "2026-11-11");
});

test("a sold-out departure is marked, not hidden or silently repriced", () => {
  const table = buildPriceTable(tour({ offers: [offer("2026-11-11", "Чөлөөт аялал", "Phoenix", 3490000, false)] }));
  assert.match(table.rows[0].cells[2], /дууссан/);
});

test("price groups carry only the adult price the partner publishes, never a guessed child fare", () => {
  const groups = buildPriceGroups(tour());
  assert.equal(groups.length, 4);
  assert.equal(groups[0].adult_price, 2990000);
  assert.equal("child_price" in groups[0], false);
  assert.equal("infant_price" in groups[0], false);
  assert.deepEqual(groups[0].dates, ["2026-11-11"]);
});

test("the headline price is the cheapest available departure", () => {
  assert.equal(lowestAdultPrice(tour()), 2990000);
  // when everything is sold out the cheapest is still reported rather than null
  const soldOut = tour({ offers: tour().offers.map((o) => ({ ...o, inStock: false })) });
  assert.equal(lowestAdultPrice(soldOut), 2990000);
});

test("the poster payload records where the data came from", () => {
  const data = buildPosterData(tour(), "Global Travel Corporation") as Record<string, any>;
  assert.equal(data.agency, "Global Travel Corporation");
  assert.equal(data.source_url, "https://global-travel.mn/tours/hainan-aylal");
  assert.equal(data.partner_sync.content_hash, "hash-a");
  assert.equal(data.duration_text, "9 өдөр 8 шөнө");
  assert.deepEqual(data.includes, ["Буфет өглөөний цай"]);
});

test("the change report names every price move, new date and sold-out flip", () => {
  const before = tour();
  const after = tour({
    offers: [
      offer("2026-11-11", "Чөлөөт аялал", "Phoenix+Paxton", 3190000), // +200,000
      offer("2026-11-11", "Хөтөлбөртэй аялал", "Phoenix+Paxton", 3290000), // unchanged
      offer("2026-11-11", "Чөлөөт аялал", "Phoenix", 3490000, false), // sold out
      offer("2026-12-02", "Чөлөөт аялал", "Phoenix+Paxton", 2990000), // new date
    ],
  });
  const lines = describeChanges(before, after).join("\n");
  assert.match(lines, /📈 2026-11-11 Чөлөөт аялал · Phoenix\+Paxton: 2,990,000₮ → 3,190,000₮/);
  assert.match(lines, /❌ 2026-11-11 Чөлөөт аялал · Phoenix.*дууссан/);
  assert.match(lines, /➕ 2026-12-02/);
  assert.match(lines, /➖ 2026-11-18/);
  assert.equal(/Хөтөлбөртэй аялал · Phoenix\+Paxton: /.test(lines), false, "an unchanged price is not reported");
});

test("the first sync reports a plain summary instead of a diff", () => {
  const lines = describeChanges(null, tour());
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Анхны хуулалт: 4 үнэ, 2 огноо/);
});
