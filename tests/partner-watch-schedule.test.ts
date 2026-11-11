import assert from "node:assert/strict";
import test from "node:test";
import { htmlToText } from "../src/lib/assistantAgent/webPage";
import { amountOf, datesOf, parseScheduleTables, statusOf } from "../src/lib/partnerWatch/scheduleTable";

/**
 * The partner schedule parser on invented pages (no real trip, hotel, price or date), each
 * rendered by the same htmlToText the assistant and the watch read pages with, in the shapes
 * partner pages use: a status column, wrapped cells, a code column with a note between rows,
 * a label before the status, dotted / spaced thousands, hotels as column groups.
 */

const td = (cells: string[]) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
const page = (rows: string[][], before = "", after = "") => htmlToText(`<html><body><h2>Хуваарь</h2>${before}<table>${rows.map(td).join("")}</table>${after}<p>Өрөөнд ганцаар орох бол 900,000 төгрөг нэмнэ.</p></body></html>`).text;

test("cells: amounts, statuses and dates as partner pages write them", () => {
  assert.equal(amountOf("2,590,000 төг"), 2_590_000);
  assert.equal(amountOf("2.590.000"), 2_590_000);
  assert.equal(amountOf("2 590 000"), 2_590_000);
  assert.equal(amountOf("2590000₮"), 2_590_000);
  assert.equal(amountOf("Үнэгүй"), 0);
  assert.equal(amountOf("2 хүн 2,590,000"), null, "a cell with more than the amount is not an amount");
  assert.equal(amountOf("12 сарын 05"), null);
  assert.deepEqual(statusOf("бүртгэж байна"), { status: "open", seats: null });
  assert.deepEqual(statusOf("Бүртгэж байна."), { status: "open", seats: null });
  assert.deepEqual(statusOf("Нээлттэй"), { status: "open", seats: null });
  assert.deepEqual(statusOf("3 суудал үлдсэн"), { status: "low", seats: 3 });
  assert.deepEqual(statusOf("Цөөн суудал"), { status: "low", seats: null });
  assert.deepEqual(statusOf("Дүүрсэн."), { status: "full", seats: null });
  assert.deepEqual(statusOf("дууссан"), { status: "full", seats: null });
  assert.deepEqual(statusOf("Суудал дууссан"), { status: "full", seats: null });
  assert.equal(statusOf("Шинэ жилийн хүлээн авалттай"), null, "not a seat status");
  assert.deepEqual(datesOf("12 сарын 05"), [{ date: "12/5" }]);
  assert.deepEqual(datesOf("01 сарын 01"), [{ date: "1/1" }]);
  assert.deepEqual(datesOf("12 сарын 2 5"), [{ date: "12/25" }], "a day typed with a space between its digits");
  assert.deepEqual(datesOf("2099.03.04"), [{ date: "2099-03-04", year: 2099 }]);
  assert.deepEqual(datesOf("2099 оны 3 сарын 4"), [{ date: "2099-03-04", year: 2099 }]);
});

test("status column, wrapped header and hotel cells: one row per departure with its state and prices", () => {
  const text = page([
    ["Бүртгэл", "Аялал гарах өдөр", "Аялал ирэх өдөр", "Том хүн<br>(12-оос дээш нас)", "Хүүхэд ортой<br>(12-оос доош нас)", "Хүүхэд оргүй<br>(12 – 2 нас)", "Зочид буудлууд"],
    ["бүртгэж байна", "12 сарын 05", "12 сарын 10", "2,590,000 төг", "2,490,000 төг", "1,990,000 төг", "Норвел: Hotel Alpha *****<br>Вэлмор: Lumen Bay Resort *****"],
    ["дүүрсэн", "12 сарын 10", "12 сарын 17", "2,890,000 төг", "2,790,000 төг", "2,190,000 төг", "Вэлмор: Lumen Bay Resort *****<br>Норвел: Hotel Alpha *****"],
    ["3 суудал үлдсэн", "12 сарын 31", "1 сарын 07", "3,190,000 төг", "3,090,000 төг", "2,290,000 төг", "Норвел: Hotel Beta ****"],
    ["бүртгэж байна", "1 сарын 07", "1 сарын 14", "2,990,000 төг", "2,890,000 төг", "2,190,000 төг", "Норвел: Hotel Beta ****"],
  ]);
  assert.match(text, /бүртгэж байна \| 12 сарын 05 \|/, "the fixture reads like a real page");
  const parsed = parseScheduleTables(text);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) return;
  assert.equal(parsed.tables, 1);
  assert.deepEqual(parsed.rows.map((row) => [row.date, row.status, row.seats]), [["12/5", "open", null], ["12/10", "full", null], ["12/31", "low", 3], ["1/7", "open", null]]);
  assert.deepEqual(parsed.rows[0].prices, [
    { column: "Том хүн (12-оос дээш нас)", amount: 2_590_000 },
    { column: "Хүүхэд ортой (12-оос доош нас)", amount: 2_490_000 },
    { column: "Хүүхэд оргүй (12 – 2 нас)", amount: 1_990_000 },
  ]);
  assert.equal(parsed.rows[0].hotel, "Норвел: Hotel Alpha ***** / Вэлмор: Lumen Bay Resort *****", "a wrapped hotel cell stays one cell");
});

