/**
 * Blocks admin-entry placeholders from ever reaching a customer: an unfilled
 * "add departure" row ("Шинэ огноо") saved in a poster used to be quoted to
 * customers as a literal date, both in chat and in the PDF the bot sends.
 * Trip names, prices and dates here are invented.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { isPlaceholderDateText, isPlaceholderTugrikFare } from "../src/lib/tripCompleteness";
import { mapPosterTripToFields } from "../src/lib/poster/tripMapper";
import { buildBlocks, formatPriceTable } from "../src/lib/poster/pdf";

test("isPlaceholderDateText / isPlaceholderTugrikFare recognise the editor's own placeholders", () => {
  assert.equal(isPlaceholderDateText("Шинэ огноо"), true);
  assert.equal(isPlaceholderDateText("шинэ огноо"), true);
  assert.equal(isPlaceholderDateText("[огноо 1]"), true);
  assert.equal(isPlaceholderDateText("12 сарын 8"), false);
  assert.equal(isPlaceholderDateText("Лхагва гараг бүр"), false);
  assert.equal(isPlaceholderTugrikFare(1), true);
  assert.equal(isPlaceholderTugrikFare(999), true);
  assert.equal(isPlaceholderTugrikFare(1000), false);
  assert.equal(isPlaceholderTugrikFare(390000), false);
  assert.equal(isPlaceholderTugrikFare(null), false);
});

test("a poster with one unfilled 'add departure' row never saves that row as a date", () => {
  const fields = mapPosterTripToFields({
    title: "Вэлмор аялал",
    duration_days: 8,
    duration_nights: 7,
    departures: [{ date: "Лхагва гараг бүр" }, { date: "Шинэ огноо" }, { date: "9 сарын 30" }],
  });
  assert.deepEqual(fields.departure_dates, ["Лхагва гараг бүр", "9 сарын 30"]);
});

test("a poster whose ONLY departure row is unfilled has no departure_dates at all", () => {
  const fields = mapPosterTripToFields({
    title: "Вэлмор аялал",
    departures: [{ date: "Шинэ огноо" }],
  });
  assert.equal(fields.departure_dates, undefined);
});

test("the customer-facing PDF drops a placeholder departure row", () => {
  const blocks = buildBlocks({
    id: "p1",
    title: "Вэлмор аялал",
    source_file: null,
    data: {
      duration_days: 8,
      duration_nights: 7,
      departures: [{ date: "9 сарын 30" }, { date: "Шинэ огноо" }],
    },
  });
  const summary = blocks.find((b) => b.label === "Аяллын товч");
  assert.ok(summary);
  const line = summary!.lines.find((l) => l.startsWith("Гарах өдрүүд"));
  assert.match(line || "", /9 сарын 30/);
  assert.doesNotMatch(line || "", /Шинэ огноо/);
});

test("the PDF price table drops a row whose date is the unfilled placeholder", () => {
  const rows = formatPriceTable({
    price_table: {
      columns: ["Том хүн", "Хүүхэд"],
      rows: [
        { dates: "9 сарын 30", cells: ["1,090,000₮", "890,000₮"] },
        { dates: "Шинэ огноо", cells: ["", ""] },
      ],
    },
  });
  assert.equal(rows.length, 1);
  assert.match(rows[0], /9 сарын 30/);
});
