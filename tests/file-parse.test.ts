import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import {
  MAX_PARSE_UPLOAD_DECODED_BYTES,
  parseUpload,
} from "../src/lib/fileParse";

test("parseUpload reads XLSX workbooks after dependency overrides", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Trips");
  sheet.addRow(["Маршрут", "Үнэ"]);
  sheet.addRow(["Улаанбаатар - Бээжин", 1200000]);

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const parsed = await parseUpload({
    filename: "trips.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    dataBase64: buffer.toString("base64"),
  });

  assert.equal(parsed.label, "trips.xlsx");
  assert.equal(parsed.inline, null);
  assert.match(parsed.text, /Trips/);
  assert.match(parsed.text, /Улаанбаатар - Бээжин/);
  assert.match(parsed.text, /1200000/);
});

test("parseUpload rejects oversized decoded uploads before parsing", async () => {
  const dataBase64 = Buffer.alloc(MAX_PARSE_UPLOAD_DECODED_BYTES + 1).toString(
    "base64",
  );

  await assert.rejects(
    () =>
      parseUpload({
        filename: "large.txt",
        mimeType: "text/plain",
        dataBase64,
      }),
    /too large/i,
  );
});