test("a code column and a note paragraph between rows: the table goes on after the note", () => {
  const text = htmlToText(`<table>${td(["Аяллын дугаар", "Бүртгэлийн байдал", "Аялал гарах өдөр", "Аялал ирэх өдөр", "Том хүн", "Хүүхэд"])}
    ${td(["Т-1", "дууссан", "11 сарын 18", "11 сарын 25", "2,190,000 төг", "1,890,000 төг"])}
    ${td(["Т-2", "8 суудал үлдсэн", "11 сарын 25", "12 сарын 02", "2,190,000 төг", "1,890,000 төг"])}</table>
    <p>Анхаар: энэ улиралд нислэгийн цаг өөрчлөгдөж болно.</p>
    <table>${td(["T-3", "бүртгэж байна", "1 сарын 27", "2 сарын 03", "2,390,000 төг", "1,990,000 төг"])}</table>`).text;
  const parsed = parseScheduleTables(text);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) return;
  assert.deepEqual(parsed.rows.map((row) => [row.date, row.status, row.seats, row.note]), [["11/18", "full", null, ""], ["11/25", "low", 8, ""], ["1/27", "open", null, ""]]);
});

test("№ column with labels, a label before the status, dotted thousands and status cells that are not statuses", () => {
  const text = page([
    ["№", "Бүртгэлийн байдал", "Аяллын өдрүүд", "Буцах өдөр", "Том хүн<br>(12-оос дээш нас)", "Хүүхэд тусдаа оргүй<br>(2-8 нас)"],
    ["1. Нэг талдаа дамжих нислэг", "Дүүрсэн.", "12 сарын 11", "12 сарын 18", "2.490.000", "1,990,000"],
    ["2.", "Бүртгэж байна.", "12 сарын 18", "12 сарын 2 5", "2 690 000", "2,090,000"],
    ["3 Баярын оройн хоол", "Шинэ жилийн хүлээн авалттай", "12 сарын 2 5", "01 сарын 01", "3,490,000", "2,490,000"],
    ["4.", "Цагаан сар", "02 сарын 05", "02 сарын 12", "2,890,000", "2,190,000"],
  ]);
  const parsed = parseScheduleTables(text);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) return;
  assert.deepEqual(parsed.rows.map((row) => [row.date, row.status, row.note, row.prices[0].amount]), [
    ["12/11", "full", "Нэг талдаа дамжих нислэг", 2_490_000],
    ["12/18", "open", "", 2_690_000],
    ["12/25", null, "Баярын оройн хоол · Шинэ жилийн хүлээн авалттай", 3_490_000],
    ["2/5", null, "Цагаан сар", 2_890_000],
  ]);
});

test("a row whose first cell ends its line is still one row", () => {
  // <br> right after the code cell, as one partner page writes «4. |» then the status on the next line.
  const text = htmlToText(`<table>${td(["№", "Бүртгэлийн байдал", "Аялал гарах өдрүүд", "Буцах өдөр", "Том хүн", "Хүүхэд"])}
    <tr><td>4.</td><td><br>Дүүрсэн.</td><td>01 сарын 01</td><td>01 сарын 08</td><td>2,990,000</td><td>2,690,000</td></tr>
    ${td(["5.", "2 суудал үлдсэн", "01 сарын 08", "01 сарын 15", "2,990,000", "2,690,000"])}</table>`).text;
  const parsed = parseScheduleTables(text);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) return;
  assert.deepEqual(parsed.rows.map((row) => [row.date, row.status, row.seats]), [["1/1", "full", null], ["1/8", "low", 2]]);
});

