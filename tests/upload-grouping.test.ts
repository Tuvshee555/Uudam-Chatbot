import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { ParseUploadUnit } from "../src/lib/adminTypes";

applyTestEnv();

// A Word program with pictures in it was sent as one request per picture, and the
// model read every picture as a trip of its own: one file produced eleven proposals,
// some of them edits to an existing trip (seen with a real file, 2026-11-05).
const dataUrl = (bytes: number, mime = "image/jpeg") => `data:${mime};base64,${Buffer.alloc(bytes, 1).toString("base64")}`;
const text = (name = "Норвел хөтөлбөр.docx"): ParseUploadUnit => ({
  displayName: `${name} (1/1)`, filename: `${name}.part-001-of-001.txt`, mimeType: "text/plain", dataUrl: dataUrl(4_000, "text/plain"),
});
const embedded = (n: number, bytes = 150_000): ParseUploadUnit => ({
  displayName: `Норвел хөтөлбөр.docx / image${n}.jpeg`, filename: `Норвел хөтөлбөр.docx/image${n}.jpeg`, mimeType: "image/jpeg", dataUrl: dataUrl(bytes), sourceGroup: "Норвел хөтөлбөр.docx",
});
const loose = (name: string, bytes = 120_000): ParseUploadUnit => ({ displayName: name, filename: name, mimeType: "image/jpeg", dataUrl: dataUrl(bytes) });

test("a Word file's own pictures ride with its text as gallery photos, never as documents of their own", async () => {
  const { attachGalleryPhotos } = await import("../src/lib/adminPageUtils");
  const units = attachGalleryPhotos([text()], [1, 2, 3].map((n) => embedded(n)));
  assert.equal(units.length, 1, "one request for the file, whatever the number of pictures");
  assert.deepEqual(units[0].companions?.map((part) => [part.filename.slice(-11), part.photoOnly]), [["image1.jpeg", true], ["image2.jpeg", true], ["image3.jpeg", true]]);
  assert.equal(attachGalleryPhotos([text()], []).length, 1);
  assert.deepEqual(attachGalleryPhotos([], [embedded(1)]), [], "pictures without a readable document are not a trip");

  const many = attachGalleryPhotos([text()], Array.from({ length: 30 }, (_, n) => embedded(n, 250_000)));
  const sent = many[0].companions || [];
  assert.ok(sent.length <= 12, "a gallery does not need thirty pictures");
  assert.ok(sent.reduce((sum, part) => sum + part.dataUrl.length, 0) < 4_000_000, "the request stays under the 4.5 MB body limit");

  const long = attachGalleryPhotos([text(), { ...text(), filename: "Норвел хөтөлбөр.docx.part-002-of-002.txt" }], [embedded(1)]);
  assert.deepEqual(long.map((unit) => unit.companions?.length || 0), [1, 0], "the pictures go once, with the first part");
});

test("a program sent together with a picture of its price table is one reading, so one trip", async () => {
  const { attachGalleryPhotos, groupDocumentWithImages } = await import("../src/lib/adminPageUtils");
  const [document] = attachGalleryPhotos([text()], [embedded(1)]);
  const grouped = groupDocumentWithImages([document, loose("үнийн хүснэгт.jpg")]);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].sameTrip, true, "the server is told these parts are one trip");
  assert.deepEqual(grouped[0].companions?.map((part) => Boolean(part.evidenceOnly)), [false, true], "the price picture is evidence, not a gallery photo");
  assert.deepEqual(grouped[0].companions?.map((part) => [part.filename, Boolean(part.photoOnly)]), [["Норвел хөтөлбөр.docx/image1.jpeg", true], ["үнийн хүснэгт.jpg", false]],
    "the loose picture is read with the document; the embedded one is still only a photo");

  const twoDocs = [text("А.docx"), text("Б.docx"), loose("зураг.jpg")];
  assert.equal(groupDocumentWithImages(twoDocs), twoDocs, "two documents are two trips: nothing is guessed");
  const postersOnly = [loose("1.jpg"), loose("2.jpg")];
  assert.equal(groupDocumentWithImages(postersOnly), postersOnly, "pictures alone are read as before");
  const tooBig = [text(), loose("том.jpg", 2_600_000)];
  assert.equal(groupDocumentWithImages(tooBig), tooBig, "a set that cannot fit one request is left alone");
});

