import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { composeHealthCheckup, splitHealthCheckup, checkupItemCount } from "../src/lib/healthCheckup";
import { TripDescriptionEditor } from "../src/components/admin/TripDescriptionEditor";

// Invented clinic list in the shape staff paste (markdown asterisks, trailing commas, "Жич:").
const DESCRIPTION = [
  "Вэлмор хотод эрүүл мэндийн үзлэг өгөх 5 өдрийн аялал.",
  "",
  "*Эрэгтэйчүүдийн биеийн шинжилгээ үзлэгт хийх зүйлс*",
  "Үндсэн үзлэг:",
  "Дотор эрүүл мэндийн үзлэг,",
  "Зүрхний цахилгаан бичлэг",
  "Хэт авиан шинжилгээ:",
  "Хэвлийн дээд хэсгийн хэт авиа: элэг, бөөр",
  "Жич: Шинжилгээний өглөө өлөн байна.",
  "Цусны шинжилгээ:",
  "1. Цусны ерөнхий шинжилгээ",
  "Эмэгтэйчүүдийн биеийн шинжилгээ үзлэгт хийх зүйлс",
  "Үндсэн үзлэг:",
  "Эмэгтэйчүүдийн үзлэг",
].join("\n");

test("the admin reads a checkup description into the same groups the website shows", () => {
  const split = splitHealthCheckup(DESCRIPTION);
  assert.equal(split.intro, "Вэлмор хотод эрүүл мэндийн үзлэг өгөх 5 өдрийн аялал.");
  assert.deepEqual(split.lists.map((list) => list.audience), ["Эрэгтэй", "Эмэгтэй"]);
  assert.deepEqual(split.lists[0].groups.map((group) => [group.title, group.items.length]),
    [["Үндсэн үзлэг", 2], ["Хэт авиан шинжилгээ", 1], ["Цусны шинжилгээ", 1]]);
  assert.deepEqual(split.lists[0].groups[1].items[0], { label: "Хэвлийн дээд хэсгийн хэт авиа", detail: "элэг, бөөр" });
  assert.deepEqual(split.lists[0].groups[2].notes, ["Шинжилгээний өглөө өлөн байна."]);
  assert.equal(checkupItemCount(split.lists[0]), 4);
});

test("saving the groups writes text the website reads back identically", () => {
  const split = splitHealthCheckup(DESCRIPTION);
  assert.deepEqual(splitHealthCheckup(composeHealthCheckup(split)), split);

  const edited = structuredClone(split);
  edited.lists[0].groups[0].items.push({ label: "Нүдний дурангийн үзлэг", detail: null });
  edited.lists[1].groups.push({ title: "Хэт авиан шинжилгээ", items: [{ label: "Бамбай булчирхайн хэт авиа", detail: null }], notes: [] });
  const reread = splitHealthCheckup(composeHealthCheckup(edited));
  assert.equal(checkupItemCount(reread.lists[0]), 5);
  assert.deepEqual(reread.lists[1].groups.map((group) => group.title), ["Үндсэн үзлэг", "Хэт авиан шинжилгээ"]);
});

test("values that would change meaning in the line format are kept as tests", () => {
  const text = composeHealthCheckup({
    intro: "",
    lists: [{
      title: "Шинжилгээнд багтсан зүйлс", audience: "Шинжилгээ", notes: [],
      groups: [
        { title: "Үндсэн", items: [{ label: "Цусны даралт: хэмжилт", detail: null }, { label: "Өндөр, жин хэмжинэ.", detail: null }], notes: [] },
        { title: "", items: [{ label: "Шээсний шинжилгээ", detail: null }], notes: [] },
        { title: "Хоосон", items: [{ label: "  ", detail: null }], notes: [] },
      ],
    }],
  });
  const reread = splitHealthCheckup(text).lists[0];
  assert.deepEqual(reread.groups.map((group) => group.title), ["Үндсэн", "Бусад"],
    "an untitled later group stays separate; an empty group is dropped");
  assert.deepEqual(reread.groups[0].items.map((item) => item.label), ["Цусны даралт – хэмжилт", "Өндөр, жин хэмжинэ"]);
});

test("a list left with no tests is not written as a stray heading", () => {
  const text = composeHealthCheckup({ intro: "Аяллын тайлбар.", lists: [{ title: "Шинжилгээнд багтсан зүйлс", audience: "Шинжилгээ", notes: [], groups: [{ title: "Үндсэн", items: [], notes: [] }] }] });
  assert.equal(text, "Аяллын тайлбар.");
});

test("the editor shows the intro as text and the tests as the website's grouped section", () => {
  const html = renderToStaticMarkup(React.createElement(TripDescriptionEditor, { value: DESCRIPTION, onChange: () => {} }));
  assert.match(html, /Эрүүл мэндийн шинжилгээ/);
  assert.match(html, /4 төрлийн үзлэг, шинжилгээ/);
  assert.match(html, /value="Хэт авиан шинжилгээ"/);
  assert.match(html, /value="элэг, бөөр"/);
  assert.match(html, /Эрэгтэй/);
  const intro = html.match(/<textarea[^>]*aria-label="Аяллын тайлбар"[^>]*>([^<]*)<\/textarea>/)?.[1] ?? "";
  assert.equal(intro.trim(), "Вэлмор хотод эрүүл мэндийн үзлэг өгөх 5 өдрийн аялал.", "the test list is not repeated in the description box");

  const plain = renderToStaticMarkup(React.createElement(TripDescriptionEditor, { value: "Энгийн аялал.", onChange: () => {} }));
  assert.doesNotMatch(plain, /төрлийн үзлэг/);
  assert.match(plain, /Эрүүл мэндийн шинжилгээний жагсаалт нэмэх/);
});
