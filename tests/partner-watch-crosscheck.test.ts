import test from "node:test";
import assert from "node:assert/strict";
import { completeFromSchedule } from "../src/lib/partnerWatch/crossCheck";
import { htmlToText } from "../src/lib/assistantAgent/webPage";

// Invented page: prices grouped by two hotels; the reader kept only the first hotel.
const NOW = new Date("2099-01-05T04:00:00Z");
type Row = Record<string, unknown>;
const cells = (row: string[]) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
const PAGE = htmlToText(`<html><body><table>${[
  ["№", "Аялал гарах өдрүүд", "Том хүн 5 одтой<br>Hotel Alpha", "Хүүхэд 3-11 нас (Оргүй)<br>Hotel Alpha", "Том хүн 5 одтой<br>Hotel Beta", "Хүүхэд 3-11 нас (Оргүй)<br>Hotel Beta"],
  ["1. Шинэ жил", "2 сарын 03", "3,000,000", "2,500,000", "2,900,000", "2,400,000"],
  ["2.", "2 сарын 10", "3,100,000", "2,600,000", "3,000,000", "2,500,000"],
].map(cells).join("")}</table></body></html>`).text;
const reader = (): Row => ({
  route_name: "НОРВЕЛ",
  extra: { price_groups: [
    { dates: ["2099-02-03"], hotel: "Hotel Alpha", adult_price: 3_000_000, child_price: 2_500_000, single_price: 900_000, note: "Шинэ жил",
      passenger_prices: [{ label: "Хүүхэд оргүй", age_range: "3-11 нас", price: 2_500_000 }, { label: "Нярай", age_range: "", price: 0, note: "Үнэгүй" }] },
    { dates: ["2099-02-10"], hotel: "Hotel Alpha", adult_price: 3_150_000, child_price: 2_600_000, single_price: 900_000,
      passenger_prices: [{ label: "Хүүхэд оргүй", age_range: "3-11 нас", price: 2_600_000 }, { label: "Нярай", age_range: "", price: 0, note: "Үнэгүй" }] },
  ] },
});

test("a hotel the reader dropped is added from the page's table, on the reader's own row for that date", () => {
  const { fields, notes } = completeFromSchedule(reader(), PAGE, NOW);
  const rows = (fields.extra as Row).price_groups as Row[];
  assert.equal(rows.length, 4);
  const beta = rows.filter((row) => row.hotel === "Hotel Beta");
  assert.deepEqual(beta.map((row) => [(row.dates as string[])[0], row.adult_price, (row.passenger_prices as Row[])[0].price, (row.passenger_prices as Row[])[1].price, row.single_price, row.note ?? ""]), [
    ["2099-02-03", 2_900_000, 2_400_000, 0, 900_000, "Шинэ жил"],
    ["2099-02-10", 3_000_000, 2_500_000, 0, 900_000, ""],
  ]);
  assert.ok(notes.some((note) => note.type === "schedule_rows_added"));
});

test("a price the reader read differently is flagged, never replaced", () => {
  const { fields, notes } = completeFromSchedule(reader(), PAGE, NOW);
  assert.equal(((fields.extra as Row).price_groups as Row[])[1].adult_price, 3_150_000);
  const differ = notes.find((note) => note.type === "schedule_price_differs");
  assert.ok(differ && /3,100,000₮/.test(differ.text) && /3,150,000₮/.test(differ.text));
});

test("rows without hotels, or a page with no table, are left as the reader wrote them", () => {
  const plain = reader();
  for (const row of (plain.extra as Row).price_groups as Row[]) delete row.hotel;
  assert.equal(completeFromSchedule(plain, PAGE, NOW).fields, plain);
  assert.equal(completeFromSchedule(reader(), "Хөтөлбөр: 1-р өдөр ...", NOW).notes.length, 0);
});