test("a price table is turned into departures and per-date fares row by row; partner columns are left out", async () => {
  const { applyPriceTable, parsePriceTable, priceTableFares } = await import("../src/lib/tripPriceTable");
  const column = (name: string, currency: string, amount: number) => ({ column: name, currency, amount });
  const row = (departure: string, adult: number, tall: number, small: number) => ({ departure, prices: [
    column("Ланд үнэ том хүн", "CNY", 5980), column("Зарлах үнэ том хүн", "MNT", adult),
    column("Ланд үнэ хүүхэд 1.2–1.4 м", "CNY", 5380), column("Зарлах үнэ хүүхэд ортой 1.2–1.4 м", "MNT", tall),
    column("Зарлах үнэ хүүхэд оргүй 1.2 м доош", "MNT", small), column("Ганцаараа орох төлбөр", "CNY", 750),
  ] });
  const table = parsePriceTable({ year: 2098, rows: [row("05/11-05/16", 1_111_111, 999_999, 888_888), row("05/18", 1_011_111, 919_999, 808_888), row("зун", 1, 1, 1), { departure: "06/01", prices: [] }] });
  assert.deepEqual(table?.rows.map((entry) => entry.departure), ["05/11", "05/18"], "a range departs on its first day; a row without a date or a price is not a departure");
  const fares = priceTableFares(table!);
  assert.deepEqual(fares?.departure_dates, ["2098-05-11", "2098-05-18"]);
  assert.deepEqual(fares?.price_groups.map((group) => [group.adult_price, group.child_price]), [[1_111_111, 999_999], [1_011_111, 919_999]], "each row keeps its own prices");
  assert.deepEqual((fares?.price_groups[1].passenger_prices as Array<{ label: string; price: number }>).map((band) => [band.label, band.price]),
    [["Хүүхэд 1.2–1.4 м", 919_999], ["Хүүхэд 1.2 м доош", 808_888]], "both child columns survive, named by their height");

  // The shape the reader is asked for: the first row cell by cell, later rows as numbers in the same order.
  const compact = parsePriceTable({ year: 2098, rows: [row("05/11", 1_111_111, 999_999, 888_888), { departure: "05/18", amounts: [5680, 1_011_111, 4980, 919_999, 808_888, 750] }] });
  assert.deepEqual(priceTableFares(compact!)?.price_groups.map((group) => [group.adult_price, group.child_price]), [[1_111_111, 999_999], [1_011_111, 919_999]]);
  assert.equal(parsePriceTable({ year: 2098, rows: [row("05/11", 1_111_111, 999_999, 888_888), { departure: "05/18", amounts: [5680, 1_011_111, 4980] }] }), null,
    "a row that does not line up with the headings makes the whole reading unusable — a shifted price is worse than none");
  assert.deepEqual([fares?.adult_price, fares?.child_price], [1_011_111, 919_999], "the trip's 'from' price is the cheapest row");
  assert.ok(!JSON.stringify(fares).includes("5980") && !JSON.stringify(fares).includes("750"), "no yuan figure reaches the trip");

  const fields: Record<string, unknown> = { departure_dates: ["5 сарын 11"], adult_price: 1_111_111, extra: { departure_date_groups: [{ dates: ["5 сарын 11", "5 сарын 18"], adult_price: 1_111_111 }], website_summary: "x" } };
  assert.equal(applyPriceTable(fields, table!), true);
  assert.deepEqual([fields.departure_dates, fields.adult_price], [["2098-05-11", "2098-05-18"], 1_011_111]);
  assert.deepEqual([(fields.extra as Record<string, unknown[]>).price_groups.length, (fields.extra as Record<string, unknown[]>).departure_date_groups.length, (fields.extra as Record<string, unknown>).website_summary], [2, 0, "x"]);

  const yearless = priceTableFares(parsePriceTable({ rows: [row("5/11", 1_111_111, 999_999, 888_888)] })!);
  assert.deepEqual(yearless?.departure_dates, ["5 сарын 11"], "no year in the picture: none is invented");
  assert.equal(parsePriceTable({ year: null, rows: [] }), null);
  assert.equal(priceTableFares({ year: null, rows: [{ departure: "05/11", prices: [column("Ланд үнэ том хүн", "MNT", 1_600_000), column("Том хүн", "CNY", 5980)] }] }), null, "a table of partner prices only gives the trip no price");
  assert.equal(applyPriceTable({ extra: {} }, { year: null, rows: [{ departure: "05/11", prices: [column("Том хүн", "CNY", 5980)] }] }), false);
});
