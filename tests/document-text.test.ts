/**
 * A file sent with an instruction about saved trips, as text for the assistant's agent
 * (src/lib/documentText.ts, POST /api/admin/file-text). No model is called here: the picture
 * reader is a script. Invented trips and prices only.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import { applyTestEnv } from "./helpers/env";

applyTestEnv();

const base64 = (value: string | Buffer) => Buffer.from(value).toString("base64");

test("an Excel price list becomes rows of text: one line per row, a merged cell written once", async () => {
  const { documentTextOf, plainDocumentText } = await import("../src/lib/documentText");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Нэмэлт");
  sheet.addRow(["测试加项单", "", ""]);
  sheet.mergeCells("A1:C1");
  sheet.addRow(["项目", "内容", "价格"]);
  sheet.addRow(["心脏", "心脏彩超", 180]);
  sheet.addRow(["头部", "头部核磁", 640]);
  const document = await documentTextOf({
    filename: "нэмэлт.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    dataBase64: base64(Buffer.from(await workbook.xlsx.writeBuffer())),
  });
  assert.equal(document.kind, "text");
  assert.equal(document.name, "нэмэлт.xlsx");
  assert.doesNotMatch(document.text, /<t[dr]|<table/i, "no markup reaches the agent");
  const lines = document.text.split("\n").filter(Boolean);
  assert.ok(lines.includes("心脏 | 心脏彩超 | 180"), document.text);
  assert.ok(lines.includes("头部 | 头部核磁 | 640"), document.text);
  assert.equal(lines.filter((line) => line.includes("测试加项单")).length, 1, "the merged title stands once");
  assert.doesNotMatch(lines.find((line) => line.includes("测试加项单"))!, /测试加项单.*测试加项单/);

  assert.equal(plainDocumentText("нэг\r\n\r\n\r\n\r\nхоёр  "), "нэг\n\nхоёр", "plain text keeps its lines");
  assert.equal(
    plainDocumentText("<h3>Хуудас 1</h3><table><tr><td>A &amp; B</td><td>мөр 1<br>мөр 2</td></tr><tr><td></td><td>170</td></tr></table>"),
    "# Хуудас 1\nA & B | мөр 1 / мөр 2\n170",
  );
});

test("an old Word file (.doc) is read whole: paragraphs, Chinese, and table cells as columns", async () => {
  const { documentTextOf } = await import("../src/lib/documentText");
  const fixture = readFileSync(path.join(__dirname, "fixtures", "legacy-word-sample.doc"));
  for (const upload of [
    { filename: "хөтөлбөр.doc", mimeType: "application/msword" },
    { filename: "хөтөлбөр.DOC", mimeType: "" },
  ]) {
    const document = await documentTextOf({ ...upload, dataBase64: base64(fixture) });
    assert.equal(document.kind, "text");
    assert.match(document.text, /АЛЬФА ХОТЫН АЯЛАЛ/);
    assert.match(document.text, /Zeta Inn буудалд байрлана/);
    assert.match(document.text, /阿尔法测试/);
    assert.match(document.text, /Гарах өдөр\tТом хүн\tХүүхэд\n12\/02\t2590000\t2290000/, "a table row keeps its cells apart");
  }
  await assert.rejects(
    () => documentTextOf({ filename: "эвдэрсэн.doc", mimeType: "application/msword", dataBase64: base64("this is not a Word file") }),
    /\.doc файлыг нээж чадсангүй[\s\S]*\.docx эсвэл PDF/,
    "a file Word cannot open is refused with what to do next",
  );
});

test("a picture is transcribed by one vision call; nothing readable is an error, never an empty source", async () => {
  const { documentTextOf } = await import("../src/lib/documentText");
  const calls: Array<{ parts: unknown[]; options: Record<string, unknown> }> = [];
  const ask = (async (parts: unknown[], options: Record<string, unknown>) => {
    calls.push({ parts, options });
    return { text: "```\nГарах өдөр | Том хүн | Хүүхэд\n12/02 | 2,590,000 | 2,290,000\n```" };
  }) as never;
  const png = base64(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
  const document = await documentTextOf({ filename: "үнэ.png", mimeType: "image/png", dataBase64: png }, { ask });
  assert.deepEqual(document, { name: "үнэ.png", kind: "image", text: "Гарах өдөр | Том хүн | Хүүхэд\n12/02 | 2,590,000 | 2,290,000" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.source, "assistant.file_text.image");
  assert.equal(calls[0].options.temperature, 0);
  assert.match(String((calls[0].parts[0] as { text: string }).text), /digit for digit/);

  const silent = (async () => ({ text: "  " })) as never;
  await assert.rejects(() => documentTextOf({ filename: "үнэ.png", mimeType: "image/png", dataBase64: png }, { ask: silent }), /зургийг уншиж чадсангүй/);
  await assert.rejects(() => documentTextOf({ filename: "хоосон.txt", mimeType: "text/plain", dataBase64: base64("   \n ") }), /уншигдах текст алга|хоосон/);
});