test("hotels as column groups: one row per hotel group, each with its own columns", () => {
  const text = page([
    ["№", "Аялал гарах өдрүүд", "Том хүн 5 одтой<br>Hotel Alpha Norvel", "Хүүхэд 3-11 нас (Оргүй)<br>Hotel Alpha Norvel", "Том хүн 5 одтой<br>Lumen Bay Resort", "Хүүхэд 3-11 нас (Оргүй)<br>Lumen Bay Resort"],
    ["1.", "12 сарын 11", "2,090,000", "1,590,000", "1,990,000", "1,590,000"],
    ["2. Шинэ жил", "12 сарын 25", "2,790,000", "2,290,000", "2,190,000", "1,890,000"],
  ]);
  const parsed = parseScheduleTables(text);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) return;
  assert.deepEqual(parsed.rows.map((row) => [row.date, row.hotel, row.prices.map((price) => `${price.column}=${price.amount}`).join(", "), row.note]), [
    ["12/11", "Hotel Alpha Norvel", "Том хүн 5 одтой=2090000, Хүүхэд 3-11 нас (Оргүй)=1590000", ""],
    ["12/11", "Lumen Bay Resort", "Том хүн 5 одтой=1990000, Хүүхэд 3-11 нас (Оргүй)=1590000", ""],
    ["12/25", "Hotel Alpha Norvel", "Том хүн 5 одтой=2790000, Хүүхэд 3-11 нас (Оргүй)=2290000", "Шинэ жил"],
    ["12/25", "Lumen Bay Resort", "Том хүн 5 одтой=2190000, Хүүхэд 3-11 нас (Оргүй)=1890000", "Шинэ жил"],
  ]);
});

test("an empty cell folded away by the page text: placed by what the cells hold, ambiguous rows skipped", () => {
  const text = page([
    ["Бүртгэл", "Аялал гарах өдөр", "Том хүн", "Хүүхэд ортой", "Хүүхэд оргүй"],
    ["", "12 сарын 05", "2,590,000", "2,490,000", "1,990,000"],
    ["дүүрсэн", "12 сарын 12", "2,590,000", "2,490,000", ""],
    ["бүртгэж байна", "12 сарын 19", "2,590,000", "2,490,000", "1,990,000"],
  ]);
  const parsed = parseScheduleTables(text);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) return;
  // 12/5: the empty status is known to be the status (the only non-price column left); 12/12: two
  // child prices for three columns — which one is missing cannot be told, so the row is skipped.
  assert.deepEqual(parsed.rows.map((row) => [row.date, row.status]), [["12/5", null], ["12/19", "open"]]);
  assert.equal(parsed.skipped, 1);
  assert.deepEqual(parsed.unread, ["12/12"], "the skipped row's date is still on the page");
});

test("an unknown shape is refused with a reason, never guessed", () => {
  const noTable = parseScheduleTables(htmlToText("<p>Аялал 12 сарын 5-нд гарна. Үнэ 2,590,000₮.</p>").text);
  assert.deepEqual(noTable, { ok: false, reason: "Хуудсанд гарах өдөр, үнэтэй хуваарийн хүснэгт олдсонгүй." });
  const noPrice = parseScheduleTables(page([["Аялал гарах өдөр", "Хөтөч"], ["12 сарын 05", "Тийм"]]));
  assert.equal(noPrice.ok, false, "a table without a price column is not a schedule");
  const unnamedGroups = parseScheduleTables(page([
    ["Аялал гарах өдөр", "Том хүн", "Хүүхэд", "Том хүн", "Хүүхэд"],
    ["12 сарын 05", "2,590,000", "1,990,000", "2,390,000", "1,890,000"],
  ]));
  assert.deepEqual(unnamedGroups, { ok: false, reason: "Үнийн баганууд буудлаар бүлэглэгдсэн боловч буудлын нэр тодорхойгүй байна." });
  const contradiction = parseScheduleTables(page([
    ["Бүртгэл", "Аялал гарах өдөр", "Том хүн"],
    ["бүртгэж байна", "12 сарын 05", "2,590,000"],
    ["дүүрсэн", "12 сарын 05", "2,590,000"],
  ]));
  assert.equal(contradiction.ok, false, "the same departure twice with different facts");
});
