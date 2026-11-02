import assert from "node:assert/strict";
import test from "node:test";
import { catalogTripNames, FOCUS_HEADER, focusKnowledgeBase, tripsNamedInRecentMessages } from "../src/lib/aiTripContext";

const KB = [
  "Trip categories:",
  "- Аялал: Вэлмор аялал; Лумиа аялал; Кардан аялал",
  "",
  "Modules:",
  "- Вэлмор аялал | duration: 6 өдөр 5 шөнө | price: 1111111 | target: Аялал | description: " + "урт тайлбар ".repeat(40) + " | Ангилал: Аялал | Departure dates: 10 сарын 1, 10 сарын 8, 10 сарын 15, 10 сарын 22, 10 сарын 29 | Багтсан: " + "зүйл, ".repeat(30),
  "- Лумиа аялал | duration: 8 өдөр 7 шөнө | price: 999999 | target: Аялал | description: " + "урт тайлбар ".repeat(40),
  "- Кардан аялал | duration: 5 өдөр 4 шөнө | price: 888888 | target: Аялал | description: " + "урт тайлбар ".repeat(40),
  "",
  "FAQ:",
].join("\n");

const focusSection = (kb: string) => kb.includes(FOCUS_HEADER) ? kb.slice(kb.indexOf(FOCUS_HEADER)).split("\n").slice(1) : [];

// Contract changed on 2026-11-02 (cost work): focused trips are no longer written in place but
// repeated in full in a section after the whole catalogue, so the catalogue part of the prompt is
// identical on every call and the provider's prompt cache can reuse it.
test("every trip is an index line; the trips a message is about are repeated in full after the catalogue", () => {
  const focused = focusKnowledgeBase(KB, ["Лумиа аялал"]);
  assert.ok(focused.length < KB.length * 0.6, `${focused.length} vs ${KB.length}`);
  const velmor = focused.split("\n").find((line) => line.startsWith("- Вэлмор аялал"))!;
  assert.equal(
    velmor,
    "- Вэлмор аялал | duration: 6 өдөр 5 шөнө | price: 1111111 | Ангилал: Аялал | Departure dates: 10 сарын 1, 10 сарын 8, 10 сарын 15, 10 сарын 22, 10 сарын 29 | summary only",
  );
  const detail = focusSection(focused);
  assert.equal(detail.length, 1);
  assert.match(detail[0], /^- Лумиа аялал \| .*description: урт тайлбар/);
  // Every trip is still named, so the model never claims one does not exist.
  assert.deepEqual(catalogTripNames(focused), ["Вэлмор аялал", "Лумиа аялал", "Кардан аялал"]);
  // The catalogue part is byte-identical whatever is in focus: a cacheable prefix.
  const other = focusKnowledgeBase(KB, ["Кардан аялал"]);
  const index = focusKnowledgeBase(KB, []);
  assert.ok(focused.startsWith(index) && other.startsWith(index));
});

test("a general question gets every trip as a compact index line", () => {
  const index = focusKnowledgeBase(KB, []);
  assert.ok(index.length < KB.length * 0.3, `${index.length} vs ${KB.length}`);
  assert.deepEqual(catalogTripNames(index), ["Вэлмор аялал", "Лумиа аялал", "Кардан аялал"]);
  assert.ok(index.split("\n").filter((line) => line.endsWith("summary only")).length === 3);
  assert.equal(focusKnowledgeBase(KB, ["Байхгүй аялал"]), index);
  assert.doesNotMatch(index, new RegExp(FOCUS_HEADER.replace(/[()]/g, "\\$&")));
});

test("trips named in the latest messages stay in full detail", () => {
  const named = tripsNamedInRecentMessages(KB, [
    { text: "сайн байна уу" },
    { text: "✈️ Кардан аялал ⏎ 💰 Үнэ: 888,888₮" },
    { text: "хүүхэд хэд вэ" },
  ]);
  assert.deepEqual(named, ["Кардан аялал"]);
});

test("a description that still holds a line break stays with its trip and is summarised", () => {
  const broken = KB.replace("description: " + "урт тайлбар ".repeat(40) + " | Ангилал", "description: эхний мөр\nхоёр дахь мөр " + "урт ".repeat(200) + " | Ангилал");
  const index = focusKnowledgeBase(broken, []);
  assert.deepEqual(catalogTripNames(index), ["Вэлмор аялал", "Лумиа аялал", "Кардан аялал"]);
  assert.doesNotMatch(index, /хоёр дахь мөр/);
});

test("at most four trips get full detail, the matcher's picks first; a long price table is cut at a row", () => {
  const many = ["Trip categories:", "", "Modules:",
    ...Array.from({ length: 10 }, (_, i) => `- Аялал ${i + 1} | duration: 5 өдөр | price: ${100000 + i} | description: тайлбар ${i + 1}`),
    "- Хүснэгт аялал | duration: 5 өдөр | price: 500000 | Огноо тус бүрийн үнэ: " + Array.from({ length: 200 }, (_, i) => `[${i + 1}/1: Том ${1000000 + i}₮]`).join("; "),
    "", "FAQ:"].join("\n");
  const focused = focusKnowledgeBase(many, ["Хүснэгт аялал", ...Array.from({ length: 9 }, (_, i) => `Аялал ${i + 1}`)]);
  const detail = focusSection(focused);
  assert.equal(detail.length, 4);
  assert.match(detail[0], /^- Хүснэгт аялал/);
  assert.ok(detail[0].length < 2_700, String(detail[0].length));
  assert.match(detail[0], /more price rows are not shown here: for a date or hotel not shown, output REFER/);
  assert.match(detail[0], /\[1\/1: Том 1000000₮\]/);
  assert.equal(catalogTripNames(focused).length, 11);
});
