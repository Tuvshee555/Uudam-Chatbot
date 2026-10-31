import test from "node:test";
import assert from "node:assert/strict";
import { readRows, withPartnerMarkup } from "../src/lib/partnerSync/globalTravel";
import { buildPosterData, buildPriceTable, describeChanges, lowestAdultPrice, packageVariants } from "../src/lib/partnerSync/posterPayload";
import { prices, row, tour } from "./fixtures/partner-tour";

test("public API rows preserve each passenger price and skip deleted/padding rows", () => {
  const rows = readRows([
    { departure_date: "2099-06-12", hotel_name: "Example Bay", seats: null, prices: { adult_price: "2100000", infant_price: "320000" } },
    { departure_date: "2099-06-12", hotel_name: null, prices: {} },
    { departure_date: "2099-06-12", hotel_name: "Removed", prices: { adult_price: "1" }, deleted_at: "2099-01-01" },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].prices.adult, 2100000);
  assert.equal(rows[0].prices.infant, 320000);
  assert.equal(rows[0].prices.child2to5, null);
  assert.equal(rows[0].seats, null);
});

test("zero seats close an otherwise active row; newest duplicate wins", () => {
  const raw = { departure_date: "2099-06-12", hotel_name: "Example Bay", prices: { adult_price: "2100000" } };
  const rows = readRows([{ ...raw, seats: 10, updated_at: "2099-01-01" }, { ...raw, availability: "Захиалга авч байна", seats: 0, updated_at: "2099-02-01" }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].open, false);
});

test("invalid calendar dates and corrupt prices fail instead of silently deleting offers", () => {
  assert.throws(() => readRows([{ departure_date: "2099-02-30", hotel_name: "Example", prices: { adult_price: "2100000" } }]), /invalid departure/);
  assert.throws(() => readRows([{ departure_date: "2099-06-12", hotel_name: "Example", prices: { adult_price: "bad" } }]), /invalid fare/);
});

test("programme-only rows remain available and missing variants are not invented", () => {
  const rows = readRows([{ departure_date: "2099-06-12", hotel_name: "Example", prices: { program_adult_price: "2400000" } }]);
  assert.equal(rows.length, 1);
  assert.equal(packageVariants(rows[0]).length, 1);
  assert.equal(packageVariants(rows[0])[0].adult, 2400000);
});

test("table preserves both child bands, infant and supplement per date and package", () => {
  const table = buildPriceTable(tour());
  assert.equal(table.rows.length, 4);
  assert.deepEqual(table.rows[0].cells.slice(1), ["2,100,000₮", "1,600,000₮", "1,200,000₮", "320,000₮", "520,000₮"]);
  assert.deepEqual(table.rows[1].cells.slice(1), ["2,400,000₮", "1,900,000₮", "1,300,000₮", "320,000₮", "520,000₮"]);
  assert.equal(table.rows[2].cells[4], "340,000₮");
  assert.equal(table.rows[2].cells[5], "620,000₮");
});

test("headline uses a bookable offer, not a cheaper sold-out fare", () => {
  assert.equal(lowestAdultPrice(tour([row(undefined, undefined, { open: false, prices: prices({ adult: 1100000 }) }), row("2099-06-19")])), 2100000);
});

test("copy retains branding/photos while replacing text, hotels, flights and complete days", () => {
  const data = buildPosterData(tour(), { title: "Own title", hero_image: "https://example.com/hero.jpg", contacts: { phone: "sample" },
    price_desc: "Old hotels", flights: { return: "Old return" }, days: [{ day: 1, photo: "https://example.com/day.jpg", hotel: "Old hotel" }, { day: 2, hotel: "Old hotel" }] });
  assert.equal(data.title, "Own title");
  assert.equal(data.hero_image, "https://example.com/hero.jpg");
  const days = data.days as Record<string, unknown>[];
  assert.equal(days[0].photo, "https://example.com/day.jpg");
  assert.equal(days[0].summary, tour().days[0].lines.join("\n"));
  assert.equal(days[1].hotel, "");
  assert.equal((data.flights as Record<string, unknown>).return, "");
  assert.equal(data.price_desc, tour().description);
  assert.deepEqual(data.includes, tour().includes);
});

test("change report detects infant-only and child-only price changes", () => {
  const after = tour([row(undefined, undefined, { prices: prices({ infant: 350000, programChild2to5: 1400000 }) })]);
  const report = describeChanges(tour([row()]), after).join("\n");
  assert.match(report, /320,000₮ → 350,000₮/);
  assert.match(report, /1,300,000₮ → 1,400,000₮/);
});

test("Uudam's markup raises every passenger fare of the partner tour, not the single-room supplement", () => {
  const marked = withPartnerMarkup({ adult: 2_100_000, child2to5: 1_300_000, child6to11: null, infant: 320_000, single: 650_000,
    programAdult: 2_400_000, programChild2to5: null, programChild6to11: 1_600_000 }, 100_000);
  assert.deepEqual(marked, { adult: 2_200_000, child2to5: 1_400_000, child6to11: null, infant: 420_000, single: 650_000,
    programAdult: 2_500_000, programChild2to5: null, programChild6to11: 1_700_000 });
});
